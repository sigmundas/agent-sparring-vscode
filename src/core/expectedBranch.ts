/**
 * What branch to pass as `--expected-branch`, and whether that is a
 * question at all.
 *
 * A managed plan run recorded `expected_branch` when it started, and the
 * engine refuses to resume the run on any other branch. So for a managed
 * run this is not a choice a person makes: either the repository is on that
 * branch, in which case there is exactly one answer and no reason to ask
 * for it, or it is not, in which case the mismatch is the only useful thing
 * to say. Prompting with the recorded branch pre-filled looked like a
 * choice and was not one: the engine would refuse anything else typed
 * there, so the prompt could only confirm a value or produce a failure one
 * step later.
 *
 * Only a plan with no recorded branch is a real question, because nothing
 * has been decided yet.
 *
 * This module is the decision; the caller owns the UI for each outcome.
 */

export type ExpectedBranchDecision =
  /** One answer, no interaction: pass this branch. */
  | { kind: "use"; branch: string }
  /** Nothing is recorded yet, so ask. `suggestion` is the checked-out branch, if any. */
  | { kind: "ask"; suggestion?: string }
  /**
   * A branch is recorded and the repository is somewhere else. Explain that
   * and launch nothing; `actual` is undefined on a detached HEAD or when the
   * branch could not be read.
   */
  | { kind: "mismatch"; expected: string; actual?: string };

/**
 * `recorded` is the run's `expected_branch` (absent for a plan that has
 * never run); `actual` is the checked-out branch, or undefined when HEAD is
 * detached or unreadable.
 *
 * A recorded branch that is blank or whitespace counts as nothing recorded:
 * it cannot be what the engine enforces, so it is a question, not a value.
 */
export function decideExpectedBranch(
  recorded: string | undefined,
  actual: string | undefined,
): ExpectedBranchDecision {
  const expected = recorded?.trim();
  const checkedOut = actual?.trim() || undefined;
  if (!expected) {
    return { kind: "ask", suggestion: checkedOut };
  }
  if (checkedOut === expected) {
    return { kind: "use", branch: expected };
  }
  return { kind: "mismatch", expected, actual: checkedOut };
}
