/**
 * At most one reusable Agent Sparring terminal per worktree.
 *
 * Observed in real use: about twenty "Agent Sparring — …" terminals. The
 * Output logs showed why — every one was opened because the pool had no
 * terminal for that repository, which is the state after each window reload
 * (the pool starts empty, and VS Code restores the old terminals, which are
 * never reused). One window had fourteen extension-host sessions in a day.
 *
 * These tests drive the production `SparringCommandRunner`, `TerminalPool`
 * and `OperationRegistry` over the vscode stub, and count terminals.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { FakeExecution, FakeShellIntegration, FakeTerminal, install, reset, until } from "./vscodeStub";

const stub = install();

type Runner = import("../vscode/commandRunner").SparringCommandRunner;
type Pool = import("../vscode/terminalPool").TerminalPool;
type Registry = import("../vscode/operationRegistry").OperationRegistry;
type ProcessInfo = import("../core/processTree").ProcessInfo;

let SparringCommandRunner: typeof import("../vscode/commandRunner").SparringCommandRunner;
let TerminalPool: typeof import("../vscode/terminalPool").TerminalPool;
let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;

before(async () => {
  SparringCommandRunner = (await import("../vscode/commandRunner")).SparringCommandRunner;
  TerminalPool = (await import("../vscode/terminalPool")).TerminalPool;
  OperationRegistry = (await import("../vscode/operationRegistry")).OperationRegistry;
});

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T,>(key: string, fallback?: T) => (store.has(key) ? (store.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void store.set(key, value),
    keys: () => [...store.keys()],
  };
}

interface Host {
  runner: Runner;
  pool: Pool;
  registry: Registry;
  logged: string[];
  dispose(): void;
}

/** A window: its pool sees whatever terminals already exist, as after a reload. */
function host(table: () => ProcessInfo[] = () => []): Host {
  const logged: string[] = [];
  const log = (message: string) => logged.push(message);
  const registry = new OperationRegistry({ workspaceState: memento() } as never, log, () => false, async () => []);
  const pool = new TerminalPool(log, async () => table(), true);
  const runner = new SparringCommandRunner(log, pool, registry);
  return { runner, pool, registry, logged, dispose: () => (runner.dispose(), pool.dispose(), registry.dispose()) };
}

/** Terminals a previous window left; their shells are the test's to describe, never integrated here. */
const restoredTerminals = new WeakSet<FakeTerminal>();
const handled = new Map<FakeTerminal, number>();

/** Play the shell's part for one command: integrate a new terminal, report the start and the end. */
async function complete(result: Promise<unknown>, exitCode = 0): Promise<{ terminal: FakeTerminal; result: Awaited<typeof result> }> {
  const terminal = await until(() => {
    for (const candidate of stub.window.terminals) {
      if (!candidate.shellIntegration && candidate.exitStatus === undefined && !restoredTerminals.has(candidate)) {
        candidate.integrate();
      }
    }
    return stub.window.terminals.find((candidate) => candidate.executions.length > (handled.get(candidate) ?? 0));
  }, "a command to be handed to a shell");
  handled.set(terminal, terminal.executions.length);
  const execution = terminal.executions[terminal.executions.length - 1];
  const base = stub.window.endEmitter.waiting;
  stub.window.startEmitter.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution });
  await until(() => (stub.window.endEmitter.waiting > base ? true : undefined), "the runner to wait for the end");
  stub.window.endEmitter.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution, exitCode });
  return { terminal, result: await result };
}

function run(h: Host, cwd: string, subcommand: string, target = "x") {
  return h.runner.run({ configured: "/usr/bin/true", args: [subcommand, target], cwd, name: subcommand, operation: { subcommand, target } });
}

/** A terminal an earlier window opened for `cwd`, restored by VS Code. */
function restored(cwd: string, pid: number): FakeTerminal {
  const terminal = new FakeTerminal(`Agent Sparring — ${path.basename(cwd)}`, pid);
  terminal.creationOptions = { name: terminal.name, cwd };
  terminal.shellIntegration = new FakeShellIntegration(terminal);
  stub.window.terminals.push(terminal);
  restoredTerminals.add(terminal);
  return terminal;
}

let py: string;
let web: string;

describe("one reusable terminal per worktree", () => {
  before(async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-terminals-")));
    py = path.join(base, "sporely-py");
    web = path.join(base, "sporely-web");
    await fs.mkdir(py);
    await fs.mkdir(web);
  });
  beforeEach(() => {
    reset();
    handled.clear();
  });

  it("prepare-plan, approve-plan and a stage command in one worktree use one terminal, never revealed", async () => {
    const h = host();
    try {
      const a = await complete(run(h, py, "prepare-plan", "plan.md"));
      const b = await complete(run(h, py, "approve-plan", "run_3r"));
      const c = await complete(run(h, py, "freeze-candidate", "stage-3r"));
      assert.equal(stub.window.created.length, 1, "one terminal for the worktree");
      assert.equal(a.terminal, b.terminal);
      assert.equal(b.terminal, c.terminal);
      assert.equal(a.terminal.name, `Agent Sparring — sporely-py`, "a stable, boring name");
      assert.equal(a.terminal.shown, 0, "routine commands never reveal the Terminal panel");
      assert.ok(h.logged.includes("terminal reused: Agent Sparring — sporely-py"));
      assert.equal(h.registry.active().length, 0, "a completed operation is no longer active");
      assert.equal(h.registry.lastSettled(py)?.exitCode, 0);
    } finally {
      h.dispose();
    }
  });

  it("different worktrees get their own terminal", async () => {
    const h = host();
    try {
      const a = await complete(run(h, py, "approve-plan"));
      const b = await complete(run(h, web, "approve-plan"));
      await complete(run(h, py, "approve-plan", "y"));
      assert.notEqual(a.terminal, b.terminal);
      assert.equal(stub.window.created.length, 2);
    } finally {
      h.dispose();
    }
  });

  it("a second command in a worktree that is running one is refused, not given a second terminal", async () => {
    const h = host();
    try {
      const first = run(h, py, "prepare-plan", "plan.md");
      await until(() => (stub.window.created.length > 0 ? true : undefined), "the first to reach its terminal");
      const second = await run(h, py, "approve-plan", "run_3r");
      assert.equal(second.ok, false);
      assert.match(second.ok ? "" : second.error, /^Agent Sparring is already running prepare-plan in sporely-py\./);
      assert.ok(h.logged.includes("approve-plan sporely-py: not started; prepare-plan is already running"));
      assert.equal(stub.window.created.length, 1, "no second terminal");
      await complete(first);
      const other = await complete(run(h, web, "approve-plan"));
      assert.equal(other.result && (other.result as { ok: boolean }).ok, true, "another worktree is independent");
    } finally {
      h.dispose();
    }
  });

  it("a failed command keeps its terminal, and the retry reuses it", async () => {
    const h = host();
    try {
      const failed = await complete(run(h, py, "approve-plan"), 1);
      assert.equal(h.registry.lastSettled(py)?.exitCode, 1);
      const retry = await complete(run(h, py, "approve-plan"));
      assert.equal(retry.terminal, failed.terminal);
      assert.equal(failed.terminal.exitStatus, undefined, "not closed");
      assert.equal(stub.window.created.length, 1);
    } finally {
      h.dispose();
    }
  });

  it("after a reload an old terminal of unknown liveness is left alone; one new terminal serves every later command", async () => {
    const old = restored(py, 5001);
    // Its shell has a child process: something is running in it.
    const h = host(() => [
      { pid: 5001, ppid: 1, command: "-zsh" },
      { pid: 5002, ppid: 5001, command: "python sparring run-plan" },
    ]);
    try {
      const first = await complete(run(h, py, "prepare-plan"));
      const second = await complete(run(h, py, "approve-plan"));
      const third = await complete(run(h, py, "freeze-candidate"));
      assert.equal(stub.window.created.length, 1, "exactly one current terminal was opened");
      assert.equal(first.terminal, second.terminal);
      assert.equal(second.terminal, third.terminal);
      assert.notEqual(first.terminal, old);
      assert.equal(old.executions.length, 0, "nothing was written into the old terminal");
      assert.equal(old.exitStatus, undefined, "and it was not closed");
    } finally {
      h.dispose();
    }
  });

  it("after a reload an old terminal whose shell is proven idle is adopted instead of opening another", async () => {
    const old = restored(py, 5001);
    const h = host(() => [{ pid: 5001, ppid: 1, command: "-zsh" }]);
    try {
      const first = await complete(run(h, py, "prepare-plan"));
      assert.equal(first.terminal, old);
      assert.equal(stub.window.created.length, 0);
      assert.ok(h.logged.some((line) => line.startsWith("terminal adopted after reload: Agent Sparring — sporely-py")));
    } finally {
      h.dispose();
    }
  });

  it("an old terminal the registry still attributes an operation to is never adopted", async () => {
    restored(py, 5001);
    const h = host(() => [{ pid: 5001, ppid: 1, command: "-zsh" }]);
    try {
      await h.pool.reconcile(py, new Set([5001]));
      assert.deepEqual(h.pool.owned(), [], "claimed by an operation: left an orphan");
    } finally {
      h.dispose();
    }
  });

  it("the dogfood sequence: reload, prepare, approve, run, switch repo, approve — bounded by worktrees plus orphans", async () => {
    const orphans = [restored(py, 5001), restored(py, 5003), restored(web, 6001)];
    const busy = (pid: number) => [
      { pid, ppid: 1, command: "-zsh" },
      { pid: pid + 1, ppid: pid, command: "claude" },
    ];
    const h = host(() => [...busy(5001), ...busy(5003), ...busy(6001)]);
    try {
      await complete(run(h, py, "prepare-plan"));
      await complete(run(h, py, "approve-plan", "run_3r"));
      await complete(run(h, py, "freeze-candidate", "stage-3r"));
      await complete(run(h, web, "approve-plan", "run_3s"));
      await complete(run(h, web, "freeze-candidate", "stage-3s"));
      assert.equal(stub.window.created.length, 2, "one current terminal per worktree");
      assert.equal(stub.window.terminals.length, orphans.length + 2);
      assert.ok(stub.window.terminals.every((terminal) => terminal.shown === 0));
    } finally {
      h.dispose();
    }
  });

  it("Show terminal reveals this worktree's terminal and no other", async () => {
    const h = host();
    try {
      const a = await complete(run(h, py, "approve-plan"));
      const b = await complete(run(h, web, "approve-plan"));
      assert.equal(h.pool.reveal(web), true);
      assert.equal(b.terminal.shown, 1);
      assert.equal(a.terminal.shown, 0);
    } finally {
      h.dispose();
    }
  });

  it("a concurrent terminal takes the lowest name no open terminal uses, never a duplicate", async () => {
    const h = host();
    const occupy = (terminal: FakeTerminal) => {
      // Typed by the person, so not one of the executions this suite plays.
      const execution = new FakeExecution("vim", terminal);
      stub.window.startEmitter.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution });
    };
    try {
      const base = `Agent Sparring — sporely-py`;
      const a = await complete(run(h, py, "prepare-plan"));
      assert.equal(a.terminal.name, base);
      occupy(a.terminal); // the person runs something of their own in it
      const b = await complete(run(h, py, "approve-plan"));
      assert.equal(b.terminal.name, `${base} (2)`);
      // The person closes the first one, then occupies the second.
      a.terminal.close();
      occupy(b.terminal);
      const c = await complete(run(h, py, "freeze-candidate"));
      assert.notEqual(c.terminal, b.terminal);
      const open = stub.window.terminals.filter((terminal) => terminal.exitStatus === undefined).map((terminal) => terminal.name);
      assert.equal(new Set(open).size, open.length, `no two open terminals share a name, got ${JSON.stringify(open)}`);
      assert.equal(c.terminal.name, base, "the lowest free name is reused");
    } finally {
      h.dispose();
    }
  });

  it("Clean Up Terminals: ended and idle redundant are closed, active and current are kept, unknown is only listed", async () => {
    const ended = restored(py, 7001);
    ended.exitStatus = { code: 0 };
    // Another worktree's: in sporely-py it would be adopted as the current one.
    const idleOrphan = restored(web, 7002);
    const busyOrphan = restored(web, 7003);
    const claimed = restored(web, 7005);
    const noIntegration = restored(web, 7006);
    noIntegration.shellIntegration = undefined;
    const table = [
      { pid: 7002, ppid: 1, command: "-zsh" },
      { pid: 7003, ppid: 1, command: "-zsh" },
      { pid: 7004, ppid: 7003, command: "python sparring run-plan" },
      { pid: 7005, ppid: 1, command: "-zsh" },
      { pid: 7006, ppid: 1, command: "-zsh" },
    ];
    const h = host(() => table);
    try {
      // The current reusable terminal for sporely-py, opened in this window.
      const current = await complete(run(h, py, "approve-plan"));
      const result = await h.pool.cleanUp(new Set([7005]));
      assert.deepEqual(result.closed.map((entry) => entry.reason).sort(), ["ended", "idle and redundant (its shell has no running child process)"]);
      assert.equal(current.terminal.creationOptions.cwd, py);
      assert.equal(idleOrphan.exitStatus?.code, 0, "idle redundant (ps proves its shell idle): closed");
      assert.equal(busyOrphan.exitStatus, undefined, "a process is running in it: never closed");
      assert.equal(current.terminal.exitStatus, undefined, "the current reusable terminal is kept");
      assert.ok(result.kept.some((entry) => entry.reason === "current reusable terminal for its worktree"));
      // A pid an operation still claims is known to be busy: kept, never
      // offered for closing alongside the genuinely unknown ones.
      assert.ok(result.kept.some((entry) => entry.name === claimed.name && entry.reason === "an Agent Sparring operation is still running in it"));
      assert.deepEqual(result.unknown, [noIntegration], "only unknown liveness is listed, not closed");
      assert.equal(claimed.exitStatus, undefined);
      assert.equal(noIntegration.exitStatus, undefined);
      assert.deepEqual(h.pool.closeConfirmed(result.unknown).length, 1, "closed only once a person confirms");
      assert.equal(claimed.exitStatus, undefined, "confirming the unknown ones never closes the claimed one");
      assert.equal((noIntegration.exitStatus as { code?: number } | undefined)?.code, 0);
    } finally {
      h.dispose();
    }
  });

  it("a terminal seen running a command is kept, even without a process table or with a claimed pid", async () => {
    const busyNoTable = restored(py, 8101);
    const busyClaimed = restored(web, 8102);
    const quiet = restored(web, 8103);
    const logged: string[] = [];
    const pool = new TerminalPool((m) => logged.push(m), async () => [], false);
    try {
      for (const terminal of [busyNoTable, busyClaimed]) {
        const execution = terminal.shellIntegration!.executeCommand("npm", ["test"]);
        stub.window.startEmitter.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution });
      }
      const result = await pool.cleanUp(new Set([8102]));
      assert.deepEqual(result.closed, []);
      assert.deepEqual(result.unknown, [quiet], "only the one nothing is known about is offered");
      assert.deepEqual(
        result.kept.map((entry) => [entry.name, entry.reason]),
        [
          [busyNoTable.name, "a command is running in it"],
          [busyClaimed.name, "a command is running in it"],
        ],
      );
    } finally {
      pool.dispose();
    }
  });

  it("without a process table every old terminal is unknown, and nothing is closed silently", async () => {
    const a = restored(py, 8001);
    const b = restored(web, 8002);
    const logged: string[] = [];
    const registry = new OperationRegistry({ workspaceState: memento() } as never, (m: string) => logged.push(m), () => false, async () => []);
    const pool = new TerminalPool((m) => logged.push(m), async () => [], false);
    try {
      const result = await pool.cleanUp();
      assert.deepEqual(result.closed, []);
      assert.deepEqual(new Set(result.unknown), new Set([a, b]));
      await pool.reconcile(py);
      assert.deepEqual(pool.owned(), [], "and none is adopted either");
    } finally {
      pool.dispose();
      registry.dispose();
    }
  });
});
