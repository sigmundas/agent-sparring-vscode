/**
 * Pure HTML renderer for the Run Overview webview. Every dynamic string is
 * escaped; no filesystem paths, session ids beyond their shortened form, or
 * secrets are placed in the document. The only script is a nonce'd
 * click-to-postMessage shim for the action buttons.
 *
 * Icons are small inline SVGs (the CSP allows no remote images or fonts) and
 * every colour is a VS Code theme variable, so the page follows the user's
 * theme. No provider logos: providers get a lettered avatar.
 *
 * Layout: header with status pills; plan journey; the current-stage card
 * (Goal + latest sparring result on the left, current activity + last
 * meaningful event on the right); provider cards; recent events; metadata.
 */

import { ACTIVE_CONTEXT_HEADLINE, FOLLOW_ACTIVE_LABEL, SELECT_RUN_LABEL } from "./activeRepository";
import { CHECK_OUTCOMES, isCheckKey, type CheckItem, type CheckOutcome } from "./humanChecks";
import { checkName, humanTask, splitPassCriteria } from "./humanTask";
import { RUN_KIND, TIMELINE_STATE_WORD, type ActionRequired, type BranchGuard, type ActorCard, type HistoryEntry, type OverviewModel, type PushAuthorization, type TimelineItem, type WhatsNext } from "./overviewModel";
import type { MatchSource } from "./planAssociation";
import type { PromptView, PromptViewSection } from "./promptInspector";
import type { StageRunAction } from "./runner";

export type OverviewAction =
  | "openHandoff"
  | "openSparring"
  | "openBrief"
  | "openPlan"
  | "openNextStage"
  | "openDiff"
  | "showLog"
  | "selectRun"
  | "followActiveRepository"
  | "runPlan"
  | "resumePlan"
  | "runStage"
  | "acceptStage"
  | "associatePlan"
  | "matchStage"
  | "reviewStageMatches"
  | "clearMatch"
  | "startNextStage"
  | "continueAutomatically"
  | "openPlanRun"
  | "stopRunner"
  | "openPlanSection"
  | "submitForReview"
  | "sendFeedbackForReview"
  | "dismissSubmissionFailure"
  | "confirmRunnerInactive"
  | "allowPush"
  | "doNotAllowPush";

/** A Pass / Fail / Can't test click or a note edit on one manual check, posted by the webview as it happens. */
export interface HumanCheckMessage {
  type: "humanCheck";
  key: string;
  outcome?: CheckOutcome;
  note?: string;
}

/**
 * The freeform findings field, posted as it is typed.
 *
 * It carries no key on purpose: there is one such field per review, and it
 * belongs to no check. A message that arrived with a check key would be a
 * check note, which is a different thing entirely — so the two never share a
 * payload shape and cannot be confused for one another on either side of the
 * wire. Empty text is valid: clearing the field clears the draft.
 */
export interface HumanFeedbackMessage {
  type: "humanFeedback";
  text: string;
}

/**
 * The auto-push toggle, posted when it is ticked or unticked.
 *
 * It carries an intention, not a decision: nothing is authorized and no
 * command runs until Allow push is pressed. It is its own message type
 * rather than an action so the host cannot confuse "the person changed a
 * checkbox" with "the person granted a permission" — the two do very
 * different things and must not share a payload.
 */
export interface AutoPushMessage {
  type: "autoPush";
  enabled: boolean;
}

export function isAutoPushMessage(message: unknown): message is AutoPushMessage {
  const record = asRecord(message);
  return record !== undefined && record["type"] === "autoPush" && typeof record["enabled"] === "boolean";
}

/** An action button click, posted by the webview. */
export interface ActionMessage {
  type: "action";
  action: OverviewAction;
}

/**
 * A "copy for chat" click: the whole review, or one check of it.
 *
 * It is not an {@link ActionMessage} because a check-scoped copy carries the
 * check's key, and an action carries nothing — widening the action payload so
 * that one button could smuggle a key through it is how a guard stops guarding
 * anything. The key's shape is the one definition {@link isCheckKey} owns, the
 * same as for a Pass / Fail / Can't test click.
 */
export interface CopyMessage {
  type: "copy";
  scope: "review" | "check";
  /** The check to copy; present (and required) for scope `check`. */
  key?: string;
}

export function isCopyMessage(message: unknown): message is CopyMessage {
  const record = asRecord(message);
  if (!record || record["type"] !== "copy") {
    return false;
  }
  if (record["scope"] === "review") {
    return record["key"] === undefined || record["key"] === null;
  }
  return record["scope"] === "check" && isCheckKey(record["key"]);
}

export interface OpenPromptSourceMessage {
  type: "openPromptSource";
  /** A path relative to the project's `.sparring` directory, as the engine recorded it. */
  source: string;
}

/**
 * A request to open the file one prompt section came from.
 *
 * The path is a webview message, so it is untrusted: it must be relative,
 * must not climb, and must not be absolute. The host resolves it against
 * the run's own sparring directory, and these checks are what stop a
 * crafted message from naming somewhere else entirely.
 */
export function isOpenPromptSourceMessage(message: unknown): message is OpenPromptSourceMessage {
  const record = asRecord(message);
  if (!record || record["type"] !== "openPromptSource" || typeof record["source"] !== "string") {
    return false;
  }
  const source = record["source"] as string;
  if (!source || source.length > 512 || source.startsWith("/") || source.startsWith("\\") || /^[A-Za-z]:/.test(source)) {
    return false;
  }
  return !source.split(/[\\/]/).some((part) => part === ".." || part === "");
}

export interface CopyPromptMessage {
  type: "copyPrompt";
  role: "stage" | "sparrer";
}

export function isCopyPromptMessage(message: unknown): message is CopyPromptMessage {
  const record = asRecord(message);
  return record !== undefined && record["type"] === "copyPrompt" && (record["role"] === "stage" || record["role"] === "sparrer");
}

/**
 * Reading a message the webview posted.
 *
 * These live beside {@link SCRIPT}, which is the only thing that produces
 * them, because the two ends of that wire have to agree about the payload
 * and nothing else in the extension can check that they do. They were on the
 * host side, where the key was tested against the shape of a *derived*
 * check's hash — so every message a structured gate's control sent was
 * dropped before it reached the draft state, and the buttons did nothing at
 * all. A webview message is still untrusted input: what is loosened here is
 * only the key's shape, to the one definition the renderer also uses.
 */
export function isActionMessage(message: unknown): message is ActionMessage {
  const record = asRecord(message);
  return record !== undefined && record["type"] === "action" && ACTIONS.has(String(record["action"]));
}

export function isHumanCheckMessage(message: unknown): message is HumanCheckMessage {
  const record = asRecord(message);
  if (!record || record["type"] !== "humanCheck" || !isCheckKey(record["key"])) {
    return false;
  }
  const outcome = record["outcome"];
  const note = record["note"];
  const outcomeOk = outcome === undefined || outcome === null || (CHECK_OUTCOMES as readonly string[]).includes(String(outcome));
  const noteOk = note === undefined || note === null || (typeof note === "string" && note.length <= NOTE_MAX_LENGTH);
  return outcomeOk && noteOk && (outcome != null || note != null);
}

export function isHumanFeedbackMessage(message: unknown): message is HumanFeedbackMessage {
  const record = asRecord(message);
  return record !== undefined && record["type"] === "humanFeedback" && typeof record["text"] === "string" && (record["text"] as string).length <= NOTE_MAX_LENGTH;
}

/** A note is free text a person typed; long enough for evidence, bounded so a message cannot be a payload. */
export const NOTE_MAX_LENGTH = 20_000;

function asRecord(message: unknown): Record<string, unknown> | undefined {
  return typeof message === "object" && message !== null ? (message as Record<string, unknown>) : undefined;
}

export const OVERVIEW_ACTIONS: readonly OverviewAction[] = [
  "openHandoff",
  "openSparring",
  "openBrief",
  "openPlan",
  "openNextStage",
  "openDiff",
  "showLog",
  "selectRun",
  "followActiveRepository",
  "runPlan",
  "resumePlan",
  "runStage",
  "acceptStage",
  "associatePlan",
  "matchStage",
  "reviewStageMatches",
  "clearMatch",
  "startNextStage",
  "continueAutomatically",
  "openPlanRun",
  "stopRunner",
  "openPlanSection",
  "submitForReview",
  "sendFeedbackForReview",
  "dismissSubmissionFailure",
  "confirmRunnerInactive",
  "allowPush",
  "doNotAllowPush",
];

const ACTIONS: ReadonlySet<string> = new Set<string>(OVERVIEW_ACTIONS);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

export function renderOverviewHtml(model: OverviewModel, nonce: string, cspSource: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Sparring</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${renderBody(model)}
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- icons

const ICON: Record<string, string> = {
  check: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  target:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1" fill="currentColor"/>',
  pulse: '<path d="M1 8h3l2-5 3 10 2-5h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  doc: '<path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 8h4M6 10.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  warn: '<path d="M8 2l6.5 11.5H1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.9" fill="currentColor"/>',
  chat: '<path d="M2.5 3h11v7.5H8L4.5 13.5v-3h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  history: '<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  dot: '<circle cx="8" cy="8" r="3.2" fill="currentColor"/>',
  arrow: '<path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  pause: '<path d="M5.5 4.5v7M10.5 4.5v7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  lock: '<rect x="3.5" y="7" width="9" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  pin: '<path d="M6 1.5h4l-.6 4 2.1 2.4H4.5L6.6 5.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 7.9v6.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};

function icon(name: keyof typeof ICON, cls = ""): string {
  return `<svg class="icon ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICON[name]}</svg>`;
}

// ---------------------------------------------------------------- body

function renderBody(model: OverviewModel): string {
  if (model.kind === "empty") {
    // The title names the repository, so an empty screen cannot be mistaken
    // for the cockpit still looking at the repository just left behind.
    return `${renderRepositoryContext(model)}
<header class="top"><div><h1>Agent Sparring</h1><div class="run muted">${escapeHtml(model.title)}</div></div></header>
${(model.emptyLines ?? []).map((line) => `<p class="muted">${escapeHtml(line)}</p>`).join("\n")}
<div class="actions">${button("runPlan", "Run plan…")}${button("showLog", "Show log")}</div>`;
  }
  if (model.kind === "ambiguous") {
    return `${renderRepositoryContext(model)}
<header class="top"><h1>Agent Sparring</h1></header>
<p>${escapeHtml(model.title)}:</p>
<ul>${(model.choices ?? []).map((choice) => `<li>${escapeHtml(choice)}</li>`).join("")}</ul>
<div class="actions">${button("showLog", "Show log")}</div>`;
  }

  const parts: string[] = [];
  parts.push(renderRepositoryContext(model));
  parts.push(renderHeader(model));
  if (model.branchGuard) {
    parts.push(renderBranchGuard(model.branchGuard));
  }
  if (model.autoPushEnabled) {
    // Quiet, above the panels, and read from the engine's own run state — so
    // it is still here after a reload, which is the whole point of the
    // choice living there rather than in this window.
    parts.push(`<p class="autopush" title="${escapeHtml(model.autoPushEnabled.detail)}">${icon("check", "good")}${escapeHtml(model.autoPushEnabled.label)}</p>`);
  }
  if (model.pushAuthorization) {
    parts.push(renderPushAuthorization(model.pushAuthorization));
  } else if (model.actionRequired) {
    parts.push(renderActionRequired(model, model.actionRequired));
  } else if (model.banner) {
    parts.push(`<div class="banner ${model.banner.kind}">${escapeHtml(model.banner.text)}</div>`);
  }
  if (model.timeline && model.timeline.length > 0) {
    parts.push(renderJourney(model.timeline));
  } else if (model.timelineNote) {
    parts.push(`<p class="muted note">${escapeHtml(model.timelineNote)}</p>`);
  }
  parts.push(renderStageCard(model));
  if (model.stageAgent && model.sparrer) {
    parts.push(`<section class="actors">${renderActor(model.stageAgent)}${renderActor(model.sparrer)}</section>`);
  }
  if (model.history && model.history.length > 0) {
    const rows = model.history
      .map((entry) => `<li><span class="time">${escapeHtml(entry.time)}</span><span class="who ${whoClass(entry.who)}">${escapeHtml(entry.who)}</span><span>${escapeHtml(entry.description)}</span></li>`)
      .join("");
    parts.push(`<section class="history"><h3>${icon("history")}Recent events</h3><ol>${rows}</ol></section>`);
  }
  if (model.facts && model.facts.length > 0) {
    parts.push(`<dl class="facts">${model.facts.map((fact) => `<dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd>`).join("")}</dl>`);
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * Which repository Agent Sparring is in, at the top of the screen, before
 * anything about the run.
 *
 * This is the contract made visible. VS Code's own repository selector in the
 * status bar cannot be read by an extension, so what the cockpit resolved has
 * to be stated rather than assumed — a person must never be able to think it
 * silently followed a selector it cannot see. Two shapes:
 *
 *  - following: one line, `Following repository: <name>`;
 *  - pinned: the pinned repository *and* the repository this window is in,
 *    on separate lines, with Follow active repository next to them. Both names
 *    appear even when they are the same, so the policy reads the same way
 *    every time and a pin never hides where the window actually is.
 *
 * Agent Sparring's own chooser sits here too. Switching context must not
 * depend on a VS Code gesture this extension cannot observe, so the way to do
 * it is where the person already is rather than only in the Command Palette.
 */
function renderRepositoryContext(model: OverviewModel): string {
  const context = model.repositoryContext;
  if (!context) {
    return "";
  }
  const pinned = context.mode === "pinned";
  const lines = [contextLine(context.headline, context.repository, pinned)];
  if (pinned && context.activeRepository) {
    lines.push(contextLine(ACTIVE_CONTEXT_HEADLINE, context.activeRepository, false));
  }
  const controls = [
    button("selectRun", SELECT_RUN_LABEL, true, "Pin an Agent Sparring repository or run explicitly", "quiet"),
    pinned ? button("followActiveRepository", FOLLOW_ACTIVE_LABEL, true, context.explanation) : "",
  ].join("");
  return `<section class="repocontext${pinned ? " pinned" : ""}${context.away ? " away" : ""}" title="${escapeHtml(context.explanation)}">
<div class="names">${lines.join("")}</div>
<div class="actions">${controls}</div>
</section>`;
}

function contextLine(headline: string, repository: string | undefined, pinned: boolean): string {
  const name = repository ?? "not resolved";
  return `<div class="line"><span class="headline">${pinned ? icon("pin", "pin") : ""}${escapeHtml(headline)}:</span><span class="name">${escapeHtml(name)}</span></div>`;
}

function renderHeader(model: OverviewModel): string {
  const pills: string[] = [];
  if (model.runKind) {
    // The kind pill is the first thing read, and the three kinds must not look
    // alike: a historical stage is toned down and says, in the pill itself,
    // that the whole job lives elsewhere.
    const historical = model.runKind === RUN_KIND.historicalStage;
    const explain = historical
      ? "One finished stage of a managed plan run, shown on its own. Back to plan run shows the whole job and its timeline."
      : model.runKind === RUN_KIND.plan
        ? "The whole job: the engine sequences its stages and records where it is."
        : "A stage that was run on its own; no managed plan run claims it.";
    pills.push(`<span class="hpill${historical ? " history" : ""}" title="${escapeHtml(explain)}">${escapeHtml(model.runKind)}</span>`);
  }
  if (model.stageLabel) {
    // What a person calls this stage. Where it sits in the run is secondary
    // metadata, on the stage card and in this pill's tooltip.
    pills.push(`<span class="hpill" title="${escapeHtml(model.position ?? "")}">${escapeHtml(model.stageLabel)}</span>`);
  } else if (model.position) {
    pills.push(`<span class="hpill">${escapeHtml(model.position.replace(/^Stage (\d+) of (\d+)$/, "Stage $1 / $2"))}</span>`);
  }
  if (model.status) {
    pills.push(`<span class="hpill ${model.status.tone}">${icon("dot", "dot")}${escapeHtml(model.status.label)}</span>`);
  }
  if (model.branchGuard) {
    pills.push(`<span class="hpill bad" title="${escapeHtml(`This stage belongs to ${model.branchGuard.expected}`)}">${icon("warn", "escalate")}Wrong branch</span>`);
  }
  // The plan the stage belongs to, then the stage: the run label alone
  // (a stage id) does not say which piece of work this is part of.
  const stageName = model.plan?.current ?? model.stageHeading ?? model.title;
  const crumb = model.planName ? `<span class="plan">${escapeHtml(model.planName)}</span><span class="sep">›</span><span>${escapeHtml(stageName)}</span>` : `<span class="id">${escapeHtml(model.title)}</span>`;
  return `<header class="top">
<div><h1>Agent Sparring</h1><div class="run muted" title="${escapeHtml(model.stageId ?? "")}">${crumb}</div></div>
<div class="pills">${pills.join("")}</div>
</header>`;
}

// ---------------------------------------------------------------- wrong branch

/**
 * The checked-out branch is not this stage's. Prominent, above everything,
 * and paired with the absence of every engine action: each loop command
 * passes `--expected-branch`, so running one here would be refused by the
 * engine's own branch guard anyway.
 */
function renderBranchGuard(guard: BranchGuard): string {
  const actual = guard.actual ? `The repository is on <span class="branch">${escapeHtml(guard.actual)}</span>.` : "No branch is checked out (detached HEAD).";
  return `<section class="card branchguard">
<h2>${icon("warn", "escalate")}Wrong branch</h2>
<p>This stage belongs to <span class="branch">${escapeHtml(guard.expected)}</span>. ${actual}</p>
<p class="muted small">Switch branches before resuming. ${escapeHtml(guard.detail)}</p>
</section>`;
}

// ---------------------------------------------------------------- push authorization

/**
 * The permission panel: one sentence, one button, one toggle.
 *
 * Deliberately *unlike* the manual-verification panel it replaces. There are
 * no Pass / Fail / Can't test controls, no progress count, no evidence field
 * and no Submit for review: this is not a test, and the version of it that
 * looked like one let a person "pass" a check that authorized nothing while
 * the acceptance gate went on refusing the same candidate. What a person
 * decides here is whether the engine may push a commit, and the two answers
 * are Allow push and Do not allow.
 *
 * The lifecycle words the engine uses — freeze, candidate identity, remote
 * reachability — stay out of the normal layer entirely and live in the
 * details disclosure, where they belong.
 */
function renderPushAuthorization(panel: PushAuthorization): string {
  const toggle = `<label class="toggle" title="${escapeHtml(panel.autoPush.detail)}"><input type="checkbox" data-autopush="run"${panel.autoPush.checked ? " checked" : ""}> ${escapeHtml(panel.autoPush.label)}</label>`;
  // The same demoted layer, the same markup, as every other panel's: the
  // engine's vocabulary is one disclosure away, never deleted.
  const rows = panel.technical.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`).join("");
  const details = panel.technical.length > 0 ? `<details class="tech"><summary>Show technical details</summary><dl class="techlist">${rows}</dl></details>` : "";
  return `<section class="card action push">
<div class="actionhead"><h2>${icon("warn", "needs_you")}${escapeHtml(panel.headline)}</h2>
<p class="summary">${escapeHtml(panel.text)}</p>
<p class="muted small helper">${escapeHtml(PUSH_HELPER)}</p></div>
<div class="pushchoice">${toggle}</div>
${details}
<div class="actions">${button("allowPush", panel.allow.label, panel.allow.enabled, panel.allow.detail, "primary")}${button("doNotAllowPush", panel.dismiss.label, true, panel.dismiss.detail, "quiet")}</div>
</section>`;
}

/**
 * What allowing actually does, in the plainest words there are. It names the
 * one Git operation and the one place it goes, because the whole reason this
 * panel exists is that a person could previously agree to "push
 * authorization" without anything being pushed.
 */
export const PUSH_HELPER =
  "The review is finished and this exact commit is what would be accepted. Agent Sparring will not push it without your say-so. Allowing it pushes this branch, to that one place, and nothing else — then the plan continues.";

// ---------------------------------------------------------------- action required

/**
 * The one place a NEEDS_YOU / ESCALATE outcome is explained.
 *
 * Two layers, deliberately. The **primary** layer is what a person needs in
 * order to act: why the run stopped, the one thing to do, what counts as a
 * pass, the result controls, and the button that continues. The **technical**
 * layer — the reviewer's verbatim wording, the gate's category and check ids,
 * the plan path and line, the failure criteria — sits behind one disclosure,
 * because it answers "why does the harness believe that", which is a
 * different question and never a prerequisite for doing the check.
 *
 * A structured gate gets the simple presentation: the requirement is stated
 * once, as the reviewer's own gate title, and each check is its instruction
 * laid out as steps plus a single "Pass if" line. The legacy derived path
 * (verdicts recorded before the engine emitted gates) keeps its Plan
 * requirement / Still required structure, because there the provenance of
 * each check really is part of what the reader must weigh — but its empty
 * sections and its explanatory prose are gone from the main flow all the
 * same.
 */
function renderActionRequired(model: OverviewModel, panel: ActionRequired): string {
  const gate = panel.gateTitle !== undefined;
  const summary = panel.subtitle ? `<p class="summary">${escapeHtml(panel.subtitle)}</p>` : panel.summary ? `<p class="summary">${escapeHtml(panel.summary)}</p>` : "";
  // With a structured gate the reviewer's own note is a restatement of the
  // gate title; it belongs to the details layer, where the verbatim wording
  // lives. Without one it is the only compact statement there is.
  const note = !gate && panel.reviewerNote ? `<p class="reason"><span class="tag reviewer">Reviewer note</span> ${escapeHtml(panel.reviewerNote)}</p>` : "";
  const failure = panel.reviewFailure ? `<p class="failure">${icon("warn", "escalate")}${escapeHtml(panel.reviewFailure)}</p>` : "";
  const submission = renderSubmissionState(panel);
  const body = gate ? renderGateChecks(panel) : renderDerivedChecks(panel);
  const buttons: string[] = [];
  buttons.push(button("submitForReview", panel.submit.label, panel.submit.enabled, panel.submit.detail, "primary"));
  // The second submission path, beside the first: the two are alternatives,
  // and a person who found a blocking bug instead of a check result has to
  // be able to see that there is somewhere for it to go.
  buttons.push(button("sendFeedbackForReview", panel.feedback.send.label, panel.feedback.send.enabled, panel.feedback.send.detail));
  if (panel.planSection) {
    buttons.push(button("openPlanSection", "Open plan section", true, `Open the document ${model.planName ?? "the plan"} at this stage's section`));
  }
  buttons.push(button("openSparring", "Open detailed review", panel.review, "Open sparring.md — the reviewer's full findings, in their own words"));
  // Asking someone else what a check means is a normal step, and it should not
  // start with reassembling four files by hand. The copy is Markdown, so it
  // pastes into a chat assistant, an issue or a message unchanged.
  buttons.push(
    copyButton(
      "review",
      undefined,
      "Copy context for chat",
      "Copy this whole review as Markdown — the stage, the goal, the routing state, every check's instruction and pass criteria verbatim, the handoff claims, the reviewer's findings and the plan section. No prompts, reasoning, command output or activity log.",
    ),
  );
  // Offered here, at a gate, because adopting does not touch the gate: the
  // engine keeps this pause and the next human action is unchanged. It is
  // the only route from a standalone stage into a managed run, so it must be
  // where the user already is.
  const auto = model.continueAutomatically;
  if (auto?.kind === "adopt") {
    buttons.push(button("continueAutomatically", auto.label, true, auto.detail, "quiet"));
  }
  // Resuming implementation is a different act from answering the gate, and
  // at a gate it is almost never the right one: it starts the stage agent
  // again on a candidate the reviewer has already read. It stays reachable,
  // one disclosure away, never beside the button that answers the review.
  if (panel.resume) {
    buttons.push(
      `<details class="more"><summary title="Other things that can be run from here">…</summary><div class="actions">${button(panel.resume.action, `${panel.resume.label} (implementation)`, true, panel.resume.detail, "quiet")}</div></details>`,
    );
  }
  return `<section class="card action ${panel.kind}${panel.ready ? " ready" : ""}${gate ? " gate" : ""}">
<div class="actionhead"><h2>${icon(panel.ready && panel.kind === "needs_you" ? "check" : "warn", panel.ready && panel.kind === "needs_you" ? "ready" : panel.kind)}${escapeHtml(panel.headline)}</h2>${summary}${note}${failure}</div>
${submission}
${body}
${renderFeedbackField(panel)}
${renderTechnical(panel)}
<div class="actions">${buttons.join("")}</div>
</section>`;
}

/**
 * The freeform field, under the structured checks and visibly not one of
 * them: its own heading, its own helper sentence, no Pass / Fail / Can't test
 * beside it, and no place in the progress count.
 *
 * It is always present, not revealed by a disclosure, because the observation
 * it exists for — the crash on the way to the first check — arrives before
 * the person has any reason to go looking for a place to put it.
 */
function renderFeedbackField(panel: ActionRequired): string {
  const draft = panel.feedback.draft ?? "";
  const previous =
    panel.feedback.submitted.length > 0
      ? `<details class="prev"><summary>Feedback already sent (${panel.feedback.submitted.length})</summary>${panel.feedback.submitted.map((entry) => `<pre class="sent">${escapeHtml(entry)}</pre>`).join("")}</details>`
      : "";
  return `<div class="feedback">
<h4>${escapeHtml(FEEDBACK_HEADING)}</h4>
<p class="muted small helper">${escapeHtml(FEEDBACK_HELPER)}</p>
<textarea class="freeform" data-feedback="review" rows="3" placeholder="${escapeHtml(FEEDBACK_PLACEHOLDER)}">${escapeHtml(draft)}</textarea>
${previous}
</div>`;
}

export const FEEDBACK_HEADING = "Additional findings or instructions";

/**
 * Two sentences, and the second one is the important half: without it the
 * field reads as a comment box for the check above, which is precisely the
 * conflation the whole channel exists to undo.
 */
export const FEEDBACK_HELPER =
  "Report a blocking bug, unexpected behavior, design feedback, or other information that does not belong to a check above. This field is independent of Pass / Fail / Can't test.";

const FEEDBACK_PLACEHOLDER = "What you found, and how to reproduce it if it is a bug";

/**
 * Where a submission stands, when one is in flight or has failed.
 *
 * A failed submission leads with what was preserved, before the reason and
 * before the engine's own words: the person has just watched five recorded
 * check results seem to vanish, and the first thing on the page has to answer
 * that. The engine's output follows verbatim, because it is the only thing
 * that says what to fix.
 */
function renderSubmissionState(panel: ActionRequired): string {
  if (panel.submitting) {
    return `<p class="submitting" title="${escapeHtml(panel.submitting.detail)}">${icon("dot", "accent")}${escapeHtml(panel.submitting.label)}</p>`;
  }
  const unresolved = panel.submissionUnresolved;
  if (unresolved) {
    // Neither success nor failure, and it says so: nobody knows what the
    // engine did with this evidence, and the panel must not invent an answer
    // in either direction to make its buttons work.
    return `<div class="subfail">
<p class="preserved">${icon("warn", "escalate")}${escapeHtml(unresolved.preserved)}</p>
<p class="muted small">${escapeHtml(unresolved.reason)} ${escapeHtml(unresolved.what)}</p>
<div class="actions">${button("dismissSubmissionFailure", "Dismiss", true, "Hide this report. Nothing you entered is changed by dismissing it.", "quiet small")}</div>
</div>`;
  }
  const failed = panel.submissionFailure;
  if (!failed) {
    return "";
  }
  const error = failed.error ? `<pre class="engineerror">${escapeHtml(failed.error)}</pre>` : "";
  return `<div class="subfail">
<p class="preserved">${icon("warn", "escalate")}${escapeHtml(failed.preserved)}</p>
<p class="muted small">${escapeHtml(failed.reason)} ${escapeHtml(failed.what)}</p>
${error}
<div class="actions">${button("dismissSubmissionFailure", "Dismiss", true, "Hide this report. Nothing you entered is changed by dismissing it.", "quiet small")}</div>
</div>`;
}

/**
 * A structured gate: the requirement once, then one task per check. No
 * heading hierarchy, no counts, no provenance prose — a single check is a
 * single thing to do, and the panel already said that is what this is.
 */
function renderGateChecks(panel: ActionRequired): string {
  const total = panel.recorded.length + panel.required.length;
  const title = panel.gateTitle ? `<p class="gatetitle">${escapeHtml(panel.gateTitle)}</p>` : "";
  // Two or more checks: say how far along the evidence is. One check has no
  // progress worth reporting — the controls under it are the whole story.
  const progress = total > 1 && panel.progress ? `<p class="muted small progress">${escapeHtml(panel.progress)}</p>` : "";
  const required =
    panel.required.length > 0
      ? `<ol class="checklist gate">${panel.required.map((item, index) => renderTask(item, index + 1, total)).join("")}</ol>`
      : `<p class="muted">Every check the reviewer asked for has a recorded result.</p>`;
  return `<div class="checks">${title}${progress}${required}${renderPreviousEvidence(panel)}</div>`;
}

/** Evidence already in notes.md, compact and collapsed; absent when there is none. */
function renderPreviousEvidence(panel: ActionRequired): string {
  if (panel.recorded.length === 0) {
    return "";
  }
  return `<details class="prev"><summary>Previous evidence (${panel.recorded.length})</summary><ol class="checklist recorded">${panel.recorded.map(renderRecorded).join("")}</ol></details>`;
}

/**
 * The legacy path, for a verdict recorded before structured gates: the plan's
 * own requirement (verbatim), then what is still required. Where each check
 * came from is shown per check, as a tag; the paragraphs that used to explain
 * the derivation are in the technical details.
 */
function renderDerivedChecks(panel: ActionRequired): string {
  const total = panel.recorded.length + panel.required.length;
  const progress = panel.progress ? `<span class="progress" title="Checks with recorded or drafted Pass, out of all checks">${escapeHtml(panel.progress)}</span>` : "";
  if (total === 0) {
    return `<div class="checks"><h3>${icon("check", "accent")}Manual verification ${progress}</h3><p class="muted">${escapeHtml(panel.noChecks ?? "")}</p></div>`;
  }
  const parts: string[] = [];
  if (panel.parents.length > 0) {
    parts.push(`<div class="part"><h4>Plan requirement</h4>${panel.parents.map((parent) => `<p class="criterion parent" title="${escapeHtml(`Plan line ${parent.line}`)}">${escapeHtml(parent.text)}</p>`).join("")}</div>`);
  }
  if (panel.recorded.length > 0) {
    parts.push(`<div class="part"><h4>Evidence already recorded</h4><ol class="checklist recorded">${panel.recorded.map(renderRecorded).join("")}</ol></div>`);
  }
  parts.push(
    `<div class="part"><h4>Still required</h4>${panel.required.length > 0 ? `<ol class="checklist">${panel.required.map((item, index) => renderRequired(item, index + 1, total)).join("")}</ol>` : `<p class="muted small">Every check has recorded evidence.</p>`}</div>`,
  );
  return `<div class="checks"><h3>${icon("check", "accent")}Manual verification ${progress}</h3>${parts.join("")}</div>`;
}

/** The demoted layer. Collapsed, always available, never in the way. */
function renderTechnical(panel: ActionRequired): string {
  if (panel.technical.length === 0) {
    return "";
  }
  const rows = panel.technical.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`).join("");
  return `<details class="tech"><summary>Show technical details</summary><dl class="techlist">${rows}</dl></details>`;
}

/**
 * One gate check as a task: the reviewer's instruction as its own sentences
 * (numbered when there is more than one), then what passing means, then the
 * three results and a note. Nothing is shortened — a check is a test, and a
 * test loses its meaning one clause at a time.
 */
function renderTask(item: CheckItem, position: number, total: number): string {
  const task = humanTask(item);
  const steps = task.steps.length > 1 ? `<ol class="steps">${task.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : `<p class="instruction">${escapeHtml(task.steps[0] ?? item.text)}</p>`;
  const passIf = task.passIf ? `<p class="passif"><span class="lead">Pass if:</span> ${escapeHtml(task.passIf)}</p>` : "";
  // Where the reviewer said the full test is defined. It is part of doing the
  // check, not of explaining the harness, so it belongs in the primary layer —
  // and it is a concrete name, which is the whole point of it.
  const source = item.source ? `<p class="muted small source"><span class="lead">Defined in:</span> ${escapeHtml(item.source)}</p>` : "";
  return `<li class="check task${item.record?.outcome ? ` ${item.record.outcome}` : ""}">
<div class="checkbody">${steps}${passIf}${source}</div>
${renderRecordControls(item)}
${renderCheckMeta(item, position, total)}
</li>`;
}

/**
 * The quiet row under a check: what the check is called, and the copy action
 * for it.
 *
 * The name is shown only when there is more than one check, because that is
 * the case where the alternative is a collective phrase — "both of them", "the
 * other one" — and the reviewer's stable id is the concrete name that ends the
 * ambiguity. With a single check the panel headline has already said which
 * check this is, and an id there would be noise.
 */
function renderCheckMeta(item: CheckItem, position: number, total: number): string {
  const name = checkName(item, position);
  const label = total > 1 && name.named ? `<span class="checkid muted small" title="${escapeHtml(NAME_TITLE)}">${escapeHtml(name.name)}</span>` : "";
  const copy = copyButton(
    "check",
    item.key,
    "Copy this check",
    `Copy ${name.named ? `check ${name.name}` : `this check (${name.description})`} as Markdown: the stage it belongs to, its instruction and its pass criteria verbatim, ready to paste into a chat and ask what it means or how to perform it`,
    "quiet small",
  );
  return `<div class="checkmeta">${label}${copy}</div>`;
}

const NAME_TITLE = "The reviewer's own stable id for this check; it is what a recorded result is matched by";

/** Pass / Fail / Can't test, plus the optional note; the same controls wherever a check is shown. */
function renderRecordControls(item: CheckItem): string {
  const outcome = item.record?.outcome;
  const choices = CHECK_OUTCOMES.map(
    (candidate) =>
      `<button type="button" class="choice ${candidate}${outcome === candidate ? " on" : ""}" data-check="${escapeHtml(item.key)}" data-outcome="${candidate}" aria-pressed="${outcome === candidate}" title="${escapeHtml(OUTCOME_TITLES[candidate])}">${OUTCOME_LABELS[candidate]}</button>`,
  ).join("");
  return `<div class="record"><span class="choices">${choices}</span><textarea class="note" data-check="${escapeHtml(item.key)}" rows="1" placeholder="Evidence or note (optional)">${escapeHtml(item.record?.note ?? "")}</textarea></div>`;
}

/**
 * The words on the three buttons. `blocked` is the engine's own value and
 * the word written into notes.md; what it means to the person pressing it is
 * that they could not run the check, so that is what the button says.
 */
export const OUTCOME_LABELS: Record<CheckOutcome, string> = { pass: "Pass", fail: "Fail", blocked: "Can't test" };

const OUTCOME_TITLES: Record<CheckOutcome, string> = {
  pass: "The check was performed and met its criteria",
  fail: "The check was performed and did not meet its criteria",
  blocked: "You could not perform the check (recorded as Blocked, the engine's own word for it)",
};

function originTag(item: CheckItem): string {
  if (item.origin === "gate") {
    return `<span class="tag reviewer" title="${escapeHtml(item.gateId ? `The reviewer's own check, id ${item.gateId}` : "The reviewer's own check")}">Reviewer</span>`;
  }
  return item.origin === "plan" ? `<span class="tag plan" title="${escapeHtml(item.line ? `Plan line ${item.line}` : "From the plan")}">Plan</span>` : `<span class="tag reviewer" title="From the sparring report, not the plan">Reviewer</span>`;
}

/** The reviewer's pass criteria, for a check on the legacy derived path. */
function checkDetail(item: CheckItem): string {
  const passIf = splitPassCriteria(item.passCriteria).passIf;
  return passIf ? `<p class="passif"><span class="lead">Pass if:</span> ${escapeHtml(passIf)}</p>` : "";
}

/** ✓ text — recorded in notes.md; the excerpt says which entry, so a wrong match is visible. */
function renderRecorded(item: CheckItem): string {
  const outcome = item.evidence?.outcome;
  const mark = outcome === "fail" ? "✗" : outcome === "blocked" ? "⊘" : "✓";
  const word = outcome ? `<span class="outcome ${outcome}">${OUTCOME_LABELS[outcome]}</span> ` : "";
  const how = item.evidence?.how === "id" ? "A result recorded from this panel for this exact check" : item.evidence?.how === "exact" ? "A result recorded from this panel" : "A ## Human evidence entry naming this check";
  return `<li class="check done ${escapeHtml(outcome ?? "pass")}"><div class="checkrow"><span class="mark">${mark}</span><div class="checkbody"><p class="criterion">${word}${escapeHtml(item.text)} ${originTag(item)}</p><p class="muted small evidence" title="${escapeHtml(how)}">notes.md: ${escapeHtml(item.evidence?.excerpt ?? "")}</p></div></div></li>`;
}

/** ○ text with the reviewer's pass criteria, then the three results and a note (legacy derived path). */
function renderRequired(item: CheckItem, position: number, total: number): string {
  const outcome = item.record?.outcome;
  return `<li class="check${outcome ? ` ${outcome}` : ""}">
<div class="checkrow"><span class="mark">○</span><div class="checkbody"><p class="criterion">${escapeHtml(item.text)} ${originTag(item)}</p>${checkDetail(item)}</div></div>
${renderRecordControls(item)}
${renderCheckMeta(item, position, total)}
</li>`;
}

const JOURNEY_ICON: Record<TimelineItem["state"], keyof typeof ICON | undefined> = {
  accepted: "check",
  finalizing: "lock",
  active: undefined,
  paused: "pause",
  working: undefined,
  future: undefined,
};

/** Filled nodes joined by connectors; the connector after an accepted node is coloured. */
function renderJourney(items: TimelineItem[]): string {
  const cells = items.map((item) => {
    const cls = `step ${item.state}${item.current ? " current" : ""}`;
    const word = TIMELINE_STATE_WORD[item.state];
    // The plan's own name for the stage, when the run knows one; its position
    // in the run stays in the tooltip, where an ordinal belongs.
    const name = item.label ? `Stage ${item.label}` : `Stage ${item.number}`;
    const label = `${name} — ${item.title} (${word}) · ${item.number} of ${items.length}`;
    const glyphIcon = JOURNEY_ICON[item.state];
    const node = glyphIcon ? icon(glyphIcon) : escapeHtml(item.label ?? String(item.number));
    const state = item.state === "accepted" ? `<span class="state">${icon("check")}${escapeHtml(word)}</span>` : `<span class="state">${escapeHtml(word)}</span>`;
    return `<li class="${cls}" title="${escapeHtml(label)}"><span class="node">${node}</span><span class="num">${escapeHtml(item.label ?? String(item.number))}</span><span class="name">${escapeHtml(item.title)}</span>${state}</li>`;
  });
  return `<ol class="journey">${cells.join("")}</ol>`;
}

/** The stage action a button triggers: Accept stage is the two-step acceptance, everything else launches the loop. */
function stageActionButton(action: StageRunAction, stageId: string | undefined, cls = action.primary ? "primary" : ""): string {
  if (action.kind === "accept") {
    const title = `sparring freeze-candidate ${stageId ?? ""} …, then sparring accept-candidate ${stageId ?? ""} … (--repo-root <project> --expected-branch <current branch>)`;
    return button("acceptStage", action.label, true, title, cls);
  }
  const title = `sparring run-loop ${stageId ?? ""} --repo-root <project> --expected-branch <current branch>`;
  return button("runStage", action.label, true, title, cls);
}

function renderStageCard(model: OverviewModel): string {
  const accepted = model.whatsNext !== undefined;
  const handedOver = model.actionRequired !== undefined;
  // Once accepted, the header pill already says Accepted: the card line
  // says "Stage complete." once and nothing repeats it. Likewise Needs you /
  // Escalated: the pill names it and the Action required panel explains it.
  const statusWord =
    model.stageStatus && !accepted && !handedOver
      ? `<span class="status ${escapeHtml(model.stageStatusKind ?? "")}" title="${escapeHtml(model.stageRaw ? `Engine state: ${model.stageRaw}` : "")}">${escapeHtml(model.stageStatus)}</span><span class="sep">·</span>`
      : "";
  const cycle = model.cycle !== undefined ? `<span class="muted" title="loop cycle from telemetry">cycle ${model.cycle}</span><span class="sep">·</span>` : "";
  const buttons: string[] = [];
  // In automatic mode the whole plan is the unit of work, so Continue
  // automatically is the primary button and the per-stage operations stay
  // available as the quieter alternatives — never removed, since a user may
  // always want to drive one stage by hand.
  // While the Action required panel is up it carries the offer instead, so
  // the same button is never in two places.
  if (model.followPlan) {
    buttons.push(button("openPlanRun", model.followPlan.label, true, model.followPlan.detail, "primary"));
  }
  const auto = model.actionRequired ? undefined : model.continueAutomatically;
  if (auto && !handedOver) {
    buttons.push(button("continueAutomatically", auto.label, true, auto.detail, auto.primary ? "primary" : "quiet"));
  }
  if (model.stageAction && !handedOver) {
    // While the human is asked for something, the resume lives in the Action required panel.
    buttons.push(stageActionButton(model.stageAction, model.stageId, auto?.primary ? "quiet" : model.stageAction.primary ? "primary" : ""));
  }
  if (model.planAction && !accepted && !handedOver) {
    // For an accepted stage the plan action is the primary button of What's next instead.
    buttons.push(button("resumePlan", model.planAction.label, true, model.planAction.detail, model.planAction.primary && !auto ? "primary" : ""));
  }
  if (model.accepting) {
    buttons.push(`<span class="busy accepting" title="${escapeHtml(model.accepting.detail)}">${icon("dot", "dot")}${escapeHtml(model.accepting.label)}</span>`);
  }
  if (model.busyState) {
    const cls = model.busyState.state === "running" ? "busy" : "busy unknown";
    buttons.push(`<span class="${cls}" title="${escapeHtml(model.busyState.detail)}">${icon(model.busyState.state === "running" ? "dot" : "warn", "dot")}${escapeHtml(model.busyState.label)}</span>`);
  }
  if (model.runner?.alive) {
    buttons.push(button("stopRunner", model.runner.label, true, "Send Ctrl-C to the terminal running this stage", "danger"));
  }
  if (model.unknownRunner) {
    // The only way out of an unknown runner, and it is here — next to the
    // state it settles — rather than in the Command Palette alone.
    buttons.push(button("confirmRunnerInactive", model.unknownRunner.label, true, model.unknownRunner.detail, "quiet"));
  }
  const actions = model.actions;
  if (actions) {
    buttons.push(button("openBrief", "Brief", actions.brief, "Open brief.md"));
    buttons.push(button("openHandoff", "Handoff", actions.handoff, "Open handoff.md"));
    buttons.push(button("openSparring", "Sparring report", actions.sparring, "Open sparring.md"));
    if (actions.diff) {
      buttons.push(button("openDiff", actions.diff.label, true, actions.diff.detail));
    }
    if (actions.plan) {
      buttons.push(button("openPlan", "Plan document", true, model.plan ? `Open the Markdown document ${model.plan.name} — ${model.plan.note}` : "Open the plan document"));
    } else if (actions.choosePlan && !accepted) {
      buttons.push(button("associatePlan", "Choose plan…", true, CHOOSE_PLAN_TITLE));
    }
    if (actions.changePlan && !(accepted && !actions.plan)) {
      buttons.push(button("associatePlan", "Change plan…", true, actions.plan ? "Choose another plan file or remove the association" : "The associated plan file is missing: choose another or remove the association", "quiet"));
    }
    buttons.push(button("showLog", "Log", true, "Show the Agent Sparring output channel"));
  }
  if (model.secondaryAction) {
    buttons.push(stageActionButton(model.secondaryAction, model.stageId, "quiet"));
  }

  // No Goal, no section: a brief without a `## Goal` heading is a fact for
  // the diagnostics command, not a Markdown complaint to put in front of
  // someone who came here to answer a review. The Brief button already says
  // whether there is a brief at all.
  const goal = model.goal ? `<div class="block"><h3>${icon("target", "accent")}Goal</h3><p class="goal">${escapeHtml(model.goal)}</p></div>` : "";
  let sparring = `<div class="block"><h3>${icon("chat")}Latest sparring result</h3><p class="muted">No routing outcome recorded yet.</p></div>`;
  if (handedOver) {
    sparring = ""; // the Action required panel is the latest sparring result
  } else if (model.lastSparring) {
    const action = model.lastSparring.action;
    const reason = model.lastSparring.reason ? ` <span class="muted">(${escapeHtml(model.lastSparring.reason)})</span>` : "";
    const iconName = action === "READY" ? "check" : "warn";
    sparring = `<div class="block"><h3>${icon(iconName, action.toLowerCase())}Latest sparring result</h3>
<p><span class="verdict ${escapeHtml(action.toLowerCase())}" title="${escapeHtml(`Routing action: ${action}`)}">${escapeHtml(model.lastSparring.word)}</span>${reason}</p>
<p>${escapeHtml(model.lastSparring.summary || "(no summary recorded)")}</p></div>`;
  }
  const planPlace = renderPlanPlace(model);

  let current = `<p class="muted">No provider turn in progress.</p>`;
  if (model.activity?.kind === "stopped") {
    current = `<p class="stopped">${icon("warn", "send_back")}${escapeHtml(model.activity.text)}</p>`;
  } else if (model.activity?.kind === "stale") {
    current = `<p class="stale">${icon("warn", "send_back")}${escapeHtml(model.activity.text)}</p>`;
  } else if (model.activity?.kind === "inferred") {
    current = `<p class="inferred" title="${escapeHtml(model.liveness?.detail ?? "")}">${icon("warn", "send_back")}${escapeHtml(model.activity.text)}</p>`;
  } else if (model.runner?.alive && model.activity?.kind !== "active") {
    current = `<p class="muted">Runner started; waiting for the first turn.</p>`;
  } else if (model.activity?.kind === "active") {
    // "Sparring for 12s · Codex" → "Codex sparring for 12s"
    const match = /^(Working|Sparring) for (.+) · (.+)$/.exec(model.activity.text);
    current = match
      ? `<p class="now"><span class="who ${whoClass(match[3])}">${escapeHtml(match[3])}</span> ${match[1].toLowerCase()} for <span class="dur">${escapeHtml(match[2])}</span></p>`
      : `<p class="now">${escapeHtml(model.activity.text)}</p>`;
  }
  const last = model.lastEvent
    ? `<p><span class="time">${escapeHtml(model.lastEvent.time)}</span><span class="sep">·</span><span class="who ${whoClass(model.lastEvent.who)}">${escapeHtml(model.lastEvent.who)}</span> ${escapeHtml(model.lastEvent.description)}</p>`
    : `<p class="muted">No activity telemetry for this stage.</p>`;

  // An accepted stage has no current activity to watch; the right column
  // answers "what should I do now?" instead. The last event stays in Recent events.
  const right = model.whatsNext
    ? renderWhatsNext(model, model.whatsNext)
    : `<div class="block"><h3>${icon("pulse", "accent")}Current activity</h3>${current}</div>
<div class="block"><h3>${icon("doc")}Last meaningful event</h3>${last}</div>`;

  const position = model.positionNote ? `<span class="muted" title="${escapeHtml(model.position ?? "")}">${escapeHtml(model.positionNote)}</span><span class="sep">·</span>` : "";
  // Where the work actually is, when this screen is a finished stage of a
  // run that has moved on. Said once, above everything this stage can offer.
  const elsewhere = model.followPlan ? `<p class="elsewhere">${icon("warn", "accent")}${escapeHtml(model.followPlan.text)}</p>` : "";
  const left = `${goal}${sparring}${planPlace}`;
  return `<section class="card stage">
<div class="stagehead">
<div><h2 title="${escapeHtml(model.stageId ?? "")}">${icon("dot", `accent ${escapeHtml(model.stageStatusKind ?? "")}`)}${escapeHtml(model.stageHeading ?? "")}</h2>
<div class="substatus">${position}${statusWord}${cycle}<span class="${accepted ? "complete" : "muted"}">${escapeHtml(model.stageLine ?? "")}</span></div></div>
<div class="actions">${buttons.join("")}</div>
</div>
${elsewhere}
<div class="columns${left ? "" : " single"}">
${left ? `<div class="col">${left}</div>` : ""}
<div class="col right">
${right}
</div>
</div>
</section>`;
}

const CHOOSE_PLAN_TITLE = "Pick the Markdown plan this stage belongs to (kept in VS Code only; the engine is not told)";
const MATCH_TITLE = "Pick which section of the linked plan THIS stage is — only this one is remapped (kept in VS Code only; the engine is not told)";
const REVIEW_MATCHES_TITLE = "See every stage of this project and which plan section it resolves to, and fix one that could not be placed — without changing this stage";

/**
 * Where this stage sits in an associated plan, for a stage that is still
 * running: the matched heading with Change match…, or the fact that it is
 * not matched with Match this stage…. Accepted stages carry this in What's
 * next instead; managed runs show the journey.
 */
function renderPlanPlace(model: OverviewModel): string {
  const plan = model.plan;
  if (!plan || plan.source !== "associated" || model.whatsNext) {
    return "";
  }
  if (plan.current) {
    // The stage card's own heading is this name now, so the block carries
    // only how it was decided and the two ways to change it.
    return `<div class="block"><h3>${icon("doc")}Current plan stage</h3>${renderCurrentPlanStage(plan.current, plan.matched, model.stageHeading === plan.current)}</div>`;
  }
  if (!model.actions?.matchStage) {
    return "";
  }
  return `<div class="block"><h3>${icon("doc")}Current plan stage</h3><p class="muted">Agent Sparring doesn't yet know where this stage belongs in ${escapeHtml(plan.name)}. ${button("matchStage", "Match this stage…", true, MATCH_TITLE, "quiet")}</p></div>`;
}

/** `Stage 3B — title` with how it was decided and the two ways to change it; the name is dropped when the card heading is already it. */
function renderCurrentPlanStage(current: string, matched: MatchSource | undefined, named = false): string {
  const how = matched === "manual" ? "Matched manually" : "Matched automatically";
  // Change match… is about this stage and nothing else; the plan-level
  // review sits next to it so fixing *another* stage never starts by
  // remapping the one on screen.
  return `${named ? "" : `<p class="nextstage">${escapeHtml(current)}</p>`}<p class="muted matched">${how} ${button("matchStage", "Change match…", true, MATCH_TITLE, "quiet")}${matched === "manual" ? button("clearMatch", "Remove match", true, "Forget the section you picked and match automatically again", "quiet") : ""}${button("reviewStageMatches", "All stage matches…", true, REVIEW_MATCHES_TITLE, "quiet")}</p>`;
}

/**
 * The accepted screen's answer to "what should I do now?". Buttons are
 * real operations only: Continue plan is the engine's resume-plan for a
 * managed run; everything for an associated file opens or matches a
 * document and never claims to start a stage.
 */
function renderWhatsNext(model: OverviewModel, next: WhatsNext): string {
  const plan = model.plan;
  const heading = next.heading ? `<p class="nextstage">${escapeHtml(next.heading)}</p>` : "";
  const summary = next.summary ? `<p class="muted summary">${escapeHtml(next.summary)}</p>` : "";
  const text = `<p class="${next.heading ? "muted" : ""}">${escapeHtml(next.text)}</p>`;
  const hints = next.hints && next.hints.length > 0 ? `<p class="muted">The brief lists later work that is in this plan: ${next.hints.map((hint) => `<span class="next">${escapeHtml(hint)}</span>`).join(", ")}.</p>` : "";
  const buttons: string[] = [];
  const planName = plan?.name ?? "the plan";
  // Opening Markdown, and nothing else. The label says "document" or
  // "section" precisely so it can never be read as switching the cockpit to
  // the plan *run* — that is Back to plan run, and it is a different act.
  const openNext = (cls = "") =>
    plan?.next?.line
      ? button("openNextStage", "Open plan section", true, `Open the document ${planName} at ${plan.next.display}`, cls)
      : button("openPlan", "Open plan document", true, `Open the document ${planName}`, cls);
  // In automatic mode the rest of the plan goes to the engine in one step;
  // the per-stage operation stays as the quieter alternative.
  const auto = model.continueAutomatically;
  if (auto && (next.kind === "continue" || next.kind === "last-managed" || next.kind === "next-stage")) {
    buttons.push(button("continueAutomatically", auto.label, true, auto.detail, "primary"));
  }
  switch (next.kind) {
    case "continue":
    case "last-managed":
      if (model.planAction) {
        buttons.push(button("resumePlan", model.planAction.label, true, model.planAction.detail, auto ? "" : "primary"));
      }
      if (model.actions?.plan) {
        buttons.push(openNext());
      }
      break;
    case "next-stage":
      buttons.push(
        button(
          "startNextStage",
          "Start next stage",
          true,
          `sparring new-stage ${next.start?.stageId ?? ""} --brief-file … — creates the stage with this plan section as its brief.md; Run stage then begins implementation`,
          auto ? "quiet" : "primary",
        ),
      );
      buttons.push(openNext());
      buttons.push(button("matchStage", "Change match…", true, MATCH_TITLE, "quiet"));
      break;
    case "next-created":
      if (model.followPlan) {
        buttons.push(button("openPlanRun", model.followPlan.label, true, model.followPlan.detail, "primary"));
      }
      buttons.push(openNext(model.followPlan ? "" : "primary"));
      break;
    case "next-unclear":
      buttons.push(openNext("primary"));
      buttons.push(button("matchStage", "Change match…", true, MATCH_TITLE, "quiet"));
      break;
    case "last-stage":
    case "no-labels":
      buttons.push(button("openPlan", "Open plan document", true, `Open the document ${planName}`));
      buttons.push(button("matchStage", "Change match…", true, MATCH_TITLE, "quiet"));
      break;
    case "match":
      if (model.actions?.matchStage) {
        buttons.push(button("matchStage", "Match this stage…", true, MATCH_TITLE, "primary"));
      }
      buttons.push(button("openPlan", "Open plan document", true, `Open the document ${planName}`));
      buttons.push(button("associatePlan", "Change plan…", true, "Choose another plan file or remove the association", "quiet"));
      break;
    case "missing-plan":
    case "choose":
      buttons.push(button("associatePlan", "Choose plan…", true, CHOOSE_PLAN_TITLE, "primary"));
      break;
  }
  const matchedKinds: WhatsNext["kind"][] = ["next-stage", "next-unclear", "last-stage", "no-labels"];
  const current =
    matchedKinds.includes(next.kind) && plan?.current
      ? `<div class="block currentstage"><h3>${icon("doc")}Current plan stage</h3><p class="nextstage">${escapeHtml(plan.current)}</p><p class="muted matched">${plan.matched === "manual" ? "Matched manually" : "Matched automatically"}${plan.matched === "manual" ? ` ${button("clearMatch", "Remove match", true, "Forget the section you picked and match automatically again", "quiet")}` : ""}${button("associatePlan", "Remove plan association", true, "Unlink this plan from the stage (kept in VS Code only)", "quiet")}</p></div>`
      : "";
  return `<div class="block whatsnext"><h3>${icon("arrow", "accent")}What's next</h3>${heading}${summary}${text}${hints}<div class="actions">${buttons.join("")}</div></div>${current}`;
}

function renderActor(card: ActorCard): string {
  const busy = card.activity === "Working" || card.activity === "Sparring";
  const duration = card.duration ? ` for ${escapeHtml(card.duration)}` : "";
  const quiet = card.quietFor ? ` <span class="muted">· no meaningful activity for ${escapeHtml(card.quietFor)}</span>` : "";
  const uncertain = busy && card.uncertain ? ` <span class="muted">· runner status unknown</span>` : "";
  const session = card.sessionLabel ? `${capitalize(card.sessionKind)}: ${escapeHtml(card.sessionLabel)}` : `No ${card.sessionKind} yet`;
  const who = whoClass(card.provider);
  // A telemetry-only turn reads "Working? (turn observed 3m ago)": the duration is
  // time since the observed start, not a claim that work is happening now.
  const word = busy && card.uncertain ? `${card.activity}?` : card.activity;
  const span = busy && card.uncertain ? (card.duration ? ` <span class="muted">(turn observed ${escapeHtml(card.duration)} ago)</span>` : "") : duration;
  const identity = `<span class="avatar ${who}">${escapeHtml(card.provider.charAt(0).toUpperCase())}</span>
<div class="who">
<div><span class="provider ${who}">${escapeHtml(card.provider)}</span> <span class="muted">(${escapeHtml(card.role)})</span></div>
<div class="activity ${card.activity.toLowerCase()}${busy && card.uncertain ? " uncertain" : ""}">${icon("dot", "dot")}${escapeHtml(word)}${busy ? span : ""}${uncertain}${quiet}</div>
<div class="session muted">${session}</div>
</div>`;
  // No captured prompt means the engine has not run a turn for this actor
  // since prompt capture existed. An ordinary state, so the card simply
  // stays a card rather than offering a disclosure that would open on
  // nothing.
  if (!card.prompt) {
    return `<div class="card actor">${identity}</div>`;
  }
  const role = card.role === "Stage agent" ? "stage" : "sparrer";
  return `<details class="card actor" data-role="${role}">
<summary>${identity}<span class="showinstr">Show instructions</span></summary>
${renderInstructions(card.prompt, role)}
</details>`;
}

/**
 * What this actor was told, from the engine's captured prompt.
 *
 * Role and turn kind come first, deliberately: they are usually enough to
 * see that a stage is running the wrong kind of turn — a review stage being
 * driven as an implementation turn, say — without reading a word of the
 * prompt body.
 *
 * Everything below is escaped text laid out by section. Nothing renders the
 * Markdown: the structure a reader needs is the section headings and where
 * each one came from, both of which the engine recorded, and escaping first
 * is what keeps arbitrary plan prose from reaching this webview as markup.
 */
function renderInstructions(prompt: PromptView, role: string): string {
  const recency = prompt.live
    ? `<span class="turnchip live">This turn</span>`
    : `<span class="turnchip">Last turn</span>`;
  const branch = prompt.branch ? ` <span class="muted">· branch <code>${escapeHtml(prompt.branch)}</code></span>` : "";
  const head = `<div class="turnline">${recency}<strong>${escapeHtml(prompt.turn)}</strong> <span class="muted">· ${escapeHtml(prompt.detail)}</span>${branch}</div>`;

  const body = prompt.sectionsUnavailable
    ? `<p class="note">${escapeHtml(prompt.sectionsUnavailable)}</p>`
    : prompt.sections.map(renderPromptSection).join("");

  const exact = `<details class="promptsec exact"><summary><span class="sechead">View exact generated prompt</span><span class="secsrc muted">${prompt.exact.length.toLocaleString("en-US")} characters, as sent</span></summary><pre class="prompttext">${escapeHtml(prompt.exact)}</pre></details>`;
  const copy = `<div class="actions"><button class="quiet" data-copyprompt="${role}">Copy prompt</button></div>`;
  return `<div class="instructions">${head}${body}${exact}${copy}</div>`;
}

/**
 * One section: its heading, where it came from, and its text.
 *
 * A file-sourced section names the file and offers to open it; an
 * engine-authored one says so instead of being left to look like part of
 * the plan. Large sections start collapsed so that PROJECT.md, which is
 * routinely the longest thing in the prompt, does not bury the rest.
 */
function renderPromptSection(section: PromptViewSection): string {
  const open = section.text.length <= PROMPT_SECTION_OPEN_MAX ? " open" : "";
  const source = section.source
    ? `<button class="linkish" data-openprompt="${escapeHtml(section.source)}" title="${escapeHtml(section.source)}">${escapeHtml(basename(section.source))}</button>`
    : `<span class="secsrc muted">Agent Sparring</span>`;
  const heading = section.heading || "(unnamed section)";
  return `<details class="promptsec"${open}><summary><span class="sechead">${escapeHtml(heading)}</span>${source}</summary><pre class="prompttext">${escapeHtml(section.text)}</pre></details>`;
}

/** Sections at or below this many characters start expanded. */
const PROMPT_SECTION_OPEN_MAX = 2000;

function basename(source: string): string {
  const parts = source.split("/");
  return parts[parts.length - 1] || source;
}

function whoClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("claude")) {
    return "claude";
  }
  if (lower.startsWith("codex")) {
    return "codex";
  }
  return "other";
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function button(action: OverviewAction, label: string, enabled = true, title?: string, cls = ""): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const classAttr = cls ? ` class="${cls}"` : "";
  return `<button type="button"${classAttr} data-action="${action}"${titleAttr}${enabled ? "" : " disabled"}>${escapeHtml(label)}</button>`;
}

/**
 * A copy-for-chat control. It carries `data-copy` rather than `data-action`
 * because it is the one button kind that acts on a *named part* of the page,
 * and the check's key travels with the click; see {@link CopyMessage}.
 */
function copyButton(scope: CopyMessage["scope"], key: string | undefined, label: string, title: string, cls = ""): string {
  const classAttr = cls ? ` class="${cls}"` : "";
  const keyAttr = key === undefined ? "" : ` data-check="${escapeHtml(key)}"`;
  return `<button type="button"${classAttr} data-copy="${scope}"${keyAttr} title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
}

export type { HistoryEntry };

// ---------------------------------------------------------------- style

const STYLE = `
:root {
  color-scheme: light dark;
  --good: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  --info: var(--vscode-charts-blue, var(--vscode-focusBorder));
  /*
   * Warning colours come from the theme's *semantic* warning tokens rather
   * than the chart palette: charts.orange is chosen to sit on a chart, and on
   * a dark side-bar background it reads as a muted brown. The notification /
   * editor warning foreground is the colour a theme guarantees is legible as
   * a warning, and inputValidation.warning{Background,Border} is the surface
   * pair it guarantees goes with it — so the warning pill keeps ordinary
   * foreground text on a tinted ground, and stays distinct without becoming
   * an alarm.
   */
  --warn: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-editorWarning-foreground, var(--vscode-charts-orange)));
  --warn-surface: var(--vscode-inputValidation-warningBackground, transparent);
  --warn-border: var(--vscode-inputValidation-warningBorder, var(--warn));
  --bad: var(--vscode-charts-red, var(--vscode-editorError-foreground));
  --claude: var(--vscode-charts-blue, var(--vscode-focusBorder));
  --codex: var(--vscode-charts-purple, var(--vscode-textLink-foreground));
  --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
  --card: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
}
body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
main { max-width: 880px; margin: 0 auto; padding: 14px 18px 20px; }
.muted { color: var(--vscode-descriptionForeground); }
.sep { color: var(--vscode-descriptionForeground); margin: 0 6px; }
.icon { width: 14px; height: 14px; vertical-align: -2px; margin-right: 6px; flex: none; }
.icon.accent { color: var(--info); }
.icon.ready, .icon.accepted { color: var(--good); }
.icon.send_back, .icon.needs_you { color: var(--warn); }
.icon.escalate { color: var(--bad); }
.icon.dot { width: 9px; height: 9px; margin-right: 5px; }

header.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
h1 { font-size: 1.35em; font-weight: 600; margin: 0; }
.run { font-family: var(--vscode-editor-font-family); font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pills { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.hpill { display: inline-flex; align-items: center; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; font-size: 0.9em; background: var(--card); }
.hpill.good { color: var(--good); border-color: var(--good); }
.hpill.info { color: var(--info); border-color: var(--info); }
/* Tinted ground + ordinary foreground: the pill stays readable in every
   theme, and the warning tone is carried by its border and its dot. */
.hpill.warn { color: var(--vscode-foreground); border-color: var(--warn-border); background: var(--warn-surface); font-weight: 600; }
.hpill.warn .icon { color: var(--warn); }
/* A historical stage is not the live thing: dashed, quiet, unmistakably a record. */
.hpill.history { color: var(--vscode-descriptionForeground); border-style: dashed; background: none; }

.run .plan { font-family: var(--vscode-font-family); font-weight: 600; color: var(--vscode-foreground); }
.run .sep { margin: 0 6px; }

.branchguard { padding: 12px 14px; margin: 8px 0 12px; border-left: 3px solid var(--bad); }
.branchguard h2 { font-size: 1.1em; }
.branchguard h2 .icon { color: var(--bad); }
.branch { font-family: var(--vscode-editor-font-family); font-weight: 600; color: var(--vscode-foreground); }
.hpill.bad { color: var(--bad); border-color: var(--bad); }
.hpill .icon { width: 11px; height: 11px; margin-right: 5px; }

.action { padding: 12px 14px 12px; margin: 8px 0 12px; border-left: 3px solid var(--warn-border); }
.action.ready { border-left-color: var(--good); }
.action.ready h2 .icon { color: var(--good); }
.failure { display: flex; align-items: flex-start; margin-top: 6px; color: var(--bad); }
.action.escalate { border-left-color: var(--bad); }
.action h2 { font-size: 1.1em; }
.action h2 .icon { color: var(--warn); }
.action.escalate h2 .icon { color: var(--bad); }
.action .summary { margin: 4px 0 0; font-weight: 600; }
.action .reason { margin: 0 0 4px; }
.action .checks { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.action h3 .progress { margin-left: auto; font-weight: 600; color: var(--info); font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
.small { font-size: 0.88em; }
.action .part { margin-top: 8px; }
.action h4 { margin: 0 0 3px; font-size: 0.9em; font-weight: 600; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
.tag { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 0.78em; font-weight: 600; vertical-align: 1px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.tag.plan { border-color: var(--info); color: var(--info); }
.tag.reviewer { border-color: var(--codex); color: var(--codex); }
.checklist { list-style: none; margin: 4px 0 0; padding: 0; }
.check { padding: 6px 0 8px; border-top: 1px dashed var(--line); }
.check:first-child { border-top: none; }
.checkrow { display: flex; gap: 10px; align-items: flex-start; }
.check .mark { flex: none; width: 18px; text-align: center; font-weight: 700; color: var(--vscode-descriptionForeground); }
.check.pass .mark { color: var(--good); }
.check.fail .mark { color: var(--bad); }
.check.blocked .mark { color: var(--warn); }
.checkbody { flex: 1 1 auto; min-width: 0; }
.criterion { margin: 0 0 2px; white-space: pre-wrap; }
.criterion.parent { padding: 4px 10px; border-left: 2px solid var(--info); background: var(--vscode-textBlockQuote-background); }
.check.done .criterion { color: var(--vscode-descriptionForeground); }
.outcome { font-weight: 600; }
.outcome.pass { color: var(--good); }
.outcome.fail { color: var(--bad); }
.outcome.blocked { color: var(--warn); }
.evidence { margin: 0; font-family: var(--vscode-editor-font-family); }
.record { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0 0 28px; flex-wrap: wrap; }
.choices { display: inline-flex; gap: 0; flex: none; }
button.choice { border-radius: 0; margin-left: -1px; }
button.choice:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
button.choice:last-child { border-radius: 0 6px 6px 0; }
button.choice.on.pass { background: var(--good); color: var(--vscode-editor-background); border-color: var(--good); font-weight: 600; }
button.choice.on.fail { background: var(--bad); color: var(--vscode-editor-background); border-color: var(--bad); font-weight: 600; }
button.choice.on.blocked { background: var(--warn); color: var(--vscode-editor-background); border-color: var(--warn); font-weight: 600; }
textarea.note { flex: 1 1 240px; min-height: 26px; padding: 4px 8px; font-family: inherit; font-size: 0.92em; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 6px; resize: vertical; }
textarea.note:focus { outline: 1px solid var(--vscode-focusBorder); }
.action > .actions { margin-top: 12px; align-items: center; }

/* A submission in flight, and one that failed with everything preserved. */
.submitting { display: flex; align-items: center; margin: 8px 0 0; font-weight: 600; color: var(--info); }
.subfail { margin: 10px 0 0; padding: 8px 10px; border-left: 3px solid var(--bad); background: var(--vscode-textBlockQuote-background); }
.subfail .preserved { display: flex; align-items: flex-start; margin: 0; font-weight: 600; }
.subfail p.muted { margin: 4px 0 0; }
.subfail .actions { margin-top: 8px; }
pre.engineerror { margin: 6px 0 0; padding: 6px 8px; max-height: 9em; overflow: auto; background: var(--vscode-editor-background); border: 1px solid var(--line); border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: 0.88em; white-space: pre-wrap; overflow-wrap: anywhere; }

/* A permission, not a test: one sentence, one toggle, two answers. */
.action.push { border-left: 3px solid var(--info); }
.pushchoice { margin-top: 10px; }
.pushchoice .toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.pushchoice .toggle input { margin: 0; }
.autopush { display: inline-flex; align-items: center; gap: 6px; margin: 0 0 8px; color: var(--good); font-weight: 600; }

/* The freeform channel: beside the checks, never inside one of them. */
.feedback { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.feedback h4 { margin: 0 0 2px; }
.feedback .helper { margin: 0 0 6px; }
textarea.freeform { display: block; width: 100%; box-sizing: border-box; min-height: 58px; padding: 6px 8px; font-family: inherit; font-size: 0.92em; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 6px; resize: vertical; }
textarea.freeform:focus { outline: 1px solid var(--vscode-focusBorder); }
pre.sent { margin: 6px 0 0; padding: 6px 10px; border-left: 2px solid var(--line); background: var(--vscode-textBlockQuote-background); font-family: var(--vscode-editor-font-family); font-size: 0.92em; white-space: pre-wrap; overflow-wrap: anywhere; }

/* One structured gate: the requirement, the steps, the pass line. */
.action.gate .checks { margin-top: 10px; padding-top: 10px; }
.gatetitle { font-size: 1.05em; font-weight: 600; margin: 0 0 6px; }
.action .progress { margin: 0 0 4px; }
.checklist.gate .check { border-top: none; padding: 0; }
.check.task .checkbody { margin-left: 0; }
.check.task .instruction { margin: 0 0 6px; }
.steps { margin: 0 0 6px; padding-left: 20px; }
.steps li { margin: 0 0 2px; line-height: 1.45; }
.passif { margin: 0 0 2px; }
.passif .lead { font-weight: 600; color: var(--vscode-descriptionForeground); }
.checklist.gate .record { margin-left: 0; margin-top: 10px; }
.source { margin: 4px 0 0; }
/* What the check is called, and the one action that acts on it alone. */
.checkmeta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0 0 28px; }
.checklist.gate .checkmeta { margin-left: 0; }
.checkid { font-family: var(--vscode-editor-font-family); }
button.small { padding: 2px 8px; font-size: 0.85em; }

/* The demoted layers: technical details, previous evidence, other actions. */
details.tech, details.prev { margin-top: 10px; font-size: 0.92em; }
details.tech > summary, details.prev > summary, details.more > summary { cursor: pointer; color: var(--vscode-descriptionForeground); width: fit-content; }
details.tech > summary:hover, details.prev > summary:hover, details.more > summary:hover { color: var(--vscode-foreground); }
details.tech > summary:focus-visible, details.more > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.techlist { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; padding: 8px 0 0; border-top: 1px solid var(--line); font-size: 0.95em; }
.techlist dt { color: var(--vscode-descriptionForeground); }
.techlist dd { margin: 0; white-space: pre-wrap; }
details.more { display: inline-block; }
details.more > summary { padding: 4px 11px; border: 1px solid var(--line); border-radius: 6px; font-size: 0.92em; list-style: none; }
details.more > summary::-webkit-details-marker { display: none; }
details.more .actions { margin-top: 6px; }

.banner { margin: 8px 0 10px; padding: 6px 10px; border-left: 3px solid var(--info); background: var(--vscode-textBlockQuote-background); font-weight: 600; }
.banner.stop, .banner.warn { border-left-color: var(--warn); }
.banner.done { border-left-color: var(--good); }
.note { margin: 6px 0 10px; }

.journey { list-style: none; display: flex; align-items: flex-start; margin: 14px 0 16px; padding: 0; overflow-x: auto; }
.step { position: relative; display: flex; flex-direction: column; align-items: center; flex: 1 1 0; min-width: 72px; text-align: center; }
.step:not(:last-child)::after { content: ""; position: absolute; top: 13px; left: 50%; width: 100%; border-top: 2px solid var(--line); z-index: 0; }
.step.accepted:not(:last-child)::after { border-top-color: var(--good); }
.node { position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--line); color: var(--vscode-foreground); font-weight: 600; font-size: 0.8em; }
.node .icon { margin: 0; width: 14px; height: 14px; }
.step.accepted .node { background: var(--good); color: var(--vscode-editor-background); }
.step.active .node { background: var(--info); color: var(--vscode-editor-background); }
.step.paused .node { background: var(--warn); color: var(--vscode-editor-background); }
.step.finalizing .node { background: var(--info); color: var(--vscode-editor-background); }
.step.current .node { box-shadow: 0 0 0 3px var(--vscode-editor-background), 0 0 0 4px currentColor; }
.step.active.current .node { box-shadow: 0 0 0 3px var(--vscode-editor-background), 0 0 0 4px var(--info); }
.step.paused.current .node { box-shadow: 0 0 0 3px var(--vscode-editor-background), 0 0 0 4px var(--warn); }
.num { margin-top: 6px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.name { display: block; max-width: 100%; padding: 0 4px; font-size: 0.9em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state { display: inline-flex; align-items: center; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.state .icon { width: 11px; height: 11px; margin-right: 3px; }
.step.accepted .state { color: var(--good); }
.step.active .state { color: var(--info); }
.step.paused .state { color: var(--warn); }
.step.finalizing .state { color: var(--info); }

.card { border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
.stage { padding: 12px 14px 10px; margin: 0 0 10px; }
.stagehead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
h2 { display: flex; align-items: center; font-size: 1.3em; font-weight: 600; margin: 0 0 2px; line-height: 1.3; }
h2 .icon { width: 16px; height: 16px; margin-right: 8px; }
h2 .icon.ready, h2 .icon.accepted { color: var(--good); }
h2 .icon.send_back, h2 .icon.needs_you { color: var(--warn); }
h2 .icon.escalate { color: var(--bad); }
.substatus { font-size: 0.95em; }
.status { font-weight: 600; color: var(--info); }
.status.ready, .status.accepted { color: var(--good); }
.status.send_back, .status.needs_you { color: var(--warn); }
.status.escalate { color: var(--bad); }
.status.finalizing { color: var(--info); }
.status.stopped { color: var(--warn); }
/* The stage on screen is history; the live managed run is elsewhere. */
.elsewhere { margin: 0 0 10px; padding: 6px 8px; border-left: 2px solid var(--warn-border); background: var(--warn-surface); color: var(--vscode-foreground); }
.next { font-weight: 600; }
.complete { color: var(--good); font-weight: 600; }
.whatsnext .nextstage { font-size: 1.15em; font-weight: 600; margin: 2px 0 2px; }
.whatsnext .summary { margin-bottom: 6px; }
.whatsnext .actions { margin: 8px 0 6px; }
.whatsnext .matched { font-size: 0.9em; }
.columns { display: grid; grid-template-columns: 3fr 2fr; gap: 0 18px; margin-top: 12px; }
.columns.single { grid-template-columns: 1fr; }
.columns.single .col.right { border-left: none; padding-left: 0; }
.col.right { border-left: 1px solid var(--line); padding-left: 18px; }
.block { padding: 6px 0 10px; }
.col .block + .block { border-top: 1px solid var(--line); padding-top: 10px; }
.col.right .block + .block { border-top: none; }
h3 { display: flex; align-items: center; font-size: 0.95em; font-weight: 600; margin: 0 0 4px; color: var(--vscode-foreground); }
h3 .icon { width: 15px; height: 15px; }
p { margin: 0 0 4px; line-height: 1.45; }
.goal { color: var(--vscode-foreground); }
.verdict { font-weight: 700; letter-spacing: 0.02em; color: var(--info); }
.verdict.ready { color: var(--good); }
.verdict.send_back, .verdict.needs_you { color: var(--warn); }
.verdict.escalate { color: var(--bad); }
.now { font-size: 1.05em; }
.dur { font-weight: 600; }
.who.claude { color: var(--claude); font-weight: 600; }
.who.codex { color: var(--codex); font-weight: 600; }
.who.other { font-weight: 600; }
.time { font-family: var(--vscode-editor-font-family); font-size: 0.92em; }

.actors { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 10px; }
.actor { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; line-height: 1.45; }
.avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; font-weight: 700; font-size: 1.05em; color: var(--vscode-editor-background); background: var(--line); }
.avatar.claude { background: var(--claude); }
.avatar.codex { background: var(--codex); }
.provider { font-weight: 600; font-size: 1.05em; }
.provider.claude { color: var(--claude); }
.provider.codex { color: var(--codex); }
.activity { display: flex; align-items: center; }
.activity .icon.dot { color: var(--vscode-descriptionForeground); }
.activity.working, .activity.sparring { color: var(--good); font-weight: 600; }
.activity.working .icon.dot, .activity.sparring .icon.dot { color: var(--good); }
.session { font-family: var(--vscode-editor-font-family); font-size: 0.85em; }

/* An actor card that carries a captured prompt is a disclosure. Opening it
   spans the full width of the grid, so the prompt is read at the width of
   the rest of the UI instead of in a half-width column. */
details.actor { display: block; padding: 0; }
details.actor > summary { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; line-height: 1.45; cursor: pointer; list-style: none; }
details.actor > summary::-webkit-details-marker { display: none; }
details.actor > summary .who { flex: 1 1 auto; min-width: 0; }
details.actor[open] { grid-column: 1 / -1; }
.showinstr { flex: none; align-self: center; font-size: 0.85em; color: var(--vscode-textLink-foreground); }
details.actor[open] .showinstr::after { content: ' ▾'; }
details.actor:not([open]) .showinstr::after { content: ' ▸'; }

.instructions { padding: 0 12px 12px; border-top: 1px solid var(--line); }
.turnline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 0; font-size: 1.02em; }
.turnchip { flex: none; padding: 1px 8px; border: 1px solid var(--line); border-radius: 10px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
.turnchip.live { border-color: var(--good); color: var(--good); font-weight: 600; }
.promptsec { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 6px; background: var(--vscode-editor-background); }
.promptsec > summary { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 6px 10px; cursor: pointer; }
.sechead { font-weight: 600; }
.secsrc { font-size: 0.85em; }
.prompttext { margin: 0; padding: 8px 10px; border-top: 1px solid var(--line); font-family: var(--vscode-editor-font-family); font-size: 0.88em; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 22em; overflow-y: auto; }
.promptsec.exact { margin-top: 10px; }
.linkish { padding: 0; border: none; background: none; color: var(--vscode-textLink-foreground); font-size: 0.85em; cursor: pointer; }
.linkish:hover { text-decoration: underline; background: none; }
.note { margin: 6px 0; font-size: 0.9em; color: var(--vscode-descriptionForeground); }

.history { margin: 0 0 10px; }
.history ol { list-style: none; margin: 0; padding: 0; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
.history li { display: grid; grid-template-columns: max-content max-content 1fr; gap: 0 10px; line-height: 1.55; }
.history li:last-child { color: var(--vscode-foreground); }

.actions { display: flex; flex-wrap: wrap; gap: 6px; }
button { font-family: inherit; font-size: 0.92em; padding: 4px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.danger { color: var(--warn); border-color: var(--warn); }
button.quiet { background: transparent; color: var(--vscode-descriptionForeground); }
.busy { display: inline-flex; align-items: center; padding: 4px 11px; border: 1px solid var(--good); border-radius: 6px; font-size: 0.92em; color: var(--good); font-weight: 600; cursor: help; }
.busy.unknown { border-color: var(--warn); color: var(--warn); }
.busy.accepting { border-color: var(--info); color: var(--info); }
.stopped, .stale, .inferred { display: flex; align-items: center; color: var(--warn); }
.activity.uncertain { color: var(--warn); }
.activity.uncertain .icon.dot { color: var(--warn); }

.facts { display: grid; grid-template-columns: max-content 1fr; gap: 1px 12px; margin: 0; padding-top: 8px; border-top: 1px solid var(--line); font-size: 0.82em; color: var(--vscode-descriptionForeground); }
.facts dt { color: var(--vscode-descriptionForeground); }
.facts dd { margin: 0; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The repository context, above everything. Quiet while following; stated
   plainly, with a left rule, while a pin is in force. */
.repocontext { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); font-size: 0.86em; }
.repocontext .names { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.repocontext .line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.repocontext .headline { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); }
.repocontext .name { font-weight: 600; color: var(--vscode-foreground); overflow-wrap: anywhere; }
.repocontext .actions { margin: 0; gap: 6px; }
.repocontext.pinned { padding-left: 8px; border-left: 2px solid var(--vscode-textLink-foreground); }
/* A pin holding the cockpit away from the repository this window is in is the
   one state where the screen can disagree with the Source Control view. */
.repocontext.away { border-left-color: var(--warn-border); }
.repocontext .pin { flex: none; opacity: 0.85; }

@media (max-width: 640px) {
  .columns { grid-template-columns: 1fr; }
  .col.right { border-left: none; padding-left: 0; border-top: 1px solid var(--line); padding-top: 8px; }
  .actors { grid-template-columns: 1fr; }
}
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (event) {
    var element = event.target instanceof Element ? event.target : null;
    var choice = element ? element.closest('button[data-check][data-outcome]') : null;
    if (choice && !choice.disabled) {
      vscode.postMessage({ type: 'humanCheck', key: choice.getAttribute('data-check'), outcome: choice.getAttribute('data-outcome') });
      return;
    }
    var copy = element ? element.closest('button[data-copy]') : null;
    if (copy && !copy.disabled) {
      var scope = copy.getAttribute('data-copy');
      var forCheck = copy.getAttribute('data-check');
      vscode.postMessage(forCheck === null ? { type: 'copy', scope: scope } : { type: 'copy', scope: scope, key: forCheck });
      return;
    }
    var openSource = element ? element.closest('button[data-openprompt]') : null;
    if (openSource && !openSource.disabled) {
      // Defensive: this button sits inside a <summary>, and a <summary>'s
      // activation toggles the section it heads. Chromium already declines
      // to toggle when the click lands on an interactive descendant, so
      // removing this changes nothing today (the integration test passes
      // either way) -- but the correct behaviour then depends on the
      // element staying a <button>, which is not a thing this file should
      // have to remember.
      event.preventDefault();
      vscode.postMessage({ type: 'openPromptSource', source: openSource.getAttribute('data-openprompt') });
      return;
    }
    var copyPrompt = element ? element.closest('button[data-copyprompt]') : null;
    if (copyPrompt && !copyPrompt.disabled) {
      vscode.postMessage({ type: 'copyPrompt', role: copyPrompt.getAttribute('data-copyprompt') });
      return;
    }
    var target = element ? element.closest('button[data-action]') : null;
    if (!target || target.disabled) { return; }
    vscode.postMessage({ type: 'action', action: target.getAttribute('data-action') });
  });
  // The auto-push toggle. It reports as it is ticked, so the choice survives
  // a rerender of the page; it authorizes nothing on its own -- Allow push is
  // what runs an engine command, and it reads this choice from the host.
  document.addEventListener('change', function (event) {
    var box = event.target;
    if (!(box instanceof HTMLInputElement) || !box.hasAttribute('data-autopush')) { return; }
    vscode.postMessage({ type: 'autoPush', enabled: box.checked });
  });
  // Every text field is saved as it is typed (debounced) and on blur, so a
  // re-render of the page never loses what was typed; the extension stores it
  // as a draft. A check note carries the check's key; the freeform findings
  // field carries no key and is posted as its own message type.
  var timers = {};
  function tracked(area) {
    return area instanceof HTMLTextAreaElement && (area.hasAttribute('data-check') || area.hasAttribute('data-feedback'));
  }
  function timerKey(area) {
    return area.hasAttribute('data-feedback') ? 'feedback:' + area.getAttribute('data-feedback') : 'check:' + area.getAttribute('data-check');
  }
  function save(area) {
    if (area.hasAttribute('data-feedback')) {
      vscode.postMessage({ type: 'humanFeedback', text: area.value });
      return;
    }
    vscode.postMessage({ type: 'humanCheck', key: area.getAttribute('data-check'), note: area.value });
  }
  document.addEventListener('input', function (event) {
    var area = event.target;
    if (!tracked(area)) { return; }
    var key = timerKey(area);
    clearTimeout(timers[key]);
    timers[key] = setTimeout(function () { save(area); }, 400);
  });
  document.addEventListener('focusout', function (event) {
    var area = event.target;
    if (!tracked(area)) { return; }
    clearTimeout(timers[timerKey(area)]);
    save(area);
  });
})();
`;
