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
import { discoverRuns, locateExternalWorktree, locateRecordedWorktree, type PlanRunSnapshot, type RunSnapshot } from "../core/discovery";
import { manifestDigest, manifestPathFor, renderBindingRecord, renderManifest, bindingPathFor, sourceDigest, BINDING_VERSION, type ExecutionManifest } from "../core/manifest";
import { autoPushScope } from "../core/presentation";
import { ManifestReader } from "../vscode/manifestReader";
import { ManifestStore, Workspace, recordPlanDigest } from "./fixtures";
import { parseIsolatedRuns, EngineFormatError, type IsolatedRun } from "../core/engineFormats";
import { UNFOLLOWED_AFTER_MS, UNFOLLOWED_AFTER_READS, readStartPlanRuns, reconcileStartedRuns, unfollowedStartMessage, type PendingStartedRun } from "../core/startPlanBinding";
import { externalWorktrees, isolatedRunAt, isolatedWorktreeLists, manifestRebuildRefusal, parseWorktreeList, runIsolation, type IsolatedRunsOfRepository } from "../core/worktrees";
import type { IsolatedRunsProbe as Probe, RunsReader } from "../vscode/isolatedRunsProbe";
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
    // The engine's own finish check for this run, as `runs --json` embeds it.
    finish: {
      schema_version: 1,
      run_key: overrides["run_key"] ?? KEY,
      managed: true,
      eligible: { merge: false, cleanup: false },
      merge_mode: null,
      actions: [],
      checks: [{ code: "run_not_complete", ok: false, detail: "the run is running, not complete" }],
      deleted_ignored_paths: [],
      kept: [],
      summary: "cannot be finished: run_not_complete",
    },
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
        finish: {
          runKey: KEY,
          eligible: { merge: false, cleanup: false },
          mergeMode: null,
          actions: [],
          checks: [{ code: "run_not_complete", ok: false, detail: "the run is running, not complete" }],
          deletedIgnoredPaths: [],
          kept: [],
          summary: "cannot be finished: run_not_complete",
        },
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

      const reports: IsolatedRunsOfRepository[] = [{ repoRoot: primary, ok: true, runs: runsOf(runsJson([engineRun({ worktree_path: isolatedTree })])) }];
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
    const reports: IsolatedRunsOfRepository[] = [{ repoRoot: "/repo", ok: true, runs: runsOf(runsJson([engineRun({ worktree_exists: false })])) }];
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
  const reports: IsolatedRunsOfRepository[] = [{ repoRoot: "/repo", ok: true, runs: runsOf(runsJson([engineRun({ worktree_path: "/elsewhere/wt" })])) }];
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

describe("review fixes", () => {
  it("finds a nested project inside a recorded worktree, owned by the record", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "isolated-nested-"));
    try {
      const tree = path.join(tmp, `repo-sparring-${KEY}`);
      const nested = path.join(tree, "subproject");
      await fs.mkdir(path.join(nested, ".sparring", "plans"), { recursive: true });
      assert.equal(await locateExternalWorktree({ path: tree, siblingOf: "/repo" }), undefined, "the root-only probe misses it");
      const found = await locateRecordedWorktree({ path: tree, siblingOf: "/repo" });
      assert.deepEqual(found.map((location) => location.projectDir), [nested]);
      assert.equal(found[0].external?.siblingOf, "/repo");
      const reports: IsolatedRunsOfRepository[] = [{ repoRoot: "/repo", ok: true, runs: runsOf(runsJson([engineRun({ worktree_path: tree })])) }];
      assert.ok(isolatedRunAt(reports, KEY, nested), "the record's worktree contains the nested project");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("an isolated start that ended waits for a record read after the end, and is retired only on one", () => {
    const pending: PendingStartedRun = { provisionalRunId: "/repo|plan:" + KEY, sparringDir: "/repo/.sparring", planLabel: "docs/plans/demo.md", before: [], launchedAtMs: 0, show: true, runKey: KEY };
    const recorded = { kind: "plan", id: `/wt|plan:${KEY}`, runKey: KEY, location: { projectDir: "/wt", sparringDir: "/wt/.sparring" }, state: { plan: "docs/plans/demo.md", source: "markdown", status: "paused" } } as unknown as RunSnapshot;
    // The cached (stale, empty) report: not retired.
    const stale = reconcileStartedRuns({ pending: [pending], bindings: {} }, [], () => "ended", () => true, () => false);
    assert.equal(stale.state.pending.length, 1);
    // Reload, then a fresh read that lists the run: bound, though it already paused.
    const fresh = reconcileStartedRuns(readStartPlanRuns(JSON.parse(JSON.stringify(stale.state))), [recorded], () => "ended", () => true, () => true);
    assert.deepEqual(fresh.bound.map((entry) => entry.runId), [`/wt|plan:${KEY}`]);
    // A fresh read that still lists nothing: the engine refused it.
    assert.equal(reconcileStartedRuns({ pending: [pending], bindings: {} }, [], () => "ended", () => true, () => true).state.pending.length, 0);
  });

  it("an ended isolated start whose record never answers is given up on after bounded reads, also across a reload", () => {
    const pending: PendingStartedRun = { provisionalRunId: "/repo|plan:" + KEY, sparringDir: "/repo/.sparring", planLabel: "docs/plans/demo.md", before: [], launchedAtMs: 0, show: true, runKey: KEY };
    let state = { pending: [pending], bindings: {} };
    for (let read = 1; read < UNFOLLOWED_AFTER_READS; read++) {
      const step = reconcileStartedRuns(readStartPlanRuns(JSON.parse(JSON.stringify(state))), [], () => "ended", () => true, () => "unanswered", 1_000);
      assert.equal(step.state.pending.length, 1, `still followed after ${read} unanswered reads`);
      assert.equal(step.state.pending[0].unansweredAfterEnd, read);
      assert.deepEqual(step.unfollowed, []);
      state = step.state;
    }
    const last = reconcileStartedRuns(readStartPlanRuns(JSON.parse(JSON.stringify(state))), [], () => "ended", () => true, () => "unanswered", 1_000);
    assert.equal(last.state.pending.length, 0, "retired");
    assert.deepEqual(last.bound, [], "no ownership inferred");
    assert.deepEqual(last.unfollowed.map((entry) => entry.runKey), [KEY]);
    assert.match(unfollowedStartMessage(last.unfollowed[0]), /could not be followed automatically.*History \/ Runs…/s);
  });

  it("an ended isolated start is given up on after a bounded time, and after a reload that lost its execution", () => {
    const pending: PendingStartedRun = { provisionalRunId: "/repo|plan:" + KEY, sparringDir: "/repo/.sparring", planLabel: "docs/plans/demo.md", before: [], launchedAtMs: 0, show: true, runKey: KEY };
    const first = reconcileStartedRuns({ pending: [pending], bindings: {} }, [], () => "ended", () => true, () => false, 10_000);
    assert.equal(first.state.pending[0].endedSeenAtMs, 10_000);
    const early = reconcileStartedRuns(first.state, [], () => "ended", () => true, () => false, 10_000 + UNFOLLOWED_AFTER_MS - 1);
    assert.equal(early.state.pending.length, 1);
    const late = reconcileStartedRuns(first.state, [], () => "ended", () => true, () => false, 10_000 + UNFOLLOWED_AFTER_MS);
    assert.deepEqual(late.unfollowed.map((entry) => entry.runKey), [KEY]);
    const reloaded = reconcileStartedRuns(readStartPlanRuns(JSON.parse(JSON.stringify(first.state))), [], () => "none", () => true, () => false, 10_001);
    assert.equal(reloaded.state.pending.length, 0);
    assert.deepEqual(reloaded.unfollowed.map((entry) => entry.runKey), [KEY], "the person is told");
    // A run that is still running is never given up on by time.
    const running = reconcileStartedRuns({ pending: [pending], bindings: {} }, [], () => "running", () => true, () => "unanswered", Number.MAX_SAFE_INTEGER);
    assert.equal(running.state.pending.length, 1);
  });

  it("an unknown runs --json schema is shown once per session as a mismatch, not only logged", async () => {
    const shown: string[] = [];
    const probe = new IsolatedRunsProbe(() => undefined, async () => ({ ok: true, stdout: JSON.stringify({ schema_version: 99, runs: [] }) }), (message) => shown.push(message));
    assert.deepEqual(await probe.list(["/repo", "/other"]), [{ repoRoot: "/repo", ok: false, runs: [] }, { repoRoot: "/other", ok: false, runs: [] }]);
    probe.invalidate();
    await probe.list(["/repo"]);
    assert.equal(shown.length, 1);
    assert.match(shown[0], /do not match.*schema_version 99/);
  });

  it("a run once listed as isolated is not rebuilt for when the run list later cannot be read", async () => {
    const answers: Awaited<ReturnType<RunsReader>>[] = [
      { ok: true, stdout: runsJson([engineRun({ worktree_path: "/elsewhere/wt" })]) },
      { ok: false, reason: "sparring: command not found" },
      { ok: true, stdout: JSON.stringify({ schema_version: 99, runs: [] }) },
    ];
    const probe = new IsolatedRunsProbe(() => undefined, async () => answers.shift()!);
    const isolation = async () => {
      probe.invalidate();
      return runIsolation(await probe.list(["/repo"]), KEY, "/elsewhere/wt", "/elsewhere/wt", () => "/repo");
    };
    assert.equal(await isolation(), "isolated");
    const afterFailure = await isolation();
    assert.equal(afterFailure, "unknown", "a failed read establishes nothing, and paths are not read as ownership");
    assert.match(manifestRebuildRefusal(afterFailure, "no binding")!, /Nothing was started/);
    assert.equal(await isolation(), "unknown", "nor does an unsupported schema");
    assert.match(manifestRebuildRefusal("isolated", "no binding")!, /missing.*nothing was started/is);
  });

  it("a manifest run is rebuilt only where a supported report establishes it is in this checkout", () => {
    const ok: IsolatedRunsOfRepository[] = [{ repoRoot: "/repo", ok: true, runs: [] }];
    assert.equal(runIsolation(ok, KEY, "/repo", "/repo"), "checkout");
    assert.equal(manifestRebuildRefusal("checkout", "no binding"), undefined);
    assert.equal(runIsolation([{ repoRoot: "/other", ok: true, runs: [] }], KEY, "/repo", "/repo"), "unknown", "another repository's report says nothing about this one");
    assert.equal(runIsolation([], KEY, "/repo", "/repo"), "unknown");
  });

  it("presentation and resume read the manifest written for the checkout the run was started from", async () => {
    const ws = await Workspace.create();
    const runKey = "demo-0badf00d";
    const stage = `${runKey}-stage-1`;
    await ws.writeStage(stage, { status: "working" });
    await ws.writePlanRun(runKey, { plan: "docs/plans/demo.md", status: "running", current_stage_index: 0, current_stage: stage, source: "manifest" });
    const manifest: ExecutionManifest = { version: 1, plan_label: "docs/plans/demo.md", source_digest: sourceDigest("# Demo\n"), stages: [{ stage_id: stage, label: "Stage 1", title: "Only", brief: "# Only\n" }] };
    const store = await ManifestStore.create();
    const picked = "/picked/checkout";
    const owner = { runKey, planKey: runKey, location: { projectDir: picked } };
    await fs.writeFile(manifestPathFor(store.dir, owner), renderManifest(manifest));
    await fs.writeFile(
      bindingPathFor(store.dir, owner),
      renderBindingRecord({ version: BINDING_VERSION, manifestFile: path.basename(manifestPathFor(store.dir, owner)), manifestDigest: manifestDigest(manifest)!, planKey: runKey, planLabel: "docs/plans/demo.md", projectDir: picked }),
    );
    const first = (await discoverRuns([ws.location])).runs.find((c): c is PlanRunSnapshot => c.kind === "plan")!;
    await recordPlanDigest(first, manifestDigest(manifest)!);
    const run = (await discoverRuns([ws.location])).runs.find((c): c is PlanRunSnapshot => c.kind === "plan")!;
    const reader = new ManifestReader();
    assert.equal((await reader.readBound(store.dir, run)).binding.ok, false, "not under the worktree's own name");
    assert.equal((await reader.readBoundAmong(store.dir, run, [], [])).binding.ok, false, "a run that is not isolated gets no other owners");
    const bound = await reader.readBoundAmong(store.dir, run, [], [picked]);
    assert.equal(bound.binding.ok, true);
    assert.equal(bound.binding.ok && bound.binding.identity.stages[0].stageId, stage);
  });

  it("the push permission for a run in its own workspace does not name the branch it started from", () => {
    assert.doesNotMatch(autoPushScope({ isolated: true, expectedBranch: "main" }), /main/);
    assert.match(autoPushScope({ expectedBranch: "feature/x" }), /feature\/x/);
  });
});

describe("a failed post-exit engine read keeps the follow request", () => {
  it("the probe reports a failed or unsupported answer as not ok, never as no runs", async () => {
    const answers = [
      { ok: false as const, reason: "timed out" },
      { ok: true as const, stdout: "not json" },
      { ok: true as const, stdout: runsJson([], 7) },
      { ok: true as const, stdout: runsJson([]) },
    ];
    const probe = new IsolatedRunsProbe(() => undefined, async () => answers.shift()!);
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      probe.invalidate();
      seen.push((await probe.list(["/repo"]))[0].ok);
    }
    assert.deepEqual(seen, [false, false, false, true]);
  });

  it("failed reads retain the start; a later successful report binds it, and a successful empty one retires it", () => {
    const pending: PendingStartedRun = { provisionalRunId: "/repo|plan:" + KEY, sparringDir: "/repo/.sparring", planLabel: "docs/plans/demo.md", before: [], launchedAtMs: 0, show: true, runKey: KEY };
    const recorded = { kind: "plan", id: `/wt|plan:${KEY}`, runKey: KEY, location: { projectDir: "/wt", sparringDir: "/wt/.sparring" }, state: { plan: "docs/plans/demo.md", source: "markdown", status: "complete" } } as unknown as RunSnapshot;
    let state = { pending: [pending], bindings: {} };
    for (let attempt = 0; attempt < 2; attempt++) {
      state = reconcileStartedRuns(readStartPlanRuns(JSON.parse(JSON.stringify(state))), [], () => "ended", () => true, () => false).state;
      assert.equal(state.pending.length, 1, "a failed read never retires it");
    }
    const bound = reconcileStartedRuns(state, [recorded], () => "ended", () => true, () => true);
    assert.deepEqual(bound.bound.map((entry) => entry.runId), [`/wt|plan:${KEY}`]);
    assert.equal(reconcileStartedRuns(state, [], () => "ended", () => true, () => true).state.pending.length, 0);
  });
});
