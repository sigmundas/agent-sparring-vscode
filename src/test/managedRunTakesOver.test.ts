/**
 * The reported sequence: Stage 3D existed as a standalone stage and was
 * adopted into a managed manifest plan run. Its evidence was submitted, the
 * reviewer returned READY, the engine accepted it and advanced to Stage 4 —
 * and the Overview went back to showing
 *
 *   Standalone stage · Stage 3D · Accepted
 *
 * offering Continue plan automatically and Start next stage, both of which
 * the live managed run had already done.
 *
 * Two things made that happen, and both are exercised here against a real
 * `.sparring` tree:
 *
 *  - the plan document of a real plan carries `## Stage 3D handoff — …`
 *    sections, which the engine-shaped plan parser refuses, so the plan run
 *    knows no stage list and claims only its *current* stage. The moment it
 *    advances, the stage it came from is a standalone accepted run again;
 *  - an explicit selection then won unconditionally and forever, so the
 *    cockpit kept following that finished stage.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun, supersedingPlanRun, type PlanRunSnapshot, type RunSnapshot } from "../core/discovery";
import { buildOverviewModel } from "../core/overviewModel";
import { Workspace } from "./fixtures";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const STAGE_3D = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const STAGE_4 = "stage-4-editor-and-ui-inspection-and-guarded-editing";

/**
 * A plan written the way the real one is: the executable stage sections plus
 * the handoff records that precede them. `## Stage 3D handoff — …` is not a
 * stage definition, and the engine-shaped parser refuses the document
 * because of it.
 */
const PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "The executable stage definitions are the `## Stage <label> — …` sections below.",
  "",
  "## Stage 3D handoff — 2026-09-14 (current stage)",
  "",
  "Status: Stage 3D implemented and self-verified.",
  "",
  "## Canonical stage sequence",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "The transport.",
  "",
  "## Stage 4 — Editor and UI inspection and guarded editing",
  "",
  "The editor.",
  "",
].join("\n");

/** The project as it stands after the managed run accepted 3D and advanced to 4. */
async function afterAdvancement(): Promise<{ ws: Workspace; runs: RunSnapshot[]; plan: PlanRunSnapshot; stage: RunSnapshot }> {
  const ws = await Workspace.create();
  await ws.writePlan(PLAN_LABEL, PLAN);
  await ws.writeStage(STAGE_3D, { status: "accepted", candidate_sha: "c".repeat(40) });
  await ws.writeStage(STAGE_4, { status: "working" });
  // Written last, as the engine writes it when it advances.
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage: STAGE_4, current_stage_index: 6, source: "manifest" });
  const runs = (await discoverRuns([ws.location])).runs;
  const plan = runs.find((run): run is PlanRunSnapshot => run.kind === "plan");
  const stage = runs.find((run) => run.kind === "stage" && run.stage.stageId === STAGE_3D);
  assert.ok(plan && stage);
  return { ws, runs, plan, stage };
}

describe("a managed run that advances past the stage it adopted", () => {
  it("still exposes that stage as a standalone run, because the plan document names no stage list", async () => {
    const { plan, runs } = await afterAdvancement();
    assert.ok(plan.planError, "the engine-shaped parser refuses a document with handoff sections");
    assert.deepEqual(plan.stages, [], "so the run claims no stage list");
    assert.equal(plan.currentStage.stageId, STAGE_4, "only its current stage is claimed");
    assert.ok(
      runs.some((run) => run.kind === "stage" && run.stage.stageId === STAGE_3D),
      "and the stage it advanced past is discoverable on its own again — history, which is allowed",
    );
  });

  it("is what the Overview follows, even though a finished stage was the explicit choice", async () => {
    const { plan, stage, runs } = await afterAdvancement();
    const chosenLongAgo = selectRun(runs, { id: stage.id, atMs: plan.stateMtimeMs - 60_000 });
    assert.equal(chosenLongAgo.selected?.id, plan.id, "the plan run advanced after the choice, so the cockpit follows it");
    assert.equal(chosenLongAgo.selected?.kind, "plan");
    assert.equal((chosenLongAgo.selected as PlanRunSnapshot).currentStage.stageId, STAGE_4, "and it is at Stage 4");

    assert.equal(selectRun(runs).selected?.id, plan.id, "with no choice at all, the one open plan run wins as before");
    assert.equal(selectRun(runs, stage.id).selected?.id, plan.id, "a choice recorded before this was tracked counts as long ago");
  });

  it("does not steal a deliberate visit to that history", async () => {
    const { plan, stage, runs } = await afterAdvancement();
    const openedNow = selectRun(runs, { id: stage.id, atMs: plan.stateMtimeMs + 1 });
    assert.equal(openedNow.selected?.id, stage.id, "the plan has not advanced since it was opened, so it stays on screen");
  });

  it("keeps an explicitly chosen run that is still going, and one with no plan beside it", async () => {
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_LABEL, PLAN);
    await ws.writeStage(STAGE_3D, { status: "working" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage: STAGE_4, current_stage_index: 6, source: "manifest" });
    await ws.writeStage(STAGE_4, { status: "working" });
    const runs = (await discoverRuns([ws.location])).runs;
    const working = runs.find((run) => run.kind === "stage" && run.stage.stageId === STAGE_3D);
    assert.ok(working);
    assert.equal(selectRun(runs, { id: working.id, atMs: 0 }).selected?.id, working.id, "an unfinished stage is never superseded: it is separate work");

    const alone = await Workspace.create();
    await alone.writeStage(STAGE_3D, { status: "accepted" });
    const soloRuns = (await discoverRuns([alone.location])).runs;
    assert.equal(selectRun(soloRuns, { id: soloRuns[0].id, atMs: 0 }).selected?.id, soloRuns[0].id, "with no plan run in the project, an accepted stage stays chosen");
  });

  it("says which run has taken over, and withdraws what that run already owns", async () => {
    const { plan, stage, runs } = await afterAdvancement();
    assert.equal(supersedingPlanRun(stage, runs)?.id, plan.id);
    assert.equal(supersedingPlanRun(plan, runs), undefined, "a plan run is never superseded by itself");

    const selection = { selected: stage, ambiguous: [] };
    const withoutPlan = buildOverviewModel(selection, undefined, {
      handoff: false,
      sparring: false,
      brief: false,
      plan: false,
      associatedPlan: { path: PLAN_LABEL, exists: true, text: PLAN, manualMatch: { label: "3D", title: "Snapshot v2 and attachment/export/import transport" } },
    });
    assert.ok(withoutPlan.continueAutomatically, "on its own, an accepted stage may still be adopted");
    assert.equal(withoutPlan.whatsNext?.kind, "next-stage", "and Start next stage is the way on");

    const taken = buildOverviewModel(selection, undefined, {
      handoff: false,
      sparring: false,
      brief: false,
      plan: false,
      associatedPlan: { path: PLAN_LABEL, exists: true, text: PLAN, manualMatch: { label: "3D", title: "Snapshot v2 and attachment/export/import transport" } },
      activePlanRun: { runId: plan.id, planName: "reported-statistics.md", stageId: STAGE_4, stageLabel: "Stage 4", status: "running" },
      existingStageIds: [STAGE_3D, STAGE_4],
    });
    assert.equal(taken.continueAutomatically, undefined, "adopting a second time is not offered while the managed run is live");
    assert.equal(taken.whatsNext?.kind, "next-created", "and neither is creating a stage the engine has already created");
    assert.match(taken.whatsNext?.text ?? "", /already exists/);
    assert.equal(taken.followPlan?.runId, plan.id);
    assert.match(taken.followPlan?.text ?? "", /managed plan run, now at Stage 4/);
    assert.equal(taken.followPlan?.label, "Show running plan");
  });
});
