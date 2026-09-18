/**
 * An explicit pin, and the three things that may end it.
 *
 * The reported failure: pin Stage 3B to read what it recorded, and the
 * cockpit moved off it on its own a moment later. The reason was that
 * `supersedingPlanRun` asked two questions and treated them as one — *has the
 * plan run that owns this stage advanced past it?* and *has its state file
 * been written since you pinned?* — and the second is not evidence of the
 * first. The ordinary way to pin a historical stage is to pin one the plan has
 * **already** moved past, so the "advanced past it" test was true from the
 * first instant, and the engine's next position write (it rewrites that file
 * on every transition) supplied the timestamp that released the pin.
 *
 * What is asserted here is the whole released-by list and nothing else:
 *
 *  - the user pinning something else, or choosing Follow active repository —
 *    both replace or clear the stored pin, so they are the caller's business
 *    and are covered where the pin is stored;
 *  - the pinned run ceasing to exist;
 *  - and, for a `follow` pin only, the plan run that was executing it moving
 *    on — which is the same request answered, not a contradiction of it.
 *
 * Plus the one that bit after the first fix: a release must be an *event*, not
 * a condition. Handing a `follow` pin over needs an open owner, so completing
 * the plan used to make the old pin reappear and move the screen for no reason
 * anyone had asked for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fsp from "node:fs/promises";
import {
  discoverRuns,
  intentForChoosing,
  selectRun,
  type PlanRunSnapshot,
  type RunPreference,
  type RunSnapshot,
  type StandaloneStageSnapshot,
} from "../core/discovery";
import { ManifestStore, Workspace, ownershipOf, recordPlanDigest } from "./fixtures";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const STAGE_A = "stage-1-contract";
const STAGE_B = "stage-2-typed-parser";
const STAGE_C = "stage-3-local-persistence";
const STAGE_D = "stage-4-editor-and-ui";

/**
 * A plan written the way a real one is: handoff records in front of the
 * canonical sections, which the engine-shaped parser refuses. The run
 * therefore knows no stage list and claims only its recorded current stage,
 * so the stages it has finished come back as standalone accepted runs — the
 * shape that makes a historical stage pinnable at all. Manifest stage ids
 * carry no plan-key prefix, exactly as `buildManifest` proposes them.
 */
function planDocument(current: string): string {
  return [
    "# Reported statistics and explicit range semantics",
    "",
    `## ${current} handoff — 2026-09-14 (current stage)`,
    "",
    "Status: implemented and self-verified.",
    "",
    "## Canonical stage sequence",
    "",
    "## Stage 3 — Local persistence",
    "",
    "The persistence.",
    "",
    "## Stage 4 — Editor and UI",
    "",
    "The editor.",
    "",
  ].join("\n");
}

/**
 * A managed plan run that has executed three stages and is at the third, with
 * the first two rediscovered as accepted standalone stages.
 */
async function planWithHistory(): Promise<{
  ws: Workspace;
  store: ManifestStore;
  runs: RunSnapshot[];
  plan: PlanRunSnapshot;
  stageA: StandaloneStageSnapshot;
  rediscover: () => Promise<RunSnapshot[]>;
}> {
  const ws = await Workspace.create();
  await ws.writePlan(PLAN_LABEL, planDocument("Stage 3"));
  await ws.writeStage(STAGE_A, { status: "accepted" });
  await ws.writeStage(STAGE_B, { status: "accepted" });
  await ws.writeStage(STAGE_C, { status: "working" });
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage_index: 2, current_stage: STAGE_C, source: "manifest" });

  const store = await ManifestStore.create();
  const rediscover = async () => (await discoverRuns([ws.location])).runs;
  const runs = await rediscover();
  const plan = runs.find((run): run is PlanRunSnapshot => run.kind === "plan")!;
  // The manifest is what records that this run executed Stages 1 and 2;
  // without it there is no evidence of ownership and nothing to take over.
  await store.write(plan, [
    { stageId: STAGE_A, label: "Stage 1", title: "Contract" },
    { stageId: STAGE_B, label: "Stage 2", title: "Typed parser" },
    { stageId: STAGE_C, label: "Stage 3", title: "Local persistence" },
  ]);
  const stageA = runs.find((run): run is StandaloneStageSnapshot => run.kind === "stage" && run.stage.stageId === STAGE_A)!;
  assert.ok(stageA, "Stage 1 must come back as a standalone stage for this to be the reported shape");
  return { ws, store, runs, plan, stageA, rediscover };
}

describe("an explicitly pinned historical stage", () => {
  it("is recorded as an inspection, because it was already finished when it was chosen", async () => {
    const { stageA, plan } = await planWithHistory();
    assert.equal(intentForChoosing(stageA), "inspect", "an accepted stage is being inspected");
    assert.equal(intentForChoosing(plan), "follow", "a running plan run is being followed");
  });

  it("survives its owning plan's state being rewritten without the plan advancing", async () => {
    const { store, runs, plan, stageA, rediscover } = await planWithHistory();
    const ownership = await ownershipOf(runs, store);
    assert.equal(ownership.get(stageA.id), plan.id, "the manifest must make the plan run the owner, or this test proves nothing");

    const pin: RunPreference = { id: stageA.id, atMs: Date.now(), intent: "inspect" };
    assert.equal(selectRun(runs, pin, undefined, undefined, ownership).selected?.id, stageA.id);

    // The engine rewrites the plan-run state file on every transition. Here it
    // writes the *same* position again, a second later: nothing advanced.
    await recordPlanDigest(plan, plan.state.planDigest);
    const later = await rediscover();
    const afterOwner = later.find((run): run is PlanRunSnapshot => run.kind === "plan")!;
    assert.ok(afterOwner.stateMtimeMs >= pin.atMs!, "the owner's state file must look newer than the pin, or the bug cannot reproduce");
    assert.equal(afterOwner.currentStage.stageId, STAGE_C, "and its position must be unchanged");

    const selection = selectRun(later, pin, undefined, undefined, await ownershipOf(later, store));
    assert.equal(selection.selected?.id, stageA.id, "the pin must still be on Stage 1");
    assert.equal(selection.pinned, true);
    assert.equal(selection.released, undefined, "nothing released it");
  });

  it("survives the owning plan completing, and is not resurrected by it", async () => {
    const { ws, store, runs, stageA, rediscover } = await planWithHistory();
    const pin: RunPreference = { id: stageA.id, atMs: Date.now(), intent: "inspect" };
    assert.equal(selectRun(runs, pin, undefined, undefined, await ownershipOf(runs, store)).selected?.id, stageA.id);

    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: STAGE_C, source: "manifest" });
    const later = await rediscover();
    const selection = selectRun(later, pin, undefined, undefined, await ownershipOf(later, store));
    assert.equal(selection.selected?.id, stageA.id, "completing the plan is not a reason to close the history being read");
    assert.equal(selection.released, undefined);
  });

  it("survives the plan genuinely advancing, because inspecting history is not following work", async () => {
    const { ws, store, runs, stageA, rediscover } = await planWithHistory();
    const pin: RunPreference = { id: stageA.id, atMs: Date.now(), intent: "inspect" };

    // The plan moves from Stage 3 to a fourth stage. Under `follow` this is
    // the hand-over; under `inspect` it is simply news about another run.
    await ws.writeStage(STAGE_D, { status: "working" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage_index: 3, current_stage: STAGE_D, source: "manifest" });
    const later = await rediscover();
    assert.equal(selectRun(later, pin, undefined, undefined, await ownershipOf(later, store)).selected?.id, stageA.id);
    assert.equal(selectRun(later, pin, undefined, undefined, await ownershipOf(later, store)).released, undefined);
    assert.ok(runs.length > 0);
  });

  it("is released when the run itself is gone from a project that was scanned", async () => {
    const { ws, store, runs, stageA, rediscover } = await planWithHistory();
    const pin: RunPreference = { id: stageA.id, atMs: Date.now(), intent: "inspect" };
    assert.equal(selectRun(runs, pin, undefined, undefined, await ownershipOf(runs, store), [ws.location]).selected?.id, stageA.id);

    await fsp.rm(ws.stageDir(STAGE_A), { recursive: true, force: true });
    const later = await rediscover();
    const selection = selectRun(later, pin, undefined, undefined, await ownershipOf(later, store), [ws.location]);
    assert.equal(selection.selected?.id === stageA.id, false, "the pinned run no longer exists");
    assert.deepEqual(selection.released, { id: stageA.id, reason: "gone" });
  });

  it("is kept, not released, when the project has not been scanned at all", async () => {
    const { store, runs, stageA } = await planWithHistory();
    const pin: RunPreference = { id: stageA.id, atMs: Date.now(), intent: "inspect" };
    // No locations passed: a window still starting up, or a folder that was
    // briefly unreadable, must not cost someone their pin.
    const selection = selectRun([], pin, undefined, undefined, await ownershipOf(runs, store), []);
    assert.equal(selection.released, undefined, "an unscanned project is not a disappearance");
  });
});

describe("a pin made while the run was still open", () => {
  it("hands over to the plan run that executed it once that run moves on", async () => {
    // Stage 1 is one the run executed but left in `working` — a stage the
    // plan document does not claim and that is therefore rediscovered on its
    // own while still open. Pinning it is a statement about work in progress.
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_LABEL, planDocument("Stage 3"));
    await ws.writeStage(STAGE_A, { status: "working" });
    await ws.writeStage(STAGE_C, { status: "working" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage_index: 2, current_stage: STAGE_C, source: "manifest" });
    const store = await ManifestStore.create();
    const rediscover = async () => (await discoverRuns([ws.location])).runs;

    const runs = await rediscover();
    const plan = runs.find((run): run is PlanRunSnapshot => run.kind === "plan")!;
    await store.write(plan, [
      { stageId: STAGE_A, label: "Stage 1", title: "Contract" },
      { stageId: STAGE_C, label: "Stage 3", title: "Local persistence" },
      { stageId: STAGE_D, label: "Stage 4", title: "Editor and UI" },
    ]);

    const stageA = runs.find((run): run is StandaloneStageSnapshot => run.kind === "stage" && run.stage.stageId === STAGE_A)!;
    assert.ok(stageA, "Stage 1 must be standalone and open at pin time");
    assert.equal(intentForChoosing(stageA), "follow", "it was open when it was chosen");
    const pin: RunPreference = { id: stageA.id, atMs: Date.now() - 1, intent: "follow" };

    // It is accepted and the plan moves on to Stage 4. The engine rewrites
    // the plan-run state file and keeps the manifest digest it recorded, so
    // the manifest still binds and the stage is still recorded as this run's.
    await ws.writeStage(STAGE_A, { status: "accepted" });
    await ws.writeStage(STAGE_D, { status: "working" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage_index: 3, current_stage: STAGE_D, source: "manifest" });
    await recordPlanDigest((await rediscover()).find((run): run is PlanRunSnapshot => run.kind === "plan")!, plan.state.planDigest);
    const later = await rediscover();
    const owner = later.find((run): run is PlanRunSnapshot => run.kind === "plan")!;
    const selection = selectRun(later, pin, undefined, undefined, await ownershipOf(later, store), [ws.location]);
    assert.equal(selection.selected?.id, owner.id, "the cockpit follows the plan run that continued the work");
    assert.equal(selection.released?.reason, "superseded");
    assert.equal(selection.released?.id, pin.id);
  });

  it("is not handed over by a plan run that never executed it", async () => {
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_LABEL, planDocument("Stage 2"));
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: STAGE_B, source: "manifest" });
    await ws.writeStage(STAGE_A, { status: "accepted" });
    await ws.writeStage(STAGE_B, { status: "working" });
    const runs = (await discoverRuns([ws.location])).runs;
    const stageA = runs.find((run): run is StandaloneStageSnapshot => run.kind === "stage" && run.stage.stageId === STAGE_A)!;
    // No manifest, so nothing records that this plan run executed Stage 1.
    const pin: RunPreference = { id: stageA.id, atMs: 0, intent: "follow" };
    const selection = selectRun(runs, pin, undefined, undefined, new Map(), [ws.location]);
    assert.equal(selection.selected?.id, stageA.id, "an unowned stage is nobody's to take over");
    assert.equal(selection.released, undefined);
  });
});

describe("a pin stored before its intent was recorded", () => {
  it("is read as an inspection, so an upgrade cannot move someone off history", async () => {
    const { store, runs, stageA, ws, rediscover } = await planWithHistory();
    // No `intent`: exactly what is in workspace state for a pin made by an
    // earlier build. The unstable reading was `follow`, which is what the
    // reported failure was.
    const pin: RunPreference = { id: stageA.id, atMs: Date.now() };
    await ws.writeStage(STAGE_B, { status: "accepted" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage_index: 2, current_stage: STAGE_C, source: "manifest" });
    const later = await rediscover();
    const selection = selectRun(later, pin, undefined, undefined, await ownershipOf(later, store), [ws.location]);
    assert.equal(selection.selected?.id, stageA.id);
    assert.equal(selection.released, undefined);
    assert.ok(runs.length > 0);
  });
});
