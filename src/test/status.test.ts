import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun, type RunSelection } from "../core/discovery";
import { emptyLiveState, foldEvents } from "../core/liveState";
import { QUIET_AFTER_MS, deriveStatus, formatAge } from "../core/status";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, event, sparringMarkdown } from "./fixtures";

const NOW = Date.parse("2026-09-12T20:00:00.000Z");

async function planSelection(status: "running" | "paused" | "complete", index: number, sparring?: string): Promise<RunSelection> {
  const ws = await Workspace.create();
  await ws.writePlan();
  await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status, current_stage_index: index, current_stage: FOO_STAGE_IDS[index] });
  for (let i = 0; i < index; i++) {
    await ws.writeStage(FOO_STAGE_IDS[i], { status: "accepted" });
  }
  await ws.writeStage(FOO_STAGE_IDS[index], { status: status === "complete" ? "accepted" : "working" }, sparring ? { "sparring.md": sparring } : {});
  return selectRun((await discoverRuns([ws.location])).runs);
}

describe("status bar derivation", () => {
  it("no runs", () => {
    const view = deriveStatus({ ambiguous: [] }, undefined, NOW);
    assert.match(view.text, /No active run/);
  });

  it("running plan with no telemetry shows only the authoritative position", async () => {
    const view = deriveStatus(await planSelection("running", 2), undefined, NOW);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Stage 3/3");
    assert.match(view.tooltip, /No activity telemetry/);
  });

  it("running plan decorated by live actor from activity", async () => {
    const selection = await planSelection("running", 2);
    let live = foldEvents([event("loop", "loop.started"), event("stage", "turn.started", { provider: "claude-cli" })]);
    let view = deriveStatus(selection, live, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Stage 3/3 · Claude working");

    live = foldEvents([event("stage", "handoff.ready"), event("sparrer", "sparring.started", { provider: "codex-cli" })], live);
    view = deriveStatus(selection, live, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Stage 3/3 · Codex sparring");

    live = foldEvents([event("sparrer", "verdict", { provider: "codex-cli", action: "SEND_BACK", summary: "fix it" })], live);
    view = deriveStatus(selection, live, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Stage 3/3 · last SEND_BACK");
    assert.match(view.tooltip, /Last verdict SEND_BACK: fix it/);
  });

  it("flags a long-silent 'working' claim as quiet", async () => {
    const selection = await planSelection("running", 0);
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const view = deriveStatus(selection, live, Date.parse(live.lastEventTs!) + QUIET_AFTER_MS + 60_000);
    assert.match(view.text, /Claude working · quiet 11m/);
  });

  it("telemetry never overrides authoritative pause/complete", async () => {
    const paused = await planSelection("paused", 1, sparringMarkdown("NEEDS_YOU", "Check on device", "device_manual_check"));
    const busyLive = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    let view = deriveStatus(paused, busyLive, NOW);
    assert.equal(view.text, "$(debug-pause) Agent Sparring: Stage 2/3 · NEEDS_YOU");
    assert.match(view.tooltip, /NEEDS_YOU: Check on device/);
    assert.ok(!view.tooltip.includes("Long findings"));

    const escalated = await planSelection("paused", 1, sparringMarkdown("ESCALATE", "Needs a stronger sparrer"));
    view = deriveStatus(escalated, busyLive, NOW);
    assert.equal(view.text, "$(debug-pause) Agent Sparring: Stage 2/3 · ESCALATE");

    const failed = await planSelection("paused", 1, sparringMarkdown("READY", "Looks good"));
    view = deriveStatus(failed, foldEvents([event("plan", "plan.failed", { summary: "acceptance gate refused" })]), NOW);
    assert.equal(view.text, "$(debug-pause) Agent Sparring: Stage 2/3 · Paused");
    assert.match(view.tooltip, /Stopped: acceptance gate refused/);

    const complete = await planSelection("complete", 2);
    view = deriveStatus(complete, busyLive, NOW);
    assert.equal(view.text, "$(check) Agent Sparring: Plan complete");
  });

  it("ambiguous runs ask for a selection", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlan("docs/plans/bar.md", "## Stage 1 — Only\nbody\n");
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writePlanRun("bar-00000000", { plan: "docs/plans/bar.md", status: "paused", current_stage_index: 0, current_stage: "bar-00000000-stage-1-only" });
    const view = deriveStatus(selectRun((await discoverRuns([ws.location])).runs), emptyLiveState(), NOW);
    assert.equal(view.text, "$(question) Agent Sparring: 2 runs · select");
    assert.equal(view.severity, "warning");
  });

  it("standalone stage states", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "frozen", candidate_sha: "abc" });
    let view = deriveStatus(selectRun((await discoverRuns([ws.location])).runs), undefined, NOW);
    assert.equal(view.text, "$(lock) Agent Sparring: hotfix-1 · frozen");

    await ws.writeStage("hotfix-1", { status: "working" }, { "sparring.md": sparringMarkdown("NEEDS_YOU", "Pick a colour") });
    view = deriveStatus(selectRun((await discoverRuns([ws.location])).runs), undefined, NOW);
    assert.equal(view.text, "$(debug-pause) Agent Sparring: hotfix-1 · NEEDS_YOU");
  });

  it("formats ages", () => {
    assert.equal(formatAge(5_000), "5s");
    assert.equal(formatAge(125_000), "2m");
    assert.equal(formatAge(3_900_000), "1h 5m");
  });
});
