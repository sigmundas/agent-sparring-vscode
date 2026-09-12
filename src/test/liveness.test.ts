/**
 * The liveness reducer: telemetry describes actor activity, process
 * observations decide liveness, and the two never get confused.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STALE_ACTIVE_MS, blocksLaunch, deriveLiveness, latestTurnStart, type ExecutionRecord } from "../core/liveness";
import { applyEvent, emptyLiveState, foldEvents, type LiveState } from "../core/liveState";
import { stageRunAction } from "../core/runner";
import { discoverRuns, selectRun } from "../core/discovery";
import { Workspace } from "./fixtures";

const T0 = Date.parse("2026-09-12T19:00:00.000Z");
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();
const RUN = "/repo|stage:s";

function turnStarted(offsetSeconds = 1): LiveState {
  return foldEvents([
    { v: 1, ts: at(0), actor: "loop", event: "loop.started" },
    { v: 1, ts: at(offsetSeconds), actor: "stage", event: "turn.started", provider: "claude-cli" },
  ]);
}

const exec = (over: Partial<ExecutionRecord>): ExecutionRecord => ({ id: "x", runId: RUN, kind: "run-loop", source: "launched", state: "running", startedAtMs: T0 - 5000, ...over });

describe("liveness reducer", () => {
  it("1. turn.started with no process information → unknown, telemetry-sourced, never running", () => {
    const liveness = deriveLiveness(turnStarted(), undefined, T0 + 60_000);
    assert.equal(liveness.state, "unknown");
    assert.equal(liveness.source, "telemetry");
    assert.equal(liveness.turnActive, true);
    assert.equal(liveness.interrupted, false);
    assert.equal(liveness.live?.stage.busy, true, "the activity itself is still described");
    assert.match(liveness.detail, /cannot prove the process is alive/);
    assert.equal(blocksLaunch(liveness), "unknown");
  });

  it("2. a shell execution starting → running, execution-sourced", () => {
    const liveness = deriveLiveness(turnStarted(), exec({}), T0 + 60_000);
    assert.equal(liveness.state, "running");
    assert.equal(liveness.source, "execution");
    assert.equal(liveness.turnActive, true);
    assert.equal(blocksLaunch(liveness), "running");
    assert.equal(deriveLiveness(undefined, exec({}), T0).state, "running", "running before any telemetry exists too");
  });

  it("3./4. execution ending with code 0 or non-zero after the turn finished → stopped, not interrupted", () => {
    const live = turnStarted();
    applyEvent(live, { v: 1, ts: at(20), actor: "stage", event: "turn.finished" });
    for (const exitCode of [0, 1, 130]) {
      const liveness = deriveLiveness(live, exec({ state: "ended", endedAtMs: T0 + 25_000, exitCode }), T0 + 60_000);
      assert.equal(liveness.state, "stopped");
      assert.equal(liveness.interrupted, false);
      assert.equal(liveness.turnActive, false);
      assert.equal(blocksLaunch(liveness), undefined);
      assert.match(liveness.detail, exitCode === 0 ? /exited normally/ : new RegExp(`exited with code ${exitCode}`));
    }
  });

  it("5./6. Ctrl-C-equivalent end (no exit code) while a turn is unmatched → stopped + interrupted, busy cleared, and it stays that way", () => {
    const live = turnStarted();
    const ended = exec({ state: "ended", endedAtMs: T0 + 30_000, exitCode: undefined });
    const liveness = deriveLiveness(live, ended, T0 + 60_000);
    assert.equal(liveness.state, "stopped");
    assert.equal(liveness.interrupted, true);
    assert.equal(liveness.turnActive, false);
    assert.equal(liveness.live?.stage.busy, false);
    assert.equal(liveness.live?.stage.busySince, undefined);
    assert.equal(live.stage.busy, true, "the fold is never mutated");
    assert.match(liveness.detail, /Ctrl-C.*runner has exited/s);
    assert.equal(blocksLaunch(liveness), undefined, "Resume is allowed after a known stop");
    // Hours later: still stopped, still interrupted, nothing ticking.
    const later = deriveLiveness(live, ended, T0 + 5 * 3_600_000);
    assert.equal(later.state, "stopped");
    assert.equal(later.interrupted, true);
  });

  it("7. late old telemetry after the execution ended does not re-arm running", () => {
    const ended = exec({ state: "ended", endedAtMs: T0 + 30_000 });
    const live = emptyLiveState();
    // The buffered notification arrives after the end, carrying the old start.
    applyEvent(live, { v: 1, ts: at(0), actor: "loop", event: "loop.started" });
    applyEvent(live, { v: 1, ts: at(1), actor: "stage", event: "turn.started" });
    applyEvent(live, { v: 1, ts: at(29), actor: "sparrer", event: "sparring.started" });
    const liveness = deriveLiveness(live, ended, T0 + 31_000);
    assert.equal(liveness.state, "stopped");
    assert.equal(liveness.interrupted, true);
    assert.equal(liveness.live?.sparrer.busy, false);
    assert.equal(latestTurnStart(live), T0 + 29_000);
  });

  it("a turn that started after the observed end is a new observation: unknown, not stopped and not running", () => {
    const ended = exec({ state: "ended", endedAtMs: T0 + 30_000 });
    const live = turnStarted(45);
    const liveness = deriveLiveness(live, ended, T0 + 60_000);
    assert.equal(liveness.state, "unknown");
    assert.equal(liveness.source, "telemetry");
    assert.equal(liveness.turnActive, true);
    assert.match(liveness.detail, /newer turn/);
  });

  it("8. a genuinely new execution after a stop → running again, and a leftover turn from before it is not attributed to it", () => {
    const live = turnStarted(); // the old, interrupted turn at T0+1s
    const fresh = exec({ id: "y", state: "running", startedAtMs: T0 + 120_000 });
    const liveness = deriveLiveness(live, fresh, T0 + 130_000);
    assert.equal(liveness.state, "running");
    assert.equal(liveness.turnActive, false, "the old turn began before this runner; it cannot be its work");
    assert.equal(liveness.live?.stage.busy, false);
    applyEvent(live, { v: 1, ts: at(125), actor: "stage", event: "turn.started" });
    const withTurn = deriveLiveness(live, fresh, T0 + 130_000);
    assert.equal(withTurn.turnActive, true);
    assert.equal(withTurn.live?.stage.busy, true);
  });

  it("9. reactivation with stale unmatched telemetry and no observation → unknown, never running", () => {
    // A reloaded extension replays activity.jsonl into an empty fold and has
    // no execution record yet: exactly case 1, whatever the file says.
    const replayed = foldEvents([
      { v: 1, ts: at(-3600), actor: "loop", event: "loop.started" },
      { v: 1, ts: at(-3599), actor: "stage", event: "turn.started", provider: "claude-cli" },
    ]);
    const liveness = deriveLiveness(replayed, undefined, T0);
    assert.equal(liveness.state, "unknown");
    assert.notEqual(liveness.state, "running");
    assert.equal(blocksLaunch(liveness), "unknown");
  });

  it("9b. reactivation with the hosting terminal found but no way to see inside it → unknown with the platform limitation spelled out", () => {
    const unknown = exec({ source: "launched", state: "unknown", detail: "The terminal survived the reload, but no process probe is available on this platform." });
    const busy = deriveLiveness(turnStarted(), unknown, T0 + 60_000);
    assert.equal(busy.state, "unknown");
    assert.equal(busy.source, "telemetry");
    assert.equal(busy.turnActive, true);
    assert.match(busy.detail, /no process probe/);
    const idle = deriveLiveness(foldEvents([{ v: 1, ts: at(0), actor: "stage", event: "turn.finished" }]), unknown, T0 + 60_000);
    assert.equal(idle.state, "unknown");
    assert.equal(idle.source, "none");
    assert.equal(idle.turnActive, false);
    assert.equal(blocksLaunch(idle), undefined);
  });

  it("10. reactivation with a surviving execution re-established by observation → running (reattached)", () => {
    const reattached = exec({ source: "reattached", state: "running", startedAtMs: T0 - 3_600_000 });
    const liveness = deriveLiveness(turnStarted(), reattached, T0 + 60_000);
    assert.equal(liveness.state, "running");
    assert.equal(liveness.source, "execution");
    assert.match(liveness.detail, /before the window reloaded is still running/);
  });

  it("11. an external, telemetry-only run: activity described, liveness unknown, stale after a long silence", () => {
    const live = turnStarted();
    const soon = deriveLiveness(live, undefined, T0 + 60_000);
    assert.equal(soon.stale, false);
    const later = deriveLiveness(live, undefined, T0 + STALE_ACTIVE_MS + 2000);
    assert.equal(later.state, "unknown", "silence is information, not a death detector");
    assert.equal(later.stale, true);
    assert.equal(later.turnActive, true);
  });

  it("12. a duplicate Run Stage is blocked for a known-alive runner and for an inferred active turn", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const run = selectRun((await discoverRuns([ws.location])).runs).selected;
    assert.equal(stageRunAction(run, deriveLiveness(turnStarted(), exec({ runId: run!.id }), T0)), undefined);
    assert.equal(stageRunAction(run, deriveLiveness(turnStarted(), undefined, T0)), undefined);
    assert.equal(stageRunAction(run, deriveLiveness(turnStarted(), exec({ runId: run!.id, state: "ended", endedAtMs: T0 + 10_000 }), T0 + 20_000))?.label, "Resume stage");
    assert.equal(stageRunAction(run, deriveLiveness(undefined, undefined, T0))?.label, "Run stage");
  });

  it("no telemetry and no observation → unknown with source none; nothing is claimed", () => {
    const liveness = deriveLiveness(undefined, undefined, T0);
    assert.deepEqual([liveness.state, liveness.source, liveness.turnActive, liveness.interrupted, liveness.stale], ["unknown", "none", false, false, false]);
    assert.equal(liveness.live, undefined);
  });

  it("the dedicated-terminal fallback source is running while its terminal lives and ended when it closes", () => {
    const alive = deriveLiveness(turnStarted(), exec({ source: "terminal" }), T0 + 10_000);
    assert.equal(alive.state, "running");
    assert.match(alive.detail, /terminal whose process it is has not closed/);
    const closed = deriveLiveness(turnStarted(), exec({ source: "terminal", state: "ended", endedAtMs: T0 + 20_000, exitCode: 130 }), T0 + 30_000);
    assert.equal(closed.state, "stopped");
    assert.equal(closed.interrupted, true);
  });
});
