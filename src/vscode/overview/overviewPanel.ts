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
import { BRIEF_FILENAME, HANDOFF_FILENAME, NOTES_FILENAME, SPARRING_FILENAME, STAGES_DIRNAME, STATE_FILENAME, currentStageOf, supersedingPlanRun, type RunSnapshot } from "../../core/discovery";
import { parseStageState, type StageStatus } from "../../core/engineFormats";
import { manifestFileName, readManifestStages } from "../../core/manifest";
import { isActionMessage, isHumanCheckMessage, renderOverviewHtml, type HumanCheckMessage, type OverviewAction } from "../../core/overviewHtml";
import { buildOverviewModel, type ActivePlanRun, type ManifestStageView, type OverviewArtifacts, type OverviewModel, type PlanContinuation } from "../../core/overviewModel";
import { locateStage, parsePlanHeadings, type HeadingRef } from "../../core/planAssociation";
import { planKey, planLabel } from "../../core/sparringCommand";
import type { DeclaredRepository } from "../../core/stageRepositories";
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
        siblingRepositories: this.siblingRepositories(run, run.kind === "plan" ? planText : associatedText, briefText, association?.match),
        manifestStages: await this.manifestStages(run),
        activePlanRun: await this.activePlanRun(run),
        existingStageIds: this.existingStageIds(run),
      };
    }
    return buildOverviewModel(selection, this.controller.currentLive, artifacts, Date.now(), this.controller.executionFor(selection.selected?.id));
  }

  /**
   * The managed plan run in progress in this project while a standalone
   * stage is on screen — the run that adopted this stage and has advanced
   * past it. Selection already follows such a run on its own
   * (`supersedingPlanRun`); this is for the case where the user is looking
   * at the finished stage deliberately, so the screen can say where the work
   * is instead of offering to sequence a stage the engine owns.
   */
  private async activePlanRun(run: RunSnapshot): Promise<ActivePlanRun | undefined> {
    const plan = supersedingPlanRun(run, this.controller.currentDiscovery.runs);
    if (!plan) {
      return undefined;
    }
    const stages = await this.manifestStages(plan);
    return {
      runId: plan.id,
      planName: planLabel(plan.planPath, plan.location.repoRoot),
      stageId: plan.currentStage.stageId,
      stageLabel: stages?.find((stage) => stage.stageId === plan.currentStage.stageId)?.label,
      status: plan.state.status,
    };
  }

  /** Every stage id the engine has created in this project, however it was created. */
  private existingStageIds(run: RunSnapshot): string[] {
    const ids = new Set<string>();
    for (const other of this.controller.currentDiscovery.runs) {
      if (other.location.projectDir !== run.location.projectDir) {
        continue;
      }
      if (other.kind === "plan") {
        ids.add(other.currentStage.stageId);
        for (const stage of other.stages) {
          if (stage.state) {
            ids.add(stage.stageId);
          }
        }
      } else {
        ids.add(other.stage.stageId);
      }
    }
    return [...ids];
  }

  /**
   * The stages of the manifest this managed run executes, each with the
   * status the engine recorded for it.
   *
   * The extension wrote that manifest, deterministically, from the plan the
   * run names; reading it back is what lets the Overview call the current
   * stage `Stage 3D` instead of "the sixth entry", and draw the journey a
   * manifest run otherwise cannot have. Every status is still the stage's own
   * `state.json` — nothing here is inferred from the manifest's order.
   */
  private async manifestStages(run: RunSnapshot): Promise<ManifestStageView[] | undefined> {
    if (run.kind !== "plan" || run.state.source !== "manifest") {
      return undefined;
    }
    const file = path.join(this.controller.manifestDirectoryPath, manifestFileName(run.planKey));
    const stages = readManifestStages(await readHead(file, MANIFEST_READ_LIMIT));
    if (!stages) {
      return undefined;
    }
    return Promise.all(
      stages.map(async (stage) => ({
        ...stage,
        status: await recordedStatus(path.join(run.location.sparringDir, STAGES_DIRNAME, stage.stageId, STATE_FILENAME)),
      })),
    );
  }

  /**
   * The sibling repositories declared for *this* stage. Declarations are
   * kept per plan and stage label, so the stage has to be located in its
   * plan the same way everything else locates it; when it cannot be located
   * unambiguously, nothing is shown rather than another stage's declaration.
   */
  private siblingRepositories(run: RunSnapshot, markdown: string | undefined, briefText: string | undefined, manual: HeadingRef | undefined): DeclaredRepository[] {
    if (!markdown) {
      return [];
    }
    const key = run.kind === "plan" ? run.planKey : planKey(planLabel(this.controller.associatedPlan(run.id) ?? "", run.location.repoRoot));
    const stage = currentStageOf(run);
    const label = locateStage(parsePlanHeadings(markdown), { stageId: stage.stageId, title: stage.title, briefText, manual })?.stage?.label;
    return label ? this.controller.stageRepositoriesFor(key, label) : [];
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


/** Only the Goal paragraph is ever displayed; a brief is never read past this many bytes. */
const BRIEF_READ_LIMIT = 64 * 1024;
/** handoff.md is read for its ## Git context branch only; never past this many bytes. */
const HANDOFF_READ_LIMIT = 256 * 1024;
/** notes.md is read for its ## Human evidence section only; never past this many bytes. */
const NOTES_READ_LIMIT = 256 * 1024;
/** A plan document is read for its headings and one opening paragraph only; never past this many bytes. */
const PLAN_READ_LIMIT = 512 * 1024;
/** A manifest carries every stage's brief verbatim, so it is the largest of them; only its stage identities are read. */
const MANIFEST_READ_LIMIT = 4 * 1024 * 1024;

/** A stage's recorded status, or undefined when it has none the engine wrote. */
async function recordedStatus(stateFile: string): Promise<StageStatus | undefined> {
  const text = await readHead(stateFile, STATE_READ_LIMIT);
  if (text === undefined) {
    return undefined;
  }
  try {
    return parseStageState(text).status;
  } catch {
    return undefined;
  }
}

/** state.json is a handful of fields; never read past this many bytes. */
const STATE_READ_LIMIT = 64 * 1024;

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
