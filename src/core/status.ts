/**
 * Status-bar text derivation.
 *
 * Authoritative lifecycle (No active run / running / Paused / NEEDS_YOU /
 * ESCALATE / Plan complete / stage working-frozen-accepted) comes from the
 * discovery snapshot: plan-run state, stage state and the current stage's
 * recorded sparring.md outcome. The live suffix ("Claude working",
 * "Codex sparring") comes from the activity stream and only decorates a run
 * whose authoritative status is running/working.
 *
 * The visible text is kept short; detail goes to the tooltip.
 *
 * No dependency on the vscode API.
 */

import { currentStageOf, runLabel, totalStagesOf, type RunSelection, type RunSnapshot } from "./discovery";
import type { RunnerLiveness } from "./liveness";
import { providerDisplayName, type LiveState } from "./liveState";
import { actionWord, presentRunStage, stageDisplayName, truncateLabel } from "./presentation";

export type StatusSeverity = "none" | "info" | "warning" | "error";

export interface StatusView {
  text: string;
  tooltip: string;
  severity: StatusSeverity;
}

const PREFIX = "Agent Sparring";
/** After this long without any telemetry, a "working" claim is flagged as quiet. */
export const QUIET_AFTER_MS = 10 * 60 * 1000;
const STANDALONE_NAME_MAX = 28;

/**
 * `live` must be the presented fold (see liveness.deriveLiveness) and
 * `liveness` the runner liveness it came from: a turn the telemetry shows is
 * worded as certain work only when a process observation backs it.
 */
export function deriveStatus(selection: RunSelection, live: LiveState | undefined, nowMs: number, liveness?: RunnerLiveness): StatusView {
  if (!selection.selected) {
    if (selection.ambiguous.length > 0) {
      const lines = selection.ambiguous.map((run) => `• ${run.location.folderName}: ${runLabel(run)} (${authoritativeWord(run)})`);
      return {
        text: `$(question) ${PREFIX}: ${selection.ambiguous.length} runs · select`,
        tooltip: `Several runs look active; pick one:\n${lines.join("\n")}`,
        severity: "warning",
      };
    }
    return { text: `$(circle-outline) ${PREFIX}: No active run`, tooltip: "No recorded plan run or stage in this workspace.", severity: "none" };
  }

  const run = selection.selected;
  const stage = currentStageOf(run);
  const name = stageDisplayName(stage);
  const presentation = presentRunStage(run, live);
  const tooltipLines: string[] = [runLabel(run)];
  tooltipLines.push(`Repository: ${run.location.folderName}`);
  tooltipLines.push(run.kind === "plan" ? `Stage ${stagePosition(run)} — ${name}` : name);
  tooltipLines.push(`Stage id: ${stage.stageId}`);
  tooltipLines.push(`Stage state: ${presentation.label}`);
  tooltipLines.push(`Engine state: ${presentation.raw}`);

  if (run.kind === "plan") {
    const { status } = run.state;
    const position = stagePosition(run);
    if (status === "complete") {
      return finish(`$(check) ${PREFIX}: Plan complete`, tooltipLines, "none");
    }
    if (status === "paused") {
      const outcome = run.currentOutcome;
      const word = outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE" ? actionWord(outcome.action) : "Paused";
      if (outcome?.summary) {
        tooltipLines.push(`${actionWord(outcome.action)}: ${outcome.summary}`);
      }
      if (live?.lastPlanEvent?.event === "plan.failed" && live.lastPlanEvent.summary) {
        tooltipLines.push(`Stopped: ${live.lastPlanEvent.summary}`);
      }
      return finish(`$(debug-pause) ${PREFIX}: Stage ${position} · ${word}`, tooltipLines, "warning");
    }
    const suffix = liveSuffix(live, nowMs, tooltipLines, liveness) ?? presentation.short;
    return finish(`$(circle-filled) ${PREFIX}: Stage ${position}${suffix ? ` · ${suffix}` : ""}`, tooltipLines, "info");
  }

  // standalone stage
  const shortName = truncateLabel(name, STANDALONE_NAME_MAX);
  if (presentation.kind === "accepted") {
    return finish(`$(check) ${PREFIX}: ${shortName} · accepted`, tooltipLines, "none");
  }
  if (presentation.kind === "finalizing") {
    return finish(`$(lock) ${PREFIX}: ${shortName} · finalizing`, tooltipLines, "none");
  }
  if (presentation.kind === "needs_you" || presentation.kind === "escalate") {
    if (run.outcome?.summary) {
      tooltipLines.push(`${actionWord(run.outcome.action)}: ${run.outcome.summary}`);
    }
    return finish(`$(debug-pause) ${PREFIX}: ${shortName} · ${presentation.short}`, tooltipLines, "warning");
  }
  const suffix = liveSuffix(live, nowMs, tooltipLines, liveness) ?? presentation.short ?? "working";
  return finish(`$(circle-filled) ${PREFIX}: ${shortName} · ${suffix}`, tooltipLines, "info");
}

function finish(text: string, tooltipLines: string[], severity: StatusSeverity): StatusView {
  return { text, tooltip: tooltipLines.join("\n"), severity };
}

function stagePosition(run: RunSnapshot): string {
  if (run.kind !== "plan") {
    return run.stage.stageId;
  }
  const total = totalStagesOf(run);
  return `${run.state.currentStageIndex + 1}/${total ?? "?"}`;
}

function authoritativeWord(run: RunSnapshot): string {
  if (run.kind === "plan") {
    return `${run.state.status}, stage ${stagePosition(run)}`;
  }
  return run.stage.state?.status ?? "working";
}

/** The live actor word when an actor is mid-turn; detail lines go to the tooltip. */
function liveSuffix(live: LiveState | undefined, nowMs: number, tooltipLines: string[], liveness?: RunnerLiveness): string | undefined {
  if (liveness?.interrupted) {
    tooltipLines.push("Last run interrupted: the runner exited while a provider turn was in progress according to activity.jsonl.");
    return "stopped";
  }
  if (!live || live.eventCount === 0) {
    tooltipLines.push("No activity telemetry for this stage.");
    return undefined;
  }
  let suffix: string | undefined;
  if (live.sparrer.busy) {
    suffix = `${providerDisplayName(live.sparrer.provider, "sparrer")} sparring`;
  } else if (live.stage.busy) {
    suffix = `${providerDisplayName(live.stage.provider, "stage")} working`;
  }
  if (suffix && liveness?.source === "telemetry") {
    // Telemetry saw the turn start; no process observation backs it.
    suffix += " (unconfirmed)";
    tooltipLines.push("Runner status unknown: " + liveness.detail);
  }
  const since = live.lastMeaningful?.ts ?? live.lastEventTs;
  if (since) {
    const age = nowMs - Date.parse(since);
    if (suffix && age > QUIET_AFTER_MS) {
      suffix += ` · no activity ${formatAge(age)}`;
      tooltipLines.push(`No meaningful activity for ${formatAge(age)}`);
    } else if (live.lastMeaningful) {
      tooltipLines.push(`Last event: ${live.lastMeaningful.description}`);
    }
  }
  if (live.lastVerdict?.summary) {
    tooltipLines.push(`Last verdict ${actionWord(live.lastVerdict.action)}: ${live.lastVerdict.summary}`);
  }
  return suffix;
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0s";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
