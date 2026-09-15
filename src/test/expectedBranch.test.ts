/**
 * A managed plan run records `expected_branch`, and the engine refuses to
 * resume it on any other branch. The extension used to prompt for that
 * value anyway, pre-filled with the recorded branch — a one-option
 * selector, where anything the person typed other than the pre-filled value
 * would be refused by the engine moments later.
 *
 * These are the three outcomes that replace it: use it silently, explain
 * the mismatch, or ask when nothing has been recorded yet.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideExpectedBranch } from "../core/expectedBranch";

describe("the expected branch of a managed run is resolved, not chosen", () => {
  it("uses the recorded branch with no prompt when the repository is on it", () => {
    assert.deepEqual(decideExpectedBranch("feature/reported-statistics-contract", "feature/reported-statistics-contract"), {
      kind: "use",
      branch: "feature/reported-statistics-contract",
    });
  });

  it("explains the mismatch, naming both branches, instead of asking", () => {
    assert.deepEqual(decideExpectedBranch("feature/x", "main"), {
      kind: "mismatch",
      expected: "feature/x",
      actual: "main",
    });
  });

  it("reports a detached or unreadable HEAD as a mismatch with no actual branch", () => {
    assert.deepEqual(decideExpectedBranch("feature/x", undefined), {
      kind: "mismatch",
      expected: "feature/x",
      actual: undefined,
    });
    // An empty string is what a failed read looks like; it is not a branch.
    assert.deepEqual(decideExpectedBranch("feature/x", "  "), {
      kind: "mismatch",
      expected: "feature/x",
      actual: undefined,
    });
  });

  it("asks only when nothing has been recorded, suggesting the checked-out branch", () => {
    assert.deepEqual(decideExpectedBranch(undefined, "feature/x"), { kind: "ask", suggestion: "feature/x" });
    assert.deepEqual(decideExpectedBranch(undefined, undefined), { kind: "ask", suggestion: undefined });
  });

  it("treats a blank recorded branch as nothing recorded — it cannot be what the engine enforces", () => {
    assert.deepEqual(decideExpectedBranch("   ", "feature/x"), { kind: "ask", suggestion: "feature/x" });
  });

  it("ignores surrounding whitespace on both sides rather than calling it a mismatch", () => {
    assert.deepEqual(decideExpectedBranch(" feature/x ", "feature/x\n"), { kind: "use", branch: "feature/x" });
  });
});
