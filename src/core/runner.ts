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

export type StageRunActionKind = "run" | "resume" | "rerun" | "accept";

export interface StageRunAction {
  kind: StageRunActionKind;
  label: string;
  /** Primary actions are the obvious next step; a rerun after READY, or Resume while the stage needs the human, are not. */
  primary: boolean;
}

/**
 * The stage actions for the selected run: `primary` is the obvious next
 * step, `secondary` an advanced alternative. Nothing when: the run is a
 * plan run (plan actions apply), the stage is accepted, or a runner is
 * alive / telemetry claims an active turn with unknown liveness (the UI
 * shows a state instead).
 *
 * - fresh stage → Run stage; a stage that ran before → Resume stage;
 * - Needs you / Escalated → Resume stage, not primary: the human request
 *   is what matters and pressing Resume does not answer it;
 * - Review complete (READY) → Accept stage, with Run loop again as the
 *   secondary advanced action;
 * - Finalizing (engine FROZEN, i.e. the acceptance did not complete) →
 *   Accept stage again; the engine allows re-freezing.
 */
export function stageActions(run: RunSnapshot | undefined, liveness?: RunnerLiveness): { primary?: StageRunAction; secondary?: StageRunAction } {
  if (!run || run.kind !== "stage") {
    return {};
  }
  const status = run.stage.state?.status;
  if (status === "accepted") {
    return {};
  }
  if (liveness && blocksLaunch(liveness)) {
    return {};
  }
  const live = liveness?.live;
  const presentation = presentStage(status, run.outcome, live);
  if (presentation.kind === "finalizing") {
    return { primary: { kind: "accept", label: "Accept stage", primary: true } };
  }
  if (presentation.kind === "ready") {
    return { primary: { kind: "accept", label: "Accept stage", primary: true }, secondary: { kind: "rerun", label: "Run loop again", primary: false } };
  }
  const resume = hasSessions(run, live);
  if (presentation.kind === "needs_you" || presentation.kind === "escalate") {
    return { primary: { kind: resume ? "resume" : "run", label: resume ? "Resume stage" : "Run stage", primary: false } };
  }
  return { primary: resume ? { kind: "resume", label: "Resume stage", primary: true } : { kind: "run", label: "Run stage", primary: true } };
}

/** The loop action (Run / Resume / Run loop again) for a stage, or undefined; Accept stage is not a loop launch. */
export function stageRunAction(run: RunSnapshot | undefined, liveness?: RunnerLiveness): StageRunAction | undefined {
  const { primary, secondary } = stageActions(run, liveness);
  if (primary && primary.kind !== "accept") {
    return primary;
  }
  return secondary;
}

// ---------------------------------------------------------------- plan runs

export interface PlanAction {
  kind: "resume" | "continue";
  label: string;
  primary: boolean;
  /** What the button does, for its tooltip. */
  detail: string;
}

/**
 * The engine operation that moves a managed plan run forward, when one
 * applies. Everything is `sparring resume-plan`: it records optional human
 * evidence and continues at the current stage, and it advances past a
 * current stage that is already ACCEPTED without running anything
 * (plan.py: resume_plan). Wording follows the situation:
 *
 * - paused (Needs you / Escalated / a failure) → Resume plan;
 * - recorded as running with no live runner and no active turn → Resume
 *   plan (the run stopped without pausing itself);
 * - current stage ACCEPTED while the plan is not complete → Continue plan;
 * - complete, or a runner alive / liveness unknown mid-turn → nothing.
 */
export function planAction(run: RunSnapshot | undefined, liveness?: RunnerLiveness): PlanAction | undefined {
  if (!run || run.kind !== "plan" || run.state.status === "complete") {
    return undefined;
  }
  if (liveness?.state === "running") {
    return undefined;
  }
  if (run.state.status === "paused") {
    // Paused is authoritative: the engine wrote it as it stopped, so a
    // lingering turn.started in telemetry cannot be a live runner.
  } else if (liveness && blocksLaunch(liveness)) {
    return undefined;
  }
  if (run.currentStage.state?.status === "accepted") {
    return { kind: "continue", label: "Continue plan", primary: true, detail: "sparring resume-plan: the accepted stage is advanced past and the next stage starts." };
  }
  if (run.state.status === "paused") {
    const action = run.currentOutcome?.action;
    const needsHuman = action === "NEEDS_YOU" || action === "ESCALATE";
    return { kind: "resume", label: "Resume plan", primary: !needsHuman, detail: needsHuman ? "sparring resume-plan: record your answer or check result, then the same stage continues." : "sparring resume-plan: continue the plan at its current stage." };
  }
  if (!liveness || liveness.state === "stopped" || (liveness.state === "unknown" && !liveness.turnActive)) {
    return { kind: "resume", label: "Resume plan", primary: true, detail: "sparring resume-plan: the run is recorded as running but no runner is alive; continue it at its current stage." };
  }
  return undefined;
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
