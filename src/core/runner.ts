/**
 * Running a standalone stage's loop from the extension, and which action a
 * stage may offer.
 *
 * - Which action a stage offers (Run stage / Resume stage / Run loop again /
 *   none) follows from the authoritative StageState and routing outcome,
 *   gated by runner liveness (see liveness.ts): a runner known to be alive,
 *   or a turn that telemetry says is active while liveness is unknown,
 *   never gets a second loop from the button.
 * - The branch passed as --expected-branch comes from the Git repository
 *   that owns the project directory; nothing is guessed.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import type { RunSnapshot, StandaloneStageSnapshot } from "./discovery";
import { blocksLaunch, type RunnerLiveness } from "./liveness";
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
 * for the loop; a run whose runner is alive or whose telemetry shows an
 * active turn with unknown liveness offers nothing (the UI shows a state
 * instead); READY only offers an explicit, non-primary rerun.
 */
export function stageRunAction(run: RunSnapshot | undefined, liveness?: RunnerLiveness): StageRunAction | undefined {
  if (!run || run.kind !== "stage") {
    return undefined;
  }
  const status = run.stage.state?.status;
  if (status === "accepted" || status === "frozen") {
    return undefined;
  }
  if (liveness && blocksLaunch(liveness)) {
    return undefined;
  }
  const live = liveness?.live;
  if (presentStage(status, run.outcome, live).kind === "ready") {
    return { kind: "rerun", label: "Run loop again", primary: false };
  }
  return hasSessions(run, live) ? { kind: "resume", label: "Resume stage", primary: true } : { kind: "run", label: "Run stage", primary: true };
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
