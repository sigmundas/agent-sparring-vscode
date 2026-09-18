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
import { NO_STAGE_OWNERSHIP, discoverRuns, selectRun, supersedingPlanRun, type PlanRunSnapshot, type RunSnapshot, type StageOwnership } from "../core/discovery";
import { buildOverviewModel } from "../core/overviewModel";
import { ManifestStore, Workspace, ownershipOf } from "./fixtures";

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

/**
 * The project as it stands after the managed run accepted 3D and advanced to
 * 4 — including the execution manifest that *records* 3D as one of its
 * stages. That record is the whole basis of the takeover: without it there is
 * no evidence this run ever executed 3D, and `owned: false` builds exactly
 * that case.
 */
async function afterAdvancement(options: { owned?: boolean } = {}): Promise<{
  ws: Workspace;
  runs: RunSnapshot[];
  plan: PlanRunSnapshot;
  stage: RunSnapshot;
  ownership: StageOwnership;
  store: ManifestStore;
}> {
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
  const store = await ManifestStore.create();
  await store.write(
    plan,
    options.owned === false
      ? [{ stageId: STAGE_4, label: "Stage 4", title: "Editor and UI inspection and guarded editing" }]
      : [
          { stageId: STAGE_3D, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport" },
          { stageId: STAGE_4, label: "Stage 4", title: "Editor and UI inspection and guarded editing" },
        ],
  );
  return { ws, runs, plan, stage, ownership: await ownershipOf(runs, store), store };
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

  it("is what the Overview follows when the stage was chosen while it was still running", async () => {
    // The reported sequence: 3D was selected *while it was working*, so the
    // request was "watch this work". The plan run then accepted it and moved
    // to Stage 4 — following that plan run is the same request answered.
    const { plan, stage, runs, ownership } = await afterAdvancement();
    const followed = selectRun(runs, { id: stage.id, atMs: plan.stateMtimeMs - 60_000, intent: "follow" }, undefined, undefined, ownership);
    assert.equal(followed.selected?.id, plan.id, "the plan run advanced after the choice, so the cockpit follows it");
    assert.equal(followed.selected?.kind, "plan");
    assert.equal((followed.selected as PlanRunSnapshot).currentStage.stageId, STAGE_4, "and it is at Stage 4");
    assert.equal(followed.released?.reason, "superseded", "and the pin is let go once, not re-decided every pass");

    assert.equal(selectRun(runs).selected?.id, plan.id, "with no choice at all, the one open plan run wins as before");
  });

  it("does not steal a deliberate visit to that history", async () => {
    const { plan, stage, runs, ownership } = await afterAdvancement();
    // Chosen after the plan had already moved on: this is someone opening
    // history, and only they can close it.
    const openedNow = selectRun(runs, { id: stage.id, atMs: plan.stateMtimeMs + 1, intent: "inspect" }, undefined, undefined, ownership);
    assert.equal(openedNow.selected?.id, stage.id, "it stays on screen");
    assert.equal(openedNow.released, undefined);
  });

  it("keeps a pin whose intent was never recorded, rather than guessing that it was following", async () => {
    // A pin stored by a build from before intent was tracked. Reading it as
    // "following" is what released explicit inspections on nothing more than
    // the owning plan rewriting its position, so the unrecorded case is read
    // as an inspection instead: the worst that does is keep a pin its owner
    // can release with one click.
    const { stage, runs, ownership } = await afterAdvancement();
    for (const pin of [stage.id, { id: stage.id }, { id: stage.id, atMs: 0 }]) {
      assert.equal(selectRun(runs, pin, undefined, undefined, ownership).selected?.id, stage.id);
    }
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
    assert.equal(selectRun(runs, { id: working.id, atMs: 0 }, undefined, undefined, NO_STAGE_OWNERSHIP).selected?.id, working.id, "an unfinished stage is never superseded: it is separate work");

    const alone = await Workspace.create();
    await alone.writeStage(STAGE_3D, { status: "accepted" });
    const soloRuns = (await discoverRuns([alone.location])).runs;
    assert.equal(
      selectRun(soloRuns, { id: soloRuns[0].id, atMs: 0 }, undefined, undefined, NO_STAGE_OWNERSHIP).selected?.id,
      soloRuns[0].id,
      "with no plan run in the project, an accepted stage stays chosen",
    );
  });

  it("says which run has taken over, and withdraws what that run already owns", async () => {
    const { plan, stage, runs, ownership } = await afterAdvancement();
    assert.equal(supersedingPlanRun(stage, runs, 0, ownership)?.id, plan.id);
    assert.equal(supersedingPlanRun(plan, runs, 0, ownership), undefined, "a plan run is never superseded by itself");

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
      managedPlanRun: { runId: plan.id, planName: "reported-statistics.md", stageId: STAGE_4, stageLabel: "Stage 4", status: "running" },
      existingStageIds: [STAGE_3D, STAGE_4],
    });
    assert.equal(taken.continueAutomatically, undefined, "adopting a second time is not offered while the managed run is live");
    assert.equal(taken.whatsNext?.kind, "next-created", "and neither is creating a stage the engine has already created");
    assert.match(taken.whatsNext?.text ?? "", /already exists/);
    assert.equal(taken.followPlan?.runId, plan.id);
    assert.match(taken.followPlan?.text ?? "", /managed plan run, now at Stage 4/);
    assert.equal(taken.followPlan?.label, "Back to plan run");
  });

  /**
   * The other half of the rule, and the one the independent review asked for:
   * a plan run merely being open in the same project, or merely having
   * advanced, is not ownership. Only its recorded execution is.
   */
  it("does not take over a stage it never recorded executing", async () => {
    const { plan, stage, runs, ownership } = await afterAdvancement({ owned: false });
    assert.equal(ownership.get(stage.id), undefined, "the manifest of the live run does not contain this stage");
    assert.equal(supersedingPlanRun(stage, runs, 0, ownership), undefined, "so nothing takes over from it");

    const chosenLongAgo = selectRun(runs, { id: stage.id, atMs: plan.stateMtimeMs - 60_000 }, undefined, undefined, ownership);
    assert.equal(chosenLongAgo.selected?.id, stage.id, "and an explicit choice of it is not overridden by an unrelated plan advancing");
  });

  it("a stage id that merely looks like the plan's is not membership", async () => {
    // `<plan key>-stage-…` is a shape, not a record. The engine writes nothing
    // to say this run created such a stage, and a plan that has merely
    // advanced must not be able to claim one.
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_LABEL, PLAN);
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage: STAGE_4, current_stage_index: 6, source: "manifest" });
    await ws.writeStage(STAGE_4, { status: "working" });
    const runs = (await discoverRuns([ws.location])).runs;
    const plan = runs.find((run): run is PlanRunSnapshot => run.kind === "plan");
    assert.ok(plan);
    const store = await ManifestStore.create();
    await store.write(plan, [{ stageId: STAGE_4, label: "Stage 4", title: "Editor" }]);

    // A stage carrying the plan key prefix, which discovery keeps out of the
    // standalone list entirely — the conservative direction, which is fine.
    // What must not happen is the opposite: claiming it as history.
    const memberships = await ownershipOf(runs, store);
    assert.deepEqual([...memberships.keys()], [], "no standalone stage is claimed by this run");
  });
});
