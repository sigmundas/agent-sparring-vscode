/**
 * The extension shell: discovery + selection + tailing wired to one status
 * bar item and one Output Channel. Everything decision-like lives in
 * `../core`; this file only adapts it to the vscode API.
 */


import * as path from "node:path";
import * as vscode from "vscode";
import { ActivityTailer } from "../core/activityTailer";
import { FOLLOW_ACTIVE_LABEL } from "../core/activeRepository";
import { diagnoseDiscovery, renderDiagnostic, type DiscoveryDiagnostic } from "../core/diagnose";
import {
  DEFAULT_NESTED_SEARCH_DEPTH,
  activityPathFor,
  canonicalPath,
  currentStageOf,
  discoverRuns,
  intentForChoosing,
  isNestedLocation,
  locateAll,
  runLabel,
  samePath,
  selectRun,
  totalStagesOf,
  type Discovery,
  type LocateOptions,
  type RunPreference,
  type RepositoryScope,
  type RunSelection,
  type PlanRunSnapshot,
  type RunSnapshot,
  type SparringLocation,
} from "../core/discovery";
import { type ManifestStageIdentity } from "../core/manifest";
import { launchRepositories, type LaunchRepository } from "../core/launchRepositories";
import { resolveMemberships, stageOwnership, type PlanMembership } from "../core/planMembership";
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
  migrateStageRepositories,
  repositoriesForPlan,
  repositoriesForStage,
  withStageRepository,
  withoutStageRepository,
  type DeclaredRepository,
  type StageRepositories,
} from "../core/stageRepositories";
import {
  STAGE_MODES_KEY,
  migrateStageModes,
  modeForStage,
  modesForPlan,
  withStageMode,
  type StageMode,
  type StageModes,
} from "../core/stageModes";
import { deriveStatus } from "../core/status";
import { SparringCommandRunner, type RunCommandOptions, type RunCommandResult } from "./commandRunner";
import { TerminalPool } from "./terminalPool";
import { ExecutionTracker, type CommandNotFound, type EngineFailure, type LaunchOptions, type LaunchResult, type PendingSubmission } from "./executionTracker";
import { ManifestReader, type BoundManifest } from "./manifestReader";
import { ActiveRepositoryTracker, RealPaths } from "./activeRepository";
import { describeReadiness } from "../core/gitReadiness";
import type { DeclarationMigration } from "../core/declarationScope";

const SELECTED_RUN_KEY = "agentSparring.selectedRunId";
/** When that choice was made, so a managed run that advances afterwards can overtake it. */
const SELECTED_AT_KEY = "agentSparring.selectedRunAtMs";
/** The run last shown, whether chosen explicitly or automatically; restores across reloads. */
const STICKY_RUN_KEY = "agentSparring.lastShownRunId";
/**
 * Which pin policy the stored selection was made under.
 *
 * An explicit selection used to mean "show this run", full stop; there was no
 * repository context for it to survive. It now means "keep this run on screen
 * even when this window is in another repository", which is a stronger and
 * longer-lived promise than anyone made when they clicked a row in the old
 * picker. Promoting an old selection to that silently would leave a window
 * pinned to a foreign repository's run with no memory of having asked, so a
 * selection stored before this key exists is demoted to the ordinary
 * remembered run instead: it is still what the cockpit shows while the window
 * is in its repository, and it lets go as soon as the window is not.
 */
const PIN_POLICY_KEY = "agentSparring.pinPolicy";
const PIN_POLICY = "repository-scoped-pin-v1";
/**
 * What the stored pin meant when it was made: `inspect` or `follow` (see
 * `RunPreference.intent`). Absent — a pin stored before this was recorded — is
 * read as `inspect`, the reading that cannot move the screen out from under
 * the person who made it.
 */
const PIN_INTENT_KEY = "agentSparring.pinIntent";
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
  /** Which repository this window is in; automatic selection is confined to it. */
  private readonly activeRepository: ActiveRepositoryTracker;
  /** Symlink resolution for repository roots, so two spellings of one directory are one repository. */
  private readonly realPaths = new RealPaths();
  private reattached = false;
  /** When the process table was last read for a run id; see resolveUnwatchedRunner. */
  private readonly probed = new Map<string, number>();
  /** Run ids whose Accept stage operation from this window is still in flight. */
  private readonly accepting = new Set<string>();
  /** Reads execution manifests out of global storage; caches their bytes and never their binding. */
  private readonly manifests = new ManifestReader();
  /** The last rejection reported for a manifest file, so a steady refusal is logged once rather than per render. */
  private readonly manifestRefusals = new Map<string, string>();
  /** Unscoped declarations already reported, so a steady one is said once rather than per discovery. */
  private readonly reportedAmbiguousDeclarations = new Set<string>();

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
    // Moving to another repository re-decides which run the cockpit follows,
    // so it is a rediscovery like any other authoritative change.
    this.activeRepository = new ActiveRepositoryTracker((message) => this.log(message));
    this.disposables.push(this.activeRepository, this.activeRepository.onDidChange(() => this.scheduleRefresh()));
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
    await this.migratePinPolicy();
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

  /**
   * Demote a selection stored before pins meant what they now mean, and
   * record which policy later selections were made under. See
   * {@link PIN_POLICY_KEY}: nobody who clicked a row in the old picker asked
   * for a run to stay on screen across repositories, so nobody is given one.
   */
  private async migratePinPolicy(): Promise<void> {
    if (this.context.workspaceState.get<string>(PIN_POLICY_KEY) === PIN_POLICY) {
      return;
    }
    const stored = this.context.workspaceState.get<string>(SELECTED_RUN_KEY);
    if (stored) {
      this.log(
        `an explicit run selection was stored before pins survived a change of repository; it is kept as the remembered run rather than becoming a pin. ${FOLLOW_ACTIVE_LABEL} is how the cockpit follows this window, and Select repository / run is how to pin deliberately.`,
      );
      await this.context.workspaceState.update(SELECTED_RUN_KEY, undefined);
      await this.context.workspaceState.update(SELECTED_AT_KEY, undefined);
      await this.context.workspaceState.update(PIN_INTENT_KEY, undefined);
      if (!this.context.workspaceState.get<string>(STICKY_RUN_KEY)) {
        await this.context.workspaceState.update(STICKY_RUN_KEY, stored);
      }
    }
    await this.context.workspaceState.update(PIN_POLICY_KEY, PIN_POLICY);
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
      scope: await this.repositoryScope(),
      gitAttached: this.activeRepository.attached,
      gitReadiness: this.activeRepository.gitReadiness,
      manifestStages: (run) => this.manifestStagesFor(run),
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
    await this.migrateDeclarationScopes();
    const sticky = this.attachedRunId ?? this.context.workspaceState.get<string>(STICKY_RUN_KEY);
    // Ownership first: whether a plan run has taken over from a pinned stage
    // is a question about recorded membership, and answering it any other way
    // is the guessing that made unrelated stages look like a plan's history.
    const ownership = stageOwnership(await this.planMemberships());
    this.selection = selectRun(this.discovery.runs, this.preference(), sticky, await this.repositoryScope(), ownership, this.locations);
    if (this.selection.released) {
      await this.retireReleasedPin(this.selection.released);
    }
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

  /**
   * The repository automatic selection is confined to, or `undefined` when
   * this window is in no repository it can name.
   *
   * `undefined` is deliberately permissive: the Git extension may be
   * inactive, the folder may not be a repository at all, or nothing has
   * focused a repository yet. Scoping on a guess would hide runs; not
   * scoping only restores the behaviour from before following existed.
   *
   * Roots are aligned to the spellings this window's own discovered projects
   * use (see {@link alignRoots}), because attribution is now strict: a run
   * that cannot be attributed is not selected, so a `/tmp` versus
   * `/private/tmp` mismatch would empty the cockpit rather than merely widen
   * it.
   */
  private async repositoryScope(): Promise<RepositoryScope | undefined> {
    const active = this.activeRepository.activeRepoRoot;
    if (!active) {
      return undefined;
    }
    const known = this.activeRepository.knownRepoRoots ?? [active];
    const aligned = await this.alignRoots([active, ...known]);
    return { repoRoot: aligned[0], knownRoots: aligned };
  }

  /**
   * The Git extension's repository roots, re-spelled the way this window's
   * discovered projects spell the same directories.
   *
   * One spelling per root, so two entries never look like two repositories
   * with the same name — which is what would happen if `/tmp/foo` and
   * `/private/tmp/foo` were both kept and the context line then tried to
   * disambiguate them.
   */
  private async alignRoots(roots: readonly string[]): Promise<string[]> {
    const byRealPath = new Map<string, string>();
    for (const location of this.locations) {
      for (const dir of [location.repoRoot, location.projectDir]) {
        byRealPath.set(canonicalPath(await this.realPaths.of(dir)), dir);
      }
    }
    const out: string[] = [];
    for (const root of roots) {
      const aligned = byRealPath.get(canonicalPath(await this.realPaths.of(root))) ?? root;
      if (!out.some((seen) => samePath(seen, aligned))) {
        out.push(aligned);
      }
    }
    return out;
  }

  get currentSelection(): RunSelection {
    return this.selection;
  }

  /** The repository this window is in (integration tests and the diagnostic). */
  get activeRepositoryRoot(): string | undefined {
    return this.activeRepository.activeRepoRoot;
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

  /**
   * The stage identities of the manifest a managed run executes — but only
   * once that manifest has been bound to *this* run, on this call.
   *
   * The file lives in global storage, which is per-user and nothing else, so
   * finding one there is not evidence that it belongs to the run on screen,
   * and neither is its name. The manifest is candidate evidence; the authority
   * is the run's own recorded state plus the worktree identity, and
   * `bindParsedManifest` checks the lot (manifest.ts): the plan label, the
   * **executable digest against the `plan_digest` the engine recorded**, the
   * recorded current stage, and the sidecar record that says which worktree
   * the file was written for.
   *
   * A manifest that fails any check yields `undefined`, and every caller
   * degrades to "no recorded membership" — a standalone stage stays
   * standalone, the journey is not drawn, and nothing claims an ownership it
   * cannot show. The rejection is logged when it changes, because a silent
   * degradation is the one thing worse than an honest one.
   *
   * The read is cached — a manifest is the largest file the Overview touches,
   * and three surfaces want it on every render — but only its *bytes* are;
   * `ManifestReader` re-derives the binding from this `RunSnapshot` on every
   * call, and its header says why a cache must never hold the conclusion.
   */
  async manifestStagesFor(run: RunSnapshot): Promise<ManifestStageIdentity[] | undefined> {
    if (run.kind !== "plan" || run.state.source !== "manifest") {
      return undefined;
    }
    // The other discovered plan runs, so a manifest written before sidecars
    // existed can be refused when more than one of them could claim it.
    const peers = this.discovery.runs.filter((candidate): candidate is PlanRunSnapshot => candidate.kind === "plan" && candidate.state.source === "manifest");
    const bound = await this.manifests.readBound(this.manifestDirectoryPath, run, peers);
    this.reportManifestBinding(run, bound);
    return bound.binding.ok ? bound.binding.identity.stages : undefined;
  }

  /** Say what was decided the first time, and again whenever it changes; never once per render. */
  private reportManifestBinding(run: PlanRunSnapshot, bound: BoundManifest): void {
    const key = `${run.id} ${bound.file}`;
    const signature = bound.binding.ok ? (bound.derived ? "derived" : "bound") : `${bound.binding.reason}: ${bound.binding.detail}`;
    if (this.manifestRefusals.get(key) === signature) {
      return;
    }
    this.manifestRefusals.set(key, signature);
    if (!bound.binding.ok) {
      this.log(`the execution manifest ${bound.file} is not this run's: ${bound.binding.detail}. Its stages are not used, and no stage is attributed to this plan run from it.`);
      return;
    }
    if (bound.derived) {
      // Never silent: this run's history is being attributed to a file that
      // does not itself say which worktree wrote it.
      this.log(
        `the execution manifest ${bound.file} was written before manifests recorded which worktree they belong to. It is this run's: its executable content digests to the plan_digest the engine recorded, it contains the recorded current stage, and no other discovered plan run could claim it. Its stages are used, and nothing was written to reach that conclusion.`,
      );
    }
  }

  /**
   * Which managed plan run each standalone stage of the discovery belongs to.
   *
   * One answer for the whole window, so the Overview's wording, the run
   * picker's grouping and the diagnostic can never disagree about whether a
   * stage is history of a plan run or work of its own.
   */
  planMemberships(): Promise<Map<string, PlanMembership>> {
    return resolveMemberships(this.discovery.runs, (run) => this.manifestStagesFor(run));
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
  stageRepositories(planKey: string, projectDir: string): Record<string, DeclaredRepository[]> {
    return repositoriesForPlan(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, projectDir);
  }

  /** One stage's declarations. */
  stageRepositoriesFor(planKey: string, projectDir: string, label: string): DeclaredRepository[] {
    return repositoriesForStage(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, projectDir, label);
  }

  /** Declare (or re-declare, by name) a sibling repository this stage's candidate spans. No commit is recorded: the engine pins that at the freeze boundary. */
  async declareStageRepository(planKey: string, projectDir: string, label: string, repository: DeclaredRepository): Promise<void> {
    const next = withStageRepository(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, projectDir, label, repository);
    await this.context.workspaceState.update(STAGE_REPOSITORIES_KEY, next);
    this.log(
      `Stage ${label} in ${path.basename(path.resolve(projectDir))}: also reviews ${repository.name} on ${repository.branch} (${repository.path}); it goes into the execution manifest built for this worktree, and the engine pins and re-verifies its commit. Another worktree running the same plan is unaffected.`,
    );
    this.render();
  }

  async undeclareStageRepository(planKey: string, projectDir: string, label: string, name: string): Promise<void> {
    const next = withoutStageRepository(this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY), planKey, projectDir, label, name);
    await this.context.workspaceState.update(STAGE_REPOSITORIES_KEY, next);
    this.log(
      `Stage ${label} in ${path.basename(path.resolve(projectDir))}: no longer declares ${name}; already-recorded pins stay in the stage's state.json until the next run rewrites the declaration`,
    );
    this.render();
  }

  // ---------------------------------------------------------------- stage modes (declaration, emitted into the manifest)

  /**
   * Stages of one plan **in one worktree** declared review-only, keyed by
   * label (`5`). Workspace state; never written into engine state.
   *
   * `projectDir` is not optional and is not a detail: a plan key is shared by
   * every worktree running the same plan path, so without it this answers for
   * the wrong checkout (stageModes.ts).
   */
  stageModes(planKey: string, projectDir: string): Record<string, StageMode> {
    return modesForPlan(this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY), planKey, projectDir);
  }

  /** One stage's declared mode in one worktree; `implementation` when nothing was declared. */
  stageModeFor(planKey: string, projectDir: string, label: string): StageMode {
    return modeForStage(this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY), planKey, projectDir, label);
  }

  /**
   * Declare what kind of stage this is. It reaches the engine through the
   * execution manifest, never by writing engine state — and because the
   * engine folds a declared mode into the digest that identifies a recorded
   * run, changing it for a stage of a run already under way is something the
   * engine refuses to continue across until its `reset-stage` command
   * re-records that digest. Said here rather than left to be discovered.
   */
  async declareStageMode(planKey: string, projectDir: string, label: string, mode: StageMode): Promise<void> {
    const next = withStageMode(this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY), planKey, projectDir, label, mode);
    await this.context.workspaceState.update(STAGE_MODES_KEY, next);
    const where = path.basename(path.resolve(projectDir));
    this.log(
      mode === "independent_review"
        ? `Stage ${label} in ${where}: declared review-only; the execution manifest built for this worktree will carry mode=independent_review, so no implementation agent runs for it and a fresh reviewer inspects the accepted candidate set. Another worktree running the same plan is unaffected.`
        : `Stage ${label} in ${where}: back to the implementation lifecycle; the manifest carries no mode for it, which is the engine's default`,
    );
    this.render();
  }

  /**
   * Move declarations made before they were scoped to a worktree — a stage's
   * mode, and the sibling repositories its candidate spans — onto the
   * worktree they were made in.
   *
   * Run after every discovery rather than once at startup, because what makes
   * a legacy declaration attributable is a *discovered plan run* with that
   * plan key, and the folder holding it may only be opened later. A pass that
   * can attribute nothing writes nothing, so this is free when there is
   * nothing to do.
   *
   * Both kinds go through the same helper (declarationScope.ts) so they can
   * never disagree about which worktree a declaration belongs to.
   */
  private async migrateDeclarationScopes(): Promise<void> {
    const plans = this.discovery.runs.filter((run): run is PlanRunSnapshot => run.kind === "plan");
    const modes = this.context.workspaceState.get<StageModes>(STAGE_MODES_KEY);
    const repositories = this.context.workspaceState.get<StageRepositories>(STAGE_REPOSITORIES_KEY);
    let moved = false;
    if (modes && Object.keys(modes).length > 0) {
      moved = (await this.applyMigration("stage mode", STAGE_MODES_KEY, migrateStageModes(modes, plans))) || moved;
    }
    if (repositories && Object.keys(repositories).length > 0) {
      moved = (await this.applyMigration("sibling repository", STAGE_REPOSITORIES_KEY, migrateStageRepositories(repositories, plans))) || moved;
    }
    if (moved) {
      this.render();
    }
  }

  /** Store what could be attributed, and say once what could not. */
  private async applyMigration<V>(what: string, key: string, migration: DeclarationMigration<V>): Promise<boolean> {
    for (const entry of migration.ambiguous) {
      const reported = `${key} ${entry.planKey}:${entry.labels.join(",")}`;
      if (this.reportedAmbiguousDeclarations.has(reported)) {
        continue;
      }
      this.reportedAmbiguousDeclarations.add(reported);
      this.log(
        `a ${what} declaration made before declarations were scoped to a worktree (plan ${entry.planKey}, stage(s) ${entry.labels.join(", ")}) ${
          entry.candidates.length > 1
            ? `could belong to ${entry.candidates.length} discovered worktrees (${entry.candidates.join(", ")})`
            : "belongs to no plan run discovered in this window"
        }, so it is kept but not applied. Declare it again in the worktree you mean.`,
      );
    }
    if (migration.migrated.length === 0) {
      return false;
    }
    await this.context.workspaceState.update(key, migration.next);
    for (const entry of migration.migrated) {
      this.log(`${what} declaration for plan ${entry.planKey} (stage(s) ${entry.labels.join(", ")}) is now scoped to ${entry.projectDir}, the only worktree with a recorded run of it.`);
    }
    return true;
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

  /**
   * A command handed to a shell for this run whose start has not been
   * observed. Never a runner: it is what makes a second command for the same
   * run refuse, and it is asked for separately for exactly that reason.
   */
  pendingSubmissionFor(runId: string | undefined): PendingSubmission | undefined {
    return this.tracker.pendingFor(runId);
  }

  /** Every unresolved submission in this window. */
  pendingSubmissions(): PendingSubmission[] {
    return this.tracker.pendingSubmissions();
  }

  /** The person's decision to forget a submission, so the command may be given again. */
  discardPendingSubmission(runId: string): boolean {
    const discarded = this.tracker.discardPending(runId);
    if (discarded) {
      this.render();
    }
    return discarded;
  }

  /** The terminal hosting this run's live execution, by name (integration tests). */
  hostingTerminal(runId: string): string | undefined {
    return this.tracker.hostingTerminal(runId);
  }

  /**
   * The terminals in the pool and why each one may not be sent a command
   * (integration tests); `undefined` means its shell is idle and the next
   * engine command for that project would reuse it.
   */
  ownedTerminals(): { name: string; cwd: string; unavailable?: string }[] {
    return this.terminals.owned();
  }

  /** Live state as presented: turns a runner known to have ended cannot be executing are cleared. */
  get presentedLive(): LiveState | undefined {
    return this.currentLiveness.live;
  }

  get sparringLocations(): SparringLocation[] {
    return this.locations;
  }

  /**
   * Every repository a plan may be started in: this window's discovered
   * Agent Sparring projects, plus every repository and worktree the built-in
   * Git extension has open (launchRepositories.ts).
   *
   * The Git extension's API is what supplies a repository with no `.sparring`
   * yet, so it is awaited rather than merely read: this is a user-initiated
   * moment, and a window that started before the Git extension would
   * otherwise offer the incomplete list once and the complete list ever after.
   */
  async launchRepositories(): Promise<LaunchRepository[]> {
    await this.activeRepository.ready();
    if (!this.activeRepository.repositoriesKnown) {
      // Said out loud rather than shown as a short list: the repositories
      // that exist *only* in the Git extension's answer are precisely the
      // ones with no Agent Sparring state, which is the first-run case.
      this.log(`the repository list may be incomplete — ${describeReadiness(this.activeRepository.gitReadiness)}. Repositories with no .sparring directory yet cannot be offered.`);
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ path: folder.uri.fsPath, name: folder.name }));
    return launchRepositories(this.locations, this.activeRepository.knownRepoRoots, folders);
  }

  /** The run the user chose, when, and what choosing it meant (see selectRun). */
  private preference(): RunPreference | undefined {
    const id = this.context.workspaceState.get<string>(SELECTED_RUN_KEY);
    if (!id) {
      return undefined;
    }
    const stored = this.context.workspaceState.get<string>(PIN_INTENT_KEY);
    return {
      id,
      atMs: this.context.workspaceState.get<number>(SELECTED_AT_KEY),
      intent: stored === "follow" || stored === "inspect" ? stored : undefined,
    };
  }

  /**
   * Pin a run, recording what pinning it meant.
   *
   * The intent is taken from the run as it is *now*, because that is the only
   * moment it is knowable: a run that was open when it was chosen is being
   * followed, and one that was already finished is being inspected. By the
   * next refresh the first has often become the second, and nothing on disk
   * remembers which it was.
   */
  async chooseRun(run: RunSnapshot | undefined): Promise<void> {
    const intent = run ? intentForChoosing(run) : undefined;
    await this.context.workspaceState.update(SELECTED_RUN_KEY, run?.id);
    await this.context.workspaceState.update(SELECTED_AT_KEY, run ? Date.now() : undefined);
    await this.context.workspaceState.update(PIN_INTENT_KEY, intent);
    if (run) {
      this.log(
        intent === "inspect"
          ? `pinned to ${run.location.folderName} · ${runLabel(run)} for inspection; it stays on screen until you choose another run or ${FOLLOW_ACTIVE_LABEL}, whatever the plan it belongs to does next.`
          : `pinned to ${run.location.folderName} · ${runLabel(run)} while it runs; if the managed plan run that owns it moves on, the cockpit follows that plan. ${FOLLOW_ACTIVE_LABEL} to go back to automatic selection.`,
      );
    }
    await this.refresh();
  }

  /**
   * Forget a pin the selection has just let go of, so each release happens
   * once and in one direction.
   *
   * Leaving the stored pin in place made a release a condition rather than an
   * event: a `follow` pin handed over to its owning plan run came back the
   * instant that plan completed, because handing over needs an *open* owner.
   * Completing a plan then moved the screen to a stage from before the plan
   * started — a change nobody asked for, arriving at the least expected
   * moment. The remembered run is set to whatever is now on screen, so the
   * cockpit does not jump anywhere else either.
   */
  private async retireReleasedPin(released: NonNullable<RunSelection["released"]>): Promise<void> {
    await this.context.workspaceState.update(SELECTED_RUN_KEY, undefined);
    await this.context.workspaceState.update(SELECTED_AT_KEY, undefined);
    await this.context.workspaceState.update(PIN_INTENT_KEY, undefined);
    const stage = released.id.split("|").pop();
    this.log(
      released.reason === "superseded"
        ? `the pinned stage ${stage} was being followed while it ran, and the plan run that executed it has moved on to ${released.by.currentStage.stageId}; following that plan run. The stage is still in Select repository / run.`
        : `the pinned run ${stage} is no longer on disk in a project that was scanned; the pin is released and automatic selection applies.`,
    );
  }

  /**
   * Release the pin and go back to automatic selection in whichever
   * repository this window is in.
   *
   * This is the named way out of a pin, offered in the Overview and the run
   * picker, because a pin is otherwise indistinguishable from the cockpit
   * simply disagreeing with the Source Control view.
   */
  async followActiveRepository(): Promise<void> {
    const root = this.activeRepository.activeRepoRoot;
    this.log(root ? `following the active repository again: ${path.basename(root)}` : "following the active repository again; this window is in no repository the Git extension has opened");
    await this.chooseRun(undefined);
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
    const tailer = this.tailer;
    this.polling = true;
    try {
      const result = await tailer.poll();
      // Reading the log is I/O, and the selection can move while it is in
      // flight — following the active repository makes that ordinary rather
      // than rare. Events read from the run we have since left must not be
      // folded into the run now on screen, which would show one run's
      // provider activity under another run's name.
      if (this.tailer !== tailer) {
        return;
      }
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
