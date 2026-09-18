/**
 * A process running the same command is not this operation's process.
 *
 * The previous repair of "a shell that took a command may already have run
 * it" searched the *whole process table* for a submitted command once its
 * shell was gone, and adopted whatever matched as the operation's engine pid.
 * A review of the same branch reproduced four ways that is unsafe, and all
 * four are here:
 *
 *  A. **the shell's pid was never recorded.** The shell may be perfectly
 *     alive and still holding the line. "I cannot establish ancestry" was
 *     being read as "the shell is gone", which widened the search to the
 *     whole table for no reason at all.
 *  B. **a candidate older than the hand-over.** A process born roughly a year
 *     before the durable intent was written was recorded as this operation's
 *     engine pid. It is plainly not this launch.
 *  C. **two byte-identical candidates.** The first row of the table was
 *     silently taken. Ambiguity is not identity.
 *  D. **another window.** Two windows can hold independent operation records
 *     for the same repository and hand over byte-identical command lines, so
 *     executable plus exact argv plus cwd cannot say whose process this is.
 *
 * What makes all four the same defect is what happens *after* the wrong
 * process is adopted: its exit becomes `engine-process-gone` and releases our
 * guard, over a command of ours that may still be queued or running. Positive
 * evidence about a different process is not evidence about this operation.
 *
 * So the only automatic way out of `submitted-shell` is a process that is
 * causally tied to this hand-over: a descendant of the shell this window gave
 * the line to, while that shell is alive, uniquely, and not older than the
 * intent. Everything else keeps the guard until a person settles that exact
 * operation id — which is (F) below.
 *
 * The other half of the rule, that an identity established *before*
 * observation was lost is still followed safely afterwards (including through
 * the shell dying and the engine being reparented to pid 1), is asserted in
 * src/test/submittedCommandSurvivesLostObservation.test.ts, cases 2a and 2b.
 */

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import type { ProcessInfo } from "../core/processTree";
import { install, reset } from "./vscodeStub";

install();

type Registry = import("../vscode/operationRegistry").OperationRegistry;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let admissionRefusal: typeof import("../vscode/operationRegistry").admissionRefusal;
let commandKey: typeof import("../vscode/operationRegistry").commandKey;
let runnerKey: typeof import("../vscode/operationRegistry").runnerKey;
let OPERATIONS_KEY: string;

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  admissionRefusal = registry.admissionRefusal;
  commandKey = registry.commandKey;
  runnerKey = registry.runnerKey;
  OPERATIONS_KEY = registry.OPERATIONS_KEY;
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

/**
 * A birth time in the exact shape `ps -o lstart=` prints (`Thu Sep 18
 * 11:12:13 2026`), written from a real instant because a candidate's age
 * relative to the hand-over is part of what is under test.
 */
function psStart(atMs: number): string {
  const at = new Date(atMs);
  const [weekday, month, day] = at.toDateString().split(" ");
  return `${weekday} ${month} ${day} ${at.toTimeString().slice(0, 8)} ${at.getFullYear()}`;
}

const repo = "/code/sporely-py";
const engineWord = "/venv/bin/sparring";
const stage = "stage-7-reported-statistics";
const loopArgs = ["run-loop", stage, "--repo-root", repo, "--expected-branch", "main"];
const loopRunId = `${repo}|stage:${stage}`;
const engineCommand = `${engineWord} ${loopArgs.join(" ")}`;

/**
 * A run-loop the previous window handed to a shell, with whatever is known
 * about that shell. `terminalPid: undefined` is the real case (A): the record
 * exists, the command was handed over, and `terminal.processId` never
 * answered.
 */
function submittedLoop(options: { terminalPid?: number; armedAtMs?: number } = {}): unknown[] {
  return [
    {
      id: "operation-handed-to-a-shell",
      key: runnerKey(loopRunId),
      state: "submitted-shell",
      transport: "shell",
      caller: "runner",
      label: `run-loop ${stage}`,
      repoRoot: repo,
      cwd: repo,
      subcommand: "run-loop",
      runId: loopRunId,
      runnerKind: "run-loop",
      stageId: stage,
      word: engineWord,
      invocation: { word: engineWord, args: loopArgs, cwd: repo },
      submittedAtMs: options.armedAtMs ?? Date.now() - 5000,
      terminalPid: options.terminalPid,
      terminalName: "Agent Sparring — sporely-py",
    },
  ];
}

/** Whether a second copy of that same operation would be admitted. */
function wouldAdmit(registry: Registry): { admitted: boolean; refusal: string } {
  const admission = registry.claim({ key: runnerKey(loopRunId), caller: "runner", label: `run-loop ${stage}`, repoRoot: repo, cwd: repo, subcommand: "run-loop", runId: loopRunId, runnerKind: "run-loop", stageId: stage });
  if (admission.admitted) {
    registry.release(admission.claim, "the test only asked whether it would be admitted");
    return { admitted: true, refusal: "" };
  }
  return { admitted: false, refusal: admissionRefusal(admission.blocked) };
}

// ---------------------------------------------------------------------------
// A. the shell's pid was never recorded
// ---------------------------------------------------------------------------

describe("not knowing which shell took the command is not knowing that the shell is gone", () => {
  beforeEach(() => reset());

  it("A. an unrecorded shell pid adopts nothing, even with a matching process in the table", async () => {
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: undefined }) });
    // A shell is alive and may still be holding the line — this window simply
    // does not know which one it is — and a process running exactly this
    // command is in the table. Neither fact ties that process to this
    // hand-over.
    let processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 7200, ppid: 1, command: "-zsh" },
      { pid: 7201, ppid: 7200, command: engineCommand, started: psStart(Date.now() - 1000) },
    ];
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      registry.restore();
      await registry.probeAll();
      await registry.probeAll();

      const held = registry.inFlightFor(runnerKey(loopRunId));
      assert.equal(held?.state, "submitted-shell", "the record stays exactly where it was");
      assert.equal(held?.enginePid, undefined, "no process was adopted as this operation's");
      assert.ok(!held?.observationLost, "and nothing was lost: an unknown pid is not a dead shell");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved");
      assert.ok(
        logged.some((line) => /no process id was recorded for the terminal/.test(line) && /may still be alive and still hold that line/.test(line)),
        `the log says what is actually unknown, got ${JSON.stringify(logged)}`,
      );

      const second = wouldAdmit(registry);
      assert.equal(second.admitted, false, "so a second run-loop for that run is refused");
      assert.match(second.refusal, /has not been able to confirm whether it started/, "and the reason is the honest one");
      assert.doesNotMatch(second.refusal, /has since closed or its shell has gone/, "never a claim that the terminal went away");

      // The matching process ending is not evidence about our operation either.
      processes = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        { pid: 7200, ppid: 1, command: "-zsh" },
      ];
      await registry.probeAll();
      assert.equal(registry.inFlightFor(runnerKey(loopRunId))?.state, "submitted-shell", "a stranger's exit releases nothing");
      assert.deepEqual(resolutions(logged), []);
      assert.equal(wouldAdmit(registry).admitted, false, "and the duplicate is still refused afterwards");
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// B. a candidate older than the hand-over
// ---------------------------------------------------------------------------

describe("a process that was already running before the command was handed over is not that command", () => {
  beforeEach(() => reset());

  it("B. a matching process born a year before the intent is not adopted, under a live shell or a dead one", async () => {
    const shellPid = 7300;
    const armedAtMs = Date.now() - 5000;
    const ancient = psStart(armedAtMs - 365 * 24 * 60 * 60 * 1000);
    for (const shellAlive of [true, false]) {
      const logged: string[] = [];
      const kept = store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: shellPid, armedAtMs }) });
      // The candidate is a descendant of the very shell that took the line —
      // the strongest relation there is — and is still not this launch,
      // because it was there a year before the launch was recorded.
      const processes: ProcessInfo[] = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        ...(shellAlive ? [{ pid: shellPid, ppid: 1, command: "-zsh" }] : []),
        { pid: 7301, ppid: shellAlive ? shellPid : 1, command: engineCommand, started: ancient },
      ];
      const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
      try {
        registry.restore();
        await registry.probeAll();

        const where = shellAlive ? "with the shell alive" : "with the shell gone";
        const held = registry.inFlightFor(runnerKey(loopRunId));
        assert.equal(held?.state, "submitted-shell", `${where}, the record stays where it was`);
        assert.equal(held?.enginePid, undefined, `${where}, no ancient process became this operation's engine pid`);
        assert.deepEqual(resolutions(logged), [], `${where}, nothing was resolved`);
        assert.equal(wouldAdmit(registry).admitted, false, `${where}, a duplicate stays refused`);
        if (shellAlive) {
          assert.ok(
            logged.some((line) => /born before this command was handed over/.test(line)),
            `the log says why the candidate under the shell was rejected, got ${JSON.stringify(logged)}`,
          );
        }
      } finally {
        registry.dispose();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// C. two byte-identical candidates
// ---------------------------------------------------------------------------

describe("two indistinguishable processes are not one identity", () => {
  beforeEach(() => reset());

  it("C. neither of two byte-identical matching processes is adopted, under a live shell or a dead one", async () => {
    const shellPid = 7400;
    for (const shellAlive of [true, false]) {
      const logged: string[] = [];
      const kept = store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: shellPid }) });
      const born = psStart(Date.now() - 1000);
      const processes: ProcessInfo[] = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        ...(shellAlive ? [{ pid: shellPid, ppid: 1, command: "-zsh" }] : []),
        { pid: 7401, ppid: shellAlive ? shellPid : 1, command: engineCommand, started: born },
        { pid: 7402, ppid: shellAlive ? shellPid : 1, command: engineCommand, started: born },
      ];
      const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => processes);
      try {
        registry.restore();
        await registry.probeAll();

        const where = shellAlive ? "with the shell alive" : "with the shell gone";
        const held = registry.inFlightFor(runnerKey(loopRunId));
        assert.equal(held?.state, "submitted-shell", `${where}, the first table row was not silently taken`);
        assert.equal(held?.enginePid, undefined, `${where}, neither pid became this operation's`);
        assert.deepEqual(resolutions(logged), [], `${where}, nothing was resolved`);
        assert.equal(wouldAdmit(registry).admitted, false, `${where}, a duplicate stays refused`);
        if (shellAlive) {
          assert.ok(
            logged.some((line) => /Two indistinguishable processes are not one identity/.test(line) && /7401, 7402/.test(line)),
            `the log names both and says why neither is adopted, got ${JSON.stringify(logged)}`,
          );
        }
      } finally {
        registry.dispose();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// D. another window, for the same repository
// ---------------------------------------------------------------------------

describe("two windows over the same repository cannot answer for each other", () => {
  beforeEach(() => reset());

  it("D. one registry's submitted operation is never bound to the other's process, however identical", async () => {
    // Two windows, two independent workspace states, one repository, and one
    // command line. Window one handed its line to shell 7500 and never saw it
    // start; window two's engine is running as a child of shell 7600. Every
    // field an invocation has — executable, exact argv, cwd — is the same.
    const oneLog: string[] = [];
    const twoLog: string[] = [];
    const shellOne = 7500;
    const shellTwo = 7600;
    let processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: shellOne, ppid: 1, command: "-zsh" },
      { pid: shellTwo, ppid: 1, command: "-zsh" },
      { pid: 7601, ppid: shellTwo, command: engineCommand, started: psStart(Date.now() - 1000) },
    ];
    const one: Registry = new OperationRegistry({ workspaceState: store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: shellOne }) }) } as never, (message: string) => oneLog.push(message), () => true, async () => processes);
    const two: Registry = new OperationRegistry({ workspaceState: store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: shellTwo }) }) } as never, (message: string) => twoLog.push(message), () => true, async () => processes);
    try {
      one.restore();
      two.restore();
      await one.probeAll();
      await two.probeAll();

      // Window two's own shell is running it, so window two is entitled to say so.
      const held2 = two.inFlightFor(runnerKey(loopRunId));
      assert.equal(held2?.state, "running-shell", "ancestry under its own shell is what identifies it");
      assert.equal(held2?.enginePid, 7601, "on that pid");

      // Window one may not borrow it.
      const held1 = one.inFlightFor(runnerKey(loopRunId));
      assert.equal(held1?.state, "submitted-shell", "similarity alone binds nothing across windows");
      assert.equal(held1?.enginePid, undefined, "so window two's process is not window one's engine pid");
      assert.deepEqual(resolutions(oneLog), [], "and window one resolved nothing");
      assert.ok(
        oneLog.some((line) => /nothing under the shell 7500 that took this line/.test(line) && /pid 7601 is running that command line/.test(line)),
        `window one's log names the other window's process as a look-alike, got ${JSON.stringify(oneLog)}`,
      );

      // Window two's run ends. That is evidence for window two only.
      processes = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        { pid: shellOne, ppid: 1, command: "-zsh" },
        { pid: shellTwo, ppid: 1, command: "-zsh" },
      ];
      await two.probeAll();
      await one.probeAll();
      assert.equal(two.inFlightFor(runnerKey(loopRunId)), undefined, "window two's operation is over, on a fact about its own process");
      assert.match(resolutions(twoLog)[0], /resolved as completed \(engine-process-gone\)/);
      assert.equal(one.inFlightFor(runnerKey(loopRunId))?.state, "submitted-shell", "window one's command may still be queued, and stays guarded");
      assert.deepEqual(resolutions(oneLog), [], "the other window's exit released nothing here");
      assert.equal(wouldAdmit(one).admitted, false, "so window one still refuses a duplicate");
    } finally {
      one.dispose();
      two.dispose();
    }
  });

  it("D2. the other window's process is not adopted once this window's own shell has gone either", async () => {
    // The case the whole-table search was introduced for, and the case it got
    // wrong: this window's shell has died, and the only matching process in
    // the table belongs to the other window.
    const logged: string[] = [];
    const shellOne = 7550;
    const shellTwo = 7650;
    let processes: ProcessInfo[] = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: shellTwo, ppid: 1, command: "-zsh" },
      { pid: 7651, ppid: shellTwo, command: engineCommand, started: psStart(Date.now() - 1000) },
    ];
    const one: Registry = new OperationRegistry({ workspaceState: store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: shellOne }) }) } as never, (message: string) => logged.push(message), () => true, async () => processes);
    try {
      one.restore();
      await one.probeAll();

      const held = one.inFlightFor(runnerKey(loopRunId));
      assert.equal(held?.state, "submitted-shell", "a dead shell leaves nothing in the table to bind to");
      assert.equal(held?.enginePid, undefined, "so the other window's engine did not become this operation's");
      assert.equal(held?.observationLost, true, "what was lost is the observation");
      assert.deepEqual(resolutions(logged), []);

      // And the other window's process ending cannot release this guard.
      processes = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        { pid: shellTwo, ppid: 1, command: "-zsh" },
      ];
      await one.probeAll();
      assert.equal(one.inFlightFor(runnerKey(loopRunId))?.state, "submitted-shell", "our command may still be queued somewhere");
      assert.deepEqual(resolutions(logged), [], "nothing was resolved by the other window's exit");
      assert.equal(wouldAdmit(one).admitted, false, "and a duplicate stays refused");
    } finally {
      one.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// F. the way out is a person, on that exact operation id
// ---------------------------------------------------------------------------

describe("an operation nothing can identify is settled by a person, and only for itself", () => {
  beforeEach(() => reset());

  const otherKey = () => commandKey(repo, "freeze-candidate", stage);

  it("F. the exact operation id releases that operation, and a stale confirmation releases nothing", async () => {
    const logged: string[] = [];
    const kept = store({ [OPERATIONS_KEY]: submittedLoop({ terminalPid: 7700 }) });
    // The shell that took it is gone and nothing in the table can be tied to
    // the hand-over: the record is unresolved for good, until a person says
    // otherwise.
    const registry: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => true, async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }, { pid: 7701, ppid: 1, command: engineCommand, started: psStart(Date.now() - 1000) }]);
    try {
      registry.restore();
      // Many rounds: an unresolved record must not drift towards a verdict.
      for (let round = 0; round < 5; round++) {
        await registry.probeAll();
      }
      const held = registry.inFlightFor(runnerKey(loopRunId));
      assert.ok(held, "the restored record is there");
      assert.equal(held.state, "submitted-shell", "repeated probing settles nothing");
      assert.equal(held.observationLost, true);
      assert.deepEqual(resolutions(logged), []);
      assert.equal(wouldAdmit(registry).admitted, false, "and the duplicate stays blocked");

      // Another operation of the same project, so "only that exact one" has
      // something to be true of.
      const other = registry.claim({ key: otherKey(), caller: "command", label: `freeze-candidate ${stage}`, repoRoot: repo, cwd: repo, subcommand: "freeze-candidate", stageId: stage });
      assert.ok(other.admitted, "a different operation of the same project is admitted");
      const otherArmed = await registry.arm(other.claim, "shell", { word: engineWord, args: ["freeze-candidate", stage] });
      assert.equal(otherArmed.ok, true, "armed, so it is durable and guarded too");

      // The person settles the run-loop. Only the run-loop.
      const staleId = held.id;
      assert.equal(registry.override(staleId, "I checked — the runner is no longer active").overridden, true);
      assert.equal(registry.inFlightFor(runnerKey(loopRunId)), undefined, "that operation is released");
      assert.match(resolutions(logged)[0], /resolved as human-override/, "recorded as the person's statement, never as evidence");
      assert.equal(registry.inFlightFor(otherKey())?.state, "armed", "and the other operation is untouched");

      // The same run is handed over again, taking the same key with a new id.
      const again = registry.claim({ key: runnerKey(loopRunId), caller: "runner", label: `run-loop ${stage}`, repoRoot: repo, cwd: repo, subcommand: "run-loop", runId: loopRunId, runnerKind: "run-loop", stageId: stage });
      assert.ok(again.admitted, "which is now allowed, because the person took responsibility");
      const armed = await registry.arm(again.claim, "shell", { word: engineWord, args: loopArgs });
      assert.equal(armed.ok, true);
      const fresh = registry.inFlightFor(runnerKey(loopRunId));
      assert.notEqual(fresh?.id, staleId, "a new operation, with an identity of its own");

      // A second click on the old panel. One guard key is reused per run, so
      // this is exactly how a stale confirmation used to release a newer
      // operation's guard.
      const stale = registry.override(staleId, "a second click on the dialog that was already confirmed");
      assert.equal(stale.overridden, false, "it releases nothing");
      assert.equal(stale.overridden ? undefined : stale.reason, "already-resolved", "and says why");
      assert.equal(registry.inFlightFor(runnerKey(loopRunId))?.id, fresh?.id, "the newer operation still holds the key");
      assert.equal(registry.inFlightFor(otherKey())?.state, "armed", "and the other operation is still untouched");
    } finally {
      registry.dispose();
    }
  });
});
