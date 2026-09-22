/**
 * Display-only derivations shared by the status bar and the Run Overview:
 * human-readable stage names, a higher-level stage presentation state, and
 * label truncation. Nothing here changes which ids, files or states the
 * extension acts on; the authoritative StageState stays what state.json says.
 */

import type { RunSnapshot, StageSnapshot } from "./discovery";
import type { RoutingAction, SparringOutcome, StageStatus } from "./engineFormats";
import type { LiveState } from "./liveState";

/**
 * The `<slug>-<8 hex>-` namespace a managed run's stage id carries (plan.py:
 * `plan_key`), matched only when a `stage-<label>-` follows it so an
 * ordinary id that merely happens to end in hex is left alone. The label may
 * be lettered (`3b`), which is what the extension's own plan labels look
 * like.
 */
const PLAN_KEY_PREFIX_RE = /^(?:[a-z0-9-]*-)?[0-9a-f]{8}-(?=stage-\d+[a-z]?-)/;
const STAGE_PREFIX_RE = /^stage-(?:\d+-)?/;

/**
 * A stage id with its plan-key namespace removed, or unchanged when it has
 * none. Shared with plan matching, which must see the `stage-<label>-<slug>`
 * shape underneath whether or not the stage belongs to a managed run.
 */
export function stripPlanKeyPrefix(stageId: string): string {
  return stageId.replace(PLAN_KEY_PREFIX_RE, "");
}

/**
 * Turn a machine stage id into a restrained label:
 * `stage-reported-statistics-local-schema-barrier` → `Reported statistics local schema barrier`,
 * `foo-1cd13d24-stage-2-schema-api` → `Schema api`.
 */
export function humanizeStageId(stageId: string): string {
  const rest = stripPlanKeyPrefix(stageId).replace(STAGE_PREFIX_RE, "");
  const words = rest
    .split(/[-_.]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return stageId;
  }
  const [first, ...others] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...others].join(" ");
}

/** Plan title when known, else a humanized id. Never the raw id. */
export function stageDisplayName(stage: StageSnapshot): string {
  return stage.title ?? humanizeStageId(stage.stageId);
}

export function truncateLabel(text: string, max = 28): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * How many lines, and how many characters, of a person's own text a modal
 * confirmation may quote back to them.
 *
 * A VS Code modal has no scroll of its own: it grows to fit its detail, and
 * its buttons sit underneath. So text that is long enough pushes the button
 * that accepts the dialog past the bottom of the screen, where it cannot be
 * clicked and cannot be reached — the dialog becomes unanswerable. A person
 * answering a manual verification check pastes what they saw, and a pasted
 * sync log or stack trace is thousands of characters, so this is reached in
 * ordinary use rather than only by abuse.
 *
 * Deliberately generous: enough to recognise what is about to be submitted,
 * which is all a confirmation is for. The text itself is never shortened —
 * only this quotation of it is.
 */
export const DIALOG_QUOTE_MAX_LINES = 12;
export const DIALOG_QUOTE_MAX_CHARS = 800;

/**
 * `text` as a modal's detail may quote it: at most
 * {@link DIALOG_QUOTE_MAX_LINES} lines and {@link DIALOG_QUOTE_MAX_CHARS}
 * characters, with a plain note of how much was left out so the reader knows
 * the dialog is showing part of something rather than all of a short thing.
 */
export function dialogQuote(text: string): string {
  const lines = text.split("\n");
  let kept = lines.slice(0, DIALOG_QUOTE_MAX_LINES).join("\n");
  let elided = lines.length > DIALOG_QUOTE_MAX_LINES;
  if (kept.length > DIALOG_QUOTE_MAX_CHARS) {
    kept = kept.slice(0, DIALOG_QUOTE_MAX_CHARS).trimEnd();
    elided = true;
  }
  if (!elided) {
    return text;
  }
  const hidden = text.length - kept.length;
  return `${kept}\n… ${hidden} more character${hidden === 1 ? "" : "s"}, submitted in full but not shown here.`;
}

/**
 * Presentation states. The engine's own words (READY, SEND_BACK, NEEDS_YOU,
 * ESCALATE, FROZEN, ACCEPTED) stay in `raw` for logs, tooltips and the
 * metadata footer; nothing in `label`/`detail` uses them.
 */
export type StagePresentationKind = "accepted" | "finalizing" | "ready" | "send_back" | "needs_you" | "escalate" | "working";

export interface StagePresentation {
  kind: StagePresentationKind;
  /** The state word shown to the user, e.g. `Review complete`. */
  label: string;
  /** One sentence under the label saying what it means / what happens next. */
  detail?: string;
  /** The word for the status bar after the position; undefined for plain working. */
  short?: string;
  /** The engine's vocabulary for this state (`state.json` status and/or routing action), for advanced surfaces only. */
  raw: string;
}

/** Human wording of a routing action as recorded in sparring.md. */
export const ACTION_WORDS: Record<RoutingAction, string> = {
  READY: "Review passed",
  SEND_BACK: "Changes requested",
  NEEDS_YOU: "Needs you",
  ESCALATE: "Escalated",
};

export function actionWord(action: string): string {
  return (ACTION_WORDS as Record<string, string>)[action] ?? action;
}

/**
 * Higher-level presentation of a stage: the authoritative StageState first
 * (accepted, frozen), then the latest recorded routing outcome from
 * sparring.md while the stage is still `working`. A live turn in progress
 * (from telemetry) means the outcome is being acted on: the state is then
 * plainly `Working` (the previous finding stays visible as the latest
 * sparring result), except READY, which no turn acts on.
 */
export function presentStage(status: StageStatus | undefined, outcome: SparringOutcome | undefined, live?: LiveState): StagePresentation {
  if (status === "accepted") {
    return { kind: "accepted", label: "Accepted", detail: "Stage complete.", short: "accepted", raw: "ACCEPTED" };
  }
  if (status === "frozen") {
    // The engine's FROZEN is the moment between the two acceptance steps; it
    // is never named to the user (see overviewModel for the persistent case).
    return { kind: "finalizing", label: "Finalizing stage…", detail: "The reviewed code is being pinned and accepted.", short: "finalizing", raw: `FROZEN${outcome ? ` · ${outcome.action}` : ""}` };
  }
  const busy = Boolean(live?.stage.busy || live?.sparrer.busy);
  const working: StagePresentation = { kind: "working", label: "Working", raw: `working${outcome ? ` · ${outcome.action}` : ""}` };
  switch (outcome?.action) {
    case "READY":
      return { kind: "ready", label: "Review complete", detail: "Independent review passed. No unresolved findings remain.", short: "Review complete", raw: "working · READY" };
    case "SEND_BACK":
      return busy
        ? working
        : { kind: "send_back", label: "Changes requested", detail: "The independent reviewer found something to fix. Work will continue automatically.", short: "Changes requested", raw: "working · SEND_BACK" };
    case "NEEDS_YOU":
      return busy ? working : { kind: "needs_you", label: "Needs you", detail: outcome.summary || "The independent reviewer needs a decision or a check only you can make.", short: "Needs you", raw: "working · NEEDS_YOU" };
    case "ESCALATE":
      return busy
        ? working
        : { kind: "escalate", label: "Escalated", detail: outcome.summary || "The independent reviewer could not settle this. Read the sparring report and decide how to continue.", short: "Escalated", raw: "working · ESCALATE" };
    default:
      return working;
  }
}

export function presentRunStage(run: RunSnapshot, live?: LiveState): StagePresentation {
  if (run.kind === "plan") {
    return presentStage(run.currentStage.state?.status, run.currentOutcome, live);
  }
  return presentStage(run.stage.state?.status, run.outcome, live);
}
