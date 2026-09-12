/**
 * Command implementations: run/resume a plan in a VS Code terminal (the
 * executable is spawned directly with an argument array, no shell), select
 * a run, and open the Run Overview panel and its actions.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildResumePlanArgs, buildRunLoopArgs, buildRunPlanArgs, resolveExecutable } from "../core/cli";
import {
  BRIEF_FILENAME,
  HANDOFF_FILENAME,
  SPARRING_FILENAME,
  chooseLaunchLocation,
  currentStageOf,
  isInsidePath,
  type PlanRunSnapshot,
  type RunSnapshot,
  type SparringLocation,
  type StandaloneStageSnapshot,
} from "../core/discovery";
import { parsePlanStages } from "../core/engineFormats";
import { blocksLaunch } from "../core/liveness";
import type { OverviewAction } from "../core/overviewHtml";
import { buildRunPickItems, describeRun } from "../core/runPick";
import { stageRunAction } from "../core/runner";
import { planRunId, type SparringSubcommand } from "../core/sparringCommand";
import type { SparringController } from "./controller";
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
  );
}

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
 */
async function openDocument(file: string, missingMessage: string, viewColumn: vscode.ViewColumn): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    void vscode.window.showWarningMessage(`Agent Sparring: ${missingMessage}`);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn, preserveFocus: false });
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
    case "openPlan":
      if (run?.kind === "plan") {
        await openDocument(run.planPath, `the plan document ${run.state.plan} is missing.`, overview.documentColumn);
      }
      return;
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
    case "runStage":
      await runStageCommand(controller);
      await overview.update();
      return;
    case "stopRunner":
      if (run && !controller.stopRunner(run.id)) {
        void vscode.window.showInformationMessage("Agent Sparring: no runner observed from this window is alive for the selected stage.");
      }
      return;
  }
}

// ---------------------------------------------------------------- run / resume stage

async function runStageCommand(controller: SparringController): Promise<void> {
  let run = controller.currentSelection.selected;
  if (!run || run.kind !== "stage") {
    await selectRunCommand(controller);
    run = controller.currentSelection.selected;
  }
  if (!run || run.kind !== "stage") {
    if (run) {
      void vscode.window.showInformationMessage("Agent Sparring: the selected run is a plan run; use Run Plan / Resume Plan for it.");
    }
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
    const status = run.stage.state?.status ?? "working";
    void vscode.window.showInformationMessage(`Agent Sparring: ${run.stage.stageId} is ${status}; the loop does not run for ${status} stages.`);
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
  const executable = await resolveOrExplain(run.location);
  if (!executable) {
    return;
  }
  const args = buildRunLoopArgs({ stageId: run.stage.stageId, repoRoot, expectedBranch, sparringDir: run.location.sparringDir });
  await controller.launch({ executable, args, cwd: repoRoot, name: `${label}: ${run.stage.stageId}`, runId: run.id, kind: "run-loop", stageId: run.stage.stageId, reveal: false });
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

async function resolveOrExplain(location: SparringLocation): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration("agentSparring").get<string>("executable", "");
  const resolved = await resolveExecutable(configured, {
    platform: process.platform,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    cwd: location.repoRoot,
  });
  if (resolved.ok) {
    return resolved.path;
  }
  const choice = await vscode.window.showErrorMessage(`Agent Sparring: ${resolved.error}`, "Open Settings");
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "agentSparring.executable");
  }
  return undefined;
}

async function launch(controller: SparringController, location: SparringLocation, executable: string, args: string[], kind: SparringSubcommand, planPath: string): Promise<void> {
  // The command runs inside the user's normal integrated terminal through
  // shell integration (executable + argument array, no quoting), so the user
  // sees the engine's own output and the terminal follows VS Code's normal
  // persistence; the run id is the one the engine will write state under.
  await controller.launch({ executable, args, cwd: location.repoRoot, name: kind, runId: planRunId(location, planPath), kind, planPath, reveal: true });
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
  const executable = await resolveOrExplain(location);
  if (!executable) {
    return;
  }
  const args = buildRunPlanArgs({ planPath, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir });
  const runId = planRunId(location, planPath);
  if (controller.livenessFor(runId).state === "running") {
    void vscode.window.showInformationMessage("Agent Sparring: a runner for this plan is alive in a terminal of this window.");
    return;
  }
  await launch(controller, location, executable, args, "run-plan", planPath);
}

async function resumePlanCommand(controller: SparringController): Promise<void> {
  const plans = controller.currentDiscovery.runs.filter((run): run is PlanRunSnapshot => run.kind === "plan" && run.state.status !== "complete");
  if (plans.length === 0) {
    void vscode.window.showInformationMessage("Agent Sparring: no paused or running plan run to resume.");
    return;
  }
  let run: PlanRunSnapshot | undefined = plans[0];
  const selected = controller.currentSelection.selected;
  if (plans.length > 1) {
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
  if (run.state.status === "running" && liveness.state !== "stopped") {
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
  const evidence = await vscode.window.showInputBox({
    title: "Agent Sparring: human evidence (optional)",
    prompt: "Answer, check result or decision to record under '## Human evidence' before the same stage resumes. Leave empty to resume without evidence.",
    ignoreFocusOut: true,
  });
  if (evidence === undefined) {
    return;
  }
  const executable = await resolveOrExplain(run.location);
  if (!executable) {
    return;
  }
  const args = buildResumePlanArgs({
    planPath: run.planPath,
    repoRoot: run.location.repoRoot,
    expectedBranch,
    sparringDir: run.location.sparringDir,
    evidence,
  });
  await launch(controller, run.location, executable, args, "resume-plan", run.planPath);
}
