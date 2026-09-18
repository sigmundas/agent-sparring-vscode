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
 *                                       the command itself is running
 *
 * Every transition *out* of a guard removes duplicate protection, so each one
 * names the evidence that proves this exact operation cannot execute again:
 *
 *  | from            | evidence                   | outcome        |
 *  |-----------------|----------------------------|----------------|
 *  | reserved        | `never-executed`           | cannot-execute |
 *  | armed           | `handover-threw`           | cannot-execute |
 *  | armed           | `never-handed-over`        | cannot-execute |
 *  | running-shell   | `shell-execution-ended`    | completed      |
 *  | running-shell   | `engine-process-gone`      | completed      |
 *  | running-direct  | `direct-process-ended`     | completed      |
 *  | running-direct  | `direct-process-gone`      | completed      |
 *  | running-dedicated | `terminal-process-exited` | completed     |
 *  | running-dedicated | `dedicated-process-gone` | completed      |
 *  | any guard       | `human-override`           | human-override |
 *
 * There is deliberately no row for `submitted-shell`. A command that has been
 * handed to a shell leaves that state in exactly three ways: it is found to be
 * running (and the guard *advances*), its own execution is reported as ended
 * (through `running-shell`), or a person overrides that exact operation id.
 *
 * `reserved` is the only state that is not persisted, and it is the only one
 * for which "nothing could have executed" is true by construction: no
 * transport has been invoked, and a reload has nothing to duplicate.
 *
 * ## The irreversible boundary
 *
 * The two `armed` resolutions are the only ones that rest on this window's own
 * knowledge of what it did rather than on a fact about a process, and both are
 * strictly *pre*-hand-over:
 *
 *  - `never-handed-over`: no idle shell could be found, so `executeCommand`
 *    was never called;
 *  - `handover-threw`: `executeCommand` itself threw, so the shell was given
 *    nothing. That call is the only thing inside its own `try`
 *    (shellIntegration.ts, `performShellHandover`), so this cannot be reached
 *    by a failure that happens after the shell has the command line. Reading
 *    back the returned execution's metadata used to share that `try`, and a
 *    throw from it resolved the operation as `cannot-execute` while the shell
 *    was holding the command.
 *
 * Once `executeCommand` has returned, everything is observation.
 *
 * ## Loss of observation is not termination evidence
 *
 * The distinction the table above turns on, stated once: **after
 * `executeCommand` has been called, nothing that this window stops being able
 * to see is evidence about what is running.** Not one of these ends a guard:
 *
 *  - no start event, in this window or after a reload. A shell reports a start
 *    only if something is listening, and a reloaded window was not;
 *  - the terminal closing. Under a *started* operation the pty goes and the
 *    process need not: real VS Code testing settled it, with a HUP- and
 *    TERM-resistant engine going on working after `terminal.dispose()`. Under
 *    a *submitted* one it is no better — the shell may have read the line
 *    before it went, and the child it started can be reparented to pid 1 and
 *    keep running;
 *  - the shell process disappearing. It is gone, so it will not read the line
 *    *from now on*; it says nothing about whether it already did. This used to
 *    be treated as proof that the line could never be read, which released the
 *    guard over a live engine whose shell had died;
 *  - a descendant search coming back empty. A dying shell reparents its
 *    children, so the engine is no longer under the shell's pid — which is why
 *    the whole process table is searched for a submitted command, not only the
 *    shell's subtree;
 *  - a reload losing the `TerminalShellExecution`, another foreground command
 *    in the same terminal (`^Z` then `bg` leaves exactly that trace), a
 *    matcher that cannot attribute a process, or a probe that cannot run.
 *
 * When observation is lost, the record keeps its guard, its terminal
 * attachment is dropped so nothing is written to a terminal that is gone or
 * no longer ours, and process-specific reconciliation continues. If no
 * definitive probe is possible, the operation stays unknown and guarded until
 * a person overrides that exact operation id.
 *
 * ## What a submitted command is reconciled against
 *
 * A short engine command (freeze-candidate, accept-candidate, new-stage) is
 * not one of the loop subcommands, so its command line cannot be parsed for a
 * project and a target and `targetOf` has nothing to offer. Such an operation
 * used to have no reconciliation path at all after a reload. So the *actual
 * invocation* — the executable word this extension resolved, the argument
 * array verbatim, and the working directory — is recorded with the durable
 * intent for every transport, shell included, and compared by exact argument
 * identity (core/processInvocation.ts). Nothing is matched by substring, and a
 * `false` from either matcher means "I cannot attribute this process", which
 * leaves the guard where it is.
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
 *  - **a terminal closing over an operation that was handed over.** The pty
 *    goes; the process need not. A process that ignores or survives the hangup
 *    keeps running, which is exactly the case a guard exists for — and a
 *    command the shell had only been *given* is no safer to write off, because
 *    the shell may have read that line before the pty went;
 *  - **the shell process that took a command disappearing.** It will not read
 *    the line from now on, which is not the same as never having read it;
 *  - **another foreground command in the same terminal.** It proves that the
 *    previous foreground relationship changed — a `bg` after a `^Z` does that
 *    while the engine runs on — and nothing else. It updates occupancy and
 *    observation here, and releases no operation key;
 *  - **"started".** A shell reporting an execution as started proves that it
 *    is now executing — which is precisely why a second copy must still be
 *    refused. Short commands (freeze-candidate, accept-candidate, new-stage)
 *    used to lose their guard here, leaving a window in which the operation
 *    was running and unguarded;
 *  - **some runner existing, or ceasing to exist, in this project.** "There
 *    is a runner in this project" is not "my operation started"; runner
 *    liveness and operation fate are different questions;
 *  - **a matcher that cannot attribute a process.** A matcher answers "can I
 *    positively attribute this process?"; a `false` from it means "I cannot
 *    attribute it", never "the old operation ended". A relative
 *    `--repo-root .`, a configured wrapper executable, a basename mismatch, a
 *    command line `ps` reports differently, an argument vector that cannot be
 *    parsed: each of those makes a *live* process unattributable, and an
 *    unattributable live process leaves the guard exactly where it was;
 *  - **a matching basename, or a matching stage id on its own.** A `stage-4`
 *    in another repository is a different operation, and so is a `plan.md` at
 *    another full path. Attribution is by full project path plus full target
 *    path (core/sparringCommand.ts, `commandLineIsOperation`) or, for a short
 *    command, by the exact recorded invocation (core/processInvocation.ts);
 *  - **the absence of a process probe.** A question that cannot be asked has
 *    not been answered.
 *
 * ## What *is* positive process evidence
 *
 *  - the recorded pid is not in the process table at all;
 *  - the recorded pid is there, a birth-time fingerprint was recorded for it,
 *    and the pid's birth time is now a different one — so this is a reused
 *    pid and the recorded process is gone (core/processTree.ts,
 *    `processGenerationVerdict`);
 *  - the shell reported the end of that exact execution;
 *  - the pty host reported an exit *status* for a dedicated terminal whose
 *    process is the engine: an exit code is a fact about that process, unlike
 *    the terminal merely being disposed of;
 *  - a person confirmed, for that exact operation id, that it is no longer
 *    active. That is an override, and is recorded as one.
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
import { commandLineIsInvocation, type RecordedInvocation } from "../core/processInvocation";
import { findSelfOrDescendant, processExists, processGenerationVerdict, type ProcessInfo } from "../core/processTree";
import { commandLineIsOperation, targetIsAttributable, type OperationTarget, type SparringSubcommand } from "../core/sparringCommand";
import { listProcesses, processProbeSupported } from "./processProbe";
import type { TerminalLease } from "./terminalPool";

/**
 * Where the durable records live. The key is unchanged from when these were
 * only shell submissions, so an extension update never loses a safety record
 * that a running operation is relying on.
 */
const OPERATIONS_KEY = "agentSparring.operations";
/**
 * Where these records used to live — under a name they shared, byte for byte,
 * with the evidence submissions in core/submission.ts (`SUBMISSIONS_KEY`).
 * Two subsystems wrote one `workspaceState` entry with two different shapes,
 * so each one's write destroyed the other's: arming an operation deleted a
 * person's in-flight evidence submission, and recording a submission deleted
 * every duplicate guard. Operations moved to a key of their own; anything
 * left under the old one is read once, and only when it still has the array
 * shape these records have.
 */
const LEGACY_OPERATIONS_KEY = "agentSparring.submissions";
/**
 * Where earlier versions kept the dedicated-runner safety record, before
 * there was one admission authority. A launch recorded there and never ended
 * is imported as a guarded operation during restore; otherwise the first
 * command after an upgrade would be admitted over a live runner.
 */
const LEGACY_LAUNCHES_KEY = "agentSparring.launches";
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
  | "never-handed-over"
  | "shell-execution-ended"
  | "terminal-process-exited"
  | "engine-process-gone"
  | "direct-process-ended"
  | "direct-process-gone"
  | "dedicated-process-gone"
  | "human-override";

/** Which outcome each piece of evidence establishes. */
const OUTCOME_OF: Readonly<Record<OperationEvidence, OperationOutcome>> = {
  "never-executed": "cannot-execute",
  "handover-threw": "cannot-execute",
  "never-handed-over": "cannot-execute",
  "shell-execution-ended": "completed",
  "terminal-process-exited": "completed",
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
  {
    from: "armed",
    evidence: "never-handed-over",
    outcome: "cannot-execute",
    proves: "no idle shell could be found for it, so `executeCommand` was never called at all and no process was spawned — known from this window's own instruction stream, not inferred",
  },
  { from: "running-shell", evidence: "shell-execution-ended", outcome: "completed", proves: "the shell reported that exact execution finishing" },
  {
    from: "running-shell",
    evidence: "engine-process-gone",
    outcome: "completed",
    proves: "the engine process that was positively attributed to this operation is no longer in the process table, or its pid now holds a process with a different birth time",
  },
  { from: "running-direct", evidence: "direct-process-ended", outcome: "completed", proves: "the child process this window spawned exited in front of us" },
  { from: "running-direct", evidence: "direct-process-gone", outcome: "completed", proves: "the recorded pid is absent from the process table, or its birth time is not the one recorded for the process we started" },
  {
    from: "running-dedicated",
    evidence: "terminal-process-exited",
    outcome: "completed",
    proves: "the pty host reported the exit status of the dedicated terminal's process, which is the engine itself, so that process has exited",
  },
  {
    from: "running-dedicated",
    evidence: "dedicated-process-gone",
    outcome: "completed",
    proves: "the recorded process of the dedicated terminal is absent from the process table, or its birth time is not the one recorded for it",
  },
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
  /**
   * The terminal that was hosting it is gone, or has been taken over by
   * another foreground command, while the operation may still be running. The
   * guard is unchanged; this is what a person is told about.
   */
  observationLost?: boolean;
  /** The engine process positively attributed to it, when one was found. */
  enginePid?: number;
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
  /**
   * Exactly what this operation is, as an invocation: the executable word that
   * was resolved, the argument array verbatim and the working directory. Kept
   * for *every* transport, not only the spawning ones, because it is the only
   * thing that can recognise a short engine command in a process table — such
   * a command takes no `--repo-root` and cannot be parsed for a target, so a
   * shell-submitted `freeze-candidate` had no reconciliation path at all after
   * a reload.
   */
  invocation?: RecordedInvocation;
  /**
   * The engine process positively attributed to this operation: the child of
   * the shell that was found running it, or the dedicated terminal's own
   * process. Once this is known, its absence is real death evidence — which
   * is why it is recorded rather than re-derived from a command line each
   * time.
   */
  enginePid?: number;
  /**
   * The birth time of the process this record names, as `ps` printed it when
   * that process was last seen alive. A pid whose birth time has changed is a
   * different process, which is the only way a live pid can prove a death.
   */
  generation?: string;
  /**
   * The terminal this operation was in has gone, or has been taken over by
   * something else, while the operation itself may still be running. A
   * presentation and routing flag: it settles nothing.
   */
  observationLost?: boolean;
  /** The last inconclusive probe answer logged for it, so a steady one is said once. */
  inconclusive?: string;
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
  /**
   * Present only for a direct child process: its pid and exactly what was
   * spawned — the executable word, the argument array verbatim and the
   * working directory it was spawned in. Semantic fields are deliberately
   * absent: several subcommands identify their repository by cwd and are
   * given no `--repo-root` at all, and demanding one of those in the command
   * line declared live processes gone.
   */
  direct?: { pid: number; word: string; args: string[]; cwd?: string };
  /**
   * The invocation this operation is, for every transport: what a process
   * table row has to match, token for token, to be positively attributed to
   * it. Written from `arm` onwards, so it is durable before anything can
   * execute; records written before this field existed fall back to `direct`.
   */
  invocation?: { word: string; args: string[]; cwd?: string };
  /** The engine process attributed to this operation, when one was positively found. */
  enginePid?: number;
  /** That process's birth time as `ps` printed it, which is what distinguishes it from a reused pid. */
  generation?: string;
  /** Whether the terminal that was hosting it is gone or is someone else's now. */
  observationLost?: boolean;
}

/**
 * A launch record written by a version that kept the dedicated runner's
 * safety in `agentSparring.launches`. Only the fields the import needs, all
 * optional: this is foreign data from an older branch and is read defensively.
 */
interface LegacyLaunch {
  id?: string;
  runId: string;
  kind?: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  repoRoot?: string;
  sparringDir?: string;
  transport?: "dedicated-terminal" | "shell";
  source?: string;
  startedAtMs?: number;
  terminalPid?: number;
  terminalName?: string;
  ended?: unknown;
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
  /** What `restore` answered, so calling it twice cannot duplicate a record. */
  private restored: OperationView[] | undefined;

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
  async arm(claim: OperationClaim, transport: OperationTransport, details?: Pick<OperationIdentity, "word" | "plan"> & { args?: string[] }): Promise<ArmResult> {
    const operation = this.held(claim, "reserved");
    operation.transport = transport;
    operation.state = "armed";
    operation.armedAtMs = Date.now();
    operation.observation = "launched";
    if (details) {
      operation.word = details.word;
      operation.plan = details.plan;
      if (details.word && details.args) {
        // The actual invocation, recorded with the intent rather than after
        // the fact: a crash between the durable write and the hand-over then
        // leaves a record the next window can still look for in the process
        // table, and a shell submission is as reconcilable as a spawned one.
        operation.invocation = { word: details.word, args: [...details.args], cwd: operation.cwd };
      }
    }
    try {
      await this.persist();
    } catch (error) {
      // Nothing has been handed over: this is still a reservation in
      // substance, and the caller is about to release it.
      operation.state = "reserved";
      operation.transport = undefined;
      operation.armedAtMs = undefined;
      operation.invocation = undefined;
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
  runningDirect(armed: ArmedOperation, process: { pid: number; word: string; args: string[]; cwd?: string }, detail: string): void {
    const operation = this.held(armed, "armed");
    operation.state = "running-direct";
    operation.directPid = process.pid;
    // The actual invocation, verbatim: the executable word, the argument
    // array as passed, and the working directory it was spawned in. Nothing
    // semantic is derived from it, because several subcommands carry no
    // `--repo-root` at all and are identified by their cwd alone.
    operation.invocation = { word: process.word, args: [...process.args], cwd: process.cwd };
    operation.enginePid = process.pid;
    this.log(`${operation.label}: ${detail}; a second copy of this operation is refused until it ends`);
    this.persistQuietly();
    // Its birth time, so a later window can tell this process from another
    // one that has since been given the same pid.
    void this.captureGeneration(operation, process.pid);
    this.changeEmitter.fire();
  }

  /**
   * No shell could be given the command at all: every terminal of this
   * project turned out to be in use by someone else, so `executeCommand` was
   * never called and nothing was spawned.
   *
   * That is positive knowledge, not an inference — this window knows which
   * calls it made — and it is the same fact `handoverFailed` records for a
   * call that threw. The record is settled, because keeping it would block
   * the operation for ever over a busy terminal.
   */
  handoverNotInvoked(armed: ArmedOperation, detail: string): void {
    const operation = this.operations.get(armed.id);
    if (operation && operation.state === "armed") {
      this.resolve(operation, "never-handed-over", detail);
    }
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
    void this.remember(operation)
      .then(() => {
        if (operation.terminalPid !== undefined && operation.terminalPid > 0) {
          operation.enginePid = operation.terminalPid;
          return this.captureGeneration(operation, operation.terminalPid);
        }
        return undefined;
      })
      .catch((error: Error) => this.log(`${operation.label}: its record could not be updated: ${error.message}`));
    this.changeEmitter.fire();
  }

  /**
   * Record the birth time of the process this operation is, while it is
   * certainly still alive.
   *
   * This is the fingerprint that later lets a live pid prove a death: a pid
   * that is still in the table with a *different* birth time is a different
   * process, so the one that was started is gone. Without it a live,
   * unrecognisable pid can only stay unresolved — which is the conservative
   * answer, and the one a platform without `ps -o lstart` gets.
   */
  private async captureGeneration(operation: Operation, pid: number): Promise<void> {
    if (!this.probeSupported() || operation.generation !== undefined) {
      return;
    }
    let processes: ProcessInfo[];
    try {
      processes = await this.probe();
    } catch {
      return;
    }
    const found = processes.find((item) => item.pid === pid);
    if (!found?.started || !this.operations.has(operation.id)) {
      return;
    }
    operation.generation = found.started;
    this.persistQuietly();
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
    // Another execution starting in a terminal that hosts one of ours changes
    // the foreground relationship, and nothing else. `^Z` followed by `bg`
    // leaves the engine running and the shell free to take the next command;
    // a plain `true` typed there is then the next foreground command while
    // the engine works on. So this updates what is being observed and
    // releases no operation key — it used to resolve the guard outright, on a
    // "a shell runs one foreground command at a time" argument that a
    // backgrounded process simply does not obey.
    for (const other of [...this.operations.values()]) {
      if (other.state === "running-shell" && other.terminal === event.terminal && other.execution !== event.execution) {
        this.loseObservation(
          other,
          `another command started in "${event.terminal.name}". That changes which process is in the foreground there — a suspended engine that was put in the background leaves exactly this trace — and says nothing about whether ${other.label} is still running, so its guard remains.`,
        );
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
        // This used to be the one case in which a closed terminal was treated
        // as evidence, on the argument that the shell holding the queued line
        // had gone with the pty. It does not follow. The shell may have read
        // that line already — nothing was listening for a start after a
        // reload, and even in this window a start event can be missed — and
        // the engine it began is then reparented and goes on running. So the
        // guard stays, and the process table is asked about the command
        // itself.
        this.loseObservation(
          operation,
          `the terminal "${terminal.name}" that took it has closed. That is the end of what could be watched, not proof that the line was never read: the shell may have run it before the pty went, and the engine it started can outlive both. The guard remains and the process table is searched for that exact command.`,
        );
      } else if (operation.state === "running-dedicated" && terminal.exitStatus?.code !== undefined) {
        // The pty host reported an exit *status* for the process that is the
        // engine. That is not "the terminal went away": it is the process's
        // own exit code, which is as positive as evidence gets.
        this.resolve(operation, "terminal-process-exited", `the process of the dedicated terminal "${terminal.name}" — which is the engine itself — exited with code ${terminal.exitStatus.code}`);
      } else if (operation.state === "running-shell" || operation.state === "running-dedicated") {
        // An operation that is already running is a process, and closing a
        // terminal does not end a process that survives the hangup. Real
        // testing in VS Code proved it: the engine went on working after
        // `terminal.dispose()`. Observation is lost; the guard is not.
        this.loseObservation(
          operation,
          operation.state === "running-dedicated"
            ? `the dedicated terminal "${terminal.name}" has closed. Its process may well have gone with it, but a process that ignores or survives the hangup does not, so this is not treated as the end of the operation: the guard remains and the process table is asked about that pid.`
            : `the terminal "${terminal.name}" hosting that execution has closed. A process that survives the hangup keeps running without its pty, so this settles nothing: the guard remains and reconciliation continues.`,
        );
      }
    }
  }

  /**
   * The terminal this operation was being watched through is gone, or is
   * someone else's now.
   *
   * Everything that identified *how* it was being observed is dropped, so
   * nothing is ever written to that terminal again and no stale execution
   * identity can be matched. Everything that identifies *what* the operation
   * is stays, the guard stays, and process-specific reconciliation is started
   * (or continues) so the question can still be answered by the one thing
   * that can answer it.
   */
  private loseObservation(operation: Operation, detail: string): void {
    if (operation.observationLost && operation.terminal === undefined) {
      return;
    }
    operation.observationLost = true;
    operation.terminal = undefined;
    // The execution identity is deliberately kept: if that exact execution
    // does report an end later, that is real evidence and must still be able
    // to resolve this record. What is dropped is the terminal, which is what
    // could otherwise be written to.
    //
    // The lease is retired rather than released: this terminal must never be
    // written to again, and whatever is in it is left running.
    operation.lease?.retire();
    operation.lease = undefined;
    this.log(`${operation.label}: ${detail}`);
    this.startProbing(operation);
    this.persistQuietly();
    this.changeEmitter.fire();
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
          ? `${operation.label}: no process probe is available on ${process.platform}, so nothing here can establish whether the shell ran that line; its fate stays unknown until its own execution is reported or you confirm it cannot run`
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

  /**
   * A direct child process, reconciled against the invocation it actually
   * received.
   *
   * Three answers, and only one of them releases the guard:
   *
   *  - the pid is absent, or its birth time is not the recorded one: that
   *    process is gone, positively;
   *  - the pid is there and the exact recorded invocation is recognisable in
   *    its command line: it is still running;
   *  - the pid is there and nothing can decide: unknown, and the guard stays.
   *    A live `sparring new-stage stage-5` used to be declared gone here,
   *    because the reconciliation demanded a `--repo-root` that command never
   *    takes.
   */
  private probeDirect(operation: Operation, processes: ProcessInfo[]): void {
    const pid = operation.directPid;
    if (pid === undefined) {
      return; // nothing to ask about
    }
    const verdict = processGenerationVerdict(processes, pid, operation.generation);
    if (verdict === "gone") {
      this.resolve(
        operation,
        "direct-process-gone",
        processExists(processes, pid)
          ? `the pid ${pid} is still in the process table but was born at a different time than the process this window started, so it is a reused pid and that process is gone`
          : `the process ${pid} this window started for it is no longer in the process table, so that operation is over`,
      );
      return;
    }
    if (verdict === "alive") {
      return; // the same process, still running
    }
    const running = processes.find((item) => item.pid === pid) as ProcessInfo;
    if (operation.invocation && commandLineIsInvocation(running.command, operation.invocation)) {
      return; // positively this invocation: still running
    }
    this.unresolvedProbe(
      operation,
      `the pid ${pid} recorded for it is still in the process table, but its command line (${running.command.slice(0, 60)}) cannot be positively recognised as the invocation this window started and no birth time was recorded to tell a reused pid from the original. That is "I cannot attribute it", not "it ended": the operation stays guarded until its process is gone or you confirm it is over.`,
    );
  }

  /**
   * An answer that settles nothing, said once per distinct answer rather than
   * every few seconds. The record is untouched.
   */
  private unresolvedProbe(operation: Operation, detail: string): void {
    if (operation.inconclusive === detail) {
      return;
    }
    operation.inconclusive = detail;
    this.log(`${operation.label}: ${detail}`);
  }

  /**
   * A dedicated terminal's process *is* the engine, so the root of that
   * process is what must be looked at — not only its descendants, which is
   * what a live dedicated runner used to be declared dead for.
   */
  private probeDedicated(operation: Operation, processes: ProcessInfo[]): void {
    const pid = operation.enginePid ?? operation.terminalPid;
    if (pid === undefined || pid <= 0) {
      // A dedicated runner restored from before this pid was recorded. There
      // is nothing to ask the process table about, and nothing that could be
      // read as an answer: it stays guarded for a person to settle.
      this.unresolvedProbe(operation, "no process id was recorded for the dedicated terminal that was running it, so nothing here can establish whether that process is still alive; it stays guarded until you confirm it is over");
      return;
    }
    const verdict = processGenerationVerdict(processes, pid, operation.generation);
    if (verdict === "gone") {
      this.resolve(
        operation,
        "dedicated-process-gone",
        processExists(processes, pid)
          ? `the pid ${pid} is still in the process table but was born at a different time than the dedicated process that was running it, so it is a reused pid and that process is gone`
          : `the process ${pid} of the dedicated terminal that was running it is no longer in the process table, so that operation is over`,
      );
      return;
    }
    if (verdict === "alive") {
      return;
    }
    const target = this.targetOf(operation);
    if (target && targetIsAttributable(target) && findSelfOrDescendant(processes, pid, (commandLine) => commandLineIsOperation(commandLine, target))) {
      return; // positively this operation, still running
    }
    // The pid is there and cannot be attributed. That is a matcher's "I
    // cannot say", and it used to end the operation: a dedicated runner whose
    // command line `ps` reports in a form the parser does not recognise — a
    // wrapper, a relative `--repo-root` — was declared dead while it worked.
    this.unresolvedProbe(
      operation,
      `the process ${pid} recorded for the dedicated terminal is still in the process table, but nothing in its command line positively identifies it as this operation and no birth time was recorded to tell a reused pid from the original. The operation stays guarded until that pid is gone or you confirm it is over.`,
    );
  }

  /**
   * What a process table can say about a command a shell was given.
   *
   * One thing it can prove: that this exact command is running. Then the
   * guard *advances* to `running-shell` on the pid that was found, and from
   * there that pid's own fate settles it.
   *
   * One thing it cannot prove, and used to be read as proof: that the command
   * never ran. The shell being gone from the table means it will not read the
   * line from now on; it says nothing about whether it already did, and a
   * child it started before it died is reparented to pid 1 with its command
   * line intact. So a missing shell is a loss of observation — the guard
   * remains — and the search is not confined to the shell's descendants,
   * which is where that reparented engine used to be looked for in vain.
   *
   * Ancestry is still required *while the ancestor exists*: a matching
   * process somewhere else in the table, under a shell that is not ours while
   * ours is alive and still holding the line, is a different invocation of the
   * same operation and proves nothing about this one. Once our shell is gone,
   * a positively attributed process anywhere is the best available account of
   * what became of the line, and anchoring the guard to it is strictly safer
   * than leaving the operation with no pid at all — its fate then follows a
   * real process rather than waiting for a person.
   */
  private probeSubmittedShell(operation: Operation, processes: ProcessInfo[]): void {
    const shellPid = operation.terminalPid;
    const shellKnown = shellPid !== undefined && shellPid > 0;
    const shellGone = shellKnown && !processExists(processes, shellPid);
    if (shellGone) {
      this.loseObservation(
        operation,
        `the shell process ${shellPid} that took it no longer exists. It may well have read that line before it went — and an engine it started is reparented rather than killed — so this is the loss of the only thing that was watching, not proof that nothing ran. The guard remains and the whole process table is searched for that exact command.`,
      );
    }
    const found = this.attributeSubmitted(operation, processes, shellGone ? undefined : shellPid);
    if (found) {
      this.advanceToProbedRunning(operation, found.process, found.where);
      return;
    }
    this.unresolvedProbe(
      operation,
      shellGone
        ? "the shell that took it is gone and no process in the table can be positively attributed to that command. Whether it ran, and whether it is still running, cannot be established here, so it stays guarded until its own process is identified or you confirm it cannot run."
        : "nothing in the process table can be positively attributed to that command yet. That is not proof that it never ran, so it stays guarded.",
    );
  }

  /**
   * The process running a submitted command, if one can be positively
   * attributed to it.
   *
   * `underShell` is the shell's pid while that shell is still alive, and
   * undefined once it is gone (or was never recorded). While it is given, that
   * shell's own subtree is the only place a match counts: a child of a live
   * shell is where its command runs, and a match elsewhere is someone else's
   * invocation of the same operation while ours may still be read. Once the
   * shell is gone there is no subtree left to search, so the whole table is.
   *
   * Both matchers are offered, because an operation has at most one of them: a
   * loop subcommand can be parsed out of a command line, and a short engine
   * command can only be recognised by the invocation that was recorded for it.
   */
  private attributeSubmitted(operation: Operation, processes: ProcessInfo[], underShell: number | undefined): { process: ProcessInfo; where: string } | undefined {
    const target = this.targetOf(operation);
    const invocation = operation.invocation;
    const matchers: ((commandLine: string) => boolean)[] = [];
    if (target && targetIsAttributable(target)) {
      matchers.push((commandLine) => commandLineIsOperation(commandLine, target));
    }
    if (invocation) {
      matchers.push((commandLine) => commandLineIsInvocation(commandLine, invocation));
    }
    if (matchers.length === 0) {
      return undefined; // no question can be asked, so there is no answer
    }
    for (const matches of matchers) {
      if (underShell !== undefined) {
        const under = findSelfOrDescendant(processes, underShell, matches);
        if (under && under.pid !== underShell) {
          return { process: under, where: `under the shell ${underShell} that took it` };
        }
        continue;
      }
      const anywhere = processes.find((item) => matches(item.command));
      if (anywhere) {
        return { process: anywhere, where: `in the process table as pid ${anywhere.pid}, no longer under the shell that took it` };
      }
    }
    if (underShell !== undefined && matchers.some((matches) => processes.some((item) => item.pid !== underShell && matches(item.command)))) {
      this.unresolvedProbe(
        operation,
        `a process matching that command is running, but not under the shell ${underShell} that was given this line — and that shell is still alive, so it may still read it. That is another invocation of the same operation, and it settles nothing about this one.`,
      );
    }
    return undefined;
  }

  /**
   * A shell execution that started before a reload, whose execution identity
   * VS Code cannot hand back. It really did run, so the question is only
   * whether it still is: the process attributable to this exact operation is
   * either in the table or it is over.
   */
  private probeRunningShell(operation: Operation, processes: ProcessInfo[]): void {
    // The strong case: an engine pid was positively attributed to this
    // operation at some point, so its fate is a fact about that pid.
    if (operation.enginePid !== undefined) {
      const verdict = processGenerationVerdict(processes, operation.enginePid, operation.generation);
      if (verdict === "gone") {
        this.resolve(
          operation,
          "engine-process-gone",
          processExists(processes, operation.enginePid)
            ? `the pid ${operation.enginePid} that was running this operation is still in the process table but was born at a different time, so it is a reused pid and that process is gone`
            : `the engine process ${operation.enginePid} that was positively attributed to this operation is no longer in the process table, so it is over`,
        );
        return;
      }
      if (verdict === "alive") {
        return;
      }
      const running = processes.find((item) => item.pid === operation.enginePid) as ProcessInfo;
      const target = this.targetOf(operation);
      if (target && targetIsAttributable(target) && commandLineIsOperation(running.command, target)) {
        return;
      }
      this.unresolvedProbe(
        operation,
        `the pid ${operation.enginePid} that was running this operation is still in the process table but can no longer be positively recognised as it, and no birth time was recorded to tell a reused pid from the original; the operation stays guarded`,
      );
      return;
    }
    const target = this.targetOf(operation);
    if (!target || !targetIsAttributable(target)) {
      // Nothing in a command line could ever prove this is the operation — a
      // relative `--repo-root .`, a command that names no project. The
      // matcher has no question to ask, so it certainly has no answer, and a
      // guard is never removed by a question that was not asked.
      this.unresolvedProbe(
        operation,
        "it was reported as started, but nothing in a process command line could positively identify it — the project or the target it was launched with cannot be compared against what `ps` reports. Whether it is still running cannot be established here, so it stays guarded until you confirm it is over.",
      );
      return;
    }
    const anywhere = processes.find((item) => commandLineIsOperation(item.command, target));
    if (anywhere) {
      // Now there is a pid, and from here on its absence is real evidence.
      operation.enginePid = anywhere.pid;
      operation.generation = anywhere.started ?? operation.generation;
      this.log(`${operation.label}: the process running it is pid ${anywhere.pid}; from now on that pid's fate is what settles this operation`);
      this.persistQuietly();
      return;
    }
    // It was observed running, and no process in the table can be attributed
    // to it. Without a pid that was once attributed, that is an attribution
    // failure and not a death: `ps` may report the command line in a form the
    // parser cannot recognise, or it may be running under a wrapper.
    this.unresolvedProbe(
      operation,
      "it was reported as started before the window reloaded, and no process in the table can be positively attributed to it. That is an attribution failure, not proof that it ended, so the operation stays guarded until its own process is identified and gone, or you confirm it is over.",
    );
  }

  /** A submitted command found running in the process table: the same record, now running. */
  private advanceToProbedRunning(operation: Operation, running: ProcessInfo, where: string): void {
    operation.state = "running-shell";
    operation.observation = "probed";
    // The pid that *is* this operation, with its birth time. From here on the
    // question is about this process and no longer about a command line.
    operation.enginePid = running.pid;
    operation.generation = running.started ?? operation.generation;
    clearInterval(operation.probeTimer);
    operation.probeTimer = undefined;
    this.log(`${operation.label}: this exact command is running ${where}, so it started; the operation stays guarded until that process is gone`);
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
        direct:
          operation.directPid !== undefined
            ? { pid: operation.directPid, word: operation.invocation?.word ?? "", args: operation.invocation?.args ?? [], cwd: operation.invocation?.cwd }
            : undefined,
        invocation: operation.invocation ? { word: operation.invocation.word, args: operation.invocation.args, cwd: operation.invocation.cwd } : undefined,
        enginePid: operation.enginePid,
        generation: operation.generation,
        observationLost: operation.observationLost,
      }));
    await this.context.workspaceState.update(OPERATIONS_KEY, stored);
  }

  /**
   * Operations the previous window left unresolved, restored before anything
   * else happens.
   *
   * They keep blocking a duplicate. What a restored shell operation cannot do
   * is recognise its own execution: VS Code does not hand a
   * `TerminalShellExecution` back, so this window has no identity for it —
   * which also means the absence of a start event says nothing at all, since
   * nothing was listening. Its fate can be established by finding the command
   * in the process table, or by a person. A terminal that does not reconnect,
   * a terminal that closes and a shell that has since died are all silence,
   * not answers, and none of them settles such a record.
   */
  restore(): OperationView[] {
    if (this.restored) {
      // Restoring is what makes admission safe, so it is called as early as
      // activation can call it — and then again by the reattach that used to
      // be its only caller. Doing it twice must not manufacture a second
      // record for one operation, so the first answer is the answer.
      return this.restored;
    }
    const stored = this.storedOperations();
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
        invocation: item.invocation ?? (item.direct ? { word: item.direct.word, args: item.direct.args ?? [], cwd: item.direct.cwd } : undefined),
        enginePid: item.enginePid ?? item.direct?.pid,
        generation: item.generation,
        observationLost: item.observationLost,
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
    restored.push(...this.importLegacyLaunches());
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
      this.persistQuietly();
      this.changeEmitter.fire();
    }
    this.restored = restored.map(view);
    return this.restored;
  }

  /**
   * The persisted records, moved off the key they used to share with the
   * evidence submissions.
   *
   * The old key is read only when what is under it is an array, which is the
   * shape these records have; a submissions object left there by the version
   * that overwrote this key is not an operation and is left alone. The old
   * entry is cleared only in that array case, so nothing else is destroyed by
   * the migration.
   */
  private storedOperations(): PersistedOperation[] {
    const current = this.context.workspaceState.get<PersistedOperation[]>(OPERATIONS_KEY, []);
    if (Array.isArray(current) && current.length > 0) {
      return current;
    }
    const legacy = this.context.workspaceState.get<unknown>(LEGACY_OPERATIONS_KEY);
    if (!Array.isArray(legacy) || legacy.length === 0) {
      return Array.isArray(current) ? current : [];
    }
    this.log(
      `${legacy.length} operation record(s) were kept under the key this extension also used for evidence submissions, where each subsystem's write destroyed the other's. They are moved to their own key and keep blocking a duplicate.`,
    );
    void this.context.workspaceState
      .update(LEGACY_OPERATIONS_KEY, undefined)
      .then(undefined, (error: Error) => this.log(`the old operation record could not be cleared: ${error.message}`));
    return legacy as PersistedOperation[];
  }

  /**
   * Dedicated runners recorded by a version that kept their safety record in
   * `agentSparring.launches` alone.
   *
   * That key is a liveness record, and the new admission authority does not
   * read it. So an upgrade over a live dedicated runner used to admit the
   * next run-plan for that run immediately: the guard simply was not there.
   * Each launch that was never observed ending becomes a guarded
   * `running-dedicated` operation under `runnerKey(runId)` — the strongest
   * identity the old record supports, which is its run, its kind, its target
   * and its terminal's pid.
   *
   * Idempotent by construction: an operation key that already holds a record
   * is left alone, and once the import has happened the record lives under
   * the operations key, so the next reload finds it there and imports
   * nothing.
   */
  private importLegacyLaunches(): Operation[] {
    const launches = this.context.workspaceState.get<LegacyLaunch[]>(LEGACY_LAUNCHES_KEY, []);
    if (!Array.isArray(launches)) {
      return [];
    }
    const imported: Operation[] = [];
    for (const launch of launches) {
      if (!launch || typeof launch.runId !== "string" || launch.ended) {
        continue;
      }
      const dedicated = launch.transport ? launch.transport === "dedicated-terminal" : launch.source === "terminal";
      if (!dedicated) {
        // A shell launch's guard was always the registry's, under the
        // operations key, so there is nothing here to import. Deliberately
        // not broadened: an unresolved *shell* launch record says a runner
        // was seen running, not that a command may execute twice, and the
        // observed-command case (`source: "observed"`) is someone else's
        // command entirely.
        continue;
      }
      const key = runnerKey(launch.runId);
      if (this.recordFor(key)) {
        continue; // a modern record already guards it
      }
      const atMs = typeof launch.startedAtMs === "number" ? launch.startedAtMs : Date.now();
      const operation: Operation = {
        id: `operation-legacy-${launch.id ?? launch.runId}`,
        key,
        caller: "runner",
        label: `${launch.kind ?? "run-plan"} ${launch.stageId ?? launch.planPath ?? launch.manifest ?? ""}`.trim(),
        repoRoot: launch.repoRoot ?? launch.planPath ?? "",
        sparringDir: launch.sparringDir,
        cwd: launch.repoRoot ?? "",
        subcommand: launch.kind ?? "run-plan",
        runId: launch.runId,
        runnerKind: launch.kind,
        stageId: launch.stageId,
        planPath: launch.planPath,
        manifest: launch.manifest,
        transport: "dedicated-terminal",
        state: "running-dedicated",
        claimedAtMs: atMs,
        armedAtMs: atMs,
        waitExpired: true,
        observation: "reattached",
        terminalPid: typeof launch.terminalPid === "number" && launch.terminalPid > 0 ? launch.terminalPid : undefined,
        terminalName: launch.terminalName,
        enginePid: typeof launch.terminalPid === "number" && launch.terminalPid > 0 ? launch.terminalPid : undefined,
        restored: true,
      };
      this.operations.set(operation.id, operation);
      this.byKey.set(operation.key, operation.id);
      imported.push(operation);
      this.log(
        `${operation.label}: a dedicated runner recorded by an earlier version of this extension, which kept its safety record outside the admission authority, was never observed ending. It is imported as a guarded operation${
          operation.terminalPid === undefined ? " with no process id, so only you can settle it" : ` on process ${operation.terminalPid}`
        }; a second command for that run is refused until it is settled.`,
      );
    }
    return imported;
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
            : `${operation.label}: the terminal "${terminal.name}" that took it is back after the reload. Its execution identity is not, so neither closing it nor its shell disappearing can settle it: only finding that command in the process table, its own execution being reported, or your confirmation.`,
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
      // window's own are visible to it and to the caller that started them —
      // unless observation of them has been lost, which is precisely when
      // nobody here can account for them any more.
      return view.restored || view.observationLost === true;
  }
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
    observationLost: operation.observationLost,
    enginePid: operation.enginePid,
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
  if (operation.state === "submitted-shell" && operation.observationLost) {
    // The command was written into a shell and this window can no longer
    // watch that shell. It is not known to have run, and it is not known not
    // to have run; saying either would be an invention.
    return [
      `Agent Sparring gave ${operation.label} to the terminal${operation.terminalName ? ` "${operation.terminalName}"` : ""} ${seconds} s ago, and that terminal has since closed or its shell has gone.`,
      "That does not settle it: a shell can read a queued line and the engine it starts goes on running without either of them, so Agent Sparring cannot determine whether that command ran, or is running now.",
      "Check it before allowing another attempt. If you have checked and it cannot run any more, confirm it.",
    ].join(" ");
  }
  if (operation.observationLost) {
    // The terminal is gone, or someone else's command is in the foreground
    // there. Neither ends a process, so what is said is exactly that.
    return [
      `Agent Sparring started ${operation.label} ${seconds} s ago and can no longer watch it: the terminal it was running in has closed, or another command has taken the foreground there.`,
      "Neither of those ends a process — an engine that survives the hangup, or one that was suspended and put in the background, goes on working — so Agent Sparring cannot determine whether it is still active.",
      "Check it before allowing another attempt: running it again while it runs would do the same engine operation twice. If you have checked and it is over, confirm it.",
    ].join(" ");
  }
  if (operation.state === "running-dedicated") {
    return [
      `Agent Sparring started ${operation.label} ${seconds} s ago in its own terminal${operation.terminalName ? ` ("${operation.terminalName}")` : ""}, and that process outlived the window reload.`,
      "Running it again now would do the same engine operation twice.",
      "It will be released as soon as that process is gone. If you know it is already over, confirm it.",
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
      return `Agent Sparring is already running ${blocked.label} in its own terminal. Running it again now would do the same engine operation twice — wait for that process to finish and try again.`;
    case "running-shell":
      return `Agent Sparring is already running ${blocked.label}: the shell it was given to reported it as started. Running it again now would do the same engine operation twice.`;
    default:
      return `Agent Sparring is already starting ${blocked.label}. Wait for that to be handed to a terminal before running it again.`;
  }
}

export { OPERATIONS_KEY };
