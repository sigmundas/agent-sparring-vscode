import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { activityPathFor, discoverRuns, locateSparringDir, readTomlRepoRoot, resolvePlanPath, selectRun, type PlanRunSnapshot } from "../core/discovery";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, sparringMarkdown } from "./fixtures";

async function discover(ws: Workspace) {
  return discoverRuns([ws.location]);
}

describe("workspace detection", () => {
  it("finds nothing without a .sparring directory", async () => {
    const ws = await Workspace.create({ sparring: false });
    assert.equal(await locateSparringDir(ws.root), undefined);
    const discovery = await discoverRuns([]);
    assert.deepEqual(discovery.runs, []);
    assert.equal(selectRun(discovery.runs).selected, undefined);
  });

  it("detects .sparring and resolves the repo root from project.toml", async () => {
    const ws = await Workspace.create();
    const location = await locateSparringDir(ws.root);
    assert.ok(location);
    assert.equal(location.sparringDir, ws.sparringDir);
    assert.equal(location.repoRoot, ws.root);
    assert.equal(readTomlRepoRoot('[repo]\nroot = "../other" # comment\n'), "../other");
    assert.equal(readTomlRepoRoot('[agents.stage]\nprovider = "claude-cli"\n'), undefined);
  });

  it("resolves plan labels relative to the repo root or absolute", () => {
    assert.equal(resolvePlanPath("docs/plans/foo.md", "/r"), path.join("/r", "docs", "plans", "foo.md"));
    assert.equal(resolvePlanPath("/abs/plan.md", "/r"), path.normalize("/abs/plan.md"));
  });
});

describe("plan run discovery", () => {
  it("an empty .sparring yields no runs", async () => {
    const ws = await Workspace.create();
    const discovery = await discover(ws);
    assert.equal(discovery.runs.length, 0);
    assert.equal(selectRun(discovery.runs).selected, undefined);
  });

  it("one running plan: current stage, total and titles come from authoritative state + plan", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted", candidate_sha: "a" });
    await ws.writeStage(FOO_STAGE_IDS[1], { status: "accepted", candidate_sha: "b" });
    await ws.writeStage(FOO_STAGE_IDS[2], { status: "working" });

    const discovery = await discover(ws);
    assert.equal(discovery.problems.length, 0);
    const selection = selectRun(discovery.runs);
    const run = selection.selected as PlanRunSnapshot;
    assert.equal(run.kind, "plan");
    assert.equal(run.planKey, FOO_PLAN_KEY);
    assert.equal(run.planStages?.length, 3);
    assert.equal(run.currentStage.stageId, FOO_STAGE_IDS[2]);
    assert.equal(run.currentStage.number, 3);
    assert.equal(run.currentStage.title, "Device/UI check!");
    assert.deepEqual(
      run.stages.map((s) => s.state?.status),
      ["accepted", "accepted", "working"],
    );
    assert.equal(activityPathFor(run), ws.activityPath(FOO_STAGE_IDS[2]));
  });

  it("a completed plan is selected only as a fallback and never as open", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    for (const id of FOO_STAGE_IDS) {
      await ws.writeStage(id, { status: "accepted", candidate_sha: "s" });
    }
    const selection = selectRun((await discover(ws)).runs);
    assert.equal(selection.ambiguous.length, 0);
    assert.equal((selection.selected as PlanRunSnapshot).state.status, "complete");
  });

  it("a paused plan exposes the current stage's recorded routing outcome", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: FOO_STAGE_IDS[1] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted" });
    await ws.writeStage(FOO_STAGE_IDS[1], { status: "working" }, { "sparring.md": sparringMarkdown("NEEDS_YOU", "Check on a Pixel 7", "device_manual_check") });
    const run = selectRun((await discover(ws)).runs).selected as PlanRunSnapshot;
    assert.equal(run.state.status, "paused");
    assert.equal(run.currentOutcome?.action, "NEEDS_YOU");
    assert.equal(run.currentOutcome?.summary, "Check on a Pixel 7");
  });

  it("survives a missing plan document: the recorded current stage still wins", async () => {
    const ws = await Workspace.create();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0]);
    const run = selectRun((await discover(ws)).runs).selected as PlanRunSnapshot;
    assert.equal(run.planStages, undefined);
    assert.ok(run.planError);
    assert.equal(run.currentStage.stageId, FOO_STAGE_IDS[0]);
    assert.equal(run.currentStage.number, undefined);
  });

  it("reports an unparseable run-state file as a problem instead of throwing", async () => {
    const ws = await Workspace.create();
    await fs.mkdir(path.join(ws.sparringDir, "plans"), { recursive: true });
    await fs.writeFile(path.join(ws.sparringDir, "plans", "broken.json"), "{ nope");
    const discovery = await discover(ws);
    assert.equal(discovery.runs.length, 0);
    assert.equal(discovery.problems.length, 1);
  });

  it("works for a repository path containing spaces", async () => {
    const ws = await Workspace.create({ withSpaces: true });
    assert.ok(ws.root.includes(" "));
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0]);
    const run = selectRun((await discover(ws)).runs).selected as PlanRunSnapshot;
    assert.equal(run.planPath, path.join(ws.root, "docs", "plans", "foo.md"));
    assert.equal(run.planStages?.length, 3);
    assert.equal(run.currentStage.exists, true);
  });
});

describe("selection rule", () => {
  it("does not guess between two open plan runs", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlan("docs/plans/bar.md", "## Stage 1 — Only\nbody\n");
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writePlanRun("bar-00000000", { plan: "docs/plans/bar.md", status: "paused", current_stage_index: 0, current_stage: "bar-00000000-stage-1-only" });
    const runs = (await discover(ws)).runs;
    const selection = selectRun(runs);
    assert.equal(selection.selected, undefined);
    assert.equal(selection.ambiguous.length, 2);

    // An explicit (persisted) choice resolves it deterministically.
    const chosen = selectRun(runs, runs[0].id);
    assert.equal(chosen.selected?.id, runs[0].id);
    assert.equal(chosen.ambiguous.length, 0);
  });

  it("prefers the single open run over completed ones", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlan("docs/plans/bar.md", "## Stage 1 — Only\nbody\n");
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    await ws.writePlanRun("bar-00000000", { plan: "docs/plans/bar.md", status: "running", current_stage_index: 0, current_stage: "bar-00000000-stage-1-only" });
    const selection = selectRun((await discover(ws)).runs);
    assert.equal((selection.selected as PlanRunSnapshot).planKey, "bar-00000000");
  });

  it("falls back to a standalone stage when no plan run exists, and excludes planned stage dirs", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    let selection = selectRun((await discover(ws)).runs);
    assert.equal(selection.selected?.kind, "stage");

    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0]);
    const runs = (await discover(ws)).runs;
    assert.deepEqual(
      runs.map((r) => r.kind).sort(),
      ["plan", "stage"],
    );
    selection = selectRun(runs);
    assert.equal(selection.selected?.kind, "plan");
  });
});

describe("terminal selections are kept", () => {
  it("a selected working standalone stage stays selected through frozen and accepted", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-local-schema-barrier", { status: "working" });
    const first = selectRun((await discover(ws)).runs);
    assert.equal(first.selected?.kind, "stage");
    const shownId = first.selected!.id;

    await ws.writeStage("stage-local-schema-barrier", { status: "frozen", base_sha: "b", candidate_sha: "c" });
    const frozen = selectRun((await discover(ws)).runs, undefined, shownId);
    assert.equal(frozen.selected?.id, shownId);

    await ws.writeStage("stage-local-schema-barrier", { status: "accepted", base_sha: "b", candidate_sha: "c" });
    const runs = (await discover(ws)).runs;
    assert.equal(runs.length, 1, "the accepted stage is still a recorded run");
    const accepted = selectRun(runs, undefined, shownId);
    assert.equal(accepted.selected?.id, shownId);
    assert.equal(accepted.selected?.kind === "stage" && accepted.selected.stage.state?.status, "accepted");

    // Rediscovery with the same remembered id keeps it too.
    assert.equal(selectRun((await discover(ws)).runs, undefined, shownId).selected?.id, shownId);
  });

  it("an accepted selection survives a simulated reload (only the persisted id remains)", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "accepted", candidate_sha: "c" });
    const persistedId = `stage:${ws.stageDir("hotfix-1")}`;
    const restored = selectRun((await discover(ws)).runs, undefined, persistedId);
    assert.equal(restored.selected?.id, persistedId);
    // An explicit persisted selection is honoured as well.
    assert.equal(selectRun((await discover(ws)).runs, persistedId).selected?.id, persistedId);
  });

  it("with no remembered selection the most recent terminal run is the fallback", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("older", { status: "accepted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ws.writeStage("newer", { status: "accepted" });
    const selection = selectRun((await discover(ws)).runs);
    assert.equal(selection.selected?.kind, "stage");
    assert.equal(selection.selected?.kind === "stage" && selection.selected.stage.stageId, "newer");
  });

  it("a remembered terminal run yields to a newly started open run", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("done", { status: "accepted" });
    const doneId = `stage:${ws.stageDir("done")}`;
    await ws.writeStage("fresh", { status: "working" });
    const selection = selectRun((await discover(ws)).runs, undefined, doneId);
    assert.equal(selection.selected?.kind === "stage" && selection.selected.stage.stageId, "fresh");
  });

  it("a remembered run breaks a tie between several open runs", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("a", { status: "working" });
    await ws.writeStage("b", { status: "working" });
    assert.equal(selectRun((await discover(ws)).runs).selected, undefined);
    const bId = `stage:${ws.stageDir("b")}`;
    assert.equal(selectRun((await discover(ws)).runs, undefined, bId).selected?.id, bId);
  });

  it("a genuinely empty .sparring still selects nothing", async () => {
    const ws = await Workspace.create();
    const selection = selectRun((await discover(ws)).runs, undefined, "stage:/gone");
    assert.equal(selection.selected, undefined);
    assert.equal(selection.ambiguous.length, 0);
  });
});

describe("reload / rediscovery", () => {
  it("a fresh discovery with no in-memory state reproduces the same selection", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: FOO_STAGE_IDS[1] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted" });
    await ws.writeStage(FOO_STAGE_IDS[1]);
    await ws.appendActivity(FOO_STAGE_IDS[1], ['{"v":1,"ts":"2026-09-12T19:00:00.000Z","actor":"loop","event":"loop.started"}\n']);

    const first = selectRun((await discover(ws)).runs);
    const second = selectRun((await discover(ws)).runs); // "after reload": nothing carried over
    assert.equal(first.selected?.id, second.selected?.id);
    assert.equal((second.selected as PlanRunSnapshot).state.status, "paused");
    assert.equal((second.selected as PlanRunSnapshot).currentStage.stageId, FOO_STAGE_IDS[1]);
  });

  it("an externally started run is picked up by the next discovery", async () => {
    const ws = await Workspace.create();
    assert.equal(selectRun((await discover(ws)).runs).selected, undefined);
    // Simulate `sparring run-plan` from a terminal: engine writes state, then the stage.
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0]);
    const selection = selectRun((await discover(ws)).runs);
    assert.equal((selection.selected as PlanRunSnapshot).state.status, "running");
  });

  it("valid authoritative state without any telemetry is fully interpretable", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 1, current_stage: FOO_STAGE_IDS[1] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted" });
    await ws.writeStage(FOO_STAGE_IDS[1]);
    const run = selectRun((await discover(ws)).runs).selected as PlanRunSnapshot;
    await assert.rejects(fs.stat(activityPathFor(run)));
    assert.equal(run.state.status, "running");
    assert.equal(run.currentStage.number, 2);
  });
});
