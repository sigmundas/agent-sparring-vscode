/**
 * Finishing one plan and starting the next one on the same branch.
 *
 * The reported failure, in the user's words: a managed plan was completed on
 * `feature/mosaic-publication-selection-fix`, a *different* follow-up plan
 * was then selected and Run Plan invoked, and instead of a fresh managed run
 * the extension passed `--adopt`, the engine found the previous plan's Stage
 * 1/2/3 already ACCEPTED under the same generated ids, and the new plan
 * completed as a no-op without executing anything.
 *
 * Two extension-side decisions produced that, and both are held here:
 *
 *  - stage ids were project-global (`stage-1-<slug>`), so two plans that
 *    both define "Stage 1 — Foundation" named the same directory;
 *  - `adopt` was inferred from disk (`adopt = onDisk.size > 0`), so the
 *    engine's own refusal was turned into an instruction to adopt.
 *
 * What must keep working: adoption as a deliberate request, the previous
 * plan's history on disk, and the cockpit following the run that is actually
 * live. The engine holds the matching invariant from its own side
 * (`tests/test_plan_run_ownership.py` there): a stage recorded as owned by
 * one managed run is never another's, whatever it is called.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { buildManifest, type KnownStage } from "../core/manifest";
import { stageBelongsToPlan } from "../core/planMembership";
import { planKey } from "../core/sparringCommand";
import { Workspace } from "./fixtures";

/** Two different plan documents, on one branch, whose stage headings are word for word the same. */
const PLAN_A_LABEL = "docs/plans/mosaic-selection.md";
const PLAN_B_LABEL = "docs/plans/mosaic-selection-follow-up.md";
const A = planKey(PLAN_A_LABEL);
const B = planKey(PLAN_B_LABEL);

const SHARED_HEADINGS = ["# Mosaic work", "", "## Stage 1 — Foundation", "", "Lay the foundation.", "", "## Stage 2 — Transport", "", "Move the bytes.", ""].join("\n");

function build(label: string, known: KnownStage[] = [], markdown = SHARED_HEADINGS) {
  const built = buildManifest({ markdown, planLabel: label, planName: path.basename(label), known });
  assert.ok(built.ok, "the fixture plan is executable");
  return built;
}

function ids(label: string, known: KnownStage[] = [], markdown = SHARED_HEADINGS): string[] {
  return build(label, known, markdown).manifest.stages.map((stage) => stage.stage_id);
}

describe("a follow-up plan's stages are its own, not the previous plan's", () => {
  it("two plan documents with identical stage headings generate no shared stage id", () => {
    // Scenario 2 of the report: separate plan documents whose headings would
    // have produced identical legacy slugs (`stage-1-foundation`).
    const a = ids(PLAN_A_LABEL);
    const b = ids(PLAN_B_LABEL);

    assert.deepEqual(a, [`${A}-stage-1-foundation`, `${A}-stage-2-transport`]);
    assert.deepEqual(b, [`${B}-stage-1-foundation`, `${B}-stage-2-transport`]);
    assert.deepEqual(
      a.filter((id) => b.includes(id)),
      [],
      "no cross-plan reuse: Stage 1 of one plan is not Stage 1 of the other",
    );
  });

  it("re-numbering from Stage 1 is not what keeps them apart, so a user need not renumber", () => {
    // The report is explicit that continuing at Stage 5/6/7 must not be the
    // workaround. Plan B numbered 1..2 and Plan B numbered 5..6 are equally
    // separate from Plan A, because the plan is the namespace, not the number.
    const renumbered = SHARED_HEADINGS.replace("## Stage 1 —", "## Stage 5 —").replace("## Stage 2 —", "## Stage 6 —");
    const b = ids(PLAN_B_LABEL, [], renumbered);

    assert.deepEqual(b, [`${B}-stage-5-foundation`, `${B}-stage-6-transport`]);
    assert.deepEqual(ids(PLAN_A_LABEL).filter((id) => b.includes(id)), []);
  });

  it("the same plan document always rebuilds to the same ids", () => {
    // Not a random discriminator: the engine refuses to continue a run whose
    // manifest changed, so the namespace has to be derived from the plan's
    // identity and nothing else.
    assert.deepEqual(ids(PLAN_B_LABEL), ids(PLAN_B_LABEL));
  });
});

describe("which stages a plan may build its manifest around", () => {
  const scope = { planKey: B, planRunId: "/repo|plan:" + B, adopt: false };

  it("a stage the previous plan's run owns is not this plan's, at any status", () => {
    // The exact stages the accidental no-op run swallowed.
    for (const stageId of [`${A}-stage-1-foundation`, "stage-1-foundation"]) {
      assert.equal(stageBelongsToPlan({ stageId, owner: A, runId: "/repo|plan:" + A }, scope), false);
      assert.equal(
        stageBelongsToPlan({ stageId, owner: A, runId: "/repo|plan:" + A }, { ...scope, adopt: true }),
        false,
        "and an explicit adoption request does not reach into another run either",
      );
    }
  });

  it("this plan's own stages are, however they are recorded", () => {
    // By the engine's record; by being a stage of this plan's own run, which
    // is what a run started before ownership existed looks like; and by this
    // plan's id namespace, for a stage an older engine created unowned.
    assert.ok(stageBelongsToPlan({ stageId: `${B}-stage-1-foundation`, owner: B, runId: "x" }, scope));
    assert.ok(stageBelongsToPlan({ stageId: "stage-1-foundation", owner: null, runId: scope.planRunId }, scope));
    assert.ok(stageBelongsToPlan({ stageId: `${B}-stage-1-foundation`, owner: null, runId: "x" }, scope));
  });

  it("an unowned hand-driven stage is this plan's only when adoption is requested", () => {
    const handDriven = { stageId: "stage-3d-snapshot-v2", owner: null, runId: "/repo|stage:stage-3d-snapshot-v2" };
    assert.equal(stageBelongsToPlan(handDriven, scope), false, "an ordinary run does not sweep it in");
    assert.ok(stageBelongsToPlan(handDriven, { ...scope, adopt: true }), "adoption is exactly what it is for");
  });

  it("a plan asked to reuse the previous plan's stage keeps its own brief out of it", () => {
    // What the failure actually hinged on: `known` carried the *other*
    // plan's stage id and its brief.md, so the manifest described work
    // already accepted. Scoping decides what may be in `known` at all; this
    // records what happens to the manifest when nothing may be.
    const built = build(PLAN_B_LABEL, []);
    for (const stage of built.manifest.stages) {
      assert.match(stage.brief, /Implement only this section/, "briefed from this plan's own section");
      assert.ok(!stage.brief.includes(A), "and not from the earlier plan's stage");
    }
  });
});

describe("Run Plan does not infer adoption from historical stage state", () => {
  async function commandsSource(): Promise<string> {
    return fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
  }

  function fn(source: string, name: string): string {
    const found = new RegExp(`(?:async )?function ${name}[\\s\\S]*?\\n}\\n`).exec(source)?.[0] ?? "";
    assert.ok(found, `${name} exists`);
    return found;
  }

  it("startManagedRun takes adoption as a declared intent, never from what is on disk", async () => {
    const source = fn(await commandsSource(), "startManagedRun");
    // The removed inference, named so it cannot come back by accident.
    assert.ok(!/const adopt\s*=\s*onDisk/.test(source), "adopt is not derived from existing stage directories");
    assert.ok(!/adopt\s*=\s*.*\.size\s*>\s*0/.test(source), "nor from any other count of what exists");
    assert.match(source, /const \{[^}]*adopt[^}]*\} = start;/, "it arrives with the request");
  });

  it("choosing a plan document starts a run that adopts nothing", async () => {
    const source = fn(await commandsSource(), "runPlanCommand");
    assert.match(source, /startManagedRun\([^)]*adopt: false/, "Run Plan never adopts");
  });

  it("the adoption request comes from the standalone stage the person is looking at", async () => {
    // Continue plan automatically, from a hand-driven stage: the one entry
    // point where adopting is what was asked for. A managed plan run
    // selected there is resumed instead, and resuming adopts nothing.
    const source = fn(await commandsSource(), "performContinueAutomatically");
    assert.match(source, /const adopt = run\.kind === "stage";/);
    const resume = fn(await commandsSource(), "planInvocationFor");
    assert.match(resume, /adopt: false/, "a rebuilt manifest for a resume is not an occasion to adopt");
  });
});

describe("starting a second plan from a completed cockpit state", () => {
  /** Plan A, complete, with both of its stages accepted and recorded as its own. */
  async function completedPlanA(): Promise<Workspace> {
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_A_LABEL, SHARED_HEADINGS);
    for (const [index, stageId] of ids(PLAN_A_LABEL).entries()) {
      await ws.writeStage(
        stageId,
        { status: "accepted", implementation_session_id: `impl-${index}`, candidate_sha: `${index}`.repeat(40).slice(0, 40), plan: A },
        { "brief.md": `# Stage brief: ${stageId}\n` },
      );
    }
    await ws.writePlanRun(A, { plan: PLAN_A_LABEL, status: "complete", current_stage_index: 1, current_stage: ids(PLAN_A_LABEL)[1], source: "manifest" });
    return ws;
  }

  it("the completed run is what the cockpit shows while it is the only one", async () => {
    const ws = await completedPlanA();
    const selected = selectRun((await discoverRuns([ws.location])).runs).selected;
    assert.equal(selected?.kind, "plan");
    assert.equal(selected?.id.endsWith(`plan:${A}`), true);
  });

  it("once the new plan's run exists the cockpit follows it, with no manual cleanup", async () => {
    // Scenario 6: completed Plan A visible → Run Plan → select Plan B → Plan
    // B is the current managed run. Nothing was deleted from `.sparring` and
    // the branch did not change.
    const ws = await completedPlanA();
    await ws.writePlan(PLAN_B_LABEL, SHARED_HEADINGS);
    const bStages = ids(PLAN_B_LABEL);
    await ws.writeStage(bStages[0], { status: "working", plan: B }, { "brief.md": `# Stage brief: ${bStages[0]}\n` });
    await ws.writePlanRun(B, { plan: PLAN_B_LABEL, status: "running", current_stage_index: 0, current_stage: bStages[0], source: "manifest" });

    const discovery = await discoverRuns([ws.location]);
    const selected = selectRun(discovery.runs).selected;

    assert.equal(selected?.id.endsWith(`plan:${B}`), true, "the open run is the one to look at");
    // Plan A is still there, as history, and still complete.
    const planA = discovery.runs.find((run) => run.id.endsWith(`plan:${A}`));
    assert.equal(planA?.kind, "plan");
    assert.equal(planA?.kind === "plan" ? planA.state.status : undefined, "complete");
  });

  it("Plan A's accepted stages are still inspectable after Plan B begins", async () => {
    // Scenario 4: old history remains. Its state, its candidate and its
    // recorded owner are all still on disk, unchanged.
    const ws = await completedPlanA();
    await ws.writePlanRun(B, { plan: PLAN_B_LABEL, status: "running", current_stage_index: 0, current_stage: ids(PLAN_B_LABEL)[0], source: "manifest" });

    for (const stageId of ids(PLAN_A_LABEL)) {
      const state = JSON.parse(await fs.readFile(path.join(ws.stageDir(stageId), "state.json"), "utf8"));
      assert.equal(state.status, "accepted");
      assert.equal(state.plan, A, "still Plan A's stage instance");
    }
  });

  it("an accidental completed no-op run may simply stay on disk", async () => {
    // The state this bug already left on a real branch: a second plan-run
    // file, recorded complete, over the first plan's stage ids. It is
    // history; a genuinely fresh plan starts from the same branch regardless,
    // because its stages are named in its own namespace and owned by it.
    const ws = await completedPlanA();
    await ws.writePlanRun(B, { plan: PLAN_B_LABEL, status: "complete", current_stage_index: 1, current_stage: ids(PLAN_A_LABEL)[1], source: "manifest" });

    const third = "docs/plans/third.md";
    const thirdStages = ids(third);
    assert.deepEqual(thirdStages.filter((id) => [...ids(PLAN_A_LABEL), ...ids(PLAN_B_LABEL)].includes(id)), []);
    await ws.writeStage(thirdStages[0], { status: "working", plan: planKey(third) }, { "brief.md": "x\n" });
    await ws.writePlanRun(planKey(third), { plan: third, status: "running", current_stage_index: 0, current_stage: thirdStages[0], source: "manifest" });

    const discovery = await discoverRuns([ws.location]);
    assert.equal(selectRun(discovery.runs).selected?.id.endsWith(`plan:${planKey(third)}`), true);
    // Both completed runs kept, neither standing in for the new one.
    for (const key of [A, B]) {
      const run = discovery.runs.find((candidate) => candidate.id.endsWith(`plan:${key}`));
      assert.equal(run?.kind === "plan" ? run.state.status : undefined, "complete");
    }
  });
});
