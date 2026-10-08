/**
 * Which recorded plan run a confirmed `start-plan` direct route became.
 *
 * On the direct route the engine mints the run key itself (start-plan
 * clears any `--run-key`), so the extension launches the confirmation under
 * a provisional run id and learns the real one only from the engine's own
 * run state. The evidence is structural, never a guess from timing or
 * prose: start-plan's preflight refuses while any run of the plan is open,
 * so a run of this plan label, recorded from Markdown in this exact sparring
 * directory, that was not there when the confirmation was launched, can only
 * be the one it started. Exactly one such run binds; none waits; more than
 * one binds nothing.
 *
 * No dependency on the vscode API.
 */

import { samePath, type RunSnapshot } from "./discovery";

export const START_PLAN_RUNS_KEY = "agentSparring.startPlanRuns";

/** A confirmation launched under a provisional id, waiting for its run to be recorded. */
export interface PendingStartedRun {
  provisionalRunId: string;
  sparringDir: string;
  planLabel: string;
  /** Plan run ids already discovered in that project when the confirmation was launched. */
  before: string[];
  launchedAtMs: number;
  /** Show the run once it is bound (the person just pressed Start). */
  show: boolean;
  /**
   * Set for a run started in its own workspace: the key the extension minted
   * for it. Such a run is recorded in a worktree the engine creates, not in
   * `sparringDir`, so it binds by this key to the run whose worktree the
   * engine's own record names (`sparring runs --json`) — never by plan label.
   */
  runKey?: string;
}

export interface StartPlanRuns {
  pending: PendingStartedRun[];
  /** Engine run id → the provisional id its execution and guard were filed under. */
  bindings: Record<string, string>;
}

export const EMPTY_START_PLAN_RUNS: StartPlanRuns = { pending: [], bindings: {} };

/** How many bindings are kept; older ones belong to runs long since settled. */
const BINDINGS_KEPT = 32;

export type BindOutcome = { kind: "bound"; runId: string } | { kind: "waiting" } | { kind: "ambiguous"; runIds: string[] };

/** Whether the engine's record names the worktree `run` was found in as its run's (see worktrees.ts: isolatedRunAt). */
export type IsolatedOwnership = (run: RunSnapshot) => boolean;

export function bindStartedRun(pending: PendingStartedRun, runs: readonly RunSnapshot[], recordOwns: IsolatedOwnership = () => false): BindOutcome {
  const candidates = pending.runKey !== undefined
    ? runs.filter((run) => run.kind === "plan" && run.runKey === pending.runKey && run.id !== pending.provisionalRunId && recordOwns(run))
    : runs.filter(
    (run) =>
      run.kind === "plan" &&
      samePath(run.location.sparringDir, pending.sparringDir) &&
      run.state.plan === pending.planLabel &&
      run.state.source === "markdown" &&
      run.id !== pending.provisionalRunId &&
      !pending.before.includes(run.id),
  );
  if (candidates.length === 1) {
    return { kind: "bound", runId: candidates[0].id };
  }
  return candidates.length === 0 ? { kind: "waiting" } : { kind: "ambiguous", runIds: candidates.map((run) => run.id) };
}

/** A stored value read defensively: anything malformed is nothing. */
export function readStartPlanRuns(value: unknown): StartPlanRuns {
  const record = value && typeof value === "object" ? (value as Partial<StartPlanRuns>) : undefined;
  const pending = Array.isArray(record?.pending)
    ? record!.pending.filter(
        (entry): entry is PendingStartedRun =>
          !!entry &&
          typeof entry.provisionalRunId === "string" &&
          typeof entry.sparringDir === "string" &&
          typeof entry.planLabel === "string" &&
          Array.isArray(entry.before) &&
          typeof entry.launchedAtMs === "number" &&
          (entry.runKey === undefined || typeof entry.runKey === "string"),
      )
    : [];
  const bindings: Record<string, string> = {};
  for (const [runId, provisional] of Object.entries(record?.bindings && typeof record.bindings === "object" ? record.bindings : {})) {
    if (typeof provisional === "string") {
      bindings[runId] = provisional;
    }
  }
  return { pending, bindings };
}

/** Record a binding, keeping the newest {@link BINDINGS_KEPT}. */
export function withBinding(state: StartPlanRuns, runId: string, provisionalRunId: string): StartPlanRuns {
  const entries = Object.entries(state.bindings).filter(([id]) => id !== runId);
  entries.push([runId, provisionalRunId]);
  return { pending: state.pending.filter((entry) => entry.provisionalRunId !== provisionalRunId), bindings: Object.fromEntries(entries.slice(-BINDINGS_KEPT)) };
}

/** What this window can still say about a confirmation's launch. */
export type LaunchEvidence = "running" | "submitted" | "ended" | "none";

export interface Reconciled {
  state: StartPlanRuns;
  bound: { pending: PendingStartedRun; runId: string }[];
  notes: string[];
}

/**
 * Bind every pending confirmation that the engine's state now proves, and
 * retire the ones that can no longer produce a run. A run is bound only if
 * exactly one pending confirmation claims it and it is not already bound,
 * so an abandoned confirmation can never take a later run from the one
 * that started it. A confirmation with no execution and no submission left
 * (`none`) was never handed to a shell, or its submission was resolved as
 * not started: it retires without binding anything.
 */
export function reconcileStartedRuns(
  state: StartPlanRuns,
  runs: readonly RunSnapshot[],
  evidence: (provisionalRunId: string) => LaunchEvidence,
  recordOwns: IsolatedOwnership = () => false,
  /**
   * Whether the engine's run records for this start's repository were read
   * *successfully* (a supported-schema report) after its execution ended. An
   * isolated start that ended may have recorded its run just before exiting;
   * a record read earlier, or a read that failed, cannot show it, so without
   * such a read the start keeps waiting instead of retiring.
   */
  isolatedRecordFresh: (pending: PendingStartedRun) => boolean = () => false,
): Reconciled {
  const alreadyBound = new Set(Object.keys(state.bindings));
  const notes: string[] = [];
  const retired = new Set<PendingStartedRun>();
  const claims = new Map<string, PendingStartedRun[]>();
  for (const pending of state.pending) {
    const launch = evidence(pending.provisionalRunId);
    if (launch === "none") {
      retired.add(pending);
      notes.push(`the confirmation ${pending.provisionalRunId} was never started, so it claims no run of ${pending.planLabel}.`);
      continue;
    }
    const outcome = bindStartedRun(pending, runs.filter((run) => !alreadyBound.has(run.id)), recordOwns);
    if (outcome.kind === "bound") {
      claims.set(outcome.runId, [...(claims.get(outcome.runId) ?? []), pending]);
    } else if (outcome.kind === "ambiguous") {
      retired.add(pending);
      notes.push(`more than one new run of ${pending.planLabel} was recorded (${outcome.runIds.join(", ")}); none is attributed to the confirmation ${pending.provisionalRunId}.`);
    } else if (launch === "ended" && (pending.runKey === undefined || isolatedRecordFresh(pending))) {
      retired.add(pending);
      notes.push(`the confirmation ${pending.provisionalRunId} ended and the engine recorded no new run of ${pending.planLabel}.`);
    }
  }
  let next: StartPlanRuns = { ...state, pending: state.pending.filter((entry) => !retired.has(entry)) };
  const bound: Reconciled["bound"] = [];
  for (const [runId, claimants] of claims) {
    if (claimants.length !== 1) {
      notes.push(`the new run ${runId} could have been started by ${claimants.map((entry) => entry.provisionalRunId).join(" or ")}; it is attributed to neither.`);
      next = { ...next, pending: next.pending.filter((entry) => !claimants.includes(entry)) };
      continue;
    }
    next = withBinding(next, runId, claimants[0].provisionalRunId);
    bound.push({ pending: claimants[0], runId });
    notes.push(`the run started as ${claimants[0].provisionalRunId} is ${runId}, the only new run of ${claimants[0].planLabel} the engine recorded.`);
  }
  return { state: next, bound, notes };
}
