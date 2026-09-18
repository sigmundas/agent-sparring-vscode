/**
 * The one authority on engine operations this extension has started, or is
 * about to start, and cannot yet account for.
 *
 * ## The invariant
 *
 * Once Agent Sparring is about to hand an engine operation to something that
 * may execute it, one durable operation identity remains authoritative until
 * there is evidence that *that* operation finished or cannot execute, or a
 * person explicitly overrides *that exact identity*.
 *
 * One operation key holds at most one record. That record has an immutable
 * operation id and an immutable target identity, and it *advances* through
 * the lifecycle rather than being deleted and re-created somewhere else: a
 * safety record is never dropped in the hope that another subsystem will
 * recreate the same fact later.
 *
 * ## The transition table
 *
 * Transient preparation, in this window only:
 *
 *     free
 *       → reserved            `claim` (synchronous, atomic, never persisted)
 *
 * The durable execution intent, created and *awaited* before the first
 * irreversible hand-over:
 *
 *     reserved
 *       → armed               `arm` — persisted before executeCommand /
 *                             createTerminal / execFile is called at all
 *
 * Then, once the transport has been invoked, one of the durable operation
 * guards — each still the same record, the same id:
 *
 *     armed  → submitted-shell      `submittedToShell`
 *     armed  → running-direct       `runningDirect`
 *     armed  → running-dedicated    `runningDedicated`
 *     submitted-shell → running-shell   the shell reported that execution
 *                                       started, or the process table proved
 *                                       it is running under that shell
 *
 * Every transition *out* of a guard removes duplicate protection, so each one
 * names the evidence that proves this exact operation cannot execute again:
 *
 *  | from            | evidence                   | outcome        |
 *  |-----------------|----------------------------|----------------|
 *  | reserved        | `never-executed`           | cannot-execute |
 *  | armed           | `handover-threw`           | cannot-execute |
 *  | submitted-shell | `terminal-closed`          | cannot-execute |
 *  | submitted-shell | `shell-process-gone`       | cannot-execute |
 *  | running-shell   | `shell-execution-ended`    | completed      |
 *  | running-shell   | `shell-superseded`         | completed      |
 *  | running-shell   | `terminal-closed`          | completed      |
 *  | running-shell   | `engine-process-gone`      | completed      |
 *  | running-direct  | `direct-process-ended`     | completed      |
 *  | running-direct  | `direct-process-gone`      | completed      |
 *  | running-dedicated | `terminal-closed`        | completed      |
 *  | running-dedicated | `dedicated-process-gone` | completed      |
 *  | any guard       | `human-override`           | human-override |
 *
 * `reserved` is the only state that is not persisted, and it is the only one
 * for which "nothing could have executed" is true by construction: no
 * transport has been invoked, and a reload has nothing to duplicate.
 *
 * ## What is not evidence, and may never end a guard
 *
 *  - **any timer.** The wait a caller does is a user-interface deadline; a
 *    stopped shell (SIGSTOP) runs a queued line when it continues, minutes
 *    later. A submitted command whose wait expired is unchanged in substance;
 *    `waitExpired` is a presentation flag, not a state;
 *  - **the terminal-reconnect grace period after a window reload.** That a
 *    terminal did not come back within six seconds says nothing about whether
 *    its shell, or the process it hosts, is alive;
 *  - **"started".** A shell reporting an execution as started proves that it
 *    is now executing — which is precisely why a second copy must still be
 *    refused. Short commands (freeze-candidate, accept-candidate, new-stage)
 *    used to lose their guard here, leaving a window in which the operation
 *    was running and unguarded;
 *  - **some runner existing, or ceasing to exist, in this project.** "There
 *    is a runner in this project" is not "my operation started"; runner
 *    liveness and operation fate are different questions;
 *  - **a matching basename, or a matching stage id on its own.** A `stage-4`
 *    in another repository is a different operation, and so is a `plan.md` at
 *    another full path. Attribution is by full project path plus full target
 *    path (core/sparringCommand.ts, `commandLineIsOperation`), and a process
 *    that cannot be attributed leaves the guard exactly where it was;
 *  - **the absence of a process probe.** A question that cannot be asked has
 *    not been answered.
 *
 * ## Why one authority
 *
 * Four transports can each do an engine operation twice: the runner launcher
 * through shell integration, the same launcher's dedicated-terminal fallback,
 * the short-command runner through shell integration, and its `execFile`
 * fallback. All four claim, arm and resolve here, so this registry can answer
 * one question continuously, for operations this window started and for those
 * restored from before a reload alike:
 *
 *     "Would starting this operation now risk executing it twice?"
 *
 * Runner *liveness* — what the Overview shows, which execution is current,
 * what a run printed — stays in ExecutionTracker (executionTracker.ts). That
 * is a different question, and neither answer substitutes for the other.
 *
 * ## Admission is atomic, and it is here
 *
 * Checking for a guard and then starting the operation is two steps, and
 * every transport has asynchronous work in between — resolving the
 * executable, acquiring a terminal, waiting for shell integration. Two clicks
 * in that window both found nothing and both submitted. So the record is
 * taken *first*, by `claim`, which is synchronous and therefore atomic
 * against anything that can interleave in this host.
 *
 * ## Why the intent is persisted before the hand-over
 *
 * `arm` writes the record to workspaceState and *awaits* that write before
 * the caller may invoke a transport. The window between "the host died" and
 * "the operation is on the durable record" is then closed in the only
 * direction that matters:
 *
 *  - died before `arm` resolved: nothing was handed over, so a retry is safe;
 *  - died after `arm` and before the transport ran: the reloaded window finds
 *    an unresolved intent and blocks, conservatively. A person can settle it,
 *    and the process table can settle it;
 *  - died after the transport ran: the same persisted identity is there and
 *    is reconciled exactly as it would have been.
 *
 * The middle case is a false positive after an unlucky crash. It is accepted,
 * because the explicit override path handles an unknown fate safely and no
 * timer is ever allowed to clear such a record.
 *
 * ## Why direct operations are persisted at all
 *
 * The first version of this assumed a direct execution dies with the window.
 * Both direct transports were then measured, and both outlive it:
 *
 *  - a dedicated terminal's process is spawned by VS Code's pty host, not by
 *    the extension host (asserted from the process table in the integration
 *    suite, section `outlives`), and persistent terminal sessions are on by
 *    default, so a window reload reconnects it;
 *  - a child of `execFile` survives its parent being SIGKILLed, reparented to
 *    pid 1 with its command line intact (asserted in
 *    src/test/directExecutionSurvival.test.ts).
 *
 * So both keep a durable guard here, with the *transport* recorded
 * immutably. How the operation is currently being observed — launched,
 * reattached, probed — changes; what it is does not. A dedicated-terminal
 * runner that mutated its own recorded source to "reattached" was forgotten
 * as a dedicated runner by the next reload, and lost its guard.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { ExecutablePlan } from "../core/cli";
import { findSelfOrDescendant, processExists, type ProcessInfo } from "../core/processTree";
import { commandLineIsOperation, targetIsAttributable, type OperationTarget, type SparringSubcommand } from "../core/sparringCommand";
import { listProcesses, processProbeSupported } from "./processProbe";
import type { TerminalLease } from "./terminalPool";

/**
 * Where the durable records live. The key is unchanged from when these were
 * only shell submissions, so an extension update never loses a safety record
 * that a running operation is relying on.
 */
const OPERATIONS_KEY = "agentSparring.submissions";
/** How often an unresolved shell operation is looked for in the process table. */
const SHELL_PROBE_INTERVAL_MS = 5000;
/** How often a direct or dedicated process recorded before a reload is looked for. */
const PROCESS_PROBE_INTERVAL_MS = 4000;

/**
 * How the operation reaches the engine. Immutable once armed, and never
 * confused with how it happens to be observed right now.
 */
export type OperationTransport = "shell" | "direct-process" | "dedicated-terminal";

/** Which part of the extension started it, for the establishment routing. */
export type OperationCaller = "runner" | "command";

/**
 * Where an operation stands. See the transition table at the top of this
 * file; every state except `reserved` is durable and refuses a second copy.
 */
export type OperationState = "reserved" | "armed" | "submitted-shell" | "running-shell" | "running-direct" | "running-dedicated";

/** The states in which something may execute, or is executing, on its own. */
const GUARDED: ReadonlySet<OperationState> = new Set<OperationState>(["armed", "submitted-shell", "running-shell", "running-direct", "running-dedicated"]);

/** How an operation is currently being watched. Never part of its identity. */
export type OperationObservation = "launched" | "reattached" | "probed";

/** What a resolution says about the operation. Only `human-override` is not evidence. */
export type OperationOutcome = "completed" | "cannot-execute" | "human-override";

/**
 * The exact evidence a resolution rests on. Every value here answers "what
 * proves this exact operation cannot execute again"; there is deliberately no
 * value for a timeout, a missed reconnect, or a look-alike process.
 */
export type OperationEvidence =
  | "never-executed"
  | "handover-threw"
  | "terminal-closed"
  | "shell-process-gone"
  | "shell-execution-ended"
  | "shell-superseded"
  | "engine-process-gone"
  | "direct-process-ended"
  | "direct-process-gone"
  | "dedicated-process-gone"
  | "human-override";

/** Which outcome each piece of evidence establishes. */
const OUTCOME_OF: Readonly<Record<OperationEvidence, OperationOutcome>> = {
  "never-executed": "cannot-execute",
  "handover-threw": "cannot-execute",
  "terminal-closed": "cannot-execute",
  "shell-process-gone": "cannot-execute",
  "shell-execution-ended": "completed",
  "shell-superseded": "completed",
  "engine-process-gone": "completed",
  "direct-process-ended": "completed",
  "direct-process-gone": "completed",
  "dedicated-process-gone": "completed",
  "human-override": "human-override",
};

/**
 * The transition table, as data, so it can be read and asserted rather than
 * only described. Every entry is a transition that removes duplicate
 * protection, and `evidence` is what proves this exact operation cannot
 * execute again.
 */
export const OPERATION_RESOLUTIONS: readonly { from: OperationState; evidence: OperationEvidence; outcome: OperationOutcome; proves: string }[] = [
  { from: "reserved", evidence: "never-executed", outcome: "cannot-execute", proves: "no transport was invoked at all, and nothing durable was ever written" },
  { from: "armed", evidence: "handover-threw", outcome: "cannot-execute", proves: "the call that would have started it threw, so nothing was handed to a shell or spawned" },
  { from: "submitted-shell", evidence: "terminal-closed", outcome: "cannot-execute", proves: "the pty and the shell reading it are gone, so a queued line can never be read" },
  { from: "submitted-shell", evidence: "shell-process-gone", outcome: "cannot-execute", proves: "the exact shell process that took the line no longer exists" },
  { from: "running-shell", evidence: "shell-execution-ended", outcome: "completed", proves: "the shell reported that exact execution finishing" },
  { from: "running-shell", evidence: "shell-superseded", outcome: "completed", proves: "another execution started in that terminal, and a shell runs one foreground command at a time" },
  { from: "running-shell", evidence: "terminal-closed", outcome: "completed", proves: "the terminal hosting that execution closed, taking its foreground process with it" },
  { from: "running-shell", evidence: "engine-process-gone", outcome: "completed", proves: "the process table no longer holds a process attributable to this exact operation" },
  { from: "running-direct", evidence: "direct-process-ended", outcome: "completed", proves: "the child process this window spawned exited in front of us" },
  { from: "running-direct", evidence: "direct-process-gone", outcome: "completed", proves: "the recorded pid is gone, or now belongs to something else" },
  { from: "running-dedicated", evidence: "terminal-closed", outcome: "completed", proves: "the dedicated terminal exists only while its process does, and it closed" },
  { from: "running-dedicated", evidence: "dedicated-process-gone", outcome: "completed", proves: "the recorded terminal process is gone, or is no longer this operation" },
  { from: "armed", evidence: "human-override", outcome: "human-override", proves: "a person took responsibility for this exact operation id" },
  { from: "submitted-shell", evidence: "human-override", outcome: "human-override", proves: "a person took responsibility for this exact operation id" },
  { from: "running-shell", evidence: "human-override", outcome: "human-override", proves: "a person took responsibility for this exact operation id" },
  { from: "running-direct", evidence: "human-override", outcome: "human-override", proves: "a person took responsibility for this exact operation id" },
  { from: "running-dedicated", evidence: "human-override", outcome: "human-override", proves: "a person took responsibility for this exact operation id" },
];

/**
 * Everything about an operation that never changes once it is claimed. Paths
 * are resolved to absolute here, because attribution compares full paths and
 * a relative one can never be compared against a `ps` command line.
 */
export interface OperationIdentity {
  key: string;
  caller: OperationCaller;
  /** Readable operation, for messages and the log. */
  label: string;
  /** The repository or worktree this operation acts on: a full path, never a name. */
  repoRoot: string;
  /** The engine's sparring directory, when it was given one explicitly. */
  sparringDir?: string;
  cwd: string;
  subcommand: string;
  runId?: string;
  /** Set for one of the four loop subcommands, which a process command line can be parsed for. */
  runnerKind?: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  word?: string;
  plan?: ExecutablePlan;
}

/** What an operation is, from the outside. Never an execution record. */
export interface OperationView {
  /** The immutable operation id. Overrides act on this, never on the key. */
  id: string;
  /** The operation that must not be started twice while this is unresolved. */
  key: string;
  caller: OperationCaller;
  transport?: OperationTransport;
  label: string;
  runId?: string;
  cwd: string;
  repoRoot: string;
  subcommand: string;
  /** When the operation was armed, or claimed if it never got that far. */
  submittedAtMs: number;
  state: OperationState;
  /** Whether a caller's start-wait ran out. A presentation flag; it settles nothing. */
  waitExpired: boolean;
  observation?: OperationObservation;
  terminalName?: string;
  terminalPid?: number;
  /** Whether this window still holds the exact execution identity (lost by a reload). */
  identifiable: boolean;
  restored: boolean;
  /** The child process running it, for a direct operation whose pid is known. */
  directPid?: number;
}

/** Everything the runner launcher needs to promote a started operation into a tracked execution. */
export interface EstablishedOperation extends OperationView {
  runnerKind?: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  word?: string;
  plan?: ExecutablePlan;
  output?: Promise<string>;
  lease?: TerminalLease;
}

export interface Establishment {
  operation: EstablishedOperation;
  terminal: vscode.Terminal;
  execution: vscode.TerminalShellExecution;
  /** Present when the shell reported the end before this window saw the start. */
  ended?: { exitCode: number | undefined };
}

/**
 * A held operation key. Every transition after admission is made against
 * this, so a caller can only ever move its own record.
 */
export interface OperationClaim {
  readonly id: string;
  readonly key: string;
}

/** A claim whose durable execution intent is on disk: the transport may now be invoked. */
export interface ArmedOperation extends OperationClaim {
  readonly transport: OperationTransport;
}

/** What `claim` answers: the key is now ours, or it is someone else's and this is who. */
export type Admission = { admitted: true; claim: OperationClaim } | { admitted: false; blocked: OperationView };

/** What `arm` answers. A failed persist means the transport must not be invoked. */
export type ArmResult = { ok: true; armed: ArmedOperation } | { ok: false; error: string };

/** What `override` answers. A stale dialog is told so rather than clearing a newer record. */
export type OverrideResult = { overridden: true; view: OperationView } | { overridden: false; reason: "already-resolved" | "not-outstanding" };

export type StartWait =
  | { established: true; terminal: vscode.Terminal; execution: vscode.TerminalShellExecution; ended?: { exitCode: number | undefined } }
  | { established: false; view: OperationView };

interface Operation extends OperationIdentity {
  readonly id: string;
  transport?: OperationTransport;
  state: OperationState;
  claimedAtMs: number;
  /** When the durable intent was written; the timestamp every message uses. */
  armedAtMs?: number;
  waitExpired: boolean;
  restored: boolean;
  observation?: OperationObservation;
  /** The child process this window spawned for a direct operation. */
  directPid?: number;
  /** Exactly what was spawned, so the pid can be confirmed to still be it after a reload. */
  directCommand?: { word: string; args: string[] };
  terminal?: vscode.Terminal;
  terminalName?: string;
  terminalPid?: number;
  execution?: vscode.TerminalShellExecution;
  output?: Promise<string>;
  lease?: TerminalLease;
  announce?: (wait: StartWait) => void;
  waitTimer?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setInterval>;
}

interface PersistedOperation {
  id: string;
  key: string;
  /** Absent in records written before the lifecycle was made explicit. */
  state?: OperationState;
  transport?: OperationTransport;
  caller?: OperationCaller;
  label: string;
  repoRoot?: string;
  sparringDir?: string;
  cwd: string;
  subcommand: string;
  runId?: string;
  runnerKind?: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  word?: string;
  submittedAtMs: number;
  waitExpired?: boolean;
  terminalPid?: number;
  terminalName?: string;
  /** Present only for a direct child process: its pid and exactly what was spawned. */
  direct?: { pid: number; word: string; args: string[] };
}

/** The operation key for a runner command: one guard per run. */
export function runnerKey(runId: string): string {
  return `run:${runId}`;
}

/**
 * The operation key for a short engine command: its project by full path,
 * its subcommand and its target. A full path, never a basename, so the same
 * stage id in two repositories is two operations.
 */
export function commandKey(cwd: string, subcommand: string, target?: string): string {
  return `cmd:${path.resolve(cwd)}:${subcommand}${target ? `:${target}` : ""}`;
}

export class OperationRegistry implements vscode.Disposable {
  private readonly operations = new Map<string, Operation>();
  /** Operation key → the one record that holds it. The whole invariant, in one map. */
  private readonly byKey = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly establishedEmitter = new vscode.EventEmitter<Establishment>();
  /** A submitted command was reported by its shell as started (or as finished). */
  readonly onDidEstablish = this.establishedEmitter.event;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Any change to the guarded set, so the cockpit can re-render. */
  readonly onDidChange = this.changeEmitter.event;
  private counter = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly probeSupported: () => boolean = processProbeSupported,
    private readonly probe: () => Promise<ProcessInfo[]> = listProcesses,
  ) {
    this.disposables.push(
      this.establishedEmitter,
      this.changeEmitter,
      vscode.window.onDidStartTerminalShellExecution((event) => this.onStarted(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => this.onEnded(event)),
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal)),
    );
  }

  dispose(): void {
    for (const operation of this.operations.values()) {
      clearTimeout(operation.waitTimer);
      clearInterval(operation.probeTimer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  // ---------------------------------------------------------------- queries

  /**
   * The one record a key can have, in any state, including a reservation.
   * `claim` is what decides whether an operation may be started; this is for
   * messages and for tests.
   */
  inFlightFor(key: string): OperationView | undefined {
    const found = this.recordFor(key);
    return found ? view(found) : undefined;
  }

  /**
   * The record for an operation that a shell may still execute on its own —
   * armed for a shell, or handed to one and not yet reported. That is the
   * situation a caller's failed start-wait is about.
   */
  pendingShellFor(key: string): OperationView | undefined {
    const found = this.recordFor(key);
    return found && (found.state === "submitted-shell" || (found.state === "armed" && found.transport === "shell")) ? view(found) : undefined;
  }

  private recordFor(key: string): Operation | undefined {
    const id = this.byKey.get(key);
    return id ? this.operations.get(id) : undefined;
  }

  /** The record by its immutable id, whatever key it holds. */
  private byId(id: string): Operation | undefined {
    return this.operations.get(id);
  }

  /** The pending shell operation for a run, whatever operation it was. */
  pendingShellForRun(runId: string | undefined): OperationView | undefined {
    return runId ? this.pendingShellFor(runnerKey(runId)) : undefined;
  }

  /**
   * Everything this window cannot account for by itself: a command a shell
   * holds, and an operation that was under way before a reload. An operation
   * this window is preparing, or is itself watching, is not in the list —
   * offering a person an override for work that is visibly running would be
   * nonsense.
   */
  unresolved(): OperationView[] {
    return [...this.operations.values()].map(view).filter(outstanding);
  }

  // ---------------------------------------------------------------- admission

  /**
   * Take the operation key, or say who holds it.
   *
   * Synchronous by design: the check and the record happen in one turn of the
   * event loop, so two callers cannot both be admitted however much
   * asynchronous work each of them does afterwards. Everything a launch does
   * — resolving the executable, acquiring a terminal, waiting for shell
   * integration — happens *after* this, under the claim.
   *
   * The claim must be settled: `arm` before a transport is invoked, or
   * `release` when preparation fails before anything could execute.
   */
  claim(identity: OperationIdentity): Admission {
    const held = this.recordFor(identity.key);
    if (held) {
      return { admitted: false, blocked: view(held) };
    }
    const atMs = Date.now();
    const operation: Operation = {
      ...identity,
      repoRoot: path.resolve(identity.repoRoot),
      sparringDir: identity.sparringDir ? path.resolve(identity.sparringDir) : undefined,
      cwd: path.resolve(identity.cwd),
      planPath: identity.planPath ? path.resolve(identity.planPath) : undefined,
      manifest: identity.manifest ? path.resolve(identity.manifest) : undefined,
      id: `operation-${atMs}-${++this.counter}`,
      claimedAtMs: atMs,
      state: "reserved",
      waitExpired: false,
      restored: false,
    };
    this.operations.set(operation.id, operation);
    this.byKey.set(operation.key, operation.id);
    return { admitted: true, claim: { id: operation.id, key: operation.key } };
  }

  // ---------------------------------------------------------------- arming

  /**
   * Create the durable execution intent, and do not return until it is on
   * disk.
   *
   * This is the fail-safe boundary. The caller may invoke its transport —
   * `shellIntegration.executeCommand`, `createTerminal`, `execFile` — only
   * after this resolves `ok`. A failed persist means the record cannot be
   * relied on after a crash, so nothing is started at all and the caller is
   * told; that is the one ordering under which a crash can never leave a
   * started operation with no durable identity.
   */
  async arm(claim: OperationClaim, transport: OperationTransport, details?: Pick<OperationIdentity, "word" | "plan">): Promise<ArmResult> {
    const operation = this.held(claim, "reserved");
    operation.transport = transport;
    operation.state = "armed";
    operation.armedAtMs = Date.now();
    operation.observation = "launched";
    if (details) {
      operation.word = details.word;
      operation.plan = details.plan;
    }
    try {
      await this.persist();
    } catch (error) {
      // Nothing has been handed over: this is still a reservation in
      // substance, and the caller is about to release it.
      operation.state = "reserved";
      operation.transport = undefined;
      operation.armedAtMs = undefined;
      const message = (error as Error).message;
      this.log(`${operation.label}: the durable record of the intent to run it could not be written (${message}); nothing was started`);
      return { ok: false, error: `Agent Sparring could not record that it is about to run ${operation.label}, so it did not start it: ${message}` };
    }
    this.log(`${operation.label}: recorded as about to run over ${transport}; the transport is invoked only now that this is durable`);
    this.changeEmitter.fire();
    return { ok: true, armed: { id: operation.id, key: operation.key, transport } };
  }

  /**
   * The command line has been handed to the shell, and `executeCommand` has
   * returned the execution identity the shell will report. The same record
   * advances; nothing is created or deleted.
   */
  submittedToShell(armed: ArmedOperation, lease: TerminalLease, execution: vscode.TerminalShellExecution, output?: Promise<string>): void {
    const operation = this.held(armed, "armed");
    operation.state = "submitted-shell";
    operation.terminal = lease.terminal;
    operation.terminalName = lease.terminal.name;
    operation.lease = lease;
    operation.execution = execution;
    operation.output = output;
    this.rememberQuietly(operation);
    this.changeEmitter.fire();
  }

  /**
   * The operation is running as a child process of this window. Its pid and
   * command line go on the same record, because such a child outlives a
   * window reload and the next window must recognise it.
   */
  runningDirect(armed: ArmedOperation, process: { pid: number; word: string; args: string[] }, detail: string): void {
    const operation = this.held(armed, "armed");
    operation.state = "running-direct";
    operation.directPid = process.pid;
    operation.directCommand = { word: process.word, args: process.args };
    this.log(`${operation.label}: ${detail}; a second copy of this operation is refused until it ends`);
    this.persistQuietly();
    this.changeEmitter.fire();
  }

  /**
   * The operation is running as the process of a dedicated terminal. That
   * process belongs to VS Code's pty host and survives a window reload, so
   * this record keeps the guard across one — and keeps it across the second
   * and the tenth, because `dedicated-terminal` is the transport and no
   * later observation overwrites it.
   */
  runningDedicated(armed: ArmedOperation, terminal: vscode.Terminal, detail: string): void {
    const operation = this.held(armed, "armed");
    operation.state = "running-dedicated";
    operation.terminal = terminal;
    operation.terminalName = terminal.name;
    this.log(`${operation.label}: ${detail}; a second copy of this operation is refused until that process is gone`);
    this.rememberQuietly(operation);
    this.changeEmitter.fire();
  }

  /**
   * The call that would have started it threw, so nothing was handed to a
   * shell and nothing was spawned. The only way out of `armed` that is not a
   * guard resolution by evidence about a running operation — and it is
   * evidence: a synchronous throw from the host API is proof that the
   * transport was never engaged.
   */
  handoverFailed(armed: ArmedOperation, detail: string): void {
    const operation = this.held(armed, "armed");
    this.resolve(operation, "handover-threw", detail);
  }

  /**
   * Give the claim back. Only for an operation that was never armed: a
   * reservation whose preparation failed. Anything armed needs evidence or an
   * override, and saying so in the log is more useful than silently keeping
   * it.
   */
  release(claim: OperationClaim, detail: string): void {
    const operation = this.operations.get(claim.id);
    if (!operation) {
      return;
    }
    if (operation.state !== "reserved") {
      this.log(`${operation.label}: not released — it is ${operation.state}, and only evidence or an override can settle that`);
      return;
    }
    this.resolve(operation, "never-executed", detail);
  }

  /**
   * A direct child process this window spawned has exited in front of us.
   * That is the strongest evidence there is about it.
   */
  directProcessEnded(armed: ArmedOperation, detail: string): void {
    const operation = this.operations.get(armed.id);
    if (!operation) {
      return;
    }
    if (operation.state === "reserved") {
      this.resolve(operation, "never-executed", detail);
      return;
    }
    if (operation.state === "armed") {
      // The spawn produced no process at all (the executable vanished between
      // the check and the call), so nothing ever ran.
      this.resolve(operation, "handover-threw", `${detail} — in fact the spawn produced no process at all, so nothing ran`);
      return;
    }
    if (operation.state !== "running-direct") {
      this.log(`${operation.label}: not settled by its caller — it is ${operation.state}, not running-direct`);
      return;
    }
    this.resolve(operation, "direct-process-ended", detail);
  }

  /** A dedicated terminal this window created has closed, so its process is gone. */
  dedicatedTerminalClosed(armed: ArmedOperation, detail: string): void {
    const operation = this.operations.get(armed.id);
    if (operation && operation.state === "running-dedicated") {
      this.resolve(operation, "terminal-closed", detail);
    }
  }

  /** The claimed record, asserted to be in the state this transition comes from. */
  private held(claim: OperationClaim, from: OperationState): Operation {
    const operation = this.operations.get(claim.id);
    if (!operation || this.byKey.get(claim.key) !== claim.id) {
      throw new Error(`the claim on ${claim.key} is no longer held`);
    }
    if (operation.state !== from) {
      throw new Error(`${claim.key} is ${operation.state}, not ${from}`);
    }
    return operation;
  }

  /**
   * Wait for the shell to report the submitted command as started, for as
   * long as a caller can reasonably be kept waiting.
   *
   * Expiry changes nothing about safety: the record stays exactly as it is,
   * its terminal is retired from reuse (never closed or signalled — the
   * person's own command may be what is holding that shell), and evidence is
   * still being looked for.
   */
  waitForStart(armed: ArmedOperation, timeoutMs: number): Promise<StartWait> {
    const operation = this.operations.get(armed.id);
    if (!operation) {
      throw new Error(`the claim on ${armed.key} is no longer held`);
    }
    return new Promise((resolve) => {
      operation.announce = (wait) => {
        operation.announce = undefined;
        clearTimeout(operation.waitTimer);
        operation.waitTimer = undefined;
        resolve(wait);
      };
      operation.waitTimer = setTimeout(() => {
        operation.announce = undefined;
        operation.waitTimer = undefined;
        operation.waitExpired = true;
        operation.lease?.retire();
        this.log(
          `${operation.label}: the shell in "${operation.terminalName ?? "?"}" has not reported it as started within ${timeoutMs} ms. Nothing is recorded as running; that terminal will not be reused, and this operation keeps blocking a second ${operation.subcommand} until something proves it can no longer run.`,
        );
        this.startProbing(operation);
        this.persistQuietly();
        this.changeEmitter.fire();
        resolve({ established: false, view: view(operation) });
      }, timeoutMs);
    });
  }

  // ---------------------------------------------------------------- resolution

  /**
   * A person stated that this exact operation cannot still run, accepting the
   * risk if they are wrong.
   *
   * Takes the immutable operation id, never the key. A dialog is opened about
   * one record and confirmed some time later; by then that record may have
   * been resolved and the key taken by a *different* operation. Confirming
   * the old dialog must do nothing to the new one, so a missing id is
   * reported as already resolved rather than turned into a search.
   */
  override(operationId: string, note: string): OverrideResult {
    const operation = this.byId(operationId);
    if (!operation) {
      return { overridden: false, reason: "already-resolved" };
    }
    if (!outstanding(view(operation))) {
      // Nothing is outstanding for this operation that a person could take
      // responsibility for: either nothing has executed, or what is running
      // is being watched by the caller that started it.
      return { overridden: false, reason: "not-outstanding" };
    }
    const resolved = view(operation);
    this.resolve(operation, "human-override", note);
    return { overridden: true, view: resolved };
  }

  private resolve(operation: Operation, evidence: OperationEvidence, detail: string): void {
    this.operations.delete(operation.id);
    if (this.byKey.get(operation.key) === operation.id) {
      this.byKey.delete(operation.key);
    }
    clearTimeout(operation.waitTimer);
    clearInterval(operation.probeTimer);
    operation.waitTimer = undefined;
    operation.probeTimer = undefined;
    this.log(`${operation.label}: resolved as ${OUTCOME_OF[evidence]} (${evidence}) — ${detail}`);
    // A caller may still be waiting for the shell to report this one (an
    // override or a closed terminal can settle it mid-wait). It is settled,
    // and settled is not established: the caller is told so rather than left
    // holding a promise nothing will ever resolve.
    operation.announce?.({ established: false, view: view(operation) });
    this.persistQuietly();
    this.changeEmitter.fire();
  }

  // ---------------------------------------------------------------- events

  private onStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const operation = this.forExecution(event.execution, event.terminal);
    if (operation) {
      this.advanceToRunning(operation, event.terminal, event.execution, undefined);
    }
    // A shell runs one foreground command at a time. Another execution
    // starting in a terminal that hosts one of our running executions is
    // evidence that ours is over — the same rule the execution tracker uses
    // for liveness, applied to the guard so the two cannot disagree.
    for (const other of [...this.operations.values()]) {
      if (other.state === "running-shell" && other.terminal === event.terminal && other.execution !== event.execution) {
        this.resolve(other, "shell-superseded", `another command started in "${event.terminal.name}", and a shell runs one foreground command at a time, so that execution had already finished`);
      }
    }
  }

  private onEnded(event: vscode.TerminalShellExecutionEndEvent): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.execution !== event.execution) {
        continue;
      }
      if (operation.state === "running-shell") {
        this.resolve(operation, "shell-execution-ended", `the shell in "${event.terminal.name}" reported that exact execution finishing${event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`}`);
        return;
      }
      if (operation.state === "submitted-shell") {
        // The shell reports an end only for a command it ran, so this is both
        // halves at once: it started, and it is over.
        this.advanceToRunning(operation, event.terminal, event.execution, { exitCode: event.exitCode });
        return;
      }
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.terminal !== terminal) {
        continue;
      }
      if (operation.state === "submitted-shell") {
        this.resolve(operation, "terminal-closed", `the terminal "${terminal.name}" that took it was closed, so its shell and the line it was given are gone`);
      } else if (operation.state === "running-shell") {
        this.resolve(operation, "terminal-closed", `the terminal "${terminal.name}" hosting that execution was closed, so the command it was running is gone with the pty`);
      } else if (operation.state === "running-dedicated") {
        this.resolve(operation, "terminal-closed", `the dedicated terminal "${terminal.name}" whose process was running it has closed, so that process is gone`);
      }
    }
  }

  /**
   * The shell has reported this exact execution. The operation advances to
   * `running-shell` — it does *not* resolve: "started" proves that it is
   * executing now, which is the strongest possible reason to keep refusing a
   * second copy. The guard is released by this execution's own end.
   */
  private advanceToRunning(operation: Operation, terminal: vscode.Terminal, execution: vscode.TerminalShellExecution, ended: { exitCode: number | undefined } | undefined): void {
    const late = operation.waitExpired;
    operation.state = "running-shell";
    operation.terminal = terminal;
    operation.terminalName = terminal.name;
    operation.execution = execution;
    operation.observation = operation.observation ?? "launched";
    clearInterval(operation.probeTimer);
    operation.probeTimer = undefined;
    this.log(
      `${operation.label}: the shell in "${terminal.name}" ${ended ? "reported it finished" : "started it"}${
        late ? ` ${Math.round((Date.now() - (operation.armedAtMs ?? operation.claimedAtMs)) / 1000)} s after it was submitted, long after the wait had expired` : ""
      }; the same operation record now guards it as running, and only its own end releases that`,
    );
    this.persistQuietly();
    // Taken before anything else: this waiter is being told the one thing
    // that *is* an establishment, not the generic settlement.
    const announce = operation.announce;
    operation.announce = undefined;
    clearTimeout(operation.waitTimer);
    operation.waitTimer = undefined;
    const establishment: Establishment = {
      operation: { ...view(operation), runnerKind: operation.runnerKind, stageId: operation.stageId, planPath: operation.planPath, manifest: operation.manifest, word: operation.word, plan: operation.plan, output: operation.output, lease: operation.lease },
      terminal,
      execution,
      ended,
    };
    this.changeEmitter.fire();
    announce?.({ established: true, terminal, execution, ended });
    this.establishedEmitter.fire(establishment);
    if (ended) {
      // Recorded as running first, then ended, in that order: the record's
      // history is honest and there is no instant in which it is unguarded.
      const current = this.operations.get(operation.id);
      if (current && current.state === "running-shell") {
        this.resolve(current, "shell-execution-ended", `the shell in "${terminal.name}" reported that exact execution finishing${ended.exitCode === undefined ? "" : ` (exit ${ended.exitCode})`}`);
      }
    }
  }

  /**
   * The operation an execution belongs to. Identity is the rule; an operation
   * whose hand-over has not returned yet is matched by its terminal, because
   * that terminal is leased to us and was idle, so an execution starting
   * there in that instant is the one just submitted.
   */
  private forExecution(execution: vscode.TerminalShellExecution, terminal: vscode.Terminal): Operation | undefined {
    for (const operation of this.operations.values()) {
      if (operation.execution === execution && operation.state === "submitted-shell") {
        return operation;
      }
    }
    for (const operation of this.operations.values()) {
      if (operation.execution === undefined && (operation.state === "submitted-shell" || (operation.state === "armed" && operation.transport === "shell")) && !operation.restored && operation.terminal === terminal) {
        return operation;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- process evidence

  /** The operation's target, for attributing a process in the table to it. */
  private targetOf(operation: Operation): OperationTarget | undefined {
    if (!operation.runnerKind) {
      return undefined; // a short command: parseSparringCommand does not know it
    }
    return { kind: operation.runnerKind, repoRoot: operation.repoRoot, sparringDir: operation.sparringDir, stageId: operation.stageId, planPath: operation.planPath, manifest: operation.manifest };
  }

  private startProbing(operation: Operation): void {
    if (operation.probeTimer) {
      return;
    }
    if (!this.probeSupported()) {
      this.log(
        operation.state === "submitted-shell"
          ? `${operation.label}: no process probe is available on ${process.platform}, so its fate stays unknown until its terminal closes or you confirm it cannot run`
          : `${operation.label}: no process probe is available on ${process.platform}, so whether the process this window started before the reload is still running cannot be established here; the operation stays blocked until you confirm it is over`,
      );
      return;
    }
    operation.probeTimer = setInterval(() => void this.probeOnce(operation), operation.state === "submitted-shell" ? SHELL_PROBE_INTERVAL_MS : PROCESS_PROBE_INTERVAL_MS);
    void this.probeOnce(operation);
  }

  /** Run one round of process evidence for every guard this window cannot account for. */
  async probeAll(): Promise<void> {
    for (const operation of [...this.operations.values()]) {
      if (outstanding(view(operation))) {
        await this.probeOnce(operation);
      }
    }
  }

  private async probeOnce(operation: Operation): Promise<void> {
    if (!this.operations.has(operation.id)) {
      clearInterval(operation.probeTimer);
      return;
    }
    if (!this.probeSupported() || !outstanding(view(operation))) {
      // A reservation is not a question for the process table, and neither is
      // a process this window is itself waiting on.
      return;
    }
    let processes: ProcessInfo[];
    try {
      processes = await this.probe();
    } catch {
      return; // A transient `ps` failure proves nothing.
    }
    if (!this.operations.has(operation.id)) {
      return;
    }
    switch (operation.state) {
      case "running-direct":
        this.probeDirect(operation, processes);
        return;
      case "running-dedicated":
        this.probeDedicated(operation, processes);
        return;
      case "submitted-shell":
        this.probeSubmittedShell(operation, processes);
        return;
      case "running-shell":
        this.probeRunningShell(operation, processes);
        return;
      default:
        // `armed` from before a reload: the transport was invoked or it was
        // not, and nothing in a process table distinguishes those two when
        // there is no execution identity to look for. It stays guarded.
        return;
    }
  }

  private probeDirect(operation: Operation, processes: ProcessInfo[]): void {
    const running = processes.find((item) => item.pid === operation.directPid);
    if (!running) {
      this.resolve(operation, "direct-process-gone", `the process ${operation.directPid} this window started for it is no longer in the process table, so that operation is over`);
    } else if (!isRecordedProcess(operation, running.command)) {
      this.resolve(operation, "direct-process-gone", `the pid ${operation.directPid} recorded for it now belongs to something else (${running.command.slice(0, 60)}), so that operation is over`);
    }
  }

  /**
   * A dedicated terminal's process *is* the engine, so the root of that
   * process is what must be looked at — not only its descendants, which is
   * what a live dedicated runner used to be declared dead for.
   */
  private probeDedicated(operation: Operation, processes: ProcessInfo[]): void {
    if (operation.terminalPid === undefined || operation.terminalPid <= 0) {
      return; // nothing to ask about
    }
    if (!processExists(processes, operation.terminalPid)) {
      this.resolve(operation, "dedicated-process-gone", `the process ${operation.terminalPid} of the dedicated terminal that was running it is no longer in the process table, so that operation is over`);
      return;
    }
    const target = this.targetOf(operation);
    if (!target || !targetIsAttributable(target)) {
      return; // present, and nothing more can be asked
    }
    if (!findSelfOrDescendant(processes, operation.terminalPid, (commandLine) => commandLineIsOperation(commandLine, target))) {
      this.resolve(operation, "dedicated-process-gone", `the process ${operation.terminalPid} recorded for it is no longer running this operation, so that operation is over`);
    }
  }

  /**
   * Two things a process table can prove about a command a shell was given:
   * that the shell is gone (so a queued line can never be read), or that
   * this exact command is running *under that shell* (so it started, and the
   * guard advances rather than lifting).
   *
   * Attribution requires the ancestry as well as the command identity. A
   * process that merely looks similar, anywhere in the table, says nothing
   * about the line this particular shell was given.
   */
  private probeSubmittedShell(operation: Operation, processes: ProcessInfo[]): void {
    const shellPid = operation.terminalPid;
    const target = this.targetOf(operation);
    if (shellPid !== undefined && shellPid > 0 && target && targetIsAttributable(target)) {
      const running = findSelfOrDescendant(processes, shellPid, (commandLine) => commandLineIsOperation(commandLine, target));
      if (running && running.pid !== shellPid) {
        operation.observation = "probed";
        this.advanceToProbedRunning(operation, running);
        return;
      }
    }
    if (shellPid !== undefined && shellPid > 0 && !processExists(processes, shellPid)) {
      this.resolve(operation, "shell-process-gone", `the shell process ${shellPid} that took it no longer exists, so the line it was given can never be read`);
    }
  }

  /**
   * A shell execution that started before a reload, whose execution identity
   * VS Code cannot hand back. It really did run, so the question is only
   * whether it still is: the process attributable to this exact operation is
   * either in the table or it is over.
   */
  private probeRunningShell(operation: Operation, processes: ProcessInfo[]): void {
    const target = this.targetOf(operation);
    if (!target || !targetIsAttributable(target)) {
      return; // not attributable: only a person can settle this one
    }
    const anywhere = processes.find((item) => commandLineIsOperation(item.command, target));
    if (!anywhere) {
      this.resolve(operation, "engine-process-gone", `it was reported as started before the window reloaded, and no process in the table is this operation any more, so it is over`);
    }
  }

  /** A submitted command found running under its own shell: the same record, now running. */
  private advanceToProbedRunning(operation: Operation, running: ProcessInfo): void {
    operation.state = "running-shell";
    operation.observation = "probed";
    clearInterval(operation.probeTimer);
    operation.probeTimer = undefined;
    this.log(`${operation.label}: this exact command is running under the shell ${operation.terminalPid} that took it (pid ${running.pid}), so it started; the operation stays guarded until that process is gone`);
    this.persistQuietly();
    this.changeEmitter.fire();
    this.startProbing(operation);
  }

  // ---------------------------------------------------------------- persistence

  /**
   * Persist without making the caller wait, and without an unhandled
   * rejection if the store refuses. Only `arm` awaits a write, because only
   * `arm` must not proceed without one; every later write is enrichment of a
   * record that is already durable, and a failure there is reported rather
   * than thrown into the void.
   */
  private persistQuietly(): void {
    void this.persist().catch((error: Error) => this.log(`the record of operations in flight could not be updated: ${error.message}`));
  }

  private rememberQuietly(operation: Operation): void {
    void this.remember(operation).catch((error: Error) => this.log(`${operation.label}: its record could not be updated: ${error.message}`));
  }

  private async remember(operation: Operation): Promise<void> {
    try {
      operation.terminalPid = await operation.terminal?.processId;
    } catch {
      operation.terminalPid = undefined;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    // Everything that may execute. A reservation is not written down: no
    // transport has been invoked, so a reload has nothing to duplicate.
    const stored: PersistedOperation[] = [...this.operations.values()]
      .filter((operation) => GUARDED.has(operation.state))
      .map((operation) => ({
        id: operation.id,
        key: operation.key,
        state: operation.state,
        transport: operation.transport,
        caller: operation.caller,
        label: operation.label,
        repoRoot: operation.repoRoot,
        sparringDir: operation.sparringDir,
        cwd: operation.cwd,
        subcommand: operation.subcommand,
        runId: operation.runId,
        runnerKind: operation.runnerKind,
        stageId: operation.stageId,
        planPath: operation.planPath,
        manifest: operation.manifest,
        word: operation.word,
        submittedAtMs: operation.armedAtMs ?? operation.claimedAtMs,
        waitExpired: operation.waitExpired,
        terminalPid: operation.terminalPid,
        terminalName: operation.terminalName,
        direct: operation.directPid !== undefined ? { pid: operation.directPid, word: operation.directCommand?.word ?? "", args: operation.directCommand?.args ?? [] } : undefined,
      }));
    await this.context.workspaceState.update(OPERATIONS_KEY, stored);
  }

  /**
   * Operations the previous window left unresolved, restored before anything
   * else happens.
   *
   * They keep blocking a duplicate. What a restored shell operation cannot do
   * is recognise its own execution: VS Code does not hand a
   * `TerminalShellExecution` back, so this window has no identity for it. Its
   * fate can still be established from its terminal closing or from the
   * process table, and until one of those happens it stays guarded. A
   * terminal that simply does not reconnect proves nothing and is not one of
   * them.
   */
  restore(): OperationView[] {
    const stored = this.context.workspaceState.get<PersistedOperation[]>(OPERATIONS_KEY, []);
    const restored: Operation[] = [];
    for (const item of stored) {
      const transport = item.transport ?? (item.direct ? "direct-process" : "shell");
      const operation: Operation = {
        ...item,
        caller: item.caller ?? (item.runId ? "runner" : "command"),
        repoRoot: item.repoRoot ?? item.cwd,
        transport,
        state: item.state ?? (item.direct ? "running-direct" : "submitted-shell"),
        claimedAtMs: item.submittedAtMs,
        armedAtMs: item.submittedAtMs,
        waitExpired: item.waitExpired ?? true,
        observation: "reattached",
        directPid: item.direct?.pid,
        directCommand: item.direct ? { word: item.direct.word, args: item.direct.args } : undefined,
        restored: true,
      };
      if (operation.state === "reserved") {
        // Never written by this version; a corrupted store. Treat it as the
        // conservative thing it might be rather than dropping it.
        operation.state = "armed";
      }
      const held = this.recordFor(operation.key);
      if (held) {
        // A record written by a version that allowed two of them, or a
        // corrupted store. They are the same operation: the newest is kept,
        // which is the one worth probing, and the operation stays blocked
        // either way.
        if ((held.armedAtMs ?? held.claimedAtMs) >= (operation.armedAtMs ?? operation.claimedAtMs)) {
          this.log(`window reloaded with two records for ${operation.key}; the older one is folded into the newer, which keeps blocking it`);
          continue;
        }
        this.operations.delete(held.id);
        restored.splice(restored.indexOf(held), 1);
        this.log(`window reloaded with two records for ${operation.key}; the older one is folded into the newer, which keeps blocking it`);
      }
      this.operations.set(operation.id, operation);
      this.byKey.set(operation.key, operation.id);
      restored.push(operation);
    }
    if (restored.length > 0) {
      const counted = new Map<OperationState, number>();
      for (const operation of restored) {
        counted.set(operation.state, (counted.get(operation.state) ?? 0) + 1);
      }
      this.log(
        `window reloaded with ${restored.length} operation(s) that may still be executing (${[...counted].map(([state, count]) => `${count} ${state}`).join(", ")}); no runner is claimed for any of them, and a second copy of each is refused until evidence settles it`,
      );
      for (const operation of restored) {
        this.startProbing(operation);
      }
      this.changeEmitter.fire();
    }
    return restored.map(view);
  }

  /** Re-tie a restored operation to a terminal that came back with its pid. */
  reconnect(pid: number, terminal: vscode.Terminal): void {
    for (const operation of this.operations.values()) {
      if (operation.restored && operation.terminalPid === pid && !operation.terminal) {
        operation.terminal = terminal;
        operation.terminalName = terminal.name;
        operation.observation = "reattached";
        this.log(
          operation.state === "running-dedicated"
            ? `${operation.label}: the dedicated terminal whose process is running it is back after the reload. It remains a dedicated runner, and its guard remains.`
            : `${operation.label}: the terminal "${terminal.name}" that took it is back after the reload. Its execution identity is not, so closing it — or its shell disappearing — is what will settle it.`,
        );
        this.changeEmitter.fire();
      }
    }
  }
}

/**
 * Whether this is something a person could be asked about, and therefore
 * something this window cannot account for by itself: an operation a shell
 * holds, or one that was under way before a reload. An operation this window
 * is preparing, or is itself watching, is neither — nobody can tell it
 * anything it does not already know.
 */
export function outstanding(view: OperationView): boolean {
  switch (view.state) {
    case "reserved":
      return false;
    case "submitted-shell":
      return true;
    default:
      // `armed`, `running-shell`, `running-direct`, `running-dedicated`: this
      // window's own are visible to it and to the caller that started them.
      return view.restored;
  }
}

/**
 * Whether a process in the table is still the direct child that was recorded.
 * A pid alone is not enough — pids are reused — so the recorded executable,
 * the subcommand, the repository and the operation's own target must be in
 * its command line too.
 */
function isRecordedProcess(operation: Operation, commandLine: string): boolean {
  const words = [operation.directCommand?.word, operation.subcommand, operation.repoRoot, operation.stageId].filter((word): word is string => Boolean(word));
  return words.every((word) => commandLine.includes(word));
}

function view(operation: Operation): OperationView {
  return {
    id: operation.id,
    key: operation.key,
    caller: operation.caller,
    transport: operation.transport,
    label: operation.label,
    runId: operation.runId,
    cwd: operation.cwd,
    repoRoot: operation.repoRoot,
    subcommand: operation.subcommand,
    submittedAtMs: operation.armedAtMs ?? operation.claimedAtMs,
    state: operation.state,
    waitExpired: operation.waitExpired,
    observation: operation.observation,
    terminalName: operation.terminalName,
    terminalPid: operation.terminalPid,
    identifiable: operation.execution !== undefined,
    restored: operation.restored,
    directPid: operation.directPid,
  };
}

/**
 * What a person is told when an operation cannot be started because an
 * earlier one may still execute. It says what is actually known, which is
 * deliberately not "a runner is alive" — that is a claim about a process
 * someone has seen.
 */
export function operationRefusal(operation: OperationView): string {
  const seconds = Math.max(1, Math.round((Date.now() - operation.submittedAtMs) / 1000));
  if (operation.state === "running-direct") {
    // Started by an earlier window, without a shell, and still in the
    // process table. Nothing about this one is uncertain except when it ends.
    return [
      `Agent Sparring started ${operation.label} ${seconds} s ago, before this window reloaded, and the process it started${operation.directPid !== undefined ? ` (pid ${operation.directPid})` : ""} is still running.`,
      "Running it again now would do the same engine operation twice.",
      "It will be released as soon as that process is gone. If you know it is already over, confirm it.",
    ].join(" ");
  }
  if (operation.state === "running-dedicated") {
    return [
      `Agent Sparring started ${operation.label} ${seconds} s ago in its own terminal${operation.terminalName ? ` ("${operation.terminalName}")` : ""}, and that process outlived the window reload.`,
      "Running it again now would do the same engine operation twice.",
      "Close that terminal, or wait for it to finish. If you know it is already over, confirm it.",
    ].join(" ");
  }
  if (operation.state === "running-shell") {
    return [
      `Agent Sparring handed ${operation.label} to the terminal${operation.terminalName ? ` "${operation.terminalName}"` : ""} ${seconds} s ago and the shell reported it as started.`,
      "Running it again now would do the same engine operation twice.",
      operation.restored
        ? "The window has reloaded since, so that execution can no longer be recognised from events; it will be released when the process is gone. If you know it is already over, confirm it."
        : "It will be released when that execution ends.",
    ].join(" ");
  }
  if (operation.state === "armed") {
    return [
      `Agent Sparring recorded, ${seconds} s ago, that it was about to run ${operation.label}, and the window reloaded before it could record what happened next.`,
      "That operation may have started, so running it again could do the same engine operation twice.",
      "Check the terminal and the engine's own state. If nothing ran, or it is over, confirm it.",
    ].join(" ");
  }
  return [
    `Agent Sparring handed ${operation.label} to the terminal${operation.terminalName ? ` "${operation.terminalName}"` : ""} ${seconds} s ago and has not been able to confirm whether it started.`,
    operation.restored
      ? "The window has reloaded since, so that command can no longer be recognised from events."
      : "A shell that is stopped or busy can still run it later, so running it again could run the same operation twice.",
    "Check that terminal. If that command cannot run any more, confirm it and Agent Sparring will let you try again.",
  ].join(" ");
}

/**
 * What a person is told when an operation is refused admission, whatever the
 * holder's state. Anything the person could be asked about gets the wording
 * above; the others are simply this window already doing the thing.
 */
export function admissionRefusal(blocked: OperationView): string {
  if (outstanding(blocked)) {
    return operationRefusal(blocked);
  }
  switch (blocked.state) {
    case "running-direct":
      return `Agent Sparring is already running ${blocked.label}. Wait for it to finish before running it again.`;
    case "running-dedicated":
      return `Agent Sparring is already running ${blocked.label} in its own terminal. Running it again now would do the same engine operation twice — close that terminal, or wait for it to finish, and try again.`;
    case "running-shell":
      return `Agent Sparring is already running ${blocked.label}: the shell it was given to reported it as started. Running it again now would do the same engine operation twice.`;
    default:
      return `Agent Sparring is already starting ${blocked.label}. Wait for that to be handed to a terminal before running it again.`;
  }
}

export { OPERATIONS_KEY };
