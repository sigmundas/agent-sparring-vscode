/**
 * What's next for an accepted stage of an intake-backed run is decided from
 * the whole intake, not from the run's own stage list — which ends where its
 * slice does. The reported defect: an accepted one-stage slice in sporely-py
 * said "No stage follows this one in the plan" while the intake's next stage
 * was waiting in sporely-web.
 *
 * The fixture is the engine-generated `plan-intake/ran/` snapshot: slice `app`
 * (one stage, run complete) → slice `web` (primary repository `web`, earlier
 * slice `app`, prepared). The pure continuation rules are held on synthetic
 * intakes shaped like the real Taxonomy v3 one.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { intakeOfRun, selectRun, type DiscoveredIntake } from "../core/discovery";
import { intakeContinuation, nextIntakeSlice, type IntakeSliceSnapshot, type IntakeSnapshot } from "../core/intake";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { crossRepositoryIntake, snapshotTree } from "./fixtures";

const T0 = Date.now();

function artifactsFor(intake: DiscoveredIntake | undefined, knownRoots: string[]): OverviewArtifacts {
  return { handoff: false, sparring: false, brief: false, plan: false, ...(intake ? { intake, knownRoots } : {}) };
}

async function world(options: { appStatus?: "paused" } = {}) {
  const w = await crossRepositoryIntake();
  if (options.appStatus) {
    const planFile = path.join(w.app.sparringDir, "plans", "app-run-0001.json");
    const state = JSON.parse(await fs.readFile(planFile, "utf8"));
    await fs.writeFile(planFile, JSON.stringify({ ...state, status: options.appStatus }));
  }
  // The fixture records the run, not its stages' state: accept its last stage.
  for (const stageId of ["app-run-0001-stage-0-audit", "app-run-0001-stage-1a-app-change"]) {
    const dir = path.join(w.app.sparringDir, "stages", stageId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ base_sha: "a", candidate_sha: "b", implementation_session_id: null, sparring_session_id: null, status: "accepted", run: "app-run-0001" }));
  }
  const discovery = await w.discover();
  const knownRoots = [w.app.repoRoot, w.web.repoRoot];
  const run = discovery.runs.find((entry) => entry.id === w.appRunId);
  assert.ok(run, "the app slice's run is discovered");
  const intake = intakeOfRun(run, discovery.intakes);
  assert.ok(intake, "and bound to its intake by the run's own binding");
  return { ...w, discovery, knownRoots, run, intake };
}

describe("What's next for an intake-backed run", () => {
  it("after slice A in app, names slice B and its repository web, with Switch — not 'No stage follows'", async () => {
    const w = await world();
    const selection = selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, w.scope(w.app), undefined, [w.app, w.web], w.discovery.intakes);
    assert.equal(selection.selected?.id, w.appRunId);
    const model = buildOverviewModel(selection, undefined, artifactsFor(w.intake, w.knownRoots), T0);
    assert.equal(model.whatsNext?.kind, "intake-next");
    assert.equal(model.whatsNext?.heading, "Stage 1B — Web repair");
    assert.deepEqual(model.whatsNext?.repository && [model.whatsNext.repository.name, model.whatsNext.repository.root, model.whatsNext.repository.action], ["web", w.web.repoRoot, "switch"]);
    assert.match(model.banner?.text ?? "", /^Execution complete/, "the execution ended; the plan did not");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /data-action="switchToNextRepository"[^>]*>Switch to web</);
    assert.doesNotMatch(html, /No stage follows/);
    assert.doesNotMatch(html, /Plan complete/);
    assert.doesNotMatch(/<div class="block whatsnext">[\s\S]*?<div class="actions">/.exec(html)?.[0] ?? "", /slice/i);
    assert.doesNotMatch(html, /data-intake="(approve|start)"/, "switching approves and starts nothing, and no approval is offered here");
  });

  it("while the finished slice's run is still open, Continue plan comes first and there is nothing to switch to yet", async () => {
    const w = await world({ appStatus: "paused" });
    const selection = selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, w.scope(w.app), undefined, [w.app, w.web], w.discovery.intakes);
    const model = buildOverviewModel(selection, undefined, artifactsFor(w.intake, w.knownRoots), T0);
    assert.equal(model.whatsNext?.kind, "intake-next");
    assert.equal(model.whatsNext?.heading, "Stage 1B — Web repair");
    assert.equal(model.whatsNext?.repository?.action, undefined);
    assert.match(model.whatsNext?.text ?? "", /Stage 1B follows in web/);
    assert.doesNotMatch(renderOverviewHtml(model, "n", "c"), /No stage follows/);
  });

  it("a run pin in web's scope does not rewrite the continuation; the next work is here, so it is shown, not switched to", async () => {
    const w = await world();
    const pinned = selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, w.scope(w.web), undefined, [w.app, w.web], w.discovery.intakes);
    assert.equal(pinned.selected?.id, w.appRunId, "the pin wins");
    const model = buildOverviewModel(pinned, undefined, artifactsFor(w.intake, w.knownRoots), T0);
    assert.equal(model.whatsNext?.heading, "Stage 1B — Web repair");
    assert.equal(model.whatsNext?.repository?.action, "show");
    const html = renderOverviewHtml(model, "n", "c");
    assert.doesNotMatch(html, /switchToNextRepository/, "same repository: no switch");
    assert.match(html, /data-action="showNextWork"[^>]*>Show next stage</);
  });

  it("after switching to web, current-work discovery selects the intake's continuation, and nothing was written", async () => {
    const w = await world();
    const before = await snapshotTree(w.intakeDir);
    buildOverviewModel(selectRun(w.discovery.runs, undefined, undefined, w.scope(w.app), undefined, [w.app, w.web], w.discovery.intakes), undefined, artifactsFor(w.intake, w.knownRoots), T0);
    const switched = selectRun(w.discovery.runs, undefined, undefined, { ...w.scope(w.web), chosen: true }, undefined, [w.app, w.web], w.discovery.intakes);
    assert.equal(switched.selected, undefined);
    assert.equal(switched.intake?.dir, w.intake.dir);
    assert.equal(nextIntakeSlice(switched.intake!)?.runId, "web", "the same next the What's next panel named");
    const model = buildOverviewModel(switched, undefined);
    assert.equal(model.intake?.action?.kind, "approve", "the approval is offered there, and only there");
    assert.deepEqual(await snapshotTree(w.intakeDir), before);
  });

  it("the multi-stage next execution is named by its stages", async () => {
    const w = await world();
    const grouped: DiscoveredIntake = {
      ...w.intake,
      slices: w.intake.slices.map((slice) => (slice.runId === "web" ? { ...slice, stages: [{ label: "Stage 2", title: "Reconcile" }, { label: "Stage 3P", title: "Presentation" }] } : slice)),
    };
    const selection = selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, w.scope(w.app), undefined, [w.app, w.web], w.discovery.intakes);
    const model = buildOverviewModel(selection, undefined, artifactsFor(grouped, w.knownRoots), T0);
    assert.equal(model.whatsNext?.heading, "Next execution: Stages 2 + 3P");
    assert.deepEqual(model.whatsNext?.stages, ["Stage 2 — Reconcile", "Stage 3P — Presentation"]);
    const block = /<div class="block whatsnext">[\s\S]*?<div class="actions">/.exec(renderOverviewHtml(model, "n", "c"))?.[0] ?? "";
    assert.match(block, /Next execution: Stages 2 \+ 3P/);
    assert.doesNotMatch(block, /slice/i, "stages are named; the engine's execution unit is not");
  });

  it("only when nothing else in the intake is left does it say there are no further stages", async () => {
    const w = await world();
    const done: DiscoveredIntake = { ...w.intake, slices: w.intake.slices.filter((slice) => slice.runId === "app") };
    const selection = selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, w.scope(w.app), undefined, [w.app, w.web], w.discovery.intakes);
    const model = buildOverviewModel(selection, undefined, artifactsFor(done, w.knownRoots), T0);
    assert.equal(model.whatsNext?.kind, "plan-complete");
    assert.equal(model.whatsNext?.text, "No further stages in this plan.");
    assert.match(model.banner?.text ?? "", /^Plan complete/);
  });

  it("a standalone managed run with no intake keeps the existing plan-stage logic", async () => {
    const w = await world();
    const selection = selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, w.scope(w.app), undefined, [w.app, w.web], w.discovery.intakes);
    const model = buildOverviewModel(selection, undefined, artifactsFor(undefined, w.knownRoots), T0);
    assert.equal(model.whatsNext, undefined, "a complete standalone run: unchanged, no intake continuation");
  });
});

// ---------------------------------------------------------------- the pure continuation

function slice(runId: string, state: IntakeSliceSnapshot["state"], repo: string, earlier: string[] = [], label = runId): IntakeSliceSnapshot {
  return {
    runId,
    runKey: `key-${runId}`,
    state,
    stages: [{ label: `Stage ${label}`, title: runId }],
    primaryRepository: repo,
    primaryPath: `/code/${repo}`,
    requirements: { approvable: true, primaryRepository: repo, siblings: [], gates: [], earlierSlices: earlier, withoutAmendment: false },
  };
}

function intakeOf(slices: IntakeSliceSnapshot[]): IntakeSnapshot {
  return { dir: "/i", sparringDir: "/s", record: { intakeId: "i", planLabel: "p", runKeys: slices.map((s) => ({ runId: s.runId, runKey: s.runKey })), repositories: {} }, slices, state: "running", reportPath: "/i/report.md", usable: true };
}

/** Taxonomy v3 as recorded: slice order and earlier_slices from its intake.json. */
function taxonomy(two: IntakeSliceSnapshot["state"]): IntakeSnapshot {
  return intakeOf([
    slice("run_1a_py", "complete", "sporely-py", [], "1A"),
    slice("run_1b_web", "complete", "sporely-web", ["run_1a_py"], "1B"),
    slice("run_2_py", two, "sporely-py", ["run_1b_web"], "2"),
    slice("run_5_web", "prepared", "sporely-web", ["run_2_py"], "5"),
    slice("run_3p_py", "prepared", "sporely-py", ["run_2_py"], "3P"),
    slice("run_3w_web", "prepared", "sporely-web", ["run_3p_py"], "3W"),
    slice("run_6p_py", "prepared", "sporely-py", ["run_3w_web", "run_5_web"], "6P"),
  ]);
}

describe("intakeContinuation", () => {
  it("Taxonomy: accepted Stage 2 in sporely-py → Stage 5 in sporely-web, after closing the open run", () => {
    const open = intakeContinuation(taxonomy("running"), "run_2_py");
    assert.equal(open.kind, "next");
    assert.equal(open.kind === "next" && open.slice.runId, "run_5_web");
    assert.equal(open.kind === "next" && open.afterCurrent, true);
    const closed = intakeContinuation(taxonomy("complete"), "run_2_py");
    assert.deepEqual(closed.kind === "next" && [closed.slice.runId, closed.slice.primaryRepository, closed.afterCurrent], ["run_5_web", "sporely-web", false]);
  });

  it("A(py) → B(web) → C(py): after A, next is B", () => {
    const i = intakeOf([slice("a", "complete", "py"), slice("b", "prepared", "web", ["a"]), slice("c", "prepared", "py", ["b"])]);
    const c = intakeContinuation(i, "a");
    assert.equal(c.kind === "next" && c.slice.runId, "b");
  });

  it("dependency-blocked work is not called next; eligible later work is", () => {
    // blocked first in textual order, eligible second
    const i = intakeOf([slice("a", "complete", "py"), slice("x", "prepared", "web", ["z"]), slice("y", "prepared", "py", ["a"]), slice("z", "prepared", "web", ["y"])]);
    const c = intakeContinuation(i, "a");
    assert.equal(c.kind === "next" && c.slice.runId, "y");
    // nothing eligible: waiting, naming what it waits on
    const waiting = intakeContinuation(intakeOf([slice("a", "complete", "py"), slice("b", "running", "web", ["a"]), slice("c", "prepared", "py", ["b"])]), "a");
    assert.equal(waiting.kind, "waiting");
    assert.deepEqual(waiting.kind === "waiting" && [waiting.slice?.runId, waiting.waitingOn, waiting.running.map((s) => s.runId)], ["c", ["b"], ["b"]]);
  });

  it("the end of the whole intake is complete; ending one slice with work left is not", () => {
    assert.equal(intakeContinuation(intakeOf([slice("a", "complete", "py"), slice("b", "complete", "web")]), "b").kind, "complete");
    assert.notEqual(intakeContinuation(intakeOf([slice("a", "running", "py"), slice("b", "prepared", "web", ["a"])]), "a").kind, "complete");
  });
});
