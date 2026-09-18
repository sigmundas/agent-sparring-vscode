/**
 * The duplicate that survived the durable submission record: admission was
 * not atomic.
 *
 * Both transports asked "is there an unresolved submission for this
 * operation?", then resolved an executable, acquired a terminal and waited
 * for shell integration, and only then opened the record. Two invocations
 * that started inside that window — a double click on Accept stage, a
 * keybinding and a button, the Overview and the Command Palette — both found
 * nothing, and both went on to submit the same engine operation. The record
 * they were meant to be protected by was written after the damage was
 * already unavoidable.
 *
 * The fix is a synchronous claim on the operation key, taken as the first
 * thing a launch does (submissionRegistry.ts). These tests hold the first
 * invocation at exactly the point where the second used to get in — the
 * await on shell integration, after the claim and before anything is handed
 * to a shell — let the second one enter, and assert that it obtains nothing:
 * no claim, no terminal, no engine invocation. Then the first is let through
 * and must run exactly once.
 *
 * They exercise the production `ExecutionTracker` and
 * `SparringCommandRunner` over a `vscode` module the test drives
 * (vscodeStub.ts), because the interleaving has to be placed deliberately;
 * the integration suite covers the same two transports against real
 * terminals.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import { FakeTerminal, install, reset, until, type FakeShellIntegration } from "./vscodeStub";

const stub = install();

type Tracker = import("../vscode/executionTracker").ExecutionTracker;
type Runner = import("../vscode/commandRunner").SparringCommandRunner;
type Registry = import("../vscode/submissionRegistry").SubmissionRegistry;

let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let SparringCommandRunner: typeof import("../vscode/commandRunner").SparringCommandRunner;
let SubmissionRegistry: typeof import("../vscode/submissionRegistry").SubmissionRegistry;
let commandKey: typeof import("../vscode/submissionRegistry").commandKey;
let runnerKey: typeof import("../vscode/submissionRegistry").runnerKey;
let SUBMISSIONS_KEY: string;

before(async () => {
  // After install(), so `require("vscode")` inside them resolves to the stub.
  const registry = await import("../vscode/submissionRegistry");
  SubmissionRegistry = registry.SubmissionRegistry;
  commandKey = registry.commandKey;
  runnerKey = registry.runnerKey;
  SUBMISSIONS_KEY = registry.SUBMISSIONS_KEY;
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
  SparringCommandRunner = (await import("../vscode/commandRunner")).SparringCommandRunner;
});

interface Store {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

/** A workspaceState that only has to remember. */
function memento(): Store {
  const store = new Map<string, unknown>();
  return {
    get: <T,>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void store.set(key, value),
    keys: () => [...store.keys()],
  };
}

/**
 * A terminal pool that hands out a fresh terminal every time, so "a second
 * terminal was opened" is visible as a second entry rather than hidden by
 * reuse. Shell integration never appears on its own: the test decides.
 */
function pool(): { acquire: (cwd: string) => unknown; acquired: FakeTerminal[]; discarded: FakeTerminal[]; retired: FakeTerminal[] } {
  const acquired: FakeTerminal[] = [];
  const discarded: FakeTerminal[] = [];
  const retired: FakeTerminal[] = [];
  return {
    acquired,
    discarded,
    retired,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, 4242 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return {
        terminal,
        release: () => undefined,
        discard: () => discarded.push(terminal),
        retire: () => retired.push(terminal),
      };
    },
  };
}

function context(): { workspaceState: Store } {
  return { workspaceState: memento() };
}

/** Waits until the launch under test is parked on the shell-integration event. */
function waitingForIntegration(): Promise<true> {
  return until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to be waiting for shell integration");
}

describe("admission for one operation key is atomic", () => {
  beforeEach(() => reset());

  it("refuses a second runner launch that arrives while the first is being prepared", async () => {
    const logged: string[] = [];
    const ctx = context();
    const registry: Registry = new SubmissionRegistry(ctx as never, (message) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker(ctx as never, (message) => logged.push(message), () => [], terminals as never, registry);
    const runId = "plan-run-1";
    const options = {
      configured: process.execPath,
      args: ["run-plan", "--manifest", "/store/manifests/foo.manifest.json"],
      cwd: os.tmpdir(),
      name: "run-plan (first)",
      runId,
      kind: "run-plan" as const,
      manifest: "/store/manifests/foo.manifest.json",
      reveal: false,
    };
    try {
      // The first invocation, held on the await where the duplicate used to
      // slip in: claimed, but nothing handed to any shell.
      const first = tracker.launch(options);
      await waitingForIntegration();
      assert.equal(terminals.acquired.length, 1, "one terminal was acquired");
      assert.equal(registry.unresolvedFor(runnerKey(runId)), undefined, "nothing has been submitted to a shell yet");
      assert.equal(registry.inFlightFor(runnerKey(runId))?.state, "reserved", "but the operation is claimed");
      assert.deepEqual(registry.unresolved(), [], "and a reservation is not an unresolved submission");
      assert.equal(ctx.workspaceState.get(SUBMISSIONS_KEY, undefined), undefined, "nor is it persisted: nothing could execute after a reload");

      // The second invocation enters now.
      const second = await tracker.launch({ ...options, name: "run-plan (second)" });
      assert.equal(second.ok, false, "the second invocation is refused");
      assert.equal(second.ok ? undefined : second.problem, "unconfirmed");
      assert.match(second.ok ? "" : second.error, /already starting/, "and told that this window is already starting it");
      assert.equal(second.ok ? undefined : second.submission, undefined, "with nothing for a person to override: no shell has anything");
      assert.equal(terminals.acquired.length, 1, "no second terminal was acquired");
      assert.equal(stub.window.created.length, 0, "and no dedicated terminal was created either");
      assert.equal(terminals.acquired[0].executions.length, 0, "and nothing has been handed to a shell at all");

      // The first is let through: exactly one command line, exactly once.
      const integration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the first launch to hand its command to the shell");
      assert.equal(integration.executed.length, 1, "exactly one engine invocation");
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      const result = await first;
      assert.equal(result.ok, true, "and it is a launch");
      assert.equal(result.ok ? result.via : undefined, "shell");
      assert.equal(tracker.executionFor(runId)?.state, "running");
      assert.deepEqual(registry.unresolved(), [], "the submission was resolved by its own start");
      assert.equal(integration.executed.length, 1, "still exactly one engine invocation");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });

  it("refuses a second freeze-candidate that arrives while the first is being prepared", async () => {
    const logged: string[] = [];
    const ctx = context();
    const registry: Registry = new SubmissionRegistry(ctx as never, (message) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const stage = "stage-4-editor-and-ui-inspection";
    const cwd = os.tmpdir();
    const options = {
      configured: process.execPath,
      args: ["freeze-candidate", stage],
      cwd,
      name: "freeze-candidate (first)",
      operation: { subcommand: "freeze-candidate", target: stage },
    };
    try {
      const first = runner.run(options);
      await waitingForIntegration();
      const key = commandKey(cwd, "freeze-candidate", stage);
      assert.equal(registry.inFlightFor(key)?.state, "reserved", "the operation is claimed before anything else happens");
      assert.equal(registry.unresolvedFor(key), undefined, "and no shell has been given anything");

      const second = await runner.run({ ...options, name: "freeze-candidate (second)" });
      assert.equal(second.ok, false, "the second freeze-candidate is refused");
      assert.equal(second.ok ? undefined : second.problem, "unconfirmed");
      assert.equal(terminals.acquired.length, 1, "no second terminal was acquired");
      assert.equal(terminals.acquired[0].executions.length, 0, "and nothing was handed to a shell");

      const integration: FakeShellIntegration = terminals.acquired[0].integrate();
      const execution = await until(() => terminals.acquired[0].executions[0], "the first command to be handed to the shell");
      assert.deepEqual(
        integration.executed.map((line) => line.includes("freeze-candidate")),
        [true],
        "exactly one freeze-candidate reached the shell",
      );
      stub.window.startEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution });
      // Only once the command runner is waiting for the end: a shell that
      // reports an end nobody is listening for is a different scenario.
      await until(() => (stub.window.endEmitter.waiting >= 2 ? true : undefined), "the command runner to wait for the execution to end");
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: integration, execution, exitCode: 0 });
      const result = await first;
      assert.equal(result.ok, true, "the first command ran");
      assert.equal(result.ok ? result.outcome.exitCode : undefined, 0);
      assert.equal(integration.executed.length, 1, "and the engine was invoked exactly once");
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });

  it("refuses a second short command while the first is running as a direct process", async (t) => {
    if (process.platform === "win32") {
      t.skip("the fake executable is a POSIX shell script");
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-admission-"));
    const calls = path.join(dir, "calls.log");
    const script = path.join(dir, "sparring");
    await fs.writeFile(script, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nsleep 1\n`);
    await fs.chmod(script, 0o755);

    const logged: string[] = [];
    const ctx = context();
    const registry: Registry = new SubmissionRegistry(ctx as never, (message) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const stage = "stage-4-editor-and-ui-inspection";
    const key = commandKey(dir, "freeze-candidate", stage);
    const options = {
      configured: script,
      args: ["freeze-candidate", stage],
      cwd: dir,
      name: "freeze-candidate (direct, first)",
      operation: { subcommand: "freeze-candidate", target: stage },
    };
    try {
      const first = runner.run(options);
      await waitingForIntegration();
      // This shell will never report integration: its terminal is gone. The
      // command runner therefore falls back to a direct child process.
      terminals.acquired[0].dispose();
      await until(() => (registry.inFlightFor(key)?.state === "direct" ? true : undefined), "the command to fall back to a direct process");
      const firstCall = await until(async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim() || undefined, "the direct process to record its call");
      assert.equal(firstCall, `freeze-candidate ${stage}`);
      assert.deepEqual(registry.unresolved(), [], "a direct process this window is waiting on is not something it cannot account for");
      // It *is* persisted, with what identifies it: such a child survives a
      // window reload (directExecutionSurvival.test.ts), and the window that
      // comes back must refuse the duplicate (directExecutionReload.test.ts).
      assert.deepEqual(
        (ctx.workspaceState.get(SUBMISSIONS_KEY, []) as { key: string; direct?: { pid: number } }[]).map((item) => [item.key, typeof item.direct?.pid]),
        [[key, "number"]],
        "and is persisted with its pid",
      );

      // The second invocation, while that process is still running.
      const second = await runner.run({ ...options, name: "freeze-candidate (direct, second)" });
      assert.equal(second.ok, false, "the second invocation cannot reach execFile");
      assert.equal(second.ok ? undefined : second.problem, "unconfirmed");
      assert.match(second.ok ? "" : second.error, /already running/);

      const result = await first;
      assert.equal(result.ok, true, "the first one ran to completion");
      assert.equal(result.ok ? result.via : undefined, "process");
      assert.equal(result.ok ? result.outcome.exitCode : undefined, 0);
      assert.deepEqual((await fs.readFile(calls, "utf8")).trim().split("\n"), [`freeze-candidate ${stage}`], "exactly one engine invocation");

      // And the claim was given up when the process ended, so the operation
      // can be done again deliberately.
      assert.equal(registry.inFlightFor(key), undefined, "the claim is released with the process");
      const retry = runner.run({ ...options, name: "freeze-candidate (direct, deliberate retry)" });
      await waitingForIntegration();
      terminals.acquired[terminals.acquired.length - 1].dispose();
      const again = await retry;
      assert.equal(again.ok, true, "a later, deliberate run is admitted");
      assert.deepEqual(
        (await fs.readFile(calls, "utf8")).trim().split("\n"),
        [`freeze-candidate ${stage}`, `freeze-candidate ${stage}`],
        "and runs the engine once more, as asked",
      );
    } finally {
      runner.dispose();
      registry.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the durable record when a shell has been given the command, and only then", async () => {
    const logged: string[] = [];
    const ctx = context();
    const registry: Registry = new SubmissionRegistry(ctx as never, (message) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const tracker: Tracker = new ExecutionTracker(ctx as never, (message) => logged.push(message), () => [], terminals as never, registry);
    const runId = "plan-run-2";
    const key = runnerKey(runId);
    try {
      const launching = tracker.launch({
        configured: process.execPath,
        args: ["run-loop", "stage-1", "--repo-root", os.tmpdir()],
        cwd: os.tmpdir(),
        name: "run-loop",
        runId,
        kind: "run-loop",
        stageId: "stage-1",
        reveal: false,
      });
      await waitingForIntegration();
      terminals.acquired[0].integrate();
      await until(() => terminals.acquired[0].executions[0], "the command to be handed to the shell");
      // Handed over and not reported: this is the durable state, unchanged.
      const submitted = await until(() => registry.unresolvedFor(key), "the submission to be on the durable record");
      assert.equal(submitted.state, "waiting");
      assert.deepEqual((ctx.workspaceState.get(SUBMISSIONS_KEY, []) as { key: string }[]).map((item) => item.key), [key], "and persisted, so a reload still refuses a duplicate");
      // A person cannot be asked about a reservation, but can about this.
      assert.equal(registry.override(key, "the person checked the terminal"), true);
      const settled = await launching;
      assert.equal(settled.ok, false, "and the caller that was waiting for the shell is told, not left hanging");
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  });
});
