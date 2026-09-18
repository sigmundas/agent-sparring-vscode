/**
 * A command a shell has been given is never written off for want of an
 * observation.
 *
 * The previous version of this branch kept one carve-out: a `submitted-shell`
 * operation — one handed to a shell and never seen to start — was resolved as
 * `cannot-execute` when its terminal closed, or when the shell that took it
 * left the process table. The argument was that the process holding the queued
 * line was gone, so the line could never be read.
 *
 * It does not hold, and a review reproduced both halves of why:
 *
 *  A. **a short command over a reload.** `freeze-candidate` was submitted, the
 *     window reloaded, and the shell may already have run it — nothing was
 *     listening for a start, because the window that armed the listener is
 *     gone. Closing that terminal then released the guard and a second
 *     freeze-candidate was admitted.
 *  B. **a run-loop whose shell died.** The shell read the line, started the
 *     engine, and then died; the engine was reparented to pid 1 and went on
 *     working. The probe looked only among the shell's *descendants*, found
 *     nothing, saw the shell missing, and resolved the operation — admitting a
 *     duplicate run-loop over a live one.
 *
 * So: a closed terminal and a missing shell are loss of observation, the whole
 * process table is searched for the command itself, and a command that cannot
 * be found anywhere stays guarded until a person settles it.
 *
 * And one thing from the same family on the way in: `executeCommand` returning
 * and then its own metadata failing to be read is not a failed hand-over.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import type { ProcessInfo } from "../core/processTree";
import { FakeTerminal, install, reset, settle, until, type FakeShellIntegration } from "./vscodeStub";

const stub = install();

type Registry = import("../vscode/operationRegistry").OperationRegistry;
type Tracker = import("../vscode/executionTracker").ExecutionTracker;
type Runner = import("../vscode/commandRunner").SparringCommandRunner;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let SparringCommandRunner: typeof import("../vscode/commandRunner").SparringCommandRunner;
let commandKey: typeof import("../vscode/operationRegistry").commandKey;
let runnerKey: typeof import("../vscode/operationRegistry").runnerKey;
let OPERATIONS_KEY: string;

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  commandKey = registry.commandKey;
  runnerKey = registry.runnerKey;
  OPERATIONS_KEY = registry.OPERATIONS_KEY;
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
  SparringCommandRunner = (await import("../vscode/commandRunner")).SparringCommandRunner;
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

function pool(): { acquire: (cwd: string) => unknown; acquired: FakeTerminal[]; retired: FakeTerminal[]; discarded: FakeTerminal[] } {
  const acquired: FakeTerminal[] = [];
  const retired: FakeTerminal[] = [];
  const discarded: FakeTerminal[] = [];
  return {
    acquired,
    retired,
    discarded,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, 6100 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return { terminal, idle: () => true, release: () => undefined, discard: () => discarded.push(terminal), retire: () => retired.push(terminal) };
    },
  };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");
/** Every resolution logged. A guard that is released without evidence shows up here. */
const resolutions = (logged: string[]) => logged.filter((line) => /: resolved as /.test(line));

const cwd = path.join(os.tmpdir(), "agent-sparring-submitted-shell");
const engineWord = "/venv/bin/sparring";

// ---------------------------------------------------------------------------
// A. a short command over a reload, whose terminal then closes
// ---------------------------------------------------------------------------

describe("a short command handed to a shell keeps its guard when the terminal closes after a reload", () => {
  beforeEach(() => reset());

  const stage = "stage-4-editor-and-ui-inspection";
  const key = () => commandKey(cwd, "freeze-candidate", stage);
  const args = ["freeze-candidate", stage, "--repo-root", cwd];
  /** What the previous window left behind: the command was given to a shell, and nothing more is known. */
  const persisted = (shellPid: number) => [
    {
      id: "operation-submitted-before-the-reload",
      key: commandKey(cwd, "freeze-candidate", stage),
      state: "submitted-shell",
      transport: "shell",
      caller: "command",
      label: `freeze-candidate ${stage}`,
      repoRoot: cwd,
      cwd,
      subcommand: "freeze-candidate",
      stageId: stage,
      word: engineWord,
      invocation: { word: engineWord, args, cwd },
      submittedAtMs: Date.now() - 4000,
      terminalPid: shellPid,
      terminalName: "Agent Sparring — submitted",
    },
  ];

  it("1. closing the reconnected terminal is not proof that the line was never read", async () => {
    const shellPid = 6200;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: persisted(shellPid) });
    // A live shell, so the probe has nothing to say either way.
    const processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: shellPid, ppid: 1, command: "-zsh" },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key())?.state, "submitted-shell", "restored as a command a shell holds");

      // VS Code brings that terminal back, and the person then closes it.
      const reconnected = new FakeTerminal("Agent Sparring — submitted", shellPid);
      stub.window.terminals.push(reconnected);
      registry.reconnect(shellPid, reconnected as never);
      reconnected.close();
      await settle();

      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "submitted-shell", "the guard is exactly where it was");
      assert.equal(held?.observationLost, true, "what was lost is the observation, and the record says so");
      assert.deepEqual(resolutions(logged), [], "and nothing at all was resolved");

      const refused = await runner.run({ configured: engineWord, args, cwd, name: "freeze-candidate (after the terminal closed)", operation: { subcommand: "freeze-candidate", target: stage } });
      assert.equal(refused.ok, false, "so a second freeze-candidate is refused");
      assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");
      assert.match(refused.ok ? "" : refused.error, /cannot determine whether that command ran/, "and it says what is actually unknown");
      assert.ok(refused.ok ? false : refused.submission, "with the explicit way out offered for that exact operation");
      assert.equal(terminals.acquired.length, 0, "nothing was prepared for the duplicate");

      // Only the person settles it, and it is recorded as theirs.
      assert.equal(registry.override(held.id, "the person checked the terminal").overridden, true);
      assert.match(resolutions(logged)[0], /resolved as human-override/);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });

  it("4. a submitted command no process in the table can be attributed to stays guarded, not resolved", async () => {
    const shellPid = 6300;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: persisted(shellPid) });
    // The shell is gone and nothing that could be this command is running:
    // it may have run and finished, it may never have run. Neither is known.
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }]);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    try {
      registry.restore();
      await registry.probeAll();
      await registry.probeAll();

      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "submitted-shell", "a missing shell settles nothing: it says only that it will not read the line from now on");
      assert.equal(held?.observationLost, true);
      assert.deepEqual(resolutions(logged), [], "and in particular nothing was resolved as cannot-execute");
      assert.ok(
        logged.some((line) => /may well have read that line before it went/.test(line)),
        `the log says why a missing shell is not an answer, got ${JSON.stringify(logged)}`,
      );
      assert.ok(logged.some((line) => /no process in the table can be positively attributed/.test(line)), "and that the search for the command itself came back inconclusive");

      const refused = await runner.run({ configured: engineWord, args, cwd, name: "freeze-candidate (shell gone)", operation: { subcommand: "freeze-candidate", target: stage } });
      assert.equal(refused.ok, false, "a duplicate is refused while it is unknown");
      assert.ok(refused.ok ? false : refused.submission, "and the person is offered the exact operation to settle");
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });

  it("3. the exact recorded invocation, found anywhere once the shell is gone, advances the guard to running", async () => {
    const shellPid = 6400;
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: persisted(shellPid) });
    // The shell ran the line and died; its child was reparented to pid 1. A
    // short command carries no --repo-root, so the exact argument array
    // recorded with the intent is the only thing that can recognise it.
    let processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 6401, ppid: 1, command: `${engineWord} ${args.join(" ")}`, started: "Thu Sep 18 11:12:13 2026" },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();

      const held = registry.inFlightFor(key());
      assert.equal(held?.state, "running-shell", "the command was found running, so the guard advances rather than lifting");
      assert.equal(held?.enginePid, 6401, "anchored to the pid that is the operation");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved: it is running");
      assert.ok(logged.some((line) => /no longer under the shell that took it/.test(line)), `the log says where it was found, got ${JSON.stringify(logged)}`);

      // From here that pid's own fate settles it, and nothing else does.
      processes = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key()), undefined, "its process being gone is what ends it");
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// B. a run-loop whose shell died and whose engine was reparented
// ---------------------------------------------------------------------------

describe("a run-loop submitted to a shell that has since died is found by the whole process table", () => {
  beforeEach(() => reset());

  const stage = "stage-9";
  const runId = `${cwd}|stage:${stage}`;
  const launch = {
    configured: process.execPath,
    args: ["run-loop", stage, "--repo-root", cwd],
    cwd,
    repoRoot: cwd,
    name: "run-loop",
    runId,
    kind: "run-loop" as const,
    stageId: stage,
    reveal: false,
  };

  it("2. the reparented engine is found under pid 1, the guard follows it, and a duplicate is refused", async () => {
    const shellPid = 6500;
    const logged: string[] = [];
    const kept = store({
      [OPERATIONS_KEY]: [
        {
          id: "operation-whose-shell-died",
          key: runnerKey(runId),
          state: "submitted-shell",
          transport: "shell",
          caller: "runner",
          label: `run-loop ${stage}`,
          repoRoot: cwd,
          cwd,
          subcommand: "run-loop",
          runId,
          runnerKind: "run-loop",
          stageId: stage,
          word: engineWord,
          invocation: { word: engineWord, args: launch.args, cwd },
          submittedAtMs: Date.now() - 6000,
          terminalPid: shellPid,
          terminalName: "Agent Sparring — run-loop",
        },
      ],
    });
    // No shell with that pid anywhere, and the engine it started reparented
    // to pid 1 — which is exactly where the descendant-only search could
    // never look.
    let processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 6501, ppid: 1, command: `${engineWord} run-loop ${stage} --repo-root ${cwd} --expected-branch main`, started: "Thu Sep 18 11:20:00 2026" },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: store() } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();

      const held = registry.inFlightFor(runnerKey(runId));
      assert.equal(held?.state, "running-shell", "the engine is running, so the operation is reconciled as running");
      assert.equal(held?.enginePid, 6501, "on the pid it was actually found as");
      assert.deepEqual(resolutions(logged), [], "and the guard was never released on the way");

      const refused = await tracker.launch({ ...launch, name: "run-loop (after the shell died)" });
      assert.equal(refused.ok, false, "a second run-loop for that run is refused");
      assert.match(refused.ok ? "" : refused.error, /same engine operation twice/);
      assert.equal(terminals.acquired.length, 0, "and nothing was prepared for it");
      assert.equal(stub.window.created.length, 0, "no terminal was created for it either");

      // That pid going is the evidence, and the only evidence.
      processes = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];
      await registry.probeAll();
      assert.equal(registry.inFlightFor(runnerKey(runId)), undefined);
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("does not resolve a submitted run-loop when the shell is gone and nothing matches", async () => {
    const shellPid = 6600;
    const logged: string[] = [];
    const kept = store({
      [OPERATIONS_KEY]: [
        {
          id: "operation-with-nothing-to-find",
          key: runnerKey(runId),
          state: "submitted-shell",
          transport: "shell",
          caller: "runner",
          label: `run-loop ${stage}`,
          repoRoot: cwd,
          cwd,
          subcommand: "run-loop",
          runId,
          runnerKind: "run-loop",
          stageId: stage,
          submittedAtMs: Date.now() - 6000,
          terminalPid: shellPid,
          terminalName: "Agent Sparring — run-loop",
        },
      ],
    });
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }]);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: store() } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => true, async () => []);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "submitted-shell", "unknown is where it stays");
      assert.deepEqual(resolutions(logged), [], "a shell that is gone is not evidence about a line it may already have read");
      assert.equal((await tracker.launch({ ...launch, name: "run-loop (nothing to find)" })).ok, false, "and the duplicate stays refused");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// C. the irreversible boundary: metadata that fails to be read
// ---------------------------------------------------------------------------

/**
 * A shell integration that takes the command and then refuses to say what it
 * took. `executeCommand` returns — the shell has the command line — and
 * reading the returned execution's own `commandLine` throws, which used to
 * share a `try` with the call itself and was classified as "the hand-over
 * threw".
 */
function integrationThatLosesItsMetadata(terminal: FakeTerminal): FakeShellIntegration {
  const integration = {
    executed: [] as string[],
    cwd: undefined,
    executeCommand(word: string, args?: string[]) {
      integration.executed.push(args ? [word, ...args].join(" ") : word);
      const execution = {
        get commandLine(): { value: string; confidence: number; isTrusted: boolean } {
          throw new Error("the host could not report what it handed over");
        },
        terminal,
        read: () => ({
          async *[Symbol.asyncIterator]() {
            // no output stream
          },
        }),
      };
      terminal.executions.push(execution as never);
      return execution;
    },
  };
  return integration as unknown as FakeShellIntegration;
}

describe("a hand-over whose own metadata cannot be read is still a hand-over", () => {
  beforeEach(() => reset());

  const stage = "stage-4-editor-and-ui-inspection";
  const args = ["freeze-candidate", stage, "--repo-root", cwd];

  it("stays guarded as submitted, and is never resolved as cannot-execute", async () => {
    const logged: string[] = [];
    const kept = store();
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const key = commandKey(cwd, "freeze-candidate", stage);
    try {
      const running = runner.run({ configured: process.execPath, args, cwd, name: "freeze-candidate", operation: { subcommand: "freeze-candidate", target: stage } });
      await waitingForIntegration();
      const terminal = terminals.acquired[0];
      const integration = integrationThatLosesItsMetadata(terminal);
      terminal.shellIntegration = integration;
      stub.window.integrationEmitter.fire({ terminal, shellIntegration: integration });

      const held = await until(() => {
        const view = registry.inFlightFor(key);
        return view?.state === "submitted-shell" ? view : undefined;
      }, "the operation to be recorded as handed over");
      assert.equal(held.state, "submitted-shell", "the shell has the command line, and the record says exactly that");
      assert.equal(integration.executed.length, 1, "it really was handed over, once");
      assert.deepEqual(resolutions(logged), [], "and nothing was resolved as cannot-execute");
      assert.ok(
        logged.some((line) => /reading back what the host said it handed over failed/.test(line)),
        `the failure is reported as what it is, got ${JSON.stringify(logged)}`,
      );

      // The wait for a start runs out, as it must when nothing reports one.
      const result = await running;
      assert.equal(result.ok, false, "nothing is treated as having run");
      assert.equal(result.ok ? undefined : result.problem, "unconfirmed");
      assert.equal(registry.inFlightFor(key)?.state, "submitted-shell", "the guard is still there afterwards");
      assert.deepEqual(resolutions(logged), [], "still nothing resolved");

      // And the terminal going away does not settle it either.
      terminal.close();
      await settle();
      assert.equal(registry.inFlightFor(key)?.state, "submitted-shell");
      assert.equal(registry.inFlightFor(key)?.observationLost, true);
      assert.deepEqual(resolutions(logged), []);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });
});
