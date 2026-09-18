/**
 * A `running-shell` operation whose process was never identified may not
 * adopt a look-alike.
 *
 * The repair of "a shell that was given a command may already have run it"
 * made `submitted-shell` bind a process only under the live shell that took
 * the line. `running-shell` kept a whole-table search, and a review of the
 * same branch reproduced the harm end to end:
 *
 *  1. a shell execution genuinely starts;
 *  2. the operation becomes `running-shell` on the shell's own start event —
 *     which binds no pid, because a start event is not a process lookup;
 *  3. the window reloads, so the record comes back with `enginePid`
 *     undefined. **That is the ordinary case, not an edge case;**
 *  4. the probe searches the whole process table for the operation's command
 *     line. The real engine is not matchable; one unrelated process is;
 *  5. that stranger's pid is recorded as this operation's `enginePid`;
 *  6. the stranger exits, and `engine-process-gone` releases the guard;
 *  7. the real engine is still running, and a duplicate is admitted.
 *
 * Uniqueness is not identity, recency is not identity, a matching cwd is not
 * identity, and a single matching process elsewhere in the table is not
 * identity. The only causal tie between a row in a process table and a
 * particular `executeCommand` is ancestry under the shell that call was made
 * against, readable only while that shell is alive. So a pidless
 * `running-shell` binds a pid under exactly the rule a submitted command
 * does, and otherwise stays `running-shell`, guarded, with a person's
 * override of that exact operation id as the way out.
 *
 * The other half of the rule is the asymmetry: an identity bound *before*
 * observation was lost is still followed afterwards, by pid and birth-time
 * generation, through the shell dying and the engine being reparented (F).
 *
 * The sibling cases for `submitted-shell` are in
 * src/test/processSimilarityIsNotIdentity.test.ts; what differs between the
 * two states is not the binding rule but what is known without a pid — a
 * submitted command may never have run, while this one certainly did.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import type { ProcessInfo } from "../core/processTree";
import { FakeTerminal, install, reset, until, type FakeShellIntegration } from "./vscodeStub";

const stub = install();

type Registry = import("../vscode/operationRegistry").OperationRegistry;
type Tracker = import("../vscode/executionTracker").ExecutionTracker;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let admissionRefusal: typeof import("../vscode/operationRegistry").admissionRefusal;
let runnerKey: typeof import("../vscode/operationRegistry").runnerKey;
let OPERATIONS_KEY: string;

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  admissionRefusal = registry.admissionRefusal;
  runnerKey = registry.runnerKey;
  OPERATIONS_KEY = registry.OPERATIONS_KEY;
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
});

interface Store {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

/** Workspace state, which is all a window reload leaves behind. */
function store(seed: Record<string, unknown> = {}): Store {
  const kept = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void (value === undefined ? kept.delete(key) : kept.set(key, value)),
    keys: () => [...kept.keys()],
  };
}

/** Every resolution logged. A guard released without evidence shows up here. */
const resolutions = (logged: string[]) => logged.filter((line) => /: resolved as /.test(line));

/** A birth time in the exact shape `ps -o lstart=` prints. */
function psStart(atMs: number): string {
  const at = new Date(atMs);
  const [weekday, month, day] = at.toDateString().split(" ");
  return `${weekday} ${month} ${day} ${at.toTimeString().slice(0, 8)} ${at.getFullYear()}`;
}

const repo = path.join(os.tmpdir(), "agent-sparring-restored-running-shell");
const engineWord = "/venv/bin/sparring";
/**
 * Case A goes through the production launch path, which resolves the
 * executable before it hands anything to a shell, so that one has to be a
 * real file. It is recognised through the recorded invocation rather than
 * through the command-line parser, which only accepts an executable named
 * `sparring` — both matchers are exercised across these cases.
 */
const launchWord = process.execPath;
const stage = "stage-9-restored-running-shell";
const loopArgs = ["run-loop", stage, "--repo-root", repo, "--expected-branch", "main"];
const runId = `${repo}|stage:${stage}`;
const key = () => runnerKey(runId);
const engineCommand = `${engineWord} ${loopArgs.join(" ")}`;
const launchCommand = `${launchWord} ${loopArgs.join(" ")}`;

/**
 * A terminal pool whose shells all report `shellPid`, so a test decides
 * exactly what ancestry is available.
 */
function pool(shellPid: number): { acquire: (cwd: string) => unknown; acquired: FakeTerminal[] } {
  const acquired: FakeTerminal[] = [];
  return {
    acquired,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, shellPid);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return { terminal, idle: () => true, release: () => undefined, discard: () => undefined, retire: () => undefined };
    },
  };
}

/**
 * A `running-shell` record exactly as the previous window left it: the shell
 * reported that exact execution as started, which is why the state is what it
 * is, and no pid was bound, because a start event binds none.
 */
function restoredRunningLoop(options: { terminalPid?: number; enginePid?: number; generation?: string; armedAtMs?: number } = {}): unknown[] {
  return [
    {
      id: "operation-the-shell-said-it-started",
      key: key(),
      state: "running-shell",
      transport: "shell",
      caller: "runner",
      label: `run-loop ${stage}`,
      repoRoot: repo,
      cwd: repo,
      subcommand: "run-loop",
      runId,
      runnerKind: "run-loop",
      stageId: stage,
      word: engineWord,
      invocation: { word: engineWord, args: loopArgs, cwd: repo },
      submittedAtMs: options.armedAtMs ?? Date.now() - 5000,
      terminalPid: options.terminalPid,
      terminalName: "Agent Sparring — sporely-py",
      enginePid: options.enginePid,
      generation: options.generation,
    },
  ];
}

/** Whether a second copy of that same operation would be admitted. */
function wouldAdmit(registry: Registry): { admitted: boolean; refusal: string } {
  const admission = registry.claim({ key: key(), caller: "runner", label: `run-loop ${stage}`, repoRoot: repo, cwd: repo, subcommand: "run-loop", runId, runnerKind: "run-loop", stageId: stage });
  if (admission.admitted) {
    registry.release(admission.claim, "the test only asked whether it would be admitted");
    return { admitted: true, refusal: "" };
  }
  return { admitted: false, refusal: admissionRefusal(admission.blocked) };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");

// ---------------------------------------------------------------------------
// A. the production path: a start event, a reload, and a pidless running-shell
// ---------------------------------------------------------------------------

describe("a running-shell operation restored after a reload has no pid bound, and binds only under its own live shell", () => {
  beforeEach(() => reset());

  it("A. only the strict descendant of the shell that ran it may be bound; a foreign match is ignored", async () => {
    const shellPid = 9100;
    const logged: string[] = [];
    const kept = store();
    const before: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool(shellPid);
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, before, () => false, async () => []);
    const launching = tracker.launch({ configured: launchWord, args: loopArgs, cwd: repo, repoRoot: repo, name: "run-loop", runId, kind: "run-loop", stageId: stage, reveal: false });
    await waitingForIntegration();
    const integration: FakeShellIntegration = terminals.acquired[0].integrate();
    const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");

    // The real, normal path into `running-shell`: the shell reports that exact
    // execution as started.
    stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
    assert.equal((await launching).ok, true, "the shell reported it as started");
    const started = before.inFlightFor(key());
    assert.equal(started?.state, "running-shell", "so it is running, on the shell's own evidence");
    assert.equal(started?.enginePid, undefined, "and no pid is bound: a start event is not a process lookup");
    await until(
      () => (kept.get<{ key: string; state: string; terminalPid?: number }[]>(OPERATIONS_KEY, []).some((item) => item.key === key() && item.state === "running-shell" && item.terminalPid === shellPid) ? true : undefined),
      "the running state and the shell's pid to be persisted",
    );
    tracker.dispose();
    before.dispose();

    // The reload. The shell is still there — persistent terminal sessions are
    // on by default — with the real engine under it, and one unrelated
    // process elsewhere running exactly the same command line.
    const born = psStart(Date.now() - 2000);
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: shellPid, ppid: 1, command: "-zsh" },
      { pid: 9101, ppid: shellPid, command: launchCommand, started: born },
      { pid: 9500, ppid: 1, command: launchCommand, started: born },
    ];
    const after: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      const restored = after.restore();
      assert.deepEqual(
        restored.map((item) => [item.state, item.restored, item.enginePid]),
        [["running-shell", true, undefined]],
        "the reloaded window finds it running, with no process bound to it",
      );
      await after.probeAll();

      const held = after.inFlightFor(key());
      assert.equal(held?.state, "running-shell");
      assert.equal(held?.enginePid, 9101, "the descendant of the shell that ran it is what gets bound");
      assert.deepEqual(resolutions(logged), [], "and nothing was resolved");
      assert.equal(wouldAdmit(after).admitted, false, "a duplicate stays refused while it runs");

      // The foreign look-alike exiting is a fact about a stranger.
      processes.splice(processes.findIndex((item) => item.pid === 9500), 1);
      await after.probeAll();
      assert.equal(after.inFlightFor(key())?.state, "running-shell", "so it releases nothing");
      assert.deepEqual(resolutions(logged), []);

      // The bound process exiting is a fact about this operation.
      processes.splice(processes.findIndex((item) => item.pid === 9101), 1);
      await after.probeAll();
      assert.equal(after.inFlightFor(key()), undefined, "and that is what releases the guard");
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      after.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// B. the shell has gone
// ---------------------------------------------------------------------------

describe("a running-shell operation whose shell has gone adopts nothing", () => {
  beforeEach(() => reset());

  it("B. a matching process elsewhere is not adopted, and the guard is unchanged", async () => {
    const shellPid = 9200;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: shellPid }) });
    // The shell that ran it is gone. A dying shell reparents its children, so
    // a matching process under pid 1 is exactly what a real reparented engine
    // *and* a stranger both look like — which is why neither may be adopted.
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 9201, ppid: 1, command: engineCommand, started: psStart(Date.now() - 2000) },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      for (let round = 0; round < 3; round++) {
        await registry.probeAll();
      }
      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "running-shell", "the state is unchanged: it did run, and nothing says it stopped");
      assert.equal(held?.enginePid, undefined, "and no process was adopted as its own");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved");
      assert.equal(wouldAdmit(registry).admitted, false, "a duplicate stays refused");
      assert.ok(
        logged.some((line) => /no longer in the table/.test(line) && /another window, another repository or another invocation/.test(line)),
        `the log says why nothing can be tied to it, got ${JSON.stringify(logged)}`,
      );
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// C. the shell's pid was never recorded
// ---------------------------------------------------------------------------

describe("not knowing which shell ran it is not knowing that the shell is gone", () => {
  beforeEach(() => reset());

  it("C. an unrecorded shell pid adopts nothing, with a matching process in the table", async () => {
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: undefined }) });
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 9300, ppid: 1, command: "-zsh" },
      { pid: 9301, ppid: 9300, command: engineCommand, started: psStart(Date.now() - 2000) },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      await registry.probeAll();
      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "running-shell");
      assert.equal(held?.enginePid, undefined, "an unknown ancestor may never widen what counts as this operation's process");
      assert.deepEqual(resolutions(logged), []);
      assert.equal(wouldAdmit(registry).admitted, false);
      assert.ok(
        logged.some((line) => /ancestry cannot be established at all/.test(line) && /not the same as the shell having gone/.test(line)),
        `the log says what is actually unknown, got ${JSON.stringify(logged)}`,
      );
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// D. a candidate older than the hand-over
// ---------------------------------------------------------------------------

describe("a process that predates the hand-over is not this execution", () => {
  beforeEach(() => reset());

  it("D. a matching descendant born before the intent is rejected, and the guard stays", async () => {
    const shellPid = 9400;
    const armedAtMs = Date.now() - 5000;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: shellPid, armedAtMs }) });
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: shellPid, ppid: 1, command: "-zsh" },
      { pid: 9401, ppid: shellPid, command: engineCommand, started: psStart(armedAtMs - 365 * 24 * 60 * 60 * 1000) },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "running-shell");
      assert.equal(held?.enginePid, undefined, "an ancient process under the right shell is still not this launch");
      assert.deepEqual(resolutions(logged), []);
      assert.equal(wouldAdmit(registry).admitted, false);
      assert.ok(
        logged.some((line) => /born before this command was handed over/.test(line)),
        `the log says why the candidate was rejected, got ${JSON.stringify(logged)}`,
      );
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// E. two candidates under the right shell
// ---------------------------------------------------------------------------

describe("two indistinguishable descendants are not one identity", () => {
  beforeEach(() => reset());

  it("E. neither of two matching descendants is bound, and the guard stays", async () => {
    const shellPid = 9600;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: shellPid }) });
    const born = psStart(Date.now() - 2000);
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: shellPid, ppid: 1, command: "-zsh" },
      { pid: 9601, ppid: shellPid, command: engineCommand, started: born },
      { pid: 9602, ppid: shellPid, command: engineCommand, started: born },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "running-shell");
      assert.equal(held?.enginePid, undefined, "the first table row is not silently taken");
      assert.deepEqual(resolutions(logged), []);
      assert.equal(wouldAdmit(registry).admitted, false);
      assert.ok(
        logged.some((line) => /Two indistinguishable processes are not one identity/.test(line) && /9601, 9602/.test(line)),
        `the log names both and says why neither is bound, got ${JSON.stringify(logged)}`,
      );
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// F. an identity bound before observation was lost
// ---------------------------------------------------------------------------

describe("a pid bound while it could be is followed afterwards, through the shell dying and reparenting", () => {
  beforeEach(() => reset());

  it("F. the exact pid and generation continue to be followed; nothing is rebound from the table", async () => {
    const shellPid = 9700;
    const enginePid = 9701;
    const born = psStart(Date.now() - 4000);
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: shellPid, enginePid, generation: born }) });
    // The shell has died and the engine has been reparented to pid 1, with a
    // look-alike elsewhere in the table for good measure.
    let processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: enginePid, ppid: 1, command: engineCommand, started: born },
      { pid: 9800, ppid: 1, command: engineCommand, started: psStart(Date.now() - 1000) },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      let held = registry.inFlightFor(key());
      assert.equal(held?.state, "running-shell", "a reparented engine that was already identified is still identified");
      assert.equal(held?.enginePid, enginePid, "on the pid it already had: nothing is rebound from the table");
      assert.deepEqual(resolutions(logged), []);
      assert.equal(wouldAdmit(registry).admitted, false);

      // The look-alike exits. That is not this operation.
      processes = processes.filter((item) => item.pid !== 9800);
      await registry.probeAll();
      held = registry.inFlightFor(key());
      assert.equal(held?.enginePid, enginePid, "and its exit binds nothing and releases nothing");
      assert.deepEqual(resolutions(logged), []);

      // Its own process going is what settles it.
      processes = processes.filter((item) => item.pid !== enginePid);
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key()), undefined, "its actual disappearance resolves the operation");
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      registry.dispose();
    }
  });

  it("F2. a pid whose birth time has changed is a reused pid, and that resolves it", async () => {
    const shellPid = 9750;
    const enginePid = 9751;
    const born = psStart(Date.now() - 4000);
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: shellPid, enginePid, generation: born }) });
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: enginePid, ppid: 1, command: "/usr/bin/vim notes.md", started: psStart(Date.now() - 500) },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key()), undefined, "a different birth time on the recorded pid is positive death evidence");
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// G. the reviewer's harm sequence, directly
// ---------------------------------------------------------------------------

describe("a foreign matching process can never release a running-shell guard", () => {
  beforeEach(() => reset());

  it("G. the foreign process exits, the real engine runs on, and the duplicate is still refused", async () => {
    const shellPid = 9900;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: restoredRunningLoop({ terminalPid: shellPid }) });
    // The reviewer's table exactly: our shell is gone, our real engine is
    // running in a shape no matcher can recognise — a relative `--repo-root
    // .`, which cannot be compared against a recorded full path and is how
    // this arises in the field — and one unrelated process runs the command
    // line we *would* recognise.
    const realEngine = { pid: 9901, ppid: 1, command: `${engineWord} run-loop ${stage} --repo-root . --expected-branch main`, started: psStart(Date.now() - 2000) };
    const foreign = { pid: 9950, ppid: 1, command: engineCommand, started: psStart(Date.now() - 1000) };
    let processes: ProcessInfo[] = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }, realEngine, foreign];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key())?.enginePid, undefined, "the foreign process never became this operation's engine pid");

      // The foreign process exits. On 366927e this was `engine-process-gone`.
      processes = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }, realEngine];
      for (let round = 0; round < 3; round++) {
        await registry.probeAll();
      }

      const held = registry.inFlightFor(key());
      assert.ok(held, "the guard is still held");
      assert.equal(held.state, "running-shell", "and still says what is true: it started, and nothing has ended it");
      assert.equal(held.enginePid, undefined);
      assert.deepEqual(resolutions(logged), [], "nothing was resolved by a stranger's exit");

      const second = wouldAdmit(registry);
      assert.equal(second.admitted, false, "so a duplicate run-loop for that run is refused while the real engine runs");
      assert.match(second.refusal, /same engine operation twice/);

      // And the way out is a person, on that exact operation id.
      assert.equal(registry.override(held.id, "I checked — the runner is no longer active").overridden, true);
      assert.equal(registry.inFlightFor(key()), undefined, "which releases it");
      assert.match(resolutions(logged)[0], /resolved as human-override/, "recorded as the person's statement, never as evidence");
    } finally {
      registry.dispose();
    }
  });
});
