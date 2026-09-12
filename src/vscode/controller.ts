/**
 * The extension shell: discovery + selection + tailing wired to one status
 * bar item and one Output Channel. Everything decision-like lives in
 * `../core`; this file only adapts it to the vscode API.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { ActivityTailer } from "../core/activityTailer";
import {
  activityPathFor,
  currentStageOf,
  discoverRuns,
  locateSparringDir,
  runLabel,
  selectRun,
  totalStagesOf,
  type Discovery,
  type RunSelection,
  type RunSnapshot,
  type SparringLocation,
} from "../core/discovery";
import { applyEvent, emptyLiveState, type LiveState } from "../core/liveState";
import { formatEvent } from "../core/logFormat";
import { deriveStatus } from "../core/status";

const SELECTED_RUN_KEY = "agentSparring.selectedRunId";
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
  private attachedRunId: string | undefined;

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

    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.start()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("agentSparring.pollIntervalMs")) {
          this.armPolling();
        }
      }),
    );
    this.renderInterval = setInterval(() => this.render(), 60_000);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.disposeWatchers();
    this.locations = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const location = await locateSparringDir(folder.uri.fsPath);
      if (location) {
        this.locations.push(location);
        this.watch(folder);
      }
    }
    this.statusBar.show();
    await this.refresh();
    this.armPolling();
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
    // the activity stream, never the whole workspace.
    const authoritative = [".sparring/plans/*.json", ".sparring/stages/*/state.json", ".sparring/stages/*/sparring.md"];
    for (const glob of authoritative) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, glob));
      const onChange = () => this.scheduleRefresh();
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      this.watcherDisposables.push(watcher);
    }
    const activity = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, ".sparring/stages/*/activity.jsonl"));
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
    this.discovery = await discoverRuns(this.locations);
    const preferred = this.context.workspaceState.get<string>(SELECTED_RUN_KEY);
    this.selection = selectRun(this.discovery.runs, preferred);
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
    this.live = emptyLiveState();
    this.attachedRunId = run.id;
    const stage = currentStageOf(run);
    const position = run.kind === "plan" ? `stage ${run.state.currentStageIndex + 1}/${totalStagesOf(run) ?? "?"}` : "stage";
    this.output.appendLine("");
    this.output.appendLine(`${now()}  ${"Extension".padEnd(15)} attached to ${runLabel(run)} · ${position} ${stage.stageId}`);
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
        this.output.appendLine(
          `${now()}  ${"Extension".padEnd(15)} ${result.exists ? "activity log recreated; replaying" : "activity log removed; live details unavailable"}`,
        );
      }
      if (result.events.length > 0) {
        const live = this.live ?? emptyLiveState();
        for (const event of result.events) {
          applyEvent(live, event);
          const line = formatEvent(event);
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
    const view = deriveStatus(this.selection, this.live, Date.now());
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
