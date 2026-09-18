/**
 * Observes `sparring` runner processes so liveness never rests on telemetry.
 *
 * Sources, most exact first:
 *  - launches by this extension through the terminal shell-integration API,
 *    in this project's reusable terminal (terminalPool.ts), ended by the
 *    matching shell-execution end event. The terminal is shared over a run's
 *    lifetime; the executions in it are tracked one by one and a finished
 *    one never keeps the UI running;
 *  - launches in a dedicated terminal whose process is the runner, used only
 *    when shell integration never becomes available; ended when the pty host
 *    reports that process's exit code. A terminal that merely closes without
 *    one is not an ending: such a process can survive the hangup, so liveness
 *    becomes `unknown` and is settled by the process table or by the person;
 *  - commands typed by the user in any integrated terminal, recognised from
 *    the shell-integration start event's command line and cwd;
 *  - launches recorded in workspaceState before a window reload, re-found by
 *    their terminal's process id and, on POSIX, confirmed alive by a
 *    process-table probe; without a probe they stay `unknown`, and so does a
 *    launch whose terminal has not reappeared — a reconnect deadline is a
 *    fact about VS Code's timing and never evidence about a process;
 *  - and, for a run none of the above ever saw, the process table read
 *    directly for its project (`probeProject`). That is the only way to
 *    answer for a runner whose terminal was closed before a reload, or one
 *    started outside VS Code entirely.
 *
 * A runner's record ends when *its own* execution ends, or when the pty host
 * reports the exit code of a dedicated terminal's process. Everything else
 * that used to end one — the terminal closing, another command taking the
 * foreground there, a process the matcher cannot recognise — is a loss of
 * observation, and leaves liveness `unknown` with a sentence saying so: a
 * suspended engine put in the background, or one that survives the hangup,
 * goes on working. The duplicate guard for such an operation stays with the
 * registry, which accepts none of those as evidence either. Ended records are
 * kept (until the next
 * launch for the same run) so a stale `turn.started` can be presented as
 * "interrupted" instead of "running" — and they are persisted across a
 * window reload for the same reason, since a reload does not un-observe a
 * runner's death.
 *
 * ## Liveness here, admission there
 *
 * Handing a command line to `shellIntegration.executeCommand` submits it. The
 * shell may run it at once, or much later — a stopped shell (SIGSTOP) takes
 * the line and runs it when it continues — or never. Whether an operation may
 * be started at all therefore lives in one authority, the OperationRegistry
 * (operationRegistry.ts): every transport in this file claims there first,
 * records its intent durably there before invoking anything, and resolves
 * there only on evidence.
 *
 * This file answers a different question — what is running, in which
 * terminal, with which output and exit code — and it holds no duplicate
 * guard of its own. It used to hold one for the dedicated-terminal fallback,
 * which meant the same fact lived in two places and each reload had to
 * recreate it in the other; the guard is now the registry's for all four
 * transports, and what is kept here is liveness.
 *
 * Nothing submitted is a runner here. A `Tracked` execution is created only
 * when the registry reports that the shell started (or finished) that exact
 * execution, whether that is in the same tick or a quarter of an hour later.
 * `executionFor`, `recordById` and the persisted launches therefore keep
 * meaning observed executions.
 */

import * as vscode from "vscode";
import { executableWord, planExecutable, wasCommandNotFound, type ExecutablePlan, type ExecutableProblem } from "../core/cli";
import type { SparringLocation } from "../core/discovery";
import type { ExecutionRecord, ExecutionSource } from "../core/liveness";
import { findDescendant, findSelfOrDescendant, processExists, processGenerationVerdict, type ProcessInfo } from "../core/processTree";
import { probeRunnerProcesses, type RunnerProbe } from "../core/runnerProcesses";
import { commandLineIsOperation, matchSparringCommand, parseSparringCommand, targetIsAttributable, type SparringSubcommand } from "../core/sparringCommand";
import { admissionRefusal, outstanding, runnerKey, operationRefusal, type Establishment, type OperationRegistry, type OperationView } from "./operationRegistry";
import { listProcesses, processProbeSupported } from "./processProbe";
import { handOverToIdleShell } from "./shellHandover";
import { awaitShellIntegration, EXECUTION_START_TIMEOUT_MS, hostEnv, shellHandoverFor, SHELL_INTEGRATION_TIMEOUT_MS } from "./shellIntegration";
import type { TerminalLease } from "./terminalPool";
import { collectOutput } from "./terminalOutput";
import type { TerminalPool } from "./terminalPool";

export { EXECUTION_START_TIMEOUT_MS, SHELL_INTEGRATION_TIMEOUT_MS };

const LAUNCHES_KEY = "agentSparring.launches";
/**
 * After a reload, how long this window waits for VS Code to bring persistent
 * terminal sessions back before it stops watching for them.
 *
 * A user-interface deadline and nothing more. It decides when `reattach`
 * returns; it decides nothing about any runner or any operation. A launch
 * whose terminal has not reappeared by then is `unknown`, not ended, and its
 * operation guard is untouched.
 */
export const RECONNECT_GRACE_MS = 6000;
const PROBE_INTERVAL_MS = 4000;

export interface LaunchOptions {
  /** The configured `agentSparring.executable` (possibly empty); resolution happens at launch, once the shell is known. */
  configured: string | undefined;
  args: string[];
  cwd: string;
  /** Terminal title suffix and log label. */
  name: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  /** The execution manifest a plan command was launched with, when it was (`--manifest`). */
  manifest?: string;
  /**
   * The repository or worktree this operation acts on, as a full path. Part
   * of the operation's identity: a process in the table is attributed to this
   * operation only if its command line names this same project, so a stage id
   * that also exists in another repository can never resolve this one.
   * Defaults to `cwd`, which every call site already sets to the project root.
   */
  repoRoot?: string;
  /** The engine's sparring directory, when it is not `<repoRoot>/.sparring`. */
  sparringDir?: string;
  reveal: boolean;
}

/**
 * Why a command could not be launched. `unconfirmed` is not a configuration
 * problem and must never be reported as one: the executable was resolved, the
 * terminal was there and the command was submitted — the shell simply has not
 * (yet) reported it as started. Nor is it a claim that nothing ran.
 */
export type LaunchProblem = ExecutableProblem | "unconfirmed";

export type LaunchResult =
  | { ok: true; record: ExecutionRecord; via: "shell" | "terminal" }
  | { ok: false; error: string; problem: LaunchProblem; submission?: OperationView };

/** The shell reported that the launched command word does not exist. */
export interface CommandNotFound {
  runId: string;
  word: string;
  exitCode: number;
}

/**
 * The engine was launched and exited non-zero. This is the other half of
 * what a bad exit code can mean, and the common half: the executable ran,
 * so what the user needs is what it printed, not advice about PATH.
 */
export interface EngineFailure {
  runId: string;
  kind: SparringSubcommand;
  /** The command word or path that ran. */
  word: string;
  exitCode: number;
  /** What the command printed, as the terminal reported it (may be empty). */
  output: string;
}

/** A deliberate interruption (Ctrl-C, SIGTERM): not a failure to report. */
const INTERRUPTED_EXITS: ReadonlySet<number> = new Set([130, 143]);

interface Tracked {
  record: ExecutionRecord;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  /** The repository this execution acts on, for attributing a process to it. */
  repoRoot?: string;
  sparringDir?: string;
  terminal?: vscode.Terminal;
  terminalPid?: number;
  /**
   * The engine process positively attributed to this run, and the birth time
   * it had when it was found. Once known, the absence of that pid — or the
   * same pid with a different birth time — is real evidence that this run's
   * process is over; nothing else in a process table is.
   */
  enginePid?: number;
  generation?: string;
  execution?: vscode.TerminalShellExecution;
  probeTimer?: ReturnType<typeof setInterval>;
  /** The command word or path this window launched (undefined for observed / reattached runs). */
  word?: string;
  /** How that word was arrived at, so an exit code is read honestly. */
  plan?: ExecutablePlan;
  /** Everything the launched execution printed; resolves when it ends. */
  output?: Promise<string>;
  /** The project terminal this command holds until it ends. */
  lease?: TerminalLease;
  /**
   * This launch *is* a process of ours: a dedicated terminal whose shell is
   * the engine, started because no shell integration was available. Such a
   * process is owned by VS Code's pty host, not by the extension host, and
   * survives a window reload (integration suite, section `outlives`).
   *
   * Read from the persisted `transport`, never from the observed `source`,
   * so it survives any number of reloads. What it decides here is liveness —
   * the terminal exists only while the process does, and the process itself
   * (not only its descendants) is what a probe must look for. The duplicate
   * guard for it belongs to the registry.
   */
  dedicated?: boolean;
}

interface PersistedLaunch {
  id: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  repoRoot?: string;
  sparringDir?: string;
  /**
   * How the engine was reached — immutable, and deliberately separate from
   * `source`, which is an *observation* and changes (`terminal` →
   * `reattached`) as the window reloads and reconnects. Conflating the two
   * meant a dedicated-terminal runner was no longer known to be one after the
   * second reload, and lost the handling that depends on it.
   */
  transport?: "dedicated-terminal" | "shell";
  source: ExecutionSource;
  startedAtMs: number;
  terminalPid: number;
  terminalName: string;
  /**
   * The liveness this window last had for a launch that has *not* ended.
   *
   * `unknown` used to be dropped from persistence altogether, because only a
   * launch that still had a terminal object was written down. A reload then
   * found nothing, the evidence submission tied to it stayed pending for
   * ever, and the buttons that would have let the person retry were disabled
   * with no way back. An unknown launch is a fact worth keeping: it is the
   * one the person is asked to settle.
   */
  state?: "running" | "unknown";
  /** Why that state is what it is, so the sentence survives the reload too. */
  detail?: string;
  /** The engine process attributed to this run, and its birth time, when one was found. */
  enginePid?: number;
  generation?: string;
  /**
   * Present only for a launch that had already ended when the window
   * reloaded. That a runner was seen to die is as much an observation as
   * that it was seen to start, and it is the more useful one: without it a
   * reload turned "the terminal was closed, so the loop is over" back into
   * "no idea", and a stale `turn.started` was presented as possibly-working
   * for ever.
   */
  ended?: { atMs: number; exitCode?: number; detail?: string };
}

/** How many ended executions are kept per run across a reload; only the last one is ever presented. */
const ENDED_KEPT_PER_RUN = 1;

export type TrackerChange = "started" | "ended" | "changed";

export class ExecutionTracker implements vscode.Disposable {
  private readonly tracked = new Map<string, Tracked>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<TrackerChange>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly notFoundEmitter = new vscode.EventEmitter<CommandNotFound>();
  /** A launch from this window ended with the shell's command-not-found code. */
  readonly onCommandNotFound = this.notFoundEmitter.event;
  private readonly engineFailedEmitter = new vscode.EventEmitter<EngineFailure>();
  /** A launch from this window ran and exited non-zero. */
  readonly onEngineFailed = this.engineFailedEmitter.event;
  private counter = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly locations: () => SparringLocation[],
    private readonly terminals: TerminalPool,
    /** The one authority on engine operations in flight (operationRegistry.ts). */
    private readonly operations: OperationRegistry,
    /** Whether this platform can be asked about processes at all. */
    private readonly probeSupported: () => boolean = processProbeSupported,
    private readonly probeProcesses: () => Promise<ProcessInfo[]> = listProcesses,
  ) {
    this.disposables.push(
      this.changeEmitter,
      this.notFoundEmitter,
      this.engineFailedEmitter,
      this.operations.onDidEstablish((event) => this.onEstablished(event)),
      vscode.window.onDidStartTerminalShellExecution((event) => this.onExecutionStarted(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => this.onExecutionEnded(event)),
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal)),
    );
  }

  dispose(): void {
    for (const item of this.tracked.values()) {
      this.stopProbe(item);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  // ---------------------------------------------------------------- queries

  /** The latest execution known for a run: running, unknown, or the last one that ended. */
  executionFor(runId: string | undefined): ExecutionRecord | undefined {
    if (!runId) {
      return undefined;
    }
    let best: ExecutionRecord | undefined;
    for (const { record } of this.tracked.values()) {
      if (record.runId === runId && (!best || record.startedAtMs > best.startedAtMs)) {
        best = record;
      }
    }
    return best;
  }

  /**
   * One execution by its own id, whatever state it is in.
   *
   * A submission is tied to the execution it launched, not to its run: a run
   * may have started something else since, and only *this* execution's exit
   * code may decide whether the evidence was recorded. Restored ended
   * launches are tracked too, so this still answers after a window reload.
   */
  recordById(executionId: string): ExecutionRecord | undefined {
    for (const { record } of this.tracked.values()) {
      if (record.id === executionId) {
        return record;
      }
    }
    return undefined;
  }

  /**
   * What one execution printed, when this window watched it. Undefined when
   * the execution is not known here or nothing was collected (a reattached
   * launch from before a reload has no output to give).
   */
  async outputOf(executionId: string): Promise<string | undefined> {
    for (const item of this.tracked.values()) {
      if (item.record.id === executionId) {
        const output = (await item.output)?.trim();
        return output ? output : undefined;
      }
    }
    return undefined;
  }

  /** What a window reload would find in workspaceState, reduced to run id and state. */
  persisted(): { runId: string; state: "running" | "unknown" | "ended" }[] {
    return this.context.workspaceState
      .get<PersistedLaunch[]>(LAUNCHES_KEY, [])
      .map((launch) => ({ runId: launch.runId, state: launch.ended ? ("ended" as const) : launch.state === "unknown" ? ("unknown" as const) : ("running" as const) }));
  }

  /**
   * The name of the terminal hosting this run's live execution, when this
   * window launched or observed one. Which terminal a runner is in is part of
   * what the ownership boundary promises, so the integration tests can read
   * it; nothing in the UI claims anything from it.
   */
  hostingTerminal(runId: string): string | undefined {
    return this.liveItemFor(runId)?.terminal?.name;
  }

  /**
   * A person has stated that the runner of one exact execution is no longer
   * active.
   *
   * This exists because `unknown` must not be a resting place: a runner
   * nothing could attribute leaves liveness unknown, and without a way out
   * every action for that run stays withheld for ever. It is deliberately an
   * assertion and not an observation — the detail says so, and no exit code
   * is invented for it, so nothing downstream can read it as the engine
   * having succeeded or failed.
   *
   * It targets the execution id, not the run, so a panel rendered before a
   * newer execution started cannot end that newer one.
   */
  confirmInactive(runId: string, executionId: string): { confirmed: boolean; reason?: "not-found" | "already-ended" } {
    const item = [...this.tracked.values()].find((candidate) => candidate.record.id === executionId && candidate.record.runId === runId);
    if (!item) {
      return { confirmed: false, reason: "not-found" };
    }
    if (item.record.state === "ended") {
      return { confirmed: false, reason: "already-ended" };
    }
    this.stopProbe(item);
    this.end(item, undefined, "You confirmed that this runner is no longer active. Agent Sparring could not establish that itself, so this is recorded as your statement rather than as an observation.");
    return { confirmed: true };
  }

  /** Send Ctrl-C to the exact terminal hosting this run's live execution. */
  stop(runId: string): boolean {
    const item = this.liveItemFor(runId);
    if (!item?.terminal) {
      return false;
    }
    item.terminal.sendText("\u0003", false); // ETX, i.e. Ctrl-C
    item.terminal.show(true);
    this.log(`sent Ctrl-C to the terminal running ${describe(item)}`);
    return true;
  }

  /**
   * The latest execution this window actually watched, ignoring anything a
   * process probe inferred. A probe is a snapshot of one moment with no
   * event to tell it when that moment passed; a watched execution outranks
   * it and must never be replaced by one.
   */
  private watchedExecutionFor(runId: string): ExecutionRecord | undefined {
    let best: ExecutionRecord | undefined;
    for (const { record } of this.tracked.values()) {
      if (record.runId === runId && record.source !== "probed" && (!best || record.startedAtMs > best.startedAtMs)) {
        best = record;
      }
    }
    return best;
  }

  private dropProbed(runId: string): void {
    for (const [id, item] of this.tracked) {
      if (item.record.runId === runId && item.record.source === "probed") {
        this.stopProbe(item);
        this.tracked.delete(id);
      }
    }
  }

  private liveItemFor(runId: string): Tracked | undefined {
    return [...this.tracked.values()].filter((item) => item.record.runId === runId && item.record.state !== "ended").sort((a, b) => b.record.startedAtMs - a.record.startedAtMs)[0];
  }

  // ---------------------------------------------------------------- launching

  /**
   * Run the sparring CLI with `args` in a fresh integrated terminal (the
   * user's normal shell, cwd = project) through shell integration, handing
   * the shell a bare `sparring` (or the configured path) as executable plus
   * an argument array, so the shell's own PATH and environment resolve it;
   * the extension host's PATH is never consulted for that. Arguments that
   * VS Code's own escaping would hand the shell as syntax rather than as
   * text — free-text `--evidence`, above all — are quoted here instead
   * (`executeThroughShell`).
   *
   * Falls back to a dedicated terminal whose process *is* the runner, with
   * the argument array passed to the process and no shell in between, when
   * shell integration does not appear in time or when this shell's quoting
   * is not one the extension can write. Then a bare name must be resolvable
   * from this process, or the launch fails with a configuration message.
   */
  async launch(options: LaunchOptions): Promise<LaunchResult> {
    // Before anything else — before the executable is resolved, before a
    // terminal is acquired, before a byte is sent — the operation is claimed.
    // That claim is what forbids a second command for this run, whether the
    // first one is still being prepared, has been given to a shell, is
    // executing in a shell, or is running as a process of ours. There is one
    // authority for all of those (operationRegistry.ts); this launcher does
    // not keep a second opinion about any of them.
    const key = runnerKey(options.runId);
    const label = `${options.kind} ${options.stageId ?? options.planPath ?? options.manifest ?? ""}`.trim();
    const admission = this.operations.claim({
      key,
      caller: "runner",
      label,
      repoRoot: options.repoRoot ?? options.cwd,
      sparringDir: options.sparringDir,
      cwd: options.cwd,
      subcommand: options.kind,
      runId: options.runId,
      runnerKind: options.kind,
      stageId: options.stageId,
      planPath: options.planPath,
      manifest: options.manifest,
    });
    if (!admission.admitted) {
      const blocked = admission.blocked;
      this.log(`refused to launch ${options.name}: ${blocked.label} is ${describeHold(blocked)}; a second command for this run is not submitted`);
      // Only something a person could actually tell us about is offered for
      // an override; work this window is watching is not.
      return { ok: false, error: admissionRefusal(blocked), problem: "unconfirmed", submission: outstanding(blocked) ? blocked : undefined };
    }
    const claim = admission.claim;
    const configured = await planExecutable(options.configured, hostEnv(options.cwd), true);
    if (!configured.ok) {
      this.log(`refused to launch ${options.name}: ${configured.error}`);
      this.operations.release(claim, "the executable could not be resolved, so nothing was ever submitted");
      return { ok: false, error: configured.error, problem: configured.problem };
    }
    // This project's terminal, reused only when its shell is genuinely idle:
    // a plan run is a long series of commands and each one used to leave a
    // dead tab behind, but a terminal someone else is using is never written
    // to (terminalPool.ts).
    const lease = this.terminals.acquire(options.cwd);
    if (options.reveal) {
      lease.terminal.show(true);
    }
    const integration = await awaitShellIntegration(lease.terminal);
    const word = executableWord(configured.plan);
    // Whether this shell can be given the command at all is decided before
    // anything durable is written, so an operation that must take the
    // shell-less route is never armed for a shell.
    const handover = integration ? shellHandoverFor(word, options.args) : undefined;
    if (integration && handover && handover.via !== "no-shell") {
      // The durable execution intent, on disk before the hand-over. A crash
      // between the two then leaves a record that blocks conservatively
      // rather than nothing at all; a failed write means nothing is handed
      // over, because a started operation with no record is the one outcome
      // that cannot be recovered from.
      const armed = await this.operations.arm(claim, "shell", { word, plan: configured.plan });
      if (!armed.ok) {
        lease.release();
        this.operations.release(claim, "the durable record of the intent could not be written, so the command was never handed to the shell");
        return { ok: false, error: armed.error, problem: "unconfirmed" };
      }
      // The final occupancy check and the hand-over are one step with nothing
      // awaited in between (shellHandover.ts). Between acquiring an idle
      // terminal and getting here, shell integration and the durable record
      // were both awaited, and the person can start their own command in that
      // terminal while they are: writing into it then would type the engine's
      // command line into their foreground process. Such a terminal is left
      // untouched and another idle one is used; the operation stays armed
      // while one is looked for, because nothing has executed.
      const handed = await handOverToIdleShell({ pool: this.terminals, cwd: options.cwd, lease, integration, word, args: options.args, reveal: options.reveal, log: this.log });
      if (!handed.ok) {
        if (handed.reason === "threw") {
          this.operations.handoverFailed(armed.armed, `handing the command line to the shell threw (${handed.error.message}), so nothing was submitted`);
          lease.discard();
          return { ok: false, error: `Agent Sparring could not hand ${label} to the terminal: ${handed.error.message}`, problem: "unconfirmed" };
        }
        this.operations.handoverNotInvoked(armed.armed, handed.detail);
        return {
          ok: false,
          error: `Agent Sparring did not start ${label}: ${handed.detail}. Nothing was written into any terminal, so nothing ran — try again when a terminal is free.`,
          problem: "unconfirmed",
        };
      }
      const request = handed.request;
      const leased = handed.lease;
      // The output must be read immediately after the hand-over or it is lost.
      this.operations.submittedToShell(armed.armed, leased, request.execution, collectOutput(request.execution));
      this.log(
        `submitted ${options.name} to the shell in "${leased.terminal.name}" (${configured.plan.kind === "shell" ? `'${word}' resolved by the shell` : word}, ${options.args.length} args${request.quotedHere ? ", command line quoted here" : ""}, cwd ${options.cwd}); waiting for the shell to report it started`,
      );
      const settled = await this.operations.waitForStart(armed.armed, EXECUTION_START_TIMEOUT_MS);
      if (settled.established) {
        // onEstablished has already tracked it; hand the caller that record.
        const record = this.executionFor(options.runId);
        if (record) {
          return { ok: true, record, via: "shell" };
        }
      }
      const view = this.operations.pendingShellFor(key) ?? this.operations.inFlightFor(key);
      return { ok: false, error: view ? operationRefusal(view) : "The command could not be confirmed as started.", problem: "unconfirmed", submission: view && outstanding(view) ? view : undefined };
    }
    if (integration) {
      // The shell is fine, it just cannot carry this command line; keep it.
      this.log(`${options.name}: this shell's quoting cannot be written safely, so the engine is run without a shell`);
      lease.release();
    } else {
      // A shell that never reported integration cannot be watched: nothing
      // would tell us when the command ended. It is of no further use.
      lease.discard();
    }
    const direct = await planExecutable(options.configured, hostEnv(options.cwd), false);
    if (!direct.ok) {
      this.log(`could not launch ${options.name}: shell integration unavailable and ${direct.error}`);
      this.operations.release(claim, "no executable could be resolved without a shell either, so nothing was started");
      return { ok: false, error: direct.error, problem: direct.problem };
    }
    const path = executableWord(direct.plan);
    // Same ordering for the transport that spawns a process of its own: the
    // intent is durable before `createTerminal`, which is irreversible.
    const armed = await this.operations.arm(claim, "dedicated-terminal", { word: path, plan: direct.plan });
    if (!armed.ok) {
      this.operations.release(claim, "the durable record of the intent could not be written, so no dedicated terminal was created");
      return { ok: false, error: armed.error, problem: "unconfirmed" };
    }
    this.dropEnded(options.runId);
    let dedicatedTerminal: vscode.Terminal;
    try {
      dedicatedTerminal = vscode.window.createTerminal({
        name: `Agent Sparring — ${options.name}`,
        shellPath: path,
        shellArgs: options.args,
        cwd: options.cwd,
        iconPath: new vscode.ThemeIcon("debug-alt"),
      });
    } catch (error) {
      this.operations.handoverFailed(armed.armed, `creating the dedicated terminal threw (${(error as Error).message}), so no process was started`);
      return { ok: false, error: `Agent Sparring could not start ${label} without a shell: ${(error as Error).message}`, problem: "unconfirmed" };
    }
    if (options.reveal) {
      dedicatedTerminal.show(true);
    }
    const item = this.track(options, "terminal", dedicatedTerminal, undefined);
    item.word = path;
    item.plan = direct.plan;
    item.dedicated = true;
    // This terminal's process *is* the runner, so the operation is under way
    // for as long as that terminal lives. The guard stays with the registry
    // — which persists the transport as `dedicated-terminal`, so however
    // many reloads follow, this is still known to be a dedicated runner —
    // and is released by evidence about that process: its terminal closing,
    // or the process table saying the pid is gone or is no longer this
    // operation. This launch record carries the liveness the Overview shows;
    // it is not a second admission authority.
    // Nothing here treats that terminal closing as the end of the operation.
    // Real testing showed the process can survive `terminal.dispose()`, so
    // the registry loses its *observation* and keeps the guard, settling it
    // from the process table or from a person. This file's launch record ends
    // with the terminal because that is all liveness can honestly say about a
    // runner it can no longer see; it is not an admission authority.
    this.operations.runningDedicated(armed.armed, dedicatedTerminal, `it runs as the process of a dedicated terminal "${dedicatedTerminal.name}"`);
    this.log(`launched ${options.name} in a dedicated terminal (shell integration unavailable; ${path}, ${options.args.length} args, cwd ${options.cwd})`);
    void this.persistWithPid(item, dedicatedTerminal);
    this.changeEmitter.fire("started");
    return { ok: true, record: item.record, via: "terminal" };
  }

  private track(options: Pick<LaunchOptions, "runId" | "kind" | "stageId" | "planPath" | "manifest" | "repoRoot" | "sparringDir">, source: ExecutionSource, terminal: vscode.Terminal | undefined, execution: vscode.TerminalShellExecution | undefined, startedAtMs = Date.now()): Tracked {
    const id = `${startedAtMs}-${++this.counter}`;
    const item: Tracked = {
      record: { id, runId: options.runId, kind: options.kind, source, state: "running", startedAtMs },
      kind: options.kind,
      stageId: options.stageId,
      planPath: options.planPath,
      manifest: options.manifest,
      repoRoot: options.repoRoot,
      sparringDir: options.sparringDir,
      terminal,
      execution,
    };
    this.tracked.set(id, item);
    return item;
  }

  private dropEnded(runId: string, except?: string): void {
    for (const [id, item] of this.tracked) {
      if (item.record.runId === runId && item.record.state === "ended" && id !== except) {
        this.tracked.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------- establishment

  /**
   * The registry reports that the shell started (or finished) a command this
   * window submitted. That is the first moment there is a runner, so — and
   * only then — it becomes an ordinary tracked execution: persisted,
   * announced, ended by its own end event. A late start is no different from
   * a prompt one except in the log.
   */
  private onEstablished(event: Establishment): void {
    const submitted = event.operation;
    if (submitted.caller !== "runner" || !submitted.runId || !submitted.runnerKind) {
      return; // a short engine command: the command runner owns that one
    }
    this.dropEnded(submitted.runId);
    const item = this.track(
      { runId: submitted.runId, kind: submitted.runnerKind, stageId: submitted.stageId, planPath: submitted.planPath, manifest: submitted.manifest, repoRoot: submitted.repoRoot },
      "launched",
      event.terminal,
      event.execution,
    );
    item.word = submitted.word;
    item.plan = submitted.plan;
    item.lease = submitted.lease;
    item.output = submitted.output ?? collectOutput(event.execution);
    this.log(`${submitted.label} is running in "${event.terminal.name}"`);
    void this.persistWithPid(item, event.terminal);
    this.changeEmitter.fire("started");
    if (event.ended) {
      // The shell told us about the end before we saw a start: it ran, and it
      // is over. Both halves are recorded, in that order.
      this.end(item, event.ended.exitCode, undefined);
    }
  }

  // ---------------------------------------------------------------- shell integration events

  private onExecutionStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const own = this.itemForExecution(event.execution);
    if (own) {
      return; // our own launch; the registry established it and it is tracked
    }
    // Another command starting in a terminal that hosts a tracked runner
    // means the foreground relationship there changed. It does not mean the
    // runner ended: `^Z` then `bg` leaves it running while the shell takes
    // the next command. So what this window can watch is over — which is
    // `unknown`, not "Stopped", and the person's confirmation is the way out.
    for (const item of this.itemsHostedIn(event.terminal)) {
      item.record = {
        ...item.record,
        state: "unknown",
        detail:
          "Another command has taken the foreground in the terminal this run was started in. That changes what can be watched there, not what is running — a suspended engine put in the background leaves exactly this trace. Agent Sparring cannot determine whether the previous runner is still active.",
      };
      this.log(`${describe(item)}: another command took the foreground in its terminal; that settles nothing, so liveness stays unknown`);
      void this.persist();
      this.changeEmitter.fire("changed");
    }
    const parsed = parseSparringCommand(event.execution.commandLine.value);
    if (!parsed) {
      return;
    }
    const cwd = event.execution.cwd?.fsPath ?? event.shellIntegration.cwd?.fsPath;
    const match = matchSparringCommand(parsed, cwd, this.locations());
    if (!match) {
      this.log(`saw a sparring ${parsed.subcommand} command in a terminal but could not tie it to a known project (cwd ${cwd ?? "unknown"})`);
      return;
    }
    this.dropEnded(match.runId);
    const item = this.track({ runId: match.runId, kind: match.kind, stageId: match.stageId, planPath: match.planPath, repoRoot: match.location.repoRoot, sparringDir: match.location.sparringDir }, "observed", event.terminal, event.execution);
    this.log(`observed ${describe(item)} start in terminal "${event.terminal.name}"`);
    void this.persistWithPid(item, event.terminal);
    this.changeEmitter.fire("started");
  }

  private onExecutionEnded(event: vscode.TerminalShellExecutionEndEvent): void {
    const own = this.itemForExecution(event.execution);
    if (own) {
      this.end(own, event.exitCode, undefined);
      return;
    }
    // An in-flight command from before a reload finishing: VS Code may report
    // its end without our ever having seen it start, and then this is the
    // only end event there will be.
    //
    // Only for a record that holds no execution identity of its own. One
    // that does is a different execution, and another command finishing in
    // the same terminal says nothing about it — ending it here is how a
    // trivial `true`, typed after the engine was backgrounded, used to be
    // read as the engine finishing.
    for (const item of this.itemsHostedIn(event.terminal)) {
      if (item.execution === undefined) {
        this.end(item, event.exitCode, undefined);
      }
    }
  }

  /**
   * The terminal hosting a tracked execution has closed.
   *
   * An exit *status* from the pty host for a dedicated terminal is the
   * engine's own exit code, and ends the record. A terminal that merely went
   * away is not: a process that ignores or survives the hangup goes on
   * working, which real testing in VS Code confirmed, so liveness becomes
   * `unknown` — with a sentence saying why and the person's confirmation as
   * the way out — rather than "Stopped", which would be a claim nothing here
   * can make and would invite a second runner.
   */
  private onTerminalClosed(terminal: vscode.Terminal): void {
    for (const item of this.itemsHostedIn(terminal)) {
      const code = item.dedicated ? terminal.exitStatus?.code : undefined;
      if (code !== undefined) {
        this.end(item, code, undefined);
        continue;
      }
      item.terminal = undefined;
      item.record = {
        ...item.record,
        state: "unknown",
        detail: `The terminal that was running this closed without reporting an exit code. That is the end of what this window can watch, not the end of a process — one that ignores or survives the hangup keeps working. Agent Sparring cannot determine whether the previous runner is still active.`,
      };
      this.log(`${describe(item)}: its terminal closed without an exit code; that settles nothing, so liveness stays unknown`);
      if (item.terminalPid !== undefined && this.probeSupported()) {
        void this.probe(item, false);
      } else {
        this.stopProbe(item);
      }
      void this.persist();
      this.changeEmitter.fire("changed");
    }
    // A submission whose terminal has closed is settled by the registry,
    // which watches the same event and applies the same distinction.
  }

  private itemForExecution(execution: vscode.TerminalShellExecution): Tracked | undefined {
    for (const item of this.tracked.values()) {
      if (item.execution === execution) {
        return item;
      }
    }
    return undefined;
  }

  private itemsHostedIn(terminal: vscode.Terminal): Tracked[] {
    return [...this.tracked.values()].filter((item) => item.terminal === terminal && item.record.state !== "ended");
  }

  private end(item: Tracked, exitCode: number | undefined, detail: string | undefined): void {
    if (item.record.state === "ended") {
      return;
    }
    this.stopProbe(item);
    // The command is over, so the terminal is free for the next one. The
    // record of this execution lives on independently of that terminal.
    item.lease?.release();
    item.record = { ...item.record, state: "ended", endedAtMs: Date.now(), exitCode, detail };
    const how = exitCode === undefined ? "ended without an exit code (Ctrl-C, signal or terminal closed)" : exitCode === 0 ? "exited normally" : `exited with code ${exitCode}`;
    this.log(`${describe(item)} ${how}${detail ? ` — ${detail}` : ""}`);
    void this.persist();
    this.changeEmitter.fire("ended");
    if (item.record.source !== "launched" || !item.word) {
      return;
    }
    if (wasCommandNotFound(exitCode, process.platform, item.plan)) {
      this.log(`the shell reported '${item.word}' as not found (exit ${exitCode})`);
      this.notFoundEmitter.fire({ runId: item.record.runId, word: item.word, exitCode: exitCode as number });
      return;
    }
    if (exitCode !== undefined && exitCode !== 0 && !INTERRUPTED_EXITS.has(exitCode)) {
      void this.reportEngineFailure(item, exitCode);
    }
  }

  /**
   * The executable ran and failed. What the user needs is what it printed,
   * so the whole output goes to the log and the event carries it; nothing
   * here guesses at a cause from the exit code.
   */
  private async reportEngineFailure(item: Tracked, exitCode: number): Promise<void> {
    const output = (await item.output) ?? "";
    for (const line of output.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "")) {
      this.log(`  ${line}`);
    }
    this.engineFailedEmitter.fire({ runId: item.record.runId, kind: item.kind, word: item.word as string, exitCode, output });
  }

  // ---------------------------------------------------------------- persistence + reload

  private async persistWithPid(item: Tracked, terminal: vscode.Terminal): Promise<void> {
    try {
      item.terminalPid = await terminal.processId;
    } catch {
      item.terminalPid = undefined;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const live: PersistedLaunch[] = [];
    const ended: PersistedLaunch[] = [];
    for (const item of this.tracked.values()) {
      if (item.record.source === "probed") {
        // An inference about one past moment, with no terminal behind it and
        // nothing to re-tie it to after a reload. The next window reads the
        // process table itself rather than inheriting this one's answer.
        continue;
      }
      const common = {
        id: item.record.id,
        runId: item.record.runId,
        kind: item.kind,
        stageId: item.stageId,
        planPath: item.planPath,
        manifest: item.manifest,
        repoRoot: item.repoRoot,
        sparringDir: item.sparringDir,
        // The transport, not the observation: what this launch *is* never
        // changes, however often the window reloads and re-finds it.
        transport: (item.dedicated ? "dedicated-terminal" : "shell") as "dedicated-terminal" | "shell",
        source: item.record.source,
        startedAtMs: item.record.startedAtMs,
        terminalPid: item.terminalPid ?? 0,
        terminalName: item.terminal?.name ?? "",
        enginePid: item.enginePid,
        generation: item.generation,
      };
      if (item.record.state === "ended") {
        ended.push({ ...common, ended: { atMs: item.record.endedAtMs ?? Date.now(), exitCode: item.record.exitCode, detail: item.record.detail } });
      } else {
        // Both running and unknown are kept, and an unknown one is kept even
        // though its terminal never came back: that a runner's fate could not
        // be established is exactly the fact the next window needs, and
        // dropping it stranded the person's evidence submission with no way
        // to retry it.
        live.push({ ...common, state: item.record.state === "running" ? "running" : "unknown", detail: item.record.detail });
      }
    }
    await this.context.workspaceState.update(LAUNCHES_KEY, [...live, ...newestEndedPerRun(ended)]);
    // Submissions are persisted by the registry, under their own key: a
    // reload must never find one among the launches.
  }

  /**
   * After activation: every launch recorded before the window reloaded is
   * re-tied to its terminal by process id. Found and a dedicated runner
   * terminal → running (the terminal exists only while the process does).
   * Found and a shell terminal → a POSIX process probe decides running /
   * ended; elsewhere the state stays `unknown`. Not found within the
   * reconnect grace period → ended (the shell that hosted it is gone).
   *
   * A launch recorded as already ended is restored as ended and nothing is
   * looked for: the observation that it died was made before the reload and
   * a reload does not un-make it.
   */
  async reattach(): Promise<void> {
    const restored = this.operations.restore();
    const launches = this.context.workspaceState.get<PersistedLaunch[]>(LAUNCHES_KEY, []);
    if (launches.length === 0 && restored.length === 0) {
      return;
    }
    const pending = new Map<string, PersistedLaunch>();
    for (const launch of launches) {
      const item: Tracked = {
        record: {
          id: launch.id,
          runId: launch.runId,
          kind: launch.kind,
          source: launch.source,
          state: "unknown",
          startedAtMs: launch.startedAtMs,
          detail: launch.state === "unknown" && launch.detail ? launch.detail : "The window reloaded; looking for the terminal that hosted this run.",
        },
        kind: launch.kind,
        stageId: launch.stageId,
        planPath: launch.planPath,
        manifest: launch.manifest,
        repoRoot: launch.repoRoot,
        sparringDir: launch.sparringDir,
        terminalPid: launch.terminalPid,
        enginePid: launch.enginePid,
        generation: launch.generation,
        // The immutable transport decides this, with the old `source` read
        // only for records written before that field existed. A dedicated
        // runner whose source had already become `reattached` used to be
        // forgotten here on the second reload.
        dedicated: launch.transport ? launch.transport === "dedicated-terminal" : launch.source === "terminal",
      };
      if (launch.ended) {
        item.record = { ...item.record, state: "ended", endedAtMs: launch.ended.atMs, exitCode: launch.ended.exitCode, detail: launch.ended.detail };
      } else {
        pending.set(launch.id, launch);
      }
      this.tracked.set(launch.id, item);
    }
    this.changeEmitter.fire("changed");
    const reviving = launches.length - pending.size;
    this.log(`window reloaded with ${launches.length} recorded launch(es)${reviving > 0 ? ` (${reviving} already ended before the reload)` : ""}; re-establishing runner liveness`);
    if (pending.size === 0 && restored.length === 0) {
      return;
    }
    const tryTerminal = async (terminal: vscode.Terminal) => {
      let pid: number | undefined;
      try {
        pid = await terminal.processId;
      } catch {
        return;
      }
      for (const [id, launch] of pending) {
        if (launch.terminalPid === pid) {
          pending.delete(id);
          await this.reattachTo(this.tracked.get(id) as Tracked, terminal);
        }
      }
      // A terminal coming back is told to the registry, which re-ties any
      // submission that terminal took. It settles nothing: the execution
      // identity is gone, so only that terminal closing, its shell turning
      // out to be dead, or the command itself appearing in the process table
      // can.
      if (pid !== undefined) {
        this.operations.reconnect(pid, terminal);
      }
    };
    const opened = vscode.window.onDidOpenTerminal((terminal) => void tryTerminal(terminal));
    await Promise.all(vscode.window.terminals.map(tryTerminal));
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_MS));
    opened.dispose();
    // Nothing is concluded here about a launch whose terminal did not come
    // back, and nothing about the operation guard either.
    //
    // The reconnect grace period is about VS Code's timing and nothing else.
    // A terminal that has not reappeared within six seconds is not a dead
    // runner: it may be a persistent session still being restored, or a
    // window that reloaded while the process kept running under the pty
    // host. Declaring such a launch ended used to look tidy and was simply
    // wrong — it turned a live runner into "Stopped" and offered a second
    // one. Liveness stays `unknown`, the guard stays with the registry, and
    // both are settled only by evidence: the terminal closing, the process
    // table proving that pid is gone or is no longer this operation, or a
    // person's explicit override.
    for (const id of pending.keys()) {
      const item = this.tracked.get(id);
      if (item && item.record.state !== "ended") {
        item.record = {
          ...item.record,
          state: "unknown",
          detail: `The terminal that hosted this run has not reappeared since the window reloaded. That is a timing fact about VS Code, not evidence about the runner, so nothing is concluded: ${
            this.probeSupported() ? "the process table is being asked whether its process is still there." : `no process probe is available on ${process.platform}, so this stays unknown until you say otherwise.`
          }`,
        };
        this.log(`${describe(item)}: its terminal did not reappear after the reload; that settles nothing, so liveness stays unknown and the operation stays guarded`);
        if (item.terminalPid !== undefined && this.probeSupported()) {
          await this.probe(item, true);
          if (item.record.state === "running") {
            item.probeTimer = setInterval(() => void this.probe(item, false), PROBE_INTERVAL_MS);
          }
        }
      }
    }
    this.changeEmitter.fire("changed");
    await this.persist();
  }

  private async reattachTo(item: Tracked, terminal: vscode.Terminal): Promise<void> {
    item.terminal = terminal;
    if (item.dedicated) {
      // The terminal's process *is* the runner: present means alive. Read
      // from the immutable transport, so the third and tenth reload know
      // this as well as the first did — `source` becomes `reattached` here,
      // which is an observation and must not decide what this launch is.
      item.record = { ...item.record, state: "running", source: "reattached", detail: undefined };
      this.log(`${describe(item)}: its dedicated terminal survived the reload; runner alive`);
      this.changeEmitter.fire("changed");
      return;
    }
    if (!this.probeSupported()) {
      item.record = {
        ...item.record,
        state: "unknown",
        detail: `The terminal "${terminal.name}" that hosted this run survived the reload, but VS Code exposes no way to tell whether the command inside it is still running, and no process probe is available on this platform.`,
      };
      this.log(`${describe(item)}: terminal found after reload; liveness unknown on ${process.platform}`);
      this.changeEmitter.fire("changed");
      return;
    }
    await this.probe(item, true);
    if (item.record.state === "running") {
      item.probeTimer = setInterval(() => void this.probe(item, false), PROBE_INTERVAL_MS);
    }
  }

  /**
   * One round of process evidence for a reattached launch.
   *
   * The distinction that matters, and that this used to get wrong: a strict
   * command matcher that finds nothing answers "I cannot attribute any
   * process to this run", which is not "this run's process has ended".
   * Ending the launch on it turned a live runner — one launched with a
   * relative `--repo-root .`, or through a wrapper that `ps` reports
   * differently — into "Stopped", and offered a second one.
   *
   * So a launch is ended here only by a fact about a *process*: a pid that
   * was once positively attributed to this run and is now gone, or is now a
   * different process carrying the same number. Until such a pid is known,
   * failure to attribute leaves liveness `unknown`, and the person's explicit
   * confirmation is the way out of it.
   */
  private async probe(item: Tracked, first: boolean): Promise<void> {
    if (item.record.state === "ended" || item.terminalPid === undefined) {
      this.stopProbe(item);
      return;
    }
    let processes: ProcessInfo[];
    try {
      processes = await this.probeProcesses();
    } catch (error) {
      item.record = { ...item.record, state: "unknown", detail: `The terminal that hosted this run survived the reload, but the process probe failed: ${(error as Error).message}` };
      this.stopProbe(item);
      this.changeEmitter.fire("changed");
      return;
    }
    const target = { kind: item.kind, repoRoot: item.repoRoot, sparringDir: item.sparringDir, stageId: item.stageId, planPath: item.planPath, manifest: item.manifest };
    const matches = (commandLine: string) => targetIsAttributable(target) && commandLineIsOperation(commandLine, target);
    // A dedicated terminal's process *is* the runner, so that pid's absence
    // from the table is a fact about the runner itself — positive evidence,
    // unlike a command line that merely cannot be matched.
    if (item.dedicated && item.enginePid === undefined && !processExists(processes, item.terminalPid)) {
      this.end(item, undefined, `The dedicated terminal's process (pid ${item.terminalPid}), which is this runner, is no longer in the process table.`);
      return;
    }
    // A pid already attributed to this run: its fate is this run's fate, and
    // a birth time recorded with it is what catches a reused pid.
    if (item.enginePid !== undefined) {
      const verdict = processGenerationVerdict(processes, item.enginePid, item.generation);
      if (verdict === "gone") {
        this.end(item, undefined, `The process that was running this run (pid ${item.enginePid}) is no longer in the process table.`);
        return;
      }
      if (verdict === "alive" || matches(processes.find((process) => process.pid === item.enginePid)?.command ?? "")) {
        this.markRunning(item, `process ${item.enginePid} is still running this run`);
        return;
      }
      item.record = {
        ...item.record,
        state: "unknown",
        detail: `The process recorded for this run (pid ${item.enginePid}) is still in the process table, but nothing positively identifies it as this run any more and no birth time was recorded to tell a reused pid from the original. Agent Sparring cannot determine whether the previous runner is still active.`,
      };
      this.changeEmitter.fire("changed");
      return;
    }
    if (!targetIsAttributable(target)) {
      // Nothing in a command line could prove this is the operation, so the
      // probe has no question to ask and `unknown` is the honest answer.
      item.record = { ...item.record, state: "unknown", detail: "This run cannot be recognised in the process table by its command line alone, so whether it is still running cannot be established here." };
      this.stopProbe(item);
      this.changeEmitter.fire("changed");
      return;
    }
    // A dedicated terminal's process is the engine itself, so the root of
    // the tree must be considered and not only its descendants; a shell's
    // is one of its children. Looking only at descendants declared every
    // live dedicated runner dead.
    const found = item.dedicated ? findSelfOrDescendant(processes, item.terminalPid, matches) : findDescendant(processes, item.terminalPid, matches);
    if (found) {
      item.enginePid = found.pid;
      item.generation = found.started;
      this.markRunning(item, `process ${found.pid} was found under its reconnected terminal`);
      void this.persist();
      return;
    }
    // Nothing could be attributed, and no pid for this run was ever
    // established, so there is nothing whose absence could mean anything.
    item.record = {
      ...item.record,
      state: "unknown",
      detail: `${first ? "The terminal that hosted this run survived the reload, but no" : "No"} process in the table can be positively attributed to this run. That is an attribution failure, not proof that it ended — a runner launched with a relative repository path, or through a wrapper, looks exactly like this while it works. Agent Sparring cannot determine whether the previous runner is still active.`,
    };
    this.log(`${describe(item)}: no process in the table could be attributed to it. A matcher that cannot recognise a process has not established that anything ended, so liveness stays unknown and the operation stays guarded.`);
    this.stopProbe(item);
    this.changeEmitter.fire("changed");
  }

  private markRunning(item: Tracked, detail: string): void {
    if (item.record.state === "running") {
      return;
    }
    item.record = { ...item.record, state: "running", source: "reattached", detail: undefined };
    this.log(`${describe(item)}: ${detail}; runner alive`);
    this.changeEmitter.fire("changed");
  }

  private stopProbe(item: Tracked): void {
    if (item.probeTimer) {
      clearInterval(item.probeTimer);
      item.probeTimer = undefined;
    }
  }

  // ---------------------------------------------------------------- untracked runs

  /**
   * Establish liveness for a run this window has no execution of at all, by
   * reading the process table for its project.
   *
   * This is the case a closed terminal plus a reload leaves behind, and the
   * case of a loop started outside VS Code. Neither can be answered from
   * anything this window watched, and `unknown` is the wrong place to leave
   * a plan whose runner is simply dead.
   *
   * Records a `probed` execution only when the answer is definite. No `ps`
   * on this platform, or a sparring runner that cannot be tied to a project,
   * records nothing: `unknown` is then the honest state and a second runner
   * must not be offered on a guess. Returns whether anything was recorded.
   */
  async probeProject(location: SparringLocation, runId: string, kind: SparringSubcommand): Promise<boolean> {
    if (this.watchedExecutionFor(runId) || !this.probeSupported()) {
      return false;
    }
    let probe: RunnerProbe;
    try {
      probe = probeRunnerProcesses(await this.probeProcesses(), location);
    } catch (error) {
      this.log(`could not read the process table for ${location.projectDir}: ${(error as Error).message}`);
      return false;
    }
    // A real observation may have arrived while `ps` ran; it outranks a probe.
    if (this.watchedExecutionFor(runId)) {
      return false;
    }
    // An earlier probe's answer is about an earlier moment. This one replaces
    // it, so a runner that has since started is not masked by "it was gone".
    this.dropProbed(runId);
    if (probe.kind === "unattributable") {
      this.log(`a sparring runner is running but names no --repo-root or --sparring-dir, so it cannot be tied to ${location.projectDir}; liveness stays unknown`);
      return false;
    }
    const item = this.track({ runId, kind }, "probed", undefined, undefined);
    if (probe.kind === "alive") {
      // This says there is *a* runner in this project. It does not say that a
      // command submitted for this run started: a `run-loop` for some other
      // stage is a different process entirely. Attribution — whether the
      // process is this exact command — belongs to the registry, which
      // matches command lines itself and leaves everything else unresolved.
      this.log(`no execution of ${kind} was watched from this window, but a sparring runner for ${location.projectDir} is running (pid ${probe.process.pid})`);
      // Nothing will tell us when it ends: there is no terminal behind it and
      // no shell execution to fire an end event. Keep asking the process
      // table, or this record would hold the UI at Running for ever.
      item.probeTimer = setInterval(() => void this.reprobe(item, location), PROBE_INTERVAL_MS);
      this.changeEmitter.fire("started");
      return true;
    }
    item.record = {
      ...item.record,
      state: "ended",
      endedAtMs: Date.now(),
      detail: "The plan runner is no longer running: no sparring process for this project exists.",
    };
    this.log(`no execution of ${kind} was watched from this window and no sparring runner for ${location.projectDir} is running; the runner is gone`);
    this.changeEmitter.fire("ended");
    return true;
  }

  /** Keep a probed-alive record honest: end it when its project's runner is gone. */
  private async reprobe(item: Tracked, location: SparringLocation): Promise<void> {
    if (item.record.state === "ended" || !this.tracked.has(item.record.id)) {
      this.stopProbe(item);
      return;
    }
    let probe: RunnerProbe;
    try {
      probe = probeRunnerProcesses(await this.probeProcesses(), location);
    } catch {
      return; // A transient `ps` failure is not evidence that anything ended.
    }
    if (probe.kind === "none") {
      this.end(item, undefined, "The runner that was found in the process table is no longer running.");
    }
  }
}

/** Keep only the most recent ended execution per run; older ones say nothing the newest does not. */
function newestEndedPerRun(ended: PersistedLaunch[]): PersistedLaunch[] {
  const byRun = new Map<string, PersistedLaunch[]>();
  for (const launch of ended) {
    byRun.set(launch.runId, [...(byRun.get(launch.runId) ?? []), launch]);
  }
  return [...byRun.values()].flatMap((launches) => launches.sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, ENDED_KEPT_PER_RUN));
}

function describe(item: Tracked): string {
  return `${item.kind} ${item.stageId ?? item.planPath ?? item.manifest ?? ""}`.trim();
}

/** Why an operation key was already held, for the log. */
function describeHold(blocked: OperationView): string {
  switch (blocked.state) {
    case "reserved":
      return "already being prepared for a terminal";
    case "armed":
      return "already recorded as about to run, so it may have started";
    case "submitted-shell":
      return "already submitted to a shell and may still execute";
    case "running-shell":
      return "already running in the shell it was given to";
    case "running-direct":
      return "already running as a process of this window";
    case "running-dedicated":
      return "already running as the process of a dedicated terminal";
  }
}
