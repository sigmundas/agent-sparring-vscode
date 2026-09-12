/**
 * Display-only derivations shared by the status bar and the Run Overview:
 * human-readable stage names, a higher-level stage presentation state, and
 * label truncation. Nothing here changes which ids, files or states the
 * extension acts on; the authoritative StageState stays what state.json says.
 */

import type { RunSnapshot, StageSnapshot } from "./discovery";
import type { RoutingAction, SparringOutcome, StageStatus } from "./engineFormats";
import type { LiveState } from "./liveState";

const PLAN_KEY_PREFIX_RE = /^(?:[a-z0-9-]*-)?[0-9a-f]{8}-stage-\d+-/;
const STAGE_PREFIX_RE = /^stage-(?:\d+-)?/;

/**
 * Turn a machine stage id into a restrained label:
 * `stage-reported-statistics-local-schema-barrier` → `Reported statistics local schema barrier`,
 * `foo-1cd13d24-stage-2-schema-api` → `Schema api`.
 */
export function humanizeStageId(stageId: string): string {
  let rest = stageId.replace(PLAN_KEY_PREFIX_RE, "");
  rest = rest.replace(STAGE_PREFIX_RE, "");
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
