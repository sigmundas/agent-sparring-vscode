/**
 * One Run Overview WebviewPanel per window. Created only on explicit
 * request (status-bar click or command), never auto-opened; updated in
 * place whenever the controller reports a change; closing it affects
 * nothing but itself.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { BRIEF_FILENAME, HANDOFF_FILENAME, SPARRING_FILENAME, currentStageOf } from "../../core/discovery";
import { renderOverviewHtml, type OverviewAction } from "../../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts, type OverviewModel } from "../../core/overviewModel";
import type { SparringController } from "../controller";

const VIEW_TYPE = "agentSparring.overview";

export class OverviewPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHtmlKey: string | undefined;

  constructor(
    private readonly controller: SparringController,
    private readonly onAction: (action: OverviewAction) => Promise<void>,
  ) {
    this.subscriptions.push(controller.onDidChange(() => this.scheduleUpdate()));
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      await this.update();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Agent Sparring", { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [],
      retainContextWhenHidden: false,
    });
    this.panel.iconPath = new vscode.ThemeIcon("debug-alt");
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.lastHtmlKey = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isActionMessage(message)) {
        void this.onAction(message.action);
      }
    });
    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible) {
        this.scheduleUpdate();
      }
    });
    await this.update();
  }

  private scheduleUpdate(): void {
    if (!this.panel || this.updateTimer) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update();
    }, 150);
  }

  async update(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const model = await this.buildModel();
    const key = JSON.stringify(model);
    if (key === this.lastHtmlKey) {
      return; // nothing visible changed; leave the document alone
    }
    this.lastHtmlKey = key;
    const nonce = crypto.randomBytes(16).toString("base64");
    this.panel.webview.html = renderOverviewHtml(model, nonce, this.panel.webview.cspSource);
    this.panel.title = model.kind === "run" ? `Agent Sparring — ${path.basename(model.title)}` : "Agent Sparring";
  }

  async buildModel(): Promise<OverviewModel> {
    const selection = this.controller.currentSelection;
    let artifacts: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };
    if (selection.selected) {
      const stage = currentStageOf(selection.selected);
      const [handoff, sparring, brief, plan] = await Promise.all([
        exists(path.join(stage.dir, HANDOFF_FILENAME)),
        exists(path.join(stage.dir, SPARRING_FILENAME)),
        exists(path.join(stage.dir, BRIEF_FILENAME)),
        selection.selected.kind === "plan" ? exists(selection.selected.planPath) : Promise.resolve(false),
      ]);
      artifacts = { handoff, sparring, brief, plan };
    }
    return buildOverviewModel(selection, this.controller.currentLive, artifacts, Date.now());
  }

  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.panel?.dispose();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
}

const ACTIONS: ReadonlySet<string> = new Set<OverviewAction>(["openHandoff", "openSparring", "openBrief", "openPlan", "openDiff", "showLog", "selectRun", "runPlan"]);

function isActionMessage(message: unknown): message is { type: "action"; action: OverviewAction } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as Record<string, unknown>)["type"] === "action" &&
    ACTIONS.has(String((message as Record<string, unknown>)["action"]))
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
