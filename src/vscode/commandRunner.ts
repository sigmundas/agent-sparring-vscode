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
 * submits through the same authority (submissionRegistry.ts): an earlier
 * freeze-candidate that may still execute refuses the next one, before the
 * executable is resolved and before a terminal is acquired. A command the
 * shell has not reported as started is not treated as run and — unlike the
 * missing-integration case — is deliberately *not* retried through the
 * direct-process transport, because the submitted line may still be read.
 */

import { execFile } from "node:child_process";
import type { CommandOutcome } from "../core/acceptance";
import { executableWord, planExecutable, type ExecutablePlan } from "../core/cli";
import type { LaunchProblem } from "./executionTracker";
import { awaitExecutionEnd, awaitShellIntegration, EXECUTION_START_TIMEOUT_MS, executeThroughShell, hostEnv } from "./shellIntegration";
import { commandKey, submissionRefusal, type SubmissionRegistry, type SubmissionView } from "./submissionRegistry";
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
  /** What must not be run twice while an earlier submission of it may still execute. */
  operation?: { subcommand: string; target?: string };
}

export type RunCommandResult =
  | { ok: true; outcome: CommandOutcome; via: "shell" | "process"; plan: ExecutablePlan }
  | { ok: false; error: string; problem: LaunchProblem; submission?: SubmissionView };

export class SparringCommandRunner {
  constructor(
    private readonly log: (message: string) => void,
    private readonly terminals: TerminalPool,
    /** The one authority on commands handed to a shell (submissionRegistry.ts). */
    private readonly submissions: SubmissionRegistry,
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
    // Before the executable is resolved and before a terminal is acquired: an
    // earlier copy of this operation that may still execute forbids another.
    const unresolved = this.submissions.unresolvedFor(key);
    if (unresolved) {
      this.log(`refused to run ${options.name}: ${unresolved.label} was submitted to a shell and may still execute; it is not run a second time`);
      return { ok: false, error: submissionRefusal(unresolved), problem: "unconfirmed", submission: unresolved };
    }
    const configured = await planExecutable(options.configured, hostEnv(options.cwd), true);
    if (!configured.ok) {
      return { ok: false, error: configured.error, problem: configured.problem };
    }
    // The project's own terminal, for as long as this command runs — and only
    // when its shell is idle, never one the user is working in.
    const lease = this.terminals.acquire(options.cwd);
    const integration = await awaitShellIntegration(lease.terminal);
    const word = executableWord(configured.plan);
    const submission = integration
      ? this.submissions.open({ key, transport: "command", label: `${subcommand}${target ? ` ${target}` : ""}`, cwd: options.cwd, subcommand, stageId: target, word, plan: configured.plan }, lease)
      : undefined;
    const request = integration ? executeThroughShell(integration, word, options.args) : undefined;
    if (request && submission) {
      lease.terminal.show(true);
      const output = collectOutput(request.execution);
      this.submissions.attach(submission, request.execution, output);
      const settled = await this.submissions.wait(submission, EXECUTION_START_TIMEOUT_MS);
      if (!settled.established) {
        // The shell has not started it, and may still. Nothing is treated as
        // run, nothing is retried through another transport, and the
        // submission stays on the registry's books — it, not any timer, is
        // what stops this operation being done twice.
        this.log(`${options.name}: the shell in "${lease.terminal.name}" has not reported the command as started; nothing is treated as run, and this operation is refused until its fate is known`);
        return { ok: false, error: submissionRefusal(settled.view), problem: "unconfirmed", submission: settled.view };
      }
      const exitCode = await awaitExecutionEnd(request.execution, lease.terminal);
      const text = await output;
      lease.release();
      this.log(`ran ${options.name} via shell integration (${word}, ${options.args.length} args${request.quotedHere ? ", command line quoted here" : ""}, cwd ${options.cwd}); exit ${exitCode === undefined ? "unknown" : exitCode}`);
      return { ok: true, outcome: { exitCode, output: text, resolvedBy: configured.plan.kind === "shell" ? "shell" : "path" }, via: "shell", plan: configured.plan };
    }
    if (submission) {
      // Nothing was handed over, so nothing can still execute.
      this.submissions.withdraw(key, "the command line was never handed to the shell, so nothing was submitted");
    }
    if (integration) {
      lease.release();
    } else {
      lease.discard();
    }
    // No shell to resolve a bare name (or none whose quoting can be written
    // here): fall back to this process's view and an argument array.
    const direct = await planExecutable(options.configured, hostEnv(options.cwd), false);
    if (!direct.ok) {
      return { ok: false, error: direct.error, problem: direct.problem };
    }
    const path = executableWord(direct.plan);
    const outcome = await runProcess(path, options.args, options.cwd);
    this.log(`ran ${options.name} as a direct process (${path}, ${options.args.length} args, cwd ${options.cwd}; shell integration unavailable); exit ${outcome.exitCode === undefined ? "unknown" : outcome.exitCode}`);
    return { ok: true, outcome, via: "process", plan: direct.plan };
  }
}

function runProcess(file: string, args: string[], cwd: string): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
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
  });
}
