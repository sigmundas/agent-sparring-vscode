/**
 * Command implementations: run/resume a plan or a stage in a VS Code
 * terminal (the CLI is handed to the user's shell as executable + argument
 * array, never a quoted command line), accept a stage (freeze then accept
 * as one action), associate a plan document with a standalone stage, select
 * a run, and the Run Overview panel and its actions.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { acceptStage, type AcceptStageResult } from "../core/acceptance";
import { buildResumePlanArgs, buildRunLoopArgs, buildRunPlanArgs, commandNotFoundMessage, type ExecutableProblem } from "../core/cli";
import {
  BRIEF_FILENAME,
  HANDOFF_FILENAME,
  SPARRING_FILENAME,
  chooseLaunchLocation,
  currentStageOf,
  isInsidePath,
  runIdFor,
  type PlanRunSnapshot,
  type RunSnapshot,
  type SparringLocation,
  type StandaloneStageSnapshot,
} from "../core/discovery";
import { parsePlanStages } from "../core/engineFormats";
import { blocksLaunch } from "../core/liveness";
import type { OverviewAction } from "../core/overviewHtml";
import { createStage, proposeNextStage, type NewStageResult } from "../core/nextStage";
import { buildStageIndex, locateStage, parsePlanHeadings, sectionSummary, type HeadingRef, type PlanHeading, type StageEntry } from "../core/planAssociation";
import { buildRunPickItems, describeRun } from "../core/runPick";
import { stageActions, stageRunAction } from "../core/runner";
import { planRunId, type SparringSubcommand } from "../core/sparringCommand";
import type { SparringController } from "./controller";
import type { LaunchResult } from "./executionTracker";
import { currentBranch } from "./git";
import { openCandidateDiff } from "./overview/gitDiff";
import { OverviewPanelManager } from "./overview/overviewPanel";

export function registerCommands(context: vscode.ExtensionContext, controller: SparringController): void {
  const overview: OverviewPanelManager = new OverviewPanelManager(controller, (action) => handleOverviewAction(controller, overview, action));
  context.subscriptions.push(
    overview,
    vscode.commands.registerCommand("agentSparring.showLog", () => controller.showLog()),
    vscode.commands.registerCommand("agentSparring.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("agentSparring.selectRun", () => selectRunCommand(controller)),
    vscode.commands.registerCommand("agentSparring.diagnoseDiscovery", () => controller.diagnoseDiscovery()),
    vscode.commands.registerCommand("agentSparring.openOverview", () => openOverviewCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.runPlan", () => runPlanCommand(controller)),
    vscode.commands.registerCommand("agentSparring.resumePlan", () => resumePlanCommand(controller)),
    vscode.commands.registerCommand("agentSparring.runStage", () => runStageCommand(controller)),
    vscode.commands.registerCommand("agentSparring.acceptStage", () => acceptStageCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.choosePlan", () => associatePlanCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.matchStage", () => matchStageCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.startNextStage", () => startNextStageCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.chooseExecutable", () => chooseExecutableCommand()),
    controller.onCommandNotFound((event) => void explainCommandNotFound(event.word)),
    // Not contributed in package.json (never in the palette): hooks for the
    // extension-host integration tests, which cannot drive QuickPicks.
    vscode.commands.registerCommand("agentSparring._test.chooseRun", async (runId: string) => {
      await controller.chooseRun(controller.currentDiscovery.runs.find((run) => run.id === runId));
      return controller.currentSelection.selected?.id;
    }),
    vscode.commands.registerCommand("agentSparring._test.liveness", (runId: string) => {
      const liveness = controller.livenessFor(runId);
      return { state: liveness.state, source: liveness.source, turnActive: liveness.turnActive, interrupted: liveness.interrupted, detail: liveness.detail, execution: liveness.execution };
    }),
    vscode.commands.registerCommand("agentSparring._test.stop", (runId: string) => controller.stopRunner(runId)),
    vscode.commands.registerCommand("agentSparring._test.acceptStage", async () => {
      const run = controller.currentSelection.selected;
      return run?.kind === "stage" ? performAcceptStage(controller, run) : undefined;
    }),
    vscode.commands.registerCommand("agentSparring._test.associatePlan", async (planPath: string | undefined) => {
      const run = controller.currentSelection.selected;
      if (run) {
        await controller.setAssociatedPlan(run.id, planPath);
      }
      return controller.associatedPlan(run?.id);
    }),
    vscode.commands.registerCommand("agentSparring._test.matchStage", async (match: HeadingRef | undefined) => {
      const run = controller.currentSelection.selected;
      if (run) {
        await controller.setManualMatch(run.id, match);
      }
      return controller.planAssociation(run?.id)?.match;
    }),
    vscode.commands.registerCommand("agentSparring._test.overviewModel", () => overview.buildModel()),
    vscode.commands.registerCommand("agentSparring._test.startNextStage", async () => {
      const run = controller.currentSelection.selected;
      return run?.kind === "stage" ? performStartNextStage(controller, overview, run, { confirm: false }) : undefined;
    }),
    vscode.commands.registerCommand("agentSparring._test.lastCommandNotFound", () => lastCommandNotFound),
    controller.onCommandNotFound((event) => {
      lastCommandNotFound = event;
    }),
  );
}

let lastCommandNotFound: { runId: string; word: string; exitCode: number } | undefined;

// ---------------------------------------------------------------- select run

interface RunItem extends vscode.QuickPickItem {
  run?: RunSnapshot;
}

async function selectRunCommand(controller: SparringController): Promise<void> {
  const runs = controller.currentDiscovery.runs;
  if (runs.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      "Agent Sparring: no recorded plan runs or stages in this workspace.",
      "Diagnose Discovery",
    );
    if (choice === "Diagnose Discovery") {
      await controller.diagnoseDiscovery();
    }
    return;
  }
  const items: RunItem[] = buildRunPickItems(runs, controller.currentSelection.selected?.id);
  items.push({ label: "$(sync) Automatic selection", description: "clear the explicit choice", run: undefined });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Which repository / run should Agent Sparring follow?" });
  if (!picked) {
    return;
  }
  await controller.chooseRun(picked.run);
}

// ---------------------------------------------------------------- overview

async function openOverviewCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  let selection = controller.currentSelection;
  if (!selection.selected && selection.ambiguous.length > 0 && !overview.isOpen) {
    // Ambiguity is resolved through the existing selection UX first.
    await selectRunCommand(controller);
    selection = controller.currentSelection;
    if (!selection.selected) {
      return;
    }
  }
  await overview.show();
}

async function openStageFile(controller: SparringController, overview: OverviewPanelManager, filename: string): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  await openDocument(path.join(currentStageOf(run).dir, filename), `${filename} does not exist yet for this stage.`, overview.documentColumn);
}

/**
 * Open a document as a normal preview tab in the Overview's own editor
 * group. showTextDocument reveals an already-open tab for the same URI
 * instead of duplicating it, and preview tabs are reused by the next
 * action unless the user pinned one; the Overview tab itself stays open.
 * `line` (1-based) reveals that line, e.g. the next stage's heading.
 */
async function openDocument(file: string, missingMessage: string, viewColumn: vscode.ViewColumn, line?: number): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    void vscode.window.showWarningMessage(`Agent Sparring: ${missingMessage}`);
    return;
  }
  const selection = line && line > 0 ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn, preserveFocus: false, selection });
}

/** The plan document for the selected run: the engine's for a plan run, the associated file for a standalone stage. */
function planDocumentFor(controller: SparringController, run: RunSnapshot): string | undefined {
  return run.kind === "plan" ? run.planPath : controller.associatedPlan(run.id);
}

async function handleOverviewAction(controller: SparringController, overview: OverviewPanelManager, action: OverviewAction): Promise<void> {
  const run = controller.currentSelection.selected;
  switch (action) {
    case "openHandoff":
      return openStageFile(controller, overview, HANDOFF_FILENAME);
    case "openSparring":
      return openStageFile(controller, overview, SPARRING_FILENAME);
    case "openBrief":
      return openStageFile(controller, overview, BRIEF_FILENAME);
    case "openPlan": {
      if (!run) {
        return;
      }
      const file = planDocumentFor(controller, run);
      if (file) {
        await openDocument(file, `the plan document ${path.basename(file)} is missing.`, overview.documentColumn);
      }
      return;
    }
    case "openNextStage": {
      if (!run) {
        return;
      }
      const file = planDocumentFor(controller, run);
      if (!file) {
        return;
      }
      await openDocument(file, `the plan document ${path.basename(file)} is missing.`, overview.documentColumn, await nextHeadingLine(controller, run, file));
      return;
    }
    case "openDiff": {
      if (!run) {
        return;
      }
      const stage = currentStageOf(run);
      const base = stage.state?.baseSha;
      if (!base) {
        void vscode.window.showInformationMessage("Agent Sparring: this stage has no recorded base_sha yet.");
        return;
      }
      await openCandidateDiff(run.location.repoRoot, base, stage.state?.candidateSha ?? undefined, stage.title ?? stage.stageId);
      return;
    }
    case "showLog":
      controller.showLog();
      return;
    case "selectRun":
      await selectRunCommand(controller);
      await overview.update();
      return;
    case "runPlan":
      return runPlanCommand(controller);
    case "resumePlan":
      await resumePlanCommand(controller, run?.kind === "plan" ? run : undefined);
      await overview.update();
      return;
    case "runStage":
      await runStageCommand(controller);
      await overview.update();
      return;
    case "acceptStage":
      await acceptStageCommand(controller, overview);
      return;
    case "associatePlan":
      await associatePlanCommand(controller, overview);
      return;
    case "matchStage":
      await matchStageCommand(controller, overview);
      return;
    case "clearMatch":
      if (run?.kind === "stage" && controller.planAssociation(run.id)?.match) {
        await controller.setManualMatch(run.id, undefined);
        await overview.update();
      }
      return;
    case "startNextStage":
      await startNextStageCommand(controller, overview);
      return;
    case "stopRunner":
      if (run && !controller.stopRunner(run.id)) {
        void vscode.window.showInformationMessage("Agent Sparring: no runner observed from this window is alive for the selected stage.");
      }
      return;
  }
}

/**
 * The line of the heading after this stage's, using the same matching the
 * Overview used (manual match, then the brief's markers): for a managed
 * run, the engine's next stage located in the document by number + title.
 */
async function nextHeadingLine(controller: SparringController, run: RunSnapshot, file: string): Promise<number | undefined> {
  try {
    const headings = parsePlanHeadings(await fs.readFile(file, "utf8"));
    if (run.kind === "plan") {
      const next = run.planStages?.[run.state.currentStageIndex + 1];
      return next ? headings.find((heading) => heading.label === String(next.number) && heading.title === next.title)?.line : undefined;
    }
    const stage = currentStageOf(run);
    const briefText = await readOptional(path.join(stage.dir, BRIEF_FILENAME));
    const position = locateStage(headings, { stageId: stage.stageId, title: stage.title, briefText, manual: controller.planAssociation(run.id)?.match });
    if (position?.next.state !== "found") {
      return undefined;
    }
    const entry = position.next.stage;
    return (entry.canonical ?? entry.occurrences[0])?.line;
  } catch {
    return undefined;
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- run / resume stage

async function selectedStage(controller: SparringController): Promise<StandaloneStageSnapshot | undefined> {
  let run = controller.currentSelection.selected;
  if (!run || run.kind !== "stage") {
    await selectRunCommand(controller);
    run = controller.currentSelection.selected;
  }
  if (!run || run.kind !== "stage") {
    if (run) {
      void vscode.window.showInformationMessage("Agent Sparring: the selected run is a plan run; use Run Plan / Resume Plan for it.");
    }
    return undefined;
  }
  return run;
}

async function runStageCommand(controller: SparringController): Promise<void> {
  const run = await selectedStage(controller);
  if (!run) {
    return;
  }
  let liveness = controller.livenessFor(run.id);
  const block = blocksLaunch(liveness);
  if (block === "running") {
    void vscode.window.showInformationMessage(`Agent Sparring: a runner is alive for ${run.stage.stageId}. ${liveness.detail}`);
    return;
  }
  if (block === "unknown") {
    // Telemetry claims a turn but nothing has observed the process: the
    // override is explicit, and the engine's worktree lock refuses a second
    // live runner anyway.
    const proceed = await vscode.window.showWarningMessage(
      `Agent Sparring: run status unknown for ${run.stage.stageId}. ${liveness.detail} Launch only if you know that runner is no longer alive.`,
      { modal: true },
      "Run anyway",
    );
    if (proceed !== "Run anyway") {
      return;
    }
    liveness = { ...liveness, turnActive: false };
  }
  const action = stageRunAction(run, liveness);
  if (!action) {
    const primary = stageActions(run, liveness).primary;
    if (primary?.kind === "accept") {
      void vscode.window.showInformationMessage(`Agent Sparring: the review of ${run.stage.stageId} is complete; use Accept stage to finish it.`);
    } else {
      void vscode.window.showInformationMessage(`Agent Sparring: ${run.stage.stageId} is complete; nothing further runs for an accepted stage.`);
    }
    return;
  }
  await launchStageLoop(controller, run, action.label);
}

async function launchStageLoop(controller: SparringController, run: StandaloneStageSnapshot, label: string): Promise<void> {
  const repoRoot = run.location.repoRoot;
  const expectedBranch = await currentBranch(repoRoot);
  if (!expectedBranch) {
    void vscode.window.showErrorMessage(
      `Agent Sparring: no Git branch is checked out in ${run.location.folderName} (detached HEAD or not a repository). Check out the stage's branch, then run again.`,
    );
    return;
  }
  const args = buildRunLoopArgs({ stageId: run.stage.stageId, repoRoot, expectedBranch, sparringDir: run.location.sparringDir });
  const result = await controller.launch({ configured: configuredExecutable(), args, cwd: repoRoot, name: `${label}: ${run.stage.stageId}`, runId: run.id, kind: "run-loop", stageId: run.stage.stageId, reveal: false });
  await explainLaunch(result);
}

// ---------------------------------------------------------------- accept stage (freeze, then accept)

async function acceptStageCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = await selectedStage(controller);
  if (!run) {
    return;
  }
  if (run.stage.state?.status === "accepted") {
    void vscode.window.showInformationMessage(`Agent Sparring: ${run.stage.stageId} is already accepted.`);
    return;
  }
  const liveness = controller.livenessFor(run.id);
  if (blocksLaunch(liveness) === "running") {
    void vscode.window.showInformationMessage(`Agent Sparring: a runner is still alive for ${run.stage.stageId}; wait for it to finish before accepting.`);
    return;
  }
  if (controller.isAccepting(run.id)) {
    return;
  }
  const result = await performAcceptStage(controller, run);
  await overview.update();
  if (!result) {
    return;
  }
  if (result.ok) {
    void vscode.window.showInformationMessage(`Agent Sparring: stage accepted${result.candidateSha ? ` at ${result.candidateSha.slice(0, 8)}` : ""}. Stage complete.`);
    return;
  }
  if (result.commandNotFound) {
    await explainCommandNotFound(configuredExecutable() || "sparring");
    return;
  }
  const buttons = result.retryable && result.step === "accept" ? ["Try Accept stage again", "Show log"] : ["Show log"];
  const choice = await vscode.window.showErrorMessage(`Agent Sparring: ${result.message}`, ...buttons);
  if (choice === "Show log") {
    controller.showLog();
  } else if (choice === "Try Accept stage again") {
    await acceptStageCommand(controller, overview);
  }
}

/**
 * Run the engine's two acceptance steps in order for `run`, marking the
 * run as accepting meanwhile so the Overview shows Accepting stage… and
 * offers no second action. Returns undefined when the branch or executable
 * could not be established (already explained to the user).
 */
async function performAcceptStage(controller: SparringController, run: StandaloneStageSnapshot): Promise<AcceptStageResult | undefined> {
  const repoRoot = run.location.repoRoot;
  const expectedBranch = await currentBranch(repoRoot);
  if (!expectedBranch) {
    void vscode.window.showErrorMessage(
      `Agent Sparring: no Git branch is checked out in ${run.location.folderName} (detached HEAD or not a repository). Check out the stage's branch, then accept again.`,
    );
    return undefined;
  }
  const invocation = { stageId: run.stage.stageId, repoRoot, expectedBranch, sparringDir: run.location.sparringDir };
  controller.setAccepting(run.id, true);
  controller.log(`Accept stage ${run.stage.stageId}: freeze-candidate, then accept-candidate (branch ${expectedBranch})`);
  let problem: { error: string; problem: ExecutableProblem } | undefined;
  try {
    const result = await acceptStage(async (args) => {
      const outcome = await controller.runCommand({ configured: configuredExecutable(), args, cwd: repoRoot, name: `Accept stage: ${run.stage.stageId}` });
      if (!outcome.ok) {
        problem = { error: outcome.error, problem: outcome.problem };
        return { exitCode: undefined, output: outcome.error };
      }
      return outcome.outcome;
    }, invocation);
    if (problem) {
      await explainExecutableProblem(problem.error);
      return undefined;
    }
    if (result.ok) {
      controller.log(`Accept stage ${run.stage.stageId}: accepted${result.candidateSha ? ` ${result.candidateSha}` : ""}`);
    } else {
      controller.log(`Accept stage ${run.stage.stageId}: ${result.step === "freeze" ? "freeze-candidate" : "accept-candidate"} failed — ${result.message}`);
      if (result.detail) {
        for (const line of result.detail.split(/\r?\n/)) {
          controller.log(`  ${line}`);
        }
      }
    }
    return result;
  } finally {
    controller.setAccepting(run.id, false);
    await controller.refresh();
  }
}

// ---------------------------------------------------------------- plan association (UI metadata only)

async function associatePlanCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  if (run.kind === "plan") {
    void vscode.window.showInformationMessage("Agent Sparring: this is an engine-managed plan run; its plan document is already known.");
    return;
  }
  const current = controller.associatedPlan(run.id);
  let choice: "choose" | "remove" | undefined = "choose";
  if (current) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(file) Choose another plan file…", description: path.basename(current), action: "choose" as const },
        { label: "$(close) Remove the association", description: "the stage keeps running; only the Plan button goes away", action: "remove" as const },
      ],
      { placeHolder: `Plan for ${run.stage.stageId} (kept in VS Code only; the engine is not told)` },
    );
    choice = picked?.action;
  }
  if (!choice) {
    return;
  }
  if (choice === "remove") {
    await controller.setAssociatedPlan(run.id, undefined);
    await overview.update();
    return;
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    defaultUri: vscode.Uri.file(current ? path.dirname(current) : run.location.repoRoot),
    filters: { Markdown: ["md", "markdown"], "All files": ["*"] },
    openLabel: "Associate plan",
    title: `Plan document for ${run.stage.stageId}`,
  });
  const file = chosen?.[0]?.fsPath;
  if (!file) {
    return;
  }
  await controller.setAssociatedPlan(run.id, file);
  await overview.update();
}

interface HeadingItem extends vscode.QuickPickItem {
  match?: HeadingRef;
  action?: "clear" | "changePlan" | "remove";
}

/**
 * Let the user say which section of the associated plan this stage is,
 * when automatic matching could not (or chose differently). The choice is
 * a heading identity in VS Code workspace state, never engine state.
 */
async function matchStageCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  if (run.kind === "plan") {
    void vscode.window.showInformationMessage("Agent Sparring: this is an engine-managed plan run; the engine records which stage is current.");
    return;
  }
  const association = controller.planAssociation(run.id);
  if (!association) {
    await associatePlanCommand(controller, overview);
    return;
  }
  const text = await readOptional(association.path);
  if (text === undefined) {
    void vscode.window.showWarningMessage(`Agent Sparring: the plan document ${path.basename(association.path)} is missing. Choose another plan for this stage.`);
    await associatePlanCommand(controller, overview);
    return;
  }
  const headings = parsePlanHeadings(text);
  if (headings.length === 0) {
    void vscode.window.showInformationMessage(`Agent Sparring: ${path.basename(association.path)} has no '## Stage … — …' or '##' headings to match this stage to.`);
    return;
  }
  const stage = run.stage;
  const briefText = await readOptional(path.join(stage.dir, BRIEF_FILENAME));
  const current = locateStage(headings, { stageId: stage.stageId, title: stage.title, briefText, manual: association.match });
  const currentLabel = current?.stage?.label;
  const howMatched = current?.source === "manual" ? "current match (yours)" : "current match (automatic)";
  // One item per logical stage (its label), not per heading: a plan mentions
  // a stage in handoffs and status notes too, and those are the same stage.
  const index = buildStageIndex(headings);
  const items: HeadingItem[] = index.map((entry) => ({
    label: `${entry.label === currentLabel ? "$(check) " : ""}${entry.display}`,
    description: entry.label === currentLabel ? howMatched : describeEntry(entry),
    detail: entry.canonical ? sectionSummary(text, entry.canonical.line, 120) : entry.occurrences.map((heading) => heading.display).join(" · "),
    match: { label: entry.label, title: entry.title ?? entry.occurrences[0].title },
  }));
  if (index.length === 0) {
    // No stage labels anywhere: offer the plain headings themselves.
    items.push(
      ...headings.map((heading, at) => ({
        label: `${at === headings.indexOf(current?.current as PlanHeading) ? "$(check) " : ""}${heading.display}`,
        description: current && headings[at] === current.current ? howMatched : `line ${heading.line}`,
        detail: sectionSummary(text, heading.line, 120),
        match: { title: heading.title },
      })),
    );
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  if (association.match) {
    items.push({ label: "$(discard) Use automatic matching again", description: "forget the section you picked", action: "clear" });
  }
  items.push({ label: "$(file) Choose another plan file…", description: path.basename(association.path), action: "changePlan" });
  items.push({ label: "$(close) Remove the plan association", description: "the stage keeps its state; only the plan display goes away", action: "remove" });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Which stage of ${path.basename(association.path)} is ${stage.stageId}? (kept in VS Code only; the engine is not told)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  if (picked.action === "changePlan") {
    await associatePlanCommand(controller, overview);
    return;
  }
  if (picked.action === "remove") {
    await controller.setAssociatedPlan(run.id, undefined);
  } else if (picked.action === "clear") {
    await controller.setManualMatch(run.id, undefined);
  } else if (picked.match) {
    await controller.setManualMatch(run.id, picked.match);
  }
  await overview.update();
}

// ---------------------------------------------------------------- launching

async function pickLocation(controller: SparringController): Promise<SparringLocation | undefined> {
  const locations = controller.sparringLocations;
  if (locations.length === 0) {
    void vscode.window.showErrorMessage("Agent Sparring: no `.sparring` directory in any workspace folder.");
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document;
  const activeFile = active?.uri.scheme === "file" ? active.uri.fsPath : undefined;
  const chosen = chooseLaunchLocation(locations, controller.currentSelection.selected, activeFile);
  if (chosen) {
    return chosen;
  }
  const picked = await vscode.window.showQuickPick(
    locations.map((location) => ({ label: location.folderName, description: location.repoRoot, location })),
    { placeHolder: "Which repository?" },
  );
  return picked?.location;
}

const isInside = isInsidePath;

async function pickPlanDocument(location: SparringLocation): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.languageId === "markdown" && active.uri.scheme === "file" && isInside(active.uri.fsPath, location.repoRoot)) {
    if (await looksLikePlan(active.uri.fsPath)) {
      return active.uri.fsPath;
    }
  }
  // Relative to the repository itself, so a nested project is not searched
  // through its whole parent workspace folder.
  const pattern = new vscode.RelativePattern(vscode.Uri.file(location.repoRoot), "**/*.md");
  const candidates = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git,.sparring,dist,out,.venv}/**", 400);
  const plans: { label: string; description: string; detail?: string; file: string }[] = [];
  for (const uri of candidates) {
    const stages = await planStageCount(uri.fsPath);
    if (stages && stages > 0) {
      plans.push({
        label: path.basename(uri.fsPath),
        description: path.relative(location.repoRoot, uri.fsPath),
        detail: `${stages} stage(s)`,
        file: uri.fsPath,
      });
    }
  }
  plans.sort((a, b) => a.description.localeCompare(b.description));
  const picked = await vscode.window.showQuickPick(
    [...plans, { label: "$(folder-opened) Browse…", description: "choose another Markdown file", file: "" }],
    { placeHolder: "Which reviewed plan should run? (plans are Markdown files with '## Stage <n> — <title>' headings)" },
  );
  if (!picked) {
    return undefined;
  }
  if (picked.file) {
    return picked.file;
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.Uri.file(location.repoRoot),
    filters: { Markdown: ["md"] },
    openLabel: "Run plan",
  });
  return chosen?.[0]?.fsPath;
}

async function planStageCount(file: string): Promise<number | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!/^##\s+stage\b/im.test(text)) {
      return 0;
    }
    return parsePlanStages(text).length;
  } catch {
    return undefined; // malformed for the engine too; not offered
  }
}

async function looksLikePlan(file: string): Promise<boolean> {
  return ((await planStageCount(file)) ?? 0) > 0;
}

async function askBranch(location: SparringLocation, recorded?: string): Promise<string | undefined> {
  const detected = recorded ?? (await currentBranch(location.repoRoot));
  const value = await vscode.window.showInputBox({
    title: "Agent Sparring: expected branch",
    prompt: recorded
      ? "The branch this plan run was started for (the engine refuses any other)."
      : "The feature branch every stage of this plan must modify (passed as --expected-branch).",
    value: detected ?? "",
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? undefined : "A branch name is required."),
  });
  return value?.trim() || undefined;
}

// ---------------------------------------------------------------- executable configuration

function configuredExecutable(): string {
  return vscode.workspace.getConfiguration("agentSparring").get<string>("executable", "");
}

async function explainLaunch(result: LaunchResult): Promise<void> {
  if (!result.ok) {
    await explainExecutableProblem(result.error);
  }
}

/** Configuration errors: the honest message plus the two ways to fix it. */
async function explainExecutableProblem(error: string): Promise<void> {
  const choice = await vscode.window.showErrorMessage(`Agent Sparring: ${error}`, "Open Settings", "Choose executable…");
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "agentSparring.executable");
  } else if (choice === "Choose executable…") {
    await chooseExecutableCommand();
  }
}

async function explainCommandNotFound(word: string): Promise<void> {
  await explainExecutableProblem(commandNotFoundMessage(word));
}

/** Pick the sparring CLI with a file dialog and store it as `agentSparring.executable`. */
async function chooseExecutableCommand(): Promise<void> {
  const chosen = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: "Use as sparring executable",
    title: "Agent Sparring: choose the sparring executable",
  });
  const file = chosen?.[0]?.fsPath;
  if (!file) {
    return;
  }
  const configuration = vscode.workspace.getConfiguration("agentSparring");
  const inspected = configuration.inspect<string>("executable");
  const target = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await configuration.update("executable", file, target);
  void vscode.window.showInformationMessage(`Agent Sparring: agentSparring.executable set to ${file} (${target === vscode.ConfigurationTarget.Workspace ? "workspace" : "user"} settings).`);
}

async function launch(controller: SparringController, location: SparringLocation, args: string[], kind: SparringSubcommand, planPath: string): Promise<void> {
  // The command runs inside the user's normal integrated terminal through
  // shell integration (executable + argument array, no quoting), so the user
  // sees the engine's own output and the terminal follows VS Code's normal
  // persistence; the run id is the one the engine will write state under.
  const result = await controller.launch({ configured: configuredExecutable(), args, cwd: location.repoRoot, name: kind, runId: planRunId(location, planPath), kind, planPath, reveal: true });
  await explainLaunch(result);
}

async function runPlanCommand(controller: SparringController): Promise<void> {
  const location = await pickLocation(controller);
  if (!location) {
    return;
  }
  const planPath = await pickPlanDocument(location);
  if (!planPath) {
    return;
  }
  const expectedBranch = await askBranch(location);
  if (!expectedBranch) {
    return;
  }
  const args = buildRunPlanArgs({ planPath, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir });
  const runId = planRunId(location, planPath);
  if (controller.livenessFor(runId).state === "running") {
    void vscode.window.showInformationMessage("Agent Sparring: a runner for this plan is alive in a terminal of this window.");
    return;
  }
  await launch(controller, location, args, "run-plan", planPath);
}

/**
 * Resume (or continue) a managed plan run with `sparring resume-plan`.
 * `preselected` is the Overview's selected plan run; without it the paused
 * / running runs are offered. A current stage that is already accepted is
 * advanced past by the engine, so the same command is "Continue plan".
 */
async function resumePlanCommand(controller: SparringController, preselected?: PlanRunSnapshot): Promise<void> {
  const plans = controller.currentDiscovery.runs.filter((run): run is PlanRunSnapshot => run.kind === "plan" && run.state.status !== "complete");
  if (plans.length === 0) {
    void vscode.window.showInformationMessage("Agent Sparring: no paused or running plan run to resume.");
    return;
  }
  let run: PlanRunSnapshot | undefined = preselected && plans.some((candidate) => candidate.id === preselected.id) ? preselected : plans[0];
  const selected = controller.currentSelection.selected;
  if (!preselected && plans.length > 1) {
    const picked = await vscode.window.showQuickPick(
      plans
        .slice()
        .sort((a, b) => Number(b.state.status === "paused") - Number(a.state.status === "paused"))
        .map((candidate) => ({
          label: `${candidate.id === selected?.id ? "$(check) " : ""}${candidate.state.plan}`,
          description: describeRun(candidate),
          candidate,
        })),
      { placeHolder: "Which plan run should resume?" },
    );
    run = picked?.candidate;
  }
  if (!run) {
    return;
  }
  const liveness = controller.livenessFor(run.id);
  if (liveness.state === "running") {
    void vscode.window.showInformationMessage(`Agent Sparring: a runner is alive for ${run.state.plan}. ${liveness.detail}`);
    return;
  }
  if (run.state.status === "running" && liveness.state !== "stopped" && run.currentStage.state?.status !== "accepted") {
    const proceed = await vscode.window.showWarningMessage(
      `Agent Sparring: ${run.state.plan} is recorded as running and no runner process has been observed ending. Resume only if that process is no longer alive.`,
      { modal: true },
      "Resume anyway",
    );
    if (proceed !== "Resume anyway") {
      return;
    }
  }
  const expectedBranch = await askBranch(run.location, run.state.expectedBranch);
  if (!expectedBranch) {
    return;
  }
  const continuing = run.currentStage.state?.status === "accepted";
  let evidence: string | undefined = "";
  if (!continuing) {
    evidence = await vscode.window.showInputBox({
      title: "Agent Sparring: human evidence (optional)",
      prompt: "Answer, check result or decision to record under '## Human evidence' before the same stage resumes. Leave empty to resume without evidence.",
      ignoreFocusOut: true,
    });
    if (evidence === undefined) {
      return;
    }
  }
  const args = buildResumePlanArgs({
    planPath: run.planPath,
    repoRoot: run.location.repoRoot,
    expectedBranch,
    sparringDir: run.location.sparringDir,
    evidence,
  });
  await launch(controller, run.location, args, "resume-plan", run.planPath);
}

function describeEntry(entry: StageEntry): string {
  const count = entry.occurrences.length;
  if (entry.ambiguous) {
    return `defined in ${count} sections`;
  }
  if (!entry.canonical) {
    return count === 1 ? "mentioned once, no defining section" : `mentioned in ${count} sections, none defining it`;
  }
  return count === 1 ? `line ${entry.canonical.line}` : `line ${entry.canonical.line} · ${count - 1} more mention${count === 2 ? "" : "s"}`;
}

// ---------------------------------------------------------------- start the next stage (engine new-stage)

async function startNextStageCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = await selectedStage(controller);
  if (!run) {
    return;
  }
  await performStartNextStage(controller, overview, run, { confirm: true });
}

export type StartNextStageOutcome =
  | { ok: true; stageId: string; runId: string }
  | { ok: false; reason: "not-accepted" | "no-plan" | "no-next" | "exists" | "cancelled" | "branch" | "executable" | "engine"; message?: string; stageId?: string };

/**
 * Start the stage that follows `run` in its associated plan: propose the
 * id from the plan's next stage label and canonical title, confirm, run
 * the engine's `new-stage`, carry the plan association (matched to that
 * stage) over to the new run, select it, and open its fresh brief.md
 * beside the plan section. Nothing under .sparring is written here: the
 * engine creates the stage, the user writes the brief.
 */
async function performStartNextStage(controller: SparringController, overview: OverviewPanelManager, run: StandaloneStageSnapshot, options: { confirm: boolean }): Promise<StartNextStageOutcome> {
  if (run.stage.state?.status !== "accepted") {
    void vscode.window.showInformationMessage(`Agent Sparring: ${run.stage.stageId} is not accepted yet; the next stage starts after this one is complete.`);
    return { ok: false, reason: "not-accepted" };
  }
  const association = controller.planAssociation(run.id);
  const text = association ? await readOptional(association.path) : undefined;
  if (!association || text === undefined) {
    void vscode.window.showInformationMessage("Agent Sparring: choose a plan for this stage first; the next stage comes from it.");
    return { ok: false, reason: "no-plan" };
  }
  const headings = parsePlanHeadings(text);
  const briefText = await readOptional(path.join(run.stage.dir, BRIEF_FILENAME));
  const position = locateStage(headings, { stageId: run.stage.stageId, title: run.stage.title, briefText, manual: association.match });
  const proposal = position?.next.state === "found" ? proposeNextStage(position.next.stage) : undefined;
  if (!proposal) {
    void vscode.window.showInformationMessage("Agent Sparring: the plan does not define a clear next stage after this one. Match this stage or read the plan.");
    return { ok: false, reason: "no-next" };
  }
  const location = run.location;
  const existing = controller.currentDiscovery.runs.find((candidate) => candidate.kind === "stage" && candidate.location.projectDir === location.projectDir && candidate.stage.stageId === proposal.stageId);
  if (existing) {
    const choice = options.confirm ? await vscode.window.showInformationMessage(`Agent Sparring: ${proposal.stageId} already exists in ${location.folderName}.`, "Show that stage") : undefined;
    if (choice === "Show that stage") {
      await controller.chooseRun(existing);
      await overview.update();
    }
    return { ok: false, reason: "exists", stageId: proposal.stageId };
  }
  if (options.confirm) {
    const detail = [`Stage id: ${proposal.stageId}`, `From: ${path.basename(association.path)} › ${proposal.display} (line ${proposal.line})`, "", "The engine's new-stage command creates the stage. You then fill in its brief from the plan section and run it."].join("\n");
    const choice = await vscode.window.showInformationMessage(`Start ${proposal.display}?`, { modal: true, detail }, "Start stage");
    if (choice !== "Start stage") {
      return { ok: false, reason: "cancelled" };
    }
  }
  controller.log(`Start next stage: sparring new-stage ${proposal.stageId} (from ${path.basename(association.path)} › ${proposal.display})`);
  let problem: string | undefined;
  const result: NewStageResult = await createStage(
    async (args) => {
      const outcome = await controller.runCommand({ configured: configuredExecutable(), args, cwd: location.repoRoot, name: `New stage: ${proposal.stageId}` });
      if (!outcome.ok) {
        problem = outcome.error;
        return { exitCode: undefined, output: outcome.error };
      }
      return outcome.outcome;
    },
    { stageId: proposal.stageId, repoRoot: location.repoRoot, sparringDir: location.sparringDir },
  );
  if (problem) {
    await explainExecutableProblem(problem);
    return { ok: false, reason: "executable", message: problem };
  }
  if (!result.ok) {
    controller.log(`Start next stage: new-stage failed — ${result.message}`);
    for (const line of result.detail.split(/\r?\n/)) {
      controller.log(`  ${line}`);
    }
    if (result.commandNotFound) {
      await explainCommandNotFound(configuredExecutable() || "sparring");
    } else {
      const choice = await vscode.window.showErrorMessage(`Agent Sparring: ${result.message}`, "Show log");
      if (choice === "Show log") {
        controller.showLog();
      }
    }
    return { ok: false, reason: "engine", message: result.message, stageId: proposal.stageId };
  }
  controller.log(`Start next stage: created ${proposal.stageId}`);
  // The new stage belongs to the same plan, at the stage we just started; the
  // association (VS Code state only) follows it so the Overview can place it.
  const newRunId = runIdFor(location, "stage", proposal.stageId);
  await controller.setAssociatedPlan(newRunId, association.path);
  await controller.setManualMatch(newRunId, { label: proposal.label, title: proposal.title });
  await controller.refresh();
  const created = controller.currentDiscovery.runs.find((candidate) => candidate.id === newRunId);
  if (created) {
    await controller.chooseRun(created);
  }
  await overview.update();
  if (options.confirm) {
    // The plan section first, the brief last so it has focus: the user's next step is to write it.
    await openDocument(association.path, `the plan document ${path.basename(association.path)} is missing.`, overview.documentColumn, proposal.line);
    const brief = path.join(location.sparringDir, "stages", proposal.stageId, BRIEF_FILENAME);
    await openDocument(brief, "brief.md was not created by the engine.", overview.documentColumn);
    void vscode.window.showInformationMessage(`Agent Sparring: ${proposal.display} created as ${proposal.stageId}. Fill in its brief from the plan section, then use Run stage.`);
  }
  return { ok: true, stageId: proposal.stageId, runId: newRunId };
}
