/**
 * The shared run model behind the Runs view and the picker:
 *
 *  - worktree discovery input: `git worktree list --porcelain`, which
 *    worktrees are worth probing, and repository families;
 *  - RunSummary: only what the engine recorded (status, next_turn, outcome,
 *    typed gates), never a guess;
 *  - the index: this repository and its worktrees first, open before recent,
 *    bounded history, other repositories last.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, locateExternalWorktree, type RunSnapshot } from "../core/discovery";
import { DEFERRED_VERIFICATION_REQUIRED } from "../core/engineFormats";
import type { PlanMembership } from "../core/planMembership";
import { buildRunIndex } from "../core/runIndex";
import { initialRunFocus } from "../core/runPick";
import { formatWhen, runFacts, runRowDescription, summarizeRun } from "../core/runSummary";
import { externalWorktrees, familyResolver, parseWorktreeList } from "../core/worktrees";
import { Workspace, sparringMarkdown } from "./fixtures";

const PLAN = "# Tidy the cockpit\n\n## Stage 1 — One\nbody\n## Stage 2 — Two\nbody\n";

const PORCELAIN = [
  "worktree /code/app",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /code/app-agent-run",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/sparring/fix-1",
  "locked",
  "",
  "worktree /code/app-detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
  "worktree /tmp/gone",
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/old",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

async function planRun(ws: Workspace, key: string, status: "running" | "paused" | "complete", stageIndex = 0): Promise<void> {
  await ws.writePlan(`docs/plans/${key}.md`, PLAN);
  await ws.writePlanRun(key, { plan: `docs/plans/${key}.md`, status, current_stage_index: stageIndex, current_stage: `${key}-stage-${stageIndex + 1}-${["one", "two"][stageIndex]}` });
}

async function setMtime(ws: Workspace, key: string, ms: number): Promise<void> {
  const fs = await import("node:fs/promises");
  const file = path.join(ws.sparringDir, "plans", `${key}.json`);
  await fs.utimes(file, ms / 1000, ms / 1000);
}

function keys(entries: readonly { summary: { runKey: string } }[]): string[] {
  return entries.map((entry) => entry.summary.runKey);
}

describe("git worktree list", () => {
  it("parses porcelain records, including detached, locked and prunable worktrees", () => {
    const worktrees = parseWorktreeList(PORCELAIN);
    assert.deepEqual(
      worktrees.map((w) => [w.path, w.branch, w.detached, w.locked !== undefined, w.prunable !== undefined]),
      [
        ["/code/app", "main", false, false, false],
        ["/code/app-agent-run", "sparring/fix-1", false, true, false],
        ["/code/app-detached", undefined, true, false, false],
        ["/tmp/gone", "old", false, false, true],
      ],
    );
  });

  it("probes only worktrees no workspace folder or discovered project already covers, and never a prunable one", () => {
    const lists = [
      { repoRoot: "/code/app", worktrees: parseWorktreeList(PORCELAIN) },
      // A second known root listing the same family must not duplicate it.
      { repoRoot: "/code/app-detached", worktrees: parseWorktreeList(PORCELAIN) },
    ];
    const external = externalWorktrees(lists, ["/code/app"], ["/code/app-detached"]);
    assert.deepEqual(
      external.map((w) => [w.path, w.siblingOf, w.branch]),
      [["/code/app-agent-run", "/code/app", "sparring/fix-1"]],
    );
  });

  it("every worktree of one repository resolves to the same family; unknown roots are their own", () => {
    const familyOf = familyResolver([{ repoRoot: "/code/app", worktrees: parseWorktreeList(PORCELAIN) }]);
    assert.equal(familyOf("/code/app-agent-run"), "/code/app");
    assert.equal(familyOf("/code/app-detached"), "/code/app");
    assert.equal(familyOf("/code/other"), "/code/other");
  });

  it("a worktree outside the workspace with a .sparring becomes an external location", async () => {
    const ws = await Workspace.create({ name: "app-agent-run" });
    const location = await locateExternalWorktree({ path: ws.root, siblingOf: "/code/app", branch: "sparring/fix-1" });
    assert.deepEqual(location?.external, { siblingOf: "/code/app", branch: "sparring/fix-1" });
    assert.equal(location?.workspaceFolder, ws.root);
    const bare = await Workspace.create({ name: "no-sparring", sparring: false });
    assert.equal(await locateExternalWorktree({ path: bare.root, siblingOf: "/code/app" }), undefined);
  });
});

describe("run summary", () => {
  it("states phase, stage position and the engine's own next actor", async () => {
    const ws = await Workspace.create();
    await planRun(ws, "tidy", "running", 1);
    await ws.writeStage("tidy-stage-2-two", { next_turn: "sparring" } as never);
    const [run] = (await discoverRuns([ws.location])).runs;
    const summary = summarizeRun(run);
    assert.equal(summary.title, "Tidy the cockpit");
    assert.equal(summary.planFile, "tidy.md");
    assert.equal(summary.phase, "running");
    assert.equal(summary.statusWord, "Running");
    assert.deepEqual([summary.stage?.position, summary.stage?.total], [2, 2]);
    assert.equal(summary.actor, "Reviewer");
    assert.equal(summary.gate, undefined, "a running run waits on nobody");
  });

  it("names no actor when the engine recorded none", async () => {
    const ws = await Workspace.create();
    await planRun(ws, "tidy", "paused");
    await ws.writeStage("tidy-stage-1-one");
    const [run] = (await discoverRuns([ws.location])).runs;
    assert.equal(summarizeRun(run).actor, undefined);
    assert.equal(summarizeRun(run).phase, "paused");
  });

  it("a paused run with NEEDS_YOU needs you, and says on what", async () => {
    const ws = await Workspace.create();
    await planRun(ws, "tidy", "paused");
    await ws.writeStage("tidy-stage-1-one", {}, { "sparring.md": sparringMarkdown("NEEDS_YOU", "Check the device", "Only you can run the device test") });
    const [run] = (await discoverRuns([ws.location])).runs;
    const summary = summarizeRun(run);
    assert.equal(summary.phase, "needs-you");
    assert.equal(summary.outcome?.word, "Needs you");
    assert.ok(summary.gate, "a gate is reported");
    assert.match(summary.gate.text, /device/i);
  });

  it("a typed awaiting reason is a gate even without a verdict", async () => {
    const ws = await Workspace.create();
    await ws.writePlan("docs/plans/tidy.md", PLAN);
    await ws.writePlanRun("tidy", {
      plan: "docs/plans/tidy.md",
      status: "paused",
      current_stage_index: 0,
      current_stage: "tidy-stage-1-one",
      awaiting: { kind: DEFERRED_VERIFICATION_REQUIRED, reason: "plan_completion", instance_ids: ["gate-1"] },
    });
    const [run] = (await discoverRuns([ws.location])).runs;
    assert.deepEqual([summarizeRun(run).phase, summarizeRun(run).gate?.kind], ["needs-you", "deferred-verification"]);
  });

  it("formats dates the way a person reads them", () => {
    const now = new Date(2026, 9, 6, 12, 0).getTime();
    assert.equal(formatWhen(new Date(2026, 9, 6, 10, 42).getTime(), now), "Today 10:42");
    assert.equal(formatWhen(new Date(2026, 9, 5, 23, 18).getTime(), now), "Yesterday 23:18");
    assert.equal(formatWhen(new Date(2026, 9, 4, 9, 0).getTime(), now), "Oct 4");
    assert.equal(formatWhen(new Date(2025, 9, 4, 9, 0).getTime(), now), "Oct 4, 2025");
  });

  it("a run row reads status · stage · when, and expands into recorded facts only", async () => {
    const ws = await Workspace.create();
    await planRun(ws, "tidy", "running", 1);
    await ws.writeStage("tidy-stage-2-two", { next_turn: "stage" } as never, { "sparring.md": sparringMarkdown("SEND_BACK", "Fix the label") });
    const [run] = (await discoverRuns([ws.location])).runs;
    const summary = summarizeRun(run);
    const now = summary.updatedAtMs;
    assert.match(runRowDescription(summary, now), /^Running · Stage 2 of 2 · Today \d\d:\d\d$/);
    assert.deepEqual(
      runFacts(summary).map((fact) => [fact.label, fact.description]),
      [
        ["Stage 2 of 2", "Two"],
        ["Next", "Implementer"],
        ["Last review", "Changes requested"],
      ],
    );
  });
});

describe("run index", () => {
  it("open runs first (running, then needs you, then paused), completed newest first", async () => {
    const ws = await Workspace.create();
    await planRun(ws, "paused-old", "paused");
    await planRun(ws, "running", "running");
    await planRun(ws, "done-old", "complete");
    await planRun(ws, "done-new", "complete");
    await setMtime(ws, "done-old", Date.now() - 86_400_000 * 3);
    await setMtime(ws, "done-new", Date.now() - 1_000);
    const index = buildRunIndex((await discoverRuns([ws.location])).runs, { followedRoot: ws.root });
    assert.deepEqual(keys(index.open), ["running", "paused-old"]);
    assert.deepEqual(keys(index.recent), ["done-new", "done-old"]);
    assert.deepEqual(index.other, []);
  });

  it("recent history is bounded, and the rest is counted for Show older runs", async () => {
    const ws = await Workspace.create();
    for (let i = 0; i < 5; i++) {
      await planRun(ws, `done-${i}`, "complete");
      await setMtime(ws, `done-${i}`, Date.now() - i * 60_000);
    }
    const runs = (await discoverRuns([ws.location])).runs;
    const bounded = buildRunIndex(runs, { followedRoot: ws.root, recentLimit: 2 });
    assert.deepEqual(keys(bounded.recent), ["done-0", "done-1"]);
    assert.equal(bounded.hidden, 3);
    const all = buildRunIndex(runs, { followedRoot: ws.root, recentLimit: 2, showOlder: true });
    assert.equal(all.recent.length, 5);
    assert.equal(all.hidden, 0);
  });

  it("the pinned or shown run is listed even beyond the bounds", async () => {
    const ws = await Workspace.create();
    for (let i = 0; i < 4; i++) {
      await planRun(ws, `done-${i}`, "complete");
      await setMtime(ws, `done-${i}`, Date.now() - i * 60_000);
    }
    const runs = (await discoverRuns([ws.location])).runs;
    const oldest = runs.find((run) => run.kind === "plan" && run.runKey === "done-3")!;
    const index = buildRunIndex(runs, { followedRoot: ws.root, recentLimit: 1, keepIds: [oldest.id] });
    assert.deepEqual(keys(index.recent), ["done-0", "done-3"]);
    assert.equal(index.hidden, 2);
  });

  it("the picker highlights a running run in a sibling worktree of the followed repository", async () => {
    const main = await Workspace.create({ name: "app" });
    const agentWorktree = await Workspace.create({ name: "app-agent-run" });
    await planRun(agentWorktree, "agent", "running");
    // A sibling worktree that is open in the workspace too: only its family says it is the same repository.
    const runs = (await discoverRuns([main.location, agentWorktree.location])).runs;
    assert.equal(initialRunFocus(runs, undefined, main.root), undefined, "without families, a sibling worktree is another repository");
    const familyOf = (root: string) => (root === agentWorktree.root ? main.root : root);
    assert.equal(initialRunFocus(runs, undefined, main.root, undefined, familyOf)?.id, runs[0].id);
  });

  it("a run in a sibling worktree of the followed repository is this repository's, not another's", async () => {
    const main = await Workspace.create({ name: "app" });
    const agentWorktree = await Workspace.create({ name: "app-agent-run" });
    const unrelated = await Workspace.create({ name: "other" });
    await planRun(agentWorktree, "agent", "running");
    await planRun(unrelated, "elsewhere", "running");
    const external = await locateExternalWorktree({ path: agentWorktree.root, siblingOf: main.root });
    assert.ok(external);
    const runs = (await discoverRuns([main.location, external, unrelated.location])).runs;
    const familyOf = (root: string) => (root === agentWorktree.root ? main.root : root);
    const index = buildRunIndex(runs, { followedRoot: main.root, familyOf });
    assert.deepEqual(keys(index.open), ["agent"]);
    assert.deepEqual(
      index.other.map((repository) => [repository.name, keys(repository.entries)]),
      [["other", ["elsewhere"]]],
    );
    assert.equal(index.open[0].summary.repository.external?.siblingOf, main.root);
  });

  it("other repositories keep their open runs and only a few recent ones", async () => {
    const here = await Workspace.create({ name: "here" });
    const there = await Workspace.create({ name: "there" });
    await planRun(there, "there-open", "paused");
    for (let i = 0; i < 4; i++) {
      await planRun(there, `there-done-${i}`, "complete");
      await setMtime(there, `there-done-${i}`, Date.now() - i * 60_000);
    }
    const runs = (await discoverRuns([here.location, there.location])).runs;
    const index = buildRunIndex(runs, { followedRoot: here.root, otherRecentLimit: 2 });
    assert.deepEqual(index.open, []);
    assert.deepEqual(keys(index.other[0].entries), ["there-open", "there-done-0", "there-done-1"]);
    assert.equal(index.hidden, 2);
  });

  it("a standalone stage a plan run claims is that plan's history, listed only with older runs", async () => {
    const ws = await Workspace.create();
    await planRun(ws, "tidy", "running");
    await ws.writeStage("loose-stage", { status: "accepted" });
    const runs = (await discoverRuns([ws.location])).runs;
    const stage = runs.find((run): run is Extract<RunSnapshot, { kind: "stage" }> => run.kind === "stage" && run.stage.stageId === "loose-stage");
    assert.ok(stage);
    const memberships = new Map<string, PlanMembership>([
      [stage.id, { planRunId: runs.find((run) => run.kind === "plan")!.id, planName: "Tidy", planStatus: "running", currentStageId: "tidy-stage-1-one" }],
    ]);
    const index = buildRunIndex(runs, { followedRoot: ws.root, memberships });
    assert.ok(![...index.open, ...index.recent].some((entry) => entry.run === stage));
    assert.equal(index.hidden, 1);
    assert.ok(buildRunIndex(runs, { followedRoot: ws.root, memberships, showOlder: true }).recent.some((entry) => entry.run === stage));
  });

  it("without a followed repository, every run is this repository's", async () => {
    const a = await Workspace.create({ name: "a" });
    const b = await Workspace.create({ name: "b" });
    await planRun(a, "one", "running");
    await planRun(b, "two", "paused");
    const index = buildRunIndex((await discoverRuns([a.location, b.location])).runs);
    assert.deepEqual(keys(index.open), ["one", "two"]);
    assert.deepEqual(index.other, []);
  });
});
