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
 *    when shell integration never becomes available; ended when that
 *    terminal closes (VS Code closes it as soon as the process exits);
 *  - commands typed by the user in any integrated terminal, recognised from
 *    the shell-integration start event's command line and cwd;
 *  - launches recorded in workspaceState before a window reload, re-found by
 *    their terminal's process id and, on POSIX, confirmed alive by a
 *    process-table probe; without a probe they stay `unknown`;
 *  - and, for a run none of the above ever saw, the process table read
 *    directly for its project (`probeProject`). That is the only way to
 *    answer for a runner whose terminal was closed before a reload, or one
 *    started outside VS Code entirely.
 *
 * Any shell execution starting or ending in a terminal that hosts a tracked
 * runner, and the terminal closing, end that runner: a shell runs one
 * foreground command at a time. Ended records are kept (until the next
 * launch for the same run) so a stale `turn.started` can be presented as
 * "interrupted" instead of "running" — and they are persisted across a
 * window reload for the same reason, since a reload does not un-observe a
 * runner's death.
 *
 * ## Submitting is not running
 *
 * Handing a command line to `shellIntegration.executeCommand` submits it. The
 * shell may run it at once, or much later — a stopped shell (SIGSTOP) takes
 * the line and runs it when it continues — or never. So a submission is kept
 * in a *separate* structure (`Pending`, below) and becomes a `Tracked`
 * execution only when the shell reports that exact execution as started:
 *
 *   pending (waiting) ──exact start event──▶ running (Tracked, "launched")
 *          │        └──exact end event────▶ running, then ended
 *          │ user-facing wait expires
 *          ▼
 *   pending (uncertain) ──exact start event (late)──▶ running, persisted,
 *          │                                          announced as usual
 *          ├──its terminal closed / shell exited────▶ resolved: never ran
 *          ├──a process probe finds this run's runner▶ resolved: it started
 *          └──the person discards it────────────────▶ resolved by hand
 *
 * Nothing pending is ever a runner: `executionFor`, `recordById` and the
 * persisted launches describe observed executions only. A pending submission
 * is asked for on its own (`pendingFor`), and it blocks a second command for
 * the same run — not because a runner is alive, but because nobody can yet
 * say that one is not about to be.
 */

import * as vscode from "vscode";
import { executableWord, planExecutable, wasCommandNotFound, type ExecutablePlan, type ExecutableProblem } from "../core/cli";
import type { SparringLocation } from "../core/discovery";
import type { ExecutionRecord, ExecutionSource } from "../core/liveness";
import { findDescendant } from "../core/processTree";
import { probeRunnerProcesses, type RunnerProbe } from "../core/runnerProcesses";
import { commandLineRuns, matchSparringCommand, parseSparringCommand, type SparringSubcommand } from "../core/sparringCommand";
import { listProcesses, processProbeSupported } from "./processProbe";
import { awaitShellIntegration, EXECUTION_START_TIMEOUT_MS, executeThroughShell, hostEnv, SHELL_INTEGRATION_TIMEOUT_MS } from "./shellIntegration";
import { collectOutput } from "./terminalOutput";
import type { TerminalLease, TerminalPool } from "./terminalPool";

export { EXECUTION_START_TIMEOUT_MS, SHELL_INTEGRATION_TIMEOUT_MS };

const LAUNCHES_KEY = "agentSparring.launches";
/** Submitted commands whose start was never observed; kept apart from the launches on purpose. */
const PENDING_KEY = "agentSparring.pendingSubmissions";
/** After a reload, how long reconnected terminals get to appear before a recorded launch is declared gone. */
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
  | { ok: false; error: string; problem: LaunchProblem; pending?: PendingSubmission };

/**
 * A command this window handed to a shell whose start has not been observed.
 *
 * It is deliberately not an `ExecutionRecord`: there is no execution to
 * describe. What it carries is identity — enough to recognise the exact
 * execution if it starts later, to keep its terminal out of reuse, and to
 * refuse a second copy of the same operation meanwhile.
 */
export interface PendingSubmission {
  id: string;
  runId: string;
  kind: SparringSubcommand;
  /** When the command line was handed to the shell. */
  submittedAtMs: number;
  /** `waiting` while the caller is still waiting; `uncertain` once that wait has expired. */
  state: "waiting" | "uncertain";
  terminalName?: string;
  /**
   * Restored from workspaceState after a window reload. VS Code cannot hand
   * back a `TerminalShellExecution`, so such a submission can no longer be
   * recognised by identity: only a process probe, the terminal going away, or
   * the person can settle it.
   */
  restored: boolean;
}

/** How a pending submission was settled, for the log and for the tests. */
export type PendingOutcome = "started" | "terminal-gone" | "probed-running" | "discarded";

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
  terminal?: vscode.Terminal;
  terminalPid?: number;
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
}

/**
 * A submitted command line, before anything is known about whether the shell
 * ran it. Everything here exists to answer one question later: *is this exact
 * execution the one we submitted?*
 */
interface Pending {
  id: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  submittedAtMs: number;
  state: "waiting" | "uncertain";
  /** The command word or path that was submitted. */
  word?: string;
  plan?: ExecutablePlan;
  terminal?: vscode.Terminal;
  terminalPid?: number;
  /** The terminal's name, kept separately because a restored submission has no terminal object. */
  terminalName?: string;
  /** The identity the shell will report if it ever starts it. Absent after a reload. */
  execution?: vscode.TerminalShellExecution;
  /** What that execution printed, read from the moment of hand-over. */
  output?: Promise<string>;
  /** The terminal it holds; retired (never reused, never closed) once the wait expires. */
  lease?: TerminalLease;
  restored: boolean;
  /** Resolves the caller that is still waiting for establishment. */
  announce?: (record: ExecutionRecord) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A pending submission as a window reload can find it. The execution identity
 * cannot be persisted, so what is kept is what makes the next window fail
 * safe: which run it was for, and which terminal took it.
 */
interface PersistedPending {
  id: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  word?: string;
  submittedAtMs: number;
  terminalPid: number;
  terminalName: string;
}

interface PersistedLaunch {
  id: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  source: ExecutionSource;
  startedAtMs: number;
  terminalPid: number;
  terminalName: string;
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
  /** Commands handed to a shell whose start has not been observed. Never runners. */
  private readonly pending = new Map<string, Pending>();
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
  ) {
    this.disposables.push(
      this.changeEmitter,
      this.notFoundEmitter,
      this.engineFailedEmitter,
      vscode.window.onDidStartTerminalShellExecution((event) => this.onExecutionStarted(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => this.onExecutionEnded(event)),
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal)),
    );
  }

  dispose(): void {
    for (const item of this.tracked.values()) {
      this.stopProbe(item);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
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
  persisted(): { runId: string; state: "running" | "ended" }[] {
    return this.context.workspaceState
      .get<PersistedLaunch[]>(LAUNCHES_KEY, [])
      .map((launch) => ({ runId: launch.runId, state: launch.ended ? ("ended" as const) : ("running" as const) }));
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
    // A command for this run is already with a shell and may still start.
    // Submitting a second one could run the operation twice.
    const unresolved = this.pendingItemFor(options.runId);
    if (unresolved) {
      const pending = view(unresolved);
      this.log(`refused to launch ${options.name}: ${describePending(unresolved)} and may still start; a second command for this run is not submitted`);
      return { ok: false, error: pendingRefusal(unresolved), problem: "unconfirmed", pending };
    }
    const configured = await planExecutable(options.configured, hostEnv(options.cwd), true);
    if (!configured.ok) {
      this.log(`refused to launch ${options.name}: ${configured.error}`);
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
    // The pending submission is registered *before* the hand-over: a start
    // event that arrives in the same tick must find something to promote, and
    // that report is the only thing that distinguishes a launch from a line
    // of text written into a terminal.
    const pending = integration ? this.submit(options, lease, word, configured.plan) : undefined;
    const request = integration ? executeThroughShell(integration, word, options.args) : undefined;
    if (request && pending) {
      pending.execution = request.execution;
      // Must be read immediately after the hand-over or output is lost.
      pending.output = collectOutput(request.execution);
      this.log(
        `submitted ${options.name} to the shell in "${lease.terminal.name}" (${configured.plan.kind === "shell" ? `'${word}' resolved by the shell` : word}, ${options.args.length} args${request.quotedHere ? ", command line quoted here" : ""}, cwd ${options.cwd}); waiting for the shell to report it started`,
      );
      const record = await this.awaitEstablished(pending);
      if (record) {
        return { ok: true, record, via: "shell" };
      }
      return { ok: false, error: pendingRefusal(pending), problem: "unconfirmed", pending: view(pending) };
    }
    if (pending) {
      // Nothing was handed over, so there is nothing to wait for.
      this.resolvePending(pending, "discarded", "this shell's quoting cannot be written safely, so nothing was submitted");
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
      return { ok: false, error: direct.error, problem: direct.problem };
    }
    this.dropEnded(options.runId);
    const path = executableWord(direct.plan);
    const dedicated = vscode.window.createTerminal({
      name: `Agent Sparring — ${options.name}`,
      shellPath: path,
      shellArgs: options.args,
      cwd: options.cwd,
      iconPath: new vscode.ThemeIcon("debug-alt"),
    });
    if (options.reveal) {
      dedicated.show(true);
    }
    const item = this.track(options, "terminal", dedicated, undefined);
    item.word = path;
    item.plan = direct.plan;
    this.log(`launched ${options.name} in a dedicated terminal (shell integration unavailable; ${path}, ${options.args.length} args, cwd ${options.cwd})`);
    void this.persistWithPid(item, dedicated);
    this.changeEmitter.fire("started");
    return { ok: true, record: item.record, via: "terminal" };
  }

  private track(options: Pick<LaunchOptions, "runId" | "kind" | "stageId" | "planPath" | "manifest">, source: ExecutionSource, terminal: vscode.Terminal | undefined, execution: vscode.TerminalShellExecution | undefined, startedAtMs = Date.now()): Tracked {
    const id = `${startedAtMs}-${++this.counter}`;
    const item: Tracked = {
      record: { id, runId: options.runId, kind: options.kind, source, state: "running", startedAtMs },
      kind: options.kind,
      stageId: options.stageId,
      planPath: options.planPath,
      manifest: options.manifest,
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

  // ---------------------------------------------------------------- pending submissions

  /** A command handed to a shell whose start has not been observed, if there is one for this run. */
  pendingFor(runId: string | undefined): PendingSubmission | undefined {
    const pending = runId ? this.pendingItemFor(runId) : undefined;
    return pending ? view(pending) : undefined;
  }

  /** Every unresolved submission, for the log, the tests and a reload's own reporting. */
  pendingSubmissions(): PendingSubmission[] {
    return [...this.pending.values()].map(view);
  }

  /**
   * The person decided: forget this submission, so the command may be given
   * again. Nothing here can prove the first one will not start — that is
   * exactly why it takes a decision — so the log records it as theirs.
   */
  discardPending(runId: string): boolean {
    const pending = this.pendingItemFor(runId);
    if (!pending) {
      return false;
    }
    this.resolvePending(pending, "discarded", "discarded on request, so the command may be given again");
    return true;
  }

  private pendingItemFor(runId: string): Pending | undefined {
    return [...this.pending.values()].filter((item) => item.runId === runId).sort((a, b) => b.submittedAtMs - a.submittedAtMs)[0];
  }

  /** Register a submission before the command line is handed to the shell. */
  private submit(options: LaunchOptions, lease: TerminalLease, word: string, plan: ExecutablePlan): Pending {
    const submittedAtMs = Date.now();
    const pending: Pending = {
      id: `pending-${submittedAtMs}-${++this.counter}`,
      runId: options.runId,
      kind: options.kind,
      stageId: options.stageId,
      planPath: options.planPath,
      manifest: options.manifest,
      submittedAtMs,
      state: "waiting",
      word,
      plan,
      terminal: lease.terminal,
      terminalName: lease.terminal.name,
      lease,
      restored: false,
    };
    this.pending.set(pending.id, pending);
    void this.rememberPending(pending);
    return pending;
  }

  /**
   * Wait for the shell to report the submitted command as started, and give
   * the caller the resulting execution record — or, when that wait expires,
   * nothing at all.
   *
   * Expiry is a *user-facing* deadline, not a verdict: the submission stays,
   * its terminal is retired from reuse (never closed, never signalled: the
   * person's own command may be what is holding that shell), and the
   * tracker's event handlers keep watching for that exact execution. A
   * stopped shell continued minutes later still promotes it properly.
   */
  private awaitEstablished(pending: Pending): Promise<ExecutionRecord | undefined> {
    return new Promise((resolve) => {
      pending.announce = (record) => {
        pending.announce = undefined;
        clearTimeout(pending.timer);
        pending.timer = undefined;
        resolve(record);
      };
      pending.timer = setTimeout(() => {
        pending.announce = undefined;
        pending.timer = undefined;
        pending.state = "uncertain";
        // The shell may yet run it, so the terminal is quarantined rather
        // than released: out of the pool, still watched, still the user's.
        pending.lease?.retire();
        this.log(
          `${describePending(pending)}: the shell in "${pending.terminal?.name ?? "?"}" has not reported it started within ${EXECUTION_START_TIMEOUT_MS} ms. Nothing is recorded as running; that terminal will not be reused, and the submission is still being watched in case the shell starts it later.`,
        );
        void this.persist();
        this.changeEmitter.fire("changed");
        resolve(undefined);
      }, EXECUTION_START_TIMEOUT_MS);
    });
  }

  /**
   * The shell reported the exact execution we submitted: now, or long after
   * the caller stopped waiting. Either way this is the first moment there is
   * a runner, so it becomes an ordinary tracked execution — persisted,
   * announced, and ended by the ordinary end event.
   */
  private promote(pending: Pending, terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): Tracked {
    const late = pending.state === "uncertain";
    this.pending.delete(pending.id);
    clearTimeout(pending.timer);
    this.dropEnded(pending.runId);
    const item = this.track({ runId: pending.runId, kind: pending.kind, stageId: pending.stageId, planPath: pending.planPath, manifest: pending.manifest }, "launched", terminal, execution);
    item.word = pending.word;
    item.plan = pending.plan;
    item.lease = pending.lease;
    item.output = pending.output ?? collectOutput(execution);
    this.log(`${describePending(pending)} started in "${terminal.name}"${late ? `, ${Math.round((Date.now() - pending.submittedAtMs) / 1000)} s after it was submitted and after the wait had expired` : ""}; the runner is alive`);
    void this.persistWithPid(item, terminal);
    pending.announce?.(item.record);
    this.changeEmitter.fire("started");
    return item;
  }

  /**
   * This submission's fate is known, and no execution came of it. The
   * terminal is retired rather than closed: whatever is in it is not ours.
   */
  private resolvePending(pending: Pending, outcome: PendingOutcome, detail: string): void {
    this.pending.delete(pending.id);
    clearTimeout(pending.timer);
    pending.timer = undefined;
    if (outcome === "discarded" || outcome === "terminal-gone") {
      pending.lease?.retire();
    }
    this.log(`${describePending(pending)}: ${detail} (${outcome})`);
    void this.persist();
    this.changeEmitter.fire("changed");
  }

  private async rememberPending(pending: Pending): Promise<void> {
    try {
      pending.terminalPid = await pending.terminal?.processId;
    } catch {
      pending.terminalPid = undefined;
    }
    await this.persist();
  }

  // ---------------------------------------------------------------- shell integration events

  private onExecutionStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const own = this.itemForExecution(event.execution);
    if (own) {
      return; // our own launch; already tracked as running
    }
    // The command we submitted to this shell, starting — immediately, or long
    // after the caller gave up waiting for it. This is the first moment it is
    // a runner, and the only thing that establishes it as one.
    const submitted = this.pendingForExecution(event.execution, event.terminal);
    if (submitted) {
      this.promote(submitted, event.terminal, event.execution);
      return;
    }
    // A shell runs one foreground command at a time: anything else starting
    // in a terminal that hosts a tracked runner means that runner has ended.
    for (const item of this.itemsHostedIn(event.terminal)) {
      this.end(item, undefined, "Another command started in its terminal, so the runner had already ended.");
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
    const item = this.track({ runId: match.runId, kind: match.kind, stageId: match.stageId, planPath: match.planPath }, "observed", event.terminal, event.execution);
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
    // The submitted command ending without our having seen it start: it ran,
    // so it is promoted and then ended, exit code and all. The record is
    // honest about a runner that existed and is over — never one that is
    // still going.
    const submitted = this.pendingForExecution(event.execution, event.terminal);
    if (submitted) {
      this.end(this.promote(submitted, event.terminal, event.execution), event.exitCode, undefined);
      return;
    }
    // An in-flight command from before a reload finishing: VS Code may report
    // its end without our ever having seen it start.
    for (const item of this.itemsHostedIn(event.terminal)) {
      this.end(item, event.exitCode, undefined);
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    for (const item of this.itemsHostedIn(terminal)) {
      const code = item.record.source === "terminal" ? terminal.exitStatus?.code : undefined;
      this.end(item, code, item.record.source === "terminal" ? undefined : "Its terminal was closed.");
    }
    // The shell that was given a command is gone, so that command can never
    // run: the submission's fate is settled, and the next one is allowed.
    for (const pending of [...this.pending.values()]) {
      if (pending.terminal === terminal) {
        this.resolvePending(pending, "terminal-gone", `its terminal "${terminal.name}" was closed before the shell ever started it, so that command can no longer run`);
      }
    }
  }

  /**
   * The submission this execution belongs to. Identity is the rule; a waiting
   * submission whose hand-over has not returned yet is matched by its
   * terminal, because that terminal is leased to us and idle-checked, so an
   * execution starting there in that instant is the one we just submitted.
   */
  private pendingForExecution(execution: vscode.TerminalShellExecution, terminal: vscode.Terminal): Pending | undefined {
    for (const pending of this.pending.values()) {
      if (pending.execution === execution) {
        return pending;
      }
    }
    for (const pending of this.pending.values()) {
      if (pending.execution === undefined && pending.state === "waiting" && !pending.restored && pending.terminal === terminal) {
        return pending;
      }
    }
    return undefined;
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
        source: item.record.source,
        startedAtMs: item.record.startedAtMs,
        terminalPid: item.terminalPid ?? 0,
        terminalName: item.terminal?.name ?? "",
      };
      if (item.record.state === "ended") {
        ended.push({ ...common, ended: { atMs: item.record.endedAtMs ?? Date.now(), exitCode: item.record.exitCode, detail: item.record.detail } });
      } else if (item.terminalPid !== undefined && item.terminal) {
        live.push(common);
      }
    }
    await this.context.workspaceState.update(LAUNCHES_KEY, [...live, ...newestEndedPerRun(ended)]);
    // Pending submissions are persisted apart from the launches, and are
    // never among them: a reload must not turn "a command may still start"
    // into either a live runner or permission to submit a second one.
    const submissions: PersistedPending[] = [...this.pending.values()].map((item) => ({
      id: item.id,
      runId: item.runId,
      kind: item.kind,
      stageId: item.stageId,
      planPath: item.planPath,
      manifest: item.manifest,
      word: item.word,
      submittedAtMs: item.submittedAtMs,
      terminalPid: item.terminalPid ?? 0,
      terminalName: item.terminalName ?? item.terminal?.name ?? "",
    }));
    await this.context.workspaceState.update(PENDING_KEY, submissions);
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
    const submissions = this.restoreSubmissions();
    const launches = this.context.workspaceState.get<PersistedLaunch[]>(LAUNCHES_KEY, []);
    if (launches.length === 0 && submissions.length === 0) {
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
          detail: "The window reloaded; looking for the terminal that hosted this run.",
        },
        kind: launch.kind,
        stageId: launch.stageId,
        planPath: launch.planPath,
        manifest: launch.manifest,
        terminalPid: launch.terminalPid,
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
    if (pending.size === 0 && submissions.length === 0) {
      return;
    }
    const looking = new Map(submissions.map((item) => [item.id, item]));

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
      for (const [id, submission] of looking) {
        if (submission.terminalPid === pid) {
          looking.delete(id);
          submission.terminal = terminal;
          submission.terminalName = terminal.name;
          // The shell that took the command is still there, and VS Code
          // cannot give back the execution identity, so nothing here can say
          // whether it ran. It stays uncertain: a process probe, that
          // terminal closing, or the person settles it.
          this.log(`${describePending(submission)}: the terminal "${terminal.name}" that took it survived the reload, so whether it ran cannot be established from events any more`);
        }
      }
    };
    const opened = vscode.window.onDidOpenTerminal((terminal) => void tryTerminal(terminal));
    await Promise.all(vscode.window.terminals.map(tryTerminal));
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_MS));
    opened.dispose();
    for (const submission of looking.values()) {
      this.resolvePending(submission, "terminal-gone", "the terminal that took it did not survive the reload, so that command can no longer run");
    }
    for (const id of pending.keys()) {
      const item = this.tracked.get(id);
      if (item && item.record.state !== "ended") {
        this.end(item, undefined, "The terminal that hosted this run was not found after the window reloaded, so the runner cannot still be alive.");
      }
    }
    await this.persist();
  }

  /**
   * Pending submissions as the previous window left them, restored as
   * `uncertain` before anything else is looked at.
   *
   * They carry no execution identity — VS Code cannot hand a
   * `TerminalShellExecution` back — so this window cannot recognise a late
   * start by events. That is deliberately not treated as "nothing happened":
   * the submission keeps blocking a second command for its run until the
   * process table finds the runner, its terminal turns out to be gone, or the
   * person discards it.
   */
  private restoreSubmissions(): Pending[] {
    const stored = this.context.workspaceState.get<PersistedPending[]>(PENDING_KEY, []);
    const restored = stored.map((item) => {
      const pending: Pending = {
        id: item.id,
        runId: item.runId,
        kind: item.kind,
        stageId: item.stageId,
        planPath: item.planPath,
        manifest: item.manifest,
        word: item.word,
        submittedAtMs: item.submittedAtMs,
        state: "uncertain",
        terminalPid: item.terminalPid,
        terminalName: item.terminalName || undefined,
        restored: true,
      };
      this.pending.set(pending.id, pending);
      return pending;
    });
    if (restored.length > 0) {
      this.log(`window reloaded with ${restored.length} command(s) submitted to a shell whose start was never confirmed; no runner is claimed for them and no second command for those runs is submitted until their fate is known`);
    }
    return restored;
  }

  private async reattachTo(item: Tracked, terminal: vscode.Terminal): Promise<void> {
    item.terminal = terminal;
    if (item.record.source === "terminal") {
      // The terminal's process is the runner: present means alive.
      item.record = { ...item.record, state: "running", source: "reattached", detail: undefined };
      this.log(`${describe(item)}: its dedicated terminal survived the reload; runner alive`);
      this.changeEmitter.fire("changed");
      return;
    }
    if (!processProbeSupported()) {
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

  private async probe(item: Tracked, first: boolean): Promise<void> {
    if (item.record.state === "ended" || item.terminalPid === undefined) {
      this.stopProbe(item);
      return;
    }
    let found = false;
    try {
      const processes = await listProcesses();
      found = findDescendant(processes, item.terminalPid, (commandLine) => commandLineRuns(commandLine, { kind: item.kind, stageId: item.stageId, planPath: item.planPath, manifest: item.manifest })) !== undefined;
    } catch (error) {
      item.record = { ...item.record, state: "unknown", detail: `The terminal that hosted this run survived the reload, but the process probe failed: ${(error as Error).message}` };
      this.stopProbe(item);
      this.changeEmitter.fire("changed");
      return;
    }
    if (found) {
      if (item.record.state !== "running") {
        item.record = { ...item.record, state: "running", source: "reattached", detail: undefined };
        this.log(`${describe(item)}: process found under its reconnected terminal; runner alive`);
        this.changeEmitter.fire("changed");
      }
      return;
    }
    this.end(item, undefined, first ? "The terminal that hosted this run survived the reload, but no runner process is running under it any more." : "Its process is no longer running under the reconnected terminal.");
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
    if (this.watchedExecutionFor(runId) || !processProbeSupported()) {
      return false;
    }
    let probe: RunnerProbe;
    try {
      probe = probeRunnerProcesses(await listProcesses(), location);
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
      // A runner exists for this project, so a command submitted for this run
      // is answered: it started. This is the one reconciliation left after a
      // reload, where execution identity cannot be restored.
      const submitted = this.pendingItemFor(runId);
      if (submitted) {
        this.resolvePending(submitted, "probed-running", "a sparring runner for this project is in the process table, so the submitted command did start");
      }
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
      probe = probeRunnerProcesses(await listProcesses(), location);
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

function describePending(pending: Pending): string {
  return `the ${pending.kind} ${pending.stageId ?? pending.planPath ?? pending.manifest ?? ""} submitted to a shell${pending.restored ? " before the window reloaded" : ""}`.replace(/\s+/g, " ").trim();
}

/** What the outside may know about a submission: identity and state, never a record. */
function view(pending: Pending): PendingSubmission {
  return {
    id: pending.id,
    runId: pending.runId,
    kind: pending.kind,
    submittedAtMs: pending.submittedAtMs,
    state: pending.state,
    terminalName: pending.terminalName ?? pending.terminal?.name,
    restored: pending.restored,
  };
}

/**
 * What a person is told when a command cannot be given because an earlier one
 * may still start. It says what is actually known — deliberately not "a
 * runner is alive", which would be a claim about a process nobody has seen.
 */
function pendingRefusal(pending: Pending): string {
  const where = pending.terminalName ?? pending.terminal?.name;
  const seconds = Math.max(1, Math.round((Date.now() - pending.submittedAtMs) / 1000));
  return [
    `Agent Sparring handed ${pending.kind}${pending.stageId ? ` ${pending.stageId}` : ""} to the terminal${where ? ` "${where}"` : ""} ${seconds} s ago but has not been able to confirm whether it started.`,
    pending.restored
      ? "The window reloaded since, so that command can no longer be recognised from events."
      : "A shell that is stopped or busy can still run it later, so running it again could run it twice.",
    `Check that terminal. If the command is not going to run, discard the submission and give it again.`,
  ].join(" ");
}
