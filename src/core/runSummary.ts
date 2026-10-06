/**
 * One run as every list-shaped surface presents it: the native Runs view, the
 * run picker, and any later host (an agent-sessions list) — one model, many
 * renderers.
 *
 * Built **only** from what the engine recorded: the plan-run status, the
 * stage's `next_turn`, the latest routing outcome in `sparring.md`, the
 * structured human gate and the typed `awaiting` / `provider_pause` reasons.
 * Nothing here decides what happens next, infers a transition or reads prose;
 * a field the engine did not record is simply absent.
 *
 * Deliberately shaped like a generic "agent session" item (title, a short
 * description, a status, timing, a tooltip), so another host can adopt it
 * without a second interpretation of engine state.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import { currentStageOf, isOpenRun, totalStagesOf, type RunSnapshot } from "./discovery";
import type { RoutingAction, SparringOutcome } from "./engineFormats";
import { DEFERRED_VERIFICATION_REQUIRED, PUSH_AUTHORIZATION_REQUIRED } from "./engineFormats";
import { planRunDisplayName, type PlanMembership } from "./planMembership";
import { actionWord, presentRunStage, stageDisplayName } from "./presentation";

/**
 * Where a run stands, in the order a person cares about.
 *
 *  - `running`   — a plan run the engine recorded as running.
 *  - `needs-you` — stopped on something only a person can answer: a
 *                  NEEDS_YOU / ESCALATE verdict, or a typed `awaiting` reason.
 *  - `paused`    — a plan run the engine recorded as paused for any other reason.
 *  - `open`      — a standalone stage not yet accepted (no runner records a
 *                  status for it).
 *  - `complete`  — a completed plan run or an accepted standalone stage.
 */
export type RunPhase = "running" | "needs-you" | "paused" | "open" | "complete";

/** Who the engine says acts next (`next_turn`), in a person's words. */
export type RunActor = "Implementer" | "Reviewer" | "Finalizing";

export interface RunGate {
  kind: "human-gate" | "verdict" | "push-authorization" | "deferred-verification" | "provider-pause";
  /** One line: what is waiting, never a command. */
  text: string;
}

export interface RunSummary {
  /** The discovery run id: stable across reloads, and what a pin stores. */
  id: string;
  kind: "plan" | "stage";
  /** What a person calls the job: the plan document's title, or the stage's name. */
  title: string;
  /** The run instance's key (`run` / stage id): secondary, for disambiguation. */
  runKey: string;
  /** The plan file name for a plan run (`docs/plans/foo.md` → `foo.md`). */
  planFile?: string;
  phase: RunPhase;
  /** The phase as one word or two: `Running`, `Needs you`, `Paused`, `Complete`. */
  statusWord: string;
  open: boolean;
  /** `Stage 2` (and `of 5` when known); absent for a standalone stage no plan claims. */
  stage?: { position?: number; total?: number; name: string; stageId: string };
  actor?: RunActor;
  outcome?: { action: RoutingAction; word: string; summary?: string };
  gate?: RunGate;
  /** The engine's last write to the run's state file. */
  updatedAtMs: number;
  repository: {
    /** The project directory that owns `.sparring`: the worktree the run lives in. */
    projectDir: string;
    repoRoot: string;
    /** Short name: the directory's own name. */
    name: string;
    /** Set when the worktree was found through `git worktree list`, outside the workspace. */
    external?: { siblingOf: string; branch?: string };
  };
}

const ACTORS: Record<string, RunActor> = { stage: "Implementer", sparring: "Reviewer", finalization: "Finalizing" };

function outcomeOf(run: RunSnapshot): SparringOutcome | undefined {
  return run.kind === "plan" ? run.currentOutcome : run.outcome;
}

function phaseOf(run: RunSnapshot, outcome: SparringOutcome | undefined): RunPhase {
  if (run.kind === "plan") {
    switch (run.state.status) {
      case "complete":
        return "complete";
      case "running":
        return "running";
      default: {
        const waitingOnPerson = run.state.awaiting !== undefined || outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE";
        return waitingOnPerson ? "needs-you" : "paused";
      }
    }
  }
  if (run.stage.state?.status === "accepted") {
    return "complete";
  }
  return outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE" ? "needs-you" : "open";
}

const PHASE_WORDS: Record<RunPhase, string> = {
  running: "Running",
  "needs-you": "Needs you",
  paused: "Paused",
  open: "Open",
  complete: "Complete",
};

function gateOf(run: RunSnapshot, phase: RunPhase, outcome: SparringOutcome | undefined): RunGate | undefined {
  if (phase === "complete" || phase === "running") {
    return undefined;
  }
  if (run.kind === "plan") {
    const awaiting = run.state.awaiting;
    if (awaiting?.kind === PUSH_AUTHORIZATION_REQUIRED) {
      return { kind: "push-authorization", text: "Waiting for permission to push" };
    }
    if (awaiting?.kind === DEFERRED_VERIFICATION_REQUIRED) {
      return { kind: "deferred-verification", text: "Waiting for a deferred manual check" };
    }
  }
  if (outcome?.humanGate) {
    return { kind: "human-gate", text: outcome.humanGate.title || "A check only you can make" };
  }
  if (outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE") {
    return { kind: "verdict", text: outcome.needsYouReason || outcome.summary || actionWord(outcome.action) };
  }
  if (run.kind === "plan" && run.state.providerPause) {
    const role = run.state.providerPause.role === "sparring" ? "reviewer" : "implementer";
    return {
      kind: "provider-pause",
      text: run.state.providerPause.kind === "provider-unavailable" ? `The ${role}'s provider was unavailable` : `The ${role}'s session could not be resumed`,
    };
  }
  return undefined;
}

function stageOf(run: RunSnapshot, memberships: ReadonlyMap<string, PlanMembership> | undefined): RunSummary["stage"] {
  const stage = currentStageOf(run);
  if (run.kind === "plan") {
    const total = totalStagesOf(run) ?? [...(memberships?.values() ?? [])].find((m) => m.planRunId === run.id && m.totalStages)?.totalStages;
    return { position: run.state.currentStageIndex + 1, ...(total ? { total } : {}), name: stageDisplayName(stage), stageId: stage.stageId };
  }
  const membership = memberships?.get(run.id);
  if (!membership) {
    return undefined;
  }
  return {
    ...(membership.position !== undefined ? { position: membership.position } : {}),
    ...(membership.totalStages ? { total: membership.totalStages } : {}),
    name: membership.stageTitle ?? stageDisplayName(stage),
    stageId: stage.stageId,
  };
}

export function summarizeRun(run: RunSnapshot, memberships?: ReadonlyMap<string, PlanMembership>): RunSummary {
  const outcome = outcomeOf(run);
  const phase = phaseOf(run, outcome);
  const open = isOpenRun(run);
  const stage = currentStageOf(run);
  const nextTurn = stage.state?.nextTurn ?? undefined;
  const actor = open && nextTurn ? ACTORS[nextTurn] : undefined;
  const gate = gateOf(run, phase, outcome);
  const title = run.kind === "plan" ? planRunDisplayName(run) : (memberships?.get(run.id)?.stageTitle ?? stageDisplayName(run.stage));
  return {
    id: run.id,
    kind: run.kind,
    title,
    runKey: run.kind === "plan" ? run.runKey : run.stage.stageId,
    ...(run.kind === "plan" ? { planFile: path.posix.basename(run.state.plan.replace(/\\/g, "/")) } : {}),
    phase,
    statusWord: run.kind === "stage" && phase === "open" ? presentRunStage(run).label : PHASE_WORDS[phase],
    open,
    ...(stageOf(run, memberships) ? { stage: stageOf(run, memberships) } : {}),
    ...(actor ? { actor } : {}),
    ...(outcome ? { outcome: { action: outcome.action, word: actionWord(outcome.action), ...(outcome.summary ? { summary: outcome.summary } : {}) } } : {}),
    ...(gate ? { gate } : {}),
    updatedAtMs: run.stateMtimeMs,
    repository: {
      projectDir: run.location.projectDir,
      repoRoot: run.location.repoRoot,
      name: path.basename(run.location.projectDir),
      ...(run.location.external ? { external: run.location.external } : {}),
    },
  };
}

/** `Stage 2 of 5`, `Stage 2`, or undefined. */
export function stagePositionText(summary: RunSummary): string | undefined {
  const position = summary.stage?.position;
  if (position === undefined) {
    return undefined;
  }
  return summary.stage?.total ? `Stage ${position} of ${summary.stage.total}` : `Stage ${position}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A person's date for `ms`, relative to `nowMs`, in local time:
 * `Today 10:42`, `Yesterday 23:18`, `Oct 4`, or `Oct 4, 2025` in another year.
 */
export function formatWhen(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const now = new Date(nowMs);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (days === 0) {
    return `Today ${clock}`;
  }
  if (days === 1) {
    return `Yesterday ${clock}`;
  }
  const date = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date}, ${at.getFullYear()}`;
}

/** The run row's one-line description: status, stage, when. */
export function runRowDescription(summary: RunSummary, nowMs: number): string {
  return [summary.statusWord, stagePositionText(summary), formatWhen(summary.updatedAtMs, nowMs)].filter(Boolean).join(" · ");
}

/** The facts under an expanded run row, in reading order; only what the engine recorded. */
export function runFacts(summary: RunSummary): { key: string; label: string; description: string; icon?: string }[] {
  const facts: { key: string; label: string; description: string; icon?: string }[] = [];
  const position = stagePositionText(summary);
  if (summary.stage) {
    facts.push({ key: "stage", label: position ?? "Stage", description: summary.stage.name, icon: "list-ordered" });
  }
  if (summary.actor) {
    facts.push({ key: "actor", label: "Next", description: summary.actor, icon: "person" });
  }
  if (summary.outcome) {
    facts.push({ key: "outcome", label: "Last review", description: summary.outcome.word, icon: "comment-discussion" });
  }
  if (summary.gate) {
    facts.push({ key: "gate", label: "Waiting on", description: summary.gate.text, icon: "bell" });
  }
  if (summary.repository.external) {
    facts.push({ key: "worktree", label: "Worktree", description: summary.repository.external.branch ? `${summary.repository.name} (${summary.repository.external.branch})` : summary.repository.name, icon: "git-branch" });
  }
  return facts;
}
