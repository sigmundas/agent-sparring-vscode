/**
 * The extension shell: discovery + selection + tailing wired to one status
 * bar item and one Output Channel. Everything decision-like lives in
 * `../core`; this file only adapts it to the vscode API.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { ActivityTailer } from "../core/activityTailer";
import { diagnoseDiscovery, renderDiagnostic, type DiscoveryDiagnostic } from "../core/diagnose";
import {
  DEFAULT_NESTED_SEARCH_DEPTH,
  activityPathFor,
  currentStageOf,
  discoverRuns,
  isNestedLocation,
  locateAll,
  runLabel,
  selectRun,
  totalStagesOf,
  type Discovery,
  type LocateOptions,
  type RunPreference,
  type RunSelection,
  type RunSnapshot,
  type SparringLocation,
} from "../core/discovery";
import { deriveLiveness, type ExecutionRecord, type RunnerLiveness } from "../core/liveness";
import { applyEvent, emptyLiveState, type LiveState } from "../core/liveState";
import {
  HUMAN_CHECKS_KEY,
  HUMAN_FEEDBACK_KEY,
  humanChecksFor,
  humanFeedbackFor,
  withHumanCheck,
  withHumanFeedback,
  withoutHumanChecks,
  withoutHumanFeedback,
  type CheckRecord,
  type HumanCheckDrafts,
  type HumanFeedbackDrafts,
} from "../core/humanChecks";
import {
  SUBMISSIONS_KEY,
  submissionFailureReason,
  submissionFor,
  submissionState,
  withSubmission,
  withSubmissionFailure,
  withoutSubmission,
  type SubmissionRecord,
  type Submissions,
} from "../core/submission";
import { LogRenderer } from "../core/logFormat";
import { PLAN_ASSOCIATIONS_KEY, planAssociationFor, withAssociation, withManualMatch, type HeadingRef, type PlanAssociation, type PlanAssociations } from "../core/planAssociation";
import {
  STAGE_REPOSITORIES_KEY,
  repositoriesForPlan,
  repositoriesForStage,
  withStageRepository,
  withoutStageRepository,
  type DeclaredRepository,
  type StageRepositories,
} from "../core/stageRepositories";
import {
  STAGE_MODES_KEY,
  modeForStage,
  modesForPlan,
  withStageMode,
  type StageMode,
  type StageModes,
} from "../core/stageModes";
import { deriveStatus } from "../core/status";
import { SparringCommandRunner, type RunCommandOptions, type RunCommandResult } from "./commandRunner";
import { TerminalPool } from "./terminalPool";
import { ExecutionTracker, type CommandNotFound, type EngineFailure, type LaunchOptions, type LaunchResult } from "./executionTracker";

const SELECTED_RUN_KEY = "agentSparring.selectedRunId";
/** When that choice was made, so a managed run that advances afterwards can overtake it. */
const SELECTED_AT_KEY = "agentSparring.selectedRunAtMs";
/** The run last shown, whether chosen explicitly or automatically; restores across reloads. */
const STICKY_RUN_KEY = "agentSparring.lastShownRunId";
const OUTPUT_CHANNEL_NAME = "Agent Sparring";
/** How often the process table may be read for one run whose liveness nothing in this window watched. */
const PROBE_COOLDOWN_MS = 15_000;

export class SparringController implements vscode.Disposable {
  readonly output: vscode.OutputChannel;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private locations: SparringLocation[] = [];
  private discovery: Discovery = { locations: [], runs: [], problems: [] };
  private selection: RunSelection = { ambiguous: [] };
  private live: LiveState | undefined;
  private tailer: ActivityTailer | undefined;
  private readonly logRenderer = new LogRenderer();
  private attachedRunId: string | undefined;
  /** Runner process observations (launched, typed in a terminal, or re-found after a reload). */
  private readonly tracker: ExecutionTracker;
  /** Short commands (freeze / accept) run to completion; never tracked as runners. */
  private readonly commands: SparringCommandRunner;
  /** The integrated terminals this extension owns: one per project, reused. */
  private readonly terminals: TerminalPool;
  private reattached = false;
  /** When the process table was last read for a run id; see resolveUnwatchedRunner. */
  private readonly probed = new Map<string, number>();
  /** Run ids whose Accept stage operation from this window is still in flight. */
  private readonly accepting = new Set<string>();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after every re-render: selection, authoritative state or live activity changed. */
  readonly onDidChange = this.changeEmitter.event;
  /** A launch from this window ended because the shell could not find the command. */
  readonly onCommandNotFound: vscode.Event<CommandNotFound>;
  /** A launch from this window ran the engine and it exited non-zero. */
  readonly onEngineFailed: vscode.Event<EngineFailure>;

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollInterval: ReturnType<typeof setInterval> | undefined;
  private renderInterval: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.statusBar = vscode.window.createStatusBarItem("agentSparring.status", vscode.StatusBarAlignment.Left, 50);
    this.statusBar.name = "Agent Sparring";
    this.statusBar.command = "agentSparring.openOverview";
    this.disposables.push(this.output, this.statusBar, this.changeEmitter);
    this.terminals = new TerminalPool((message) => this.log(message));
    this.tracker = new ExecutionTracker(
      context,
      (message) => this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} ${message}`),
      () => this.locations,
      this.terminals,
    );
    this.onCommandNotFound = this.tracker.onCommandNotFound;
    this.onEngineFailed = this.tracker.onEngineFailed;
    this.commands = new SparringCommandRunner((message) => this.log(message), this.terminals);
    this.disposables.push(
      this.tracker,
      this.commands,
      this.terminals,
      // A runner ending may have left new authoritative files behind; a
      // start or liveness change only needs re-rendering.
      // A runner ending is also the moment a submission is decided: its exit
      // code is what says whether the evidence was recorded or the drafts must
      // be kept. A start or liveness change only needs re-rendering.
      this.tracker.onDidChange((change) => {
        if (change === "ended") {
          void this.resolveSubmissions().then(() => this.refresh());
        } else {
          this.render();
        }
      }),
    );

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.start()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("agentSparring.pollIntervalMs")) {
          this.armPolling();
        }
        if (event.affectsConfiguration("agentSparring.nestedSearchDepth")) {
          this.scheduleRefresh();
        }
      }),
    );
    this.renderInterval = setInterval(() => this.render(), 60_000);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.disposeWatchers();
    // Every workspace folder is watched independently, whether or not it has
    // a .sparring yet, so one created later (e.g. by `sparring new-stage`
    // in a terminal) is discovered without a reload.
    for (const folder of this.fileFolders()) {
      this.watch(folder);
    }
    this.statusBar.show();
    await this.refresh();
    this.armPolling();
    if (!this.reattached) {
      // Launches recorded before a reload: liveness is re-established from
      // terminals and processes, never from the telemetry just replayed.
      this.reattached = true;
      // Then any submission that was in flight when the window went away is
      // decided by what its own execution turned out to do, so a reload can
      // neither strand it as "Submitting…" nor discard its drafts.
      void this.tracker.reattach().then(() => this.resolveSubmissions());
    }
  }

  private fileFolders(): vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
  }

  /** Probe each workspace folder on its own (including nested projects); never merge folders into one root. */
  private async relocate(): Promise<void> {
    const before = this.locations;
    this.locations = await locateAll(
      this.fileFolders().map((folder) => ({ path: folder.uri.fsPath, name: folder.name })),
      this.locateOptions(),
    );
    const nestedBefore = before.filter(isNestedLocation).map((location) => location.projectDir);
    const nestedNow = this.locations.filter(isNestedLocation).map((location) => location.projectDir);
    if (nestedBefore.join("\0") !== nestedNow.join("\0")) {
      this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} nested projects with .sparring: ${nestedNow.length === 0 ? "none" : nestedNow.join(", ")}`);
    }
  }

  private locateOptions(): LocateOptions {
    const configured = vscode.workspace.getConfiguration("agentSparring").get<number>("nestedSearchDepth", DEFAULT_NESTED_SEARCH_DEPTH);
    return { nestedSearchDepth: Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : DEFAULT_NESTED_SEARCH_DEPTH };
  }

  /**
   * Trace the production discovery path for every workspace folder into the
   * Output Channel (paths, existence, parse success and lifecycle status
   * only) and return the structured report.
   */
  async diagnoseDiscovery(): Promise<DiscoveryDiagnostic> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      index: folder.index,
      name: folder.name,
      scheme: folder.uri.scheme,
      fsPath: folder.uri.fsPath,
    }));
    const report = await diagnoseDiscovery(folders, {
      ...this.locateOptions(),
      preferredId: this.preference()?.id,
      stickyId: this.attachedRunId ?? this.context.workspaceState.get<string>(STICKY_RUN_KEY),
    });
    this.output.appendLine("");
    this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} ---- Diagnose Discovery (extension ${String(this.context.extension.packageJSON.version)}) ----`);
    for (const line of renderDiagnostic(report)) {
      this.output.appendLine(`${" ".repeat(26)}${line}`);
    }
    this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} ---- end of diagnostic ----`);
    this.output.show(true);
    return report;
  }

  dispose(): void {
    this.disposeWatchers();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private watcherDisposables: vscode.Disposable[] = [];

  private watch(folder: vscode.WorkspaceFolder): void {
    // Deliberately narrow globs: only the engine's authoritative files and
    // the activity stream, at any depth so nested projects are covered too.
    // The base is a workspace folder, so this filters the workspace watcher's
    // existing event stream rather than starting a new recursive watcher.
    const authoritative = ["**/.sparring/plans/*.json", "**/.sparring/stages/*/state.json", "**/.sparring/stages/*/sparring.md"];
    for (const glob of authoritative) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      const onChange = () => this.scheduleRefresh();
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.watcherDisposables.push(watcher);
    }
    const activity = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/.sparring/stages/*/activity.jsonl"));
    const onActivity = (uri: vscode.Uri) => {
      if (this.tailer && path.resolve(uri.fsPath) === path.resolve(this.tailer.path)) {
        this.schedulePoll();
      } else if (!this.selection.selected) {
        // A run started externally may write telemetry before we noticed its state file.
        this.scheduleRefresh();
      }
    };
    activity.onDidCreate(onActivity);
    activity.onDidChange(onActivity);
    activity.onDidDelete(onActivity);
    this.watcherDisposables.push(activity);
  }

  private disposeWatchers(): void {
    for (const disposable of this.watcherDisposables.splice(0)) {
      disposable.dispose();
    }
  }

  private armPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    const configured = vscode.workspace.getConfiguration("agentSparring").get<number>("pollIntervalMs", 1500);
    const interval = Math.max(250, configured);
    this.pollInterval = setInterval(() => void this.pollActivity(), interval);
  }

  // ---------------------------------------------------------------- discovery

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), 200);
  }

  async refresh(): Promise<void> {
    this.refreshTimer = undefined;
    await this.relocate();
    this.discovery = await discoverRuns(this.locations);
    const sticky = this.attachedRunId ?? this.context.workspaceState.get<string>(STICKY_RUN_KEY);
    this.selection = selectRun(this.discovery.runs, this.preference(), sticky);
    if (this.selection.selected && this.selection.selected.id !== this.context.workspaceState.get<string>(STICKY_RUN_KEY)) {
      await this.context.workspaceState.update(STICKY_RUN_KEY, this.selection.selected.id);
    }
    await this.attachToSelected();
    this.render();
    await this.resolveUnwatchedRunner();
  }

  /**
   * Settle the liveness of the selected run when this window watched no
   * execution for it and telemetry claims a turn is in progress.
   *
   * That combination is what a closed terminal plus a reload leaves, and
   * what a loop started outside VS Code looks like. It used to present as
   * "Working?" / "Run status unknown" indefinitely, with every action
   * withheld — including the Resume plan the situation actually called for.
   * The process table answers it (ExecutionTracker.probeProject); when it
   * cannot, the state stays unknown, which is still the honest answer.
   *
   * `turnActive` is the trigger, and it is precise: deriveLiveness reports
   * it only when telemetry alone claims a turn, which is exactly the case
   * nothing this window watched can settle. A later turn puts the run back
   * in that state, so the question is asked again rather than answered from
   * an earlier probe — throttled, because it reads the process table.
   */
  private async resolveUnwatchedRunner(): Promise<void> {
    const run = this.selection.selected;
    if (!run || !this.livenessFor(run.id).turnActive) {
      return;
    }
    const last = this.probed.get(run.id) ?? 0;
    if (Date.now() - last < PROBE_COOLDOWN_MS) {
      return;
    }
    this.probed.set(run.id, Date.now());
    if (await this.tracker.probeProject(run.location, run.id, run.kind === "plan" ? "resume-plan" : "run-loop")) {
      this.render();
    }
  }

  get currentSelection(): RunSelection {
    return this.selection;
  }

  get currentDiscovery(): Discovery {
    return this.discovery;
  }

  get currentLive(): LiveState | undefined {
    return this.live;
  }

  // ---------------------------------------------------------------- runners

  /**
   * Launch a sparring command in an integrated terminal and observe its
   * lifetime (see ExecutionTracker). `runId` ties the process to a
   * discovered run so the Overview can offer Stop and, after it ends, say
   * "interrupted" instead of "running".
   */
  async launch(options: LaunchOptions): Promise<LaunchResult> {
    const result = await this.tracker.launch(options);
    if (result.ok) {
      // The engine writes its state before the first provider turn; pick it up promptly.
      setTimeout(() => void this.refresh(), 1500);
      setTimeout(() => void this.refresh(), 6000);
    }
    this.render();
    return result;
  }

  /** Run one short sparring command to completion (see SparringCommandRunner). */
  runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
    return this.commands.run(options);
  }

  /** Append a line to the Output Channel under the Extension actor. */
  log(message: string): void {
    this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} ${message}`);
  }

  // ---------------------------------------------------------------- execution manifests

  /**
   * Where the execution manifests this extension hands the engine are kept:
   * the extension's own global storage, deliberately outside every
   * repository.
   *
   * A manifest is a derived artifact — regenerated from the plan on each
   * invocation and byte-stable while the plan is unchanged — so it must not
   * appear in the user's worktree, where the engine's own freeze would then
   * refuse it as an unrepresented change. Keeping it here also means it
   * survives for the whole run, which a temporary file deleted after launch
   * would not.
   */
  get manifestDirectoryPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, "manifests");
  }

  /** The same directory, created; readers use {@link manifestDirectoryPath} and never write while rendering. */
  async manifestDirectory(): Promise<string> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.manifestDirectoryPath));
    return this.manifestDirectoryPath;
  }

  // ---------------------------------------------------------------- acceptance in flight

  isAccepting(runId: string | undefined): boolean {
    return runId !== undefined && this.accepting.has(runId);
  }

  setAccepting(runId: string, accepting: boolean): void {
    if (accepting) {
      this.accepting.add(runId);
    } else {
      this.accepting.delete(runId);
    }
    this.render();
  }

  // ---------------------------------------------------------------- plan associations (UI metadata only)

  /** The Markdown plan the user associated with a run in this workspace, if any. Never read by or written into the engine. */
  associatedPlan(runId: string | undefined): string | undefined {
    return this.planAssociation(runId)?.path;
  }

  /** The association with its manual heading match, if any. */
  planAssociation(runId: string | undefined): PlanAssociation | undefined {
    return runId === undefined ? undefined : planAssociationFor(this.context.workspaceState.get<PlanAssociations>(PLAN_ASSOCIATIONS_KEY), runId);
  }

  async setAssociatedPlan(runId: string, planPath: string | undefined): Promise<void> {
    const next = withAssociation(this.context.workspaceState.get<PlanAssociations>(PLAN_ASSOCIATIONS_KEY), runId, planPath);
    await this.context.workspaceState.update(PLAN_ASSOCIATIONS_KEY, next);
    this.log(planPath ? `associated plan ${path.basename(planPath)} with ${runId.split("|").pop()} (VS Code workspace state only)` : `removed the plan association of ${runId.split("|").pop()}`);
    this.render();
  }

  /** Record which heading of the associated plan is this stage (or clear it); workspace state only. */
  async setManualMatch(runId: string, match: HeadingRef | undefined): Promise<void> {
    const next = withManualMatch(this.context.workspaceState.get<PlanAssociations>(PLAN_ASSOCIATIONS_KEY), runId, match);
    await this.context.workspaceState.update(PLAN_ASSOCIATIONS_KEY, next);
    const stage = runId.split("|").pop();
    this.log(match ? `matched ${stage} to plan heading ${match.label ? `Stage ${match.label} — ` : ""}${match.title} (VS Code workspace state only)` : `cleared the manual plan heading match of ${stage}`);
    this.render();
  }

  // ---------------------------------------------------------------- sibling repositories (declaration, emitted into the manifest)

  /** Every stage's declared sibling repositories for one plan, keyed by label (`3D`). Workspace state; never written into engine state. */
  stageRepositories(planKey: string): Record<string, DeclaredRepository[]> {
    return repositoriesForPlan(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey);
  }

  /** One stage's declarations. */
  stageRepositoriesFor(planKey: string, label: string): DeclaredRepository[] {
    return repositoriesForStage(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, label);
  }

  /** Declare (or re-declare, by name) a sibling repository this stage's candidate spans. No commit is recorded: the engine pins that at the freeze boundary. */
  async declareStageRepository(planKey: string, label: string, repository: DeclaredRepository): Promise<void> {
    const next = withStageRepository(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, label, repository);
    await this.context.workspaceState.update(STAGE_REPOSITORIES_KEY, next);
    this.log(`Stage ${label}: also reviews ${repository.name} on ${repository.branch} (${repository.path}); it goes into the execution manifest, and the engine pins and re-verifies its commit`);
    this.render();
  }

  async undeclareStageRepository(planKey: string, label: string, name: string): Promise<void> {
    const next = withoutStageRepository(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, label, name);
    await this.context.workspaceState.update(STAGE_REPOSITORIES_KEY, next);
    this.log(`Stage ${label}: no longer declares ${name}; already-recorded pins stay in the stage's state.json until the next run rewrites the declaration`);
    this.render();
  }

  // ---------------------------------------------------------------- stage modes (declaration, emitted into the manifest)

  /** Stages of one plan declared review-only, keyed by label (`5`). Workspace state; never written into engine state. */
  stageModes(planKey: string): Record<string, StageMode> {
    return modesForPlan(this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY), planKey);
  }

  /** One stage's declared mode; `implementation` when nothing was declared. */
  stageModeFor(planKey: string, label: string): StageMode {
    return modeForStage(this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY), planKey, label);
  }

  /**
   * Declare what kind of stage this is. It reaches the engine through the
   * execution manifest, never by writing engine state — and because the
   * engine folds a declared mode into the digest that identifies a recorded
   * run, changing it for a stage of a run already under way is something the
   * engine refuses to continue across until its `reset-stage` command
   * re-records that digest. Said here rather than left to be discovered.
   */
  async declareStageMode(planKey: string, label: string, mode: StageMode): Promise<void> {
    const next = withStageMode(this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY), planKey, label, mode);
    await this.context.workspaceState.update(STAGE_MODES_KEY, next);
    this.log(
      mode === "independent_review"
        ? `Stage ${label}: declared review-only; the execution manifest will carry mode=independent_review, so no implementation agent runs for it and a fresh reviewer inspects the accepted candidate set`
        : `Stage ${label}: back to the implementation lifecycle; the manifest carries no mode for it, which is the engine's default`,
    );
    this.render();
  }

  // ---------------------------------------------------------------- manual check drafts (UI state until submitted)

  /** Outcomes / notes the user recorded for the plan's manual checks of a run; drafts in workspace state until Submit evidence writes them to notes.md. */
  humanChecks(runId: string | undefined): Record<string, CheckRecord> {
    return runId === undefined ? {} : humanChecksFor(this.context.workspaceState.get<HumanCheckDrafts>(HUMAN_CHECKS_KEY), runId);
  }

  /** Merge one check's outcome and/or note. `notify` false keeps the Overview from re-rendering (a note being typed). */
  async setHumanCheck(runId: string, key: string, change: CheckRecord, notify = true): Promise<void> {
    const next = withHumanCheck(this.context.workspaceState.get<HumanCheckDrafts>(HUMAN_CHECKS_KEY), runId, key, change);
    await this.context.workspaceState.update(HUMAN_CHECKS_KEY, next);
    if (notify) {
      this.render();
    }
  }

  async clearHumanChecks(runId: string): Promise<void> {
    await this.context.workspaceState.update(HUMAN_CHECKS_KEY, withoutHumanChecks(this.context.workspaceState.get<HumanCheckDrafts>(HUMAN_CHECKS_KEY), runId));
    this.render();
  }

  /**
   * The freeform findings a person has typed for a run and not sent yet.
   *
   * Stored like the check drafts and for the same reason — a rerender, a
   * details disclosure or a window reload must not lose a reproduction path
   * someone just wrote out — but stored apart from them, because it is not a
   * result for any check and nothing may ever read it as one.
   */
  humanFeedback(runId: string | undefined): string | undefined {
    return runId === undefined ? undefined : humanFeedbackFor(this.context.workspaceState.get<HumanFeedbackDrafts>(HUMAN_FEEDBACK_KEY), runId);
  }

  /** Replace the draft with what the field now holds. `notify` false keeps the Overview from re-rendering mid-keystroke. */
  async setHumanFeedback(runId: string, text: string, notify = false): Promise<void> {
    const next = withHumanFeedback(this.context.workspaceState.get<HumanFeedbackDrafts>(HUMAN_FEEDBACK_KEY), runId, text);
    await this.context.workspaceState.update(HUMAN_FEEDBACK_KEY, next);
    if (notify) {
      this.render();
    }
  }

  /** Only a submission the engine actually recorded clears it; see {@link resolveSubmission}. */
  async clearHumanFeedback(runId: string): Promise<void> {
    await this.context.workspaceState.update(HUMAN_FEEDBACK_KEY, withoutHumanFeedback(this.context.workspaceState.get<HumanFeedbackDrafts>(HUMAN_FEEDBACK_KEY), runId));
    this.render();
  }

  // ---------------------------------------------------------------- submissions (drafts survive until the engine records them)

  /** The submission in flight or last failed for a run; undefined once the engine has recorded one. */
  submissionFor(runId: string | undefined): SubmissionRecord | undefined {
    return runId === undefined ? undefined : submissionFor(this.context.workspaceState.get<Submissions>(SUBMISSIONS_KEY), runId);
  }

  /**
   * Record that evidence has been handed to the engine. The drafts are *not*
   * cleared here: this is the beginning of a submission, and only the exit
   * code of `record.executionId` says whether it became one.
   */
  async beginSubmission(record: SubmissionRecord): Promise<void> {
    await this.context.workspaceState.update(SUBMISSIONS_KEY, withSubmission(this.context.workspaceState.get<Submissions>(SUBMISSIONS_KEY), record));
    this.log(`Submission: ${record.results > 0 ? `${record.results} check result(s)` : "freeform feedback"} handed to the engine for ${record.stageId ?? record.runId}; the drafts are kept until it exits 0`);
    this.render();
  }

  /**
   * Resolve every pending submission against the execution it launched.
   *
   * Called whenever an execution ends and once after a window reload (where
   * the recorded launch carries the exit code observed before the reload), so
   * a submission is never left pending by a reload and never resolved by
   * anything other than its own execution's exit code.
   */
  async resolveSubmissions(): Promise<void> {
    const submissions = this.context.workspaceState.get<Submissions>(SUBMISSIONS_KEY);
    for (const runId of Object.keys(submissions ?? {})) {
      const record = submissionFor(submissions, runId);
      if (!record || record.failure) {
        continue; // already reported; the drafts are kept and the panel says so
      }
      const execution = this.tracker.recordById(record.executionId);
      const state = submissionState(execution);
      if (state === "pending") {
        continue;
      }
      if (state === "recorded") {
        await this.context.workspaceState.update(SUBMISSIONS_KEY, withoutSubmission(this.context.workspaceState.get<Submissions>(SUBMISSIONS_KEY), runId));
        if (record.channel === "checks") {
          await this.clearHumanChecks(runId);
        } else {
          await this.clearHumanFeedback(runId);
        }
        this.log(`Submission: the engine exited 0 for ${record.stageId ?? runId}; the evidence is recorded and the drafts are cleared`);
        continue;
      }
      const failure = { atMs: Date.now(), exitCode: execution?.exitCode, output: await this.tracker.outputOf(record.executionId), reason: submissionFailureReason(execution?.exitCode) };
      await this.context.workspaceState.update(SUBMISSIONS_KEY, withSubmissionFailure(this.context.workspaceState.get<Submissions>(SUBMISSIONS_KEY), runId, failure));
      this.log(`Submission: ${failure.reason} Every drafted result and note for ${record.stageId ?? runId} is kept exactly as it was.`);
      this.render();
    }
  }

  /** Dismiss a failed submission's report. The drafts are untouched: they are the user's, not the report's. */
  async dismissSubmission(runId: string): Promise<void> {
    await this.context.workspaceState.update(SUBMISSIONS_KEY, withoutSubmission(this.context.workspaceState.get<Submissions>(SUBMISSIONS_KEY), runId));
    this.render();
  }

  /** The latest runner execution observed for a run (running, unknown after a reload, or ended). */
  executionFor(runId: string | undefined): ExecutionRecord | undefined {
    return this.tracker.executionFor(runId);
  }

  /** Send Ctrl-C to the exact terminal running this run; nothing else is signalled. */
  stopRunner(runId: string): boolean {
    return this.tracker.stop(runId);
  }

  /** Runner liveness for the selected run, combining process observation with the activity fold. */
  get currentLiveness(): RunnerLiveness {
    return this.livenessFor(this.selection.selected?.id);
  }

  livenessFor(runId: string | undefined): RunnerLiveness {
    return deriveLiveness(this.live, this.tracker.executionFor(runId), Date.now());
  }

  /** What a window reload would find recorded about this window's launches (integration tests). */
  persistedLaunches(): { runId: string; state: "running" | "ended" }[] {
    return this.tracker.persisted();
  }

  /** Live state as presented: turns a runner known to have ended cannot be executing are cleared. */
  get presentedLive(): LiveState | undefined {
    return this.currentLiveness.live;
  }

  get sparringLocations(): SparringLocation[] {
    return this.locations;
  }

  /** The run the user chose, with the moment they chose it (see selectRun). */
  private preference(): RunPreference | undefined {
    const id = this.context.workspaceState.get<string>(SELECTED_RUN_KEY);
    return id ? { id, atMs: this.context.workspaceState.get<number>(SELECTED_AT_KEY) } : undefined;
  }

  async chooseRun(run: RunSnapshot | undefined): Promise<void> {
    await this.context.workspaceState.update(SELECTED_RUN_KEY, run?.id);
    await this.context.workspaceState.update(SELECTED_AT_KEY, run ? Date.now() : undefined);
    await this.refresh();
  }

  private async attachToSelected(): Promise<void> {
    const run = this.selection.selected;
    if (!run) {
      if (this.tailer) {
        this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} detached; no active run`);
      }
      this.tailer = undefined;
      this.live = undefined;
      this.attachedRunId = undefined;
      return;
    }
    const activityPath = activityPathFor(run);
    const sameTarget = this.tailer && path.resolve(this.tailer.path) === path.resolve(activityPath) && this.attachedRunId === run.id;
    if (sameTarget) {
      await this.pollActivity();
      return;
    }
    this.tailer = new ActivityTailer(activityPath);
    this.logRenderer.reset();
    this.live = emptyLiveState();
    this.attachedRunId = run.id;
    const stage = currentStageOf(run);
    const position = run.kind === "plan" ? `stage ${run.state.currentStageIndex + 1}/${totalStagesOf(run) ?? "?"}` : "stage";
    this.output.appendLine("");
    this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} attached to ${run.location.folderName} · ${runLabel(run)} · ${position} ${stage.stageId}`);
    await this.pollActivity();
  }

  // ---------------------------------------------------------------- tailing

  private schedulePoll(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollActivity();
    }, 100);
  }

  private async pollActivity(): Promise<void> {
    if (!this.tailer || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const result = await this.tailer.poll();
      if (result.reset) {
        this.live = emptyLiveState();
        this.logRenderer.reset();
        this.output.appendLine(
          `${now()}  ${"Extension".padEnd(15)} ${result.exists ? "activity log recreated; replaying" : "activity log removed; live details unavailable"}`,
        );
      }
      if (result.events.length > 0) {
        const live = this.live ?? emptyLiveState();
        for (const event of result.events) {
          applyEvent(live, event);
          const line = this.logRenderer.render(event);
          if (line) {
            this.output.appendLine(line);
          }
        }
        this.live = live;
        this.render();
      } else if (result.reset) {
        this.render();
      }
    } catch (error) {
      this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} could not read activity log: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    const liveness = this.currentLiveness;
    const view = deriveStatus(this.selection, liveness.live, Date.now(), liveness);
    this.statusBar.text = view.text;
    const tooltip = new vscode.MarkdownString(view.tooltip.replace(/\n/g, "  \n"));
    tooltip.appendMarkdown("\n\nClick to open the run overview.");
    this.statusBar.tooltip = tooltip;
    this.statusBar.backgroundColor =
      view.severity === "warning"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : view.severity === "error"
          ? new vscode.ThemeColor("statusBarItem.errorBackground")
          : undefined;
    this.changeEmitter.fire();
  }

  showLog(): void {
    this.output.show(true);
  }
}

function now(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
