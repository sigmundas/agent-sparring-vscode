/**
 * The experimental agent-sessions listing copies one mapping from RunSummary;
 * it must say no more than the summary does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentSessionItem } from "../core/agentSessionItem";
import type { RunSummary } from "../core/runSummary";

const NOW = new Date(2026, 9, 6, 12, 0).getTime();

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    id: "/code/app|plan:tidy",
    kind: "plan",
    title: "Tidy the cockpit",
    runKey: "tidy-1",
    planFile: "tidy.md",
    phase: "running",
    statusWord: "Running",
    open: true,
    stage: { position: 2, total: 3, name: "Header", stageId: "tidy-1-stage-2-header" },
    updatedAtMs: new Date(2026, 9, 6, 10, 42).getTime(),
    repository: { projectDir: "/code/app", repoRoot: "/code/app", name: "app" },
    ...overrides,
  };
}

describe("a run as an agent session", () => {
  it("a running run is in progress, described by its stage and who acts next", () => {
    const item = agentSessionItem(summary({ actor: "Reviewer" }), NOW);
    assert.equal(item.state, "inProgress");
    assert.equal(item.label, "Tidy the cockpit");
    assert.equal(item.description, "Stage 2 of 3 · Reviewer");
    assert.equal(item.badge, undefined);
    assert.equal(item.timing.lastRequestEnded, undefined, "still running");
    assert.match(item.tooltip, /Run `tidy-1` · app · updated Today 10:42/);
  });

  it("a run waiting on a person needs input and carries what it waits on", () => {
    const item = agentSessionItem(summary({ phase: "needs-you", statusWord: "Needs you", gate: { kind: "human-gate", text: "Device check" } }), NOW);
    assert.equal(item.state, "needsInput");
    assert.equal(item.badge, "Device check");
    assert.match(item.tooltip, /Waiting on: Device check/);
  });

  it("paused needs input, complete is completed, and nothing is ever reported failed", () => {
    assert.equal(agentSessionItem(summary({ phase: "paused", statusWord: "Paused" }), NOW).state, "needsInput");
    const done = agentSessionItem(summary({ phase: "complete", statusWord: "Complete", open: false }), NOW);
    assert.equal(done.state, "completed");
    assert.equal(done.timing.lastRequestEnded, done.timing.created);
  });

  it("a standalone stage with no position falls back to its status", () => {
    assert.equal(agentSessionItem(summary({ kind: "stage", stage: undefined, phase: "open", statusWord: "Working" }), NOW).description, "Working");
  });
});
