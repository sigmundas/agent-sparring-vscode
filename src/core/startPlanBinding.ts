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
  /**
   * For a run started in its own workspace whose execution has ended: when
   * this window first saw it ended, and how many reads of the engine's
   * record after that gave no answer. Stored, so the bound on following it
   * survives a reload.
   */
  endedSeenAtMs?: number;
  unansweredAfterEnd?: number;
}

/**
 * How long, and through how many unanswered reads of the engine's record, an
 * ended isolated start is followed before it is given up on. Giving up
 * claims nothing about the run: the person is told to find it in "Runs…".
 */
export const UNFOLLOWED_AFTER_MS = 60_000;
export const UNFOLLOWED_AFTER_READS = 5;

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
          (entry.runKey === undefined || typeof entry.runKey === "string") &&
          (entry.endedSeenAtMs === undefined || typeof entry.endedSeenAtMs === "number") &&
          (entry.unansweredAfterEnd === undefined || typeof entry.unansweredAfterEnd === "number"),
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
  /** Isolated starts given up on without a run: the person must be told to look in "Runs…". */
  unfollowed: PendingStartedRun[];
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
   * `"unanswered"`: the record was asked after the end and gave no answer
   * this version reads; counted towards {@link UNFOLLOWED_AFTER_READS}.
   */
  isolatedRecordFresh: (pending: PendingStartedRun) => boolean | "unanswered" = () => false,
  nowMs: number = Date.now(),
): Reconciled {
  const alreadyBound = new Set(Object.keys(state.bindings));
  const notes: string[] = [];
  const retired = new Set<PendingStartedRun>();
  const unfollowed: PendingStartedRun[] = [];
  const updated = new Map<PendingStartedRun, PendingStartedRun>();
  const claims = new Map<string, PendingStartedRun[]>();
  for (const pending of state.pending) {
    const launch = evidence(pending.provisionalRunId);
    if (launch === "none" && pending.runKey !== undefined && pending.endedSeenAtMs !== undefined) {
      // Seen ended before, and this window no longer has its execution (a reload): never a bound-less wait.
      retired.add(pending);
      unfollowed.push(pending);
      notes.push(`the run started in its own workspace as ${pending.runKey} could not be followed automatically after its launch ended; it is not attributed to any run.`);
      continue;
    }
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
    } else if (launch === "ended") {
      const read = pending.runKey === undefined ? true : isolatedRecordFresh(pending);
      if (read === true) {
        retired.add(pending);
        notes.push(`the confirmation ${pending.provisionalRunId} ended and the engine recorded no new run of ${pending.planLabel}.`);
        continue;
      }
      const seen = pending.endedSeenAtMs ?? nowMs;
      const unanswered = (pending.unansweredAfterEnd ?? 0) + (read === "unanswered" ? 1 : 0);
      if (unanswered >= UNFOLLOWED_AFTER_READS || nowMs - seen >= UNFOLLOWED_AFTER_MS) {
        retired.add(pending);
        unfollowed.push(pending);
        notes.push(`the run started in its own workspace as ${pending.runKey} could not be followed automatically: its launch ended and the engine's record of runs gave no answer (${unanswered} reads); it is not attributed to any run.`);
        continue;
      }
      updated.set(pending, { ...pending, endedSeenAtMs: seen, unansweredAfterEnd: unanswered });
    }
  }
  let next: StartPlanRuns = { ...state, pending: state.pending.filter((entry) => !retired.has(entry)).map((entry) => updated.get(entry) ?? entry) };
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
  return { state: next, bound, unfollowed, notes };
}

/**
 * What the person is told when an isolated start is given up on. Plain
 * words, no paths; it claims nothing about whether the run exists.
 */
export function unfollowedStartMessage(pending: PendingStartedRun): string {
  return (
    `The plan run started in its own workspace (${pending.planLabel}) could not be followed automatically: ` +
    `its launch ended and the engine's list of runs could not be read. Use "History / Runs…" to find it once the list can be read, or open its workspace folder. ` +
    `The list is read without your terminal's shell, so if agentSparring.executable is a command only your terminal finds, set it to the full path of sparring.`
  );
}
