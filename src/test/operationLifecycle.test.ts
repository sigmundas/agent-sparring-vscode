/**
 * The operation lifecycle: one durable identity from before the hand-over
 * until evidence about *that* operation, or a person overriding *that exact*
 * record.
 *
 * Seven things were wrong, and each one removed duplicate protection without
 * evidence. They are the seven sections below.
 *
 *  1. **Attribution was too broad.** A process was matched on its stage id
 *     alone, and plan and manifest paths by basename, so `stage-4` in
 *     repository B resolved `stage-4` in repository A and
 *     `/repo/other/plan.md` resolved `/repo/one/plan.md`.
 *  2. **A short shell command lost its guard on start.** "Started" proves the
 *     operation is executing, which is the strongest reason to refuse a
 *     second copy — and freeze-candidate, accept-candidate and new-stage were
 *     released exactly then, mid-execution.
 *  3. **The dedicated transport was derived from the observation.** The
 *     persisted `source` mutated `terminal` → `reattached`, so the next
 *     reload no longer knew it was looking at a dedicated runner.
 *  4. **A reconnect deadline was treated as death.** A terminal that had not
 *     reappeared within six seconds ended the launch; that is VS Code's
 *     timing, not a fact about a process. And the dedicated probe excluded
 *     the root process, which is the one process that can ever be the engine.
 *  5. **An override acted on the operation key.** A dialog about record A,
 *     confirmed later, cleared whatever held that key by then — including a
 *     newer operation B.
 *  6. **An end observed before a start was not consumed.** The caller then
 *     installed a waiter for an event that had already happened.
 *  7. **The durable intent was written after the hand-over.** A crash in
 *     between left a started operation with no record at all.
 *
 * These tests drive the production `ExecutionTracker`,
 * `SparringCommandRunner` and `OperationRegistry` over a `vscode` module the
 * test controls (vscodeStub.ts), because each of these is about an exact
 * moment: between a start and an end, between two reloads, between a persist
 * and a spawn.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import type { ProcessInfo } from "../core/processTree";
import { findDescendant, findSelfOrDescendant } from "../core/processTree";
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
let LAUNCHES_KEY: string;

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  commandKey = registry.commandKey;
  runnerKey = registry.runnerKey;
  OPERATION_RESOLUTIONS = registry.OPERATION_RESOLUTIONS;
  OPERATIONS_KEY = registry.OPERATIONS_KEY;
  LAUNCHES_KEY = "agentSparring.launches";
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
  SparringCommandRunner = (await import("../vscode/commandRunner")).SparringCommandRunner;
});

interface Store {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

/** Workspace state, which is the only thing a window reload leaves behind. */
function store(): Store {
  const kept = new Map<string, unknown>();
  return {
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void kept.set(key, value),
    keys: () => [...kept.keys()],
  };
}

/** A workspaceState whose writes fail from the nth call on. Nothing else changes. */
function storeFailingFrom(nth: number): Store & { writes: number } {
  const kept = new Map<string, unknown>();
  const failing = {
    writes: 0,
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => {
      failing.writes += 1;
      if (failing.writes >= nth) {
        throw new Error("the workspace state is not writable in this test");
      }
      kept.set(key, value);
    },
    keys: () => [...kept.keys()],
  };
  return failing;
}

/**
 * The production pool's contract, as much of it as these tests need: a lease
 * over a terminal, and `idle()` — the synchronous occupancy check the
 * hand-over makes with nothing awaited after it. `occupied` is how a test
 * makes a terminal the person's while the launcher is mid-flight.
 */
function pool(): { acquire: (cwd: string) => unknown; acquired: FakeTerminal[]; retired: FakeTerminal[]; occupied: Set<FakeTerminal> } {
  const acquired: FakeTerminal[] = [];
  const retired: FakeTerminal[] = [];
  const occupied = new Set<FakeTerminal>();
  return {
    acquired,
    retired,
    occupied,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, 7100 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return { terminal, idle: () => !occupied.has(terminal), release: () => undefined, discard: () => undefined, retire: () => retired.push(terminal) };
    },
  };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");

/** How many times a resolution was logged for a label: a guard must resolve exactly once. */
const resolutions = (logged: string[]) => logged.filter((line) => /: resolved as /.test(line));

// ---------------------------------------------------------------------------

describe("the transition table names evidence, and only evidence", () => {
  it("no transition out of a guard rests on a timeout, a look-alike or a missing answer", () => {
    const forbidden = /timeout|timed out|did not reconnect|no reconnect|basename|some process|a runner in this project|expired/i;
    for (const transition of OPERATION_RESOLUTIONS) {
      assert.doesNotMatch(transition.evidence, forbidden, `${transition.from} → ${transition.evidence}`);
      assert.doesNotMatch(transition.proves, forbidden, `what ${transition.evidence} claims to prove`);
      assert.ok(transition.proves.length > 20, `${transition.evidence} says what it proves`);
    }
  });

  it("every durable state can be resolved by a human override, and no other state can", () => {
    const overridable = OPERATION_RESOLUTIONS.filter((transition) => transition.evidence === "human-override").map((transition) => transition.from);
    assert.deepEqual(overridable.slice().sort(), ["armed", "running-dedicated", "running-direct", "running-shell", "submitted-shell"], "a person can always take responsibility for a durable record");
    assert.ok(!overridable.includes("reserved"), "and never for a reservation, which cannot have executed");
  });
});

// ---------------------------------------------------------------------------
// 2. a short shell command that started, and has not ended
// ---------------------------------------------------------------------------

describe("a short shell command keeps its guard from before the hand-over until its own end", () => {
  beforeEach(() => reset());

  const stage = "stage-4-editor-and-ui-inspection";
  const cwd = path.join(os.tmpdir(), "agent-sparring-lifecycle-repo-one");
  const options = () => ({
    configured: process.execPath,
    args: ["freeze-candidate", stage, "--repo-root", cwd],
    cwd,
    name: "freeze-candidate",
    operation: { subcommand: "freeze-candidate", target: stage },
  });

  it("refuses a second freeze-candidate while the first has started and not ended", async () => {
    const logged: string[] = [];
    const kept = store();
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const key = commandKey(cwd, "freeze-candidate", stage);
    try {
      const first = runner.run({ ...options(), name: "freeze-candidate (first)" });
      await waitingForIntegration();
      const integration: FakeShellIntegration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");

      // The shell starts it. This is the moment the guard used to be dropped.
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      await until(() => (registry.inFlightFor(key)?.state === "running-shell" ? true : undefined), "the same record to advance to running");
      assert.deepEqual(resolutions(logged), [], "and nothing has been resolved: it is executing");

      const second = await runner.run({ ...options(), name: "freeze-candidate (second)" });
      assert.equal(second.ok, false, "a second copy is refused while the first is executing");
      assert.equal(second.ok ? undefined : second.problem, "unconfirmed");
      assert.match(second.ok ? "" : second.error, /same engine operation twice/);
      assert.equal(terminals.acquired.length, 1, "no second terminal was acquired");
      assert.deepEqual(
        integration.executed.filter((line) => line.includes("freeze-candidate")).length,
        1,
        "and exactly one engine invocation happened",
      );

      // Its own end is what releases it.
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution, exitCode: 0 });
      const result = await first;
      assert.equal(result.ok, true, "the first command ran to completion");
      assert.equal(result.ok ? result.outcome.exitCode : undefined, 0);
      assert.equal(registry.inFlightFor(key), undefined, "and the guard is released by that execution's own end");
      assert.equal(resolutions(logged).length, 1, "exactly once");
      assert.match(resolutions(logged)[0], /resolved as completed \(shell-execution-ended\)/);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });

  it("still refuses it when the window reloads while that command is running", async () => {
    const logged: string[] = [];
    const kept = store();
    const first: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const firstPool = pool();
    const firstRunner: Runner = new SparringCommandRunner((message) => logged.push(message), firstPool as never, first);
    const key = commandKey(cwd, "freeze-candidate", stage);
    const running = firstRunner.run({ ...options(), name: "freeze-candidate (before the reload)" });
    await waitingForIntegration();
    const integration = firstPool.acquired[0].integrate();
    const execution = await until(() => firstPool.acquired[0].executions[0], "the command to be handed to the shell");
    stub.window.startEmitter.fire({ terminal: firstPool.acquired[0], shellIntegration: integration, execution });
    await until(() => (first.inFlightFor(key)?.state === "running-shell" ? true : undefined), "the record to advance to running");
    await until(
      () => (kept.get<{ key: string; state: string }[]>(OPERATIONS_KEY, []).some((item) => item.key === key && item.state === "running-shell") ? true : undefined),
      "the running state to be persisted",
    );

    // The reload: everything in memory is gone. The command is not — it is
    // executing in a shell owned by the pty host.
    first.dispose();
    const after: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const secondPool = pool();
    const secondRunner: Runner = new SparringCommandRunner((message) => logged.push(message), secondPool as never, after);
    try {
      const restored = after.restore();
      assert.deepEqual(
        restored.map((item) => [item.state, item.restored, item.transport]),
        [["running-shell", true, "shell"]],
        "the reloaded window finds it as a command that is executing",
      );
      const refused = await secondRunner.run({ ...options(), name: "freeze-candidate (after the reload)" });
      assert.equal(refused.ok, false, "and refuses a duplicate");
      assert.match(refused.ok ? "" : refused.error, /same engine operation twice/);
      assert.ok(refused.ok ? false : refused.submission, "offering the person the override, which is the only way out with no probe here");
      assert.equal(secondPool.acquired.length, 0, "nothing was acquired for it");
    } finally {
      // The first window's caller is still waiting on an execution nobody
      // will end; let it go with the terminal.
      firstPool.acquired[0].dispose();
      await running.catch(() => undefined);
      secondRunner.dispose();
      after.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 1. attribution, at the registry
// ---------------------------------------------------------------------------

describe("a process resolves an operation only when it is provably that operation", () => {
  beforeEach(() => reset());

  const stage = "stage-4-editor-and-ui-inspection";
  const repoOne = "/code/repo-one";
  const repoTwo = "/code/repo-two";

  /** A restored run-loop for `stage` in repository one, submitted to a shell. */
  async function restoredLoop(kept: Store, shellPid: number): Promise<void> {
    await kept.update(OPERATIONS_KEY, [
      {
        id: "operation-from-the-previous-window",
        key: runnerKey(`${repoOne}|stage:${stage}`),
        state: "submitted-shell",
        transport: "shell",
        caller: "runner",
        label: `run-loop ${stage}`,
        repoRoot: repoOne,
        cwd: repoOne,
        subcommand: "run-loop",
        runId: `${repoOne}|stage:${stage}`,
        runnerKind: "run-loop",
        stageId: stage,
        submittedAtMs: Date.now() - 4000,
        terminalPid: shellPid,
        terminalName: "Agent Sparring — repo one",
      },
    ]);
  }

  it("the same stage id in another repository resolves nothing", async () => {
    const kept = store();
    const logged: string[] = [];
    const shellPid = 900;
    await restoredLoop(kept, shellPid);
    let processes: ProcessInfo[] = [
      { pid: shellPid, ppid: 1, command: "-zsh" },
      // Repository two is running its own stage-4. A different operation.
      { pid: 901, ppid: shellPid, command: `/venv/bin/sparring run-loop ${stage} --repo-root ${repoTwo} --expected-branch main` },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.unresolved().length, 1, "repository two's stage-4 says nothing about repository one's");

      // Its own repository's stage-4, under its own shell: that is evidence.
      processes = [
        { pid: shellPid, ppid: 1, command: "-zsh" },
        { pid: 902, ppid: shellPid, command: `/venv/bin/sparring run-loop ${stage} --repo-root ${repoOne} --expected-branch main` },
      ];
      await registry.probeAll();
      assert.equal(registry.unresolved()[0]?.state, "running-shell", "and it advances the guard rather than lifting it");
    } finally {
      registry.dispose();
    }
  });

  it("the exact command under someone else's shell resolves nothing either", async () => {
    const kept = store();
    const logged: string[] = [];
    const shellPid = 910;
    await restoredLoop(kept, shellPid);
    const processes: ProcessInfo[] = [
      { pid: shellPid, ppid: 1, command: "-zsh" },
      { pid: 911, ppid: 1, command: "-zsh (someone else's)" },
      // The same operation — but not under the shell that was given the line.
      { pid: 912, ppid: 911, command: `/venv/bin/sparring run-loop ${stage} --repo-root ${repoOne} --expected-branch main` },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.unresolved()[0]?.state, "submitted-shell", "ancestry is part of the attribution, so this proves nothing");
    } finally {
      registry.dispose();
    }
  });

  it("a plan with the same basename at another full path resolves nothing", async () => {
    const kept = store();
    const logged: string[] = [];
    const shellPid = 920;
    await kept.update(OPERATIONS_KEY, [
      {
        id: "operation-for-repo-one's-plan",
        key: runnerKey(`${repoOne}|plan:plan-abcd1234`),
        state: "submitted-shell",
        transport: "shell",
        caller: "runner",
        label: "run-plan plan.md",
        repoRoot: repoOne,
        cwd: repoOne,
        subcommand: "run-plan",
        runId: `${repoOne}|plan:plan-abcd1234`,
        runnerKind: "run-plan",
        planPath: `${repoOne}/plan.md`,
        submittedAtMs: Date.now() - 4000,
        terminalPid: shellPid,
        terminalName: "Agent Sparring — repo one",
      },
    ]);
    let processes: ProcessInfo[] = [
      { pid: shellPid, ppid: 1, command: "-zsh" },
      // Another plan.md entirely, in another repository.
      { pid: 921, ppid: shellPid, command: `/venv/bin/sparring run-plan /repo/other/plan.md --repo-root /repo/other --expected-branch main` },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      // The other repository's plan is neither this operation starting nor
      // proof that this operation is over.
      assert.equal(registry.unresolved()[0]?.state, "submitted-shell", "another plan.md is another operation");
      assert.ok(
        !logged.some((line) => /resolved as/.test(line)),
        `nothing was resolved by it, got ${JSON.stringify(resolutions(logged))}`,
      );

      // Its own plan, at its own full path, still running.
      processes = [
        { pid: shellPid, ppid: 1, command: "-zsh" },
        { pid: 922, ppid: shellPid, command: `/venv/bin/sparring run-plan ${repoOne}/plan.md --repo-root ${repoOne} --expected-branch main` },
      ];
      await registry.probeAll();
      assert.equal(registry.unresolved()[0]?.state, "running-shell", "its own plan, under its own shell, is what proves it started");

      // Gone. Now, and only now, the operation is over.
      processes = [{ pid: shellPid, ppid: 1, command: "-zsh" }];
      await registry.probeAll();
      assert.deepEqual(registry.unresolved(), [], "its own process disappearing is what ends it");
      assert.match(resolutions(logged)[0], /resolved as completed \(engine-process-gone\)/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. + 4. the dedicated transport
// ---------------------------------------------------------------------------

describe("a dedicated-terminal runner is known to be one for as long as it exists", () => {
  beforeEach(() => reset());

  const cwd = "/code/repo-one";
  const manifest = "/code/repo-one/.sparring/manifests/foo.manifest.json";
  const runId = `${cwd}|plan:foo-abcd1234`;
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

  /** Start it, in a window whose shell integration never appears. */
  async function startDedicated(kept: Store, logged: string[]): Promise<{ pid: number }> {
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => false, async () => []);
    const launching = tracker.launch(options);
    await waitingForIntegration();
    terminals.acquired[0].dispose();
    const result = await launching;
    assert.equal(result.ok && result.via, "terminal", "it ran in a dedicated terminal");
    const dedicated = stub.window.terminals[stub.window.terminals.length - 1];
    const pid = await dedicated.processId;
    await until(() => (kept.get<unknown[]>(LAUNCHES_KEY, []).length === 1 ? true : undefined), "the launch to be persisted");
    tracker.dispose();
    registry.dispose();
    return { pid };
  }

  it("survives two reloads with its transport identity, and refuses a duplicate after each", async () => {
    const kept = store();
    const logged: string[] = [];
    const { pid } = await startDedicated(kept, logged);

    for (const round of [1, 2]) {
      reset();
      const reconnected = new FakeTerminal(`Agent Sparring — run-plan (reload ${round})`, pid);
      stub.window.terminals.push(reconnected);
      const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
      const terminals = pool();
      const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => false, async () => []);
      try {
        await tracker.reattach();
        assert.equal(tracker.executionFor(runId)?.state, "running", `reload ${round}: the dedicated terminal's process is the runner, and it is there`);
        assert.equal(
          kept.get<{ transport?: string }[]>(LAUNCHES_KEY, [])[0]?.transport,
          "dedicated-terminal",
          `reload ${round}: what this launch is has not been overwritten by how it is now observed`,
        );
        assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-dedicated", `reload ${round}: and the guard is still a dedicated runner's`);

        const refused = await tracker.launch({ ...options, name: `run-plan (after reload ${round})` });
        assert.equal(refused.ok, false, `reload ${round}: a duplicate is refused`);
        assert.match(refused.ok ? "" : refused.error, /same engine operation twice/);
        assert.equal(stub.window.created.length, 0, `reload ${round}: and no second dedicated terminal was created`);
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    }
  });

  it("stays guarded when its terminal does not come back within the reconnect deadline", async () => {
    const kept = store();
    const logged: string[] = [];
    await startDedicated(kept, logged);
    reset(); // no terminal reappears at all

    // No process probe at all: nothing whatever can be established here.
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry, () => false, async () => []);
    try {
      registry.restore();
      await tracker.reattach(); // waits out RECONNECT_GRACE_MS
      assert.equal(tracker.executionFor(runId)?.state, "unknown", "a missed reconnect deadline is not death: liveness is unknown, not ended");
      assert.match(tracker.executionFor(runId)?.detail ?? "", /not evidence about the runner/);
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "running-dedicated", "and the operation guard is untouched");

      const refused = await tracker.launch({ ...options, name: "run-plan (after the grace period)" });
      assert.equal(refused.ok, false, "so a duplicate is still refused");
      assert.equal(stub.window.created.length, 0, "and nothing was started");
      assert.ok(refused.ok ? false : refused.submission, "the person is offered the override, which is the way out when nothing can be proved");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("ends only when the process table proves that process is gone, deadline or no deadline", async () => {
    const kept = store();
    const logged: string[] = [];
    const { pid } = await startDedicated(kept, logged);
    reset(); // again, no terminal comes back

    // The probe can speak, and says that pid holds nothing.
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }]);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker(
      { workspaceState: kept } as never,
      (message) => logged.push(message),
      () => [],
      terminals as never,
      registry,
      () => true,
      async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }],
    );
    try {
      registry.restore();
      await tracker.reattach();
      assert.equal(tracker.executionFor(runId)?.state, "ended", "that its process is gone is evidence, and it is the only thing here that was");
      await until(() => (registry.inFlightFor(runnerKey(runId)) === undefined ? true : undefined), "the guard to be released by the same evidence");
      assert.ok(
        logged.some((line) => /resolved as completed \(dedicated-process-gone\)/.test(line)),
        `settled by evidence about that process, got ${JSON.stringify(logged.filter((line) => line.includes("resolved")))}`,
      );
      assert.notEqual(pid, undefined);

      const allowed = tracker.launch({ ...options, name: "run-plan (once its process is really gone)" });
      await waitingForIntegration();
      assert.equal(terminals.acquired.length, 1, "after which the operation may be started again");
      terminals.acquired[0].dispose();
      await allowed;
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("looks at the dedicated process itself, not only at its children", async () => {
    // A dedicated terminal's process *is* the engine, so it is the root of
    // the tree that must match. Excluding the root — which is what
    // findDescendant does, correctly, for a shell — declared every live
    // dedicated runner dead.
    const engine = `/venv/bin/sparring run-plan --manifest ${manifest} --repo-root ${cwd} --expected-branch main`;
    const table: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 500, ppid: 1, command: engine },
      { pid: 501, ppid: 500, command: "claude --output-format stream-json -p hello" },
    ];
    const isEngine = (line: string) => line.includes("sparring run-plan");
    assert.equal(findDescendant(table, 500, isEngine), undefined, "the root is not among its own descendants");
    assert.equal(findSelfOrDescendant(table, 500, isEngine)?.pid, 500, "but it is the process the probe must find");

    const kept = store();
    const logged: string[] = [];
    await kept.update(OPERATIONS_KEY, [
      {
        id: "operation-for-a-dedicated-runner",
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
        manifest,
        submittedAtMs: Date.now() - 4000,
        terminalPid: 500,
        terminalName: "Agent Sparring — run-plan",
      },
    ]);
    let processes = table;
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      assert.equal(registry.unresolved()[0]?.state, "running-dedicated", "a live dedicated runner is not declared dead by its own probe");

      // The pid is still there and its command line is now something this
      // extension cannot attribute. That is the matcher saying "I cannot
      // recognise this", which is not "the operation ended" — and it used to
      // be read as the latter.
      processes = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }, { pid: 500, ppid: 1, command: "/bin/zsh" }];
      await registry.probeAll();
      assert.equal(registry.unresolved()[0]?.state, "running-dedicated", "a pid that cannot be attributed leaves the guard exactly where it was");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved by a failure to recognise a command line");
      assert.ok(
        logged.some((line) => /cannot be attributed|positively identifies/.test(line)),
        `and the log says the answer was inconclusive, got ${JSON.stringify(logged)}`,
      );

      // A birth time for that pid, recorded while the operation was alive,
      // is what turns a live pid into evidence: the same number with a
      // different birth time is a different process.
      processes = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];
      await registry.probeAll();
      assert.deepEqual(registry.unresolved(), [], "its process being gone from the table is what ends it");
      assert.match(resolutions(logged)[0], /resolved as completed \(dedicated-process-gone\)/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. the override acts on the exact record
// ---------------------------------------------------------------------------

describe("an override acts on the exact operation it was asked about", () => {
  beforeEach(() => reset());

  it("a stale dialog for A does nothing to the newer B that now holds the same key", async () => {
    const logged: string[] = [];
    const kept = store();
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const cwd = path.join(os.tmpdir(), "agent-sparring-override");
    const stage = "stage-4";
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const key = commandKey(cwd, "freeze-candidate", stage);
    const options = {
      configured: process.execPath,
      args: ["freeze-candidate", stage, "--repo-root", cwd],
      cwd,
      name: "freeze-candidate",
      operation: { subcommand: "freeze-candidate", target: stage },
    };
    try {
      // A: submitted, and its start-wait runs out. This is the record a
      // person would be shown a dialog about.
      const firstRun = runner.run({ ...options, name: "freeze-candidate (A)" });
      await waitingForIntegration();
      const firstIntegration = terminals.acquired[0].integrate();
      const firstExecution = await until(() => terminals.acquired[0].executions[0], "A to be handed to the shell");
      const a = await firstRun;
      assert.equal(a.ok, false, "A was never reported as started");
      const dialogAbout = a.ok ? undefined : a.submission;
      assert.ok(dialogAbout, "and the person is offered the override for it");

      // A is resolved by evidence while that dialog is open: the shell
      // reports that exact execution finishing, which is the one thing that
      // settles a command a shell was given.
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: firstIntegration, execution: firstExecution, exitCode: 0 });
      await until(() => (registry.inFlightFor(key) === undefined ? true : undefined), "A to be resolved by its own execution ending");

      // B: the same operation, deliberately run again. It takes the same key
      // and is a different record with a different id.
      const secondRun = runner.run({ ...options, name: "freeze-candidate (B)" });
      await waitingForIntegration();
      terminals.acquired[1].integrate();
      await until(() => terminals.acquired[1].executions[0], "B to be handed to the shell");
      const b = await until(() => registry.inFlightFor(key), "B to hold the key");
      assert.notEqual(b.id, dialogAbout.id, "B is a different operation with the same key");

      // Now the person confirms A's dialog.
      const result = registry.override(dialogAbout.id, "the person confirmed A, long after A was resolved");
      assert.deepEqual(result, { overridden: false, reason: "already-resolved" }, "which does nothing at all");
      assert.equal(registry.inFlightFor(key)?.id, b.id, "B is untouched and still guards the operation");
      assert.ok(
        !logged.some((line) => /resolved as human-override/.test(line)),
        "and nothing was recorded as overridden",
      );

      // B can still be overridden, as itself.
      assert.equal(registry.override(b.id, "the person checked the terminal for B").overridden, true);
      assert.equal(registry.inFlightFor(key), undefined);
      terminals.acquired[1].dispose();
      await secondRun.catch(() => undefined);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. an end that was already observed
// ---------------------------------------------------------------------------

describe("an end observed before the start is consumed, not waited for again", () => {
  beforeEach(() => reset());

  it("completes the command normally and resolves the guard exactly once", async () => {
    const logged: string[] = [];
    const kept = store();
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const cwd = path.join(os.tmpdir(), "agent-sparring-end-first");
    const stage = "stage-4";
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const key = commandKey(cwd, "accept-candidate", stage);
    try {
      const running = runner.run({
        configured: process.execPath,
        args: ["accept-candidate", stage, "--repo-root", cwd],
        cwd,
        name: "accept-candidate",
        operation: { subcommand: "accept-candidate", target: stage },
      });
      await waitingForIntegration();
      const integration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");

      // The shell reports the end without this window ever seeing a start —
      // what a command that finishes inside one tick looks like. There is no
      // start event afterwards, so anything that waits for one waits for ever.
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution, exitCode: 0 });

      const result = await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("hung"), 3000))]);
      assert.notEqual(result, "hung", "the caller does not wait for an event that already happened");
      const outcome = result as Awaited<ReturnType<Runner["run"]>>;
      assert.equal(outcome.ok, true, "the command completed");
      assert.equal(outcome.ok ? outcome.outcome.exitCode : undefined, 0, "with the exit code the shell reported");
      assert.equal(registry.inFlightFor(key), undefined, "and the guard is resolved");
      assert.equal(resolutions(logged).length, 1, "exactly once");
      assert.match(resolutions(logged)[0], /resolved as completed \(shell-execution-ended\)/);
      // Both halves are on the record, in the honest order: it ran, then it
      // finished. There is no instant in which it was unguarded.
      const order = logged.filter((line) => /reported it finished|resolved as completed/.test(line));
      assert.match(order[0], /reported it finished/);
      assert.match(order[1], /resolved as completed/);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. the durable intent comes before the hand-over
// ---------------------------------------------------------------------------

describe("the durable execution intent is on disk before anything can execute", () => {
  beforeEach(() => reset());

  const cwd = path.join(os.tmpdir(), "agent-sparring-intent");
  const runId = `${cwd}|stage:stage-1`;
  const launchOptions = {
    configured: process.execPath,
    args: ["run-loop", "stage-1", "--repo-root", cwd],
    cwd,
    repoRoot: cwd,
    name: "run-loop",
    runId,
    kind: "run-loop" as const,
    stageId: "stage-1",
    reveal: false,
  };

  it("persists the intent, and only then hands the command to the shell", async () => {
    const logged: string[] = [];
    const writes: { at: number; keys: string[] }[] = [];
    const kept = store();
    let executed = 0;
    const observing: Store = {
      get: kept.get,
      update: async (key, value) => {
        writes.push({ at: executed, keys: (value as { key: string }[]).map((item) => item.key) });
        await kept.update(key, value);
      },
      keys: kept.keys,
    };
    const registry: Registry = new OperationRegistry({ workspaceState: observing } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], terminals as never, registry);
    try {
      const launching = tracker.launch(launchOptions);
      await waitingForIntegration();
      const integration = terminals.acquired[0].integrate();
      await until(() => {
        executed = integration.executed.length;
        return executed > 0 ? true : undefined;
      }, "the command to be handed to the shell");

      // The first durable write names this operation, and it happened while
      // nothing had been handed over yet.
      const armWrite = writes.find((write) => write.keys.includes(runnerKey(runId)));
      assert.ok(armWrite, `the intent was written, got ${JSON.stringify(writes)}`);
      assert.equal(armWrite.at, 0, "and it completed before the command line reached the shell");
      assert.equal(integration.executed.length, 1, "which then happened exactly once");

      const execution = terminals.acquired[0].executions[0];
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      await launching;
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("hands nothing over at all when the intent cannot be made durable", async () => {
    const logged: string[] = [];
    // The very first write is the arm, and it fails.
    const kept = storeFailingFrom(1);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: store() } as never, (message) => logged.push(message), () => [], terminals as never, registry);
    try {
      const launching = tracker.launch(launchOptions);
      await waitingForIntegration();
      const integration = terminals.acquired[0].integrate();
      const result = await launching;
      assert.equal(result.ok, false, "the launch fails");
      assert.equal(result.ok ? undefined : result.problem, "unconfirmed");
      assert.match(result.ok ? "" : result.error, /could not record that it is about to run/);
      assert.deepEqual(integration.executed, [], "and the shell was given nothing: the transport was never invoked");
      assert.equal(stub.window.created.length, 0, "nor was any process started another way");
      assert.ok(logged.some((line) => /durable record of the intent .*could not be written/.test(line)), `and the log says why, got ${JSON.stringify(logged)}`);
      // The claim is gone, because nothing was ever handed over: a retry is
      // safe, which is the whole point of writing the record first.
      assert.equal(registry.inFlightFor(runnerKey(runId)), undefined, "and the operation is left free, because nothing can have executed");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("creates no dedicated terminal when the intent for one cannot be made durable", async () => {
    const logged: string[] = [];
    const kept = storeFailingFrom(1);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: store() } as never, (message) => logged.push(message), () => [], terminals as never, registry);
    try {
      const launching = tracker.launch(launchOptions);
      await waitingForIntegration();
      terminals.acquired[0].dispose(); // no shell integration: the dedicated route
      const result = await launching;
      assert.equal(result.ok, false, "the launch fails");
      assert.equal(stub.window.created.length, 0, "and `createTerminal` — which is irreversible — was never called");
      await settle();
      assert.equal(registry.inFlightFor(runnerKey(runId)), undefined, "the operation is left free, because nothing was spawned");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. two observers race to establish the same start
// ---------------------------------------------------------------------------

/**
 * A shell-run command can be established as started in two ways: the shell
 * reports the execution, or the process probe finds the engine running under
 * that shell. Both are real evidence, they race, and either can arrive first.
 *
 * The probe winning used to be a trap. It moved the record to `running-shell`
 * with a pid but no execution, and `outstanding` answered "no" for
 * `running-shell` — on the reasoning that such an operation is one this
 * window is watching through its execution. This one has no execution to
 * watch, so nothing would ever report its end, and `probeOnce` refused every
 * round for the one operation that had only the process table left. The
 * engine could exit and the guard stayed for as long as the window lived; a
 * real integration run sat there for fifteen minutes.
 *
 * The rule these tests hold to: whichever observation arrives first, the
 * operation has exactly one lifecycle, a later stronger observation joins
 * that record rather than starting another, and the command's real end
 * settles it exactly once.
 */
describe("whichever observer establishes a start first, the operation still settles exactly once", () => {
  beforeEach(() => reset());

  const stage = "stage-9-probe-race";
  const cwd = path.join(os.tmpdir(), "agent-sparring-probe-race");
  const args = ["freeze-candidate", stage, "--repo-root", cwd];
  const options = () => ({
    configured: process.execPath,
    args,
    cwd,
    name: "freeze-candidate",
    operation: { subcommand: "freeze-candidate", target: stage },
  });
  const key = () => commandKey(cwd, "freeze-candidate", stage);

  /** The shell that took the line, and the engine running under it. */
  const SHELL_PID = 7100;
  const ENGINE_PID = 9001;
  const engineLine = `${process.execPath} ${args.join(" ")}`;
  const tableWithEngine = (): ProcessInfo[] => [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: SHELL_PID, ppid: 1, command: "/bin/zsh -il" },
    { pid: ENGINE_PID, ppid: SHELL_PID, command: engineLine, started: new Date().toISOString() },
  ];
  const tableWithoutEngine = (): ProcessInfo[] => [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: SHELL_PID, ppid: 1, command: "/bin/zsh -il" },
  ];

  /**
   * Hand the command to a shell and let the *probe* establish it, without the
   * shell ever having reported the execution. The returned execution is the
   * one the shell is still holding, to be reported later or not at all.
   */
  async function probeWinsFirst(logged: string[], processes: () => ProcessInfo[]) {
    const kept = store();
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes());
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const started = runner.run(options());
    await waitingForIntegration();
    const integration: FakeShellIntegration = terminals.acquired[0].integrate();
    const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");
    // The shell has the line and has reported nothing about it. The probe is
    // the only observer with anything to say.
    await until(() => (registry.inFlightFor(key())?.terminalPid === SHELL_PID ? true : undefined), "the shell's pid to be recorded");
    await registry.probeAll();
    return { registry, terminals, runner, integration, execution, started, kept };
  }

  it("the probe establishes it, the shell's later report joins the same record, and that execution's end settles it", async () => {
    const logged: string[] = [];
    const processes = tableWithEngine();
    const { registry, terminals, runner, integration, execution } = await probeWinsFirst(logged, () => processes);
    try {
      const probed = registry.inFlightFor(key());
      assert.equal(probed?.state, "running-shell", "the probe established it as running");
      assert.equal(probed?.observation, "probed", "and says so: this was the process table, not the shell");
      assert.equal(probed?.enginePid, ENGINE_PID, "anchored to the exact engine process it found");
      assert.equal(probed?.shellReportedStart, false, "and the shell has reported nothing, so nothing will announce its end");

      // The shell finally reports the execution for the command already
      // known to be running. One record, told apart more exactly.
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      const joined = registry.inFlightFor(key());
      assert.equal(joined?.state, "running-shell", "the same state: it was already running and still is");
      assert.equal(joined?.shellReportedStart, true, "and the shell is now watching that execution, so its end will be reported");
      assert.equal(joined?.identifiable, true, "this window holds that exact execution");
      assert.equal(joined?.enginePid, ENGINE_PID, "without losing the pid that cost real evidence to obtain");
      assert.ok(registry.inFlightFor(key()), "the same single record still holds the key: a stronger observation is not a second lifecycle");
      // And it stops being an operation nobody here can account for. That
      // answer is what offers a person the "confirm it cannot run" override,
      // which must not be on offer against a command the shell is reporting.
      assert.deepEqual(registry.unresolved(), [], "it no longer needs the process table: the shell is watching it again");
      assert.deepEqual(resolutions(logged), [], "and nothing has been resolved: the command is executing");
      assert.deepEqual(terminals.retired, [], "and the terminal it is running in was not retired");

      const second = await runner.run(options());
      assert.equal(second.ok, false, "a second copy is still refused while it executes");
      assert.equal(terminals.acquired.length, 1, "and no second terminal was acquired");

      // Its own end, through the identity it gained.
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution, exitCode: 0 });
      assert.equal(registry.inFlightFor(key()), undefined, "the execution's end releases the guard");
      assert.equal(resolutions(logged).length, 1, "exactly once");
      assert.match(resolutions(logged)[0], /shell-execution-ended/, "by the strongest evidence it had");

      const third = await runner.run(options());
      assert.equal(third.ok, true, "and the next command is admitted");
    } finally {
      registry.dispose();
    }
  });

  it("the probe establishes it, the shell never reports anything, and the engine exiting settles it", async () => {
    const logged: string[] = [];
    let processes = tableWithEngine();
    const { registry, runner } = await probeWinsFirst(logged, () => processes);
    try {
      assert.equal(registry.inFlightFor(key())?.enginePid, ENGINE_PID, "the probe established it");

      // Still running: absence of a shell report is not absence of a process.
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key())?.state, "running-shell", "a live engine is not declared gone");
      assert.deepEqual(resolutions(logged), [], "and nothing is resolved while it runs");

      // The engine exits. Nothing else will ever say so: this window holds no
      // execution for it, and the shell is not going to report one. This is
      // the round that used to be refused, leaving the guard forever.
      processes = tableWithoutEngine();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key()), undefined, "the engine process being gone is what ends it");
      assert.equal(resolutions(logged).length, 1, "settled exactly once");
      assert.match(resolutions(logged)[0], /engine-process-gone/, "on the evidence it actually had: that exact pid");

      const next = await runner.run(options());
      assert.equal(next.ok, true, "and the next command is admitted, rather than blocked for the life of the window");
    } finally {
      registry.dispose();
    }
  });

  it("the shell reports first, and the process table is then not allowed to settle it", async () => {
    const logged: string[] = [];
    // A table in which the engine cannot be found at all. For an operation
    // this window is watching through its execution, that must decide
    // nothing: `ps` not showing a process is not that execution ending, and
    // reading it as such would be a false completion.
    const processes = tableWithoutEngine();
    const kept = store();
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    try {
      void runner.run(options());
      await waitingForIntegration();
      const integration: FakeShellIntegration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");

      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      const running = registry.inFlightFor(key());
      assert.equal(running?.state, "running-shell", "the shell established it");
      assert.equal(running?.observation, "launched", "by reporting the execution, not by a process lookup");
      assert.equal(running?.shellReportedStart, true, "so its end is an event this window will be told about");
      assert.equal(running?.enginePid, undefined, "and no pid was bound: knowing an execution started never says which process it is");

      await registry.probeAll();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key())?.state, "running-shell", "the process table settles nothing here");
      assert.deepEqual(resolutions(logged), [], "a command this window is watching is not completed by a probe");

      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution, exitCode: 0 });
      assert.equal(registry.inFlightFor(key()), undefined, "its own execution's end is what settles it");
      assert.equal(resolutions(logged).length, 1, "exactly once");
      assert.match(resolutions(logged)[0], /shell-execution-ended/);
    } finally {
      registry.dispose();
    }
  });

  it("a foreign command starting in the same terminal is never adopted as this operation's start", async () => {
    const logged: string[] = [];
    let processes = tableWithEngine();
    const { registry, terminals, integration } = await probeWinsFirst(logged, () => processes);
    try {
      assert.equal(registry.inFlightFor(key())?.enginePid, ENGINE_PID, "the probe established it");

      // Something else runs in that terminal — the person typing, or a
      // backgrounded engine leaving the foreground. The new matching pass
      // must not treat this as the report of *this* operation's start: that
      // would attach a stranger's identity and let a stranger's end release
      // this guard.
      const foreign = { commandLine: { value: "git status", isTrusted: true } } as never;
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution: foreign });

      const after = registry.inFlightFor(key());
      assert.ok(after, "the operation is still guarded");
      assert.equal(after?.shellReportedStart, false, "no stranger's execution was adopted as its start");
      assert.equal(after?.observationLost, true, "what changed is that the foreground is someone else's now");
      assert.deepEqual(resolutions(logged), [], "and nothing was resolved by another command starting");

      // Its own pid still settles it, and the stranger's fate never does.
      processes = tableWithoutEngine();
      await registry.probeAll();
      assert.equal(registry.inFlightFor(key()), undefined, "its own engine process being gone is what ends it");
      assert.equal(resolutions(logged).length, 1, "exactly once");
      assert.match(resolutions(logged)[0], /engine-process-gone/);
    } finally {
      registry.dispose();
    }
  });

  it("a probe-established operation keeps its pid identity across a reload, and settles there", async () => {
    const logged: string[] = [];
    let processes = tableWithEngine();
    const { registry, kept } = await probeWinsFirst(logged, () => processes);
    let reloaded: Registry | undefined;
    try {
      assert.equal(registry.inFlightFor(key())?.enginePid, ENGINE_PID);
      const persisted = kept.get<{ state: string; enginePid?: number; generation?: string }[]>(OPERATIONS_KEY, []);
      assert.equal(persisted.length, 1, "it is written down: a reload must not duplicate it");
      assert.equal(persisted[0].state, "running-shell");
      assert.equal(persisted[0].enginePid, ENGINE_PID, "with the identity that became authoritative");
      assert.ok(persisted[0].generation, "and the birth time that tells it from a reused pid");

      // The window reloads. The execution identity cannot survive that; the
      // pid one does, and is what settles it.
      registry.dispose();
      const after: string[] = [];
      reloaded = new OperationRegistry({ workspaceState: kept } as never, (message: string) => after.push(message), () => true, async () => processes);
      reloaded.restore();
      await reloaded.probeAll();
      assert.equal(reloaded.unresolved()[0]?.state, "running-shell", "a live engine still blocks a duplicate after the reload");

      processes = tableWithoutEngine();
      await reloaded.probeAll();
      assert.equal(reloaded.inFlightFor(key()), undefined, "and its exact process being gone settles it");
      assert.equal(resolutions(after).length, 1, "exactly once");
      assert.match(resolutions(after)[0], /engine-process-gone/);
    } finally {
      reloaded?.dispose();
    }
  });
});
