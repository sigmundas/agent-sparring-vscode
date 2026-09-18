/**
 * A window reload must not become permission to do a started engine
 * operation twice.
 *
 * Both direct transports outlive the extension host — an `execFile` child is
 * reparented and keeps running (directExecutionSurvival.test.ts), and a
 * dedicated terminal's process belongs to VS Code's pty host (integration
 * suite, section `outlives`). The extension-local claim, however, dies with
 * the window. So for each transport something must be found again afterwards,
 * and these tests reload the window — a fresh registry and tracker over the
 * *same* workspace state, which is all a reload leaves behind — and assert
 * that the duplicate is still refused, and that it is released only by
 * evidence that the operation is over.
 *
 * Both transports are guarded by the same record, in the same authority:
 *
 *  - a short command's child process is persisted with its pid and command
 *    line, and reconciled against the process table;
 *  - a dedicated-terminal runner is persisted with the *transport* it is —
 *    `dedicated-terminal` — and its terminal's pid, and reconciled the same
 *    way. That the transport is immutable is the point: the launch record's
 *    `source` changes to `reattached` when a reload re-finds the terminal,
 *    and deriving "this is a dedicated runner" from that observation meant
 *    the *second* reload no longer knew what it was looking at and dropped
 *    the guard.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import { FakeTerminal, install, reset, until } from "./vscodeStub";

const stub = install();

type Registry = import("../vscode/operationRegistry").OperationRegistry;
type Tracker = import("../vscode/executionTracker").ExecutionTracker;
type Runner = import("../vscode/commandRunner").SparringCommandRunner;
type Probe = () => Promise<{ pid: number; ppid: number; command: string }[]>;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let SparringCommandRunner: typeof import("../vscode/commandRunner").SparringCommandRunner;
let commandKey: typeof import("../vscode/operationRegistry").commandKey;
let OPERATIONS_KEY: string;

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  commandKey = registry.commandKey;
  OPERATIONS_KEY = registry.OPERATIONS_KEY;
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

function pool(): { acquire: () => unknown; acquired: FakeTerminal[] } {
  const acquired: FakeTerminal[] = [];
  return {
    acquired,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, 5100 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return { terminal, idle: () => true, release: () => undefined, discard: () => undefined, retire: () => undefined };
    },
  };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");

describe("a reload does not release a direct engine operation that is still running", () => {
  beforeEach(() => reset());

  it("keeps refusing a short command whose child process survived the reload", async (t) => {
    if (process.platform === "win32") {
      t.skip("the engine stand-in is a POSIX shell script");
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-reload-"));
    const calls = path.join(dir, "calls.log");
    const engine = path.join(dir, "sparring");
    await fs.writeFile(engine, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nsleep 4\n`);
    await fs.chmod(engine, 0o755);

    const kept = store();
    const logged: string[] = [];
    const stage = "stage-4-editor-and-ui-inspection";
    const key = commandKey(dir, "freeze-candidate", stage);
    const options = {
      configured: engine,
      args: ["freeze-candidate", stage],
      cwd: dir,
      name: "freeze-candidate",
      operation: { subcommand: "freeze-candidate", target: stage },
    };

    // ---- the window that starts it -------------------------------------
    const before: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const firstPool = pool();
    const firstRunner: Runner = new SparringCommandRunner((message) => logged.push(message), firstPool as never, before);
    const running = firstRunner.run(options);
    await waitingForIntegration();
    firstPool.acquired[0].dispose(); // shell integration never appears: the direct fallback is taken
    const directly = await until(() => {
      const held = before.inFlightFor(key);
      return held?.state === "running-direct" ? held : undefined;
    }, "the operation to be running as a direct process");
    const pid = directly.directPid;
    assert.ok(pid !== undefined, "the child's pid is on the record");
    const persisted = kept.get<{ key: string; direct?: { pid: number; word: string; args: string[] } }[]>(OPERATIONS_KEY, []);
    assert.deepEqual(
      persisted.map((item) => [item.key, item.direct?.pid, item.direct?.args]),
      [[key, pid, options.args]],
      "and it is persisted with what identifies it, because that process outlives this window",
    );
    const ran = await until(async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim() || undefined, "the engine stand-in to record the call");
    assert.deepEqual(ran.split("\n"), [`freeze-candidate ${stage}`], "the engine has run once");

    // ---- the reload: everything in memory is gone ----------------------
    // The child process is not: it is still running, reparented, and still
    // in the process table under its own command line.
    before.dispose();
    reset();
    const table: Probe = async () => {
      const { execFile } = await import("node:child_process");
      const { parsePsOutput } = await import("../core/processTree");
      return new Promise((resolve) => execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parsePsOutput(stdout))));
    };
    const after: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, table);
    const secondPool = pool();
    const secondRunner: Runner = new SparringCommandRunner((message) => logged.push(message), secondPool as never, after);
    try {
      const restored = after.restore();
      assert.deepEqual(
        restored.map((item: { state: string; restored: boolean; directPid?: number }) => [item.state, item.restored, item.directPid]),
        [["running-direct", true, pid]],
        "the reloaded window finds the operation it started, as a running process rather than a shell submission",
      );
      assert.deepEqual(after.unresolved().map((item: { state: string }) => item.state), ["running-direct"], "and cannot account for it on its own");

      const refused = await secondRunner.run({ ...options, name: "freeze-candidate (after the reload)" });
      assert.equal(refused.ok, false, "so the same operation is refused");
      assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");
      assert.match(refused.ok ? "" : refused.error, /before this window reloaded/, "and says what it is waiting for");
      assert.match(refused.ok ? "" : refused.error, /same engine operation twice/);
      assert.equal(secondPool.acquired.length, 0, "nothing was acquired for it");
      assert.deepEqual((await fs.readFile(calls, "utf8")).trim().split("\n"), [`freeze-candidate ${stage}`], "and the engine still ran exactly once");

      // A probe that cannot see the process table proves nothing, and a pid
      // that now holds something else means that operation is over.
      await after.probeAll();
      assert.equal(after.unresolved().length, 1, "a live process keeps it blocked");

      // The operation really ends. Only then is the key free again.
      await running;
      await until(async () => {
        await after.probeAll();
        return after.inFlightFor(key) === undefined ? true : undefined;
      }, "the process table to settle it once the child has exited");
      assert.ok(
        logged.some((line) => /resolved as completed \(direct-process-gone\)/.test(line)),
        `settled by evidence about that process, got ${JSON.stringify(logged.filter((line) => line.includes("resolved")))}`,
      );
      assert.deepEqual(kept.get(OPERATIONS_KEY, []), [], "and nothing is left on the record");
    } finally {
      after.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a restored direct process to a human override where no process probe exists", async () => {
    // Windows, where processProbe.ts reports itself unsupported. Nothing can
    // establish whether that process is over, so the operation stays blocked
    // — and the person is given the same way out as for a shell submission,
    // recorded as an override rather than as evidence.
    const kept = store();
    const logged: string[] = [];
    const cwd = path.join(os.tmpdir(), "agent-sparring-no-probe");
    const stage = "stage-4-editor-and-ui-inspection";
    const key = commandKey(cwd, "freeze-candidate", stage);
    await kept.update(OPERATIONS_KEY, [
      {
        id: "submission-from-the-previous-window",
        key,
        transport: "command",
        label: `freeze-candidate ${stage}`,
        cwd,
        subcommand: "freeze-candidate",
        stageId: stage,
        submittedAtMs: Date.now() - 3000,
        direct: { pid: 2147480002, word: "/venv/bin/sparring", args: ["freeze-candidate", stage] },
      },
    ]);
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    try {
      registry.restore();
      await registry.probeAll();
      assert.deepEqual(registry.unresolved().map((item: { state: string; restored: boolean }) => [item.state, item.restored]), [["running-direct", true]], "the operation is still on the record");
      assert.ok(
        logged.some((line) => /no process probe is available/.test(line) && /before the reload/.test(line)),
        `and the log says why nothing here can settle it, got ${JSON.stringify(logged)}`,
      );
      const refused = await runner.run({
        configured: "/venv/bin/sparring",
        args: ["freeze-candidate", stage],
        cwd,
        name: "freeze-candidate (after the reload)",
        operation: { subcommand: "freeze-candidate", target: stage },
      });
      assert.equal(refused.ok, false, "so a duplicate is refused");
      assert.ok(refused.ok ? false : refused.submission, "and the person is offered the override, which is the only way out here");
      assert.equal(refused.ok ? undefined : refused.submission?.directPid, 2147480002, "named as the process it is about");
      assert.equal(terminals.acquired.length, 0, "nothing was acquired for it");

      const held = registry.inFlightFor(key);
      assert.ok(held, "the record is there to be overridden");
      assert.equal(registry.override(held.id, "the person confirmed that the process is over").overridden, true, "the override applies to a restored process, not only to a shell submission");
      assert.deepEqual(registry.unresolved(), [], "after which the operation may be run again");
      assert.ok(logged.some((line) => /resolved as human-override/.test(line)), "recorded as an override, not as evidence");
    } finally {
      registry.dispose();
    }
  });

  it("keeps refusing a runner whose dedicated terminal survived the reload, from its own persisted launch", async () => {
    const kept = store();
    const logged: string[] = [];
    const runId = "plan-run-dedicated";
    const options = {
      configured: process.execPath,
      args: ["run-plan", "--manifest", "/store/manifests/foo.manifest.json"],
      cwd: os.tmpdir(),
      name: "run-plan",
      runId,
      kind: "run-plan" as const,
      manifest: "/store/manifests/foo.manifest.json",
      reveal: false,
    };

    // ---- the window that starts it -------------------------------------
    const before: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const firstPool = pool();
    const firstTracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], firstPool as never, before);
    const launched = firstTracker.launch(options);
    await waitingForIntegration();
    firstPool.acquired[0].dispose(); // no shell integration: the dedicated terminal is used
    const result = await launched;
    assert.equal(result.ok, true, "the runner was started in a dedicated terminal");
    assert.equal(result.ok ? result.via : undefined, "terminal");
    assert.equal(stub.window.created.length, 1, "exactly one dedicated terminal");
    const dedicated = stub.window.terminals[stub.window.terminals.length - 1];
    await until(() => (kept.get<{ runId: string; source: string; transport?: string; terminalPid: number }[]>("agentSparring.launches", []).length === 1 ? true : undefined), "the launch to be persisted with its terminal's pid");
    const persistedLaunch = kept.get<{ runId: string; source: string; transport?: string; terminalPid: number }[]>("agentSparring.launches", [])[0];
    assert.equal(persistedLaunch.source, "terminal", "recorded as a process of ours, not as a shell command");
    assert.equal(persistedLaunch.terminalPid, await dedicated.processId);
    assert.equal(persistedLaunch.transport, "dedicated-terminal", "with the transport it is, which no later observation overwrites");
    // The guard is the registry's, as it is for every other transport: one
    // authority answers "would starting this again risk doing it twice".
    const guard = kept.get<{ key: string; state: string; transport: string; terminalPid?: number }[]>(OPERATIONS_KEY, []);
    assert.deepEqual(
      guard.map((item) => [item.key, item.state, item.transport]),
      [[`run:${runId}`, "running-dedicated", "dedicated-terminal"]],
      "and the operation guard is persisted as a dedicated-terminal runner",
    );

    // ---- the reload: VS Code brings the terminal back ------------------
    before.dispose();
    firstTracker.dispose();
    reset();
    const reconnected = new FakeTerminal("Agent Sparring — run-plan", persistedLaunch.terminalPid);
    stub.window.terminals.push(reconnected);
    const after: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const secondPool = pool();
    const tracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], secondPool as never, after);
    try {
      const reattaching = tracker.reattach();
      await until(() => (tracker.executionFor(runId)?.state === "running" ? true : undefined), "the dedicated terminal to be recognised as still running its process");
      const refused = await tracker.launch({ ...options, name: "run-plan (after the reload)" });
      assert.equal(refused.ok, false, "a second command for that run is refused");
      assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");
      assert.match(refused.ok ? "" : refused.error, /same engine operation twice/);
      assert.equal(stub.window.created.length, 0, "no second dedicated terminal was created");
      assert.equal(secondPool.acquired.length, 0, "and no terminal was acquired for it");
      await reattaching;
      assert.equal(after.inFlightFor(`run:${runId}`)?.state, "running-dedicated", "and it is still known to be a dedicated runner");

      // The evidence that ends it is the one it always was: that terminal is
      // gone, and it exists only while its process does.
      reconnected.dispose();
      await until(() => (tracker.executionFor(runId)?.state === "ended" ? true : undefined), "the launch to end when its terminal closes");
      const allowed = tracker.launch({ ...options, name: "run-plan (once the process is over)" });
      await waitingForIntegration();
      assert.equal(secondPool.acquired.length, 1, "after which the operation may be started again");
      secondPool.acquired[0].dispose();
      await allowed;
    } finally {
      tracker.dispose();
      after.dispose();
      for (const terminal of [...stub.window.terminals]) {
        terminal.dispose();
      }
    }
  });
});
