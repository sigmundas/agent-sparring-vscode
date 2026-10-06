/**
 * Binding a start-plan direct-route confirmation to the run the engine
 * minted for it, from recorded engine state alone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunSnapshot } from "../core/discovery";
import { bindStartedRun, readStartPlanRuns, withBinding, type PendingStartedRun } from "../core/startPlanBinding";

function planRun(id: string, overrides: { sparringDir?: string; plan?: string; source?: string } = {}): RunSnapshot {
  return {
    kind: "plan",
    id,
    location: { sparringDir: overrides.sparringDir ?? "/repo/.sparring" },
    state: { plan: overrides.plan ?? "plans/demo.md", source: overrides.source ?? "markdown", status: "running" },
  } as unknown as RunSnapshot;
}

const PENDING: PendingStartedRun = { provisionalRunId: "p", sparringDir: "/repo/.sparring", planLabel: "plans/demo.md", before: ["old"], launchedAtMs: 0, show: true };

describe("start-plan run binding", () => {
  it("binds the one new run of the plan in that project", () => {
    assert.deepEqual(bindStartedRun(PENDING, [planRun("old"), planRun("new")]), { kind: "bound", runId: "new" });
  });

  it("waits while the engine has recorded nothing new", () => {
    assert.deepEqual(bindStartedRun(PENDING, [planRun("old")]), { kind: "waiting" });
  });

  it("ignores another plan, another project, and a non-Markdown run", () => {
    const others = [planRun("a", { plan: "plans/other.md" }), planRun("b", { sparringDir: "/other/.sparring" }), planRun("c", { source: "intake-manifest" })];
    assert.deepEqual(bindStartedRun(PENDING, others), { kind: "waiting" });
  });

  it("binds nothing when more than one new run could be it", () => {
    assert.deepEqual(bindStartedRun(PENDING, [planRun("x"), planRun("y")]), { kind: "ambiguous", runIds: ["x", "y"] });
  });

  it("stores bindings and retires the pending entry", () => {
    const state = withBinding({ pending: [PENDING], bindings: {} }, "new", "p");
    assert.deepEqual(state, { pending: [], bindings: { new: "p" } });
    assert.deepEqual(readStartPlanRuns(JSON.parse(JSON.stringify(state))), state);
    assert.deepEqual(readStartPlanRuns("garbage"), { pending: [], bindings: {} });
  });
});
