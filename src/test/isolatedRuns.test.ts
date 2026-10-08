/**
 * Runs in their own workspace: the Run Plan choice's arguments, discovery
 * from the engine's `sparring runs --json`, resume from the primary checkout
 * by run key, and following the run by its key across a reload. Every
 * engine answer here is a stub; nothing runs a provider or the engine.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { install } from "./vscodeStub";
install();
import { buildResumePlanArgs, buildRunPlanArgs, buildRunsArgs } from "../core/cli";
import { discoverRuns, locateExternalWorktree, type RunSnapshot } from "../core/discovery";
import { parseIsolatedRuns, EngineFormatError, type IsolatedRun } from "../core/engineFormats";
import { readStartPlanRuns, reconcileStartedRuns, type PendingStartedRun } from "../core/startPlanBinding";
import { externalWorktrees, isolatedRunAt, isolatedWorktreeLists, parseWorktreeList, type IsolatedRunsOfRepository } from "../core/worktrees";
import type { IsolatedRunsProbe as Probe } from "../vscode/isolatedRunsProbe";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IsolatedRunsProbe } = require("../vscode/isolatedRunsProbe") as { IsolatedRunsProbe: typeof Probe };

const KEY = "isolated-demo-0badf00d";

function runsJson(runs: object[], version: unknown = 1): string {
  return JSON.stringify({ schema_version: version, runs });
}

function runsOf(text: string): IsolatedRun[] {
  const report = parseIsolatedRuns(text);
  assert.equal(report.kind, "runs");
  return report.kind === "runs" ? report.runs : [];
}

function engineRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_key: KEY,
    plan_label: "docs/plans/demo.md",
    managed: true,
    worktree_path: "/elsewhere/repo-sparring-isolated-demo-0badf00d",
    worktree_exists: true,
    branch: "sparring/demo-1a2b3c",
    target_branch: "main",
    base_sha: "0".repeat(40),
    created_at: "2026-10-08T00:00:00Z",
    lifecycle: "created",
    run_status: "running",
    git: {},
    finish: {},
    ...overrides,
  };
}

describe("Run Plan: arguments for each choice", () => {
  it("in this checkout keeps today's exact invocation", () => {
    assert.deepEqual(buildRunPlanArgs({ planPath: "/repo/docs/plans/demo.md", repoRoot: "/repo", expectedBranch: "feature/x", runKey: KEY, allowPushForRun: true }), [
      "run-plan",
      "/repo/docs/plans/demo.md",
      "--repo-root",
      "/repo",
      "--expected-branch",
      "feature/x",
      "--run-key",
      KEY,
      "--allow-push-for-run",
    ]);
  });

  it("in its own workspace: same input, run key and push choice, --managed --target-branch, and no --expected-branch", () => {
    const markdown = buildRunPlanArgs({ planPath: "/repo/docs/plans/demo.md", repoRoot: "/repo", expectedBranch: "main", runKey: KEY, isolated: { targetBranch: "main" } });
    assert.deepEqual(markdown, ["run-plan", "/repo/docs/plans/demo.md", "--repo-root", "/repo", "--run-key", KEY, "--managed", "--target-branch", "main"]);
    const manifest = buildRunPlanArgs({ manifest: "/store/m.json", repoRoot: "/repo", expectedBranch: "main", runKey: KEY, allowPushForRun: true, isolated: { targetBranch: "main" } });
    assert.deepEqual(manifest, ["run-plan", "--manifest", "/store/m.json", "--repo-root", "/repo", "--run-key", KEY, "--managed", "--target-branch", "main", "--allow-push-for-run"]);
    assert.ok(!manifest.includes("--expected-branch"));
  });

  it("refuses to build one without a target branch or a run key", () => {
    assert.throws(() => buildRunPlanArgs({ planPath: "/p.md", repoRoot: "/repo", expectedBranch: "", runKey: KEY, isolated: {} }));
    assert.throws(() => buildRunPlanArgs({ planPath: "/p.md", repoRoot: "/repo", expectedBranch: "", isolated: { targetBranch: "main" } }));
  });
});

describe("sparring runs --json", () => {
  it("reads schema v1 strictly", () => {
    assert.deepEqual(buildRunsArgs("/repo"), ["runs", "--repo-root", "/repo", "--json"]);
    const report = parseIsolatedRuns(runsJson([engineRun()]));
    assert.equal(report.kind, "runs");
    assert.deepEqual(report.kind === "runs" ? report.runs : [], [
      {
        runKey: KEY,
        planLabel: "docs/plans/demo.md",
        worktreePath: "/elsewhere/repo-sparring-isolated-demo-0badf00d",
        worktreeExists: true,
        branch: "sparring/demo-1a2b3c",
        targetBranch: "main",
        lifecycle: "created",
        runStatus: "running",
      },
    ]);
  });

  it("an unknown schema version is a mismatch, not a guess; a malformed v1 is an error", () => {
    assert.deepEqual(parseIsolatedRuns(runsJson([engineRun()], 2)), { kind: "version-mismatch", version: 2 });
    assert.throws(() => parseIsolatedRuns(runsJson([engineRun({ lifecycle: "zombie" })])), EngineFormatError);
    assert.throws(() => parseIsolatedRuns(runsJson([engineRun({ managed: false })])), EngineFormatError);
    assert.throws(() => parseIsolatedRuns(runsJson([engineRun({ worktree_path: "relative/x" })])), EngineFormatError);
  });

  it("the probe asks once per root within its cadence, and contributes nothing on a mismatch", async () => {
    const asked: string[] = [];
    const logged: string[] = [];
    let body = runsJson([engineRun()]);
    const probe = new IsolatedRunsProbe(
      (message) => logged.push(message),
      async (root) => {
        asked.push(root);
        return { ok: true, stdout: body };
      },
    );
    assert.equal((await probe.list(["/repo", "/repo/"]))[0].runs.length, 1);
    await probe.list(["/repo"]);
    assert.equal(asked.length, 1, "one root, asked once, cached between refreshes");
    body = runsJson([engineRun()], 9);
    probe.invalidate();
    assert.deepEqual((await probe.list(["/repo"]))[0].runs, []);
    probe.invalidate();
    await probe.list(["/repo"]);
    assert.equal(logged.filter((line) => line.includes("mismatch")).length, 1, "said once");
  });
});

describe("discovery of runs in their own workspace", () => {
  it("adds the record's worktree outside the workspace; a worktree only git lists is not adopted", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isolated-runs-"));
    try {
      const primary = path.join(tmp, "repo");
      const isolatedTree = path.join(tmp, `repo-sparring-${KEY}`);
      const unmanaged = path.join(tmp, "repo-hand-made");
      for (const tree of [primary, isolatedTree, unmanaged]) {
        await fs.mkdir(path.join(tree, ".sparring", "plans"), { recursive: true });
      }
      const state = (run: string) =>
        JSON.stringify({ plan: "docs/plans/demo.md", plan_digest: "0".repeat(64), expected_branch: "sparring/demo-1a2b3c", current_stage: `${run}-stage-1`, current_stage_index: 0, status: "running", source: "markdown", run });
      await fs.writeFile(path.join(isolatedTree, ".sparring", "plans", `${KEY}.json`), state(KEY));
      // A hand-made worktree carrying a run state under the very same key.
      await fs.writeFile(path.join(unmanaged, ".sparring", "plans", `${KEY}.json`), state(KEY));

      const reports: IsolatedRunsOfRepository[] = [{ repoRoot: primary, runs: runsOf(runsJson([engineRun({ worktree_path: isolatedTree })])) }];
      // git knows only the primary and the hand-made worktree here (its
      // answer is cached, say); the engine's record still names the run's.
      const git = [{ repoRoot: primary, worktrees: parseWorktreeList(`worktree ${primary}\nHEAD ${"1".repeat(40)}\nbranch refs/heads/main\n\nworktree ${unmanaged}\nHEAD ${"2".repeat(40)}\nbranch refs/heads/hand\n`) }];
      const candidates = externalWorktrees([...git, ...isolatedWorktreeLists(reports)], [primary], [primary]);
      assert.deepEqual(candidates.map((candidate) => candidate.path).sort(), [isolatedTree, unmanaged].sort());
      assert.ok(candidates.every((candidate) => candidate.siblingOf === primary));

      const locations = (await Promise.all(candidates.map((candidate) => locateExternalWorktree(candidate)))).filter((location) => location !== undefined);
      const runs = (await discoverRuns(locations)).runs.filter((run) => run.kind === "plan");
      const inIsolated = runs.find((run) => run.location.projectDir === isolatedTree);
      const inUnmanaged = runs.find((run) => run.location.projectDir === unmanaged);
      assert.ok(inIsolated && inUnmanaged, "both are discovered as ordinary runs");
      assert.equal(isolatedRunAt(reports, inIsolated.runKey, inIsolated.location.projectDir)?.repoRoot, primary, "the record associates its own worktree");
      assert.equal(isolatedRunAt(reports, inUnmanaged.runKey, inUnmanaged.location.projectDir), undefined, "same key, but no record names this worktree");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("a removed worktree is nothing to probe", () => {
    const reports: IsolatedRunsOfRepository[] = [{ repoRoot: "/repo", runs: runsOf(runsJson([engineRun({ worktree_exists: false })])) }];
    assert.deepEqual(isolatedWorktreeLists(reports), [{ repoRoot: "/repo", worktrees: [] }]);
  });
});

describe("resuming a run in its own workspace", () => {
  it("Markdown: --run-key with the recorded input, --repo-root the primary checkout, no --expected-branch or --sparring-dir", () => {
    const args = buildResumePlanArgs({
      source: "markdown",
      planPath: "/elsewhere/wt/docs/plans/demo.md",
      repoRoot: "/repo",
      expectedBranch: "sparring/demo-1a2b3c",
      sparringDir: "/elsewhere/wt/.sparring",
      runKey: KEY,
      isolated: {},
      evidence: "checked",
    });
    assert.deepEqual(args, ["resume-plan", "/elsewhere/wt/docs/plans/demo.md", "--repo-root", "/repo", "--run-key", KEY, "--evidence", "checked"]);
  });

  it("manifest-backed: resumes as a manifest run, and never from another input kind", () => {
    const args = buildResumePlanArgs({ source: "manifest", manifest: "/store/m.json", repoRoot: "/repo", expectedBranch: "x", runKey: KEY, isolated: {} });
    assert.deepEqual(args, ["resume-plan", "--manifest", "/store/m.json", "--repo-root", "/repo", "--run-key", KEY]);
    assert.throws(() => buildResumePlanArgs({ source: "manifest", planPath: "/p.md", repoRoot: "/repo", expectedBranch: "x", runKey: KEY, isolated: {} }), /manifest plan input/);
  });

  it("is refused without a run key, which is what the engine finds the record by", () => {
    assert.throws(() => buildResumePlanArgs({ source: "markdown", planPath: "/p.md", repoRoot: "/repo", expectedBranch: "x", isolated: {} }), /run key/);
  });
});

describe("following a run in its own workspace by its key", () => {
  const provisional = `/repo|plan:${KEY}`;
  const pending: PendingStartedRun = { provisionalRunId: provisional, sparringDir: "/repo/.sparring", planLabel: "docs/plans/demo.md", before: [], launchedAtMs: 0, show: true, runKey: KEY };
  const run = (projectDir: string, runKey = KEY): RunSnapshot =>
    ({ kind: "plan", id: `${projectDir}|plan:${runKey}`, runKey, location: { projectDir, sparringDir: `${projectDir}/.sparring` }, state: { plan: "docs/plans/demo.md", source: "manifest", status: "running" } }) as unknown as RunSnapshot;
  const reports: IsolatedRunsOfRepository[] = [{ repoRoot: "/repo", runs: runsOf(runsJson([engineRun({ worktree_path: "/elsewhere/wt" })])) }];
  const owns = (candidate: RunSnapshot) => candidate.kind === "plan" && isolatedRunAt(reports, candidate.runKey, candidate.location.projectDir) !== undefined;

  it("waits until the record lists it, then binds to the run in the recorded worktree, surviving a reload", () => {
    // Stored, then read back as a reloaded window would.
    const stored = readStartPlanRuns(JSON.parse(JSON.stringify({ pending: [pending], bindings: {} })));
    assert.equal(stored.pending[0].runKey, KEY);
    const before = reconcileStartedRuns(stored, [], () => "running", owns);
    assert.deepEqual(before.state.pending.map((entry) => entry.runKey), [KEY], "still waiting");
    const after = reconcileStartedRuns(readStartPlanRuns(JSON.parse(JSON.stringify(before.state))), [run("/elsewhere/wt")], () => "running", owns);
    assert.deepEqual(after.bound.map((entry) => entry.runId), [`/elsewhere/wt|plan:${KEY}`]);
    assert.deepEqual(after.state.bindings, { [`/elsewhere/wt|plan:${KEY}`]: provisional });
  });

  it("never binds a worktree the record does not name, nor a run under another key", () => {
    const result = reconcileStartedRuns({ pending: [pending], bindings: {} }, [run("/hand-made"), run("/elsewhere/wt", "other-key")], () => "running", owns);
    assert.deepEqual(result.bound, []);
    assert.equal(result.state.pending.length, 1);
  });
});
