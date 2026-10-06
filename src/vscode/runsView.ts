/**
 * The native "Runs" view: every discovered run, this repository's open work
 * first (core/runIndex.ts), each expandable into what the engine recorded —
 * stage, who acts next, the latest review outcome and what it is waiting on
 * (core/runSummary.ts).
 *
 * A renderer only. It reads the controller's discovery, and its one action,
 * Follow, goes through the same pin the run picker uses. Nothing here starts,
 * resumes or changes a run.
 */

import * as vscode from "vscode";
import type { RunSnapshot } from "../core/discovery";
import { buildRunIndex, type RunIndexEntry } from "../core/runIndex";
import { runFacts, runRowDescription, stagePositionText, type RunPhase, type RunSummary } from "../core/runSummary";
import type { SparringController } from "./controller";

export const RUNS_VIEW_ID = "agentSparring.runs";

type Node =
  | { type: "section"; id: string; label: string; entries: RunIndexEntry[]; description?: string }
  | { type: "run"; entry: RunIndexEntry }
  | { type: "fact"; parent: string; key: string; label: string; description: string; icon?: string }
  | { type: "older"; hidden: number }
  | { type: "fewer" };

const PHASE_ICONS: Record<RunPhase, vscode.ThemeIcon> = {
  running: new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue")),
  "needs-you": new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow")),
  paused: new vscode.ThemeIcon("debug-pause"),
  open: new vscode.ThemeIcon("circle-large-outline"),
  complete: new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green")),
};

function tooltip(summary: RunSummary): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${escapeMd(summary.title)}**\n\n`);
  md.appendMarkdown(`${escapeMd(summary.statusWord)}${summary.stage ? ` · ${escapeMd(stagePositionText(summary) ?? "")} — ${escapeMd(summary.stage.name)}` : ""}\n\n`);
  if (summary.gate) {
    md.appendMarkdown(`Waiting on: ${escapeMd(summary.gate.text)}\n\n`);
  }
  md.appendMarkdown("---\n\n");
  md.appendMarkdown(`Run \`${summary.runKey}\`${summary.planFile ? ` · plan \`${summary.planFile}\`` : ""}\n\n`);
  md.appendMarkdown(`Worktree \`${summary.repository.projectDir}\`${summary.repository.external ? " (not in this workspace)" : ""}`);
  return md;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

export class RunsViewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private showOlder = false;
  private view: vscode.TreeView<Node> | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  private signature = "";
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly controller: SparringController) {
    // The controller fires on every render, including each activity poll;
    // the tree only changes when discovery, the selection or the minute does.
    this.subscriptions.push(controller.onDidChange(() => this.scheduleRefresh()));
  }

  private scheduleRefresh(): void {
    const discovery = this.controller.currentDiscovery;
    const selection = this.controller.currentSelection;
    const next = [
      Math.floor(Date.now() / 60_000),
      selection.selected?.id ?? "",
      selection.scope?.repoRoot ?? "",
      ...discovery.runs.map((run) => {
        const outcome = run.kind === "plan" ? run.currentOutcome : run.outcome;
        const stage = run.kind === "plan" ? run.currentStage : run.stage;
        return [run.id, run.stateMtimeMs, run.location.external ? "external" : "", stage.state?.nextTurn, outcome?.action, outcome?.summary, outcome?.humanGate?.title].join("@");
      }),
    ].join("\n");
    if (next === this.signature || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.signature = next;
      this.refresh();
    }, 300);
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    this.refresh();
  }

  setShowOlder(showOlder: boolean): void {
    this.showOlder = showOlder;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
    this.updateBadge();
  }

  private async index() {
    const memberships = await this.controller.planMemberships();
    const scope = this.controller.currentSelection.scope;
    return buildRunIndex(this.controller.currentDiscovery.runs, {
      followedRoot: scope?.repoRoot,
      familyOf: (root) => this.controller.familyOf(root),
      memberships,
      showOlder: this.showOlder,
      keepIds: this.controller.currentSelection.selected ? [this.controller.currentSelection.selected.id] : [],
    });
  }

  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    void this.index().then((index) => {
      const waiting = [...index.open, ...index.other.flatMap((repository) => repository.entries)].filter((entry) => entry.summary.phase === "needs-you").length;
      if (this.view) {
        this.view.badge = waiting > 0 ? { value: waiting, tooltip: `${waiting} run${waiting === 1 ? "" : "s"} waiting for you` } : undefined;
      }
    });
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const index = await this.index();
      const roots: Node[] = [];
      if (index.open.length > 0) {
        roots.push({ type: "section", id: "open", label: "Open", entries: index.open });
      }
      if (index.recent.length > 0) {
        roots.push({ type: "section", id: "recent", label: "Recent", entries: index.recent });
      }
      for (const repository of index.other) {
        roots.push({ type: "section", id: `other:${repository.key}`, label: repository.name, description: "other repository", entries: repository.entries });
      }
      if (index.hidden > 0) {
        roots.push({ type: "older", hidden: index.hidden });
      } else if (this.showOlder) {
        roots.push({ type: "fewer" });
      }
      return roots;
    }
    if (node.type === "section") {
      return node.entries.map((entry) => ({ type: "run", entry }));
    }
    if (node.type === "run") {
      return runFacts(node.entry.summary).map((fact) => ({ type: "fact", parent: node.entry.summary.id, ...fact }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case "section": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.id}`;
        item.description = node.description;
        item.contextValue = "section";
        return item;
      }
      case "run": {
        const summary = node.entry.summary;
        const item = new vscode.TreeItem(summary.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `run:${summary.id}`;
        item.description = runRowDescription(summary, Date.now());
        item.tooltip = tooltip(summary);
        item.iconPath = PHASE_ICONS[summary.phase];
        const shown = this.controller.currentSelection.selected?.id === summary.id;
        item.contextValue = `run${summary.repository.external ? ".external" : ""}${shown ? ".shown" : ""}`;
        item.command = { command: "agentSparring.runs.follow", title: "Show in Overview", arguments: [node] };
        return item;
      }
      case "fact": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `fact:${node.parent}:${node.key}`;
        item.description = node.description;
        item.tooltip = `${node.label}: ${node.description}`;
        item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
        return item;
      }
      case "older": {
        const item = new vscode.TreeItem("Show older runs…", vscode.TreeItemCollapsibleState.None);
        item.id = "older";
        item.description = `${node.hidden} more`;
        item.command = { command: "agentSparring.runs.showOlder", title: "Show older runs" };
        return item;
      }
      case "fewer": {
        const item = new vscode.TreeItem("Show recent runs only", vscode.TreeItemCollapsibleState.None);
        item.id = "fewer";
        item.command = { command: "agentSparring.runs.showRecent", title: "Show recent runs only" };
        return item;
      }
    }
  }

  /** The run a view node names, looked up again in the current discovery so a stale node cannot pin a vanished run. */
  runOf(node: unknown): RunSnapshot | undefined {
    const id = (node as Node | undefined)?.type === "run" ? (node as { entry: RunIndexEntry }).entry.summary.id : undefined;
    return id ? this.controller.currentDiscovery.runs.find((run) => run.id === id) : undefined;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.changed.dispose();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}

export function registerRunsView(context: vscode.ExtensionContext, controller: SparringController, showOverview: () => Promise<void>): void {
  const provider = new RunsViewProvider(controller);
  const view = vscode.window.createTreeView(RUNS_VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  provider.attach(view);
  context.subscriptions.push(
    provider,
    view,
    vscode.commands.registerCommand("agentSparring.runs.follow", async (node: unknown) => {
      const run = provider.runOf(node);
      if (!run) {
        return;
      }
      if (controller.currentSelection.selected?.id !== run.id) {
        await controller.chooseRun(run, "explicit");
      }
      await showOverview();
    }),
    vscode.commands.registerCommand("agentSparring.runs.openWorktree", async (node: unknown) => {
      const run = provider.runOf(node);
      if (run) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(run.location.projectDir), { forceNewWindow: true });
      }
    }),
    vscode.commands.registerCommand("agentSparring.runs.copyRunId", async (node: unknown) => {
      const summary = (node as Node | undefined)?.type === "run" ? (node as { entry: RunIndexEntry }).entry.summary : undefined;
      if (summary) {
        await vscode.env.clipboard.writeText(summary.runKey);
      }
    }),
    vscode.commands.registerCommand("agentSparring.runs.refresh", () => controller.rediscoverWorktrees()),
    vscode.commands.registerCommand("agentSparring.runs.showOlder", () => provider.setShowOlder(true)),
    vscode.commands.registerCommand("agentSparring.runs.showRecent", () => provider.setShowOlder(false)),
  );
}
