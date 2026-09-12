import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { foldEvents } from "../core/liveState";
import { humanizeStageId, presentStage, truncateLabel } from "../core/presentation";
import { deriveStatus } from "../core/status";
import { Workspace, event, sparringMarkdown } from "./fixtures";

const NOW = Date.parse("2026-09-12T20:00:00.000Z");

describe("humanized stage names", () => {
  it("derives a readable label from a standalone id", () => {
    assert.equal(humanizeStageId("stage-reported-statistics-local-schema-barrier"), "Reported statistics local schema barrier");
    assert.equal(humanizeStageId("hotfix-1"), "Hotfix 1");
    assert.equal(humanizeStageId("stage-7-device_qa.pass"), "Device qa pass");
  });

  it("strips a plan-key prefix from planned ids", () => {
    assert.equal(humanizeStageId("foo-1cd13d24-stage-2-schema-api"), "Schema api");
  });

  it("truncates long labels with an ellipsis", () => {
    assert.equal(truncateLabel("Reported statistics local schema barrier", 28), "Reported statistics local s…");
    assert.equal(truncateLabel("short", 28), "short");
  });
});

describe("stage presentation state", () => {
  it("READY on a working stage presents as awaiting acceptance", () => {
    const p = presentStage("working", { action: "READY", summary: "ok" });
    assert.equal(p.kind, "ready");
    assert.equal(p.label, "READY · awaiting acceptance");
    assert.equal(p.short, "READY");
  });

  it("keeps accepted/frozen from the authoritative state ahead of any outcome", () => {
    assert.equal(presentStage("accepted", { action: "SEND_BACK", summary: "" }).label, "ACCEPTED · stage complete");
    assert.equal(presentStage("frozen", { action: "READY", summary: "" }).label, "frozen · awaiting acceptance");
  });

  it("SEND_BACK, NEEDS_YOU, ESCALATE and plain working", () => {
    assert.equal(presentStage("working", { action: "SEND_BACK", summary: "" }).label, "SEND_BACK · correcting");
    assert.equal(presentStage("working", { action: "NEEDS_YOU", summary: "" }).label, "NEEDS_YOU");
    assert.equal(presentStage("working", { action: "ESCALATE", summary: "" }).label, "ESCALATE");
    assert.equal(presentStage("working", undefined).label, "working");
    const busy = foldEvents([event("stage", "turn.started")]);
    assert.equal(presentStage("working", { action: "NEEDS_YOU", summary: "" }, busy).kind, "working");
  });
});

describe("status bar with humanized names", () => {
  it("standalone stage: truncated human name plus READY", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-reported-statistics-local-schema-barrier", { status: "working" }, { "sparring.md": sparringMarkdown("READY", "Looks complete") });
    const view = deriveStatus(selectRun((await discoverRuns([ws.location])).runs), undefined, NOW);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Reported statistics local s… · READY");
    assert.match(view.tooltip, /Stage id: stage-reported-statistics-local-schema-barrier/);
    assert.match(view.tooltip, /Stage state: READY · awaiting acceptance/);
    assert.ok(view.text.length < 80);
  });

  it("standalone stage: live actor wins over the outcome word", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" }, { "sparring.md": sparringMarkdown("SEND_BACK", "fix") });
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const view = deriveStatus(selectRun((await discoverRuns([ws.location])).runs), live, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Hotfix 1 · Claude working");
  });
});
