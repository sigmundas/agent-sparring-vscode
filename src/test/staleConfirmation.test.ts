/**
 * "I checked — runner is no longer active" settles what the person was
 * looking at, and nothing else.
 *
 * The control is rendered from one execution and one operation, and it is
 * clicked some time later. In between, that operation can end and the *next*
 * run for the same run id can take the same operation key — `run:<runId>` is
 * one guard per run, deliberately reused. The confirmation used to:
 *
 *  1. check the exact execution id (correct), and then
 *  2. look the guard up afresh by runner key and override whatever it found.
 *
 * So a stale panel released a live newer operation's guard, and a duplicate
 * engine command became admissible over a runner that had only just started.
 *
 * Both identities are now the panel's own, and a stale confirmation is inert:
 * it reports truthfully that nothing was changed.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import { FakeTerminal, install, reset, until } from "./vscodeStub";

const stub = install();

type Registry = import("../vscode/operationRegistry").OperationRegistry;
type Runner = import("../vscode/commandRunner").SparringCommandRunner;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let SparringCommandRunner: typeof import("../vscode/commandRunner").SparringCommandRunner;
let commandKey: typeof import("../vscode/operationRegistry").commandKey;
let releaseGuardOnConfirmedInactive: typeof import("../vscode/controller").releaseGuardOnConfirmedInactive;

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  commandKey = registry.commandKey;
  SparringCommandRunner = (await import("../vscode/commandRunner")).SparringCommandRunner;
  releaseGuardOnConfirmedInactive = (await import("../vscode/controller")).releaseGuardOnConfirmedInactive;
});

interface Store {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

function store(): Store {
  const kept = new Map<string, unknown>();
  return {
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void (value === undefined ? kept.delete(key) : kept.set(key, value)),
    keys: () => [...kept.keys()],
  };
}

function pool(): { acquire: (cwd: string) => unknown; acquired: FakeTerminal[] } {
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

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the command to wait for shell integration");

describe("a confirmation for an execution that has been superseded changes nothing", () => {
  beforeEach(() => reset());

  const cwd = path.join(os.tmpdir(), "agent-sparring-stale-confirmation");
  const stage = "stage-4";
  const options = {
    configured: process.execPath,
    args: ["freeze-candidate", stage, "--repo-root", cwd],
    cwd,
    name: "freeze-candidate",
    operation: { subcommand: "freeze-candidate", target: stage },
  };

  it("A is resolved, B takes the same key, and confirming A's panel leaves B guarded", async () => {
    const logged: string[] = [];
    const registry: Registry = new OperationRegistry({ workspaceState: store() } as never, (message: string) => logged.push(message), () => false, async () => []);
    const terminals = pool();
    const runner: Runner = new SparringCommandRunner((message) => logged.push(message), terminals as never, registry);
    const key = commandKey(cwd, "freeze-candidate", stage);
    try {
      // A is submitted and never reported as started, which is exactly the
      // state the recovery control is rendered for. Its id is what the panel
      // carries from that moment on.
      const firstRun = runner.run({ ...options, name: "freeze-candidate (A)" });
      await waitingForIntegration();
      const firstIntegration = terminals.acquired[0].integrate();
      const firstExecution = await until(() => terminals.acquired[0].executions[0], "A to be handed to the shell");
      const a = await firstRun;
      assert.equal(a.ok, false);
      const panelOperationId = a.ok ? undefined : a.submission?.id;
      assert.ok(panelOperationId, "the panel was rendered from A's exact operation id");

      // A ends, by the one thing that ends it: its own execution.
      stub.window.endEmitter.fire({ terminal: terminals.acquired[0], shellIntegration: firstIntegration, execution: firstExecution, exitCode: 0 });
      await until(() => (registry.inFlightFor(key) === undefined ? true : undefined), "A to be resolved by its own execution ending");

      // B is the next freeze-candidate for the same stage: a different
      // operation, with the same key.
      const secondRun = runner.run({ ...options, name: "freeze-candidate (B)" });
      await waitingForIntegration();
      const secondIntegration = terminals.acquired[1].integrate();
      const secondExecution = await until(() => terminals.acquired[1].executions[0], "B to be handed to the shell");
      const b = await until(() => registry.inFlightFor(key), "B to hold the key");
      assert.notEqual(b.id, panelOperationId, "B is a different record with the same key");

      // The person clicks the control the stale panel is still showing. The
      // execution it names is gone, so nothing is confirmed — and nothing is
      // released.
      const stale = releaseGuardOnConfirmedInactive({ confirmed: false }, panelOperationId, (id, note) => registry.override(id, note));
      assert.equal(stale.overrode, false, "no guard was released");
      assert.equal(stale.untouched, "the execution that confirmation was about is not the one this run is waiting on");
      assert.equal(registry.inFlightFor(key)?.id, b.id, "B still holds the guard");

      // And even if that confirmation had succeeded — an execution record for
      // A still being around — the override is by A's id, so B is untouched.
      const byIdentity = releaseGuardOnConfirmedInactive({ confirmed: true }, panelOperationId, (id, note) => registry.override(id, note));
      assert.equal(byIdentity.overrode, false, "A cannot be overridden: it is already resolved");
      assert.equal(byIdentity.untouched, "that operation had already been resolved");
      assert.equal(registry.inFlightFor(key)?.id, b.id, "and B is still guarded, which is the whole point");
      assert.ok(!logged.some((line) => /resolved as human-override/.test(line)), "nothing was recorded as an override");

      // B is settled only as itself.
      const forB = releaseGuardOnConfirmedInactive({ confirmed: true }, b.id, (id, note) => registry.override(id, note));
      assert.deepEqual(forB, { overrode: true });
      assert.equal(registry.inFlightFor(key), undefined);
      assert.ok(logged.some((line) => /resolved as human-override/.test(line)), "and that one is recorded as the person's");

      stub.window.endEmitter.fire({ terminal: terminals.acquired[1], shellIntegration: secondIntegration, execution: secondExecution, exitCode: 0 });
      await secondRun.catch(() => undefined);
    } finally {
      runner.dispose();
      registry.dispose();
    }
  });

  it("a panel that carried no operation id releases nothing, and says so", () => {
    const released = releaseGuardOnConfirmedInactive({ confirmed: true }, undefined, () => {
      throw new Error("no override may be attempted when the panel named no operation");
    });
    assert.deepEqual(released, { overrode: false, untouched: "the panel named no operation, so there was nothing to take responsibility for" });
  });
});
