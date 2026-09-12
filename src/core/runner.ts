/**
 * Running a standalone stage's loop from the extension, and what the
 * extension may honestly say about a runner it launched.
 *
 * - Which action a stage offers (Run stage / Resume stage / Run loop again /
 *   none) follows from the authoritative StageState and routing outcome.
 * - The branch passed as --expected-branch comes from the Git repository
 *   that owns the project directory; nothing is guessed.
 * - When a runner the extension launched exits, the "busy" claims derived
 *   from telemetry are cleared for presentation; engine files are untouched.
 * - For runs launched elsewhere, a busy claim with no telemetry for a long
 *   time is presented as stale rather than as certain work.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import type { RunSnapshot, StandaloneStageSnapshot } from "./discovery";
import type { LiveState } from "./liveState";
import { presentStage } from "./presentation";

// ---------------------------------------------------------------- action

export type StageRunActionKind = "run" | "resume" | "rerun";

export interface StageRunAction {
  kind: StageRunActionKind;
  label: string;
  /** Primary actions are the obvious next step; a rerun after READY is not. */
  primary: boolean;
}

/**
 * The loop action for the selected run, or undefined when none applies:
 * plan runs use Run/Resume Plan; accepted and frozen stages are terminal
 * for the loop; a stage the telemetry shows mid-turn must never get a
 * second loop; READY only offers an explicit, non-primary rerun.
 *
 * `live` must already be the presented state (see applyRunner), so a turn
 * cut off by our own finished runner no longer counts as active.
 */
export function stageRunAction(run: RunSnapshot | undefined, live?: LiveState): StageRunAction | undefined {
  if (!run || run.kind !== "stage") {
    return undefined;
  }
  const status = run.stage.state?.status;
  if (status === "accepted" || status === "frozen") {
    return undefined;
  }
  if (isTurnActive(live)) {
    return undefined;
  }
  if (presentStage(status, run.outcome, live).kind === "ready") {
    return { kind: "rerun", label: "Run loop again", primary: false };
  }
  return hasSessions(run, live) ? { kind: "resume", label: "Resume stage", primary: true } : { kind: "run", label: "Run stage", primary: true };
}

/** A stage or sparring turn is in progress as far as the (presented) telemetry says. */
export function isTurnActive(live: LiveState | undefined): boolean {
  return Boolean(live && (live.stage.busy || live.sparrer.busy));
}

/**
 * Whether a loop already ran for this stage: persisted session ids in
 * state.json, or session ids / turns observed in telemetry (the engine
 * persists ids after the first turn, so an interrupted first run counts).
 */
export function hasSessions(run: StandaloneStageSnapshot, live?: LiveState): boolean {
  if (run.stage.state?.implementationSessionId || run.stage.state?.sparringSessionId) {
    return true;
  }
  return Boolean(live && (live.stage.sessionId || live.sparrer.sessionId || live.recentMeaningful.some((entry) => entry.event === "turn.started")));
}

// ---------------------------------------------------------------- branch

export interface GitRepositoryInfo {
  /** Absolute fsPath of the repository root as the Git extension reports it. */
  rootPath: string;
  /** HEAD branch name; undefined when detached or unknown. */
  branch?: string;
}

/**
 * The branch of the Git repository that owns `repoRoot`: the repository whose
 * root is `repoRoot` or its deepest ancestor. Returns undefined when no
 * repository owns the path or its HEAD is detached; callers must then refuse
 * to launch rather than guess.
 */
export function pickBranch(repoRoot: string, repositories: GitRepositoryInfo[]): string | undefined {
  const target = path.resolve(repoRoot);
  const owner = repositories
    .filter((repo) => {
      const root = path.resolve(repo.rootPath);
      const relative = path.relative(root, target);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .sort((a, b) => path.resolve(b.rootPath).length - path.resolve(a.rootPath).length)[0];
  const branch = owner?.branch?.trim();
  return branch ? branch : undefined;
}

// ---------------------------------------------------------------- runner lifecycle

export interface RunnerStatus {
  /** The run id the runner was launched for. */
  runId: string;
  alive: boolean;
  startedAtMs: number;
  endedAtMs?: number;
  /** Process exit code when known; undefined for a signal or an unknown cause. */
  exitCode?: number;
}

/** After this long without any telemetry, an externally launched runner's busy claim is presented as stale. */
export const STALE_ACTIVE_MS = 30 * 60 * 1000;

export interface EffectiveLive {
  live: LiveState | undefined;
  /**
   * The extension's own runner exited while telemetry still had an actor
   * mid-turn: the run was interrupted (Ctrl-C, crash, cancellation) and no
   * turn.finished / verdict will follow.
   */
  interrupted: boolean;
  /** No runner of ours, but the busy claim has had no telemetry for STALE_ACTIVE_MS. */
  stale: boolean;
}

/**
 * Presentation overlay: clear busy claims that a finished runner of ours
 * can no longer back, and flag long-silent busy claims from elsewhere.
 * Never mutates `live`; never touches engine state.
 */
export function applyRunner(live: LiveState | undefined, runner: RunnerStatus | undefined, nowMs: number): EffectiveLive {
  if (!live) {
    return { live, interrupted: false, stale: false };
  }
  const busy = live.stage.busy || live.sparrer.busy;
  if (!busy) {
    return { live, interrupted: false, stale: false };
  }
  if (runner && !runner.alive) {
    // Only a turn that began before the runner ended can have been cut off by it.
    const lastStart = Math.max(Date.parse(live.stage.busySince ?? "") || 0, Date.parse(live.sparrer.busySince ?? "") || 0);
    const endedAt = runner.endedAtMs ?? nowMs;
    if (lastStart <= endedAt) {
      return {
        live: { ...live, stage: { ...live.stage, busy: false, busySince: undefined }, sparrer: { ...live.sparrer, busy: false, busySince: undefined } },
        interrupted: true,
        stale: false,
      };
    }
  }
  if (!runner?.alive) {
    const lastEvent = Date.parse(live.lastEventTs ?? "");
    if (Number.isFinite(lastEvent) && nowMs - lastEvent > STALE_ACTIVE_MS) {
      return { live, interrupted: false, stale: true };
    }
  }
  return { live, interrupted: false, stale: false };
}
