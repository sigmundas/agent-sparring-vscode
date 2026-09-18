/**
 * Runs short `sparring` commands (freeze-candidate, accept-candidate) to
 * completion and reports their exit code and output.
 *
 * Preferred path: the user's own integrated shell through terminal shell
 * integration (see `executeThroughShell`), so a bare `sparring` resolves
 * exactly as it does when the user types it, and the output stays visible
 * in that terminal. The execution's output stream is read for the log and
 * for translating refusals.
 *
 * Fallback when shell integration never appears — or when this shell's
 * quoting is not one the extension can write: the executable is resolved on
 * the extension host's side (configured path, or the bare name along this
 * process's PATH) and spawned directly with the argument array. When that
 * cannot resolve either, the caller gets an honest configuration message
 * rather than a reinstall suggestion.
 *
 * Runner liveness is untouched: these commands never register with the
 * ExecutionTracker. They run in the project's own reusable terminal
 * (terminalPool.ts), which is leased for the duration and only ever taken
 * when its shell is idle, so they can never be sent into a terminal that is
 * already running something.
 *
 * Submitting is not running here either, and this transport carries the same
 * risk of doing an engine operation twice as the runner launcher does. So it
 * goes through the same authority (operationRegistry.ts), and claims the
 * operation there before it does anything at all: an earlier freeze-candidate
 * that is being prepared, that may still execute, that is *executing*, or
 * that is running as a child process of this window all refuse the next one,
 * before the executable is resolved and before a terminal is acquired. Two
 * clicks in the same instant cannot both get past that claim, and the
 * direct-process fallback holds it until the child has exited. A command the
 * shell has not reported as started is not treated as run and — unlike the
 * missing-integration case — is deliberately *not* retried through the
 * direct-process transport, because the submitted line may still be read.
 *
 * Two orderings here are load-bearing:
 *
 *  - the durable execution intent is written, and awaited, before the command
 *    line is handed to the shell or a child is spawned. A crash in between
 *    then leaves a record that blocks conservatively instead of nothing at
 *    all (`arm`);
 *  - the guard is *not* released when the shell says the command started.
 *    These commands are short — freeze-candidate finishes in a second — and
 *    "started" used to end the guard, leaving the operation running and
 *    unguarded. The same record advances to running and is released by that
 *    execution's own end.
 */

import { execFile } from "node:child_process";
import type { CommandOutcome } from "../core/acceptance";
import { executableWord, planExecutable, type ExecutablePlan } from "../core/cli";
import type { LaunchProblem } from "./executionTracker";
import { admissionRefusal, commandKey, operationRefusal, outstanding, type OperationRegistry, type OperationView } from "./operationRegistry";
import { handOverToIdleShell } from "./shellHandover";
import { awaitExecutionEnd, awaitShellIntegration, EXECUTION_START_TIMEOUT_MS, hostEnv, shellHandoverFor } from "./shellIntegration";
import { collectOutput } from "./terminalOutput";
import type { TerminalPool } from "./terminalPool";

export { stripAnsi } from "./terminalOutput";

export interface RunCommandOptions {
  /** The configured `agentSparring.executable`, possibly empty. */
  configured: string | undefined;
  args: string[];
  cwd: string;
  /** Terminal title suffix and log label. */
  name: string;
  /** What must not be run twice while an earlier copy of it may still execute. */
  operation?: { subcommand: string; target?: string };
  /** The repository or worktree this acts on, for the operation's identity; defaults to `cwd`. */
  repoRoot?: string;
  /** The engine's sparring directory, when it is not `<repoRoot>/.sparring`. */
  sparringDir?: string;
}

export type RunCommandResult =
  | { ok: true; outcome: CommandOutcome; via: "shell" | "process"; plan: ExecutablePlan }
  | { ok: false; error: string; problem: LaunchProblem; submission?: OperationView };

export class SparringCommandRunner {
  constructor(
    private readonly log: (message: string) => void,
    private readonly terminals: TerminalPool,
    /** The one authority on engine operations in flight (operationRegistry.ts). */
    private readonly operations: OperationRegistry,
  ) {}

  dispose(): void {
    // The terminals belong to the pool, which the controller disposes.
  }

  async run(options: RunCommandOptions): Promise<RunCommandResult> {
    // The operation this command is, for duplicate prevention. Falls back to
    // the first argument, which is the subcommand in every call site.
    const subcommand = options.operation?.subcommand ?? options.args[0] ?? "command";
    const target = options.operation?.target ?? options.args[1];
    const key = commandKey(options.cwd, subcommand, target);
    const label = `${subcommand}${target ? ` ${target}` : ""}`;
    // The first thing that happens, and the only synchronous one: while this
    // operation is claimed, no other invocation can resolve an executable,
    // acquire a terminal or send anything for it.
    const admission = this.operations.claim({
      key,
      caller: "command",
      label,
      repoRoot: options.repoRoot ?? options.cwd,
      sparringDir: options.sparringDir,
      cwd: options.cwd,
      subcommand,
      stageId: target,
    });
    if (!admission.admitted) {
      const blocked = admission.blocked;
      this.log(`refused to run ${options.name}: ${blocked.label} is already in flight (${blocked.state}); it is not run a second time`);
      return { ok: false, error: admissionRefusal(blocked), problem: "unconfirmed", submission: outstanding(blocked) ? blocked : undefined };
    }
    const claim = admission.claim;
    const configured = await planExecutable(options.configured, hostEnv(options.cwd), true);
    if (!configured.ok) {
      this.operations.release(claim, "the executable could not be resolved, so nothing was ever submitted");
      return { ok: false, error: configured.error, problem: configured.problem };
    }
    // The project's own terminal, for as long as this command runs — and only
    // when its shell is idle, never one the user is working in.
    const lease = this.terminals.acquire(options.cwd);
    const integration = await awaitShellIntegration(lease.terminal);
    const word = executableWord(configured.plan);
    // Whether this shell *can* be given the command is decided before
    // anything durable is written: an operation that must take the
    // shell-less route is never armed for a shell.
    const handover = integration ? shellHandoverFor(word, options.args) : undefined;
    if (integration && handover && handover.via !== "no-shell") {
      const armed = await this.operations.arm(claim, "shell", { word, plan: configured.plan });
      if (!armed.ok) {
        // The intent could not be made durable, so nothing is handed over:
        // the one ordering under which a crash cannot strand a started
        // operation without a record.
        lease.release();
        this.operations.release(claim, "the durable record of the intent could not be written, so the command was never handed to the shell");
        return { ok: false, error: armed.error, problem: "unconfirmed" };
      }
      // The final occupancy check and the hand-over happen as one step, with
      // nothing awaited in between, so a terminal the person has started
      // something in since `arm` was awaited is left completely alone and
      // another idle one is used (shellHandover.ts). The operation stays
      // armed throughout: nothing has executed while a safe terminal is
      // being looked for.
      const handed = await handOverToIdleShell({ pool: this.terminals, cwd: options.cwd, lease, integration, word, args: options.args, reveal: false, log: this.log });
      if (!handed.ok) {
        if (handed.reason === "threw") {
          this.operations.handoverFailed(armed.armed, `handing the command line to the shell threw (${handed.error.message}), so nothing was submitted`);
          lease.discard();
          return { ok: false, error: `Agent Sparring could not hand ${label} to the terminal: ${handed.error.message}`, problem: "unconfirmed" };
        }
        this.operations.handoverNotInvoked(armed.armed, handed.detail);
        return {
          ok: false,
          error: `Agent Sparring did not run ${label}: ${handed.detail}. Nothing was written into any terminal, so nothing ran — try again when a terminal is free.`,
          problem: "unconfirmed",
        };
      }
      const request = handed.request;
      const leased = handed.lease;
      leased.terminal.show(true);
      const output = collectOutput(request.execution);
      this.operations.submittedToShell(armed.armed, leased, request.execution, output);
      const settled = await this.operations.waitForStart(armed.armed, EXECUTION_START_TIMEOUT_MS);
      if (!settled.established) {
        // The shell has not started it, and may still. Nothing is treated as
        // run, nothing is retried through another transport, and the record
        // stays on the registry's books — it, not any timer, is what stops
        // this operation being done twice.
        this.log(`${options.name}: the shell in "${leased.terminal.name}" has not reported the command as started; nothing is treated as run, and this operation is refused until its fate is known`);
        return { ok: false, error: operationRefusal(settled.view), problem: "unconfirmed", submission: settled.view };
      }
      // The shell may report the end before this caller sees the start — a
      // command that finishes inside the same tick does exactly that. That
      // end is authoritative and is consumed here; installing a waiter for
      // an event that has already happened would wait for ever.
      const exitCode = settled.ended ? settled.ended.exitCode : await awaitExecutionEnd(request.execution, leased.terminal);
      const text = await output;
      leased.release();
      this.log(
        `ran ${options.name} via shell integration (${word}, ${options.args.length} args${request.quotedHere ? ", command line quoted here" : ""}, cwd ${options.cwd}); exit ${exitCode === undefined ? "unknown" : exitCode}${settled.ended ? " (the shell reported the end before the start was observed)" : ""}`,
      );
      return { ok: true, outcome: { exitCode, output: text, resolvedBy: configured.plan.kind === "shell" ? "shell" : "path" }, via: "shell", plan: configured.plan };
    }
    if (integration) {
      // The shell is fine, it just cannot carry this command line; keep it.
      lease.release();
    } else {
      lease.discard();
    }
    // No shell to resolve a bare name (or none whose quoting can be written
    // here): fall back to this process's view and an argument array.
    const direct = await planExecutable(options.configured, hostEnv(options.cwd), false);
    if (!direct.ok) {
      this.operations.release(claim, "no executable could be resolved without a shell either, so nothing was started");
      return { ok: false, error: direct.error, problem: direct.problem };
    }
    const path = executableWord(direct.plan);
    const armed = await this.operations.arm(claim, "direct-process", { word: path, plan: direct.plan });
    if (!armed.ok) {
      this.operations.release(claim, "the durable record of the intent could not be written, so nothing was spawned");
      return { ok: false, error: armed.error, problem: "unconfirmed" };
    }
    // The child process is spawned under an armed record, and the record is
    // given up only when it has ended: there is no instant between "about to
    // spawn" and "spawned" in which a second invocation could spawn another
    // one, and no instant in which a crash would leave no record.
    //
    // Its pid and command line go on the record as soon as the spawn returns
    // them, without an await in between, because such a child outlives this
    // window: it is reparented to pid 1 and keeps running when the extension
    // host is killed, which is what a window reload does (proven in
    // src/test/directExecutionSurvival.test.ts). A reload must find it and
    // refuse a second freeze-candidate, not conclude from its own missing
    // claim that nothing is happening.
    let outcome: CommandOutcome;
    try {
      outcome = await runProcess(path, options.args, options.cwd, (pid) => {
        this.operations.runningDirect(armed.armed, { pid, word: path, args: options.args, cwd: options.cwd }, `it runs as process ${pid} of this window, without a shell`);
      });
    } finally {
      this.operations.directProcessEnded(armed.armed, "the process that ran it has ended in front of us");
    }
    this.log(`ran ${options.name} as a direct process (${path}, ${options.args.length} args, cwd ${options.cwd}; shell integration unavailable); exit ${outcome.exitCode === undefined ? "unknown" : outcome.exitCode}`);
    return { ok: true, outcome, via: "process", plan: direct.plan };
  }
}

/**
 * Spawn the engine without a shell. `started` is called synchronously with
 * the child's pid the instant it exists, so the operation's identity is on
 * the record before anything can interleave; a spawn that produces no pid at
 * all never started, and nothing is recorded for it.
 */
function runProcess(file: string, args: string[], cwd: string, started?: (pid: number) => void): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      if (!error) {
        resolve({ exitCode: 0, output, resolvedBy: "path" });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      if (typeof code === "number") {
        resolve({ exitCode: code, output, resolvedBy: "path" });
      } else if (code === "ENOENT") {
        // The path was checked before the spawn, so this means it vanished
        // in between; the output says so rather than a shell being blamed.
        resolve({ exitCode: 127, output: `${output}${file}: not found\n`, resolvedBy: "path" });
      } else {
        resolve({ exitCode: undefined, output: `${output}${error.message}\n`, resolvedBy: "path" });
      }
    });
    if (child.pid !== undefined) {
      started?.(child.pid);
    }
  });
}
