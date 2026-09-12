import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptStage, explainAcceptanceFailure, firstEngineLine, type CommandOutcome } from "../core/acceptance";

const INVOCATION = { stageId: "stage-reported-statistics-typed-parser", repoRoot: "/code/repo", expectedBranch: "feature/reported-statistics", sparringDir: "/code/repo/.sparring" };

function runner(outcomes: Record<string, CommandOutcome>, calls: string[][]) {
  return async (args: string[]) => {
    calls.push(args);
    const subcommand = args.find((arg) => arg === "freeze-candidate" || arg === "accept-candidate") ?? "";
    return outcomes[subcommand] ?? { exitCode: 1, output: `unexpected ${subcommand}` };
  };
}

describe("Accept stage = freeze-candidate, then accept-candidate", () => {
  it("runs freeze first, then accept, with the same stage / repo / branch, and reports the accepted SHA", async () => {
    const calls: string[][] = [];
    const result = await acceptStage(
      runner(
        {
          "freeze-candidate": { exitCode: 0, output: "frozen candidate: abcdef0123456789abcdef0123456789abcdef01\nbranch: feature/reported-statistics\npushed: ok\n" },
          "accept-candidate": { exitCode: 0, output: "accepted candidate: abcdef0123456789abcdef0123456789abcdef01\nbranch: feature/reported-statistics\n" },
        },
        calls,
      ),
      INVOCATION,
      "darwin",
    );
    assert.deepEqual(calls, [
      ["freeze-candidate", INVOCATION.stageId, "--repo-root", "/code/repo", "--expected-branch", "feature/reported-statistics"],
      ["accept-candidate", INVOCATION.stageId, "--repo-root", "/code/repo", "--expected-branch", "feature/reported-statistics"],
    ]);
    assert.ok(result.ok);
    assert.equal(result.ok && result.candidateSha, "abcdef0123456789abcdef0123456789abcdef01");
    assert.deepEqual(result.ok && result.steps, ["freeze", "accept"]);
  });

  it("never calls accept when freeze fails, and translates the refusal", async () => {
    const calls: string[][] = [];
    const result = await acceptStage(
      runner(
        {
          "freeze-candidate": {
            exitCode: 1,
            output: "could not freeze candidate: refusing to freeze abc123 as the candidate for stage 'x': the working tree holds changes that commit does not represent (src/a.py). Commit or discard them first.\n",
          },
        },
        calls,
      ),
      INVOCATION,
      "darwin",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "freeze-candidate");
    assert.ok(!result.ok);
    assert.equal(!result.ok && result.step, "freeze");
    assert.equal(!result.ok && result.message, "The repository has uncommitted changes. Commit or discard them, then try Accept stage again.");
    assert.match(!result.ok ? result.detail : "", /could not freeze candidate/, "the engine's words are kept for the log");
    assert.ok(!(!result.ok && /freeze failed/i.test(result.message)));
  });

  it("HEAD moved between review and acceptance: understandable wording, not a lifecycle lesson", () => {
    const stale = explainAcceptanceFailure(
      "accept",
      {
        exitCode: 1,
        output:
          "could not accept candidate: the frozen candidate for stage 'x' is aaaa…, but feature/x in /code/repo is now at bbbb…; refusing acceptance as stale. The candidate that changed must be frozen again and go through sparring again before it can be accepted; no commit was created and the frozen candidate was left unchanged.\n",
      },
      "darwin",
    );
    assert.equal(stale.message, "The code changed after the independent review. Run the review again before accepting this stage.");
    assert.equal(stale.retryable, false);
  });

  it("other refusals: not pushed, wrong branch, already accepted, lock held", () => {
    assert.match(explainAcceptanceFailure("freeze", { exitCode: 1, output: "could not freeze candidate: refusing to freeze abc as the candidate for stage 'x': it is not available on the intended remote branch (origin/feature/x is behind)" }).message, /has not been pushed/);
    assert.match(explainAcceptanceFailure("freeze", { exitCode: 1, output: "could not freeze candidate: expected branch 'feature/x' but /code/repo is on 'main'; refusing to freeze a candidate from the wrong branch" }).message, /different branch/);
    assert.equal(explainAcceptanceFailure("freeze", { exitCode: 1, output: "could not freeze candidate: stage 'x' is already ACCEPTED at abc; acceptance is terminal for a stage." }).message, "This stage is already accepted.");
    assert.match(explainAcceptanceFailure("freeze", { exitCode: 1, output: "could not freeze candidate: cannot freeze a candidate for stage 'x': worktree lock is held by another process" }).message, /Another sparring process/);
  });

  it("a failure in the second step after a successful freeze reads as 'could not be finalized' and is retryable", async () => {
    const calls: string[][] = [];
    const result = await acceptStage(
      runner(
        {
          "freeze-candidate": { exitCode: 0, output: "frozen candidate: abc\n" },
          "accept-candidate": { exitCode: 1, output: "could not accept candidate: something unexpected happened\n" },
        },
        calls,
      ),
      INVOCATION,
      "darwin",
    );
    assert.equal(calls.length, 2);
    assert.ok(!result.ok);
    assert.equal(!result.ok && result.step, "accept");
    assert.equal(!result.ok && result.message, "Stage could not be finalized: something unexpected happened");
    assert.equal(!result.ok && result.retryable, true);
    assert.ok(!(!result.ok && /FROZEN|frozen/.test(result.message)), "no internal FROZEN terminology");
  });

  it("the shell reporting command-not-found is a configuration problem, not an engine refusal", () => {
    const explained = explainAcceptanceFailure("freeze", { exitCode: 127, output: "zsh: command not found: sparring" }, "darwin");
    assert.equal(explained.commandNotFound, true);
    assert.match(explained.message, /agentSparring.executable/);
    const interrupted = explainAcceptanceFailure("freeze", { exitCode: undefined, output: "" }, "darwin");
    assert.match(interrupted.message, /did not finish/);
    assert.equal(interrupted.retryable, true);
  });

  it("keeps the engine's own explanation for unknown refusals", () => {
    assert.equal(firstEngineLine("fake sparring: x\ncould not freeze candidate: new refusal wording\n"), "new refusal wording");
    assert.equal(firstEngineLine("  \nsome other stderr\n"), "some other stderr");
    assert.equal(firstEngineLine(""), undefined);
    assert.equal(explainAcceptanceFailure("freeze", { exitCode: 2, output: "could not freeze candidate: new refusal wording" }).message, "The stage could not be accepted: new refusal wording");
  });
});
