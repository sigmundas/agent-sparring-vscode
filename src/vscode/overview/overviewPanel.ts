/**
 * One Run Overview WebviewPanel per window. Created only on explicit
 * request (status-bar click or command), never auto-opened; updated in
 * place whenever the controller reports a change; closing it affects
 * nothing but itself.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { BRIEF_FILENAME, HANDOFF_FILENAME, NOTES_FILENAME, SPARRING_FILENAME, STAGES_DIRNAME, STATE_FILENAME, currentStageOf, type PlanRunSnapshot, type RunSnapshot } from "../../core/discovery";
import { parseStageState, type StageStatus } from "../../core/engineFormats";
import { planRunDisplayName } from "../../core/planMembership";
import {
  isActionMessage,
  isCopyMessage,
  isCopyPromptMessage,
  isHumanCheckMessage,
  isHumanFeedbackMessage,
  isOpenPromptSourceMessage,
  renderOverviewHtml,
  type CopyMessage,
  type CopyPromptMessage,
  type HumanCheckMessage,
  type HumanFeedbackMessage,
  type OpenPromptSourceMessage,
  type OverviewAction,
} from "../../core/overviewHtml";
import { PROMPTS_DIRNAME, PROMPT_INDEX_FILENAME, latestCapture, parseCaptureIndex } from "../../core/promptInspector";
import { buildOverviewModel, type CapturedPrompt, type ManagedPlanRun, type ManifestStageView, type OverviewArtifacts, type OverviewModel, type PlanContinuation } from "../../core/overviewModel";
import { checkCopyText, reviewCopyText, type ReviewCopySource } from "../../core/reviewCopy";
import { locateStage, parsePlanHeadings, type HeadingRef } from "../../core/planAssociation";
import { planKey, planLabel } from "../../core/sparringCommand";
import type { DeclaredRepository } from "../../core/stageRepositories";
import { documentViewColumn } from "../../core/viewColumn";
import type { SparringController } from "../controller";
import { gitContext } from "../git";
import { readHead as readFileHead } from "../fileHead";

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
      } else if (isHumanFeedbackMessage(message)) {
        void this.recordHumanFeedback(message);
      } else if (isCopyMessage(message)) {
        void this.copyForChat(message);
      } else if (isOpenPromptSourceMessage(message)) {
        void this.openPromptSource(message);
      } else if (isCopyPromptMessage(message)) {
        void this.copyPrompt(message);
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
    // One message carries one control's value: a result click has no note, a
    // keystroke has no outcome. The absent half stays `undefined`, which
    // withHumanCheck reads as "not part of this change" — it must never be
    // filled in with a value, or one control would overwrite the other's.
    await this.controller.setHumanCheck(run.id, message.key, { outcome: message.outcome, note: message.note }, !noteOnly);
    if (noteOnly) {
      this.lastHtmlKey = JSON.stringify(await this.buildModel());
    }
  }

  /**
   * The freeform findings field, stored as a draft without re-rendering —
   * the textarea being typed in must not be replaced under the user's
   * cursor. The comparison key is advanced for the same reason it is for a
   * note: so the stored text alone does not make the next update rebuild the
   * document.
   *
   * Nothing is launched here. Sending the feedback is a separate, deliberate
   * click, and it is the only thing on this path that runs the engine.
   */
  private async recordHumanFeedback(message: HumanFeedbackMessage): Promise<void> {
    const run = this.controller.currentSelection.selected;
    if (!run) {
      return;
    }
    await this.controller.setHumanFeedback(run.id, message.text);
    this.lastHtmlKey = JSON.stringify(await this.buildModel());
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
    return (await this.gather()).model;
  }

  /**
   * The model, and the recorded prose it was built from.
   *
   * The Overview itself only ever shows derived facts, so the model is enough
   * for rendering; the copy-for-chat surface quotes the reviewer's and the
   * stage agent's own words, so it needs the texts too. Reading them once,
   * here, is what keeps the two surfaces describing the same run.
   */
  private async gather(): Promise<{ model: OverviewModel; source: ReviewCopySource }> {
    const selection = this.controller.currentSelection;
    let artifacts: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };
    let sparringText: string | undefined;
    let repository: string | undefined;
    if (selection.selected) {
      const run = selection.selected;
      repository = run.location.folderName;
      const stage = currentStageOf(run);
      const association = run.kind === "stage" ? this.controller.planAssociation(run.id) : undefined;
      const [handoffText, sparring, briefText, notesText, planText, associatedText] = await Promise.all([
        readHead(path.join(stage.dir, HANDOFF_FILENAME), HANDOFF_READ_LIMIT),
        readHead(path.join(stage.dir, SPARRING_FILENAME), SPARRING_READ_LIMIT),
        readHead(path.join(stage.dir, BRIEF_FILENAME)),
        readHead(path.join(stage.dir, NOTES_FILENAME), NOTES_READ_LIMIT),
        run.kind === "plan" ? readHead(run.planPath, PLAN_READ_LIMIT) : Promise.resolve(undefined),
        association ? readHead(association.path, PLAN_READ_LIMIT) : Promise.resolve(undefined),
      ]);
      sparringText = sparring;
      artifacts = {
        handoff: handoffText !== undefined,
        handoffText,
        sparring: sparring !== undefined,
        brief: briefText !== undefined,
        briefText,
        plan: planText !== undefined,
        planText,
        git: await gitContext(run.location.repoRoot),
        associatedPlan: association ? { path: association.path, exists: associatedText !== undefined, text: associatedText, manualMatch: association.match } : undefined,
        accepting: this.controller.isAccepting(run.id),
        humanChecks: this.controller.humanChecks(run.id),
        humanFeedback: this.controller.humanFeedback(run.id),
        submission: this.controller.submissionFor(run.id),
        notesText,
        capturedPrompts: await this.capturedPrompts(stage.dir),
        continuation: planContinuation(),
        siblingRepositories: this.siblingRepositories(run, run.kind === "plan" ? planText : associatedText, briefText, association?.match),
        manifestStages: await this.manifestStages(run),
        managedPlanRun: await this.managedPlanRun(run),
        existingStageIds: this.existingStageIds(run),
      };
    }
    const model = buildOverviewModel(selection, this.controller.currentLive, artifacts, Date.now(), this.controller.executionFor(selection.selected?.id));
    return { model, source: { model, artifacts, sparringText, repository } };
  }

  /**
   * Put the review — or one check of it — on the clipboard as Markdown.
   *
   * Nothing is launched and nothing is recorded: this is a read of what the
   * engine already wrote, arranged so it can be pasted somewhere and asked
   * about. The reader is told what landed on the clipboard, by name, because a
   * silent copy is indistinguishable from a dead button.
   */
  private async copyForChat(message: CopyMessage): Promise<void> {
    const { source } = await this.gather();
    if (!source.model.actionRequired) {
      void vscode.window.showInformationMessage("Agent Sparring: this stage is not waiting for you right now, so there is no review to copy.");
      return;
    }
    const text = message.scope === "check" && message.key !== undefined ? checkCopyText(source, message.key) : reviewCopyText(source);
    if (!text) {
      void vscode.window.showInformationMessage("Agent Sparring: that check is no longer part of this review; the panel has been refreshed.");
      await this.update();
      return;
    }
    await vscode.env.clipboard.writeText(text);
    const what = message.scope === "check" ? `Check ${message.key}` : `The review of ${source.model.plan?.current ?? source.model.stageHeading ?? "this stage"}`;
    void vscode.window.setStatusBarMessage(`Agent Sparring: ${what} copied as Markdown.`, 4000);
  }

  /**
   * Open the file a prompt section came from.
   *
   * The engine records a section's source relative to the project's
   * `.sparring` directory, so it is resolved against this run's own sparring
   * directory and then checked to be inside it. The message already had to
   * be relative and non-climbing to get here; this second check is what
   * survives symlinks and normalisation, and it is cheap.
   */
  private async openPromptSource(message: OpenPromptSourceMessage): Promise<void> {
    const run = this.controller.currentSelection.selected;
    if (!run) {
      return;
    }
    const root = path.resolve(run.location.sparringDir);
    const target = path.resolve(root, message.source);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document, { viewColumn: this.documentColumn, preview: true });
    } catch {
      void vscode.window.showInformationMessage(`Agent Sparring: could not open ${message.source}. It may have been removed since this prompt was captured.`);
    }
  }

  /**
   * The exact captured prompt on the clipboard.
   *
   * Taken from the model rather than re-read, so what is copied is what the
   * panel is showing. This is the one place the extension deliberately
   * exports a provider prompt: the review copy-for-chat surface still
   * excludes prompts entirely, because that artifact is the review, and this
   * one is the prompt.
   */
  private async copyPrompt(message: CopyPromptMessage): Promise<void> {
    const model = await this.buildModel();
    const card = message.role === "stage" ? model.stageAgent : model.sparrer;
    const prompt = card?.prompt;
    if (!prompt) {
      void vscode.window.showInformationMessage("Agent Sparring: there is no captured prompt for that actor yet.");
      return;
    }
    await vscode.env.clipboard.writeText(prompt.exact);
    void vscode.window.setStatusBarMessage(`Agent Sparring: ${card?.provider ?? message.role}'s ${prompt.turn.toLowerCase()} copied.`, 4000);
  }

  /** The whole review on the clipboard; the Command Palette entry point. Returns what was copied. */
  async copyReviewContext(): Promise<string | undefined> {
    const { source } = await this.gather();
    const text = reviewCopyText(source);
    if (!text) {
      void vscode.window.showInformationMessage("Agent Sparring: the selected stage is not waiting for a human, so there is no review to copy.");
      return undefined;
    }
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage("Agent Sparring: review copied as Markdown.", 4000);
    return text;
  }

  /**
   * The managed plan run this standalone stage is a stage of — the run that
   * adopted it and has since advanced past it, whether that run is still going
   * or is complete.
   *
   * One source, and it is recorded execution: membership (`planMembership.ts`),
   * which reads the execution manifest the extension wrote for that run —
   * bound to the run and validated against its recorded state before it counts
   * — or the run's own recorded stage list. It answers the identity question
   * outright: this stage id is that run's Stage 3D. It holds for a *finished*
   * run, which is the case that produced the reported confusion: a complete
   * plan whose historical stages still offered Continue plan automatically.
   *
   * There is deliberately **no fallback**. "Some open plan run in this project
   * has advanced" used to stand in for membership, and it is not membership at
   * all: it turned a stage that plan had never executed into a "Historical
   * stage", withdrew that stage's own actions in favour of a run that did not
   * own it, and offered "Back to plan run" as the way out. Without recorded
   * membership a standalone stage stays standalone, and no dead button
   * appears.
   */
  private async managedPlanRun(run: RunSnapshot): Promise<ManagedPlanRun | undefined> {
    if (run.kind !== "stage") {
      return undefined;
    }
    const membership = (await this.controller.planMemberships()).get(run.id);
    if (!membership) {
      return undefined;
    }
    const plan = this.controller.currentDiscovery.runs.find(
      (candidate): candidate is PlanRunSnapshot => candidate.kind === "plan" && candidate.id === membership.planRunId,
    );
    if (!plan) {
      return undefined;
    }
    const stages = await this.controller.manifestStagesFor(plan);
    return {
      runId: plan.id,
      planName: planRunDisplayName(plan),
      stageId: plan.currentStage.stageId,
      stageLabel: stages?.find((stage) => stage.stageId === plan.currentStage.stageId)?.label,
      status: plan.state.status,
      memberLabel: membership.stageLabel,
      memberTitle: membership.stageTitle,
    };
  }

  /** Every stage id the engine has created in this project, however it was created. */
  /**
   * The engine's captured prompts for this stage: the latest turn per role.
   *
   * Only two prompt files are read however many turns a stage has run — the
   * index names which ones are current, and the rest stay on disk for
   * whoever wants the history. Absent for a stage last run by an engine
   * without prompt capture, which is an ordinary state and reads as "no
   * instructions to show" rather than an error.
   */
  private async capturedPrompts(stageDir: string): Promise<CapturedPrompt[] | undefined> {
    const directory = path.join(stageDir, PROMPTS_DIRNAME);
    const index = parseCaptureIndex(await readHead(path.join(directory, PROMPT_INDEX_FILENAME), PROMPT_INDEX_READ_LIMIT));
    if (index.length === 0) {
      return undefined;
    }
    // Three roles, at most three files: a stage runs a stage agent and a
    // sparrer, or -- when it is a review-only stage -- an independent
    // reviewer and neither of the other two.
    const wanted = (["stage", "sparrer", "reviewer"] as const)
      .map((role) => latestCapture(index, role))
      .filter((entry) => entry !== undefined);
    const captured = await Promise.all(
      wanted.map(async (entry) => {
        const text = await readHead(path.join(directory, entry.file), PROMPT_READ_LIMIT);
        return text === undefined ? undefined : { entry, text };
      }),
    );
    const present = captured.filter((capture) => capture !== undefined);
    return present.length === 0 ? undefined : present;
  }

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
    const stages = await this.controller.manifestStagesFor(run);
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
/** sparring.md is read for its routing outcome, its gate and its findings; never past this many bytes. */
const SPARRING_READ_LIMIT = 256 * 1024;
/** A plan document is read for its headings and one opening paragraph only; never past this many bytes. */
const PLAN_READ_LIMIT = 512 * 1024;
/**
 * A captured prompt is bounded by what the engine assembles — brief,
 * PROJECT.md, sparring.md, handoff.md and the engine's own framing — so a
 * megabyte is generous. Truncation is safe either way: the view compares
 * the text's length against what the index recorded and declines to section
 * a prompt that no longer matches, rather than slicing the wrong offsets.
 */
const PROMPT_READ_LIMIT = 1024 * 1024;
const PROMPT_INDEX_READ_LIMIT = 1024 * 1024;

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

/** The beginning of a text file; a brief-sized cap by default (see fileHead.ts). */
function readHead(file: string, limit = BRIEF_READ_LIMIT): Promise<string | undefined> {
  return readFileHead(file, limit);
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
