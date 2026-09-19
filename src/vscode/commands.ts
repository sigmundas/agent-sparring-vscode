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
import { buildResumePlanArgs, buildRunLoopArgs, buildRunPlanArgs, buildRunSparringArgs, commandNotFoundMessage, readGitBranch, type DeferredResultAnswer } from "../core/cli";
import {
  BINDING_VERSION,
  adoptionGaps,
  bindingPathFor,
  buildManifest,
  carriedForward,
  manifestDigest,
  manifestPathFor,
  previousManifestFileNames,
  renderBindingRecord,
  renderManifest,
  type ExecutionManifest,
  type KnownStage,
  type ManifestBindingRecord,
  type ManifestOwner,
} from "../core/manifest";
import {
  BRIEF_FILENAME,
  HANDOFF_FILENAME,
  NOTES_FILENAME,
  SPARRING_FILENAME,
  currentStageOf,
  isInsidePath,
  runIdFor,
  type PlanRunSnapshot,
  type RunSnapshot,
  type SparringLocation,
  type StageSnapshot,
  type StandaloneStageSnapshot,
} from "../core/discovery";
import { stageScopeOf } from "../core/stageScope";
import { FOLLOW_ACTIVE_LABEL, describeRepositoryContext } from "../core/activeRepository";
import { decideExpectedBranch } from "../core/expectedBranch";
import { parseHandoffBranch, parsePlanStages, type PlanRunSource } from "../core/engineFormats";
import { appendHumanEvidence, OUTCOME_WORDS, renderHumanEvidence, renderHumanFeedback, submittableChecks } from "../core/humanChecks";
import { blocksLaunch } from "../core/liveness";
import type { OverviewAction } from "../core/overviewHtml";
import { UNKNOWN_RUNNER_EXPLANATION, type ActionRequired, type PlanContinuation } from "../core/overviewModel";
import { createStage, proposeNextStage, renderNextStageBrief, type NewStageResult } from "../core/nextStage";
import { buildStageIndex, locateStage, parsePlanHeadings, sectionSummary, type HeadingRef, type PlanHeading, type StageEntry } from "../core/planAssociation";
import { stageMatchRows, type StageMatchRow, type StageToMatch } from "../core/stageMatches";
import { buildRunPickGroups, describeRun } from "../core/runPick";
import { stageDisplayName } from "../core/presentation";
import { stageActions, stageRunAction } from "../core/runner";
import { planKey, planLabel, planRunId, type SparringSubcommand } from "../core/sparringCommand";
import { chooseLaunchRepository, launchTargets } from "../core/launchRepositories";
import { STAGE_REPOSITORIES_KEY, manifestRepositories, relativeRepositoryPath, repositoriesForPlan, type DeclaredRepository, type StageRepositories } from "../core/stageRepositories";
import type { ManifestRepository } from "../core/manifest";
import { STAGE_MODES_KEY, STAGE_MODE_LABELS, STAGE_MODES, modesForPlan, type StageMode, type StageModes } from "../core/stageModes";
import { withTemporaryFile } from "../core/tempFile";
import type { SparringController } from "./controller";
import type { EngineFailure, LaunchProblem, LaunchResult } from "./executionTracker";
import type { OperationView } from "./operationRegistry";
import { outputTail } from "./terminalOutput";
import { currentBranch, knownRepositories, pendingChanges } from "./git";
import { manifestSupport } from "./engineProbe";
import { openCandidateDiff } from "./overview/gitDiff";
import { configuredExecutable } from "./engineExecutable";
import { settingsTarget } from "../core/settingsTarget";
import { OverviewPanelManager } from "./overview/overviewPanel";

export function registerCommands(context: vscode.ExtensionContext, controller: SparringController): void {
  const overview: OverviewPanelManager = new OverviewPanelManager(controller, (action) => handleOverviewAction(controller, overview, action));
  context.subscriptions.push(
    overview,
    vscode.commands.registerCommand("agentSparring.showLog", () => controller.showLog()),
    vscode.commands.registerCommand("agentSparring.confirmRunnerInactive", () => confirmRunnerInactiveCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("agentSparring.selectRun", () => selectRunCommand(controller)),
    vscode.commands.registerCommand("agentSparring.followActiveRepository", () => controller.followActiveRepository()),
    vscode.commands.registerCommand("agentSparring.diagnoseDiscovery", () => controller.diagnoseDiscovery()),
    vscode.commands.registerCommand("agentSparring.openOverview", () => openOverviewCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.runPlan", () => runPlanCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.resumePlan", () => resumePlanCommand(controller)),
    vscode.commands.registerCommand("agentSparring.runStage", () => runStageCommand(controller)),
    vscode.commands.registerCommand("agentSparring.acceptStage", () => acceptStageCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.choosePlan", () => associatePlanCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.matchStage", () => matchStageCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.reviewStageMatches", () => reviewStageMatchesCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.startNextStage", () => startNextStageCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.continueAutomatically", () => void performContinueAutomatically(controller, overview, { confirm: true })),
    vscode.commands.registerCommand("agentSparring.allowPush", () => void allowPushCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.stageRepositories", () => stageRepositoriesCommand(controller)),
    vscode.commands.registerCommand("agentSparring.stageMode", () => stageModeCommand(controller)),
    vscode.commands.registerCommand("agentSparring.copyReviewContext", () => overview.copyReviewContext()),
    vscode.commands.registerCommand("agentSparring.chooseExecutable", () => chooseExecutableCommand()),
    vscode.commands.registerCommand("agentSparring.openSettings", () => openSettingsCommand(controller)),
    // The same command with the create question already answered, so the
    // integration suite can drive both branches without a dialog.
    vscode.commands.registerCommand("agentSparring._test.openSettings", (create?: boolean) => openSettingsCommand(controller, create)),
    controller.onCommandNotFound((event) => void explainCommandNotFound(event.word)),
    controller.onEngineFailed((event) => void explainEngineFailure(controller, event)),
    // Not contributed in package.json (never in the palette): hooks for the
    // extension-host integration tests, which cannot drive QuickPicks.
    vscode.commands.registerCommand("agentSparring._test.chooseRun", async (runId: string) => {
      await controller.chooseRun(controller.currentDiscovery.runs.find((run) => run.id === runId));
      return controller.currentSelection.selected?.id;
    }),
    vscode.commands.registerCommand("agentSparring._test.liveness", (runId: string) => {
      const liveness = controller.livenessFor(runId);
      return { state: liveness.state, source: liveness.source, turnActive: liveness.turnActive, interrupted: liveness.interrupted, stop: liveness.stop, detail: liveness.detail, execution: liveness.execution };
    }),
    // Stop, driven exactly as the webview drives it: an explicit execution
    // id, resolved from the rendered model when the test does not name one.
    vscode.commands.registerCommand("agentSparring._test.stop", async (runId: string, executionId?: string) => {
      const target = executionId ?? controller.stopTargetFor(runId)?.executionId;
      if (!target) {
        return { requested: false, reason: "no-target", detail: "no exact runner could be identified for this run" };
      }
      return controller.requestStop(runId, target);
    }),
    // What a window reload would find: the launches recorded in workspaceState,
    // including the ones already known to have ended.
    vscode.commands.registerCommand("agentSparring._test.persistedLaunches", () => controller.persistedLaunches()),
    // The terminal-ownership boundary: which terminals the extension owns,
    // which of them may be written to, and where a run's runner actually is.
    vscode.commands.registerCommand("agentSparring._test.ownedTerminals", () => controller.ownedTerminals()),
    vscode.commands.registerCommand("agentSparring._test.hostingTerminal", (runId: string) => controller.hostingTerminal(runId)),
    // Submitted commands whose start has not been observed: never runners,
    // and the reason a second command for the same run is refused.
    vscode.commands.registerCommand("agentSparring._test.unresolvedSubmissions", () => controller.unresolvedSubmissions()),
    // The one record holding a run's duplicate guard, in whatever state —
    // including the states this window is itself watching, which `unresolved`
    // deliberately leaves out because nobody can tell it anything about them.
    vscode.commands.registerCommand("agentSparring._test.guardFor", (runId: string) => controller.guardFor(runId)),
    // Takes the immutable operation id, exactly as the dialog does: an
    // override never searches for another record with the same key.
    vscode.commands.registerCommand("agentSparring._test.overrideSubmission", (operationId: string, note: string) => controller.overrideSubmission(operationId, note ?? "confirmed by the person in a test").overridden),
    vscode.commands.registerCommand("agentSparring._test.probeSubmissions", () => controller.probeSubmissions()),
    // The explicit human recovery from `unknown`, driven exactly as the
    // Overview drives it: both ids come from the model that was built, never
    // from a lookup made when the click arrives. With no ids given, the ones
    // the panel would currently carry are used; passing a stale pair is how a
    // test reproduces a panel left open while a newer run started.
    vscode.commands.registerCommand("agentSparring._test.confirmRunnerInactive", async (executionId?: string, operationId?: string) => {
      const run = controller.currentSelection.selected;
      if (!run) {
        return undefined;
      }
      const unknown = executionId === undefined ? ((await overview.buildModel()) as { unknownRunner?: { executionId?: string; operationId?: string } }).unknownRunner : { executionId, operationId };
      if (!unknown) {
        return undefined;
      }
      return controller.confirmRunnerInactive(run.id, unknown.executionId, unknown.operationId);
    }),
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
    // One inline agent-config change, delivered exactly as the webview would
    // post it and awaited to completion.
    vscode.commands.registerCommand("agentSparring._test.agentConfig", (message: unknown) => overview.deliverAgentConfig(message)),
    vscode.commands.registerCommand("agentSparring._test.startNextStage", async () => {
      const run = controller.currentSelection.selected;
      return run?.kind === "stage" ? performStartNextStage(controller, overview, run, { confirm: false }) : undefined;
    }),
    vscode.commands.registerCommand("agentSparring._test.continueAutomatically", () => performContinueAutomatically(controller, overview, { confirm: false })),
    // Allow push exactly as the panel drives it: the candidate comes from the
    // model that was built, and the toggle from the stored draft. Passing a
    // toggle here only sets that draft first, so a test can reproduce both
    // halves of the one click.
    vscode.commands.registerCommand("agentSparring._test.allowPush", async (autoPush?: boolean) => {
      const run = controller.currentSelection.selected;
      if (run && autoPush !== undefined) {
        await controller.setAutoPushDraft(run.id, autoPush);
      }
      return allowPushCommand(controller, overview);
    }),
    vscode.commands.registerCommand("agentSparring._test.declareStageRepository", async (label: string, repository: DeclaredRepository | undefined) => {
      const run = controller.currentSelection.selected;
      const key = run ? await planKeyFor(controller, run) : undefined;
      if (!run || !key) {
        return undefined;
      }
      if (repository) {
        await controller.declareStageRepository(key, run.location.projectDir, label, repository);
      }
      return controller.stageRepositoriesFor(key, run.location.projectDir, label);
    }),
    // What a *given* worktree sees declared for a plan stage, so the
    // integration suite can ask the same question of two worktrees and prove
    // they are independent through real workspace state — where the scope key
    // has to survive being a JSON key containing a path.
    // The manifest a *given* worktree would hand the engine for a plan,
    // built through the same `declarationsFor` the launcher uses — so the
    // suite compares what would actually execute, not a restatement of it.
    // Nothing is launched and nothing is written.
    vscode.commands.registerCommand("agentSparring._test.manifestFor", async (projectDir: string, planPath: string) => {
      const markdown = await readOptional(planPath);
      if (markdown === undefined) {
        return undefined;
      }
      const location: SparringLocation = { sparringDir: path.join(projectDir, ".sparring"), projectDir, repoRoot: projectDir, workspaceFolder: projectDir, folderName: path.basename(projectDir) };
      const label = planLabel(planPath, projectDir);
      const built = buildManifest({ markdown, planLabel: label, planName: path.basename(planPath), ...declarationsFor(controller, planKey(label), location) });
      if (!built.ok) {
        return { ok: false, reason: built.problems[0]?.reason };
      }
      return { ok: true, planKey: planKey(label), text: renderManifest(built.manifest), digest: manifestDigest(built.manifest) };
    }),
    // Exactly the values VS Code holds for the declaration keys — what it
    // would restore into a new window, and all it would restore.
    vscode.commands.registerCommand("agentSparring._test.storedDeclarations", () => ({
      modes: context.workspaceState.get(STAGE_MODES_KEY),
      repositories: context.workspaceState.get(STAGE_REPOSITORIES_KEY),
    })),
    // The manifest a worktree would build from *supplied* stored values
    // instead of from the live workspace state: a cold read of the persisted
    // shape, through the same readers and the same builder production uses.
    vscode.commands.registerCommand(
      "agentSparring._test.manifestFromStored",
      async (stored: { modes?: StageModes; repositories?: StageRepositories }, projectDir: string, planPath: string) => {
        const markdown = await readOptional(planPath);
        if (markdown === undefined) {
          return undefined;
        }
        const label = planLabel(planPath, projectDir);
        const key = planKey(label);
        const built = buildManifest({
          markdown,
          planLabel: label,
          planName: path.basename(planPath),
          repositories: manifestRepositories(repositoriesForPlan(stored.repositories, key, projectDir), projectDir),
          modes: modesForPlan(stored.modes, key, projectDir),
        });
        if (!built.ok) {
          return { ok: false, reason: built.problems[0]?.reason };
        }
        return { ok: true, planKey: key, text: renderManifest(built.manifest), digest: manifestDigest(built.manifest) };
      },
    ),
    vscode.commands.registerCommand("agentSparring._test.declareStageMode", async (label: string, mode: StageMode) => {
      const run = controller.currentSelection.selected;
      const key = run ? await planKeyFor(controller, run) : undefined;
      if (!run || !key) {
        return undefined;
      }
      await controller.declareStageMode(key, run.location.projectDir, label, mode);
      return controller.stageModeFor(key, run.location.projectDir, label);
    }),
    vscode.commands.registerCommand("agentSparring._test.stageDeclarations", async (projectDir: string, label: string) => {
      const run = controller.currentSelection.selected;
      const key = run ? await planKeyFor(controller, run) : undefined;
      if (!key) {
        return undefined;
      }
      return {
        planKey: key,
        repositories: controller.stageRepositoriesFor(key, projectDir, label),
        mode: controller.stageModeFor(key, projectDir, label),
      };
    }),
    vscode.commands.registerCommand("agentSparring._test.lastCommandNotFound", () => lastCommandNotFound),
    controller.onCommandNotFound((event) => {
      lastCommandNotFound = event;
    }),
    // The webview's own actions, as the Overview's buttons deliver them.
    vscode.commands.registerCommand("agentSparring._test.overviewAction", (action: OverviewAction) => handleOverviewAction(controller, overview, action)),
    vscode.commands.registerCommand("agentSparring._test.recordHumanCheck", async (key: string, outcome: "pass" | "fail" | "blocked", note?: string) => {
      const run = controller.currentSelection.selected;
      if (!run) {
        return undefined;
      }
      await controller.setHumanCheck(stageScopeOf(run), key, { outcome, note });
      return controller.humanChecks(stageScopeOf(run))[key];
    }),
    vscode.commands.registerCommand("agentSparring._test.recordHumanFeedback", async (text: string) => {
      const run = controller.currentSelection.selected;
      if (!run) {
        return undefined;
      }
      await controller.setHumanFeedback(stageScopeOf(run), text);
      return controller.humanFeedback(stageScopeOf(run));
    }),
    vscode.commands.registerCommand("agentSparring._test.manifestDirectory", () => controller.manifestDirectoryPath),
    vscode.commands.registerCommand("agentSparring._test.lastEngineFailure", () => lastEngineFailure),
    // What `Run plan…` would have to choose from, after the same wait it
    // performs: the integration suite checks in a real window both that the
    // wait is for repository *discovery* and not merely for the Git API, and
    // that a `.sparring` directory outside a repository is not offered.
    vscode.commands.registerCommand("agentSparring._test.launchCandidates", async () =>
      (await controller.launchRepositories()).map((candidate) => ({
        repoRoot: candidate.location.repoRoot,
        folderName: candidate.location.folderName,
        established: candidate.established,
        launchable: candidate.launchable,
        blocked: candidate.blocked,
      })),
    ),
    controller.onEngineFailed((event) => {
      lastEngineFailure = event;
    }),
  );
}

let lastCommandNotFound: { runId: string; word: string; exitCode: number } | undefined;
let lastEngineFailure: EngineFailure | undefined;

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
  // Grouped, because the two kinds answer different questions: a plan run is
  // the whole job with its timeline, a standalone stage is one old stage to
  // inspect. They used to sit in one dense list, which is how a completed
  // plan's own history came to look like the thing to pick.
  const groups = buildRunPickGroups(runs, { selectedId: controller.currentSelection.selected?.id, memberships: await controller.planMemberships() });
  const items: RunItem[] = [];
  for (const group of groups) {
    items.push({ label: group.title, kind: vscode.QuickPickItemKind.Separator });
    for (const item of group.items) {
      items.push({ label: item.label, description: item.description, detail: item.detail, run: item.run });
    }
  }
  // Picking a row *pins* it: it is kept even when this window moves to
  // another repository, which is the point of opening history there. The way
  // back is the same list, so the two modes are named next to each other
  // rather than one of them being a command you have to already know about.
  const selection = controller.currentSelection;
  const context = describeRepositoryContext(selection);
  items.push({ label: "REPOSITORY CONTEXT", kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: `${context.mode === "pinned" ? "" : "$(check) "}$(sync) ${FOLLOW_ACTIVE_LABEL}`,
    description: selection.scope ? `automatic selection in ${selection.scope.name}` : "automatic selection; no active repository resolved",
    detail: context.mode === "pinned" ? "Releases the pin above." : "Already following; every row above pins instead.",
    run: undefined,
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Pin a run, or follow the active repository. ${context.text}`,
  });
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


// ---------------------------------------------------------------- settings (project.toml)

/**
 * Open the project's own `.sparring/project.toml`, creating it first if the
 * person asks.
 *
 * The file is the settings surface. There is deliberately no form here: the
 * engine owns the schema, `project.toml` is human-owned configuration that a
 * managed run never rewrites, and an editor that let the extension author
 * TOML would be a second, drifting opinion about what the schema is.
 *
 * Creation goes through the engine's own `init-config` for the same reason:
 * the template belongs to the engine, so the extension has no copy of it to
 * fall behind.
 */
/** What an invocation did, so the integration suite can assert on it. */
export interface SettingsOutcome {
  /** Absolute path of the file that was opened, when one was. */
  opened?: string;
  /** The file did not exist and creation was offered. */
  offered?: boolean;
  /** The engine's init-config ran and produced the file. */
  created?: boolean;
  /** Why nothing was opened. */
  problem?: string;
}

/**
 * `create` answers the "create it?" question without a dialog. `undefined`
 * asks the person, which is what the real command does; the test seam
 * supplies an explicit answer so both branches can be exercised for real.
 */
async function openSettingsCommand(controller: SparringController, create?: boolean): Promise<SettingsOutcome> {
  const target = settingsTarget(controller.currentSelection);
  if (!target) {
    const problem = "no repository is selected, so there are no project settings to open.";
    void vscode.window.showInformationMessage(`Agent Sparring: ${problem}`);
    return { problem };
  }
  if (await exists(target.configPath)) {
    await vscode.window.showTextDocument(vscode.Uri.file(target.configPath), { preview: false, preserveFocus: false });
    return { opened: target.configPath };
  }
  const label = "Create project settings";
  const answer =
    create ??
    (await vscode.window.showInformationMessage(`Agent Sparring: ${target.repository} has no .sparring/project.toml yet.`, label)) === label;
  if (!answer) {
    return { offered: true };
  }
  const result = await controller.runCommand({
    configured: configuredExecutable(),
    args: ["--sparring-dir", target.sparringDir, "init-config"],
    cwd: target.projectDir,
    name: `Create project settings: ${target.repository}`,
    repoRoot: target.projectDir,
    sparringDir: target.sparringDir,
  });
  if (!result.ok) {
    const problem = `the engine could not create project settings: ${result.error}`;
    void vscode.window.showErrorMessage(`Agent Sparring: ${problem}`);
    return { offered: true, problem };
  }
  if (!(await exists(target.configPath))) {
    // The engine ran and the file is still not there: say so rather than
    // opening an editor on nothing, and leave the log as the evidence.
    const problem = "the engine did not create .sparring/project.toml; see the log.";
    void vscode.window.showErrorMessage(`Agent Sparring: ${problem}`);
    controller.showLog();
    return { offered: true, problem };
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target.configPath), { preview: false, preserveFocus: false });
  await controller.refresh();
  return { offered: true, created: true, opened: target.configPath };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
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
    case "openSettings":
      await openSettingsCommand(controller);
      return;
    case "showLog":
      controller.showLog();
      return;
    case "selectRun":
      await selectRunCommand(controller);
      await overview.update();
      return;
    case "followActiveRepository":
      await controller.followActiveRepository();
      await overview.update();
      return;
    case "runPlan":
      return runPlanCommand(controller, overview);
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
    case "reviewStageMatches":
      await reviewStageMatchesCommand(controller, overview);
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
    case "sendFeedbackForReview":
      await sendFeedbackForReviewCommand(controller, overview);
      return;
    case "confirmRunnerInactive":
      await confirmRunnerInactiveCommand(controller, overview);
      return;
    case "allowPush":
      await allowPushCommand(controller, overview);
      return;
    case "doNotAllowPush":
      await doNotAllowPushCommand(controller, overview);
      return;
    case "dismissSubmissionFailure":
      if (run) {
        // Only the report goes. The drafts it was reporting about are the
        // user's work and are never touched from here.
        await controller.dismissSubmission(stageScopeOf(run));
        await overview.update();
      }
      return;
    case "openPlanRun": {
      // The stage on screen is one stage of a managed plan run: select that
      // run, so the Overview shows the whole job and its timeline. This is the
      // one action here that changes the selection; it opens no document.
      //
      // The run is taken from the model the button was rendered from, so what
      // is selected is exactly what the screen named — and it works for a
      // complete run as well as a live one.
      const model = await overview.buildModel();
      const plan = model.followPlan ? controller.currentDiscovery.runs.find((candidate) => candidate.id === model.followPlan?.runId) : undefined;
      if (!plan) {
        void vscode.window.showInformationMessage("Agent Sparring: the managed plan run for this stage is no longer discoverable.");
        await overview.update();
        return;
      }
      await showRun(controller, overview, plan);
      return;
    }
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
  await explainLaunch(controller, result);
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
    await sayRunnerAlive(controller, overview, `a runner is still alive for ${run.stage.stageId}; wait for it to finish before accepting.`, run.id);
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
  let problem: { error: string; problem: LaunchProblem; submission?: OperationView } | undefined;
  try {
    const result = await acceptStage(async (args) => {
      const outcome = await controller.runCommand({ configured: configuredExecutable(), args, cwd: repoRoot, name: `Accept stage: ${run.stage.stageId}` });
      if (!outcome.ok) {
        problem = { error: outcome.error, problem: outcome.problem, submission: outcome.submission };
        return { exitCode: undefined, output: outcome.error };
      }
      return outcome.outcome;
    }, invocation);
    if (problem) {
      await explainCommandProblem(controller, problem);
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
/**
 * The way out of a runner nothing could establish anything about.
 *
 * It is an assertion, and it is asked for as one: the person is told what is
 * unknown, what confirming does and what it deliberately does not claim. It
 * targets the exact execution the panel was rendered from, so a stale panel
 * cannot settle a newer run's runner, and it invents no exit code — the
 * evidence submission becomes retryable, with its text intact, and is
 * reported as neither delivered nor failed.
 */
async function confirmRunnerInactiveCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  const model = await overview.buildModel();
  const unknown = model.kind === "run" ? model.unknownRunner : undefined;
  if (!unknown) {
    void vscode.window.showInformationMessage("Agent Sparring: the status of this run's runner is not in question, so there is nothing to confirm.");
    return;
  }
  const liveness = controller.livenessFor(run.id);
  const confirmed = await vscode.window.showWarningMessage(
    "Is the previous runner no longer active?",
    {
      modal: true,
      detail: [
        UNKNOWN_RUNNER_EXPLANATION,
        "",
        liveness.detail,
        "",
        "Confirming records that as your statement. It releases this run's actions and lets you send any evidence you drafted again; it claims nothing about whether the engine recorded anything.",
        "A command already handed to a shell may still be queued. Only confirm after checking that the exact command cannot run later; finding no running process alone does not establish that.",
        "If that runner is still working or its command can still start, starting another one could do the same engine operation twice.",
      ].join("\n"),
    },
    "Yes — it is no longer active",
  );
  if (confirmed !== "Yes — it is no longer active") {
    return;
  }
  // Both ids come from the model this dialog was built from, and neither is
  // looked up again: the execution whose liveness is ended, and the exact
  // operation whose guard the person is taking responsibility for. A newer run
  // that started while this dialog was open holds the same runner key, and
  // must be left exactly as it is.
  const result = await controller.confirmRunnerInactive(run.id, unknown.executionId, unknown.operationId);
  await overview.update();
  if (!result.confirmed) {
    void vscode.window.showInformationMessage("Agent Sparring: that runner is no longer the one this run is waiting on — the panel has been refreshed. Nothing was changed.");
    return;
  }
  void vscode.window.showInformationMessage(
    `Agent Sparring: recorded that you checked and the runner is no longer active. Your drafts are preserved. Nothing has been resubmitted; use the submission action in Overview to retry. Whether the engine recorded the earlier evidence is unknown.`,
  );
}

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
  if (panel.kind === "deferred_verification") {
    await submitDeferredVerification(controller, overview, run, panel);
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
  const sent = await askReviewerAgain(controller, run, entry, `Submit for review: ${count} manual verification result(s)`);
  if (sent.launched) {
    // Handed over, not recorded. The drafts stay exactly as they are until
    // this execution exits 0; see controller.resolveSubmissions.
    await controller.beginSubmission({
      runId: run.id,
      channel: "checks",
      executionId: sent.executionId,
      startedAtMs: Date.now(),
      entry,
      results: count,
      stageId: run.kind === "plan" ? run.currentStage.stageId : run.stage.stageId,
    });
  }
  await overview.update();
}

/**
 * Answer the plan's deferred-verification checkpoint.
 *
 * Deliberately a different path from every other submission here, because
 * what is being answered is different: not a stage's review, but the run's
 * own obligations, which the engine keeps in its ledger and addresses by
 * *asking* rather than by stage. So the results go through
 * `resume-plan --deferred-result <gate instance>:<check id>=<outcome>[=note]`
 * and nothing is written to notes.md from here — the engine records each
 * answer in its ledger *and* in the originating stage's notes, which is the
 * one place it can attribute them correctly. The extension writing a second
 * copy would be guessing which stage each result belonged to.
 *
 * The qualified reference is always sent. A bare check id can belong to two
 * askings at the same checkpoint, and the engine refuses an ambiguous one
 * rather than guessing; sending the asking the panel was rendered from means
 * the answer lands where the person was looking and nowhere else.
 */
async function submitDeferredVerification(
  controller: SparringController,
  overview: OverviewPanelManager,
  run: RunSnapshot,
  panel: ActionRequired,
): Promise<void> {
  if (run.kind !== "plan") {
    return;
  }
  const answers: DeferredResultAnswer[] = [];
  for (const check of submittableChecks(panel)) {
    const outcome = check.record.outcome;
    if (!check.id || !check.gateInstanceId || !outcome) {
      // Without both identities the engine cannot attribute the answer, and
      // an answer attributed to the wrong asking is worse than one that was
      // never sent. Refuse the whole submission rather than send part of it.
      void vscode.window.showWarningMessage(
        "Agent Sparring: one of these deferred checks does not carry the asking it belongs to, so its result could not be addressed to the engine. Nothing was submitted; reopen the panel to refresh it from the engine's own state.",
      );
      return;
    }
    answers.push({ gateInstanceId: check.gateInstanceId, checkId: check.id, outcome, note: check.record.note });
  }
  if (answers.length === 0) {
    void vscode.window.showInformationMessage("Agent Sparring: record Pass, Fail or Can't test for the remaining deferred checks first.");
    return;
  }
  const failing = answers.filter((answer) => answer.outcome !== "pass").length;
  const summary = answers.map((answer) => `${OUTCOME_WORDS[answer.outcome]} — ${answer.checkId}${answer.note ? `: ${answer.note}` : ""}`).join("\n");
  const consequence =
    failing === 0
      ? "Every deferred check passes, so the engine completes the plan. Nothing already accepted is re-run."
      : `${failing} of them ${failing === 1 ? "is not a pass" : "are not passes"}, so the plan stays open. A Fail is written into the stage that raised the check, where that stage's agents read it; Can't test records that no result could be obtained.`;
  const choice = await vscode.window.showInformationMessage(
    "Submit deferred verification?",
    { modal: true, detail: [`${answers.length} result${answers.length === 1 ? "" : "s"} will be recorded against the askings that raised them.`, "", summary, "", consequence].join("\n") },
    "Submit verification",
  );
  if (choice !== "Submit verification") {
    return;
  }
  const expectedBranch = await resolveExpectedBranch(run.location, run.state.expectedBranch);
  if (!expectedBranch) {
    return;
  }
  const input = await planInvocationFor(controller, run);
  if (!input) {
    return;
  }
  const args = buildResumePlanArgs({ ...input, repoRoot: run.location.repoRoot, expectedBranch, sparringDir: run.location.sparringDir, deferredResults: answers });
  controller.log(`Submit deferred verification: ${answers.length} result(s) passed to resume-plan --deferred-result`);
  const result = await launch(controller, run.location, args, "resume-plan", run.planPath, "manifest" in input ? input.manifest : undefined);
  if (result.ok) {
    await controller.beginSubmission({
      runId: run.id,
      channel: "checks",
      executionId: result.record.id,
      startedAtMs: Date.now(),
      entry: summary,
      results: answers.length,
      stageId: run.currentStage.stageId,
    });
  }
  await overview.update();
}

/**
 * Freeform human feedback, sent to the *reviewer* against the unchanged
 * candidate.
 *
 * This is the other half of the human gate, and it deliberately routes the
 * same way as a check result rather than more directly. A person who finds a
 * reproducible crash on the way to check 1 has something the workflow needs,
 * but what they have is *evidence*, not a verdict and not an implementation
 * order: whether it means SEND_BACK, the same checks again, revised checks or
 * nothing at all is the reviewer's call, made against its own acceptance
 * rules. Handing the prose straight to the stage agent would skip that call
 * and let a sentence typed in a text box act as a routing decision.
 *
 * So: the text is recorded verbatim under `## Human evidence`, in its own
 * `### Additional human feedback` block, and the reviewer is asked to rule
 * again — `resume-plan --evidence` inside a managed run, `run-sparring` for a
 * standalone stage. No check is marked, nothing is accepted, and the outstanding
 * checks stay outstanding. The draft is cleared only once the engine has
 * actually been launched.
 */
async function sendFeedbackForReviewCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
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
  if (!panel.feedback.send.enabled) {
    void vscode.window.showInformationMessage(`Agent Sparring: ${panel.feedback.send.detail}`);
    return;
  }
  const entry = renderHumanFeedback(panel.feedback.draft ?? "", new Date());
  if (!entry) {
    void vscode.window.showInformationMessage("Agent Sparring: type what you found in 'Additional findings or instructions' first.");
    return;
  }
  const outstanding = panel.required.filter((item) => !item.record?.outcome).length;
  const stay =
    outstanding === 0
      ? "No check result is recorded or changed by this."
      : `The ${outstanding === 1 ? "one check" : `${outstanding} checks`} still without a result stay that way: nothing is marked Pass, Fail or Can't test.`;
  const detail = [
    `This text goes to the reviewer as human evidence against the unchanged candidate, and the reviewer rules again. ${stay}`,
    "",
    entry,
  ].join("\n");
  const choice = await vscode.window.showInformationMessage("Send this feedback to the reviewer?", { modal: true, detail }, "Send feedback for review");
  if (choice !== "Send feedback for review") {
    return;
  }
  const sent = await askReviewerAgain(controller, run, entry, "Send feedback for review: freeform human feedback");
  if (sent.launched) {
    await controller.beginSubmission({
      runId: run.id,
      channel: "feedback",
      executionId: sent.executionId,
      startedAtMs: Date.now(),
      entry,
      results: 0,
      stageId: run.kind === "plan" ? run.currentStage.stageId : run.stage.stageId,
    });
  }
  await overview.update();
}

/**
 * Record `entry` as human evidence and ask the reviewer to rule again — the
 * one path both submission buttons take, so that "the reviewer looks at the
 * unchanged candidate" means the same command, on the same branch, with the
 * same failure reporting, whichever button was pressed.
 *
 *  - managed plan run → the engine's own `resume-plan --evidence`, which
 *    records the evidence and continues the plan at this same stage. The plan
 *    loop is the engine's orchestration and is not bypassed here.
 *  - standalone stage → the entry is written into the stage's notes.md, then
 *    `sparring run-sparring <stage>` resumes the recorded sparring session
 *    against the unchanged candidate. `run-loop` would start the stage agent
 *    with nothing to implement; Resume stage stays the separate action for
 *    actual implementation work.
 *
 * The launch result names the execution whose *exit code* decides the
 * submission, so the caller can record a submission in flight and keep the
 * drafts until the engine has actually recorded the evidence. Launching is
 * not submitting. Nothing is frozen or accepted either way.
 */
type Handover = { launched: false } | { launched: true; executionId: string };

async function askReviewerAgain(controller: SparringController, run: RunSnapshot, entry: string, logPrefix: string): Promise<Handover> {
  if (run.kind === "plan") {
    const expectedBranch = await resolveExpectedBranch(run.location, run.state.expectedBranch);
    if (!expectedBranch) {
      return { launched: false };
    }
    const input = await planInvocationFor(controller, run);
    if (!input) {
      return { launched: false };
    }
    const args = buildResumePlanArgs({ ...input, repoRoot: run.location.repoRoot, expectedBranch, sparringDir: run.location.sparringDir, evidence: entry });
    controller.log(`${logPrefix} passed to resume-plan --evidence for ${run.currentStage.stageId}`);
    const result = await launch(controller, run.location, args, "resume-plan", run.planPath, "manifest" in input ? input.manifest : undefined);
    return result.ok ? { launched: true, executionId: result.record.id } : { launched: false };
  }
  const expectedBranch = await currentBranch(run.location.repoRoot);
  if (!expectedBranch) {
    void vscode.window.showErrorMessage(
      `Agent Sparring: no Git branch is checked out in ${run.location.folderName} (detached HEAD or not a repository). Check out the stage's branch, then submit again.`,
    );
    return { launched: false };
  }
  if (!(await recordEvidence(controller, run, entry))) {
    return { launched: false };
  }
  const args = buildRunSparringArgs({ stageId: run.stage.stageId, repoRoot: run.location.repoRoot, expectedBranch, sparringDir: run.location.sparringDir });
  controller.log(`${logPrefix}: sparring run-sparring ${run.stage.stageId} (branch ${expectedBranch}); the stage agent is not started`);
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
  await explainLaunch(controller, result);
  return result.ok ? { launched: true, executionId: result.record.id } : { launched: false };
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
async function explainWrongBranch(guard: { expected: string; actual?: string }, subject = "this stage belongs to"): Promise<void> {
  const where = guard.actual ? `the repository is on ${guard.actual}` : "no branch is checked out";
  void vscode.window.showWarningMessage(
    `Agent Sparring: ${subject} ${guard.expected}, but ${where}. Switch branches first; the engine refuses a run on another branch.`,
  );
}

// ---------------------------------------------------------------- push authorization

export type AllowPushOutcome =
  | { ok: true; candidateSha: string; forRun: boolean; executionId?: string }
  | { ok: false; reason: "no-run" | "not-waiting" | "stale" | "branch" | "input" | "cancelled" | "launch"; message?: string };

/**
 * Allow the engine to push the candidate the person is looking at.
 *
 * What this does **not** do is push anything. The extension runs no `git
 * push`, and there is no code path here that could: it hands the engine a
 * permission (`resume-plan --allow-push-candidate <commit>`, plus
 * `--allow-push-for-run` when the toggle is on) and the engine performs the
 * push, re-proves that the commit is really on the remote branch, and then
 * runs its own unchanged acceptance gate. Whether the push may happen at all
 * is therefore decided in one place, by the component that owns acceptance.
 *
 * The commit is taken from the model the button was rendered from, and the
 * engine is *also* told to check it against what the run is actually waiting
 * on. That is what makes a panel that has been open a while harmless: it can
 * only ever authorize the candidate it was showing, and if the run has moved
 * on the engine refuses rather than authorizing a commit nobody looked at.
 */
async function allowPushCommand(controller: SparringController, overview: OverviewPanelManager): Promise<AllowPushOutcome> {
  const run = controller.currentSelection.selected;
  if (!run || run.kind !== "plan") {
    return { ok: false, reason: "no-run" };
  }
  const model = await overview.buildModel();
  const panel = model.kind === "run" ? model.pushAuthorization : undefined;
  if (!panel) {
    void vscode.window.showInformationMessage("Agent Sparring: this run is not waiting for permission to push anything right now.");
    await overview.update();
    return { ok: false, reason: "not-waiting" };
  }
  if (!panel.allow.enabled) {
    void vscode.window.showInformationMessage(`Agent Sparring: ${panel.allow.detail}`);
    return { ok: false, reason: model.branchGuard ? "branch" : "cancelled" };
  }
  const forRun = panel.autoPush.checked;
  const expectedBranch = await resolveExpectedBranch(run.location, run.state.expectedBranch);
  if (!expectedBranch) {
    return { ok: false, reason: "branch" };
  }
  const input = await planInvocationFor(controller, run);
  if (!input) {
    return { ok: false, reason: "input" };
  }
  const args = buildResumePlanArgs({
    ...input,
    repoRoot: run.location.repoRoot,
    expectedBranch,
    sparringDir: run.location.sparringDir,
    allowPush: { candidateSha: panel.candidateSha, forRun },
  });
  controller.log(
    `Allow push: authorizing ${panel.candidateSha} for ${panel.target}${forRun ? ", and this run's later verified candidates" : ""}; the engine performs the push and then its own acceptance gate`,
  );
  const result = await launch(controller, run.location, args, "resume-plan", run.planPath, "manifest" in input ? input.manifest : undefined);
  if (!result.ok) {
    await overview.update();
    return { ok: false, reason: "launch", message: result.error };
  }
  // The toggle was an intention; the engine now holds the decision, and the
  // Overview reads it back from the run state. Keeping the draft would leave
  // this window's checkbox as a second, quieter answer to the same question.
  await controller.setAutoPushDraft(run.id, false);
  await overview.update();
  return { ok: true, candidateSha: panel.candidateSha, forRun, executionId: result.record.id };
}

/**
 * Leave it. Nothing is pushed, nothing is recorded, and the run stays
 * exactly where the engine left it — which is a real answer, because
 * pushing the branch by hand and resuming normally is a perfectly good way
 * through this, and so is deciding not to accept the candidate at all.
 */
async function doNotAllowPushCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  const model = await overview.buildModel();
  const panel = model.kind === "run" ? model.pushAuthorization : undefined;
  if (!panel) {
    await overview.update();
    return;
  }
  await controller.setAutoPushDraft(run.id, false);
  controller.log(`Allow push: declined for ${panel.candidateSha}; nothing was pushed and the run is unchanged`);
  void vscode.window.showInformationMessage(
    `Agent Sparring: nothing was pushed. ${panel.shortSha} is still waiting, and the plan is paused where it was. You can push the branch to ${panel.target} yourself and then continue the plan, or leave it as it is.`,
  );
  await overview.update();
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

/** One stage to match, addressed explicitly so the plan-level review can fix a stage that is not the selected one. */
interface MatchTarget {
  runId: string;
  stage: StageSnapshot;
  planPath: string;
}

/**
 * Let the user say which section of the associated plan this stage is,
 * when automatic matching could not (or chose differently). The choice is
 * a heading identity in VS Code workspace state, never engine state.
 *
 * `target` names the stage explicitly; without it the selected run is the
 * stage, which is the ordinary "Change match…" case. Either way the dialog
 * names the stage in its title, because this only ever remaps *one* stage
 * and mistaking which one silently moves a stage's whole history.
 */
async function matchStageCommand(controller: SparringController, overview: OverviewPanelManager, target?: MatchTarget): Promise<void> {
  const run = target ? undefined : controller.currentSelection.selected;
  if (!target) {
    if (!run) {
      return;
    }
    if (run.kind === "plan") {
      void vscode.window.showInformationMessage("Agent Sparring: this is an engine-managed plan run; the engine records which stage is current.");
      return;
    }
  }
  const runId = target?.runId ?? run!.id;
  const stage = target?.stage ?? (run as StandaloneStageSnapshot).stage;
  if (target && !controller.planAssociation(runId)) {
    // Reached from the plan-level review: this stage was never opened, so it
    // has no association of its own, and a manual match without one would be
    // dropped. Associating it with the plan being reviewed is exactly what
    // the user is saying by matching it there.
    await controller.setAssociatedPlan(runId, target.planPath);
  }
  const association = controller.planAssociation(runId);
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
  if (!target) {
    // Only for the stage the panel is showing: from the plan-level review
    // the plan is the fixed thing and the stage is what is being placed in
    // it, so re-associating or dropping it there would be a different act.
    items.push({ label: "$(file) Choose another plan file…", description: path.basename(association.path), action: "changePlan" });
    items.push({ label: "$(close) Remove the plan association", description: "the stage keeps its state; only the plan display goes away", action: "remove" });
  }
  // The stage this remaps is named in the title, not only in the small
  // print: the dialog looks the same for every stage, and picking a section
  // for the wrong one silently moves that stage's whole history.
  const named = current?.stage?.display ?? stageDisplayName(stage);
  const picked = await vscode.window.showQuickPick(items, {
    title: `Match "${named}" to which plan section?`,
    placeHolder: `Only ${stage.stageId} is remapped, in ${path.basename(association.path)} (kept in VS Code only; the engine is not told)`,
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
    await controller.setAssociatedPlan(runId, undefined);
  } else if (picked.action === "clear") {
    await controller.setManualMatch(runId, undefined);
  } else if (picked.match) {
    await controller.setManualMatch(runId, picked.match);
  }
  await overview.update();
}

/**
 * Every stage this project already has, and which section of the plan each
 * one is — in one place, so a historical stage that nothing could match is
 * fixed *there* rather than by selecting it and using "Change match…", which
 * remaps whatever stage happens to be on screen.
 *
 * That accident is the reason this exists: matching is deliberately
 * conservative, an old brief that mentions three stage numbers matches none
 * of them, and the natural way to "fix Stage 1" was to open the panel — which
 * was showing Stage 3D — and remap that instead.
 */
async function reviewStageMatchesCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const run = controller.currentSelection.selected;
  const planPath = run ? planDocumentFor(controller, run) : undefined;
  if (!run || !planPath) {
    void vscode.window.showInformationMessage("Agent Sparring: choose a plan for this stage first; stage matches are reviewed against one plan.");
    return;
  }
  let fixing = false;
  for (;;) {
    const markdown = await readOptional(planPath);
    if (markdown === undefined) {
      void vscode.window.showWarningMessage(`Agent Sparring: the plan document ${path.basename(planPath)} could not be read.`);
      return;
    }
    const rows = await collectStageMatches(controller, run, markdown, planPath);
    if (rows.length === 0) {
      void vscode.window.showInformationMessage(`Agent Sparring: this project has no stage directories to match against ${path.basename(planPath)}.`);
      return;
    }
    const problems = rows.filter((row) => row.problem).length;
    if (fixing && problems === 0) {
      // The list came up because something needed placing; nothing does any
      // more, so the list closes instead of reopening as if it still did.
      void vscode.window.showInformationMessage(`Agent Sparring: every stage is now matched to a section of ${path.basename(planPath)}. Nothing else needs placing.`);
      await overview.update();
      return;
    }
    const items: StageMatchItem[] = rows.map((row) => ({
      label: `${row.problem ? "$(warning)" : "$(check)"} ${row.name}`,
      description: `→ ${row.label ? `Stage ${row.label}` : "unmatched"}`,
      detail: row.problem ?? `${row.matchedBy === "manual" ? "matched by you" : "matched automatically"} · ${row.stageId}`,
      row,
    }));
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: "$(check-all) Done", description: problems === 0 ? "nothing here needs a decision" : "leave the rest as it is", done: true });
    const picked = await vscode.window.showQuickPick(items, {
      title: `Stage matches in ${path.basename(planPath)}`,
      // When everything is placed, every row is a change, not a task: say so,
      // or a list of ticks reads as a list of things still to do.
      placeHolder: problems === 0 ? "All stages are matched. Select one only if you want to change it." : `${problems} stage(s) could not be placed in the plan; pick one to say which section it is.`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || picked.done || !picked.row) {
      return;
    }
    fixing = problems > 0;
    await matchStageCommand(controller, overview, { runId: picked.row.runId, stage: picked.row.stage, planPath });
  }
}

type StageMatchItem = vscode.QuickPickItem & { row?: StageMatchRow & { stage: StageSnapshot }; done?: boolean };

/** Read what each existing stage needs to be placed, then let the core do the placing. */
async function collectStageMatches(controller: SparringController, run: RunSnapshot, markdown: string, planPath: string): Promise<(StageMatchRow & { stage: StageSnapshot })[]> {
  const stages: (StageToMatch & { stage: StageSnapshot })[] = [];
  for (const candidate of stagesOfProject(controller, run.location.projectDir)) {
    if (!candidate.runId) {
      continue; // part of a managed run: the engine records which stage is which
    }
    const association = controller.planAssociation(candidate.runId);
    stages.push({
      runId: candidate.runId,
      stage: candidate.stage,
      stageId: candidate.stage.stageId,
      name: stageDisplayName(candidate.stage),
      title: candidate.stage.title,
      briefText: await readOptional(path.join(candidate.stage.dir, BRIEF_FILENAME)),
      // Another plan's manual match says nothing about this one.
      manual: association?.path === planPath ? association.match : undefined,
    });
  }
  const placed = stageMatchRows(parsePlanHeadings(markdown), stages);
  return placed.map((row) => ({ ...row, stage: stages.find((entry) => entry.runId === row.runId)!.stage }));
}

// ---------------------------------------------------------------- launching

/**
 * Which repository a launch targets.
 *
 * The candidates are every project Agent Sparring has state in *plus* every
 * repository and worktree the Git extension has open
 * (`controller.launchRepositories`), because the moment a repository most
 * needs to be offered is before it has any Agent Sparring state — starting the
 * first plan is exactly when that matters, and the engine creates what it
 * needs under `--sparring-dir` on its first write.
 *
 * Roots nest, so the deepest one containing the active file wins
 * (launchRepositories.ts). A file in `sporely/sporely-py/` belongs to
 * `sporely-py`, never to the container folder above it that happens to hold a
 * `.sparring` directory of its own.
 *
 * And a candidate is only offered when the engine could actually run there:
 * `.sparring` in a directory that is not inside a git repository is history,
 * not a place to start work (see `launchable` in launchRepositories.ts). Such
 * a location stays discovered and inspectable; it is named here as excluded,
 * with the reason, rather than silently dropped — a repository going missing
 * from this list without explanation is the failure that produced the list in
 * the first place.
 */
async function pickLocation(controller: SparringController): Promise<SparringLocation | undefined> {
  const candidates = await controller.launchRepositories();
  const targets = launchTargets(candidates);
  if (targets.length === 0) {
    const excluded = candidates.filter((candidate) => !candidate.launchable);
    void vscode.window.showErrorMessage(
      excluded.length > 0
        ? `Agent Sparring: no repository to run a plan in. ${excluded[0].blocked} Open the repository you mean, or set [repo] root in its .sparring/project.toml.`
        : "Agent Sparring: no repository to run a plan in — no Git repository is open, and no workspace folder has a `.sparring` directory.",
    );
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document;
  const activeFile = active?.uri.scheme === "file" ? active.uri.fsPath : undefined;
  const chosen = chooseLaunchRepository(candidates, controller.currentSelection.selected, activeFile);
  if (chosen) {
    return chosen.location;
  }
  for (const candidate of candidates.filter((entry) => !entry.launchable)) {
    controller.log(`Run plan…: ${candidate.location.folderName} is not offered. ${candidate.blocked}`);
  }
  const picked = await vscode.window.showQuickPick(
    targets.map((candidate) => ({
      label: candidate.location.folderName,
      description: candidate.location.repoRoot,
      // Said rather than implied: an offered repository with no history must
      // not look like one Agent Sparring has already run in.
      detail: candidate.established ? undefined : "No Agent Sparring state yet — this would be its first plan run here.",
      candidate,
    })),
    { placeHolder: "Which repository?" },
  );
  return picked?.candidate.location;
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

/**
 * The branch to pass as `--expected-branch`.
 *
 * A managed run recorded one when it started, and the engine refuses to
 * resume on any other, so there is nothing here for a person to decide: if
 * the repository is on that branch it is used silently. If it is not, the
 * mismatch is the only useful thing to say, and it is said — asking for a
 * value the engine will reject is not a choice, it is the same failure one
 * step later. Only a plan with no recorded branch is a real question.
 *
 * Returns undefined when the caller should stop: either the person
 * cancelled, or the mismatch has already been explained to them.
 */
async function resolveExpectedBranch(location: SparringLocation, recorded?: string): Promise<string | undefined> {
  const decision = decideExpectedBranch(recorded, await currentBranch(location.repoRoot));
  if (decision.kind === "use") {
    return decision.branch;
  }
  if (decision.kind === "ask") {
    return askBranch(decision.suggestion);
  }
  await explainWrongBranch(decision, "this plan run was started for");
  return undefined;
}

async function askBranch(suggestion?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "Agent Sparring: expected branch",
    prompt: "The feature branch every stage of this plan must modify (passed as --expected-branch).",
    value: suggestion ?? "",
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? undefined : "A branch name is required."),
  });
  return value?.trim() || undefined;
}

// ---------------------------------------------------------------- executable configuration

async function explainLaunch(controller: SparringController, result: LaunchResult): Promise<void> {
  if (result.ok) {
    return;
  }
  if (result.problem !== "unconfirmed") {
    await explainExecutableProblem(result.error);
    return;
  }
  await explainUnconfirmed(controller, result.error, result.submission);
}

/**
 * A command whose fate nobody can establish.
 *
 * The only way out, other than evidence, is a person stating that the command
 * cannot still run — and that is an override, not a cancellation: nothing here
 * can stop a line already sitting in a shell's input. So it is asked for
 * modally, in those words, and what it permits is a retry.
 */
async function explainUnconfirmed(controller: SparringController, error: string, submission: OperationView | undefined): Promise<void> {
  const choices = submission ? ["Show Log", "I checked — allow retry"] : ["Show Log"];
  const choice = await vscode.window.showWarningMessage(`Agent Sparring: ${error}`, ...choices);
  if (choice === "Show Log") {
    await vscode.commands.executeCommand("agentSparring.showLog");
    return;
  }
  if (choice !== "I checked — allow retry" || !submission) {
    return;
  }
  // A command a shell holds and a process started before a reload are two
  // different things to be asked about, and are asked about as themselves.
  const direct = submission.state === "running-direct" || submission.state === "running-dedicated";
  const detail = (
    direct
      ? [
          "Agent Sparring started this operation as a process of its own, in a window that has since reloaded, and cannot see that process in the process table from here.",
          "",
          `Started: ${submission.label}`,
          `As process: ${submission.directPid ?? "unknown"}`,
          "",
          "Only confirm this if that process is really over. If it is still running, running the operation again would do it twice.",
        ]
      : [
          "Agent Sparring cannot cancel a command a shell has already been given, and it has no evidence about this one either way.",
          "",
          `Submitted: ${submission.label}`,
          `To: ${submission.terminalName ?? "a terminal of this window"}`,
          "",
          "Only confirm this if you have looked at that terminal and that command cannot start any more. If it can, running the operation again may run it twice.",
        ]
  ).join("\n");
  const confirmed = await vscode.window.showWarningMessage("Allow this operation to be run again?", { modal: true, detail }, "Allow retry");
  if (confirmed !== "Allow retry") {
    return;
  }
  // The exact record the dialog was about, by its immutable id. If that
  // record has been resolved while the dialog was open — the shell reported
  // it, its terminal closed, the process table settled it — and a *new*
  // operation has since taken the same key, confirming this dialog must not
  // touch that new one.
  const result = controller.overrideSubmission(
    submission.id,
    direct
      ? "the person confirmed that the process started before the reload is over; this is an override, not an observation"
      : "the person confirmed, having checked the terminal, that this command cannot still run; this is an override, not an observation",
  );
  if (result.overridden) {
    void vscode.window.showInformationMessage(`Agent Sparring: ${submission.label} may be run again. Its earlier submission was cleared by you, not by evidence. Your drafts are preserved. Nothing has been resubmitted; use the original action in Overview to retry.`);
    return;
  }
  void vscode.window.showInformationMessage(
    `Agent Sparring: that submission of ${submission.label} has already been resolved or replaced since you were asked about it, so nothing was overridden. Try the operation again; if something is still in flight you will be told about that one.`,
  );
}

/**
 * A failed short command is reported as what it was: a configuration problem
 * gets the settings dialog, a command whose fate is unknown gets the same
 * treatment as an unconfirmed launch.
 */
async function explainCommandProblem(controller: SparringController, problem: { error: string; problem: LaunchProblem; submission?: OperationView }): Promise<void> {
  if (problem.problem !== "unconfirmed") {
    await explainExecutableProblem(problem.error);
    return;
  }
  await explainUnconfirmed(controller, problem.error, problem.submission);
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

/**
 * A runner is alive somewhere else. Saying so is not enough: the run it
 * belongs to is what the user wants to see, so offer to go there. `runId`
 * is the run that is busy; the Overview switches to it and opens.
 */
async function sayRunnerAlive(controller: SparringController, overview: OverviewPanelManager, message: string, runId: string): Promise<void> {
  const run = controller.currentDiscovery.runs.find((candidate) => candidate.id === runId);
  const choice = await vscode.window.showInformationMessage(`Agent Sparring: ${message}`, ...(run ? ["Show running plan"] : []));
  if (choice === "Show running plan" && run) {
    await showRun(controller, overview, run);
  }
}

/** Follow `run` in the Overview: it becomes the explicit selection and the panel opens. */
async function showRun(controller: SparringController, overview: OverviewPanelManager, run: RunSnapshot): Promise<void> {
  await controller.chooseRun(run);
  await overview.show();
  await overview.update();
}

async function explainCommandNotFound(word: string): Promise<void> {
  await explainExecutableProblem(commandNotFoundMessage(word));
}

/**
 * The engine ran and failed. Its own last words are shown — not a guess at
 * the cause, and never a configuration message: the executable was found,
 * so nothing about the configuration is in question. The full output is in
 * the Output Channel.
 */
async function explainEngineFailure(controller: SparringController, failure: EngineFailure): Promise<void> {
  const tail = outputTail(failure.output);
  const choice = await vscode.window.showErrorMessage(`Agent Sparring: sparring ${failure.kind} exited with code ${failure.exitCode}.${tail ? ` ${tail}` : ""}`, "Show log");
  if (choice === "Show log") {
    controller.showLog();
  }
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

/** Returns the launch result, for callers that must not discard a draft the engine never received. */
async function launch(controller: SparringController, location: SparringLocation, args: string[], kind: SparringSubcommand, planPath: string, manifest?: string): Promise<LaunchResult> {
  // The command runs inside the user's normal integrated terminal through
  // shell integration, so the user sees the engine's own output and the
  // terminal follows VS Code's normal persistence; the run id is the one the
  // engine will write state under. Every engine action in this file takes
  // this same route (controller.launch / controller.runCommand): nothing
  // here builds a command line or starts a process of its own.
  const result = await controller.launch({ configured: configuredExecutable(), args, cwd: location.repoRoot, name: kind, runId: planRunId(location, planPath), kind, planPath, manifest, reveal: true });
  await explainLaunch(controller, result);
  return result;
}

/**
 * Run a plan: pick the project and the plan document, then start it the way
 * the configured continuation mode says a plan is run.
 *
 * There is deliberately no second answer to "how is a plan started". In
 * **automatic** mode (the default) this is the same managed, manifest-driven
 * run that Continue automatically starts — same manifest, same preflight,
 * same confirmation — because a plan started from a differently-labelled
 * button used to become a *Markdown* managed run, which then could not be
 * continued by the automatic path at all (the engine refuses to resume a run
 * from another kind of input, rightly). In **manual** mode the plan's own
 * path is handed to `run-plan`, which is what that mode is for.
 */
async function runPlanCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  const location = await pickLocation(controller);
  if (!location) {
    return;
  }
  const planPath = await pickPlanDocument(location);
  if (!planPath) {
    return;
  }
  const runId = planRunId(location, planPath);
  if (controller.livenessFor(runId).state === "running") {
    await sayRunnerAlive(controller, overview, "a runner for this plan is alive in a terminal of this window.", runId);
    return;
  }
  const existing = controller.currentDiscovery.runs.find((candidate) => candidate.id === runId);
  if (existing?.kind === "plan") {
    // The engine refuses a fresh run of a plan it already has a run for, and
    // that run's input kind is its own. Continue it instead of starting a
    // second one on different terms.
    await resumePlanCommand(controller, existing);
    return;
  }
  const expectedBranch = await resolveExpectedBranch(location);
  if (!expectedBranch) {
    return;
  }
  if (planContinuationMode() === "automatic") {
    const markdown = await readOptional(planPath);
    if (markdown === undefined) {
      void vscode.window.showWarningMessage(`Agent Sparring: the plan document ${path.basename(planPath)} could not be read.`);
      return;
    }
    const label = planLabel(planPath, location.repoRoot);
    await startManagedRun(controller, overview, { location, planPath, markdown, label, runId, expectedBranch, confirm: true });
    return;
  }
  const args = buildRunPlanArgs({ planPath, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir });
  await launch(controller, location, args, "run-plan", planPath);
}

/**
 * The user's plan-progression mode, read the same way the Overview reads it
 * (`agentSparring.planContinuation`), so what the panel offers and what a
 * command does cannot disagree.
 */
function planContinuationMode(): PlanContinuation {
  return vscode.workspace.getConfiguration("agentSparring").get<string>("planContinuation", "automatic") === "manual" ? "manual" : "automatic";
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
  const expectedBranch = await resolveExpectedBranch(run.location, run.state.expectedBranch);
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
  let problem: { error: string; problem: LaunchProblem; submission?: OperationView } | undefined;
  // The brief travels through a temporary file outside the workspace; the
  // engine reads it and writes brief.md. The file is removed afterwards.
  const result: NewStageResult = await withTemporaryFile(rendered.brief, `${proposal.stageId}.md`, (briefFile) =>
    createStage(
      async (args) => {
        const outcome = await controller.runCommand({ configured: configuredExecutable(), args, cwd: location.repoRoot, name: `New stage: ${proposal.stageId}` });
        if (!outcome.ok) {
          problem = { error: outcome.error, problem: outcome.problem, submission: outcome.submission };
          return { exitCode: undefined, output: outcome.error };
        }
        return outcome.outcome;
      },
      { stageId: proposal.stageId, repoRoot: location.repoRoot, sparringDir: location.sparringDir, briefFile },
    ),
  );
  if (problem) {
    await explainCommandProblem(controller, problem);
    return { ok: false, reason: "executable", message: problem.error };
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
/**
 * Write the manifest and the binding record that says which worktree it was
 * written for, and return the manifest's path.
 *
 * Provenance first: the manifest keeps the `source_digest` of the one already
 * there when the new one executes the same thing (manifest.ts:
 * `carriedForward`). The engine's run identity includes `source_digest`, so
 * rebuilding it from an edited plan document — even one where only a handoff
 * record changed — would otherwise end the recorded run. When this run has no
 * file at its current name, the names manifests were written under before
 * (`previousManifestFileNames`) are read for that provenance and nothing else;
 * they are never authority and never written again.
 *
 * Then the binding record. The manifest itself cannot say which worktree it
 * belongs to — the engine refuses a manifest carrying a field it does not
 * know, and nothing in the payload it *does* know identifies the primary
 * repository — so the statement goes in a sidecar next to it, naming the
 * resolved project directory, the manifest file and its executable digest.
 * Without it a reader has no way to tell two worktrees of one repository
 * apart, and degrades to no membership; so the two files are written together,
 * the manifest first.
 */
async function writeManifestFile(controller: SparringController, owner: ManifestOwner, manifest: ExecutionManifest): Promise<string> {
  const directory = controller.manifestDirectoryPath;
  const file = manifestPathFor(directory, owner);
  let previous = await readOptional(file);
  for (const name of previousManifestFileNames(owner.planKey, owner.location.projectDir)) {
    if (previous !== undefined) {
      break;
    }
    previous = await readOptional(path.join(directory, name));
    if (previous !== undefined) {
      controller.log(`carrying the execution manifest provenance of ${name} forward into ${path.basename(file)}, which is scoped to this worktree.`);
    }
  }
  const written = carriedForward(manifest, previous);
  await fs.writeFile(file, renderManifest(written), "utf8");

  const digest = manifestDigest(written);
  if (digest === undefined) {
    controller.log(`the execution manifest ${path.basename(file)} could not be read back under the engine's own rules, so no binding record was written; this run's historical stages will not be attributed to it.`);
    return file;
  }
  const record: ManifestBindingRecord = {
    version: BINDING_VERSION,
    manifestFile: path.basename(file),
    manifestDigest: digest,
    planKey: owner.planKey,
    planLabel: written.plan_label,
    projectDir: path.resolve(owner.location.projectDir),
  };
  const bindingFile = bindingPathFor(directory, owner);
  await fs.writeFile(bindingFile, renderBindingRecord(record), "utf8");
  return file;
}

/**
 * The managed plan run that already owns this stage, when one does.
 *
 * Recorded membership only (planMembership.ts): the run's validated execution
 * manifest, or its own recorded stage list. A plan run merely being open in
 * the same project is not ownership and must not block anything, so nothing
 * here falls back to that.
 */
async function ownedByPlanRun(
  controller: SparringController,
  run: RunSnapshot,
): Promise<{ runId: string; planName: string; status: string; stage: string } | undefined> {
  if (run.kind !== "stage") {
    return undefined;
  }
  const membership = (await controller.planMemberships()).get(run.id);
  if (!membership) {
    return undefined;
  }
  return {
    runId: membership.planRunId,
    planName: membership.planName,
    status: membership.planStatus,
    stage: membership.stageLabel ? `${membership.stageLabel} (${run.stage.stageId})` : `This stage (${run.stage.stageId})`,
  };
}

/**
 * The declarations a plan's manifest carries for one **worktree**: its stages'
 * sibling repositories and their modes.
 *
 * One place, because every caller has to agree. Starting a run and resuming it
 * must produce byte-identical manifests from an unchanged plan — the engine
 * refuses a run whose digest moved — so `performContinueAutomatically` and
 * `planInvocationFor` may not know different things; and anything that reports
 * what *would* be built must read the same state, or it would be reporting on
 * a manifest nothing executes.
 *
 * `projectDir` is not a detail: a plan key is shared by every worktree running
 * the same plan path, so without it these answer for the wrong checkout
 * (declarationScope.ts).
 */
function declarationsFor(controller: SparringController, key: string, location: SparringLocation): { repositories: Record<string, ManifestRepository[]>; modes: Record<string, StageMode> } {
  return {
    repositories: manifestRepositories(controller.stageRepositories(key, location.projectDir), location.repoRoot),
    modes: controller.stageModes(key, location.projectDir),
  };
}

/**
 * The plan input a resume of `run` must use — the **one** place that decides
 * it, for every path that ultimately calls `resume-plan`.
 *
 * The rule is short and has no exceptions: a run is resumed from the kind of
 * input it was started from. `source=markdown` resumes with the plan's own
 * path; `source=manifest` resumes with a freshly rebuilt manifest. Nothing
 * in the UI may change an existing run's input kind, because the engine
 * refuses such a resume — correctly, since the two describe different
 * execution content for the same plan — and a run that no button can
 * continue is the failure this exists to prevent. The recorded source is
 * carried in the result so the command builder can check it too, rather than
 * trusting each caller to have asked here.
 *
 * Undefined means nothing can be launched, and the reason has already been
 * shown to the person.
 */
type PlanResumeInput = ({ planPath: string } | { manifest: string }) & { source: PlanRunSource };

async function planInvocationFor(controller: SparringController, run: PlanRunSnapshot): Promise<PlanResumeInput | undefined> {
  if (run.state.source !== "manifest") {
    return { planPath: run.planPath, source: "markdown" };
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
    known: await knownStageIds(controller, run.location.projectDir, markdown),
    ...declarationsFor(controller, run.planKey, run.location),
  });
  if (!built.ok) {
    void vscode.window.showWarningMessage(`Agent Sparring: the execution manifest for ${path.basename(run.planPath)} could not be rebuilt: ${built.problems[0]?.reason ?? "the plan changed."}`);
    return undefined;
  }
  try {
    await controller.manifestDirectory();
    return { manifest: await writeManifestFile(controller, run, built.manifest), source: "manifest" };
  } catch (error) {
    void vscode.window.showErrorMessage(`Agent Sparring: could not write the execution manifest: ${(error as Error).message}. Nothing was started.`);
    return undefined;
  }
}

// ---------------------------------------------------------------- continue automatically (engine-managed plan)

export type ContinueAutomaticallyOutcome =
  | {
      ok: true;
      runId: string;
      /** Absent when the run is continued from its own Markdown plan; see `input`. */
      manifest?: string;
      kind: "run-plan" | "resume-plan";
      /**
       * Which plan input was actually handed to the engine. For a resume it
       * is always the run's recorded `source`, never a choice — see
       * `planInvocationFor`.
       */
      input: PlanRunSource;
      adopt: boolean;
      stages: number;
      /** The run was started with run-scoped push authorization. */
      autoPush?: boolean;
    }
  | { ok: false; reason: "no-plan" | "unreadable" | "manifest" | "preflight" | "branch" | "complete" | "running" | "cancelled" | "write" | "owned"; message?: string };

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
  // Ownership is enforced here, in the command, and not only by withholding
  // the button in the Overview. This path is reachable from the Command
  // Palette and from a keybinding, and what it would do to a stage a managed
  // run already executed is create or adopt a *second* plan run over work that
  // run owns — the duplicate-run failure that started this. The refusal is the
  // same whichever route arrives.
  const owner = await ownedByPlanRun(controller, run);
  if (owner) {
    void vscode.window.showInformationMessage(
      `Agent Sparring: ${owner.stage} is a stage of the managed plan run ${owner.planName} (${owner.status}). Continue that run instead of starting a second one over the same work.`,
      "Back to plan run",
    ).then(async (choice) => {
      if (choice === "Back to plan run") {
        await controller.chooseRun(controller.currentDiscovery.runs.find((candidate) => candidate.id === owner.runId));
        await overview.update();
      }
    });
    controller.log(`Continue automatically: refused — ${owner.stage} is already owned by the managed plan run ${owner.planName} (${owner.status}).`);
    return { ok: false, reason: "owned", message: `${owner.stage} belongs to ${owner.planName}` };
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
  const runId = runIdFor(location, "plan", planKey(label));
  const existing = controller.currentDiscovery.runs.find((candidate) => candidate.id === runId);
  const managed = existing?.kind === "plan" ? existing : undefined;
  if (managed?.state.status === "complete") {
    void vscode.window.showInformationMessage(`Agent Sparring: the managed run of ${label} is complete; every stage was accepted.`);
    return { ok: false, reason: "complete" };
  }
  if (controller.livenessFor(runId).state === "running") {
    await sayRunnerAlive(controller, overview, `a runner for ${label} is already alive in a terminal of this window.`, runId);
    return { ok: false, reason: "running" };
  }

  // A managed run's branch is already recorded and already enforced by the
  // engine, so it is resolved, not asked for; a fresh run takes the branch
  // the repository is actually on. Either way no picker appears.
  if (managed) {
    const expectedBranch = await resolveExpectedBranch(location, managed.state.expectedBranch);
    if (!expectedBranch) {
      return { ok: false, reason: "branch" }; // resolveExpectedBranch already named the mismatch
    }
    // An existing run is *continued*, on its own terms: the input kind comes
    // from what the engine recorded, never from which button was pressed.
    return continueManagedRun(controller, overview, { run: managed, markdown, expectedBranch, stage: currentStageOf(run), confirm: options.confirm });
  }
  const expectedBranch = await currentBranch(location.repoRoot);
  if (!expectedBranch) {
    void vscode.window.showErrorMessage(
      `Agent Sparring: no Git branch is checked out in ${location.folderName} (detached HEAD or not a repository). Check out the plan's branch, then start again.`,
    );
    return { ok: false, reason: "branch" };
  }
  return startManagedRun(controller, overview, { location, planPath, markdown, label, runId, expectedBranch, stage: currentStageOf(run), confirm: options.confirm });
}

/** What a fresh managed run needs to know before it is started. */
interface ManagedStart {
  location: SparringLocation;
  planPath: string;
  markdown: string;
  /** The plan label the run will be keyed by (plan.py: plan_label). */
  label: string;
  runId: string;
  expectedBranch: string;
  /**
   * The stage the person is looking at, when there is one. Only the
   * preflight uses it, for the one check that is about a stage's own history
   * rather than about the plan.
   */
  stage?: StageSnapshot;
  confirm: boolean;
}

/**
 * Start a fresh engine-managed run of this plan, from an execution manifest.
 *
 * The extension does the interpreting once — which headings are canonical
 * stages, how `3A`/`3B`/`3C` order, which sections are historical handoffs,
 * which stage ids the project already uses, what each brief says — writes
 * that out as a manifest (manifest.ts) and hands it to `run-plan
 * --manifest`. From then on the engine sequences: it accepts a READY
 * candidate through its existing hard gate and starts the next stage, with
 * no Accept stage / Start next stage / Run stage click in between. It stops
 * at NEEDS_YOU, ESCALATE, a failure, or the end of the plan. The extension
 * implements no sequencing of its own.
 *
 * One confirmation, before the first stage, and it carries the one
 * run-scoped choice that has to be made up front if it is to apply from the
 * first candidate: whether this run may push the candidates it verifies.
 */
async function startManagedRun(controller: SparringController, overview: OverviewPanelManager, start: ManagedStart): Promise<ContinueAutomaticallyOutcome> {
  const { location, planPath, markdown, label, runId, expectedBranch } = start;
  const built = buildManifest({
    markdown,
    planLabel: label,
    planName: path.basename(planPath),
    known: await knownStageIds(controller, location.projectDir, markdown),
    ...declarationsFor(controller, planKey(label), location),
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

  // Only a fresh run needs --adopt, and only when the plan's stages already
  // exist on disk from stage-by-stage work. The engine still checks each one
  // and reports what it inherits; nothing is taken over silently.
  const onDisk = await existingStages(controller, location, built.manifest);
  const adopt = onDisk.size > 0;

  if (await refusedByPreflight(controller, overview, start.stage, { manifest: built.manifest, location, adopt, onDisk, expectedBranch })) {
    return { ok: false, reason: "preflight", message: "preflight" };
  }

  let autoPush = false;
  if (start.confirm) {
    const detail = describePlan(built.manifest, controller, location, { kind: "run-plan", adopt, expectedBranch, skipped: built.skipped.length });
    const choice = await vscode.window.showInformationMessage(
      "Run this plan automatically until Agent Sparring needs you?",
      { modal: true, detail },
      "Run automatically",
      AUTO_PUSH_START_LABEL,
    );
    if (choice !== "Run automatically" && choice !== AUTO_PUSH_START_LABEL) {
      return { ok: false, reason: "cancelled" };
    }
    autoPush = choice === AUTO_PUSH_START_LABEL;
  }

  let manifestPath: string;
  try {
    await controller.manifestDirectory();
    manifestPath = await writeManifestFile(controller, { planKey: planKey(label), location }, built.manifest);
  } catch (error) {
    void vscode.window.showErrorMessage(`Agent Sparring: could not write the execution manifest: ${(error as Error).message}. Nothing was started.`);
    return { ok: false, reason: "write", message: (error as Error).message };
  }

  for (const problem of built.skipped) {
    controller.log(`Continue automatically: not executable, left in the plan — ${problem.reason}`);
  }
  controller.log(
    `Continue automatically: run-plan${adopt ? " --adopt" : ""}${autoPush ? " --allow-push-for-run" : ""} --manifest ${manifestPath} (${built.manifest.stages.length} stage(s): ${built.manifest.stages.map((stage) => stage.stage_id).join(", ")})`,
  );

  const args = buildRunPlanArgs({ manifest: manifestPath, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir, adopt, allowPushForRun: autoPush });
  const result = await controller.launch({
    configured: configuredExecutable(),
    args,
    cwd: location.repoRoot,
    name: `run-plan: ${path.basename(planPath)}`,
    runId,
    kind: "run-plan",
    planPath,
    manifest: manifestPath,
    reveal: true,
  });
  await explainLaunch(controller, result);
  await overview.update();
  if (!result.ok) {
    return { ok: false, reason: "write", message: result.error };
  }
  return { ok: true, runId, manifest: manifestPath, kind: "run-plan", input: "manifest", adopt, stages: built.manifest.stages.length, autoPush };
}

/** The second choice on the start confirmation; the same permission `--allow-push-for-run` records. */
const AUTO_PUSH_START_LABEL = "Run automatically, and push accepted candidates";

/**
 * Continue the engine's existing managed run of this plan.
 *
 * The input kind is the run's own, decided in exactly one place
 * (`planInvocationFor`) and checked again by the command builder: a run
 * started from a Markdown plan is continued from that plan, and a run
 * started from a manifest is continued from a freshly rebuilt manifest.
 * Pressing a differently-labelled button never changes it — the engine
 * refuses such a resume, and a run no button can continue was the failure
 * that made this one function the only decision point.
 */
async function continueManagedRun(
  controller: SparringController,
  overview: OverviewPanelManager,
  context: { run: PlanRunSnapshot; markdown: string; expectedBranch: string; stage?: StageSnapshot; confirm: boolean },
): Promise<ContinueAutomaticallyOutcome> {
  const { run, expectedBranch } = context;
  const location = run.location;
  const input = await planInvocationFor(controller, run);
  if (!input) {
    return { ok: false, reason: "manifest" }; // planInvocationFor said why
  }
  const manifest = "manifest" in input ? input.manifest : undefined;

  if (await refusedByPreflight(controller, overview, context.stage, { location, adopt: false, onDisk: new Set<string>(), expectedBranch })) {
    return { ok: false, reason: "preflight", message: "preflight" };
  }

  if (context.confirm) {
    const stages = declaredStages(context.markdown);
    const choice = await vscode.window.showInformationMessage(
      "Run this plan automatically until Agent Sparring needs you?",
      {
        modal: true,
        detail: [
          `Agent Sparring continues the engine's managed run of ${run.state.plan}.`,
          "",
          `Branch: ${expectedBranch}`,
          `Continuing at: ${run.currentStage.stageId}${stages ? ` (${stages} stage(s) in the plan)` : ""}`,
          "",
          "Each stage runs implementation ↔ review and, on READY, is frozen and accepted at its exact pushed commit — with no further confirmation. The run stops when the reviewer needs you, escalates, something fails, or the plan is complete.",
        ].join("\n"),
      },
      "Run automatically",
    );
    if (choice !== "Run automatically") {
      return { ok: false, reason: "cancelled" };
    }
  }

  controller.log(`Continue automatically: resume-plan ${manifest ? `--manifest ${manifest}` : run.planPath} (the run is recorded as a ${input.source} plan input)`);
  const args = buildResumePlanArgs({ ...input, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir });
  const result = await launch(controller, location, args, "resume-plan", run.planPath, manifest);
  await overview.update();
  if (!result.ok) {
    return { ok: false, reason: "write", message: result.error };
  }
  return { ok: true, runId: run.id, manifest, kind: "resume-plan", input: input.source, adopt: false, stages: declaredStages(context.markdown) ?? 0 };
}

/** How many `## Stage <n> — <title>` sections a plan declares, when it parses at all. */
function declaredStages(markdown: string): number | undefined {
  try {
    return parsePlanStages(markdown).length || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the preflight and, when it found something, say all of it at once.
 *
 * True means nothing was launched. Shared by starting and continuing so a
 * dirty worktree or a wrong branch is reported the same way whichever it
 * was, and so a healthy plan still gets exactly one dialog: the
 * confirmation.
 */
async function refusedByPreflight(
  controller: SparringController,
  overview: OverviewPanelManager,
  stage: StageSnapshot | undefined,
  context: PreflightContext,
): Promise<boolean> {
  const blockers = await preflight(stage, context);
  if (blockers.length === 0) {
    return false;
  }
  controller.log(`Continue automatically: refused — ${blockers.map((problem) => problem.title).join("; ")}`);
  const detail = blockers.map((problem) => `• ${problem.title}\n   ${problem.fix}`).join("\n\n");
  const fixes = [...new Set(blockers.map((problem) => problem.action).filter((action): action is PreflightAction => action !== undefined))];
  const choice = await vscode.window.showWarningMessage(
    blockers.length === 1 ? "Agent Sparring: one thing needs fixing before this plan can run automatically." : `Agent Sparring: ${blockers.length} things need fixing before this plan can run automatically.`,
    { modal: true, detail },
    ...fixes.map((action) => PREFLIGHT_ACTIONS[action]),
  );
  const chosen = fixes.find((action) => PREFLIGHT_ACTIONS[action] === choice);
  if (chosen === "review-matches") {
    await reviewStageMatchesCommand(controller, overview);
  } else if (chosen === "declare-siblings") {
    await stageRepositoriesCommand(controller);
  }
  return true;
}

/**
 * Which stage ids this project already uses for which plan labels — and, for
 * the ones that have really run, the brief they ran against.
 *
 * The ids keep an existing sequence's history instead of re-creating it
 * under new ones. Each stage of the same project is located in the plan the
 * same way the Overview locates it — the user's manual match first, then the
 * brief's own `Stage 3B` markers, then the id — and only an unambiguous
 * match counts.
 *
 * The brief is carried only for a stage with real execution history: it is
 * accepted, or it holds a session or a candidate commit. For such a stage
 * `brief.md` *is* the contract the work was implemented and reviewed
 * against, and the plan's section for it has usually moved on since (plans
 * get rewritten afterwards to record what was built). Re-extracting the
 * section would make the manifest describe work nobody did, and the engine
 * would refuse to adopt the stage rather than run it against a brief it
 * never saw. A stage that exists but has not run yet is left to the plan:
 * there is no history to protect, and the current section is the better
 * text.
 */
async function knownStageIds(controller: SparringController, projectDir: string, markdown: string): Promise<KnownStage[]> {
  const headings = parsePlanHeadings(markdown);
  const known: KnownStage[] = [];
  for (const candidate of stagesOfProject(controller, projectDir)) {
    const briefText = await readOptional(path.join(candidate.stage.dir, BRIEF_FILENAME));
    const position = locateStage(headings, {
      stageId: candidate.stage.stageId,
      title: candidate.stage.title,
      briefText,
      manual: candidate.runId ? controller.planAssociation(candidate.runId)?.match : undefined,
    });
    const label = position?.stage?.label;
    if (!label || known.some((entry) => entry.label === label)) {
      continue;
    }
    const executed = hasExecutionHistory(candidate.stage);
    known.push({ label, stageId: candidate.stage.stageId, ...(executed && briefText !== undefined ? { brief: briefText } : {}) });
  }
  return known;
}

/**
 * Every stage of this project the extension can see, however it is
 * discovered: standalone stage runs, and the stages of a managed plan run —
 * including its current one, which discovery no longer lists standalone
 * because the plan run claims it. Missing that stage would silently rebuild
 * the manifest around a different id and brief on the next resume, and the
 * engine would then refuse the digest.
 */
function stagesOfProject(controller: SparringController, projectDir: string): { stage: StageSnapshot; runId?: string }[] {
  const out: { stage: StageSnapshot; runId?: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of controller.currentDiscovery.runs) {
    if (candidate.location.projectDir !== projectDir) {
      continue;
    }
    const stages = candidate.kind === "stage" ? [candidate.stage] : [...candidate.stages, candidate.currentStage];
    for (const stage of stages) {
      if (!stage.exists || seen.has(stage.stageId)) {
        continue;
      }
      seen.add(stage.stageId);
      out.push({ stage, runId: candidate.kind === "stage" ? candidate.id : undefined });
    }
  }
  return out;
}

/** Has this stage actually run? Acceptance, a recorded session or a candidate commit all say yes. */
function hasExecutionHistory(stage: StageSnapshot): boolean {
  const state = stage.state;
  return state !== undefined && (state.status === "accepted" || state.implementationSessionId !== null || state.sparringSessionId !== null || state.candidateSha !== null);
}

// ---------------------------------------------------------------- preflight

type PreflightAction = "review-matches" | "declare-siblings";

const PREFLIGHT_ACTIONS: Record<PreflightAction, string> = {
  "review-matches": "Review stage matches…",
  "declare-siblings": "Sibling repositories…",
};

interface PreflightProblem {
  title: string;
  /** What to do about it, in one sentence. */
  fix: string;
  action?: PreflightAction;
}

/**
 * `manifest` is absent when no manifest is involved — continuing a run the
 * engine recorded as a Markdown one. The checks that are *about* a manifest
 * (a stage that would be re-created, a declared sibling, an engine without
 * `--manifest`) then have nothing to check and say nothing, rather than
 * being answered from a manifest that will not be executed.
 */
interface PreflightContext {
  manifest?: ExecutionManifest;
  location: SparringLocation;
  adopt: boolean;
  onDisk: Set<string>;
  expectedBranch: string;
}

/**
 * Everything that would make this run fail or do damage, found before the
 * confirmation rather than in a terminal afterwards.
 *
 * The rule this follows: **say nothing when nothing is wrong.** A healthy
 * plan gets exactly one dialog, the confirmation. Checks that cannot be
 * answered from data this window actually has — a worktree the Git extension
 * has not opened, an engine only the user's shell can resolve — return
 * nothing at all rather than a maybe, because the engine's own refusals are
 * the authority and a hedged warning in front of a working run is worse than
 * silence.
 */
async function preflight(stage: StageSnapshot | undefined, context: PreflightContext): Promise<PreflightProblem[]> {
  const { manifest, location } = context;
  const problems: PreflightProblem[] = [];

  // 1. A stage that would be created inside a sequence that has already run
  //    past it: an existing stage nothing could recognise. Running it would
  //    re-implement accepted work under a new id.
  if (manifest && context.adopt) {
    for (const stage of adoptionGaps(manifest, context.onDisk)) {
      problems.push({
        title: `${stage.label} — ${stage.title} would be started again, as a new stage ${stage.stage_id}.`,
        fix: "Later stages already exist, so this one almost certainly ran under an id nothing could match. Say which stage it is and its history is kept.",
        action: "review-matches",
      });
    }
  }

  // 2. A declared sibling repository that is not where, or not as, it was
  //    declared. Acceptance pins each one, and the engine would refuse the
  //    whole stage at the freeze boundary — after the run had started.
  for (const stage of manifest?.stages ?? []) {
    for (const repository of stage.repositories ?? []) {
      const root = path.resolve(location.repoRoot, repository.path);
      if (!(await isDirectory(path.join(root, ".git")))) {
        problems.push({
          title: `${stage.label} also reviews ${repository.name}, but ${repository.path} is not a Git repository here.`,
          fix: "Check it out at that path, or re-declare where it actually is.",
          action: "declare-siblings",
        });
        continue;
      }
      const branch = await readGitBranch(root);
      if (branch && branch !== repository.branch) {
        problems.push({
          title: `${repository.name} is on ${branch}, but ${stage.label} declares ${repository.branch}.`,
          fix: "Check out the declared branch there, or re-declare the branch the candidate is on. Acceptance refuses a sibling on any other branch.",
          action: "declare-siblings",
        });
      }
    }
  }

  // 3. The stage's own candidate was built somewhere else. Same source the
  //    Overview's branch guard uses: the branch written into the last
  //    handoff, which is the only branch a standalone stage records. Skipped
  //    when the run was started without a stage on screen (Run plan from the
  //    Command Palette): there is no stage whose history could disagree.
  const handoffBranch = stage ? parseHandoffBranch((await readOptional(path.join(stage.dir, HANDOFF_FILENAME))) ?? "") : undefined;
  if (handoffBranch && handoffBranch !== context.expectedBranch) {
    problems.push({
      title: `${context.expectedBranch} is checked out, but this stage's last handoff was written on ${handoffBranch}.`,
      fix: `Check out ${handoffBranch} first; the run is started for the checked-out branch and the engine refuses every other one.`,
    });
  }

  // 4. Uncommitted work. It does not stop the run starting, but it stops the
  //    first acceptance, which is worse: the run would get that far and halt.
  const changes = pendingChanges(location.repoRoot);
  if (changes !== undefined && changes > 0) {
    problems.push({
      title: `${location.folderName} has ${changes} uncommitted change${changes === 1 ? "" : "s"}.`,
      fix: "Commit or stash them. The engine refuses to freeze a candidate from a dirty worktree, so the run would stop at the first stage it tried to accept.",
    });
  }

  // 5. An engine that predates the manifest input would fail on the flag,
  //    in a terminal, having done nothing.
  if (manifest && (await manifestSupport(configuredExecutable(), location.repoRoot)) === "missing-manifest") {
    problems.push({
      title: "The configured sparring engine has no `run-plan --manifest`.",
      fix: "Automatic continuation needs a newer engine. Update it, or keep using the per-stage actions.",
    });
  }

  return problems;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Which of the manifest's stages already exist on disk in this project. */
async function existingStages(controller: SparringController, location: SparringLocation, manifest: ExecutionManifest): Promise<Set<string>> {
  const known = new Set(stagesOfProject(controller, location.projectDir).map((entry) => entry.stage.stageId));
  const found = new Set<string>();
  for (const stage of manifest.stages) {
    if (known.has(stage.stage_id)) {
      found.add(stage.stage_id);
      continue;
    }
    try {
      await fs.access(path.join(location.sparringDir, "stages", stage.stage_id));
      found.add(stage.stage_id);
    } catch {
      // not present
    }
  }
  return found;
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
  const lines = manifest.stages.map((stage) => {
    const mark = accepted.has(stage.stage_id) ? "✓" : "•";
    const also = (stage.repositories ?? []).map((repository) => `\n      also reviews ${repository.name} on ${repository.branch}`).join("");
    return `  ${mark} ${stage.label} — ${stage.title}${accepted.has(stage.stage_id) ? " (already accepted)" : ""}${also}`;
  });
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
  // The one run-scoped choice that has to be made before the first stage if
  // it is to apply to the first candidate. Off unless it is chosen: the
  // ordinary button starts the run with no push authorization at all, and the
  // run then stops and asks the first time a verified candidate is not on the
  // remote. (A modal dialog cannot hold a checkbox, so the choice is the
  // second button rather than a tick-box — the default is still no.)
  parts.push(
    "",
    `"${AUTO_PUSH_START_LABEL}" additionally lets this run push the candidates it verifies to their remote branch, so it does not stop to ask for each one. It applies to this run only, and to nothing but an ordinary push of ${context.expectedBranch}.`,
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------- sibling repositories

/** The plan key a stage's declarations are filed under: a managed run's own, or the associated plan's. */
async function planKeyFor(controller: SparringController, run: RunSnapshot): Promise<string | undefined> {
  if (run.kind === "plan") {
    return run.planKey;
  }
  const planPath = controller.associatedPlan(run.id);
  return planPath ? planKey(planLabel(planPath, run.location.repoRoot)) : undefined;
}

/**
 * Declare which other repositories a plan stage's candidate spans.
 *
 * Some stages are genuinely two repositories, and the reviewer's READY
 * depends on both. The engine already refuses to accept such a stage on the
 * primary commit alone — it pins every declared sibling at the freeze
 * boundary and re-verifies each pin at acceptance, so a sibling that moved
 * after review refuses acceptance as stale — but nothing could *say* which
 * repositories those are. This is that.
 *
 * The declaration is a property of the stage as planned, so it is kept per
 * plan and stage label and emitted into the execution manifest; the engine
 * writes it into the stage's own `state.json` when the run reaches that
 * stage. Nothing here writes engine state, and nothing here asks for a
 * commit: which commit was reviewed is the freeze boundary's answer, and a
 * hand-typed SHA would be exactly the stale pin the verification exists to
 * catch.
 */
async function stageRepositoriesCommand(controller: SparringController): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    void vscode.window.showInformationMessage("Agent Sparring: select a run first.");
    return;
  }
  const planPath = planDocumentFor(controller, run);
  const key = await planKeyFor(controller, run);
  if (!planPath || !key) {
    void vscode.window.showInformationMessage("Agent Sparring: choose a plan for this stage first; sibling repositories are declared per plan stage.");
    return;
  }
  const markdown = await readOptional(planPath);
  if (markdown === undefined) {
    void vscode.window.showWarningMessage(`Agent Sparring: the plan document ${path.basename(planPath)} could not be read.`);
    return;
  }

  const entries = buildStageIndex(parsePlanHeadings(markdown)).filter((entry) => entry.label);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`Agent Sparring: ${path.basename(planPath)} defines no labelled stages.`);
    return;
  }
  const label = await pickStageLabel(controller, run.location, key, entries);
  if (!label) {
    return;
  }
  await editStageRepositories(controller, run.location, key, label);
}

/**
 * Declare what kind of stage a plan stage is: work, or a review of work.
 *
 * The engine will not infer this. A stage called "Independent final review
 * and activation decision" runs the implementation lifecycle — a stage agent
 * that writes code, with a sparrer behind it — unless something says
 * otherwise, because which agent runs is not a thing to read off a heading.
 * Saying otherwise is this command: the choice is recorded per plan and
 * stage label and emitted into the execution manifest, and the engine then
 * runs that stage as one fresh independent reviewer over the candidates the
 * earlier stages already accepted, with no implementation turn at all.
 *
 * Nothing here writes engine state, and nothing here changes a stage that
 * has already run: the engine refuses to continue a stage under a mode other
 * than the one it ran under, and its `reset-stage` command is the supported
 * way to restart one. This command is told so, and says so.
 */
async function stageModeCommand(controller: SparringController): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    void vscode.window.showInformationMessage("Agent Sparring: select a run first.");
    return;
  }
  const planPath = planDocumentFor(controller, run);
  const key = await planKeyFor(controller, run);
  if (!planPath || !key) {
    void vscode.window.showInformationMessage("Agent Sparring: choose a plan for this stage first; a stage's mode is declared per plan stage.");
    return;
  }
  const markdown = await readOptional(planPath);
  if (markdown === undefined) {
    void vscode.window.showWarningMessage(`Agent Sparring: the plan document ${path.basename(planPath)} could not be read.`);
    return;
  }
  const entries = buildStageIndex(parsePlanHeadings(markdown)).filter((entry) => entry.label);
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`Agent Sparring: ${path.basename(planPath)} defines no labelled stages.`);
    return;
  }

  const stage = await vscode.window.showQuickPick(
    entries.map((entry) => ({
      label: entry.display,
      description: controller.stageModeFor(key, run.location.projectDir, entry.label) === "independent_review" ? "review only" : "",
      value: entry.label,
    })),
    { title: "Stage mode", placeHolder: "Which stage is a review of work rather than work?" },
  );
  if (!stage) {
    return;
  }

  const current = controller.stageModeFor(key, run.location.projectDir, stage.value);
  const mode = await vscode.window.showQuickPick(
    STAGE_MODES.map((candidate) => ({
      label: `${candidate === current ? "$(check) " : "$(blank) "}${STAGE_MODE_LABELS[candidate].label}`,
      detail: STAGE_MODE_LABELS[candidate].detail,
      value: candidate as StageMode,
    })),
    { title: `Stage ${stage.value} — mode`, placeHolder: "What kind of stage is this?" },
  );
  if (!mode || mode.value === current) {
    return;
  }
  await controller.declareStageMode(key, run.location.projectDir, stage.value, mode.value);
  void vscode.window.showInformationMessage(
    mode.value === "independent_review"
      ? `Agent Sparring: Stage ${stage.value} is now review-only. If its stage has already run under the other mode, the engine will refuse to continue it and tell you to run sparring reset-stage, which archives that attempt and restarts the stage with a fresh reviewer.`
      : `Agent Sparring: Stage ${stage.value} runs the implementation lifecycle again.`,
  );
}

async function pickStageLabel(controller: SparringController, location: SparringLocation, key: string, entries: StageEntry[]): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => {
      const declared = controller.stageRepositoriesFor(key, location.projectDir, entry.label);
      return {
        label: entry.display,
        description: declared.length === 0 ? "" : `also reviews ${declared.map((repository) => repository.name).join(", ")}`,
        value: entry.label,
      };
    }),
    { title: "Sibling repositories", placeHolder: "Which stage reviews more than this repository?" },
  );
  return picked?.value;
}

/** The declarations for one stage: what is there, plus adding one and removing one. */
async function editStageRepositories(controller: SparringController, location: SparringLocation, key: string, label: string): Promise<void> {
  const declared = controller.stageRepositoriesFor(key, location.projectDir, label);
  const add = { label: "$(add) Add a repository…", value: undefined as string | undefined };
  const picked = await vscode.window.showQuickPick(
    [
      ...declared.map((repository) => ({
        label: `$(trash) ${repository.name}`,
        description: `on ${repository.branch}`,
        detail: `Remove this declaration. ${relativeRepositoryPath(location.repoRoot, repository.path)}`,
        value: repository.name,
      })),
      add,
    ],
    { title: `Stage ${label} — sibling repositories`, placeHolder: declared.length === 0 ? "This stage reviews only the primary repository." : "Pick one to remove, or add another." },
  );
  if (!picked) {
    return;
  }
  if (picked.value) {
    await controller.undeclareStageRepository(key, location.projectDir, label, picked.value);
    return;
  }
  await addStageRepository(controller, location, key, label);
}

async function addStageRepository(controller: SparringController, location: SparringLocation, key: string, label: string): Promise<void> {
  const repositories = (await knownRepositories()).filter((repository) => path.resolve(repository.rootPath) !== path.resolve(location.repoRoot));
  const browse = { label: "$(folder-opened) Choose a folder…", value: undefined as { rootPath: string; branch?: string } | undefined };
  const picked = await vscode.window.showQuickPick(
    [
      ...repositories.map((repository) => ({
        label: `$(repo) ${path.basename(repository.rootPath)}`,
        description: repository.branch ? `on ${repository.branch}` : "",
        detail: repository.rootPath,
        value: repository,
      })),
      browse,
    ],
    { title: `Stage ${label} — add a repository`, placeHolder: "Which repository does this stage also change?" },
  );
  if (!picked) {
    return;
  }
  let chosen = picked.value;
  if (!chosen) {
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Use this repository" });
    const root = folders?.[0]?.fsPath;
    if (!root) {
      return;
    }
    chosen = { rootPath: root, branch: await currentBranch(root) };
  }

  // The branch the engine will require that repository to be on. Prefilled
  // with what is checked out there now, because that is nearly always the
  // review branch — but it is the *expected* branch, so it stays editable.
  const branch = await vscode.window.showInputBox({
    title: `Stage ${label} — branch in ${path.basename(chosen.rootPath)}`,
    prompt: "The branch this repository's candidate must be on. The engine refuses to freeze it on any other.",
    value: chosen.branch ?? "",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "A branch is required."),
  });
  if (!branch?.trim()) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: `Stage ${label} — name for ${path.basename(chosen.rootPath)}`,
    prompt: "How this repository is named in the manifest and in the engine's recorded candidate set.",
    value: path.basename(chosen.rootPath),
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "A name is required."),
  });
  if (!name?.trim()) {
    return;
  }
  await controller.declareStageRepository(key, location.projectDir, label, { name: name.trim(), path: chosen.rootPath, branch: branch.trim() });
  void vscode.window.showInformationMessage(
    `Agent Sparring: Stage ${label} also reviews ${name.trim()} on ${branch.trim()}. Acceptance will pin that repository's reviewed commit and refuse if it moved.`,
  );
}

/**
 * The next stage cannot be started as things stand (no clear section, an
 * ambiguous definition, a heading-only section): nothing is created, the
 * reason is stated, and the two ways forward are offered.
 */
async function explainNextStageProblem(controller: SparringController, overview: OverviewPanelManager, run: StandaloneStageSnapshot, planPath: string, message: string, line: number | undefined): Promise<void> {
  controller.log(`Start next stage: nothing created — ${message}`);
  const choice = await vscode.window.showWarningMessage(`Agent Sparring: ${message}`, "Open plan section", "Change match…");
  if (choice === "Open plan section") {
    await openDocument(planPath, `the plan document ${path.basename(planPath)} is missing.`, overview.documentColumn, line);
  } else if (choice === "Change match…") {
    if (controller.currentSelection.selected?.id === run.id) {
      await matchStageCommand(controller, overview);
    }
  }
}
