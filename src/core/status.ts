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
 * No dependency on the vscode API.
 */

import { currentStageOf, runLabel, totalStagesOf, type RunSelection, type RunSnapshot } from "./discovery";
import { providerDisplayName, type LiveState } from "./liveState";

export type StatusSeverity = "none" | "info" | "warning" | "error";

export interface StatusView {
  text: string;
  tooltip: string;
  severity: StatusSeverity;
}

const PREFIX = "Agent Sparring";
/** After this long without any telemetry, a "working" claim is flagged as quiet. */
export const QUIET_AFTER_MS = 10 * 60 * 1000;

export function deriveStatus(selection: RunSelection, live: LiveState | undefined, nowMs: number): StatusView {
  if (!selection.selected) {
    if (selection.ambiguous.length > 0) {
      const lines = selection.ambiguous.map((run) => `• ${runLabel(run)} (${authoritativeWord(run)})`);
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
  const position = stagePosition(run);
  const tooltipLines: string[] = [runLabel(run)];
  if (stage.title) {
    tooltipLines.push(`Stage ${position ?? "?"} — ${stage.title}`);
  } else {
    tooltipLines.push(`Stage ${stage.stageId}`);
  }

  if (run.kind === "plan") {
    const { status } = run.state;
    if (status === "complete") {
      return finish(`$(check) ${PREFIX}: Plan complete`, tooltipLines, "none");
    }
    if (status === "paused") {
      const outcome = run.currentOutcome;
      const word = outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE" ? outcome.action : "Paused";
      if (outcome?.summary) {
        tooltipLines.push(`${outcome.action}: ${outcome.summary}`);
      }
      if (live?.lastPlanEvent?.event === "plan.failed" && live.lastPlanEvent.summary) {
        tooltipLines.push(`Stopped: ${live.lastPlanEvent.summary}`);
      }
      return finish(`$(debug-pause) ${PREFIX}: Stage ${position} · ${word}`, tooltipLines, "warning");
    }
    // running
    const suffix = liveSuffix(live, nowMs, tooltipLines);
    return finish(`$(circle-filled) ${PREFIX}: Stage ${position}${suffix ? ` · ${suffix}` : ""}`, tooltipLines, "info");
  }

  // standalone stage
  const stageStatus = stage.state?.status ?? "working";
  if (stageStatus === "accepted") {
    return finish(`$(check) ${PREFIX}: ${stage.stageId} · accepted`, tooltipLines, "none");
  }
  if (stageStatus === "frozen") {
    return finish(`$(lock) ${PREFIX}: ${stage.stageId} · frozen`, tooltipLines, "none");
  }
  const outcome = run.outcome;
  if (outcome && (outcome.action === "NEEDS_YOU" || outcome.action === "ESCALATE") && !(live?.stage.busy || live?.sparrer.busy)) {
    tooltipLines.push(`${outcome.action}: ${outcome.summary}`);
    return finish(`$(debug-pause) ${PREFIX}: ${stage.stageId} · ${outcome.action}`, tooltipLines, "warning");
  }
  const suffix = liveSuffix(live, nowMs, tooltipLines);
  return finish(`$(circle-filled) ${PREFIX}: ${stage.stageId}${suffix ? ` · ${suffix}` : " · working"}`, tooltipLines, "info");
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

function liveSuffix(live: LiveState | undefined, nowMs: number, tooltipLines: string[]): string | undefined {
  if (!live || live.eventCount === 0) {
    tooltipLines.push("No activity telemetry for this stage.");
    return undefined;
  }
  let suffix: string | undefined;
  if (live.sparrer.busy) {
    suffix = `${providerDisplayName(live.sparrer.provider, "sparrer")} sparring`;
  } else if (live.stage.busy) {
    suffix = `${providerDisplayName(live.stage.provider, "stage")} working`;
  } else if (live.lastVerdict) {
    suffix = `last ${live.lastVerdict.action}`;
  }
  if (live.lastEventTs) {
    const age = nowMs - Date.parse(live.lastEventTs);
    tooltipLines.push(`Last activity ${formatAge(age)} ago`);
    if (suffix && (live.sparrer.busy || live.stage.busy) && age > QUIET_AFTER_MS) {
      suffix += ` · quiet ${formatAge(age)}`;
    }
  }
  if (live.lastVerdict?.summary) {
    tooltipLines.push(`Last verdict ${live.lastVerdict.action}: ${live.lastVerdict.summary}`);
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
