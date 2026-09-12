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
import { LogRenderer } from "../core/logFormat";
import { deriveStatus } from "../core/status";
import { ExecutionTracker, type LaunchOptions } from "./executionTracker";

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
  private reattached = false;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after every re-render: selection, authoritative state or live activity changed. */
  readonly onDidChange = this.changeEmitter.event;

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
    this.disposables.push(
      this.tracker,
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
  async launch(options: LaunchOptions): Promise<void> {
    await this.tracker.launch(options);
    // The engine writes its state before the first provider turn; pick it up promptly.
    setTimeout(() => void this.refresh(), 1500);
    setTimeout(() => void this.refresh(), 6000);
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
