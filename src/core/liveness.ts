/**
 * Runner liveness, kept strictly apart from actor activity.
 *
 * Actor activity (`LiveState`, folded from activity.jsonl) answers "what did
 * the engine last report?": a turn was observed starting, a verdict was
 * observed. It never proves the `sparring` process is alive; an unmatched
 * `turn.started` is exactly what Ctrl-C, a crash or a window reload leave
 * behind.
 *
 * Runner liveness answers "is the sparring runner process alive?" and comes
 * only from observing the process: a terminal shell execution the extension
 * launched or saw start/end, a dedicated terminal whose process is the
 * runner, or a process-table probe after a reload. Telemetry alone is never
 * promoted to a certain `running`; without an observation the state is
 * `unknown`.
 *
 * `unknown` is a waiting room, not a resting place. A run with an unmatched
 * `turn.started` and no execution to point at used to stay there for ever —
 * the case that matters is precisely the one where the runner is dead and
 * the user needs to resume. So a run this window never watched is resolved
 * by reading the process table for the project (runnerProcesses.ts, driven
 * from executionTracker.probeProject): a runner found there is `running`
 * with source `probed`, and none found is `stopped`. It stays `unknown`
 * only while the probe has not answered, when the platform has no `ps`, or
 * when a sparring runner exists that cannot be tied to any project.
 *
 * `deriveLiveness` combines the two into what the UI may honestly show and
 * a presented copy of the activity fold in which turns the runner can no
 * longer be executing are cleared. Nothing here mutates engine files or the
 * fold itself.
 *
 * No dependency on the vscode API.
 */

import type { LiveState } from "./liveState";

/** Where an execution observation came from, most exact first. */
export type ExecutionSource =
  /** Launched by this extension through the terminal shell-integration API (executable + argument array). */
  | "launched"
  /** Launched by this extension in a dedicated terminal whose process is the runner (shell integration unavailable). */
  | "terminal"
  /** A command typed in an integrated terminal, observed through shell integration start/end events. */
  | "observed"
  /** A launch recorded before a window reload whose hosting terminal was found again; liveness re-established by a process probe. */
  | "reattached"
  /** No execution was ever watched for this run; the process table was read directly (runnerProcesses.ts). */
  | "probed";

export type ExecutionState =
  /** The process is observed to be alive right now. */
  | "running"
  /** The process was observed to end (normal exit, non-zero exit, Ctrl-C, terminal closed, terminal gone after reload). */
  | "ended"
  /** The hosting terminal survived a reload but whether the command inside it is still running cannot be established. */
  | "unknown";

/** What the extension knows about one `sparring` run-loop / run-sparring / run-plan / resume-plan process. */
export interface ExecutionRecord {
  /** Unique per observation; a new launch or a newly observed command gets a new id. */
  id: string;
  /** The discovered run this execution belongs to (see discovery.runIdFor). */
  runId: string;
  kind: "run-loop" | "run-sparring" | "run-plan" | "resume-plan";
  source: ExecutionSource;
  state: ExecutionState;
  startedAtMs: number;
  endedAtMs?: number;
  /** Exit code when the shell reported one; undefined for Ctrl-C, signals, a closed terminal or an unknown cause. */
  exitCode?: number;
  /** Why the state is what it is; shown in tooltips and the log. */
  detail?: string;
}

export type LivenessState = "running" | "stopped" | "unknown";

export interface RunnerLiveness {
  state: LivenessState;
  /** `execution`: a process observation backs the state; `telemetry`: only activity.jsonl speaks; `none`: no information either way. */
  source: "execution" | "telemetry" | "none";
  /** A stage or sparring turn is in progress as far as the presented telemetry says. */
  turnActive: boolean;
  /** The runner ended while telemetry still had an actor mid-turn: Ctrl-C, crash, reload. */
  interrupted: boolean;
  /** Telemetry-only busy claim with no telemetry for STALE_ACTIVE_MS. */
  stale: boolean;
  /** The activity fold as it may be presented: turns a known-ended runner cannot be executing are cleared. */
  live: LiveState | undefined;
  /** One sentence for tooltips: which observation the state rests on. */
  detail: string;
  execution?: ExecutionRecord;
}

/** After this long without any telemetry, a telemetry-only busy claim is presented as stale. */
export const STALE_ACTIVE_MS = 30 * 60 * 1000;

const TELEMETRY_ONLY_DETAIL =
  "A provider turn started according to activity.jsonl, but no runner process has been observed from this window: the loop may have been started in another terminal or outside VS Code. Telemetry cannot prove the process is alive.";

/**
 * Combine actor activity with the execution observation for the same run.
 *
 * Precedence: a running execution wins; an ended execution masks every turn
 * that began at or before its end (late or replayed telemetry with an older
 * timestamp can therefore never re-arm `running`); a turn that began after
 * the end is a new observation and falls back to telemetry-only `unknown`;
 * no execution means `unknown` while telemetry claims a turn and `none`
 * otherwise.
 */
export function deriveLiveness(live: LiveState | undefined, execution: ExecutionRecord | undefined, nowMs: number): RunnerLiveness {
  const busy = Boolean(live && (live.stage.busy || live.sparrer.busy));
  const lastStart = live ? latestTurnStart(live) : 0;

  if (execution?.state === "running") {
    // A turn observed before this runner started cannot be this runner's; the
    // engine's worktree lock forbids a second runner, so it is a leftover.
    const presented = live && busy && lastStart < execution.startedAtMs ? clearBusy(live) : live;
    return {
      state: "running",
      source: "execution",
      turnActive: Boolean(presented && (presented.stage.busy || presented.sparrer.busy)),
      interrupted: false,
      stale: false,
      live: presented,
      detail: runningDetail(execution),
      execution,
    };
  }

  if (execution?.state === "ended") {
    const endedAt = execution.endedAtMs ?? nowMs;
    if (live && busy && lastStart <= endedAt) {
      return {
        state: "stopped",
        source: "execution",
        turnActive: false,
        interrupted: true,
        stale: false,
        live: clearBusy(live),
        detail: `${endedDetail(execution)} The last provider turn started according to activity.jsonl, but the Sparring runner has exited; no turn.finished or verdict will follow.`,
        execution,
      };
    }
    if (live && busy) {
      // Newer than the observed end: another launcher's turn; only telemetry speaks for it.
      return telemetryOnly(live, nowMs, execution, `${endedDetail(execution)} A newer turn has since started according to activity.jsonl; nothing has observed that runner.`);
    }
    return { state: "stopped", source: "execution", turnActive: false, interrupted: false, stale: false, live, detail: endedDetail(execution), execution };
  }

  if (execution?.state === "unknown") {
    const detail = execution.detail ?? "The terminal that hosted this run is still open after the window reloaded, but whether the command inside it is still running cannot be established from VS Code.";
    if (live && busy) {
      return telemetryOnly(live, nowMs, execution, detail);
    }
    return { state: "unknown", source: "none", turnActive: false, interrupted: false, stale: false, live, detail, execution };
  }

  if (live && busy) {
    return telemetryOnly(live, nowMs, undefined, TELEMETRY_ONLY_DETAIL);
  }
  return { state: "unknown", source: "none", turnActive: false, interrupted: false, stale: false, live, detail: "No runner process has been observed for this run." };
}

function telemetryOnly(live: LiveState, nowMs: number, execution: ExecutionRecord | undefined, detail: string): RunnerLiveness {
  const lastEvent = Date.parse(live.lastEventTs ?? "");
  const stale = Number.isFinite(lastEvent) && nowMs - lastEvent > STALE_ACTIVE_MS;
  return { state: "unknown", source: "telemetry", turnActive: true, interrupted: false, stale, live, detail, execution };
}

/** Epoch ms of the latest turn start/resume among busy actors; 0 when none is parseable. */
export function latestTurnStart(live: LiveState): number {
  return Math.max(
    live.stage.busy ? Date.parse(live.stage.busySince ?? "") || 0 : 0,
    live.sparrer.busy ? Date.parse(live.sparrer.busySince ?? "") || 0 : 0,
  );
}

function clearBusy(live: LiveState): LiveState {
  return { ...live, stage: { ...live.stage, busy: false, busySince: undefined }, sparrer: { ...live.sparrer, busy: false, busySince: undefined } };
}

function runningDetail(execution: ExecutionRecord): string {
  switch (execution.source) {
    case "launched":
      return "A runner launched from this window is running (exact: its shell execution has not ended).";
    case "terminal":
      return "A runner launched from this window is running (exact: the terminal whose process it is has not closed).";
    case "observed":
      return "A sparring command typed in an integrated terminal is running (exact: its shell execution has not ended).";
    case "reattached":
      return "The runner launched before the window reloaded is still running (its process was found under the reconnected terminal).";
    case "probed":
      return "A sparring runner for this project is in the process table. Nothing in this window launched it, so it cannot be stopped from here.";
  }
}

function endedDetail(execution: ExecutionRecord): string {
  const how = execution.exitCode === undefined ? "ended without an exit code (Ctrl-C, a signal, or its terminal closed)" : execution.exitCode === 0 ? "exited normally" : `exited with code ${execution.exitCode}`;
  return execution.detail ? `${execution.detail} ` : `The Sparring runner ${how}.`;
}

/** Whether a second loop must not be launched for this run without an explicit override. */
export function blocksLaunch(liveness: RunnerLiveness): "running" | "unknown" | undefined {
  if (liveness.state === "running") {
    return "running";
  }
  if (liveness.turnActive) {
    return "unknown";
  }
  return undefined;
}
