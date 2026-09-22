/**
 * Starting the next run on the same branch — a different plan, or the same one.
 *
 * The reported failure, in the user's words: a managed plan was completed on
 * `feature/mosaic-publication-selection-fix`, a *different* follow-up plan
 * was then selected and Run Plan invoked, and instead of a fresh managed run
 * the extension passed `--adopt`, the engine found the previous plan's Stage
 * 1/2/3 already ACCEPTED under the same generated ids, and the new plan
 * completed as a no-op without executing anything.
 *
 * Three extension-side decisions produced that, and all three are held here:
 *
 *  - stage ids were project-global (`stage-1-<slug>`), so two plans that
 *    both define "Stage 1 — Foundation" named the same directory;
 *  - `adopt` was inferred from disk (`adopt = onDisk.size > 0`), so the
 *    engine's own refusal was turned into an instruction to adopt;
 *  - Run Plan redirected to Resume whenever a run of the chosen document was
 *    already recorded, so "run this plan" meant "continue whatever ran it
 *    last" — and after a completed run there was nothing left to continue.
 *
 * The contract these tests hold is the user's: **Run Plan starts a new run of
 * the selected plan.** Identity is per run *instance*, so the same document
 * may be run again, and a plan document is an input rather than a run. What
 * must keep working: adoption as a deliberate request, earlier runs' history
 * on disk, and the cockpit following the run that is actually live. The
 * engine holds the matching invariant from its own side
 * (`tests/test_plan_run_ownership.py` there): a stage recorded as owned by
 * one managed run is never another's, whatever it is called.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, locateAll, selectRun, type RepositoryScope } from "../core/discovery";
import { buildManifest, manifestFileName, type KnownStage } from "../core/manifest";
import { stageBelongsToPlan } from "../core/planMembership";
import { newRunKey, planKey } from "../core/sparringCommand";
import { Workspace } from "./fixtures";

/** Two different plan documents, on one branch, whose stage headings are word for word the same. */
const PLAN_A_LABEL = "docs/plans/mosaic-selection.md";
const PLAN_B_LABEL = "docs/plans/mosaic-selection-follow-up.md";

/**
 * Fixed run keys, so what a test asserts is the identity model rather than
 * this call's random suffix. Each is a legal run key of the shape
 * `newRunKey` mints; `A2` is a *second* run of plan A's document, which is
 * the case the whole run-instance idea exists for.
 */
const A = `${planKey(PLAN_A_LABEL)}-1111aaaa`;
const A2 = `${planKey(PLAN_A_LABEL)}-2222bbbb`;
const B = `${planKey(PLAN_B_LABEL)}-3333cccc`;

const SHARED_HEADINGS = ["# Mosaic work", "", "## Stage 1 — Foundation", "", "Lay the foundation.", "", "## Stage 2 — Transport", "", "Move the bytes.", ""].join("\n");

function build(label: string, runKey: string, known: KnownStage[] = [], markdown = SHARED_HEADINGS) {
  const built = buildManifest({ markdown, planLabel: label, planName: path.basename(label), runKey, known });
  assert.ok(built.ok, "the fixture plan is executable");
  return built;
}

function ids(label: string, runKey: string, known: KnownStage[] = [], markdown = SHARED_HEADINGS): string[] {
  return build(label, runKey, known, markdown).manifest.stages.map((stage) => stage.stage_id);
}

describe("a new run's stages are its own, not an earlier run's", () => {
  it("two plan documents with identical stage headings generate no shared stage id", () => {
    // Scenario 2 of the report: separate plan documents whose headings would
    // have produced identical legacy slugs (`stage-1-foundation`).
    const a = ids(PLAN_A_LABEL, A);
    const b = ids(PLAN_B_LABEL, B);

    assert.deepEqual(a, [`${A}-stage-1-foundation`, `${A}-stage-2-transport`]);
    assert.deepEqual(b, [`${B}-stage-1-foundation`, `${B}-stage-2-transport`]);
    assert.deepEqual(
      a.filter((id) => b.includes(id)),
      [],
      "no cross-run reuse: Stage 1 of one plan is not Stage 1 of the other",
    );
  });

  it("two runs of the *same* document also generate no shared stage id", () => {
    // The case a plan-keyed namespace could not express. Same repository,
    // same branch, same file, same headings — and run A2's Stage 1 is its
    // own stage instance rather than run A's accepted one.
    const first = ids(PLAN_A_LABEL, A);
    const second = ids(PLAN_A_LABEL, A2);

    assert.deepEqual(second, [`${A2}-stage-1-foundation`, `${A2}-stage-2-transport`]);
    assert.deepEqual(
      first.filter((id) => second.includes(id)),
      [],
      "a rerun of one document is new work, not the earlier run's history",
    );
  });

  it("their manifests are separate files, so a rebuild cannot overwrite the earlier run's", () => {
    // The manifest is the only record of which stages a run executed, so two
    // runs of one document sharing its name would let the second run's
    // rebuild be read back as the first run's stage list.
    const worktree = "/repo/checkout";
    assert.notEqual(manifestFileName(A, worktree), manifestFileName(A2, worktree));
  });

  it("re-numbering from Stage 1 is not what keeps them apart, so a user need not renumber", () => {
    // The report is explicit that continuing at Stage 5/6/7 must not be the
    // workaround. Plan B numbered 1..2 and Plan B numbered 5..6 are equally
    // separate from run A, because the run is the namespace, not the number.
    const renumbered = SHARED_HEADINGS.replace("## Stage 1 —", "## Stage 5 —").replace("## Stage 2 —", "## Stage 6 —");
    const b = ids(PLAN_B_LABEL, B, [], renumbered);

    assert.deepEqual(b, [`${B}-stage-5-foundation`, `${B}-stage-6-transport`]);
    assert.deepEqual(
      ids(PLAN_A_LABEL, A).filter((id) => b.includes(id)),
      [],
    );
  });

  it("one run always rebuilds to the same ids", () => {
    // Not a random discriminator *per rebuild*: the engine refuses to
    // continue a run whose manifest changed, so within a run the namespace
    // has to be fixed. The randomness is in minting the run key, once.
    assert.deepEqual(ids(PLAN_B_LABEL, B), ids(PLAN_B_LABEL, B));
  });

  it("a minted run key is the plan's key plus a suffix of its own", () => {
    const minted = newRunKey(PLAN_A_LABEL);
    assert.ok(minted.startsWith(`${planKey(PLAN_A_LABEL)}-`), "recognisable as this document's run");
    assert.notEqual(minted, newRunKey(PLAN_A_LABEL), "and a different run every time");
    assert.match(minted, /-[0-9a-f]{8}$/);
  });
});

describe("which stages a run may build its manifest around", () => {
  const scope = { runKey: B, planRunId: "/repo|plan:" + B, adopt: false };

  it("a stage an earlier run owns is not this run's, at any status", () => {
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

  it("a stage owned by another run of the same document is not this run's either", () => {
    // Ownership is by run and not by plan, which is the whole reason this
    // case can be answered at all.
    const second = { runKey: A2, planRunId: "/repo|plan:" + A2, adopt: false };
    assert.equal(stageBelongsToPlan({ stageId: `${A}-stage-1-foundation`, owner: A, runId: "/repo|plan:" + A }, second), false);
    assert.equal(stageBelongsToPlan({ stageId: `${A}-stage-1-foundation`, owner: A, runId: "/repo|plan:" + A }, { ...second, adopt: true }), false);
  });

  it("this run's own stages are, however they are recorded", () => {
    // By the engine's record; by being a stage of this run itself, which is
    // what a run started before ownership existed looks like; and by this
    // run's id namespace, for a stage an older engine created unowned.
    assert.ok(stageBelongsToPlan({ stageId: `${B}-stage-1-foundation`, owner: B, runId: "x" }, scope));
    assert.ok(stageBelongsToPlan({ stageId: "stage-1-foundation", owner: null, runId: scope.planRunId }, scope));
    assert.ok(stageBelongsToPlan({ stageId: `${B}-stage-1-foundation`, owner: null, runId: "x" }, scope));
  });

  it("an unowned hand-driven stage is this run's only when adoption is requested", () => {
    const handDriven = { stageId: "stage-3d-snapshot-v2", owner: null, runId: "/repo|stage:stage-3d-snapshot-v2" };
    assert.equal(stageBelongsToPlan(handDriven, scope), false, "an ordinary run does not sweep it in");
    assert.ok(stageBelongsToPlan(handDriven, { ...scope, adopt: true }), "adoption is exactly what it is for");
  });

  it("a run asked to reuse an earlier run's stage keeps its own brief out of it", () => {
    // What the failure actually hinged on: `known` carried the *other* run's
    // stage id and its brief.md, so the manifest described work already
    // accepted. Scoping decides what may be in `known` at all; this records
    // what happens to the manifest when nothing may be.
    const built = build(PLAN_B_LABEL, B, []);
    for (const stage of built.manifest.stages) {
      assert.match(stage.brief, /Implement only this section/, "briefed from this plan's own section");
      assert.ok(!stage.brief.includes(A), "and not from the earlier run's stage");
    }
  });
});

describe("Run Plan starts a new run and infers no adoption", () => {
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

  it("choosing a plan document mints a run key rather than deriving one from the document", async () => {
    // The redirect this replaced: `runPlanCommand` used to look the document
    // up as a run and hand it to Resume, which is how a completed plan
    // became impossible to run again.
    const source = fn(await commandsSource(), "runPlanCommand");
    assert.match(source, /const runKey = newRunKey\(label\);/, "a new run, identified as one");
    assert.ok(!/await resumePlanCommand\(controller, existing\)/.test(source), "no silent redirect to Resume");
    // The one case that cannot simply start: a run of this document still in
    // flight. The person is asked; Resume is an answer, not the default.
    assert.match(source, /state\.status !== "complete"/, "only an *open* run stands in the way");
    assert.match(source, /"Continue that run"/);
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

  it("a fresh run tells the engine which run it is", async () => {
    // Without `--run-key` the engine would mint its own and the extension
    // could not name the run it just started: not its state file, not its
    // stage directories, not the terminal it is watching.
    const source = await commandsSource();
    assert.match(fn(source, "startManagedRun"), /buildRunPlanArgs\([^)]*runKey/);
    assert.match(fn(source, "runPlanCommand"), /buildRunPlanArgs\([^)]*runKey/);
  });
});

describe("starting a second run from a completed cockpit state", () => {
  /** One run of plan A, complete, with both stages accepted and recorded as its own. */
  async function completedRunOfPlanA(ws?: Workspace): Promise<Workspace> {
    const workspace = ws ?? (await Workspace.create());
    await workspace.writePlan(PLAN_A_LABEL, SHARED_HEADINGS);
    for (const [index, stageId] of ids(PLAN_A_LABEL, A).entries()) {
      await workspace.writeStage(
        stageId,
        { status: "accepted", implementation_session_id: `impl-${index}`, candidate_sha: `${index}`.repeat(40).slice(0, 40), run: A },
        { "brief.md": `# Stage brief: ${stageId}\n` },
      );
    }
    await workspace.writePlanRun(A, { plan: PLAN_A_LABEL, run: A, status: "complete", current_stage_index: 1, current_stage: ids(PLAN_A_LABEL, A)[1], source: "manifest" });
    return workspace;
  }

  it("the completed run is what the cockpit shows while it is the only one", async () => {
    const ws = await completedRunOfPlanA();
    const selected = selectRun((await discoverRuns([ws.location])).runs).selected;
    assert.equal(selected?.kind, "plan");
    assert.equal(selected?.id.endsWith(`plan:${A}`), true);
  });

  it("once a new run of a different plan exists the cockpit follows it, with no manual cleanup", async () => {
    // Scenario 6: completed run visible → Run Plan → select Plan B → Plan B
    // is the current managed run. Nothing was deleted from `.sparring` and
    // the branch did not change.
    const ws = await completedRunOfPlanA();
    await ws.writePlan(PLAN_B_LABEL, SHARED_HEADINGS);
    const bStages = ids(PLAN_B_LABEL, B);
    await ws.writeStage(bStages[0], { status: "working", run: B }, { "brief.md": `# Stage brief: ${bStages[0]}\n` });
    await ws.writePlanRun(B, { plan: PLAN_B_LABEL, run: B, status: "running", current_stage_index: 0, current_stage: bStages[0], source: "manifest" });

    const discovery = await discoverRuns([ws.location]);
    const selected = selectRun(discovery.runs).selected;

    assert.equal(selected?.id.endsWith(`plan:${B}`), true, "the open run is the one to look at");
    // The completed run is still there, as history, and still complete.
    const first = discovery.runs.find((run) => run.id.endsWith(`plan:${A}`));
    assert.equal(first?.kind, "plan");
    assert.equal(first?.kind === "plan" ? first.state.status : undefined, "complete");
  });

  it("a second run of the *same* plan is a second row, and is the one followed", async () => {
    // The acceptance case for rerunning a document: two runs of
    // `mosaic-selection.md` side by side, the finished one kept as history
    // and the live one on screen. Nothing had to be removed from
    // `.sparring`, and neither run answers for the other's stages.
    const ws = await completedRunOfPlanA();
    const second = ids(PLAN_A_LABEL, A2);
    await ws.writeStage(second[0], { status: "working", run: A2 }, { "brief.md": `# Stage brief: ${second[0]}\n` });
    await ws.writePlanRun(A2, { plan: PLAN_A_LABEL, run: A2, status: "running", current_stage_index: 0, current_stage: second[0], source: "manifest" });

    const discovery = await discoverRuns([ws.location]);

    const runsOfA = discovery.runs.filter((run) => run.kind === "plan" && run.state.plan === PLAN_A_LABEL);
    assert.equal(runsOfA.length, 2, "one document, two recorded runs");
    assert.deepEqual(
      runsOfA.map((run) => (run.kind === "plan" ? run.runKey : "")).sort(),
      [A, A2].sort(),
    );
    assert.equal(selectRun(discovery.runs).selected?.id.endsWith(`plan:${A2}`), true, "the live run is on screen");
    // And each run's stages are its own, by the engine's record.
    const owners = await Promise.all(
      // Only the stages that exist: the second run has reached its first.
      [...ids(PLAN_A_LABEL, A), second[0]].map(async (stageId) => JSON.parse(await fs.readFile(path.join(ws.stageDir(stageId), "state.json"), "utf8")).run),
    );
    assert.deepEqual(owners, [A, A, A2]);
  });

  it("the first run's accepted stages are still inspectable after the second begins", async () => {
    // Scenario 4: old history remains. Its state, its candidate and its
    // recorded owner are all still on disk, unchanged.
    const ws = await completedRunOfPlanA();
    await ws.writePlanRun(B, { plan: PLAN_B_LABEL, run: B, status: "running", current_stage_index: 0, current_stage: ids(PLAN_B_LABEL, B)[0], source: "manifest" });

    for (const stageId of ids(PLAN_A_LABEL, A)) {
      const state = JSON.parse(await fs.readFile(path.join(ws.stageDir(stageId), "state.json"), "utf8"));
      assert.equal(state.status, "accepted");
      assert.equal(state.run, A, "still that run's stage instance");
    }
  });

  it("an accidental completed no-op run may simply stay on disk", async () => {
    // The state this bug already left on a real branch: a second plan-run
    // file, recorded complete, over the first plan's stage ids. It is
    // history; a genuinely fresh run starts from the same branch regardless,
    // because its stages are named in its own namespace and owned by it.
    const ws = await completedRunOfPlanA();
    await ws.writePlanRun(B, { plan: PLAN_B_LABEL, run: B, status: "complete", current_stage_index: 1, current_stage: ids(PLAN_A_LABEL, A)[1], source: "manifest" });

    const third = "docs/plans/third.md";
    const thirdKey = `${planKey(third)}-4444dddd`;
    const thirdStages = ids(third, thirdKey);
    assert.deepEqual(
      thirdStages.filter((id) => [...ids(PLAN_A_LABEL, A), ...ids(PLAN_B_LABEL, B)].includes(id)),
      [],
    );
    await ws.writeStage(thirdStages[0], { status: "working", run: thirdKey }, { "brief.md": "x\n" });
    await ws.writePlanRun(thirdKey, { plan: third, run: thirdKey, status: "running", current_stage_index: 0, current_stage: thirdStages[0], source: "manifest" });

    const discovery = await discoverRuns([ws.location]);
    assert.equal(selectRun(discovery.runs).selected?.id.endsWith(`plan:${thirdKey}`), true);
    // Both completed runs kept, neither standing in for the new one.
    for (const key of [A, B]) {
      const run = discovery.runs.find((candidate) => candidate.id.endsWith(`plan:${key}`));
      assert.equal(run?.kind === "plan" ? run.state.status : undefined, "complete");
    }
  });
});

describe("runs recorded before run instances existed", () => {
  /**
   * Exactly what is on disk in a project today: `plans/<plan key>.json` with
   * no `run` field, and stages carrying the older `plan` ownership spelling.
   */
  const LEGACY = planKey(PLAN_A_LABEL);

  it("a legacy run is discovered, keyed by the plan key its stages already record", async () => {
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_A_LABEL, SHARED_HEADINGS);
    const stages = ids(PLAN_A_LABEL, LEGACY);
    await ws.writeStage(stages[0], { status: "working", plan: LEGACY }, { "brief.md": `# Stage brief: ${stages[0]}\n` });
    await ws.writePlanRun(LEGACY, { plan: PLAN_A_LABEL, status: "paused", current_stage_index: 0, current_stage: stages[0], source: "manifest" });

    const discovery = await discoverRuns([ws.location]);
    const run = discovery.runs.find((candidate) => candidate.kind === "plan");

    assert.equal(run?.kind, "plan");
    assert.equal(run?.kind === "plan" ? run.runKey : undefined, LEGACY, "its file name is its run key");
    assert.equal(run?.kind === "plan" ? run.planKey : undefined, planKey(PLAN_A_LABEL));
    assert.equal(run?.id.endsWith(`plan:${LEGACY}`), true, "and the cockpit's id for it is unchanged");
    // Its stage is read as owned by it, from the older spelling.
    assert.equal(run?.kind === "plan" ? run.stages[0]?.state?.run : undefined, LEGACY);
  });

  it("its stages are not this new run's, so a fresh run of the same document cannot take them", () => {
    const fresh = { runKey: A2, planRunId: "/repo|plan:" + A2, adopt: true };
    assert.equal(stageBelongsToPlan({ stageId: `${LEGACY}-stage-1-foundation`, owner: LEGACY, runId: "/repo|plan:" + LEGACY }, fresh), false);
  });
});

describe("the cockpit shows the run that was just started, wherever it was started", () => {
  /**
   * The dogfooding report this suite gained: Run Plan was used in
   * `sporely-py-mosaic-fix`, the engine started stage 1 of 3 in the terminal,
   * and the cockpit went on saying *Following repository: agent-sparring* —
   * the repository the active editor happened to be in — with the new run
   * counted among the work discovered "elsewhere".
   *
   * Automatic selection cannot fix that on its own, and should not: it is
   * deliberately confined to the repository this window is following, so that
   * a run in another checkout never appears unasked. Starting a run *is* the
   * asking, and the pin is what records it.
   */
  async function runStartedInAnotherRepository() {
    const editing = await Workspace.create({ name: "agent-sparring" });
    const running = await Workspace.create({ name: "sporely-py-mosaic-fix" });
    await running.writePlan(PLAN_A_LABEL, SHARED_HEADINGS);
    const stages = ids(PLAN_A_LABEL, A);
    await running.writeStage(stages[0], { status: "working", run: A }, { "brief.md": `# Stage brief: ${stages[0]}\n` });
    await running.writePlanRun(A, { plan: PLAN_A_LABEL, run: A, status: "running", current_stage_index: 0, current_stage: stages[0], source: "manifest" });

    const locations = await locateAll([editing, running].map((ws) => ({ path: ws.root, name: path.basename(ws.root) })));
    const runs = (await discoverRuns(locations)).runs;
    const started = runs.find((run) => run.id.endsWith(`plan:${A}`))!;
    // The window is in the repository being edited, not the one running.
    const scope: RepositoryScope = { repoRoot: editing.root, knownRoots: [editing.root, running.root] };
    return { runs, started, scope, locations };
  }

  it("is not selected automatically, because it is in another repository", async () => {
    const { runs, started, scope, locations } = await runStartedInAnotherRepository();
    const selection = selectRun(runs, undefined, undefined, scope, undefined, locations);

    assert.equal(selection.selected, undefined, "the reported symptom: the cockpit stays where the window is");
    assert.deepEqual(
      (selection.elsewhere ?? []).map((run) => run.id),
      [started.id],
      "and the new run is merely counted as work elsewhere",
    );
  });

  it("is selected once starting it pins it, with the window left where it is", async () => {
    const { runs, started, scope, locations } = await runStartedInAnotherRepository();
    const selection = selectRun(runs, { id: started.id, atMs: Date.now(), intent: "starting" }, undefined, scope, undefined, locations);

    assert.equal(selection.selected?.id, started.id);
    assert.equal(selection.pinned, true, "shown because it was asked for, not because the window moved");
    assert.equal(selection.scope?.name, "agent-sparring", "and the window is still honestly named as being elsewhere");
  });

  it("a pin recorded before the engine has written the run's state is kept, not retired", async () => {
    // The gap this exists for: `controller.launch` returns when the terminal
    // has the command, and the engine writes `plans/<run key>.json` a moment
    // later. A refresh landing in between must not conclude the run was
    // deleted — which is what an ordinary pin to a missing run means.
    const { runs, scope, locations } = await runStartedInAnotherRepository();
    const notYet = `${planKey(PLAN_A_LABEL)}-9999eeee`;
    const pin = { id: `${path.resolve(locations[1].projectDir)}|plan:${notYet}`, atMs: Date.now() };

    const starting = selectRun(runs, { ...pin, intent: "starting" }, undefined, scope, undefined, locations);
    assert.equal(starting.released, undefined, "the pin survives the gap");

    // Any other intent means the run really is gone, and the pin is retired.
    const following = selectRun(runs, { ...pin, intent: "follow" }, undefined, scope, undefined, locations);
    assert.deepEqual(following.released, { id: pin.id, reason: "gone" });
  });
});
