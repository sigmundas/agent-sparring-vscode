/**
 * Pure HTML renderer for the Run Overview webview. Every dynamic string is
 * escaped; no filesystem paths, session ids beyond their shortened form, or
 * secrets are placed in the document. The only script is a nonce'd
 * click-to-postMessage shim for the action buttons.
 *
 * Icons are small inline SVGs (the CSP allows no remote images or fonts) and
 * every colour is a VS Code theme variable, so the page follows the user's
 * theme. No provider logos: an actor's avatar carries a role glyph instead
 * (spectacles-and-pens for the stage agent, gloves for the sparrer).
 *
 * Layout: header with status pills; plan journey; the current-stage card
 * (Goal + latest sparring result on the left, current activity + last
 * meaningful event on the right); provider cards; recent events; metadata.
 */

import { ACTIVE_CONTEXT_HEADLINE, FOLLOW_ACTIVE_LABEL, SELECT_RUN_LABEL } from "./activeRepository";
import {
  CONFIG_FIELDS,
  CONFIG_ROLES,
  PROVIDER_DEFAULT_VALUE,
  type AgentFieldControl,
  type AgentRoleControls,
  type ConfigField,
  type ConfigRole,
} from "./effectiveConfig";
import { CHECK_OUTCOMES, isCheckKey, type CheckItem, type CheckOutcome } from "./humanChecks";
import { checkName, humanTask, splitPassCriteria } from "./humanTask";
import { RUN_KIND, TIMELINE_STATE_WORD, type ActionRequired, type AgentConfigSection, type BranchGuard, type ActorCard, type HistoryEntry, type OverviewModel, type PushAuthorization, type TimelineItem, type WhatsNext } from "./overviewModel";
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
  | "openPlanSection"
  | "submitForReview"
  | "sendFeedbackForReview"
  | "dismissSubmissionFailure"
  | "confirmRunnerInactive"
  | "allowPush"
  | "doNotAllowPush"
  | "openSettings";

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

/**
 * A Stop click: interrupt one exact execution.
 *
 * It carries the execution id it was rendered with, and that is the whole
 * point of its being its own message type rather than an action. An action
 * says "the person pressed Stop" and the host would then have to work out
 * *what* to stop — which, by the time the click arrives, may be a runner
 * that started after this page was drawn. A panel can only ever ask for
 * the runner it was showing, and the host refuses when that is no longer
 * the one the run is waiting on.
 */
export interface StopMessage {
  type: "stop";
  executionId: string;
}

/** An execution id as this renderer writes it: `<epoch ms>-<counter>`. */
const EXECUTION_ID = /^[0-9]{1,20}-[0-9]{1,10}$/;

export function isStopMessage(message: unknown): message is StopMessage {
  const record = asRecord(message);
  return record !== undefined && record["type"] === "stop" && typeof record["executionId"] === "string" && EXECUTION_ID.test(record["executionId"] as string);
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

/**
 * One inline agent-configuration change: a model typed, or an effort chosen.
 *
 * It is its own message type, not an action, because it carries a value that
 * becomes an argument to an engine command — and it carries `scope`, the
 * project.toml the control was rendered from. The host refuses a message
 * whose scope is not the repository it is now looking at, which is what
 * stops a control left open across a repository switch from writing to the
 * wrong project. `value` is `null` for "use the provider's default", which
 * clears the override; it is never the words "provider default".
 */
export interface AgentConfigMessage {
  type: "agentConfig";
  role: ConfigRole;
  field: ConfigField;
  value: string | null;
  scope: string;
}

/**
 * A model name is free text, so it is bounded here the way a note is: long
 * enough for any identifier a provider could plausibly have, short enough
 * that the message cannot be a payload. The engine validates what it means.
 *
 * No control on the page posts a model any more — the cards show it and
 * project.toml changes it — but `set-config <role> --model` is still the
 * engine's own mutation, so the wire keeps accepting and bounding one.
 */
export const MODEL_MAX_LENGTH = 200;

export function isAgentConfigMessage(message: unknown): message is AgentConfigMessage {
  const record = asRecord(message);
  if (!record || record["type"] !== "agentConfig") {
    return false;
  }
  if (!(CONFIG_ROLES as readonly string[]).includes(String(record["role"]))) {
    return false;
  }
  if (!(CONFIG_FIELDS as readonly string[]).includes(String(record["field"]))) {
    return false;
  }
  if (typeof record["scope"] !== "string" || !record["scope"]) {
    return false;
  }
  const value = record["value"];
  if (value === null) {
    // "Use the provider's default" is only meaningful for an override. A
    // role always resolves to some provider, so there is nothing to clear.
    return record["field"] !== "provider";
  }
  // Not trimmed or emptied here: a blank value means "clear", and turning it
  // into one silently would make two different requests look the same on the
  // wire. The webview sends null for a clear; anything else must be a value.
  return typeof value === "string" && value.length > 0 && value.length <= MODEL_MAX_LENGTH;
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
  "openPlanSection",
  "submitForReview",
  "sendFeedbackForReview",
  "dismissSubmissionFailure",
  "confirmRunnerInactive",
  "allowPush",
  "doNotAllowPush",
  "openSettings",
];

const ACTIONS: ReadonlySet<string> = new Set<string>(OVERVIEW_ACTIONS);

/**
 * The stable identity a disclosure's open/closed state is remembered
 * under: what the section belongs to, never where it sits.
 *
 * `scope` is the stage the page is drawn for — the strongest identity the
 * model carries, and the one that changes when the page starts describing
 * different work. `what` names the section within it: the actor's role
 * plus the kind of section, so the stage agent's instructions and the
 * sparrer's are two keys and the run's technical details is a third.
 *
 * Position is deliberately not part of it. Keyed by index, the third
 * prompt section of one stage would inherit the third of the next, and a
 * new actor's card would open because the last one's was.
 */
function disclose(scope: string, ...what: (string | undefined)[]): string {
  return ` data-disclose="${escapeHtml([scope, ...what.filter((part) => part !== undefined && part !== "")].join("/"))}"`;
}

/**
 * What identifies the work this page is about, for disclosure keys.
 *
 * The repository as well as the stage, because a stage id is unique within
 * a project and not across them: the same plan run in two worktrees has the
 * same `stage-3d-…` on both sides, and keying on the stage alone would let
 * one of them open the other's sections.
 *
 * The repository is named the way the page already names it — the folder,
 * not its path — because this document deliberately carries no filesystem
 * paths. That is weaker than the full-path identity attribution uses
 * (operationRegistry.ts), and deliberately so: what is at stake here is
 * whether a section is expanded, so two identically-named folders showing
 * the same stage id sharing that is not worth a path in the markup.
 */
function discloseScope(model: OverviewModel): string {
  const repository = model.repositoryContext?.repository ?? "";
  return `${repository}:${model.stageId ?? model.title}`;
}

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
  gear: '<circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
};

function icon(name: keyof typeof ICON, cls = ""): string {
  return `<svg class="icon ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICON[name]}</svg>`;
}

// Role glyphs drawn inside the actor avatar circle: spectacles-and-pens for the
// stage agent, gloves for the sparrer. Traced from icons/sstage.svg and
// icons/sparring.svg; each keeps that file's viewBox and group transform, and
// is filled with currentColor so the circle's foreground colour applies.
const AVATAR_GLYPH: Record<"stage" | "sparrer", { viewBox: string; body: string }> = {
  stage: {
    viewBox: "0 0 82.85601 88.02034",
    body:
      '<g transform="translate(67.803234,-237.29847)" fill="currentColor">' +
      '<path d="m -49.634473,325.07045 c -0.2227,-0.36034 0.30085,-1.26018 0.92873,-1.59621 0.30867,-0.16519 0.5231,-0.55332 0.5231,-0.94681 0,-0.36677 0.67491,-1.8211 1.499799,-3.23184 2.11796,-3.6222 2.35444,-3.89425 3.29883,-3.79519 0.76539,0.0803 0.78452,0.0551 0.62096,-0.81671 -0.20201,-1.07681 19.04271,-20.31037 20.32216,-20.31037 0.18487,0 1.34447,1.09133 2.57688,2.42518 1.23241,1.33385 2.38957,2.5755 2.57148,2.75923 0.63043,0.63675 0.31559,1.08233 -2.77813,3.93184 -1.70987,1.57489 -4.29948,4.0153 -5.75469,5.42314 -9.92858,9.60541 -15.84124,13.96201 -21.034369,15.49866 -0.3638,0.10765 -0.89631,0.35828 -1.18335,0.55696 -0.61048,0.42256 -1.36349,0.47088 -1.5914,0.10212 z m 39.221099,-25.5092 c -0.96408,-0.73185 -0.47983,-1.33901 6.5984604,-8.2731 6.53631,-6.40317 7.03688,-6.95808 6.68277,-7.40834 -0.90826,-1.15483 -1.05747,-1.08849 -4.01412,1.78483 -15.2292304,14.79998 -13.7826304,13.75646 -15.6486104,11.28836 -0.79764,-1.05503 -1.99495,-2.44904 -2.66068,-3.0978 -1.43492,-1.39834 -1.46575,-1.60125 -0.38192,-2.51324 0.45568,-0.38343 2.86669,-2.6469 5.35781,-5.02994 4.08282,-3.90567 7.4227804,-6.85773 12.3577804,-10.92256 1.46130005,-1.20364 1.83984005,-1.38907 2.83560005,-1.38907 1.02439995,0 1.31222995,-0.15317 2.65088995,-1.41076 2.83373,-2.6621 3.72629,-2.89987 5.23233,-1.39382 1.5955796,1.59558 1.12919,3.0957 -1.85906,5.97958 -1.23371,1.19063 -1.23371,1.19063 -1.06416,4.23334 0.21338,3.8292 0.0724,4.06947 -5.40071995,9.2008 -2.13034005,1.99732 -5.17849005,4.91141 -6.77367005,6.47576 -3.02359,2.96516 -3.15702,3.0496 -3.9127004,2.47596 z m -39.621349,-30.44839 c -5.98001,-1.37824 -11.3909,-6.61034 -12.3206,-11.91351 -0.38427,-2.19194 -0.71618,-2.51354 -2.59415,-2.51354 -3.920911,0 -3.744961,-4.81424 0.17961,-4.91398 0.90104,-0.0229 1.76418,-0.0577 1.91808,-0.0774 0.15389,-0.0196 0.49288,-0.54175 0.7533,-1.16021 5.70264,-13.54282 21.429029,-15.18412 29.325479,-3.06059 0.87406,1.34197 1.4445,1.98457 1.63213,1.83861 1.43733,-1.11814 5.51535,-1.40551 7.96844,-0.56152 1.94159,0.668 2.19963,0.57788 3.13806,-1.09597 6.63664,-11.83759 29.5309004,-9.26572 29.5309004,3.31741 0,0.43151 0.8509896,1.00045 1.3920496,0.93068 2.4496,-0.31586 4.1642,0.72407 4.1642,2.52565 0,1.27727 -0.95682,2.25729 -2.20386,2.25729 -2.00029,0 -2.53384,0.25362 -2.71095,1.28864 -3.2086796,18.75086 -31.31134,17.3899 -32.0727,-1.55322 -0.1229,-3.05773 -0.19916,-3.23285 -1.75308,-4.0256 -1.89137,-0.9649 -4.67995,-0.65997 -6.17243,0.67495 -0.52917,0.47331 -0.59563,0.78458 -0.59818,2.80145 -0.0123,9.76507 -9.90794,17.46915 -19.576299,15.24083 z m 6.766709,-3.44089 c 6.22836,-1.62228 10.64769,-8.9933 8.9419,-14.91419 -3.08051,-10.69258 -15.286309,-13.4499 -22.141749,-5.00187 -7.51524,9.26111 1.55657,22.94875 13.199849,19.91606 z m 40.6878004,-0.0277 c 6.64627,-1.71137 11.15168,-9.88448 8.75773,-15.88711 -3.71312,-9.31035 -14.2012,-11.95198 -20.8991604,-5.26388 -9.23208,9.2185 -0.51208,24.40918 12.1414304,21.15099 z"/>' +
      "</g>",
  },
  sparrer: {
    viewBox: "0 0 97.584854 81.122635",
    body:
      '<g transform="translate(-76.921671,-237.31213)" fill="currentColor">' +
      '<path d="m 103.98368,316.53251 c -7.679331,-5.2402 -17.699747,-15.72719 -17.699747,-18.52386 0,-1.7009 1.006268,-2.6436 1.792138,-1.67895 0.258076,0.31678 1.25188,1.53864 2.208454,2.71525 5.695597,7.00562 11.106275,11.81421 13.611145,12.09654 3.38615,0.38167 9.21074,-5.47741 9.43946,-9.49533 0.11257,-1.97713 0.13382,-1.98657 2.73418,-1.21277 5.75785,1.71338 6.9533,3.2937 4.48449,5.92831 -1.06334,1.13474 -2.35687,2.58154 -2.87451,3.21509 -0.51763,0.63357 -1.01779,1.22598 -1.11144,1.31649 -0.0937,0.0906 -1.49407,1.61929 -3.11203,3.39729 -4.52882,4.97677 -5.22342,5.14117 -9.47214,2.24194 z m 35.8655,0.70312 c -2.287,-2.0055 -12.10986,-12.7235 -12.08158,-13.18258 0.007,-0.12972 1.57833,-1.49475 3.48965,-3.03337 3.52118,-2.83461 7.64723,-6.93386 11.17694,-11.10437 2.78329,-3.28853 2.90819,-3.4513 4.20873,-5.48439 0.64807,-1.01308 1.29122,-1.84129 1.42924,-1.84046 0.29226,10e-4 2.3902,1.92041 2.3902,2.18591 0,0.7527 -6.25161,8.24975 -9.70267,11.63562 -5.23031,5.13154 -5.21959,6.46366 0.0933,11.58527 5.29195,5.10146 9.54822,2.9788 18.77574,-9.36371 2.62169,-3.5067 2.74586,-3.59059 3.5341,-2.38757 1.58535,2.41954 -4.57055,10.43016 -13.48052,17.54207 -6.46323,5.15893 -7.47642,5.51417 -9.8331,3.44758 z m -37.15421,-9.62274 c -4.100492,-2.71606 -15.091215,-15.42453 -11.885623,-13.74325 2.237598,1.17359 6.697026,2.75405 9.955883,3.52845 11.12871,2.64454 11.74707,3.49606 6.44959,8.88152 -2.60456,2.64782 -2.55661,2.63368 -4.51985,1.33328 z m 40.92893,-0.75134 c -1.6235,-1.42206 -3.50128,-3.64183 -3.85041,-4.55166 -0.12607,-0.32853 0.49602,-1.17775 1.80158,-2.45934 1.09678,-1.07663 2.98845,-3.14236 4.20371,-4.59048 1.21526,-1.44813 2.41391,-2.84662 2.66365,-3.10776 0.24976,-0.26112 1.26866,-1.55703 2.26425,-2.87979 2.16535,-2.87693 1.54853,-2.85075 4.61185,-0.19568 5.2959,4.59012 5.28381,4.01299 0.21591,10.29723 -6.61374,8.20111 -9.22311,9.84148 -11.91054,7.48748 z m -19.49115,-5.61718 c -0.45253,-0.23623 -1.78548,-0.96464 -2.96208,-1.61869 -2.31798,-1.28855 -5.27602,-2.29072 -8.39256,-2.84338 -17.144494,-3.04022 -23.163212,-5.57013 -29.403305,-12.3594 -3.186274,-3.46669 -3.626185,-11.04933 -0.641029,-11.04933 1.708896,0 7.828727,4.0528 7.828727,5.1845 0,1.72901 2.235335,3.23795 2.762309,1.86467 1.253376,-3.26624 -0.533841,-5.38567 -7.369995,-8.73994 -7.269835,-3.56709 -9.063728,-5.78044 -9.032754,-11.14492 0.04441,-7.68029 10.812528,-19.22294 20.551968,-22.03009 0.814568,-0.23477 1.910423,-0.5577 2.435232,-0.71759 7.305537,-2.22587 17.040407,3.41013 25.985207,15.04409 0.56969,0.74097 2.34868,2.92208 3.95329,4.84693 1.60462,1.92484 3.60402,4.44685 4.44312,5.60445 6.74066,9.29928 6.3662,8.73435 8.86838,13.37911 0.63385,1.1766 1.42557,2.53241 1.75938,3.01288 0.82721,1.19071 0.7945,1.35469 -0.71314,3.5748 -2.92579,4.30841 -7.38877,9.18538 -12.60533,13.77461 -5.59478,4.92198 -5.84582,5.06374 -7.46742,4.2173 z M 96.0869,247.32765 c 5.6246,-3.65996 10.88746,-3.39742 15.40705,0.76859 1.68332,1.55164 2.92128,1.56194 3.30639,0.0275 0.57105,-2.27522 -6.55148,-6.33024 -11.13926,-6.34182 -5.962522,-0.0151 -15.647304,6.3107 -11.205917,7.31931 0.686258,0.15585 0.607468,0.19432 3.631737,-1.77359 z m 57.50211,35.9857 c -0.90509,-0.86424 -2.38612,-2.10878 -3.29121,-2.76567 -2.1904,-1.58974 -3.1685,-2.69087 -4.36962,-4.9193 -2.36673,-4.39094 -8.60573,-13.64209 -9.62517,-14.27214 -0.53295,-0.32937 -0.36247,-1.48178 0.25403,-1.71715 0.31678,-0.12091 1.41718,-0.69481 2.44536,-1.27526 2.08923,-1.17947 2.09335,-1.17801 3.36505,1.18669 5.20473,9.67816 18.06421,15.26033 24.71548,10.72876 3.65355,-2.4892 2.34914,-4.81893 -1.39497,-2.49147 -4.87744,3.03199 -10.50082,1.40806 -16.81552,-4.85603 -5.67102,-5.62558 -6.51082,-9.39215 -4.00347,-17.95613 0.50153,-1.713 0.18478,-2.53937 -0.97333,-2.53937 -1.0085,0 -1.9904,1.12124 -1.9904,2.27283 0,0.96139 -0.47714,1.08808 -1.32582,0.35202 -0.4139,-0.35897 -1.32352,-0.80642 -2.02139,-0.99434 -2.52077,-0.67877 0.88616,-3.81074 6.73618,-6.19252 1.81942,-0.74076 7.50164,-0.29975 8.60746,0.66804 0.17196,0.1505 0.49297,0.27364 0.71333,0.27364 1.4662,0 9.05663,5.40904 12.54836,8.94213 11.2745,11.40802 9.70615,20.44345 -5.67546,32.69711 -0.90509,0.72102 -1.71966,1.38704 -1.81017,1.48003 -3.02915,3.11244 -4.03419,3.33991 -6.08872,1.37813 z m -22.38017,-28.58481 c -3.58148,-4.41097 -3.91016,-5.02994 -3.02228,-5.69143 3.82521,-2.8498 9.57298,-3.33026 11.56196,-0.96649 2.55014,3.03067 0.72148,7.10381 -4.02094,8.95621 -2.02688,0.79172 -1.99783,0.80649 -4.51874,-2.29829 z"/>' +
      "</g>",
  },
};

function avatarGlyph(role: "stage" | "sparrer"): string {
  const glyph = AVATAR_GLYPH[role];
  return `<svg class="glyph" viewBox="${glyph.viewBox}" width="22" height="22" aria-hidden="true">${glyph.body}</svg>`;
}

// ---------------------------------------------------------------- body

function renderBody(model: OverviewModel): string {
  if (model.kind === "empty") {
    // The title names the repository, so an empty screen cannot be mistaken
    // for the cockpit still looking at the repository just left behind.
    return `${renderRepositoryContext(model)}
<header class="top"><div><h1>Agent Sparring</h1><div class="run muted">${escapeHtml(model.title)}</div></div></header>
${(model.emptyLines ?? []).map((line) => `<p class="muted">${escapeHtml(line)}</p>`).join("\n")}
${renderActors(model, discloseScope(model))}
<div class="actions">${button("runPlan", "Run plan…")}${button("showLog", "Show log")}</div>`;
  }
  if (model.kind === "ambiguous") {
    return `${renderRepositoryContext(model)}
<header class="top"><h1>Agent Sparring</h1></header>
<p>${escapeHtml(model.title)}:</p>
<ul>${(model.choices ?? []).map((choice) => `<li>${escapeHtml(choice)}</li>`).join("")}</ul>
<div class="actions">${button("showLog", "Show log")}</div>`;
  }

  // One identity for every disclosure on this page (see `disclose`).
  const scope = discloseScope(model);
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
    parts.push(renderPushAuthorization(model.pushAuthorization, scope));
  } else if (model.actionRequired) {
    parts.push(renderActionRequired(model, model.actionRequired, scope));
  } else if (model.banner) {
    parts.push(`<div class="banner ${model.banner.kind}">${escapeHtml(model.banner.text)}</div>`);
  }
  if (model.timeline && model.timeline.length > 0) {
    parts.push(renderJourney(model.timeline));
  } else if (model.timelineNote) {
    parts.push(`<p class="muted note">${escapeHtml(model.timelineNote)}</p>`);
  }
  parts.push(renderStageCard(model));
  parts.push(renderActors(model, scope));
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
function renderPushAuthorization(panel: PushAuthorization, scope: string): string {
  const toggle = `<label class="toggle" title="${escapeHtml(panel.autoPush.detail)}"><input type="checkbox" data-autopush="run"${panel.autoPush.checked ? " checked" : ""}> ${escapeHtml(panel.autoPush.label)}</label>`;
  // The same demoted layer, the same markup, as every other panel's: the
  // engine's vocabulary is one disclosure away, never deleted.
  const rows = panel.technical.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`).join("");
  const details = panel.technical.length > 0 ? `<details class="tech"${disclose(scope, "push", "technical")}><summary>Show technical details</summary><dl class="techlist">${rows}</dl></details>` : "";
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
function renderActionRequired(model: OverviewModel, panel: ActionRequired, scope: string): string {
  const gate = panel.gateTitle !== undefined;
  const summary = panel.subtitle ? `<p class="summary">${escapeHtml(panel.subtitle)}</p>` : panel.summary ? `<p class="summary">${escapeHtml(panel.summary)}</p>` : "";
  // With a structured gate the reviewer's own note is a restatement of the
  // gate title; it belongs to the details layer, where the verbatim wording
  // lives. Without one it is the only compact statement there is.
  const note = !gate && panel.reviewerNote ? `<p class="reason"><span class="tag reviewer">Reviewer note</span> ${escapeHtml(panel.reviewerNote)}</p>` : "";
  const failure = panel.reviewFailure ? `<p class="failure">${icon("warn", "escalate")}${escapeHtml(panel.reviewFailure)}</p>` : "";
  const submission = renderSubmissionState(panel);
  const body = gate ? renderGateChecks(panel, scope) : renderDerivedChecks(panel);
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
      `<details class="more"${disclose(scope, "other-actions")}><summary title="Other things that can be run from here">…</summary><div class="actions">${button(panel.resume.action, `${panel.resume.label} (implementation)`, true, panel.resume.detail, "quiet")}</div></details>`,
    );
  }
  return `<section class="card action ${panel.kind}${panel.ready ? " ready" : ""}${gate ? " gate" : ""}">
<div class="actionhead"><h2>${icon(panel.ready && panel.kind === "needs_you" ? "check" : "warn", panel.ready && panel.kind === "needs_you" ? "ready" : panel.kind)}${escapeHtml(panel.headline)}</h2>${summary}${note}${failure}</div>
${submission}
${body}
${renderFeedbackField(panel, scope)}
${renderTechnical(panel, scope)}
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
function renderFeedbackField(panel: ActionRequired, scope: string): string {
  const draft = panel.feedback.draft ?? "";
  const previous =
    panel.feedback.submitted.length > 0
      ? `<details class="prev"${disclose(scope, "feedback-sent")}><summary>Feedback already sent (${panel.feedback.submitted.length})</summary>${panel.feedback.submitted.map((entry) => `<pre class="sent">${escapeHtml(entry)}</pre>`).join("")}</details>`
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
function renderGateChecks(panel: ActionRequired, scope: string): string {
  const total = panel.recorded.length + panel.required.length;
  const title = panel.gateTitle ? `<p class="gatetitle">${escapeHtml(panel.gateTitle)}</p>` : "";
  // Two or more checks: say how far along the evidence is. One check has no
  // progress worth reporting — the controls under it are the whole story.
  const progress = total > 1 && panel.progress ? `<p class="muted small progress">${escapeHtml(panel.progress)}</p>` : "";
  const required =
    panel.required.length > 0
      ? `<ol class="checklist gate">${panel.required.map((item, index) => renderTask(item, index + 1, total)).join("")}</ol>`
      : `<p class="muted">Every check the reviewer asked for has a recorded result.</p>`;
  return `<div class="checks">${title}${progress}${required}${renderPreviousEvidence(panel, scope)}</div>`;
}

/** Evidence already in notes.md, compact and collapsed; absent when there is none. */
function renderPreviousEvidence(panel: ActionRequired, scope: string): string {
  if (panel.recorded.length === 0) {
    return "";
  }
  return `<details class="prev"${disclose(scope, "previous-evidence")}><summary>Previous evidence (${panel.recorded.length})</summary><ol class="checklist recorded">${panel.recorded.map(renderRecorded).join("")}</ol></details>`;
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
function renderTechnical(panel: ActionRequired, scope: string): string {
  if (panel.technical.length === 0) {
    return "";
  }
  const rows = panel.technical.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`).join("");
  return `<details class="tech"${disclose(scope, "technical")}><summary>Show technical details</summary><dl class="techlist">${rows}</dl></details>`;
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
 *
 * "Can't test" is not a failure and is never dressed as one. It is styled
 * neutrally — grey, `⊘` — beside a red Fail, because the two say entirely
 * different things about the stage and a person scanning the list has to be
 * able to tell them apart at a glance.
 */
export const OUTCOME_LABELS: Record<CheckOutcome, string> = { pass: "Pass", fail: "Fail", blocked: "Can't test" };

const OUTCOME_TITLES: Record<CheckOutcome, string> = {
  pass: "The check was performed and met its criteria",
  fail: "The check was performed and did not meet its criteria",
  blocked: "You could not perform the check, so there is no result either way (recorded as Blocked, the engine's own word for it)",
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
    // The execution id travels with the control and comes back on the
    // click, so this button can only ever ask for the runner it was drawn
    // for. It is `quiet danger`, not the full danger treatment: stopping a
    // run interrupts it, and deletes nothing.
    buttons.push(
      `<button class="quiet danger" data-stop="${escapeHtml(model.runner.executionId)}" title="${escapeHtml(model.runner.detail)}">${escapeHtml(model.runner.label)}</button>`,
    );
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

/**
 * The two actor cards, each its own configuration surface, and the one
 * shared Settings action beside them.
 *
 * There is no second Agents panel: model and effort belong to the role they
 * configure, and one of the two places was always going to be the stale one.
 * The controls are joined onto the card here rather than carried in the
 * model, so the model keeps one description of the configuration and this
 * file decides where on the page it is drawn.
 */
function renderActors(model: OverviewModel, scope: string): string {
  const config = model.agentConfig;
  const configScope = config?.scope;
  const controlsFor = (role: ConfigRole): AgentRoleControls | undefined =>
    configScope ? config?.controls.find((entry) => entry.role === role) : undefined;
  const actors = [model.stageAgent, model.sparrer].filter((card): card is ActorCard => card !== undefined);
  const cards = actors.map((card) => renderActor(card, controlsFor(card.configRole), configScope)).join("");
  // Every panel is laid out after every card, so the cards keep their row
  // whichever of them is open, and an opened panel appears below both of
  // them at the width of the rest of the page rather than in a half-width
  // column. They behave as a tab strip: at most one is open, each names the
  // actor it belongs to and carries that actor's colour, and the card it
  // came from is marked while it is open.
  const panels = actors.map((card) => renderInstructionsPanel(card, scope)).join("");
  const section = cards ? `<section class="actors">${cards}${panels}</section>` : "";
  return `${section}${config ? renderAgentsBar(config, cards !== "") : ""}`;
}

/**
 * One actor: what it is, what it is configured with, what it is doing.
 *
 * The role heads the card because the role is the concept — a stage agent
 * and a sparrer are different jobs, and which provider is filling one today
 * is a setting. The provider is therefore read underneath it, quietly, and
 * the model and effort controls follow as the settings of that role.
 *
 * The card carries the toggle for its instructions but not the instructions
 * themselves: those are a panel after both cards, so opening one actor's
 * does not move the other actor's card out of its row. The toggle is a
 * button and not a `<summary>` for the same reason it was never wrapped
 * around the card -- a summary activates on click, and an effort dropdown
 * inside one would collapse the card it is in as often as not.
 */
function renderActor(card: ActorCard, controls: AgentRoleControls | undefined, configScope: string | undefined): string {
  const busy = card.activity === "Working" || card.activity === "Sparring";
  const duration = card.duration ? ` for ${escapeHtml(card.duration)}` : "";
  const quiet = card.quietFor ? ` <span class="muted">· no meaningful activity for ${escapeHtml(card.quietFor)}</span>` : "";
  const uncertain = busy && card.uncertain ? ` <span class="muted">· runner status unknown</span>` : "";
  const who = whoClass(card.provider);
  // A telemetry-only turn reads "Working? (turn observed 3m ago)": the duration is
  // time since the observed start, not a claim that work is happening now.
  const word = busy && card.uncertain ? `${card.activity}?` : (card.activity ?? "");
  const span = busy && card.uncertain ? (card.duration ? ` <span class="muted">(turn observed ${escapeHtml(card.duration)} ago)</span>` : "") : duration;
  const role = actorRole(card);
  const identity = `<div class="identity"><span class="avatar ${who}">${avatarGlyph(role)}</span>
<div class="who"><div class="rolename ${who}">${escapeHtml(card.role)}</div><div class="provider muted">${escapeHtml(card.provider)}</div></div></div>`;
  const settings = controls && configScope ? renderRoleControls(controls, configScope) : "";
  // No run, no stage: the card is a configuration surface and says nothing
  // about activity. With a stage, the session line appears only once the
  // engine has recorded one — an absent id is left off rather than shown as
  // a placeholder for a value that does not exist yet.
  const activity = card.activity
    ? `<div class="activity ${card.activity.toLowerCase()}${busy && card.uncertain ? " uncertain" : ""}">${icon("dot", "dot")}${escapeHtml(word)}${busy ? span : ""}${uncertain}${quiet}</div>`
    : "";
  const session =
    card.sessionLabel && card.sessionKind
      ? `<div class="session muted">${capitalize(card.sessionKind)}: ${escapeHtml(card.sessionLabel)}</div>`
      : "";
  const body = `${identity}${settings}${activity}${session}`;
  // No captured prompt means the engine has not run a turn for this actor
  // since prompt capture existed. An ordinary state, so the card simply
  // stays a card rather than offering a disclosure that would open on
  // nothing.
  if (!card.prompt) {
    return `<div class="card actor ${who}" data-role="${role}">${body}</div>`;
  }
  // The toggle stays on the card; what it opens is rendered after both cards
  // (see `renderActors`), so opening one actor's instructions never moves the
  // other actor's card. `aria-controls` is the only thing tying the two
  // together in the document, and the script relies on the same pairing.
  return `<div class="card actor ${who}" data-role="${role}">${body}
<button type="button" class="showinstr" data-instr="${role}" aria-controls="${instrPanelId(role)}" aria-expanded="false" data-show="${SHOW_INSTRUCTIONS}" data-hide="${HIDE_INSTRUCTIONS}">${SHOW_INSTRUCTIONS}</button></div>`;
}

/**
 * The toggle's two labels. They live here rather than in the page's script
 * because they are wording, and the script should carry behaviour only; it
 * reads whichever one the current state calls for off the button.
 */
const SHOW_INSTRUCTIONS = "Show instructions";
const HIDE_INSTRUCTIONS = "Hide instructions";

/** The id the card's toggle points at, and the panel answers to. */
function instrPanelId(role: string): string {
  return `instr-${role}`;
}

/**
 * Which actor a card is for, in the vocabulary the markup uses. One
 * definition, because the card's `aria-controls` and the panel's id are
 * derived from it and a disagreement would be a toggle that opens nothing.
 */
function actorRole(card: ActorCard): "stage" | "sparrer" {
  return card.role === "Stage agent" ? "stage" : "sparrer";
}

/**
 * One actor's instructions, as a panel below the cards rather than inside
 * the card that opens it.
 *
 * It is a plain element and not a `<details>` because the control that opens
 * it lives in the card and a `<summary>` cannot be separated from its own
 * `<details>`. Its open state is still remembered the way every disclosure
 * on this page is — `data-disclose`, keyed by what the section is — so
 * nothing new is stored and a reload restores it with the rest.
 *
 * The panel names the actor it belongs to. Only one is ever open, but it is
 * read well below the card that opened it, so the heading says whose it is
 * without a reader having to remember which tab they pressed.
 */
function renderInstructionsPanel(card: ActorCard, scope: string): string {
  if (!card.prompt) {
    return "";
  }
  const role = actorRole(card);
  const who = whoClass(card.provider);
  return `<div class="instrpanel ${who}" id="${instrPanelId(role)}" data-instrpanel="${role}"${disclose(scope, role, "instructions")} hidden>
<div class="instrhead ${who}">${escapeHtml(card.role)} <span class="muted">· instructions</span></div>
${renderInstructions(card.prompt, role, scope)}</div>`;
}

/**
 * The shared line beside the cards: Settings, and whatever the engine said
 * about the configuration as a whole.
 *
 * It is a line, not a panel. The only things it carries are the ones that
 * belong to both roles at once — the project.toml the cards were drawn from,
 * the engine's own note when it could not resolve a configuration, and the
 * fact that a change lands on the next turn while a run is active. When
 * there are no controls to put in the cards, the engine's read-only role
 * lines are shown here instead of being replaced by empty controls.
 */
function renderAgentsBar(section: AgentConfigSection, hasCards: boolean): string {
  const settings = button("openSettings", section.settings.label, true, section.settings.detail, "quiet");
  const lines =
    section.controls.length === 0 || !section.scope || !hasCards
      ? section.lines
          .map(
            (line) =>
              `<div class="agentconfig-role" title="${escapeHtml(line.detail)}"><span class="muted">${escapeHtml(line.role)}</span><span class="agentconfig-value">${escapeHtml(line.text)}</span></div>`,
          )
          .join("")
      : "";
  const active = section.activeRunNote ? `<p class="muted note">${escapeHtml(section.activeRunNote)}</p>` : "";
  const note = section.note ? `<p class="muted note">${escapeHtml(section.note)}</p>` : "";
  return `<div class="agentsbar">${lines}${active}${note}<div class="actions">${settings}</div></div>`;
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
function renderInstructions(prompt: PromptView, role: string, scope: string): string {
  const recency = prompt.live
    ? `<span class="turnchip live">This turn</span>`
    : `<span class="turnchip">Last turn</span>`;
  const branch = prompt.branch ? ` <span class="muted">· branch <code>${escapeHtml(prompt.branch)}</code></span>` : "";
  const head = `<div class="turnline">${recency}<strong>${escapeHtml(prompt.turn)}</strong> <span class="muted">· ${escapeHtml(prompt.detail)}</span>${branch}</div>`;

  const body = prompt.sectionsUnavailable
    ? `<p class="note">${escapeHtml(prompt.sectionsUnavailable)}</p>`
    : prompt.sections.map((section) => renderPromptSection(section, role, scope)).join("");

  const exact = `<details class="promptsec exact"${disclose(scope, role, "prompt", "exact")}><summary><span class="sechead">View exact generated prompt</span><span class="secsrc muted">${prompt.exact.length.toLocaleString("en-US")} characters, as sent</span></summary><pre class="prompttext">${escapeHtml(prompt.exact)}</pre></details>`;
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
function renderPromptSection(section: PromptViewSection, role: string, scope: string): string {
  const open = section.text.length <= PROMPT_SECTION_OPEN_MAX ? " open" : "";
  const source = section.source
    ? `<button class="linkish" data-openprompt="${escapeHtml(section.source)}" title="${escapeHtml(section.source)}">${escapeHtml(basename(section.source))}</button>`
    : `<span class="secsrc muted">Agent Sparring</span>`;
  const heading = section.heading || "(unnamed section)";
  // Keyed by the section's own heading, so a section that appears in one
  // turn and not the next cannot hand its state to a different section.
  return `<details class="promptsec"${open}${disclose(scope, role, "prompt", heading)}><summary><span class="sechead">${escapeHtml(heading)}</span>${source}</summary><pre class="prompttext">${escapeHtml(section.text)}</pre></details>`;
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

/**
 * One role's settings, inside that role's own card: model, effort, and the
 * provider only when there is genuinely a choice to make.
 *
 * The role is not repeated here — it is the card's heading — and neither is
 * a provider the engine reports as the only one for the role, which the card
 * already names underneath that heading. A dropdown of one would be a
 * control that lies about being a control, and a second copy of the provider
 * name would be the duplication this layout exists to remove.
 *
 * The model is a row here but not a control: it is the value the engine
 * resolved, read on the card and changed in project.toml. Nothing
 * enumerates the models a CLI accepts, so a control could only be a box
 * that takes any string and discovers on the next turn that it was wrong.
 *
 * Every actual control carries the role, the field and the scope it was
 * rendered with, so the message the webview posts is self-describing and the
 * host never has to infer which repository a change was meant for from
 * whatever happens to be selected when it arrives.
 */
function renderRoleControls(role: AgentRoleControls, scope: string): string {
  const attrs = `data-role="${escapeHtml(role.role)}" data-scope="${escapeHtml(scope)}"`;
  const items = [...(role.provider.options ? [role.provider] : []), role.model, ...(role.effort ? [role.effort] : [])];
  const rows = items.map((item) => field(item.label, control(item, attrs))).join("");
  return `<div class="agentconfig-block">${rows}</div>`;
}

function field(label: string, input: string): string {
  return `<label class="agentconfig-field"><span class="muted">${escapeHtml(label)}</span>${input}</label>`;
}

/**
 * The control for one field: a dropdown, or text that is only read.
 *
 * A dropdown when the engine gave options — its entries are the engine's own
 * levels and providers, so nothing here enumerates what a provider accepts.
 * Read-only text otherwise, and that is every remaining case: a role with one
 * provider has nothing to choose, and the model is shown rather than edited
 * because no engine or CLI reports a list of models to choose from. A field
 * that is neither is a control this renderer has no honest shape for, so it
 * is left out rather than drawn as an empty box.
 */
function control(item: AgentFieldControl, attrs: string): string {
  if (item.fixedText !== undefined) {
    // Shown, not chosen. The "novalue" case is the absence of an override --
    // the words "Provider default" rather than a model the engine resolved --
    // and is drawn quietly so it is never read as a configured value.
    const quiet = item.value === PROVIDER_DEFAULT_VALUE ? " novalue" : "";
    return `<span class="agentconfig-fixed${quiet}" title="${escapeHtml(item.detail)}">${escapeHtml(item.fixedText)}</span>`;
  }
  if (!item.options) {
    return "";
  }
  // The value this control was rendered with. The script compares against
  // it before posting, so simply tabbing through a field -- or re-selecting
  // what is already selected -- runs no engine command at all. The leading
  // "-" or "=" keeps "cleared" distinguishable from a value that happens to
  // spell it, so a level actually named "default" can still be cleared.
  const sent = ` data-sent="${escapeHtml(item.value === PROVIDER_DEFAULT_VALUE ? "-" : `=${item.value}`)}"`;
  return `<select ${attrs} data-field="${escapeHtml(item.field)}" title="${escapeHtml(item.detail)}"${sent}>${options(item.options, item.value)}</select>`;
}

function options(items: readonly { value: string; label: string }[], selected: string): string {
  return items
    .map(
      (item) =>
        `<option value="${escapeHtml(item.value)}"${item.value === selected ? " selected" : ""}>${escapeHtml(item.label)}</option>`,
    )
    .join("");
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
/* Not a failure and not a warning: no result was obtained, so it reads as absence. */
.check.blocked .mark { color: var(--vscode-descriptionForeground); }
.checkbody { flex: 1 1 auto; min-width: 0; }
.criterion { margin: 0 0 2px; white-space: pre-wrap; }
.criterion.parent { padding: 4px 10px; border-left: 2px solid var(--info); background: var(--vscode-textBlockQuote-background); }
.check.done .criterion { color: var(--vscode-descriptionForeground); }
.outcome { font-weight: 600; }
.outcome.pass { color: var(--good); }
.outcome.fail { color: var(--bad); }
.outcome.blocked { color: var(--vscode-descriptionForeground); }
.evidence { margin: 0; font-family: var(--vscode-editor-font-family); }
.record { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0 0 28px; flex-wrap: wrap; }
.choices { display: inline-flex; gap: 0; flex: none; }
button.choice { border-radius: 0; margin-left: -1px; }
button.choice:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
button.choice:last-child { border-radius: 0 6px 6px 0; }
button.choice.on.pass { background: var(--good); color: var(--vscode-editor-background); border-color: var(--good); font-weight: 600; }
button.choice.on.fail { background: var(--bad); color: var(--vscode-editor-background); border-color: var(--bad); font-weight: 600; }
button.choice.on.blocked { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); border-color: var(--vscode-descriptionForeground); font-weight: 600; }
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

/* What the next turn would run with. Compact by design: the file is the editor. */
/* The shared line beside the two cards: Settings, and anything the engine
   said about the configuration as a whole. Deliberately not a panel. */
.agentsbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 10px; }
.agentsbar .note { margin: 0; flex: 1 1 18em; }
.agentsbar .actions { margin-left: auto; }
.agentconfig-role { display: flex; align-items: baseline; gap: 8px; font-size: 0.92em; }
.agentconfig-role .muted { min-width: 8.5em; }
.agentconfig-value { font-weight: 600; overflow-wrap: anywhere; }
.agentconfig-block { margin: 6px 0 2px; }
.agentconfig-field { display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: 0.9em; }
.agentconfig-field > .muted { min-width: 5.5em; }
/* Only a chooser is drawn as a control. It is the platform's own select,
   filled and with its own chevron, so the one thing on the card that can be
   changed here looks like the one thing that can be changed here. */
.agentconfig-field select {
  flex: 1; min-width: 0; padding: 2px 4px; font: inherit; font-size: 0.95em;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 3px;
}
.agentconfig-field select:disabled { opacity: 0.6; }
/* A read value, not a control. 5px is the select's 1px border plus its 4px
   padding, so a model name and an effort level still start on the same
   column. */
.agentconfig-fixed { flex: 1; min-width: 0; padding: 2px 4px 2px 5px; font-size: 0.95em; font-weight: 600; overflow-wrap: anywhere; }
/* The absence of an override is not a value, so it never borrows a value's
   weight. */
.agentconfig-fixed.novalue { font-weight: 400; font-style: italic; color: var(--vscode-descriptionForeground); }

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
.actor { display: block; padding: 10px 12px; line-height: 1.45; }
.actor .identity { display: flex; gap: 12px; align-items: center; }
/* 2.8em is the height of the two-line column beside the avatar (the 1.05em
   role name and the 0.88em provider name, both at line-height 1.45), so the
   circle reads at the height of the identity row it sits in. Width and height
   are the same em length rather than stretched, so the circle stays round and
   still scales with the editor font size. */
.avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 2.8em; height: 2.8em; border-radius: 50%; color: var(--vscode-editor-background); background: var(--line); }
.avatar .glyph { width: 62%; height: 62%; display: block; }
.avatar.claude { background: var(--claude); }
.avatar.codex { background: var(--codex); }
/* The role is the heading; the provider filling it today is secondary. */
.rolename { font-weight: 600; font-size: 1.05em; }
.rolename.claude { color: var(--claude); }
.rolename.codex { color: var(--codex); }
.actor .provider { font-size: 0.88em; }
.activity { display: flex; align-items: center; }
.activity .icon.dot { color: var(--vscode-descriptionForeground); }
.activity.working, .activity.sparring { color: var(--good); font-weight: 600; }
.activity.working .icon.dot, .activity.sparring .icon.dot { color: var(--good); }
.session { font-family: var(--vscode-editor-font-family); font-size: 0.85em; }

/* The captured prompt opens below both cards, never inside the card that
   opens it: a card that grew would push the other actor's card out of its
   row, which is the one thing a person reading two actors side by side does
   not want. The card is the tab and the panel is what the tab opens, so the
   prompt is also read at the width of the rest of the page. */
.showinstr {
  display: block; margin: 6px -12px -10px; padding: 4px 12px 8px; width: calc(100% + 24px);
  font: inherit; font-size: 0.85em; text-align: left; cursor: pointer;
  color: var(--vscode-textLink-foreground); background: none; border: none;
}
.showinstr::after { content: ' ▸'; }
.showinstr[aria-expanded="true"]::after { content: ' ▾'; }
.showinstr:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
/* While its panel is open the card is the selected tab: it carries the
   actor's own colour along the edge the panel is on, and gives up the
   rounding there so the two read as one surface. The colour is painted
   inside the existing border rather than widening it, so selecting a tab
   cannot change the height of the card it is on. */
.card.actor:has(> .showinstr[aria-expanded="true"]) { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.card.actor.claude:has(> .showinstr[aria-expanded="true"]) { box-shadow: inset 0 -2px 0 var(--claude); }
.card.actor.codex:has(> .showinstr[aria-expanded="true"]) { box-shadow: inset 0 -2px 0 var(--codex); }

.instrpanel {
  grid-column: 1 / -1; position: relative; margin-top: -4px;
  border: 1px solid var(--line); border-top-width: 2px; border-radius: 6px;
  background: var(--card);
}
.instrpanel.claude { border-top-color: var(--claude); }
.instrpanel.codex { border-top-color: var(--codex); }
.instrhead { padding: 8px 12px 0; font-weight: 600; }
.instrhead.claude { color: var(--claude); }
.instrhead.codex { color: var(--codex); }
/* The notch points at the card this panel came from -- a quarter of the way
   across for the left card, three quarters for the right one. At most one
   panel is open, so it always points at a card. */
.instrpanel::before {
  content: ''; position: absolute; top: -7px; width: 12px; height: 12px;
  background: var(--card); border-left: 2px solid; border-top: 2px solid; border-color: inherit;
  transform: rotate(45deg);
}
.instrpanel[data-instrpanel="stage"]::before { left: 25%; }
.instrpanel[data-instrpanel="sparrer"]::before { left: 75%; }

.instructions { padding: 0 12px 12px; }
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
  /* One column: the cards are stacked, so a notch a quarter of the way
     across would point at neither of them. The panel's coloured edge and
     its heading are what say whose it is. */
  .instrpanel::before { display: none; }
}
`;

/**
 * Everything the page needs to put itself back the way the person left it
 * after the host replaces the document.
 *
 * The host rerenders by assigning `webview.html`, which is a fresh
 * document: a `<details>` the person opened closes, and the scroll
 * position goes back to the top. During a live run that happens every few
 * seconds, so "Show instructions" could not be read at all.
 *
 * This is the smallest thing that fixes the class of problem rather than
 * one instance of it. The webview's own `setState` survives a document
 * replacement (and a hide/restore) and never reaches the host or the
 * engine, which is exactly right: whether a section is open is
 * presentation, and Agent Sparring's recorded state has no business
 * knowing about it. Nothing is added to the host, no message crosses the
 * wire, and there is no framework.
 *
 * Two rules make it correct rather than merely sticky:
 *
 *  - a disclosure is keyed by what it *is* — the run, the stage, the actor
 *    and which section — written into the markup as `data-disclose`, never
 *    by its position. Keying by position is how the third section of one
 *    stage inherits the third section of the next one, and how a new
 *    actor's card opens because the previous actor's was open;
 *  - the store is bounded and pruned to what the page being drawn actually
 *    contains, so a long session cannot accumulate the keys of every stage
 *    it has ever shown.
 *
 * A key that is not in the store is left exactly as the renderer wrote it,
 * so a section the renderer deliberately starts closed (a large prompt
 * section) stays closed until somebody opens it.
 */
const DISCLOSURE_SCRIPT = `
  // Restored before the first paint: this script is the last thing in the
  // body, so the elements exist, and the page has not yet been shown.
  var STORE = 'disclosures';
  function state() {
    try { return vscode.getState() || {}; } catch (error) { return {}; }
  }
  function remember(next) {
    try { vscode.setState(next); } catch (error) { /* a webview with no state store still works */ }
  }
  function disclosures() {
    var open = state()[STORE];
    return open && typeof open === 'object' ? open : {};
  }
  // A disclosure is a <details>, or a panel whose control lives elsewhere on
  // the page -- the instructions, opened from its actor's card. Both are
  // remembered the same way, under the same keys.
  function show(node, isOpen) {
    if (node.tagName === 'DETAILS') { node.open = isOpen; return; }
    node.hidden = !isOpen;
    var toggle = document.querySelector('[aria-controls="' + node.id + '"]');
    if (!toggle) { return; }
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    // The control says what pressing it will do. Both labels are written on
    // the button by the renderer, so no wording is invented here.
    var label = toggle.getAttribute(isOpen ? 'data-hide' : 'data-show');
    if (label) { toggle.textContent = label; }
  }
  function restore() {
    var open = disclosures();
    var kept = {};
    // At most one instructions panel is open, here too: a store written
    // before the panels became a tab strip can name both, and restoring it
    // as written would put the page into a state its own controls cannot
    // produce. The first one wins and the rest are recorded closed.
    var alreadyOpen = false;
    var nodes = document.querySelectorAll('[data-disclose]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-disclose');
      if (Object.prototype.hasOwnProperty.call(open, key)) {
        var wanted = open[key] === true;
        if (wanted && nodes[i].hasAttribute('data-instrpanel')) {
          if (alreadyOpen) { wanted = false; }
          alreadyOpen = alreadyOpen || wanted;
        }
        show(nodes[i], wanted);
        // Pruning to what this document has is what bounds the store: a
        // disclosure belonging to a stage that is no longer on screen is
        // dropped rather than kept for ever.
        kept[key] = wanted;
      }
    }
    var scrolled = state().scroll;
    if (typeof scrolled === 'number' && scrolled > 0) {
      window.scrollTo(0, scrolled);
    }
    var next = state();
    next[STORE] = kept;
    remember(next);
  }
  function record(node, isOpen) {
    var next = state();
    var open = next[STORE] && typeof next[STORE] === 'object' ? next[STORE] : {};
    open[node.getAttribute('data-disclose')] = isOpen === true;
    next[STORE] = open;
    remember(next);
  }
  document.addEventListener('toggle', function (event) {
    var node = event.target;
    if (!node || !node.getAttribute || !node.hasAttribute('data-disclose')) { return; }
    record(node, node.open === true);
  }, true);
  // The instructions toggle. The panel it opens is laid out after both actor
  // cards, so opening one actor's instructions leaves the other actor's card
  // exactly where it was; the button and the panel are tied by aria-controls
  // and nothing else.
  //
  // A tab strip, so at most one panel is open: opening one closes the other,
  // and pressing the open one's own toggle closes it and leaves none open.
  // Both changes are recorded, or the closed one would come back on the next
  // rerender and there would be two again.
  function closeOthers(panel) {
    var panels = document.querySelectorAll('[data-instrpanel]');
    for (var i = 0; i < panels.length; i++) {
      if (panels[i] !== panel && !panels[i].hidden) {
        show(panels[i], false);
        if (panels[i].hasAttribute('data-disclose')) { record(panels[i], false); }
      }
    }
  }
  document.addEventListener('click', function (event) {
    var element = event.target instanceof Element ? event.target : null;
    var toggle = element ? element.closest('button[data-instr]') : null;
    if (!toggle) { return; }
    var panel = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!panel) { return; }
    var isOpen = panel.hidden;
    if (isOpen) { closeOthers(panel); }
    show(panel, isOpen);
    if (panel.hasAttribute('data-disclose')) { record(panel, isOpen); }
  });
  // Where the person had scrolled to, kept cheaply: the value is read back
  // only when a fresh document is built, so a throttle of a frame is
  // plenty and a scroll never costs a write per event.
  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer !== null) { return; }
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      var next = state();
      next.scroll = window.scrollY;
      remember(next);
    }, 100);
  });
  restore();
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (event) {
    var element0 = event.target instanceof Element ? event.target : null;
    var stop = element0 ? element0.closest('button[data-stop]') : null;
    if (stop && !stop.disabled) {
      // The execution this page was drawn for, carried back verbatim. The
      // host refuses it if that is no longer the runner this run is
      // waiting on, so a page left open cannot interrupt a newer one.
      vscode.postMessage({ type: 'stop', executionId: stop.getAttribute('data-stop') });
      return;
    }
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
    if (box instanceof HTMLInputElement && box.hasAttribute('data-autopush')) {
      vscode.postMessage({ type: 'autoPush', enabled: box.checked });
      return;
    }
    agentConfigChanged(event.target);
  });
  // The inline agent controls, which are dropdowns and nothing else: they
  // report on change. The model is read-only text on the card and is changed
  // in project.toml, so there is no text field here to save on blur or on
  // Enter, and no keystroke path that could queue a write per character.
  //
  // Every message carries the scope the control was rendered with, so the
  // host can refuse one that belongs to a repository no longer on screen.
  // The control is disabled while its own change is in flight, which is what
  // stops a double click or a fast second selection from starting a second
  // write over the first; the host's reply re-renders the page from the
  // engine's actual answer and the control comes back with that value in it.
  function agentConfigChanged(node) {
    if (!(node instanceof HTMLSelectElement)) { return; }
    if (!node.hasAttribute('data-role') || !node.hasAttribute('data-field')) { return; }
    if (node.disabled) { return; }
    // The empty option is the sentinel for "no override", which the host
    // sends as null and the engine turns into its --*-default flag.
    var sent = node.value === '' ? null : node.value;
    var stamp = sent === null ? '-' : '=' + sent;
    if (node.getAttribute('data-sent') === stamp) { return; }
    node.setAttribute('data-sent', stamp);
    node.disabled = true;
    vscode.postMessage({
      type: 'agentConfig',
      role: node.getAttribute('data-role'),
      field: node.getAttribute('data-field'),
      value: sent,
      scope: node.getAttribute('data-scope'),
    });
  }
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
    if (!tracked(area)) {
      agentConfigChanged(event.target);
      return;
    }
    clearTimeout(timers[timerKey(area)]);
    save(area);
  });
${DISCLOSURE_SCRIPT}
})();
`;
