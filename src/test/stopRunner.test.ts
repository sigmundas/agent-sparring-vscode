/**
 * Stopping a run interrupts one exact operation, and claims nothing.
 *
 * Stop is the first control in this extension that deliberately reaches out
 * and does something to a running process, so the whole of its safety is in
 * *what it is allowed to aim at* and *what it is allowed to conclude*:
 *
 *  - it aims only at an execution with positive current evidence of being
 *    alive — the terminal it is in, or the pid that was positively bound to
 *    it with the birth time it had when it was seen. Never a process that
 *    merely runs the same command, never a process name, never everything
 *    in the project;
 *  - it concludes nothing. The duplicate guard is exactly where it was
 *    before the click, and only the same evidence that ends any execution
 *    turns "Stop requested" into "Stopped".
 *
 * The process-identity claims are made against real processes and the real
 * `ps`, because a claim about pid reuse cannot be tested against a fake
 * process table that was written to agree with it.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach, after } from "node:test";
import { FakeTerminal, install, reset, until, settle, type FakeShellIntegration } from "./vscodeStub";

const stub = install();

type Registry = import("../vscode/operationRegistry").OperationRegistry;
type Tracker = import("../vscode/executionTracker").ExecutionTracker;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let runnerKey: typeof import("../vscode/operationRegistry").runnerKey;
let listProcesses: typeof import("../vscode/processProbe").listProcesses;
let deriveLiveness: typeof import("../core/liveness").deriveLiveness;

const posix = process.platform !== "win32";

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  runnerKey = registry.runnerKey;
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
  listProcesses = (await import("../vscode/processProbe")).listProcesses;
  deriveLiveness = (await import("../core/liveness")).deriveLiveness;
});

function store(seed: Record<string, unknown> = {}) {
  const kept = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void (value === undefined ? kept.delete(key) : kept.set(key, value)),
  };
}

function pool(shellPid?: number) {
  const acquired: FakeTerminal[] = [];
  return {
    acquired,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, shellPid ?? 8100 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return { terminal, idle: () => true, release: () => undefined, discard: () => undefined, retire: () => undefined };
    },
  };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");
const resolutions = (logged: string[]) => logged.filter((line) => /: resolved as /.test(line));

// ---------------------------------------------------------------------------
// real processes
// ---------------------------------------------------------------------------

const survivors: ChildProcess[] = [];
let workspace: string | undefined;

/** A stand-in engine that goes on working until something really stops it. */
async function engineScript(): Promise<{ dir: string; engine: string; interpreter: string }> {
  if (!workspace) {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-stop-"));
    const engine = path.join(workspace, "sparring");
    await fs.writeFile(engine, ["while true; do", "  sleep 0.2", "done", ""].join("\n"));
    await fs.chmod(engine, 0o755);
    await fs.symlink("/bin/sh", path.join(workspace, "python3"));
  }
  return { dir: workspace, engine: path.join(workspace, "sparring"), interpreter: path.join(workspace, "python3") };
}

function startEngine(where: { dir: string; engine: string; interpreter: string }, args: string[]): ChildProcess {
  const child = spawn(where.interpreter, [where.engine, ...args], { cwd: where.dir, detached: true, stdio: "ignore" });
  child.unref();
  survivors.push(child);
  return child;
}

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const inTheTable = (pid: number) => until(async () => ((await listProcesses()).some((item) => item.pid === pid) ? true : undefined), `pid ${pid} to appear in the process table`);
const generationOf = async (pid: number) => (await listProcesses()).find((item) => item.pid === pid)?.started;

after(async () => {
  for (const child of survivors.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
  if (workspace) {
    await fs.rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

// ---------------------------------------------------------------------------
// a launched, running shell execution
// ---------------------------------------------------------------------------

const options = (cwd: string, runId = `${cwd}|stage:stage-1`) => ({
  configured: process.execPath,
  args: ["run-loop", "stage-1", "--repo-root", cwd],
  cwd,
  repoRoot: cwd,
  name: "run-loop",
  runId,
  kind: "run-loop" as const,
  stageId: "stage-1",
  reveal: false,
});

/** A launch that the shell has reported as started: the ordinary live run. */
async function launchAndStart(kept: ReturnType<typeof store>, logged: string[], dir: string, signalled: number[], runId?: string) {
  const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
  const terminals = pool();
  const tracker: Tracker = new ExecutionTracker(
    { workspaceState: kept } as never,
    (message) => logged.push(message),
    () => [],
    terminals as never,
    registry,
    () => true,
    listProcesses,
    (pid) => signalled.push(pid),
  );
  const launching = tracker.launch(options(dir, runId));
  await waitingForIntegration();
  const integration: FakeShellIntegration = terminals.acquired[0].integrate();
  const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");
  stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
  const result = await launching;
  assert.equal(result.ok, true, "the shell reported it as started");
  return { registry, tracker, terminals, execution };
}

// ---------------------------------------------------------------------------

describe("Stop interrupts one exact operation", () => {
  beforeEach(() => reset());

  it("1+4+6+7. a live run offers Stop, and Stop is a Ctrl-C into that run's own terminal and nothing else", async () => {
    const dir = (await engineScript()).dir;
    const logged: string[] = [];
    const signalled: number[] = [];
    const { registry, tracker, terminals } = await launchAndStart(store(), logged, dir, signalled);
    try {
      const target = tracker.stopTargetFor(options(dir).runId);
      assert.equal(target?.via, "terminal", "the terminal hosting the live execution is the target");
      assert.equal(target?.executionId, tracker.executionFor(options(dir).runId)?.id);

      const outcome = await tracker.requestStop(options(dir).runId, target?.executionId as string);

      assert.deepEqual(outcome, { requested: true, via: "terminal" });
      assert.deepEqual(terminals.acquired[0].written, ["\u0003"], "exactly one interrupt, into that terminal");
      assert.deepEqual(signalled, [], "no process was signalled directly: the terminal is the more exact route");
      // 5: nothing anywhere in this path names a process by name.
      assert.deepEqual(
        logged.filter((line) => /pkill|killall|SIGKILL|-9/.test(line)),
        [],
      );
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("2+8+11. a requested stop is not a stop: the guard stays, no state is touched, and the status says so", async () => {
    const dir = (await engineScript()).dir;
    const logged: string[] = [];
    const runId = options(dir).runId;
    const { registry, tracker } = await launchAndStart(store(), logged, dir, []);
    try {
      const target = tracker.stopTargetFor(runId);
      await tracker.requestStop(runId, target?.executionId as string);

      // 8: nothing about the run was reset, deleted or ended.
      const record = tracker.executionFor(runId);
      assert.equal(record?.state, "running", "the execution is still running until something proves otherwise");
      assert.ok(record?.stopRequestedAtMs, "what changed is that a request was recorded");
      assert.deepEqual(resolutions(logged), [], "and no operation was resolved");

      // 11 + 3: guarded, and visibly so.
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-shell", "the duplicate guard is exactly where it was");
      const refused = await tracker.launch({ ...options(dir), name: "a second run-loop" });
      assert.equal(refused.ok, false, "so a second copy is still refused");

      const liveness = deriveLiveness(undefined, record, Date.now());
      assert.equal(liveness.stop, "requested", "requested, never 'stopped'");
      assert.equal(liveness.state, "running");

      // Asking twice is not offered.
      assert.equal(tracker.stopTargetFor(runId)?.executionId, record?.id, "the target is still resolvable");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("9+10+17. only the execution ending turns a request into Stopped, and an unasked-for ending is not", async () => {
    const dir = (await engineScript()).dir;
    const runId = options(dir).runId;
    const logged: string[] = [];
    const { registry, tracker, terminals } = await launchAndStart(store(), logged, dir, []);
    try {
      const target = tracker.stopTargetFor(runId);
      await tracker.requestStop(runId, target?.executionId as string);
      const terminal = terminals.acquired[0];

      // 12: the terminal merely closing is not the end of anything.
      terminal.close();
      await settle();
      assert.notEqual(tracker.executionFor(runId)?.state, "ended", "a closed terminal settles nothing");
      assert.equal(deriveLiveness(undefined, tracker.executionFor(runId), Date.now()).stop, "requested", "still only a request");
      // 13: and it released no guard.
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-shell");
      assert.deepEqual(resolutions(logged), []);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("9+10. the shell reporting that exact execution ending is what makes it Stopped, and the plan can be resumed", async () => {
    const dir = (await engineScript()).dir;
    const runId = options(dir).runId;
    const logged: string[] = [];
    const { registry, tracker, terminals, execution } = await launchAndStart(store(), logged, dir, []);
    try {
      await tracker.requestStop(runId, tracker.stopTargetFor(runId)?.executionId as string);
      const integration = terminals.acquired[0].shellIntegration as FakeShellIntegration;
      // Exit 130 is what the engine reports for an interruption.
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution, exitCode: 130 });
      await settle();

      const record = tracker.executionFor(runId);
      assert.equal(record?.state, "ended");
      const liveness = deriveLiveness(undefined, record, Date.now());
      assert.equal(liveness.stop, "stopped", "now, and only now, it is stopped");
      assert.equal(liveness.state, "stopped");
      assert.match(liveness.detail, /You stopped this runner and it has ended/);
      assert.match(liveness.detail, /continues from what it had reached/, "and the run is resumable, not reset");
      assert.equal(registry.inFlightFor(runnerKey(runId)), undefined, "the guard is released by that evidence, so Resume is possible");
      assert.equal(tracker.stopTargetFor(runId), undefined, "and there is nothing left to stop");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("17. an ordinary completion is never called Stopped", async () => {
    const dir = (await engineScript()).dir;
    const runId = options(dir).runId;
    const logged: string[] = [];
    const { registry, tracker, terminals, execution } = await launchAndStart(store(), logged, dir, []);
    try {
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: terminals.acquired[0].shellIntegration as FakeShellIntegration, execution, exitCode: 0 });
      await settle();
      const liveness = deriveLiveness(undefined, tracker.executionFor(runId), Date.now());
      assert.equal(liveness.stop, undefined, "nobody asked for a stop, so nothing is called one");
      assert.match(liveness.detail, /exited normally/);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("16. another run's Stop is refused: ids are checked, not just the run", async () => {
    const dir = (await engineScript()).dir;
    const logged: string[] = [];
    const { registry, tracker } = await launchAndStart(store(), logged, dir, []);
    try {
      const mine = tracker.executionFor(options(dir).runId)?.id as string;
      // A panel from another repository's run, or an execution that has
      // since been replaced: neither may reach this one.
      assert.equal((await tracker.requestStop("/somewhere/else|stage:stage-1", mine)).requested, false, "that execution does not belong to that run");
      assert.equal((await tracker.requestStop(options(dir).runId, "999-999")).requested, false, "and no such execution exists for this one");
      assert.equal(tracker.executionFor(options(dir).runId)?.stopRequestedAtMs, undefined, "nothing was recorded against the live runner");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// process identity, against real processes
// ---------------------------------------------------------------------------

describe("Stop after a reload signals only a process it can still prove is the right one", () => {
  beforeEach(() => reset());

  /**
   * The state a reload leaves for a dedicated runner: the terminal object is
   * gone, the pid and its birth time are on the record. `reattach` re-finds
   * it, and from then on the pid is what the run is.
   */
  async function restored(pid: number, generation: string | undefined, signalled: number[], logged: string[], dir: string, transport: "dedicated-terminal" | "shell" = "dedicated-terminal") {
    const runId = options(dir).runId;
    const kept = store({
      "agentSparring.launches": [
        {
          id: "1700000000000-1",
          runId,
          kind: "run-loop",
          stageId: "stage-1",
          repoRoot: dir,
          transport,
          source: transport === "dedicated-terminal" ? "terminal" : "launched",
          startedAtMs: Date.now() - 60_000,
          terminalPid: pid,
          terminalName: "Agent Sparring — run-loop",
          state: "running",
          enginePid: transport === "dedicated-terminal" ? pid : undefined,
          generation,
        },
      ],
    });
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    const tracker: Tracker = new ExecutionTracker(
      { workspaceState: kept } as never,
      (message) => logged.push(message),
      () => [],
      pool() as never,
      registry,
      () => true,
      listProcesses,
      (signal) => signalled.push(signal),
    );
    await tracker.reattach();
    return { registry, tracker, runId };
  }

  it("14. a restored run whose exact pid and generation still check out can be stopped, by signalling that pid alone", async (t) => {
    if (!posix) {
      t.skip("process identity is established through POSIX ps");
      return;
    }
    const where = await engineScript();
    const child = startEngine(where, ["run-loop", "stage-1", "--repo-root", where.dir]);
    await inTheTable(child.pid as number);
    const signalled: number[] = [];
    const logged: string[] = [];
    const { registry, tracker, runId } = await restored(child.pid as number, await generationOf(child.pid as number), signalled, logged, where.dir);
    try {
      await until(() => (tracker.executionFor(runId)?.state === "running" ? true : undefined), "the restored run to be re-established as alive");
      const target = tracker.stopTargetFor(runId);
      assert.equal(target?.via, "process", "no terminal object survived the reload; the pid did");

      const outcome = await tracker.requestStop(runId, target?.executionId as string);

      assert.deepEqual(outcome, { requested: true, via: "process" });
      assert.deepEqual(signalled, [child.pid], "exactly that pid, and no other");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("15. a restored run with no recorded generation is never signalled: a pid alone is not an identity", async (t) => {
    if (!posix) {
      t.skip("process identity is established through POSIX ps");
      return;
    }
    const where = await engineScript();
    const child = startEngine(where, ["run-loop", "stage-1", "--repo-root", where.dir]);
    await inTheTable(child.pid as number);
    const signalled: number[] = [];
    const logged: string[] = [];
    // The pid is right and the process is alive — and it still may not be
    // signalled, because nothing recorded can tell it from a reused pid.
    const { registry, tracker, runId } = await restored(child.pid as number, undefined, signalled, logged, where.dir);
    try {
      await until(() => (tracker.executionFor(runId)?.state === "running" ? true : undefined), "the restored run to be re-established as alive");
      assert.equal(tracker.stopTargetFor(runId), undefined, "so no Stop is offered");
      const outcome = await tracker.requestStop(runId, tracker.executionFor(runId)?.id as string);
      assert.equal(outcome.requested, false);
      assert.equal(outcome.requested === false && outcome.reason, "no-target");
      assert.deepEqual(signalled, [], "and nothing at all was signalled");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("15. a recorded pid that now holds a different process is not signalled", async (t) => {
    if (!posix) {
      t.skip("process identity is established through POSIX ps");
      return;
    }
    const where = await engineScript();
    const child = startEngine(where, ["run-loop", "stage-1", "--repo-root", where.dir]);
    await inTheTable(child.pid as number);
    const signalled: number[] = [];
    const logged: string[] = [];
    // A birth time that is not this process's: what pid reuse looks like.
    const { registry, tracker, runId } = await restored(child.pid as number, "Thu Jan  1 00:00:00 2015", signalled, logged, where.dir);
    try {
      const outcome = await tracker.requestStop(runId, tracker.executionFor(runId)?.id as string);
      assert.equal(outcome.requested, false, "the pid is live, and it is not ours");
      assert.deepEqual(signalled, [], "so it is left strictly alone");
      assert.ok(alive(child.pid), "and the real process is untouched");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("a run whose fate is unknown offers no Stop at all, and nothing is guessed at", async (t) => {
    if (!posix) {
      t.skip("process identity is established through POSIX ps");
      return;
    }
    const where = await engineScript();
    // A real process running this run's command line, so the table is not
    // empty: an unknown run must not reach for it. Nothing ties it to this
    // hand-over, and a matching command line is not an identity.
    const lookAlike = startEngine(where, ["run-loop", "stage-1", "--repo-root", where.dir]);
    await inTheTable(lookAlike.pid as number);
    const signalled: number[] = [];
    const logged: string[] = [];
    // A shell launch whose terminal never came back and whose engine was
    // never bound to a pid: the honest answer is unknown.
    const { registry, tracker, runId } = await restored(999_999, undefined, signalled, logged, where.dir, "shell");
    try {
      const record = tracker.executionFor(runId);
      assert.notEqual(record?.state, "running", "nothing established that it is alive");
      assert.equal(tracker.stopTargetFor(runId), undefined, "so there is nothing it may aim at");
      const outcome = await tracker.requestStop(runId, record?.id as string);
      assert.equal(outcome.requested, false);
      assert.match(outcome.requested === false ? outcome.detail : "", /cannot determine|cannot identify|nothing it can safely interrupt/);
      assert.deepEqual(signalled, [], "and the look-alike process was left strictly alone");
      assert.ok(alive(lookAlike.pid), "it is still running");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});
