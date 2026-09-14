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
import { BRIEF_FILENAME, HANDOFF_FILENAME, NOTES_FILENAME, SPARRING_FILENAME, currentStageOf } from "../../core/discovery";
import { CHECK_OUTCOMES } from "../../core/humanChecks";
import { OVERVIEW_ACTIONS, renderOverviewHtml, type HumanCheckMessage, type OverviewAction } from "../../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts, type OverviewModel, type PlanContinuation } from "../../core/overviewModel";
import { documentViewColumn } from "../../core/viewColumn";
import type { SparringController } from "../controller";
import { gitContext } from "../git";

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
      } else if (isHumanCheckMessage(message)) {
        void this.recordHumanCheck(message);
      }
    });
    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.viewColumn !== undefined) {
        this.lastColumn = event.webviewPanel.viewColumn;
      }
      if (event.webviewPanel.visible) {
        this.scheduleUpdate();
      }
    });
    if (this.panel.viewColumn !== undefined) {
      this.lastColumn = this.panel.viewColumn;
    }
    await this.update();
  }

  private lastColumn: vscode.ViewColumn | undefined;

  /**
   * A Pass / Fail / Blocked click re-renders (the choice lights up); a note
   * keystroke is stored without re-rendering, or the textarea being typed
   * in would be replaced under the user's cursor. The key the next update
   * compares against is advanced so the stored note alone triggers nothing.
   */
  private async recordHumanCheck(message: HumanCheckMessage): Promise<void> {
    const run = this.controller.currentSelection.selected;
    if (!run) {
      return;
    }
    const noteOnly = message.outcome === undefined;
    await this.controller.setHumanCheck(run.id, message.key, { outcome: message.outcome, note: message.note }, !noteOnly);
    if (noteOnly) {
      this.lastHtmlKey = JSON.stringify(await this.buildModel());
    }
  }

  /**
   * The editor group the Overview lives in (current when visible, else the
   * last one it was seen in), so document actions open beside its tab and
   * follow it when it is moved.
   */
  get documentColumn(): vscode.ViewColumn {
    return documentViewColumn(this.panel?.viewColumn, this.lastColumn, vscode.window.activeTextEditor?.viewColumn) as vscode.ViewColumn;
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
      const run = selection.selected;
      const stage = currentStageOf(run);
      const association = run.kind === "stage" ? this.controller.planAssociation(run.id) : undefined;
      const [handoffText, sparring, briefText, notesText, planText, associatedText] = await Promise.all([
        readHead(path.join(stage.dir, HANDOFF_FILENAME), HANDOFF_READ_LIMIT),
        exists(path.join(stage.dir, SPARRING_FILENAME)),
        readHead(path.join(stage.dir, BRIEF_FILENAME)),
        readHead(path.join(stage.dir, NOTES_FILENAME), NOTES_READ_LIMIT),
        run.kind === "plan" ? readHead(run.planPath, PLAN_READ_LIMIT) : Promise.resolve(undefined),
        association ? readHead(association.path, PLAN_READ_LIMIT) : Promise.resolve(undefined),
      ]);
      artifacts = {
        handoff: handoffText !== undefined,
        handoffText,
        sparring,
        brief: briefText !== undefined,
        briefText,
        plan: planText !== undefined,
        planText,
        git: await gitContext(run.location.repoRoot),
        associatedPlan: association ? { path: association.path, exists: associatedText !== undefined, text: associatedText, manualMatch: association.match } : undefined,
        accepting: this.controller.isAccepting(run.id),
        humanChecks: this.controller.humanChecks(run.id),
        notesText,
        continuation: planContinuation(),
      };
    }
    return buildOverviewModel(selection, this.controller.currentLive, artifacts, Date.now(), this.controller.executionFor(selection.selected?.id));
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

const ACTIONS: ReadonlySet<string> = new Set<OverviewAction>(OVERVIEW_ACTIONS);

function isActionMessage(message: unknown): message is { type: "action"; action: OverviewAction } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as Record<string, unknown>)["type"] === "action" &&
    ACTIONS.has(String((message as Record<string, unknown>)["action"]))
  );
}

function isHumanCheckMessage(message: unknown): message is HumanCheckMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (record["type"] !== "humanCheck" || typeof record["key"] !== "string" || !/^[0-9a-f]{1,16}$/.test(record["key"])) {
    return false;
  }
  const outcome = record["outcome"];
  const note = record["note"];
  const outcomeOk = outcome === undefined || outcome === null || (CHECK_OUTCOMES as readonly string[]).includes(String(outcome));
  const noteOk = note === undefined || note === null || (typeof note === "string" && note.length <= 20_000);
  return outcomeOk && noteOk && (outcome != null || note != null);
}

/** Only the Goal paragraph is ever displayed; a brief is never read past this many bytes. */
const BRIEF_READ_LIMIT = 64 * 1024;
/** handoff.md is read for its ## Git context branch only; never past this many bytes. */
const HANDOFF_READ_LIMIT = 256 * 1024;
/** notes.md is read for its ## Human evidence section only; never past this many bytes. */
const NOTES_READ_LIMIT = 256 * 1024;
/** A plan document is read for its headings and one opening paragraph only; never past this many bytes. */
const PLAN_READ_LIMIT = 512 * 1024;

/** The beginning of a text file, or undefined when it does not exist / cannot be read. */
async function readHead(file: string, limit = BRIEF_READ_LIMIT): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
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
 * The user's plan-progression mode. `automatic` is the default: a plan
 * belongs to the engine's managed run, which continues from stage to stage
 * on its own and stops when it needs a human. `manual` keeps the explicit
 * per-stage checkpoints for people who want them.
 */
function planContinuation(): PlanContinuation {
  const configured = vscode.workspace.getConfiguration("agentSparring").get<string>("planContinuation", "automatic");
  return configured === "manual" ? "manual" : "automatic";
}
