/**
 * The one authority on commands this extension has handed to a shell and
 * cannot yet account for.
 *
 * ## The invariant
 *
 * Once an engine command has been handed to a shell, and nothing has *proved*
 * that it can no longer execute, that submission stays on the record and
 * blocks a second copy of the same operation. That is a safety fact, and its
 * lifetime is decided only by evidence:
 *
 *  - `started` — the shell reported that exact execution. It ran (a runner is
 *    then promoted to a tracked execution by the ExecutionTracker);
 *  - `ended` — the shell reported that exact execution finishing, which it
 *    only does for a command it ran;
 *  - `terminal-closed` — the terminal that took it was closed, so the pty and
 *    the shell reading it are gone and a queued line can never be read;
 *  - `shell-gone` — process inspection says the shell process that took it no
 *    longer exists (the same conclusion, for a submission whose terminal this
 *    window can no longer identify — after a reload, above all);
 *  - `attributed` — process inspection found a process running *this exact
 *    command* (same subcommand and same stage / plan / manifest), so it
 *    started;
 *  - `not-submitted` — the command line was never handed over at all (this
 *    shell's quoting could not be written), so there is nothing to run. The
 *    record then drops back to a reservation (`unsubmit`) while the caller
 *    runs the operation another way, and is `release`d if it cannot;
 *  - `released` — the operation never reached a shell at all, or the process
 *    this window ran instead of one has ended. Nothing was ever queued
 *    anywhere, so there is nothing to be afraid of;
 *  - `overridden` — a person stated that it cannot still run. That is an
 *    override, not evidence, and is recorded as such.
 *
 * What is **not** evidence, and may never end a submission's safety lifetime:
 *
 *  - any timer. The wait a caller does is a user-interface deadline; a stopped
 *    shell (SIGSTOP) runs a queued line when it continues, minutes later;
 *  - the terminal-reconnect grace period after a window reload. That a
 *    terminal did not come back within six seconds says nothing about whether
 *    its shell is alive;
 *  - some *other* runner turning up in the project's process table. "There is
 *    a runner in this project" is not "the command I queued started". Runner
 *    liveness and submission fate are different questions, and a probed
 *    runner and an unresolved submission coexist happily.
 *
 * ## Why one registry
 *
 * Both transports submit to a shell and both can therefore duplicate work: the
 * runner launcher (executionTracker.ts) and the short-command runner
 * (commandRunner.ts, freeze-candidate / accept-candidate / new-stage). There
 * is one definition of "submitted and may still execute" and one durable
 * store for it, so neither transport can be made safe and the other left
 * behind.
 *
 * Liveness stays separate: `ExecutionTracker.executionFor` answers "is there
 * an observed runner", this answers "may an earlier command still execute".
 * Neither substitutes for the other.
 *
 * ## Admission is atomic, and it is here
 *
 * Checking for an unresolved submission and then submitting is two steps, and
 * both transports had asynchronous work in between — resolving the
 * executable, acquiring a terminal, waiting for shell integration. Two clicks
 * in that window both found nothing and both went on to submit, which is the
 * duplicate the record was built to prevent. A caller-local boolean would not
 * have fixed it either: there are two callers, and the operation is one.
 *
 * So the record is taken *first*, by `claim`, which is synchronous and
 * therefore atomic against anything that can interleave in this host: one
 * operation key, at most one record, from the first instant of a launch:
 *
 *     free
 *       → reserved   `claim` — nothing can execute yet, nothing is persisted
 *       → waiting    `submit` — handed to a shell; durable from here on
 *       → uncertain  the wait expired; still durable, still blocking
 *       → direct     `runningDirectly` — another transport really started it
 *       → gone       resolved by evidence, withdrawn, released, or overridden
 *
 * A second caller that finds *any* of those states for its key is refused
 * before it resolves an executable, acquires a terminal or sends a byte.
 *
 * `reserved` and `direct` are this window's own in-flight work: they are not
 * persisted, because a reload cannot leave either of them able to execute —
 * a reservation never reached a shell, and a direct child process does not
 * outlive the extension host that spawned it. Only what a *shell* was given
 * is written down, which is the durable semantics that was there before.
 *
 * Because a key holds one record, `override` and `withdraw` act on that exact
 * record rather than picking one of several with the same key.
 */

import * as vscode from "vscode";
import type { ExecutablePlan } from "../core/cli";
import { commandLineRuns, type SparringSubcommand } from "../core/sparringCommand";
import { listProcesses, processProbeSupported } from "./processProbe";
import type { TerminalLease } from "./terminalPool";

const SUBMISSIONS_KEY = "agentSparring.submissions";
/** How often an unresolved submission's shell is looked for in the process table. */
const PID_PROBE_INTERVAL_MS = 5000;

/** Which transport submitted it: a runner command, or a short engine command. */
export type SubmissionTransport = "runner" | "command";

/**
 * Where an operation stands.
 *
 *  - `reserved` — admitted, nothing handed over yet. Blocks a second caller;
 *    never persisted, because nothing can execute;
 *  - `waiting` — handed to a shell, which has not reported it yet;
 *  - `uncertain` — the caller's wait expired; unchanged in substance;
 *  - `direct` — not a shell submission at all: a dedicated terminal or a
 *    child process this window started really is running it. Blocks for that
 *    operation's lifetime; never persisted.
 */
export type SubmissionState = "reserved" | "waiting" | "uncertain" | "direct";

/** The states in which a command was handed to a shell and may still execute on its own. */
const SUBMITTED: ReadonlySet<SubmissionState> = new Set<SubmissionState>(["waiting", "uncertain"]);

/** How a submission's fate was established. Only `overridden` is not evidence. */
export type SubmissionResolution = "started" | "ended" | "terminal-closed" | "shell-gone" | "attributed" | "not-submitted" | "overridden" | "released";

/** What a submission is, from the outside. Never an execution record. */
export interface SubmissionView {
  id: string;
  /** The operation that must not be submitted twice while this is unresolved. */
  key: string;
  transport: SubmissionTransport;
  /** Readable operation, for messages and the log. */
  label: string;
  runId?: string;
  cwd: string;
  subcommand: string;
  submittedAtMs: number;
  state: SubmissionState;
  terminalName?: string;
  terminalPid?: number;
  /** Whether this window still holds the exact execution identity (lost by a reload). */
  identifiable: boolean;
  restored: boolean;
}

/** Everything the runner launcher needs to promote a submission into a tracked execution. */
export interface EstablishedSubmission extends SubmissionView {
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
  submission: EstablishedSubmission;
  terminal: vscode.Terminal;
  execution: vscode.TerminalShellExecution;
  /** Present when the shell reported the end before this window saw the start. */
  ended?: { exitCode: number | undefined };
}

export interface SubmissionIdentity {
  key: string;
  transport: SubmissionTransport;
  label: string;
  cwd: string;
  subcommand: string;
  runId?: string;
  /** Set for a runner command, so a late start can be promoted with its own kind. */
  runnerKind?: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  word?: string;
  plan?: ExecutablePlan;
}

/**
 * A held operation key. Every transition after admission is made against
 * this, so a caller can only ever move its own record.
 */
export interface OperationClaim {
  readonly id: string;
  readonly key: string;
}

/** What `claim` answers: the key is now ours, or it is someone else's and this is who. */
export type Admission = { admitted: true; claim: OperationClaim } | { admitted: false; blocked: SubmissionView };

export type SubmissionWait =
  | { established: true; terminal: vscode.Terminal; execution: vscode.TerminalShellExecution; ended?: { exitCode: number | undefined } }
  | { established: false; view: SubmissionView };

interface Submission extends SubmissionIdentity {
  id: string;
  submittedAtMs: number;
  state: SubmissionState;
  terminal?: vscode.Terminal;
  terminalName?: string;
  terminalPid?: number;
  execution?: vscode.TerminalShellExecution;
  output?: Promise<string>;
  lease?: TerminalLease;
  restored: boolean;
  announce?: (wait: SubmissionWait) => void;
  waitTimer?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setInterval>;
}

interface PersistedSubmission {
  id: string;
  key: string;
  transport: SubmissionTransport;
  label: string;
  cwd: string;
  subcommand: string;
  runId?: string;
  runnerKind?: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  manifest?: string;
  word?: string;
  submittedAtMs: number;
  terminalPid?: number;
  terminalName?: string;
}

/** The operation key for a runner command: one unresolved submission per run. */
export function runnerKey(runId: string): string {
  return `run:${runId}`;
}

/** The operation key for a short engine command: its subcommand, project and target. */
export function commandKey(cwd: string, subcommand: string, target?: string): string {
  return `cmd:${cwd}:${subcommand}${target ? `:${target}` : ""}`;
}

export class SubmissionRegistry implements vscode.Disposable {
  private readonly submissions = new Map<string, Submission>();
  /** Operation key → the one record that holds it. The whole invariant, in one map. */
  private readonly byKey = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly establishedEmitter = new vscode.EventEmitter<Establishment>();
  /** A submitted command was reported by its shell as started (or as finished). */
  readonly onDidEstablish = this.establishedEmitter.event;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Any change to the unresolved set, so the cockpit can re-render. */
  readonly onDidChange = this.changeEmitter.event;
  private counter = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly probeSupported: () => boolean = processProbeSupported,
    private readonly probe: () => Promise<{ pid: number; command: string }[]> = listProcesses,
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
    for (const submission of this.submissions.values()) {
      clearTimeout(submission.waitTimer);
      clearInterval(submission.probeTimer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  // ---------------------------------------------------------------- queries

  /**
   * The unresolved *submission* for an operation: a command a shell was given
   * and which may still execute. A reservation or a running direct process is
   * not one of those and is deliberately not reported here — nothing is
   * queued in a shell for it, and there is nothing for a person to override.
   * Use `claim` to find out whether an operation may be started.
   */
  unresolvedFor(key: string): SubmissionView | undefined {
    const found = this.recordFor(key);
    return found && SUBMITTED.has(found.state) ? view(found) : undefined;
  }

  /** Anything in flight for this key, in any state, including a reservation. */
  inFlightFor(key: string): SubmissionView | undefined {
    const found = this.recordFor(key);
    return found ? view(found) : undefined;
  }

  /** The one record a key can have. */
  private recordFor(key: string): Submission | undefined {
    const id = this.byKey.get(key);
    return id ? this.submissions.get(id) : undefined;
  }

  /** The unresolved submission for a run, whatever operation it was. */
  unresolvedForRun(runId: string | undefined): SubmissionView | undefined {
    return runId ? this.unresolvedFor(runnerKey(runId)) : undefined;
  }

  /** Every command a shell has been given and that is not accounted for. */
  unresolved(): SubmissionView[] {
    return [...this.submissions.values()].filter((submission) => SUBMITTED.has(submission.state)).map(view);
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
   * The claim must be settled: `submit` when a shell takes the command,
   * `runningDirectly` when another transport starts it, `release` when
   * preparation fails before anything could execute.
   */
  claim(identity: SubmissionIdentity): Admission {
    const held = this.recordFor(identity.key);
    if (held) {
      return { admitted: false, blocked: view(held) };
    }
    const atMs = Date.now();
    const submission: Submission = {
      ...identity,
      id: `submission-${atMs}-${++this.counter}`,
      submittedAtMs: atMs,
      state: "reserved",
      restored: false,
    };
    this.submissions.set(submission.id, submission);
    this.byKey.set(submission.key, submission.id);
    return { admitted: true, claim: { id: submission.id, key: submission.key } };
  }

  // ---------------------------------------------------------------- submitting

  /**
   * The claimed operation is being handed to a shell. Called *before* the
   * command line is given to it, so a start event that arrives in the same
   * tick finds it, and so a crash between the two cannot lose it. This is the
   * transition that makes the record durable.
   */
  submit(claim: OperationClaim, lease: TerminalLease, details?: Pick<SubmissionIdentity, "word" | "plan">): Submission {
    const submission = this.held(claim, "reserved");
    submission.state = "waiting";
    submission.submittedAtMs = Date.now();
    submission.terminal = lease.terminal;
    submission.terminalName = lease.terminal.name;
    submission.lease = lease;
    if (details) {
      submission.word = details.word;
      submission.plan = details.plan;
    }
    void this.remember(submission);
    this.changeEmitter.fire();
    return submission;
  }

  /**
   * The command line was not handed over after all (this shell's quoting
   * could not be written), and the caller is going on to another transport.
   * Nothing was submitted, so the durable record goes — but the claim stays,
   * because the operation is still about to happen and a second copy of it
   * must still be refused.
   */
  unsubmit(claim: OperationClaim, detail: string): void {
    const submission = this.held(claim, "waiting");
    submission.state = "reserved";
    submission.terminal = undefined;
    submission.terminalName = undefined;
    submission.lease = undefined;
    submission.execution = undefined;
    clearTimeout(submission.waitTimer);
    submission.waitTimer = undefined;
    this.log(`${submission.label}: ${detail}; the operation stays claimed while it is run another way`);
    void this.persist();
    this.changeEmitter.fire();
  }

  /**
   * The operation is not going through a shell: this window started it
   * itself, in a dedicated terminal or as a child process. There is nothing
   * to wait for evidence about — it is running, observably — but a second
   * copy must be refused for as long as it runs, so the claim is held until
   * the caller `release`s it.
   */
  runningDirectly(claim: OperationClaim, detail: string): void {
    const submission = this.held(claim, "reserved");
    submission.state = "direct";
    this.log(`${submission.label}: ${detail}; a second copy of this operation is refused until it ends`);
  }

  /**
   * Give the claim back. Only for an operation that never reached a shell: a
   * reservation whose preparation failed, or a direct process that has ended.
   * A command a shell was given is never released — that needs evidence
   * (`withdraw` when it was never handed over, `override` when a person
   * takes responsibility).
   */
  release(claim: OperationClaim, detail: string): void {
    const submission = this.submissions.get(claim.id);
    if (!submission) {
      return;
    }
    if (SUBMITTED.has(submission.state)) {
      this.log(`${submission.label}: not released — it was handed to a shell, and only evidence or an override can settle that`);
      return;
    }
    this.resolve(submission, "released", detail);
  }

  /** The claimed record, asserted to be in the state this transition comes from. */
  private held(claim: OperationClaim, from: SubmissionState): Submission {
    const submission = this.submissions.get(claim.id);
    if (!submission || this.byKey.get(claim.key) !== claim.id) {
      throw new Error(`the claim on ${claim.key} is no longer held`);
    }
    if (submission.state !== from) {
      throw new Error(`${claim.key} is ${submission.state}, not ${from}`);
    }
    return submission;
  }

  /** The identity the shell will report, once `executeCommand` has returned it. */
  attach(submission: Submission, execution: vscode.TerminalShellExecution, output?: Promise<string>): void {
    submission.execution = execution;
    submission.output = output;
  }

  /**
   * Wait for the shell to report the submitted command, for as long as a
   * caller can reasonably be kept waiting.
   *
   * Expiry changes nothing about safety: the submission stays, its terminal is
   * retired from reuse (never closed or signalled — the person's own command
   * may be what is holding that shell), and evidence is still being looked
   * for, including a process probe for the shell that took it.
   */
  wait(submission: Submission, timeoutMs: number): Promise<SubmissionWait> {
    return new Promise((resolve) => {
      submission.announce = (wait) => {
        submission.announce = undefined;
        clearTimeout(submission.waitTimer);
        submission.waitTimer = undefined;
        resolve(wait);
      };
      submission.waitTimer = setTimeout(() => {
        submission.announce = undefined;
        submission.waitTimer = undefined;
        submission.state = "uncertain";
        submission.lease?.retire();
        this.log(
          `${submission.label}: the shell in "${submission.terminalName ?? "?"}" has not reported it as started within ${timeoutMs} ms. Nothing is recorded as running; that terminal will not be reused, and this submission keeps blocking a second ${submission.subcommand} until something proves it can no longer run.`,
        );
        this.startProbing(submission);
        void this.persist();
        this.changeEmitter.fire();
        resolve({ established: false, view: view(submission) });
      }, timeoutMs);
    });
  }

  // ---------------------------------------------------------------- resolution

  /**
   * A person stated that this command cannot still run, accepting the risk if
   * they are wrong. Deliberately a separate resolution from every evidential
   * one, and logged as theirs.
   */
  override(key: string, note: string): boolean {
    const submission = this.recordFor(key);
    if (!submission || !SUBMITTED.has(submission.state)) {
      // Nothing was given to a shell for this operation, so there is nothing
      // for a person to take responsibility for.
      return false;
    }
    this.resolve(submission, "overridden", note);
    return true;
  }

  private resolve(submission: Submission, resolution: SubmissionResolution, detail: string): void {
    this.submissions.delete(submission.id);
    if (this.byKey.get(submission.key) === submission.id) {
      this.byKey.delete(submission.key);
    }
    clearTimeout(submission.waitTimer);
    clearInterval(submission.probeTimer);
    submission.waitTimer = undefined;
    submission.probeTimer = undefined;
    this.log(`${submission.label}: resolved as ${resolution} — ${detail}`);
    // A caller may still be waiting for the shell to report this one (an
    // override or a closed terminal can settle it mid-wait). It is settled,
    // and settled is not established: the caller is told so rather than left
    // holding a promise nothing will ever resolve.
    submission.announce?.({ established: false, view: view(submission) });
    void this.persist();
    this.changeEmitter.fire();
  }

  // ---------------------------------------------------------------- events

  private onStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const submission = this.forExecution(event.execution, event.terminal);
    if (!submission) {
      return;
    }
    this.establish(submission, event.terminal, event.execution, undefined);
  }

  private onEnded(event: vscode.TerminalShellExecutionEndEvent): void {
    const submission = this.forExecution(event.execution, event.terminal);
    if (!submission) {
      return;
    }
    // The shell reports an end only for a command it ran.
    this.establish(submission, event.terminal, event.execution, { exitCode: event.exitCode });
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    for (const submission of [...this.submissions.values()]) {
      if (submission.terminal === terminal && SUBMITTED.has(submission.state)) {
        this.resolve(submission, "terminal-closed", `the terminal "${terminal.name}" that took it was closed, so its shell and the line it was given are gone`);
      }
    }
  }

  private establish(submission: Submission, terminal: vscode.Terminal, execution: vscode.TerminalShellExecution, ended: { exitCode: number | undefined } | undefined): void {
    const late = submission.state === "uncertain";
    // Taken before the record is settled: this waiter is being told the one
    // thing that *is* an establishment, not the generic settlement.
    const announce = submission.announce;
    submission.announce = undefined;
    this.resolve(
      submission,
      ended ? "ended" : "started",
      late
        ? `the shell in "${terminal.name}" ${ended ? "reported it finished" : "started it"} ${Math.round((Date.now() - submission.submittedAtMs) / 1000)} s after it was submitted, long after the wait had expired`
        : `the shell in "${terminal.name}" ${ended ? "reported it finished" : "started it"}`,
    );
    const establishment: Establishment = { submission: { ...view(submission), runnerKind: submission.runnerKind, stageId: submission.stageId, planPath: submission.planPath, manifest: submission.manifest, word: submission.word, plan: submission.plan, output: submission.output, lease: submission.lease }, terminal, execution, ended };
    announce?.({ established: true, terminal, execution, ended });
    this.establishedEmitter.fire(establishment);
  }

  /**
   * The submission an execution belongs to. Identity is the rule; a submission
   * whose hand-over has not returned yet is matched by its terminal, because
   * that terminal is leased to us and was idle, so an execution starting there
   * in that instant is the one just submitted.
   */
  private forExecution(execution: vscode.TerminalShellExecution, terminal: vscode.Terminal): Submission | undefined {
    for (const submission of this.submissions.values()) {
      if (submission.execution === execution && SUBMITTED.has(submission.state)) {
        return submission;
      }
    }
    for (const submission of this.submissions.values()) {
      if (submission.execution === undefined && submission.state === "waiting" && !submission.restored && submission.terminal === terminal) {
        return submission;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- process evidence

  /**
   * Look for the two things a process table can prove about a submission:
   * that the shell which took it is gone (so a queued line can never be
   * read), or that this exact command is running (so it started). Anything
   * else leaves it unresolved — a probe that cannot run, or a process table
   * without an answer, is not evidence.
   */
  private startProbing(submission: Submission): void {
    if (submission.probeTimer || !this.probeSupported()) {
      if (!this.probeSupported()) {
        this.log(`${submission.label}: no process probe is available on ${process.platform}, so its fate stays unknown until its terminal closes or you confirm it cannot run`);
      }
      return;
    }
    submission.probeTimer = setInterval(() => void this.probeOnce(submission), PID_PROBE_INTERVAL_MS);
    void this.probeOnce(submission);
  }

  /** Run one round of process evidence for every unresolved submission. */
  async probeAll(): Promise<void> {
    for (const submission of [...this.submissions.values()].filter((item) => SUBMITTED.has(item.state))) {
      await this.probeOnce(submission);
    }
  }

  private async probeOnce(submission: Submission): Promise<void> {
    if (!this.submissions.has(submission.id)) {
      clearInterval(submission.probeTimer);
      return;
    }
    if (!this.probeSupported() || !SUBMITTED.has(submission.state)) {
      // A reservation and a direct process are not questions for the process
      // table: nothing was queued in a shell for either.
      return;
    }
    let processes: { pid: number; command: string }[];
    try {
      processes = await this.probe();
    } catch {
      return; // A transient `ps` failure proves nothing.
    }
    if (!this.submissions.has(submission.id)) {
      return;
    }
    if (submission.runnerKind) {
      const running = processes.find((item) => commandLineRuns(item.command, { kind: submission.runnerKind as SparringSubcommand, stageId: submission.stageId, planPath: submission.planPath, manifest: submission.manifest }));
      if (running) {
        this.resolve(submission, "attributed", `this exact command is in the process table (pid ${running.pid}), so the shell did start it`);
        return;
      }
    }
    if (submission.terminalPid !== undefined && submission.terminalPid > 0 && !processes.some((item) => item.pid === submission.terminalPid)) {
      this.resolve(submission, "shell-gone", `the shell process ${submission.terminalPid} that took it no longer exists, so the line it was given can never be read`);
    }
  }

  // ---------------------------------------------------------------- persistence

  private async remember(submission: Submission): Promise<void> {
    try {
      submission.terminalPid = await submission.terminal?.processId;
    } catch {
      submission.terminalPid = undefined;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    // Only what a shell was actually given: a reservation and a direct
    // process cannot outlive this window, so neither is written down.
    const stored: PersistedSubmission[] = [...this.submissions.values()].filter((submission) => SUBMITTED.has(submission.state)).map((submission) => ({
      id: submission.id,
      key: submission.key,
      transport: submission.transport,
      label: submission.label,
      cwd: submission.cwd,
      subcommand: submission.subcommand,
      runId: submission.runId,
      runnerKind: submission.runnerKind,
      stageId: submission.stageId,
      planPath: submission.planPath,
      manifest: submission.manifest,
      word: submission.word,
      submittedAtMs: submission.submittedAtMs,
      terminalPid: submission.terminalPid,
      terminalName: submission.terminalName,
    }));
    await this.context.workspaceState.update(SUBMISSIONS_KEY, stored);
  }

  /**
   * Submissions the previous window left unresolved, restored before anything
   * else happens.
   *
   * They keep blocking a duplicate. What they cannot do is recognise their own
   * execution: VS Code does not hand a `TerminalShellExecution` back, so this
   * window has no identity for them. Their fate can still be established —
   * their terminal closing, the recorded shell process turning out to be gone,
   * or this exact command being found in the process table — and until one of
   * those happens they stay uncertain. A terminal that simply does not
   * reconnect proves nothing and is not one of them.
   */
  restore(): SubmissionView[] {
    const stored = this.context.workspaceState.get<PersistedSubmission[]>(SUBMISSIONS_KEY, []);
    const restored: Submission[] = [];
    for (const item of stored) {
      const submission: Submission = {
        ...item,
        state: "uncertain",
        restored: true,
      };
      const held = this.recordFor(submission.key);
      if (held) {
        // A record written by a version that allowed two of them, or a
        // corrupted store. They are the same operation: the newest is kept,
        // which is the one whose shell is worth probing, and the operation
        // stays blocked either way.
        if (held.submittedAtMs >= submission.submittedAtMs) {
          this.log(`window reloaded with two records for ${submission.key}; the older one is folded into the newer, which keeps blocking it`);
          continue;
        }
        this.submissions.delete(held.id);
        restored.splice(restored.indexOf(held), 1);
        this.log(`window reloaded with two records for ${submission.key}; the older one is folded into the newer, which keeps blocking it`);
      }
      this.submissions.set(submission.id, submission);
      this.byKey.set(submission.key, submission.id);
      restored.push(submission);
    }
    if (restored.length > 0) {
      this.log(`window reloaded with ${restored.length} command(s) submitted to a shell whose fate is unknown; no runner is claimed for them, and a second copy of each is refused until evidence settles it`);
      for (const submission of restored) {
        this.startProbing(submission);
      }
      this.changeEmitter.fire();
    }
    return restored.map(view);
  }

  /** Re-tie a restored submission to a terminal that came back with its pid. */
  reconnect(pid: number, terminal: vscode.Terminal): void {
    for (const submission of this.submissions.values()) {
      if (submission.restored && submission.terminalPid === pid && !submission.terminal) {
        submission.terminal = terminal;
        submission.terminalName = terminal.name;
        this.log(`${submission.label}: the terminal "${terminal.name}" that took it is back after the reload. Its execution identity is not, so closing it — or its shell disappearing — is what will settle it.`);
        this.changeEmitter.fire();
      }
    }
  }
}

function view(submission: Submission): SubmissionView {
  return {
    id: submission.id,
    key: submission.key,
    transport: submission.transport,
    label: submission.label,
    runId: submission.runId,
    cwd: submission.cwd,
    subcommand: submission.subcommand,
    submittedAtMs: submission.submittedAtMs,
    state: submission.state,
    terminalName: submission.terminalName,
    terminalPid: submission.terminalPid,
    identifiable: submission.execution !== undefined,
    restored: submission.restored,
  };
}

/**
 * What a person is told when a command cannot be given because an earlier one
 * may still execute. It says what is actually known, which is deliberately not
 * "a runner is alive" — that is a claim about a process someone has seen.
 */
export function submissionRefusal(submission: SubmissionView): string {
  const seconds = Math.max(1, Math.round((Date.now() - submission.submittedAtMs) / 1000));
  return [
    `Agent Sparring handed ${submission.label} to the terminal${submission.terminalName ? ` "${submission.terminalName}"` : ""} ${seconds} s ago and has not been able to confirm whether it started.`,
    submission.restored
      ? "The window has reloaded since, so that command can no longer be recognised from events."
      : "A shell that is stopped or busy can still run it later, so running it again could run the same operation twice.",
    "Check that terminal. If that command cannot run any more, confirm it and Agent Sparring will let you try again.",
  ].join(" ");
}

/**
 * What a person is told when an operation is refused admission, whatever the
 * holder's state. A shell submission has its own wording, because that is the
 * one case where nobody can say what is happening; the others are simply this
 * window already doing the thing.
 */
export function admissionRefusal(blocked: SubmissionView): string {
  if (blocked.state === "waiting" || blocked.state === "uncertain") {
    return submissionRefusal(blocked);
  }
  if (blocked.state === "direct") {
    return `Agent Sparring is already running ${blocked.label}. Wait for it to finish before running it again.`;
  }
  return `Agent Sparring is already starting ${blocked.label}. Wait for that to be handed to a terminal before running it again.`;
}

export { SUBMISSIONS_KEY };
