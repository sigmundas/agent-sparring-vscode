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
import { buildResumePlanArgs, buildRunLoopArgs, buildRunPlanArgs, buildRunSparringArgs, commandNotFoundMessage, type ExecutableProblem } from "../core/cli";
import { buildManifest, manifestFileName, renderManifest, type ExecutionManifest, type KnownStage } from "../core/manifest";
import {
  BRIEF_FILENAME,
  HANDOFF_FILENAME,
  NOTES_FILENAME,
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
import { appendHumanEvidence, renderHumanEvidence, submittableChecks } from "../core/humanChecks";
import { blocksLaunch } from "../core/liveness";
import type { OverviewAction } from "../core/overviewHtml";
import { createStage, proposeNextStage, renderNextStageBrief, type NewStageResult } from "../core/nextStage";
import { buildStageIndex, locateStage, parsePlanHeadings, sectionSummary, type HeadingRef, type PlanHeading, type StageEntry } from "../core/planAssociation";
import { buildRunPickItems, describeRun } from "../core/runPick";
import { stageActions, stageRunAction } from "../core/runner";
import { planKey, planLabel, planRunId, type SparringSubcommand } from "../core/sparringCommand";
import { withTemporaryFile } from "../core/tempFile";
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
    vscode.commands.registerCommand("agentSparring.continueAutomatically", () => void performContinueAutomatically(controller, overview, { confirm: true })),
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
    vscode.commands.registerCommand("agentSparring._test.continueAutomatically", () => performContinueAutomatically(controller, overview, { confirm: false })),
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
    case "continueAutomatically":
      await performContinueAutomatically(controller, overview, { confirm: true });
      return;
    case "stopRunner":
      if (run && !controller.stopRunner(run.id)) {
        void vscode.window.showInformationMessage("Agent Sparring: no runner observed from this window is alive for the selected stage.");
      }
      return;
    case "openPlanSection": {
      if (!run) {
        return;
      }
      const file = planDocumentFor(controller, run);
      if (!file) {
        return;
      }
      const model = await overview.buildModel();
      await openDocument(file, `the plan document ${path.basename(file)} is missing.`, overview.documentColumn, model.plan?.currentLine);
      return;
    }
    case "submitForReview":
      await submitForReviewCommand(controller, overview);
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

// ---------------------------------------------------------------- submit manual verification evidence for review

/**
 * Hand the recorded manual-verification results back to the *reviewer*.
 *
 * The outcomes are rendered as one `## Human evidence` entry and written
 * where the engine keeps them (the stage's notes.md, in the engine's own
 * append shape) and — for a standalone stage — into the same section of
 * handoff.md, because the sparring prompt shows the reviewer `handoff.md`
 * verbatim and only the stage agent would otherwise fold notes.md into it.
 *
 * Then the *reviewer* runs, not the stage agent:
 *
 *  - standalone stage → `sparring run-sparring <stage>`, which resumes the
 *    recorded sparring session against the unchanged candidate. Running
 *    `run-loop` here would start Claude first with nothing to implement;
 *    Resume stage remains the separate action for real implementation work.
 *  - managed plan run → the engine's own `resume-plan --evidence`, which
 *    records the evidence and continues the plan at this same stage. The
 *    plan loop is the engine's orchestration and is not bypassed here.
 *
 * Nothing is frozen or accepted: the reviewer rules on the next turn.
 */
async function submitForReviewCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  const model = await overview.buildModel();
  const panel = model.actionRequired;
  if (!panel) {
    void vscode.window.showInformationMessage("Agent Sparring: this stage is not waiting for you right now.");
    return;
  }
  if (model.branchGuard) {
    await explainWrongBranch(model.branchGuard);
    return;
  }
  if (!panel.submit.enabled) {
    // The same sentence the disabled button carries: incomplete evidence, a
    // live runner, or nothing to send.
    void vscode.window.showInformationMessage(`Agent Sparring: ${panel.submit.detail}`);
    return;
  }
  const recorded = submittableChecks(panel);
  const entry = renderHumanEvidence(recorded, new Date(), model.planName);
  if (!entry) {
    void vscode.window.showInformationMessage("Agent Sparring: record Pass, Fail or Blocked for the remaining checks first.");
    return;
  }
  const count = recorded.length;
  const what = run.kind === "plan" ? "the engine records the evidence and continues the plan at this same stage" : "the independent reviewer reads it and rules again; the stage agent is not started";
  const detail = [`${count} result${count === 1 ? "" : "s"} will be recorded under '## Human evidence', then ${what}.`, "", entry].join("\n");
  const choice = await vscode.window.showInformationMessage("Submit for review?", { modal: true, detail }, "Submit for review");
  if (choice !== "Submit for review") {
    return;
  }
  if (run.kind === "plan") {
    const expectedBranch = await askBranch(run.location, run.state.expectedBranch);
    if (!expectedBranch) {
      return;
    }
    const input = await planInvocationFor(controller, run);
    if (!input) {
      return;
    }
    const args = buildResumePlanArgs({ ...input, repoRoot: run.location.repoRoot, expectedBranch, sparringDir: run.location.sparringDir, evidence: entry });
    controller.log(`Submit for review: ${count} manual verification result(s) passed to resume-plan --evidence for ${run.currentStage.stageId}`);
    await launch(controller, run.location, args, "resume-plan", run.planPath, "manifest" in input ? input.manifest : undefined);
    await controller.clearHumanChecks(run.id);
    await overview.update();
    return;
  }
  const expectedBranch = await currentBranch(run.location.repoRoot);
  if (!expectedBranch) {
    void vscode.window.showErrorMessage(
      `Agent Sparring: no Git branch is checked out in ${run.location.folderName} (detached HEAD or not a repository). Check out the stage's branch, then submit again.`,
    );
    return;
  }
  if (!(await recordEvidence(controller, run, entry))) {
    return;
  }
  await controller.clearHumanChecks(run.id);
  const args = buildRunSparringArgs({ stageId: run.stage.stageId, repoRoot: run.location.repoRoot, expectedBranch, sparringDir: run.location.sparringDir });
  controller.log(`Submit for review: sparring run-sparring ${run.stage.stageId} (branch ${expectedBranch}); the stage agent is not started`);
  const result = await controller.launch({
    configured: configuredExecutable(),
    args,
    cwd: run.location.repoRoot,
    name: `Review: ${run.stage.stageId}`,
    runId: run.id,
    kind: "run-sparring",
    stageId: run.stage.stageId,
    reveal: false,
  });
  await explainLaunch(result);
  await overview.update();
}

/**
 * Write the entry into the stage's notes.md, in the engine's own place and
 * append shape. That file is the whole story: the engine reads its
 * `## Human evidence` section live when it builds the sparring prompt
 * (sparring_prompt.py), so the reviewer sees this entry on its next turn
 * without anything being mirrored into handoff.md. False when nothing could
 * be written; the caller then launches nothing.
 */
async function recordEvidence(controller: SparringController, run: StandaloneStageSnapshot, entry: string): Promise<boolean> {
  const notesPath = path.join(run.stage.dir, NOTES_FILENAME);
  try {
    const notes = (await readOptional(notesPath)) ?? `# Notes: ${run.stage.stageId}\n`;
    await fs.writeFile(notesPath, appendHumanEvidence(notes, entry), "utf8");
  } catch (error) {
    void vscode.window.showErrorMessage(`Agent Sparring: could not write ${NOTES_FILENAME} for ${run.stage.stageId}: ${(error as Error).message}. Nothing was submitted.`);
    return false;
  }
  controller.log(`Submit for review: recorded the results under '## Human evidence' in ${run.stage.stageId}/${NOTES_FILENAME}; the reviewer reads that section directly`);
  return true;
}

/** Nothing is launched from the wrong branch; the recorded branch is named so the fix is obvious. */
async function explainWrongBranch(guard: { expected: string; actual?: string }): Promise<void> {
  const where = guard.actual ? `the repository is on ${guard.actual}` : "no branch is checked out";
  void vscode.window.showWarningMessage(
    `Agent Sparring: this stage belongs to ${guard.expected}, but ${where}. Switch branches first; the engine refuses a run on another branch.`,
  );
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

async function launch(controller: SparringController, location: SparringLocation, args: string[], kind: SparringSubcommand, planPath: string, manifest?: string): Promise<void> {
  // The command runs inside the user's normal integrated terminal through
  // shell integration (executable + argument array, no quoting), so the user
  // sees the engine's own output and the terminal follows VS Code's normal
  // persistence; the run id is the one the engine will write state under.
  const result = await controller.launch({ configured: configuredExecutable(), args, cwd: location.repoRoot, name: kind, runId: planRunId(location, planPath), kind, planPath, manifest, reveal: true });
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
  const input = await planInvocationFor(controller, run);
  if (!input) {
    return;
  }
  const args = buildResumePlanArgs({
    ...input,
    repoRoot: run.location.repoRoot,
    expectedBranch,
    sparringDir: run.location.sparringDir,
    evidence,
  });
  await launch(controller, run.location, args, "resume-plan", run.planPath, "manifest" in input ? input.manifest : undefined);
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
  | { ok: true; stageId: string; runId: string; brief: string }
  | { ok: false; reason: "not-accepted" | "no-plan" | "no-next" | "brief" | "exists" | "cancelled" | "branch" | "executable" | "engine"; message?: string; stageId?: string };

/**
 * Start the stage that follows `run` in its associated plan: propose the
 * id from the plan's next stage label and canonical title, render that
 * stage's plan section as the brief, confirm, run the engine's `new-stage
 * --brief-file` with the brief in a temporary file, carry the plan
 * association (matched to that stage) over to the new run and select it.
 * The loop is not launched: Run stage is the user's next, deliberate step.
 * Nothing under .sparring is written here: the engine creates the stage
 * and writes brief.md from the file it is given.
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
  const planName = path.basename(association.path);
  if (!proposal) {
    const nextEntry = position?.next.state === "found" ? position.next.stage : undefined;
    await explainNextStageProblem(
      controller,
      overview,
      run,
      association.path,
      nextEntry?.ambiguous ? `${planName} defines ${nextEntry.display} in more than one section, so Agent Sparring cannot say which one to start.` : "the plan does not define a clear next stage after this one.",
      nextEntry ? (nextEntry.canonical ?? nextEntry.occurrences[0])?.line : undefined,
    );
    return { ok: false, reason: "no-next" };
  }
  const rendered = renderNextStageBrief(text, proposal, planName);
  if (!rendered.ok) {
    await explainNextStageProblem(controller, overview, run, association.path, rendered.message, proposal.line);
    return { ok: false, reason: "brief", message: rendered.message, stageId: proposal.stageId };
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
    const detail = ["Agent Sparring will create the stage using this plan section as its brief.", "", `Stage: ${proposal.display}`, `Stage id: ${proposal.stageId}`, `Plan section: ${planName} › ${proposal.display} (line ${proposal.line})`].join("\n");
    const choice = await vscode.window.showInformationMessage(`Start ${proposal.display}?`, { modal: true, detail }, "Start stage");
    if (choice !== "Start stage") {
      return { ok: false, reason: "cancelled" };
    }
  }
  controller.log(`Start next stage: sparring new-stage ${proposal.stageId} --brief-file <temporary copy of ${planName} › ${proposal.display}>`);
  let problem: string | undefined;
  // The brief travels through a temporary file outside the workspace; the
  // engine reads it and writes brief.md. The file is removed afterwards.
  const result: NewStageResult = await withTemporaryFile(rendered.brief, `${proposal.stageId}.md`, (briefFile) =>
    createStage(
      async (args) => {
        const outcome = await controller.runCommand({ configured: configuredExecutable(), args, cwd: location.repoRoot, name: `New stage: ${proposal.stageId}` });
        if (!outcome.ok) {
          problem = outcome.error;
          return { exitCode: undefined, output: outcome.error };
        }
        return outcome.outcome;
      },
      { stageId: proposal.stageId, repoRoot: location.repoRoot, sparringDir: location.sparringDir, briefFile },
    ),
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
    // The accepted stage stays selected; the engine refused before creating anything.
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
  controller.log(`Start next stage: created ${proposal.stageId} with ${rendered.brief.split("\n").length} lines of brief from ${planName}`);
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
    // Deliberately no loop launch: the Overview now shows the new stage as
    // Ready to start, and Run stage is the checkpoint before provider tokens.
    void vscode.window.showInformationMessage(`Agent Sparring: ${proposal.display} created as ${proposal.stageId}, briefed from ${planName}. Run stage begins implementation.`);
  }
  return { ok: true, stageId: proposal.stageId, runId: newRunId, brief: rendered.brief };
}

/**
 * How to address a managed plan run on the command line.
 *
 * A run started from an execution manifest must be resumed with
 * `--manifest`: the engine records which kind of input a run executes and
 * refuses to continue it from the other, because the two describe different
 * execution content. So the manifest is rebuilt from the plan — it is
 * deterministic, so an unchanged plan yields the same bytes and the same
 * digest — and its path is passed. Undefined when the manifest could not be
 * produced, in which case the caller must not launch.
 */
async function planInvocationFor(controller: SparringController, run: PlanRunSnapshot): Promise<{ planPath: string } | { manifest: string } | undefined> {
  if (run.state.source !== "manifest") {
    return { planPath: run.planPath };
  }
  const markdown = await readOptional(run.planPath);
  if (markdown === undefined) {
    void vscode.window.showWarningMessage(`Agent Sparring: this run was started from an execution manifest built from ${path.basename(run.planPath)}, which can no longer be read. Restore it, then continue.`);
    return undefined;
  }
  const built = buildManifest({
    markdown,
    planLabel: run.state.plan,
    planName: path.basename(run.planPath),
    known: await knownStageIds(controller, run, markdown),
  });
  if (!built.ok) {
    void vscode.window.showWarningMessage(`Agent Sparring: the execution manifest for ${path.basename(run.planPath)} could not be rebuilt: ${built.problems[0]?.reason ?? "the plan changed."}`);
    return undefined;
  }
  try {
    const file = path.join(await controller.manifestDirectory(), manifestFileName(run.planKey));
    await fs.writeFile(file, renderManifest(built.manifest), "utf8");
    return { manifest: file };
  } catch (error) {
    void vscode.window.showErrorMessage(`Agent Sparring: could not write the execution manifest: ${(error as Error).message}. Nothing was started.`);
    return undefined;
  }
}

// ---------------------------------------------------------------- continue automatically (engine-managed plan)

export type ContinueAutomaticallyOutcome =
  | { ok: true; runId: string; manifest: string; kind: "run-plan" | "resume-plan"; adopt: boolean; stages: number }
  | { ok: false; reason: "no-plan" | "unreadable" | "manifest" | "branch" | "complete" | "running" | "cancelled" | "write"; message?: string };

/**
 * Hand the whole plan to the engine and let it run until it needs a human.
 *
 * This is the preferred mode for a plan workflow. The extension does the
 * interpreting once — which headings are canonical stages, how `3A`/`3B`/
 * `3C` order, which sections are historical handoffs, which stage ids the
 * project already uses, what each brief says — writes that out as an
 * execution manifest (manifest.ts), and starts or resumes the engine's own
 * managed plan run against it. From then on the engine sequences: it
 * accepts a READY stage through its existing hard gate and starts the next
 * one, with no Accept stage / Start next stage / Run stage click in
 * between. It stops at NEEDS_YOU, ESCALATE, a failure, or the end of the
 * plan. The extension implements no sequencing of its own.
 *
 * One confirmation, before the first stage. None between stages: that is
 * the point of the mode, and each stage's own hard gate is unchanged.
 */
async function performContinueAutomatically(controller: SparringController, overview: OverviewPanelManager, options: { confirm: boolean }): Promise<ContinueAutomaticallyOutcome> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return { ok: false, reason: "no-plan" };
  }
  const location = run.location;
  const planPath = planDocumentFor(controller, run);
  if (!planPath) {
    void vscode.window.showInformationMessage("Agent Sparring: choose a plan for this stage first; automatic continuation runs that plan's stages.");
    return { ok: false, reason: "no-plan" };
  }
  const markdown = await readOptional(planPath);
  if (markdown === undefined) {
    void vscode.window.showWarningMessage(`Agent Sparring: the plan document ${path.basename(planPath)} could not be read.`);
    return { ok: false, reason: "unreadable" };
  }

  const label = run.kind === "plan" ? run.state.plan : planLabel(planPath, location.repoRoot);
  const built = buildManifest({
    markdown,
    planLabel: label,
    planName: path.basename(planPath),
    known: await knownStageIds(controller, run, markdown),
  });
  if (!built.ok) {
    const detail = built.problems.map((problem) => `• ${problem.reason}`).join("\n");
    controller.log(`Continue automatically: refused — ${built.problems.map((problem) => problem.reason).join(" ")}`);
    const choice = await vscode.window.showWarningMessage(
      `Agent Sparring: ${path.basename(planPath)} cannot be turned into an execution list.`,
      { modal: true, detail: `${detail}\n\nFix the plan, or keep using the per-stage actions.` },
      "Open plan",
    );
    if (choice === "Open plan") {
      await openDocument(planPath, `${path.basename(planPath)} is missing.`, overview.documentColumn);
    }
    return { ok: false, reason: "manifest", message: built.problems[0]?.reason };
  }

  const runId = runIdFor(location, "plan", planKey(label));
  const existing = controller.currentDiscovery.runs.find((candidate) => candidate.id === runId);
  const managed = existing?.kind === "plan" ? existing : undefined;
  if (managed?.state.status === "complete") {
    void vscode.window.showInformationMessage(`Agent Sparring: the managed run of ${label} is complete; every stage was accepted.`);
    return { ok: false, reason: "complete" };
  }
  if (controller.livenessFor(runId).state === "running") {
    void vscode.window.showInformationMessage(`Agent Sparring: a runner for ${label} is already alive in a terminal of this window.`);
    return { ok: false, reason: "running" };
  }

  const expectedBranch = managed ? await askBranch(location, managed.state.expectedBranch) : await currentBranch(location.repoRoot);
  if (!expectedBranch) {
    void vscode.window.showErrorMessage(
      `Agent Sparring: no Git branch is checked out in ${location.folderName} (detached HEAD or not a repository). Check out the plan's branch, then start again.`,
    );
    return { ok: false, reason: "branch" };
  }

  const kind: "run-plan" | "resume-plan" = managed ? "resume-plan" : "run-plan";
  // Only a fresh run needs --adopt, and only when the plan's stages already
  // exist on disk from stage-by-stage work. The engine still checks each one
  // and reports what it inherits; nothing is taken over silently.
  const adopt = kind === "run-plan" && (await anyStageExists(controller, location, built.manifest));

  if (options.confirm) {
    const detail = describePlan(built.manifest, controller, location, { kind, adopt, expectedBranch, skipped: built.skipped.length });
    const choice = await vscode.window.showInformationMessage(
      "Run this plan automatically until Agent Sparring needs you?",
      { modal: true, detail },
      "Run automatically",
    );
    if (choice !== "Run automatically") {
      return { ok: false, reason: "cancelled" };
    }
  }

  let manifestPath: string;
  try {
    manifestPath = path.join(await controller.manifestDirectory(), manifestFileName(planKey(label)));
    await fs.writeFile(manifestPath, renderManifest(built.manifest), "utf8");
  } catch (error) {
    void vscode.window.showErrorMessage(`Agent Sparring: could not write the execution manifest: ${(error as Error).message}. Nothing was started.`);
    return { ok: false, reason: "write", message: (error as Error).message };
  }

  for (const problem of built.skipped) {
    controller.log(`Continue automatically: not executable, left in the plan — ${problem.reason}`);
  }
  controller.log(
    `Continue automatically: ${kind}${adopt ? " --adopt" : ""} --manifest ${manifestPath} (${built.manifest.stages.length} stage(s): ${built.manifest.stages.map((stage) => stage.stage_id).join(", ")})`,
  );

  const invocation = { manifest: manifestPath, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir };
  const args = kind === "run-plan" ? buildRunPlanArgs({ ...invocation, adopt }) : buildResumePlanArgs(invocation);
  const result = await controller.launch({
    configured: configuredExecutable(),
    args,
    cwd: location.repoRoot,
    name: `${kind}: ${path.basename(planPath)}`,
    runId,
    kind,
    planPath,
    manifest: manifestPath,
    reveal: true,
  });
  await explainLaunch(result);
  await overview.update();
  if (!result.ok) {
    return { ok: false, reason: "write", message: result.error };
  }
  return { ok: true, runId, manifest: manifestPath, kind, adopt, stages: built.manifest.stages.length };
}

/**
 * Which stage ids this project already uses for which plan labels, so an
 * existing sequence keeps its history instead of being re-created under new
 * ids. Each standalone stage of the same project is located in the plan the
 * same way the Overview locates it — the user's manual match first, then the
 * brief's own `Stage 3B` markers, then the id — and only an unambiguous
 * match counts.
 */
async function knownStageIds(controller: SparringController, run: RunSnapshot, markdown: string): Promise<KnownStage[]> {
  const headings = parsePlanHeadings(markdown);
  const known: KnownStage[] = [];
  for (const candidate of controller.currentDiscovery.runs) {
    if (candidate.kind !== "stage" || candidate.location.projectDir !== run.location.projectDir) {
      continue;
    }
    const position = locateStage(headings, {
      stageId: candidate.stage.stageId,
      title: candidate.stage.title,
      briefText: await readOptional(path.join(candidate.stage.dir, BRIEF_FILENAME)),
      manual: controller.planAssociation(candidate.id)?.match,
    });
    const label = position?.stage?.label;
    if (label && !known.some((entry) => entry.label === label)) {
      known.push({ label, stageId: candidate.stage.stageId });
    }
  }
  return known;
}

/** Does any of the manifest's stages already exist on disk in this project? */
async function anyStageExists(controller: SparringController, location: SparringLocation, manifest: ExecutionManifest): Promise<boolean> {
  const ids = new Set(manifest.stages.map((stage) => stage.stage_id));
  if (controller.currentDiscovery.runs.some((run) => run.kind === "stage" && run.location.projectDir === location.projectDir && ids.has(run.stage.stageId))) {
    return true;
  }
  for (const id of ids) {
    try {
      await fs.access(path.join(location.sparringDir, "stages", id));
      return true;
    } catch {
      // not present
    }
  }
  return false;
}

/** The confirmation's detail: what will run, in order, and what will not. */
function describePlan(
  manifest: ExecutionManifest,
  controller: SparringController,
  location: SparringLocation,
  context: { kind: "run-plan" | "resume-plan"; adopt: boolean; expectedBranch: string; skipped: number },
): string {
  // Both shapes a stage can be discovered as: a standalone one, and one
  // already inside a managed plan run (this plan's, or an earlier one).
  const accepted = new Set<string>();
  for (const run of controller.currentDiscovery.runs) {
    if (run.location.projectDir !== location.projectDir) {
      continue;
    }
    const stages = run.kind === "stage" ? [run.stage] : run.stages;
    for (const stage of stages) {
      if (stage.state?.status === "accepted") {
        accepted.add(stage.stageId);
      }
    }
  }
  const lines = manifest.stages.map((stage) => `  ${accepted.has(stage.stage_id) ? "✓" : "•"} ${stage.label} — ${stage.title}${accepted.has(stage.stage_id) ? " (already accepted)" : ""}`);
  const parts = [
    context.kind === "resume-plan"
      ? "Agent Sparring continues the engine's managed run of this plan."
      : "Agent Sparring hands the whole plan to the engine as one managed run.",
    "",
    `Branch: ${context.expectedBranch}`,
    `Stages (${manifest.stages.length}), in this order:`,
    ...lines,
  ];
  if (context.skipped > 0) {
    parts.push("", `${context.skipped} heading${context.skipped === 1 ? "" : "s"} that only record what happened (handoffs, status notes) stay in the plan and are not run.`);
  }
  if (context.adopt) {
    parts.push("", "Stages that already exist are adopted: the engine checks each one and reports what it inherits, and refuses anything it would have to guess at.");
  }
  parts.push(
    "",
    "After this, each stage runs implementation ↔ review and, on READY, is frozen and accepted at its exact pushed commit — with no further confirmation. The run stops when the reviewer needs you, escalates, something fails, or the plan is complete.",
  );
  return parts.join("\n");
}

/**
 * The next stage cannot be started as things stand (no clear section, an
 * ambiguous definition, a heading-only section): nothing is created, the
 * reason is stated, and the two ways forward are offered.
 */
async function explainNextStageProblem(controller: SparringController, overview: OverviewPanelManager, run: StandaloneStageSnapshot, planPath: string, message: string, line: number | undefined): Promise<void> {
  controller.log(`Start next stage: nothing created — ${message}`);
  const choice = await vscode.window.showWarningMessage(`Agent Sparring: ${message}`, "Open in plan", "Change match…");
  if (choice === "Open in plan") {
    await openDocument(planPath, `the plan document ${path.basename(planPath)} is missing.`, overview.documentColumn, line);
  } else if (choice === "Change match…") {
    if (controller.currentSelection.selected?.id === run.id) {
      await matchStageCommand(controller, overview);
    }
  }
}
