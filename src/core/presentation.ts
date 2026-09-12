/**
 * Display-only derivations shared by the status bar and the Run Overview:
 * human-readable stage names, a higher-level stage presentation state, and
 * label truncation. Nothing here changes which ids, files or states the
 * extension acts on; the authoritative StageState stays what state.json says.
 */

import type { RunSnapshot, StageSnapshot } from "./discovery";
import type { SparringOutcome, StageStatus } from "./engineFormats";
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

export type StagePresentationKind = "accepted" | "frozen" | "ready" | "send_back" | "needs_you" | "escalate" | "working";

export interface StagePresentation {
  kind: StagePresentationKind;
  /** Short label for pills and the status bar, e.g. `READY · awaiting acceptance`. */
  label: string;
  /** The word for the status bar after the position, e.g. `READY`; undefined for plain working. */
  short?: string;
}

/**
 * Higher-level presentation of a stage: the authoritative StageState first
 * (accepted, frozen), then the latest recorded routing outcome from
 * sparring.md while the stage is still `working`. A live turn in progress
 * (from telemetry) means the outcome is being acted on, so SEND_BACK and
 * READY still show but NEEDS_YOU/ESCALATE on a standalone stage do not
 * while an actor is busy.
 */
export function presentStage(status: StageStatus | undefined, outcome: SparringOutcome | undefined, live?: LiveState): StagePresentation {
  if (status === "accepted") {
    return { kind: "accepted", label: "ACCEPTED · stage complete", short: "accepted" };
  }
  if (status === "frozen") {
    return { kind: "frozen", label: "frozen · awaiting acceptance", short: "frozen" };
  }
  const busy = Boolean(live?.stage.busy || live?.sparrer.busy);
  switch (outcome?.action) {
    case "READY":
      return { kind: "ready", label: "READY · awaiting acceptance", short: "READY" };
    case "SEND_BACK":
      return { kind: "send_back", label: "SEND_BACK · correcting", short: "SEND_BACK" };
    case "NEEDS_YOU":
      return busy ? { kind: "working", label: "working" } : { kind: "needs_you", label: "NEEDS_YOU", short: "NEEDS_YOU" };
    case "ESCALATE":
      return busy ? { kind: "working", label: "working" } : { kind: "escalate", label: "ESCALATE", short: "ESCALATE" };
    default:
      return { kind: "working", label: "working" };
  }
}

export function presentRunStage(run: RunSnapshot, live?: LiveState): StagePresentation {
  if (run.kind === "plan") {
    return presentStage(run.currentStage.state?.status, run.currentOutcome, live);
  }
  return presentStage(run.stage.state?.status, run.outcome, live);
}
