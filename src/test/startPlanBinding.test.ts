/**
 * Binding a start-plan direct-route confirmation to the run the engine
 * minted for it, from recorded engine state alone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunSnapshot } from "../core/discovery";
import { bindStartedRun, readStartPlanRuns, reconcileStartedRuns, withBinding, type LaunchEvidence, type PendingStartedRun } from "../core/startPlanBinding";

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

describe("reconciling pending confirmations", () => {
  const evidence = (map: Record<string, LaunchEvidence>) => (id: string) => map[id] ?? "none";

  it("a launch that was never submitted claims nothing, and a later retry binds its own run", () => {
    const failed: PendingStartedRun = { ...PENDING, provisionalRunId: "failed" };
    const retry: PendingStartedRun = { ...PENDING, provisionalRunId: "retry" };
    const result = reconcileStartedRuns({ pending: [failed, retry], bindings: {} }, [planRun("old"), planRun("new")], evidence({ retry: "running" }));
    assert.deepEqual(result.state, { pending: [], bindings: { new: "retry" } });
    assert.deepEqual(result.bound.map((entry) => entry.pending.provisionalRunId), ["retry"]);
  });

  it("a run started outside this window is never claimed by a dead confirmation", () => {
    const result = reconcileStartedRuns({ pending: [PENDING], bindings: {} }, [planRun("old"), planRun("external")], evidence({}));
    assert.deepEqual(result.state, { pending: [], bindings: {} });
  });

  it("an unresolved submission keeps waiting until the engine records its run", () => {
    const result = reconcileStartedRuns({ pending: [PENDING], bindings: {} }, [planRun("old")], evidence({ p: "submitted" }));
    assert.deepEqual(result.state.pending, [PENDING]);
  });

  it("two live confirmations claiming one run bind neither", () => {
    const a: PendingStartedRun = { ...PENDING, provisionalRunId: "a" };
    const b: PendingStartedRun = { ...PENDING, provisionalRunId: "b" };
    const result = reconcileStartedRuns({ pending: [a, b], bindings: {} }, [planRun("old"), planRun("new")], evidence({ a: "running", b: "running" }));
    assert.deepEqual(result.state, { pending: [], bindings: {} });
  });

  it("a run already bound is never taken by another confirmation", () => {
    const late: PendingStartedRun = { ...PENDING, provisionalRunId: "late" };
    const result = reconcileStartedRuns({ pending: [late], bindings: { new: "first" } }, [planRun("old"), planRun("new")], evidence({ late: "running" }));
    assert.deepEqual(result.state.bindings, { new: "first" });
    assert.deepEqual(result.state.pending, [late]);
  });

  it("an ended confirmation with no recorded run stops waiting", () => {
    const result = reconcileStartedRuns({ pending: [PENDING], bindings: {} }, [planRun("old")], evidence({ p: "ended" }));
    assert.deepEqual(result.state.pending, []);
  });
});
