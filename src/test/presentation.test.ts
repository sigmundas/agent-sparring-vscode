import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { foldEvents } from "../core/liveState";
import { actionWord, humanizeStageId, presentStage, truncateLabel } from "../core/presentation";
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

describe("stage presentation state (human vocabulary)", () => {
  it("READY → Review complete, with the engine word kept only in raw", () => {
    const p = presentStage("working", { action: "READY", summary: "ok" });
    assert.equal(p.kind, "ready");
    assert.equal(p.label, "Review complete");
    assert.equal(p.detail, "Independent review passed. No unresolved findings remain.");
    assert.equal(p.short, "Review complete");
    assert.equal(p.raw, "working · READY");
  });

  it("SEND_BACK → Changes requested; NEEDS_YOU → Needs you with the request as detail; ESCALATE → Escalated", () => {
    const sendBack = presentStage("working", { action: "SEND_BACK", summary: "fix x" });
    assert.equal(sendBack.label, "Changes requested");
    assert.equal(sendBack.detail, "The independent reviewer found something to fix. Work will continue automatically.");
    const needsYou = presentStage("working", { action: "NEEDS_YOU", summary: "Test the shipped desktop app against the upgraded database and record the result." });
    assert.equal(needsYou.label, "Needs you");
    assert.equal(needsYou.detail, "Test the shipped desktop app against the upgraded database and record the result.");
    assert.equal(needsYou.raw, "working · NEEDS_YOU");
    assert.equal(presentStage("working", { action: "ESCALATE", summary: "" }).label, "Escalated");
    assert.equal(presentStage("working", undefined).label, "Working");
  });

  it("ACCEPTED → Accepted / Stage complete; FROZEN → Finalizing stage…, never the word frozen", () => {
    const accepted = presentStage("accepted", { action: "SEND_BACK", summary: "" });
    assert.equal(accepted.label, "Accepted");
    assert.equal(accepted.detail, "Stage complete.");
    const frozen = presentStage("frozen", { action: "READY", summary: "" });
    assert.equal(frozen.kind, "finalizing");
    assert.equal(frozen.label, "Finalizing stage…");
    assert.ok(!/frozen/i.test(`${frozen.label} ${frozen.detail} ${frozen.short}`));
    assert.equal(frozen.raw, "FROZEN · READY");
  });

  it("a live correction turn presents as Working (the finding stays under Latest sparring result)", () => {
    const busy = foldEvents([event("stage", "turn.started")]);
    assert.equal(presentStage("working", { action: "NEEDS_YOU", summary: "" }, busy).kind, "working");
    assert.equal(presentStage("working", { action: "SEND_BACK", summary: "" }, busy).label, "Working");
    assert.equal(presentStage("working", { action: "READY", summary: "" }, busy).kind, "ready", "nothing acts on READY");
  });

  it("maps routing actions to words for the Latest sparring result", () => {
    assert.equal(actionWord("READY"), "Review passed");
    assert.equal(actionWord("SEND_BACK"), "Changes requested");
    assert.equal(actionWord("NEEDS_YOU"), "Needs you");
    assert.equal(actionWord("ESCALATE"), "Escalated");
    assert.equal(actionWord("OTHER"), "OTHER");
  });
});

describe("status bar with humanized names", () => {
  it("standalone stage: truncated human name plus Review complete; the engine word only in the tooltip", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-reported-statistics-local-schema-barrier", { status: "working" }, { "sparring.md": sparringMarkdown("READY", "Looks complete") });
    const view = deriveStatus(selectRun((await discoverRuns([ws.location])).runs), undefined, NOW);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Reported statistics local s… · Review complete");
    assert.match(view.tooltip, /Stage id: stage-reported-statistics-local-schema-barrier/);
    assert.match(view.tooltip, /Stage state: Review complete/);
    assert.match(view.tooltip, /Engine state: working · READY/);
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
