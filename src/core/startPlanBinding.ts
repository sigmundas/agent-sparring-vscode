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

export function bindStartedRun(pending: PendingStartedRun, runs: readonly RunSnapshot[]): BindOutcome {
  const candidates = runs.filter(
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
          typeof entry.launchedAtMs === "number",
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
