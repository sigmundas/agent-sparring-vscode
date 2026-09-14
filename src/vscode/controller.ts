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
  type RunSelection,
  type RunSnapshot,
  type SparringLocation,
} from "../core/discovery";
import { deriveLiveness, type ExecutionRecord, type RunnerLiveness } from "../core/liveness";
import { applyEvent, emptyLiveState, type LiveState } from "../core/liveState";
import { HUMAN_CHECKS_KEY, humanChecksFor, withHumanCheck, withoutHumanChecks, type CheckRecord, type HumanCheckDrafts } from "../core/humanChecks";
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
import { deriveStatus } from "../core/status";
import { SparringCommandRunner, type RunCommandOptions, type RunCommandResult } from "./commandRunner";
import { ExecutionTracker, type CommandNotFound, type LaunchOptions, type LaunchResult } from "./executionTracker";

const SELECTED_RUN_KEY = "agentSparring.selectedRunId";
/** The run last shown, whether chosen explicitly or automatically; restores across reloads. */
const STICKY_RUN_KEY = "agentSparring.lastShownRunId";
const OUTPUT_CHANNEL_NAME = "Agent Sparring";

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
  private reattached = false;
  /** Run ids whose Accept stage operation from this window is still in flight. */
  private readonly accepting = new Set<string>();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after every re-render: selection, authoritative state or live activity changed. */
  readonly onDidChange = this.changeEmitter.event;
  /** A launch from this window ended because the shell could not find the command. */
  readonly onCommandNotFound: vscode.Event<CommandNotFound>;

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
    this.tracker = new ExecutionTracker(
      context,
      (message) => this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} ${message}`),
      () => this.locations,
    );
    this.onCommandNotFound = this.tracker.onCommandNotFound;
    this.commands = new SparringCommandRunner((message) => this.log(message));
    this.disposables.push(
      this.tracker,
      this.commands,
      // A runner ending may have left new authoritative files behind; a
      // start or liveness change only needs re-rendering.
      this.tracker.onDidChange((change) => (change === "ended" ? void this.refresh() : this.render())),
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
      void this.tracker.reattach();
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
      preferredId: this.context.workspaceState.get<string>(SELECTED_RUN_KEY),
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
    const preferred = this.context.workspaceState.get<string>(SELECTED_RUN_KEY);
    const sticky = this.attachedRunId ?? this.context.workspaceState.get<string>(STICKY_RUN_KEY);
    this.selection = selectRun(this.discovery.runs, preferred, sticky);
    if (this.selection.selected && this.selection.selected.id !== this.context.workspaceState.get<string>(STICKY_RUN_KEY)) {
      await this.context.workspaceState.update(STICKY_RUN_KEY, this.selection.selected.id);
    }
    await this.attachToSelected();
    this.render();
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

  /** Live state as presented: turns a runner known to have ended cannot be executing are cleared. */
  get presentedLive(): LiveState | undefined {
    return this.currentLiveness.live;
  }

  get sparringLocations(): SparringLocation[] {
    return this.locations;
  }

  async chooseRun(run: RunSnapshot | undefined): Promise<void> {
    await this.context.workspaceState.update(SELECTED_RUN_KEY, run?.id);
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
