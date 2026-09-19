/**
 * Working, Run status unknown, Stopped — and what each of them is allowed
 * to rest on.
 *
 * The two reported symptoms were opposites of each other: the Overview said
 * the run was busy when the extension's grip on it was weak, and said
 * nothing useful when a run was recorded as active but could not be
 * accounted for — in which case it also offered Run/Resume, which the
 * registry then refused with a dialog the person had no way to anticipate.
 *
 * So each word is pinned to exactly one thing here:
 *
 *  - **Working**: positive current evidence that *this* execution is alive.
 *  - **Run status unknown**: recorded as active, and neither alive nor
 *    ended can be established — the guard stays, and the screen says so
 *    before anything is clicked.
 *  - **Stopped**: the person asked, and that exact execution has since been
 *    observed ending. Never an ordinary completion or failure.
 *  - **Waiting for you** keeps its own meaning, and a plan record that says
 *    `running` never overrides it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { applyEvent, emptyLiveState, type LiveState } from "../core/liveState";
import type { ExecutionRecord } from "../core/liveness";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { Workspace, normalUi } from "./fixtures";

const T0 = Date.parse("2026-02-02T09:00:00Z");
const BASE: OverviewArtifacts = { handoff: true, sparring: true, brief: true, plan: true };

function busy(): LiveState {
  const live = emptyLiveState();
  applyEvent(live, { v: 1, ts: new Date(T0).toISOString(), actor: "loop", event: "loop.started" });
  applyEvent(live, { v: 1, ts: new Date(T0 + 1000).toISOString(), actor: "stage", event: "turn.started", provider: "claude-cli", session_id: "82ab" });
  return live;
}

const execution = (runId: string, over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  id: "e1",
  runId,
  kind: "run-loop",
  source: "launched",
  state: "running",
  startedAtMs: T0,
  ...over,
});

async function stage(stageId = "s", files: Record<string, string> = {}) {
  const ws = await Workspace.create();
  await ws.writeStage(stageId, { status: "working", implementation_session_id: "82ab" }, files);
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  return { selection, runId: selection.selected!.id };
}

/** A guard the registry cannot account for: the state after a reload. */
const guarded = { guardedOperationId: "operation-1", guardOutstanding: true };

describe("Working means this exact runner is observed alive", () => {
  it("1. an observed-alive execution with a stop target renders Working and offers Stop", async () => {
    const { selection, runId } = await stage();
    const model = buildOverviewModel(selection, busy(), { ...BASE, stopTarget: { executionId: "e1", via: "terminal" } }, T0 + 60_000, execution(runId));
    assert.equal(model.busyState?.label, "Working");
    assert.equal(model.busyState?.state, "running");
    assert.equal(model.runner?.label, "Stop");
    assert.equal(model.stageAction, undefined, "and nothing that would start a second one");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /data-stop="e1"/);
    assert.doesNotMatch(normalUi(html), /Run status unknown/);
  });

  it("Working is never claimed from a plan record, from telemetry, or from a launch having succeeded", async () => {
    const { selection, runId } = await stage();
    // Telemetry says a turn is in progress and nothing has been observed:
    // that is the textbook case for unknown, not for Working.
    const telemetryOnly = buildOverviewModel(selection, busy(), BASE, T0 + 60_000, undefined);
    assert.equal(telemetryOnly.busyState?.label, "Run status unknown");
    assert.equal(telemetryOnly.runner, undefined, "and nothing to stop, because nothing is identified");

    // An execution whose fate could not be established is not Working either.
    const lost = buildOverviewModel(selection, busy(), BASE, T0 + 60_000, execution(runId, { state: "unknown", detail: "The terminal that hosted this run closed without reporting an exit code." }));
    assert.equal(lost.busyState?.label, "Run status unknown");
    assert.equal(lost.runner, undefined);
  });
});

describe("Run status unknown says what it costs, and withholds what it must", () => {
  it("2+3. a run recorded as active but unaccountable blocks a second copy, and says so before it is clicked", async () => {
    const { selection, runId } = await stage();
    // No telemetry at all: the *only* thing saying this run may be active is
    // the duplicate guard the registry is still holding. That case used to
    // offer Resume and then be refused by the registry on the click.
    const model = buildOverviewModel(selection, undefined, { ...BASE, ...guarded }, T0 + 60_000, execution(runId, { state: "unknown", detail: "No process in the table can be positively attributed to this run." }));
    assert.equal(model.busyState?.label, "Run status unknown");
    assert.equal(model.busyState?.state, "unknown");
    assert.match(model.busyState?.detail ?? "", /Run may still be active — starting another copy is blocked\./);
    assert.doesNotMatch(model.busyState?.detail ?? "", /failed|error/i, "nothing here implies a failure");
    assert.equal(model.stageAction, undefined, "nothing that would start a second copy is offered");
    assert.equal(model.planAction, undefined);
    assert.ok(model.unknownRunner, "and the way out of it is on screen");
  });

  it("a guard with no execution behind it is not a dead end: the way out is on the screen that withholds the action", async () => {
    const { selection } = await stage();
    // The case a reload leaves when a command was handed to a shell and
    // never seen to start: a duplicate guard, and no runner record at all.
    // Before the actions were withheld for a guard, the route out was to
    // press Run and override the refusal dialog. Withholding the button
    // removes that route, so the screen has to carry it.
    const model = buildOverviewModel(selection, undefined, { ...BASE, ...guarded }, T0 + 60_000, undefined);
    assert.equal(model.stageAction, undefined, "nothing that could start a second copy");
    assert.ok(model.unknownRunner, "and something the person can press to settle it");
    assert.equal(model.unknownRunner?.operationId, "operation-1", "acting on the exact operation this page was built from");
    assert.equal(model.unknownRunner?.executionId, undefined, "there is no execution to end, and none is named");
    assert.doesNotMatch(model.unknownRunner?.detail ?? "", /send your evidence again/, "there was no submission behind it either");
    assert.match(renderOverviewHtml(model, "n", "c"), /data-action="confirmRunnerInactive"/);
  });

  it("the guard alone withholds the actions, even when nothing else looks busy", async () => {
    const { selection } = await stage();
    const free = buildOverviewModel(selection, undefined, BASE, T0 + 60_000, undefined);
    assert.ok(free.stageAction, "with no guard the stage can be run");

    const held = buildOverviewModel(selection, undefined, { ...BASE, ...guarded }, T0 + 60_000, undefined);
    assert.equal(held.stageAction, undefined, "with one, it cannot");
    assert.equal(held.busyState?.label, "Run status unknown");
  });
});

describe("Stopped is only ever a stop that was asked for and then observed", () => {
  it("9+10. an observed end after a request reads Stopped — ready to resume, and the plan run can be resumed", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writeStage("plan-stage-1", { status: "working", implementation_session_id: "82ab" });
    await ws.writePlanRun("foo-plan", { plan: "docs/plans/foo.md", status: "running", current_stage_index: 0, current_stage: "plan-stage-1" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const runId = selection.selected!.id;
    const model = buildOverviewModel(
      selection,
      busy(),
      BASE,
      T0 + 60_000,
      execution(runId, { state: "ended", endedAtMs: T0 + 30_000, exitCode: 130, stopRequestedAtMs: T0 + 29_000 }),
    );
    assert.equal(model.status?.label, "Stopped — ready to resume");
    assert.match(model.liveness?.detail ?? "", /You stopped this runner and it has ended/);
    assert.equal(model.runner, undefined, "there is nothing left to stop");
    assert.ok(model.planAction, "and the same managed run is offered again");
    assert.match(model.planAction?.label ?? "", /plan/i);
    assert.equal(renderOverviewHtml(model, "n", "c").includes('data-action="resumePlan"'), true, "Resume plan, not a new run");
  });

  it("17. an ordinary completion and an ordinary failure keep their own words", async () => {
    const { selection, runId } = await stage();
    const clean = buildOverviewModel(selection, undefined, BASE, T0 + 60_000, execution(runId, { state: "ended", endedAtMs: T0 + 30_000, exitCode: 0 }));
    assert.notEqual(clean.status?.label, "Stopped — ready to resume");
    const failed = buildOverviewModel(selection, undefined, BASE, T0 + 60_000, execution(runId, { state: "ended", endedAtMs: T0 + 30_000, exitCode: 2 }));
    assert.notEqual(failed.status?.label, "Stopped — ready to resume");
  });

  it("11. a stop that was asked for and never proved stays unknown and stays guarded", async () => {
    const { selection, runId } = await stage();
    const model = buildOverviewModel(
      selection,
      busy(),
      { ...BASE, ...guarded },
      T0 + 60_000,
      execution(runId, { state: "unknown", stopRequestedAtMs: T0 + 29_000, detail: "The terminal that was running this closed without reporting an exit code." }),
    );
    assert.equal(model.busyState?.label, "Stop requested · status unknown");
    assert.match(model.busyState?.detail ?? "", /nothing has proved that runner ended/);
    assert.match(model.busyState?.detail ?? "", /starting another copy is blocked/);
    assert.equal(model.stageAction, undefined, "and nothing is offered that could start a second copy");
    assert.notEqual(model.status?.label, "Stopped — ready to resume");
  });

  it("a stop that was asked for while the runner is still alive says so, and does not offer a second Stop", async () => {
    const { selection, runId } = await stage();
    const model = buildOverviewModel(
      selection,
      busy(),
      { ...BASE, stopTarget: { executionId: "e1", via: "terminal" } },
      T0 + 60_000,
      execution(runId, { stopRequestedAtMs: T0 + 29_000 }),
    );
    assert.equal(model.busyState?.label, "Stop requested…");
    assert.equal(model.busyState?.state, "running");
    assert.equal(model.runner, undefined, "asking twice is not offered");
  });
});

describe("a run waiting for a human is not Working", () => {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "Check it", checks: [{ id: "one", instruction: "Open it.", pass_criteria: "It opens.", source: null }] };
  const sparring = ["# Sparring: s", "", "## Routing outcome", "", "- Action: `NEEDS_YOU`", "- Summary: one check blocks this", "", "## NEEDS YOU", "", HUMAN_GATE_MARKER, "", "```json", JSON.stringify(gate), "```", ""].join("\n");

  async function planAtGate(status: "running" | "paused") {
    const ws = await Workspace.create();
    await ws.writeStage("gate-stage", { status: "working", implementation_session_id: "82ab", sparring_session_id: "c3" }, { "sparring.md": sparring });
    await ws.writePlan();
    await ws.writePlanRun("foo-plan", { plan: "docs/plans/foo.md", status, current_stage_index: 0, current_stage: "gate-stage" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    // On the branch the run expects, so nothing is withheld for that reason.
    return buildOverviewModel(selection, undefined, { ...BASE, git: { branch: "feature/x" } }, T0 + 60_000, undefined);
  }

  it("18. a plan run paused at a gate is Waiting for you, and nothing there is a runner to stop", async () => {
    const model = await planAtGate("paused");
    assert.ok(model.actionRequired, "the person is what it is waiting for");
    assert.equal(model.actionRequired?.kind, "needs_you");
    assert.equal(model.busyState, undefined, "no Working pill: nothing is running");
    assert.equal(model.runner, undefined, "and nothing to stop");
  });

  it("18. a plan record that still says `running` with no runner observed is not Working either", async () => {
    const model = await planAtGate("running");
    assert.equal(model.busyState, undefined, "the plan record is not a process observation");
    assert.equal(model.runner, undefined, "so no Stop is offered against it");
    assert.equal(model.stageStatus, "Needs you", "and the stage is described by what the reviewer recorded");
  });
});
