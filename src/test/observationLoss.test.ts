/**
 * Loss of observation is not termination evidence.
 *
 * Seven ways the extension used to remove duplicate protection without ever
 * establishing that anything had ended. They are not seven unrelated bugs:
 * each one takes a change in what this window can *see* and reads it as a
 * change in what is *running*.
 *
 *  1. **A closed terminal ended a running shell operation.** Real VS Code
 *     testing showed a HUP- and TERM-resistant engine process going on
 *     working after `terminal.dispose()`; the pty goes, the process does not.
 *  2. **A closed terminal ended a dedicated runner.** Same fact, other
 *     transport: the process belongs to the pty host and can survive it.
 *  3. **Another foreground command ended a running shell operation.**
 *     `^Z` then `bg` leaves the engine running and the shell free, so the
 *     next command typed there — even `true` — released the guard while the
 *     engine worked.
 *  4. **The final occupancy check happened before two awaits.** A terminal
 *     that was idle when it was acquired could be the person's by the time
 *     the command line was written into it.
 *  5. **A direct process was reconciled against semantics it never had.**
 *     `sparring new-stage s` identifies its repository by cwd and is given no
 *     `--repo-root`, so demanding one in its command line declared a live
 *     process gone.
 *  6. **A matcher's "I cannot attribute this" was read as "it ended".** A
 *     relative `--repo-root .` cannot be compared against anything `ps`
 *     prints, and a live runner launched that way was declared dead.
 *  7. **The same for a dedicated runner** whose command line could not be
 *     recognised at all.
 *
 * And one upgrade path: a dedicated runner whose only safety record was the
 * old `agentSparring.launches` entry was not known to the admission
 * authority at all, so the first command after the upgrade was admitted over
 * a live runner.
 *
 * These tests use real processes wherever the claim is about a process: a
 * stand-in engine script that ignores SIGHUP and SIGTERM, found through the
 * real `ps`. What is faked is only what VS Code would report.
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
type Runner = import("../vscode/commandRunner").SparringCommandRunner;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let SparringCommandRunner: typeof import("../vscode/commandRunner").SparringCommandRunner;
let commandKey: typeof import("../vscode/operationRegistry").commandKey;
let runnerKey: typeof import("../vscode/operationRegistry").runnerKey;
let OPERATION_RESOLUTIONS: typeof import("../vscode/operationRegistry").OPERATION_RESOLUTIONS;
let OPERATIONS_KEY: string;
let listProcesses: typeof import("../vscode/processProbe").listProcesses;

const LAUNCHES_KEY = "agentSparring.launches";
const posix = process.platform !== "win32";

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  commandKey = registry.commandKey;
  runnerKey = registry.runnerKey;
  OPERATION_RESOLUTIONS = registry.OPERATION_RESOLUTIONS;
  OPERATIONS_KEY = registry.OPERATIONS_KEY;
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
  SparringCommandRunner = (await import("../vscode/commandRunner")).SparringCommandRunner;
  listProcesses = (await import("../vscode/processProbe")).listProcesses;
});

interface Store {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

/** Workspace state, which is the only thing a window reload leaves behind. */
function store(seed: Record<string, unknown> = {}): Store {
  const kept = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void (value === undefined ? kept.delete(key) : kept.set(key, value)),
    keys: () => [...kept.keys()],
  };
}

/**
 * The terminal pool's contract as these tests need it, including `idle()` —
 * the synchronous occupancy check the hand-over makes with nothing awaited
 * after it. `occupy` is how a test makes a terminal the person's at an exact
 * moment.
 */
function pool(): {
  acquire: (cwd: string) => unknown;
  acquired: FakeTerminal[];
  retired: FakeTerminal[];
  discarded: FakeTerminal[];
  occupy: (terminal: FakeTerminal) => void;
} {
  const acquired: FakeTerminal[] = [];
  const retired: FakeTerminal[] = [];
  const discarded: FakeTerminal[] = [];
  const occupied = new Set<FakeTerminal>();
  return {
    acquired,
    retired,
    discarded,
    occupy: (terminal) => occupied.add(terminal),
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, 8100 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return {
        terminal,
        idle: () => !occupied.has(terminal),
        release: () => undefined,
        discard: () => discarded.push(terminal),
        retire: () => retired.push(terminal),
      };
    },
  };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");
/** How many times a resolution was logged: a guard must never resolve without evidence. */
const resolutions = (logged: string[]) => logged.filter((line) => /: resolved as /.test(line));

// ---------------------------------------------------------------------------
// a real engine stand-in
// ---------------------------------------------------------------------------

const survivors: ChildProcess[] = [];
let workspace: string | undefined;

/**
 * A stand-in for the engine that behaves like the one the reviewer
 * reproduced with: it ignores SIGHUP and SIGTERM and keeps working, writing a
 * heartbeat, so "the terminal closed" and "the process ended" are
 * observably different things.
 */
async function engineScript(): Promise<{ dir: string; engine: string; interpreter: string }> {
  if (!workspace) {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-observation-"));
    const engine = path.join(workspace, "sparring");
    await fs.writeFile(engine, ['trap "" HUP TERM', "while true; do", `  echo "alive $$" >> "$(dirname "$0")/heartbeat.log"`, "  sleep 0.2", "done", ""].join("\n"));
    await fs.chmod(engine, 0o755);
    // The shape `ps` reports for a real venv console script: the interpreter,
    // then the script path, then the engine's own arguments. Attribution has
    // to work on that shape, so the stand-in is run that way rather than
    // through a shebang — which `ps` would report as `/bin/sh <script> …`,
    // a shape the parser deliberately does not accept as an invocation.
    await fs.symlink("/bin/sh", path.join(workspace, "python3"));
  }
  return { dir: workspace, engine: path.join(workspace, "sparring"), interpreter: path.join(workspace, "python3") };
}

/**
 * Start the stand-in with exactly `args`, as a process nothing in this window
 * owns. Returns the child and the invocation `ps` will show for it.
 */
function startEngine(where: { dir: string; engine: string; interpreter: string }, args: string[]): { child: ChildProcess; word: string; args: string[] } {
  const argv = [where.engine, ...args];
  const child = spawn(where.interpreter, argv, { cwd: where.dir, detached: true, stdio: "ignore" });
  child.unref();
  survivors.push(child);
  return { child, word: where.interpreter, args: argv };
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

/** Wait for the real process table to hold this pid, so a probe can see it. */
const inTheTable = (pid: number) => until(async () => ((await listProcesses()).some((item) => item.pid === pid) ? true : undefined), `pid ${pid} to appear in the process table`);

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
// the transition table
// ---------------------------------------------------------------------------

describe("the resolution table distinguishes lost observation from a finished process", () => {
  it("a closed terminal settles only a command that was never observed started", () => {
    const closures = OPERATION_RESOLUTIONS.filter((transition) => transition.evidence === "terminal-closed");
    assert.deepEqual(
      closures.map((transition) => transition.from),
      ["submitted-shell"],
      "the shell that held a queued line being gone is evidence about that line; a closed terminal under a running process is not",
    );
    assert.equal(closures[0].outcome, "cannot-execute");
  });

  it("no resolution rests on another command starting in the same terminal", () => {
    assert.deepEqual(
      OPERATION_RESOLUTIONS.filter((transition) => /superseded|foreground/i.test(`${transition.evidence} ${transition.proves}`)),
      [],
      "a shell taking another foreground command says nothing about a process that was backgrounded",
    );
  });

  it("every process resolution names an absence or an exit, never a failure to recognise", () => {
    const processEvidence = OPERATION_RESOLUTIONS.filter((transition) => /-process-gone|process-exited/.test(transition.evidence));
    assert.ok(processEvidence.length >= 4, "direct, dedicated and shell all resolve on process facts");
    for (const transition of processEvidence) {
      assert.match(transition.proves, /no longer in the process table|absent from the process table|no longer exists|different birth time|has exited/, `${transition.evidence} rests on a fact about a process`);
      assert.doesNotMatch(transition.proves, /cannot be recognised|unattributable|matcher/i, `${transition.evidence} does not rest on attribution failing`);
    }
  });
});

// ---------------------------------------------------------------------------
// 1 + 2: a terminal closing under a started operation
// ---------------------------------------------------------------------------

describe("a process that survives its terminal keeps its guard", () => {
  beforeEach(() => reset());

  const options = (cwd: string) => ({
    configured: process.execPath,
    args: ["run-loop", "stage-1", "--repo-root", cwd],
    cwd,
    repoRoot: cwd,
    name: "run-loop",
    runId: `${cwd}|stage:stage-1`,
    kind: "run-loop" as const,
    stageId: "stage-1",
    reveal: false,
  });

  it("1. a running shell operation is not ended by terminal.dispose(), and a duplicate is refused", async (t) => {
    if (!posix) {
      t.skip("the engine stand-in is a POSIX shell script");
      return;
    }
    const where = await engineScript();
    const dir = where.dir;
    const logged: string[] = [];
    const kept = store();
    // The engine the shell started, as a real process that ignores the
    // hangup a closing pty sends.
    const { child } = startEngine(where, ["run-loop", "stage-1", "--repo-root", dir]);
    await inTheTable(child.pid as number);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => true, listProcesses);
    const key = runnerKey(options(dir).runId);
    try {
      const launching = tracker.launch(options(dir));
      await waitingForIntegration();
      const integration: FakeShellIntegration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      assert.equal((await launching).ok, true, "the shell reported it as started");
      assert.equal(registry.inFlightFor(key)?.state, "running-shell");

      // The terminal goes away without an exit code — exactly what closing a
      // terminal whose process ignores the hangup looks like.
      terminals.acquired[0].close();
      await settle();

      assert.ok(alive(child.pid), "the engine process is still running, which is the whole point");
      const held = registry.inFlightFor(key);
      assert.equal(held?.state, "running-shell", "the operation is still guarded: nothing about that process was established");
      assert.equal(held?.observationLost, true, "what was lost is the observation, and the record says so");
      assert.deepEqual(resolutions(logged), [], "and nothing was resolved");

      const refused = await tracker.launch({ ...options(dir), name: "run-loop (after the terminal closed)" });
      assert.equal(refused.ok, false, "so a second run-loop for that run is refused");
      assert.match(refused.ok ? "" : refused.error, /same engine operation twice|no longer active/);
      assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");
      assert.ok(refused.ok ? false : refused.submission, "and the person is offered the explicit way out");
      assert.equal(stub.window.created.length, 0, "nothing was started");

      // The process table can still settle it, and it is the only thing that
      // does: first it finds the process, then the process is gone.
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key)?.state, "running-shell", "a live engine process keeps it guarded");
      process.kill(child.pid as number, "SIGKILL");
      await until(async () => {
        await registry.probeAll();
        return registry.inFlightFor(key) === undefined ? true : undefined;
      }, "the guard to be released once that process is really gone");
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("2. a dedicated runner's process is not ended by terminal.dispose() either", async (t) => {
    if (!posix) {
      t.skip("the engine stand-in is a POSIX shell script");
      return;
    }
    const where = await engineScript();
    const dir = where.dir;
    const logged: string[] = [];
    const kept = store();
    // The dedicated terminal's process *is* the engine; the fake terminal
    // reports the pid of the real one.
    const { child } = startEngine(where, ["run-loop", "stage-1", "--repo-root", dir]);
    await inTheTable(child.pid as number);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => true, listProcesses);
    const key = runnerKey(options(dir).runId);
    try {
      stub.window.nextTerminalPid = child.pid as number;
      const launching = tracker.launch(options(dir));
      await waitingForIntegration();
      terminals.acquired[0].dispose(); // no shell integration: the dedicated route
      const result = await launching;
      assert.equal(result.ok && result.via, "terminal", "it ran in a dedicated terminal");
      const dedicated = stub.window.terminals[stub.window.terminals.length - 1];
      await until(() => (registry.inFlightFor(key)?.terminalPid === child.pid ? true : undefined), "the dedicated terminal's pid to be recorded");

      dedicated.close(); // the terminal goes, with no exit status for the process
      await settle();

      assert.ok(alive(child.pid), "the process outlived its terminal");
      assert.equal(registry.inFlightFor(key)?.state, "running-dedicated", "so the operation is still guarded");
      assert.equal(registry.inFlightFor(key)?.observationLost, true);
      assert.deepEqual(resolutions(logged), [], "nothing was resolved by the terminal going away");

      const refused = await tracker.launch({ ...options(dir), name: "run-plan (after the dedicated terminal closed)" });
      assert.equal(refused.ok, false, "and a duplicate is refused");
      assert.equal(stub.window.created.length, 1, "no second dedicated terminal was created");

      process.kill(child.pid as number, "SIGKILL");
      await until(async () => {
        await registry.probeAll();
        return registry.inFlightFor(key) === undefined ? true : undefined;
      }, "the guard to be released once that process is gone");
      assert.match(resolutions(logged)[0], /resolved as completed \(dedicated-process-gone\)/);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("3. a backgrounded operation is not ended by the next foreground command", async (t) => {
    if (!posix) {
      t.skip("the engine stand-in is a POSIX shell script");
      return;
    }
    // The reviewer's sequence: the engine runs, is suspended, is put in the
    // background, and a trivial `true` becomes the shell's next foreground
    // command. The shell's foreground relationship changed; the engine did
    // not stop.
    const where = await engineScript();
    const dir = where.dir;
    const logged: string[] = [];
    const kept = store();
    const { child } = startEngine(where, ["run-loop", "stage-1", "--repo-root", dir]);
    await inTheTable(child.pid as number);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => true, listProcesses);
    const key = runnerKey(options(dir).runId);
    try {
      const launching = tracker.launch(options(dir));
      await waitingForIntegration();
      const integration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      await launching;

      const heartbeat = path.join(dir, "heartbeat.log");
      const before = (await fs.readFile(heartbeat, "utf8").catch(() => "")).length;

      // ^Z, bg, and then `true` in the same terminal.
      const next = integration.executeCommand("true");
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution: next });
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution: next, exitCode: 0 });
      await settle();

      assert.ok(alive(child.pid), "the engine process is still alive after the new foreground command");
      await until(async () => ((await fs.readFile(heartbeat, "utf8").catch(() => "")).length > before ? true : undefined), "the backgrounded engine to go on working");
      assert.equal(registry.inFlightFor(key)?.state, "running-shell", "and its guard remains");
      assert.equal(tracker.executionFor(options(dir).runId)?.state, "unknown", "liveness says it cannot tell, rather than claiming the runner stopped");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved as shell-superseded, because no such evidence exists");

      const refused = await tracker.launch({ ...options(dir), name: "run-loop (after the foreground changed)" });
      assert.equal(refused.ok, false, "a retry is refused while it may still be running");
      assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 4: the occupancy race around an awaited arm()
// ---------------------------------------------------------------------------

describe("a terminal that became the person's while the intent was being persisted is left alone", () => {
  beforeEach(() => reset());

  it("4. nothing whatever is written into it, and another idle terminal is used", async () => {
    const cwd = path.join(os.tmpdir(), "agent-sparring-occupancy");
    const runId = `${cwd}|stage:stage-1`;
    const logged: string[] = [];
    const terminals = pool();
    // The person starts an interactive Python in that terminal in the window
    // between "this terminal is idle" and "here is the command line": the
    // durable record of the intent is being awaited, and awaiting is exactly
    // what gives them the time.
    const kept = store();
    let armed = false;
    const delayedArm: Store = {
      get: kept.get,
      update: async (key, value) => {
        if (!armed && Array.isArray(value) && value.some((item) => (item as { key?: string }).key === runnerKey(runId))) {
          armed = true;
          terminals.occupy(terminals.acquired[0]);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await kept.update(key, value);
      },
      keys: kept.keys,
    };
    const registry: Registry = new OperationRegistry({ workspaceState: delayedArm } as never, (message: string) => logged.push(message), () => false, async () => []);
    const tracker: Tracker = new ExecutionTracker({ workspaceState: store() } as never, (message) => logged.push(message), () => [], terminals as never, registry);
    try {
      const launching = tracker.launch({
        configured: process.execPath,
        args: ["run-loop", "stage-1", "--repo-root", cwd],
        cwd,
        repoRoot: cwd,
        name: "run-loop",
        runId,
        kind: "run-loop",
        stageId: "stage-1",
        reveal: false,
      });
      await waitingForIntegration();
      const first = terminals.acquired[0];
      const firstIntegration = first.integrate();
      // The second terminal is acquired because the first is no longer idle;
      // it needs its own shell integration.
      await until(() => (terminals.acquired.length > 1 ? true : undefined), "another terminal to be acquired");
      const second = terminals.acquired[1];
      const secondIntegration = second.integrate();
      const execution = await until(() => second.executions[0], "the command to be handed to the idle terminal");
      stub.window.startEmitter.fire({ terminal: second, shellIntegration: secondIntegration, execution });
      const result = await launching;

      assert.deepEqual(firstIntegration.executed, [], "absolutely nothing was written into the terminal the person was using");
      assert.deepEqual(first.executions, [], "not one execution was started in it");
      assert.equal(first.exitStatus, undefined, "and it was not closed or interrupted either — whatever they started is still theirs");
      assert.deepEqual(terminals.retired, [first], "it was only retired from reuse");
      assert.equal(secondIntegration.executed.length, 1, "the command went to a genuinely idle terminal");
      assert.equal(result.ok, true, "and the operation ran, once");
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-shell", "under the same operation identity that was armed before any of this");
      assert.ok(logged.some((line) => /no longer idle/.test(line)), `and the log says what happened, got ${JSON.stringify(logged)}`);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 5 + 6 + 7: reconciliation that cannot conclude
// ---------------------------------------------------------------------------

describe("a live process that cannot be positively attributed stays guarded", () => {
  beforeEach(() => reset());

  it("5. a restored `new-stage` is recognised by its actual invocation, which carries no --repo-root", async (t) => {
    if (!posix) {
      t.skip("the engine stand-in is a POSIX shell script");
      return;
    }
    const where = await engineScript();
    const dir = where.dir;
    const logged: string[] = [];
    // `sparring new-stage s` identifies its repository by the working
    // directory and is given no --repo-root at all. Requiring one in its
    // command line is what declared this live process gone.
    const { child, word, args } = startEngine(where, ["new-stage", "s"]);
    await inTheTable(child.pid as number);
    const key = commandKey(dir, "new-stage", "s");
    const kept = store({
      [OPERATIONS_KEY]: [
        {
          id: "operation-from-the-previous-window",
          key,
          state: "running-direct",
          transport: "direct-process",
          caller: "command",
          label: "new-stage s",
          repoRoot: dir,
          cwd: dir,
          subcommand: "new-stage",
          stageId: "s",
          submittedAtMs: Date.now() - 3000,
          direct: { pid: child.pid, word, args, cwd: dir },
        },
      ],
    });
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key)?.state, "running-direct", "the recorded pid is alive and its invocation is recognisable, so the operation is still running");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved by the absence of a flag it never took");

      const refused = await runner.run({ configured: where.engine, args: ["new-stage", "s"], cwd: dir, name: "new-stage", operation: { subcommand: "new-stage", target: "s" } });
      assert.equal(refused.ok, false, "so a second new-stage is refused");
      assert.equal(terminals.acquired.length, 0, "and nothing was prepared for it");

      // Its ending is the only thing that releases it.
      process.kill(child.pid as number, "SIGKILL");
      await until(async () => {
        await registry.probeAll();
        return registry.inFlightFor(key) === undefined ? true : undefined;
      }, "the guard to be released once that process has really gone");
      assert.match(resolutions(logged)[0], /resolved as completed \(direct-process-gone\)/);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });

  it("6. a live shell runner with a relative --repo-root stays guarded", async (t) => {
    if (!posix) {
      t.skip("the engine stand-in is a POSIX shell script");
      return;
    }
    const where = await engineScript();
    const dir = where.dir;
    const logged: string[] = [];
    // `--repo-root .` cannot be resolved by anything reading a process table:
    // `ps` reports no working directory. The matcher therefore cannot
    // attribute this process — which is not the same as it not being there.
    const { child } = startEngine(where, ["run-loop", "stage-9", "--repo-root", "."]);
    await inTheTable(child.pid as number);
    const runId = `${dir}|stage:stage-9`;
    const kept = store({
      [OPERATIONS_KEY]: [
        {
          id: "operation-with-a-relative-root",
          key: runnerKey(runId),
          state: "running-shell",
          transport: "shell",
          caller: "runner",
          label: "run-loop stage-9",
          repoRoot: dir,
          cwd: dir,
          subcommand: "run-loop",
          runId,
          runnerKind: "run-loop",
          stageId: "stage-9",
          submittedAtMs: Date.now() - 5000,
          terminalPid: 1,
          terminalName: "Agent Sparring — relative",
        },
      ],
    });
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: store() } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => true, listProcesses);
    try {
      registry.restore();
      await registry.probeAll();
      assert.ok(alive(child.pid), "the runner is in fact still working");
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-shell", "and the operation stays guarded");
      assert.deepEqual(resolutions(logged), [], "a matcher that cannot attribute a process has established nothing");
      assert.ok(
        logged.some((line) => /attribution failure|positively attributed|positively identify/.test(line)),
        `the log says the answer was inconclusive, got ${JSON.stringify(logged)}`,
      );

      const refused = await tracker.launch({
        configured: process.execPath,
        args: ["run-loop", "stage-9", "--repo-root", dir],
        cwd: dir,
        repoRoot: dir,
        name: "run-loop",
        runId,
        kind: "run-loop",
        stageId: "stage-9",
        reveal: false,
      });
      assert.equal(refused.ok, false, "so a second runner is refused");
      assert.ok(refused.ok ? false : refused.submission, "and only the person can settle it");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("7. a live dedicated runner whose command line cannot be recognised stays guarded", async (t) => {
    if (!posix) {
      t.skip("this test needs a real process table");
      return;
    }
    const logged: string[] = [];
    // A process this window recorded as the dedicated runner's, running
    // something the parser cannot read as a sparring invocation at all — a
    // wrapper, a shim, a `ps` spelling nobody anticipated.
    const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    child.unref();
    survivors.push(child);
    await inTheTable(child.pid as number);
    const cwd = path.join(os.tmpdir(), "agent-sparring-unrecognisable");
    const runId = `${cwd}|plan:foo-abcd1234`;
    const kept = store({
      [OPERATIONS_KEY]: [
        {
          id: "operation-unrecognisable",
          key: runnerKey(runId),
          state: "running-dedicated",
          transport: "dedicated-terminal",
          caller: "runner",
          label: "run-plan foo.manifest.json",
          repoRoot: cwd,
          cwd,
          subcommand: "run-plan",
          runId,
          runnerKind: "run-plan",
          manifest: `${cwd}/foo.manifest.json`,
          submittedAtMs: Date.now() - 5000,
          terminalPid: child.pid,
          terminalName: "Agent Sparring — run-plan",
        },
      ],
    });
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, listProcesses);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-dedicated", "an unrecognisable live pid is not a dead runner");
      assert.deepEqual(resolutions(logged), [], "and nothing was resolved");

      // Only the process actually going away settles it.
      process.kill(child.pid as number, "SIGKILL");
      await until(async () => {
        await registry.probeAll();
        return registry.inFlightFor(runnerKey(runId)) === undefined ? true : undefined;
      }, "the guard to be released once that pid is gone");
      assert.match(resolutions(logged)[0], /resolved as completed \(dedicated-process-gone\)/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 8: the legacy dedicated-launch guard
// ---------------------------------------------------------------------------

describe("a dedicated runner recorded by an earlier version is imported into the one admission authority", () => {
  beforeEach(() => reset());

  const cwd = "/code/repo-one";
  const runId = `${cwd}|plan:foo-abcd1234`;
  const manifest = `${cwd}/.sparring/manifests/foo.manifest.json`;
  /** The persisted shape of that older branch: a launch record and no operation record at all. */
  const legacy = () => ({
    [LAUNCHES_KEY]: [
      {
        id: "1789463594979-1",
        runId,
        kind: "run-plan",
        manifest,
        repoRoot: cwd,
        transport: "dedicated-terminal",
        source: "terminal",
        startedAtMs: Date.now() - 60_000,
        terminalPid: 4242,
        terminalName: "Agent Sparring — run-plan",
      },
    ],
  });

  const options = {
    configured: process.execPath,
    args: ["run-plan", "--manifest", manifest, "--repo-root", cwd],
    cwd,
    repoRoot: cwd,
    name: "run-plan",
    runId,
    kind: "run-plan" as const,
    manifest,
    reveal: false,
  };

  it("8. the new launch is refused, and the import happens exactly once however often the window reloads", async () => {
    const logged: string[] = [];
    const kept = store(legacy());
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => false, async () => []);
    try {
      const restored = registry.restore();
      assert.deepEqual(
        restored.map((item) => [item.key, item.state, item.transport]),
        [[runnerKey(runId), "running-dedicated", "dedicated-terminal"]],
        "the unresolved legacy dedicated launch is a guarded operation before anything can be admitted",
      );
      // Restoring is called again by the reattach that used to be its only
      // caller; doing it twice must not manufacture a second record.
      assert.equal(registry.restore().length, 1, "and restoring again changes nothing");

      const refused = await tracker.launch(options);
      assert.equal(refused.ok, false, "a new run-plan for that run is refused");
      assert.match(refused.ok ? "" : refused.error, /same engine operation twice/);
      assert.equal(stub.window.created.length, 0, "and nothing was started");
      assert.equal(terminals.acquired.length, 0, "not even a terminal was acquired");
      assert.ok(logged.some((line) => /earlier version of this extension/.test(line)), `the log says where the record came from, got ${JSON.stringify(logged)}`);
    } finally {
      tracker.dispose();
      registry.dispose();
    }

    // The next reload finds it under the operations key, imports nothing, and
    // still refuses: one record, not two.
    reset();
    const second: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const secondPool = pool();
    const secondTracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], secondPool as never, second, () => false, async () => []);
    try {
      const restored = second.restore();
      assert.equal(restored.length, 1, "exactly one record after the second reload");
      assert.equal(restored[0].state, "running-dedicated");
      assert.equal((kept.get<unknown[]>(OPERATIONS_KEY, [])).length, 1, "and one persisted record, not a growing pile of them");
      assert.equal((await secondTracker.launch({ ...options, name: "run-plan (second reload)" })).ok, false, "still refused");
    } finally {
      secondTracker.dispose();
      second.dispose();
    }
  });

  it("does not invent a guard for a legacy launch that was already observed ending", async () => {
    const logged: string[] = [];
    const ended = legacy();
    ended[LAUNCHES_KEY][0] = { ...ended[LAUNCHES_KEY][0], ended: { atMs: Date.now() - 30_000, exitCode: 0 } } as never;
    const kept = store(ended);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    try {
      assert.deepEqual(registry.restore(), [], "a launch that was seen to end is not a duplicate risk");
    } finally {
      registry.dispose();
    }
  });
});
