/**
 * A submission of human evidence, from the click until the engine has
 * actually recorded it.
 *
 * **Launching is not submitting.** The first version of this cleared the
 * drafted check results as soon as the launcher reported that it had started
 * a command, which is the one thing about a submission that is never in
 * doubt. Everything that can actually go wrong happens afterwards: the engine
 * refuses the branch, refuses the plan digest, cannot read the manifest, the
 * provider fails, someone presses Ctrl-C, the terminal is closed. Every one
 * of those left the person who had just performed five manual checks looking
 * at an empty form.
 *
 * So a submission is a recorded fact with three states, and only one of them
 * may discard anything:
 *
 *  - **pending** — the engine was launched and has not ended. The drafts stay
 *    exactly as they are, and the panel says `Submitting…` rather than
 *    offering the button again.
 *  - **recorded** — the execution ended with exit code 0. The engine has the
 *    evidence; now, and only now, the drafts are cleared.
 *  - **failed** — anything else, including no exit code at all. The drafts
 *    stay, byte for byte, and the panel says so above the engine's own error.
 *  - **unresolved** — nobody could establish what the runner did, and a
 *    person said so explicitly. Not a success and not a failure: the drafts
 *    stay and the submission becomes retryable. Without this state a runner
 *    whose liveness went unknown left the submission pending for ever and
 *    every evidence action disabled, with the person's work stranded behind
 *    them.
 *
 * The record also keeps the submitted entry verbatim. That is deliberate
 * redundancy: it is the same text the drafts still hold, and it is what makes
 * a failure recoverable even if the drafts are later cleared by something
 * else — the thing that was missing when a real Stage 4 submission was lost.
 *
 * Kept in workspace state, so a window reload mid-submission resolves against
 * the recorded execution instead of waiting forever.
 *
 * No dependency on the vscode API.
 */

import { stageScopeKey } from "./stageScope";

/** Which of the two channels was submitted; each owns its own drafts. */
export type SubmissionChannel = "checks" | "feedback";

export interface SubmissionFailure {
  atMs: number;
  /** Undefined when the execution ended with no exit code at all (Ctrl-C, a signal, the terminal closed). */
  exitCode?: number;
  /** The engine's own last words, when it printed any. Never paraphrased. */
  output?: string;
  /** One sentence naming what happened, in this extension's vocabulary. */
  reason: string;
}

export interface SubmissionRecord {
  runId: string;
  channel: SubmissionChannel;
  /** The execution whose exit code decides this submission. */
  executionId: string;
  startedAtMs: number;
  /** Exactly what was handed to the engine as `--evidence`. */
  entry: string;
  /** How many structured check results the entry carried (0 for a feedback-only submission). */
  results: number;
  /**
   * The stage the evidence belongs to.
   *
   * Required, and half of this record's storage key: a managed plan run keeps
   * one run id across every stage, so without it a Stage 1 failure was still
   * the run's "latest submission" while Stage 2 was being worked on, and the
   * panel said so. See core/stageScope.ts.
   */
  stageId: string;
  /** Set once the execution ended without succeeding; absent while pending. */
  failure?: SubmissionFailure;
  /**
   * Set when a person stated that the runner this submission was handed to is
   * no longer active.
   *
   * Neither `recorded` nor `failed`: the engine never told anyone what
   * happened, and inventing either answer would be a lie about a person's
   * recorded work. What it does is make the submission retryable again — the
   * text is still here, and the buttons are offered — which is the one thing
   * that was missing when a runner went unknown and every evidence action
   * stayed disabled for ever.
   */
  unresolved?: { atMs: number; note: string };
}

/**
 * workspaceState entry: stage scope key (run id + the stage the evidence was
 * entered for) → that stage's latest submission.
 *
 * Scoped rather than keyed by run, because a run outlives its stages: see
 * core/stageScope.ts.
 */
export type Submissions = Record<string, SubmissionRecord>;

export const SUBMISSIONS_KEY = "agentSparring.submissions";

/**
 * workspaceState entry for the auto-push toggle's *draft* position: run id →
 * true.
 *
 * Deliberately named a draft. The permission it leads to is engine run state
 * (`push_authorization`), and this window's memory of a checkbox must never
 * be mistaken for it: a tick that was never turned into an engine command
 * authorizes nothing, and a reload reads the authorization from the engine.
 */
export const AUTO_PUSH_DRAFT_KEY = "agentSparring.autoPushDraft";

/**
 * Where a submission stands. `pending` is the answer whenever anything is
 * unknown — an execution that cannot be found, one still running, one whose
 * liveness this platform could not establish — because the cost of guessing
 * wrong is a person's recorded work, and the cost of waiting is a label.
 */
export type SubmissionState = "pending" | "recorded" | "failed" | "unresolved";

export function submissionState(execution: { state: "running" | "unknown" | "ended"; exitCode?: number } | undefined): SubmissionState {
  if (!execution || execution.state !== "ended") {
    return "pending";
  }
  return execution.exitCode === 0 ? "recorded" : "failed";
}

/** The sentence a submission left unresolved by an unknown runner leads with. */
export const SUBMISSION_UNRESOLVED =
  "Agent Sparring cannot tell whether the engine recorded this evidence — your check results and feedback were preserved, and you can send them again.";

/**
 * Record that a person settled an unknown runner for this submission. The
 * entry, the results count and everything else are kept exactly as they
 * were; only the statement is added.
 */
export function withSubmissionUnresolved(submissions: Submissions | undefined, key: string, unresolved: { atMs: number; note: string }): Submissions {
  const record = submissionFor(submissions, key);
  if (!record) {
    return { ...(submissions ?? {}) };
  }
  return { ...submissions, [key]: { ...record, unresolved } };
}

/** Exit codes that mean a person or a signal stopped it, not that the engine judged anything. */
const INTERRUPTED_EXITS = new Set([130, 143]);

/**
 * What to say about a failed submission. The exit code is reported as itself;
 * nothing here infers a cause from it, because the engine's own output is
 * carried alongside and says what actually happened.
 */
export function submissionFailureReason(exitCode: number | undefined): string {
  if (exitCode === undefined) {
    return "The submission was interrupted before the engine finished (Ctrl-C, a signal, or the terminal was closed).";
  }
  if (INTERRUPTED_EXITS.has(exitCode)) {
    return `The submission was interrupted (exit ${exitCode}) before the engine recorded the evidence.`;
  }
  return `The engine exited with code ${exitCode} without recording the evidence.`;
}

/** The sentence a failed submission leads with. The reassurance comes first: it is the answer to what the person is about to fear. */
export const SUBMISSION_PRESERVED = "Submission failed — your check results and feedback were preserved.";

/**
 * The submission stored under one stage scope key, or undefined.
 *
 * A record that does not name the scope it was found under is rejected
 * rather than shown: a key and a record disagreeing about which run or stage
 * this is means the store was written by something other than
 * {@link withSubmission}, and the one thing this must never do is attribute
 * somebody's evidence to the wrong stage.
 */
export function submissionFor(submissions: Submissions | undefined, key: string): SubmissionRecord | undefined {
  const record = submissions?.[key];
  if (!record || typeof record !== "object" || typeof record.entry !== "string" || (record.channel !== "checks" && record.channel !== "feedback")) {
    return undefined;
  }
  if (typeof record.stageId !== "string" || !record.stageId || typeof record.runId !== "string" || submissionKeyOf(record) !== key) {
    return undefined;
  }
  return record;
}

/** The stage scope key a record belongs under; the only place a submission's key is made. */
export function submissionKeyOf(record: SubmissionRecord): string {
  return stageScopeKey({ runId: record.runId, stageId: record.stageId });
}

export function withSubmission(submissions: Submissions | undefined, record: SubmissionRecord): Submissions {
  return { ...(submissions ?? {}), [submissionKeyOf(record)]: record };
}

export function withSubmissionFailure(submissions: Submissions | undefined, key: string, failure: SubmissionFailure): Submissions {
  const record = submissionFor(submissions, key);
  if (!record) {
    return { ...(submissions ?? {}) };
  }
  return { ...submissions, [key]: { ...record, failure } };
}

export function withoutSubmission(submissions: Submissions | undefined, key: string): Submissions {
  const next: Submissions = { ...(submissions ?? {}) };
  delete next[key];
  return next;
}

/**
 * The submission handed to one exact execution, wherever it is stored.
 *
 * This is how a confirmation dialog finds the submission it is about. The
 * execution id comes from the surface the person was looking at, and it is
 * the strongest identity in the store — stronger than "the current stage's
 * submission", which by the time a click arrives may be a different stage's
 * entirely. The run is required as well, so a confirmation about a runner of
 * one run can never reach another run's record even if the two windows ever
 * produced the same execution id.
 */
export function submissionByExecution(submissions: Submissions | undefined, executionId: string, runId: string): { key: string; record: SubmissionRecord } | undefined {
  for (const key of Object.keys(submissions ?? {})) {
    const record = submissionFor(submissions, key);
    if (record?.executionId === executionId && record.runId === runId) {
      return { key, record };
    }
  }
  return undefined;
}
