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
 * Submitting is not running here either: a command the shell has not reported
 * as started is not treated as run, and — unlike the missing-integration case
 * — it is deliberately *not* retried through the direct-process transport. A
 * stopped or busy shell can still run the submitted line later, and running
 * freeze-candidate or accept-candidate twice is not a risk worth taking.
 */

import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { CommandOutcome } from "../core/acceptance";
import { executableWord, planExecutable, type ExecutablePlan } from "../core/cli";
import type { LaunchProblem } from "./executionTracker";
import { awaitExecutionEnd, awaitShellIntegration, executeThroughShell, hostEnv, watchExecutions } from "./shellIntegration";
import { collectOutput } from "./terminalOutput";
import type { TerminalPool } from "./terminalPool";

export { stripAnsi } from "./terminalOutput";

/** How long a submitted short command that never started is still watched, for the log alone. */
const LATE_COMMAND_WATCH_MS = 10 * 60 * 1000;

export interface RunCommandOptions {
  /** The configured `agentSparring.executable`, possibly empty. */
  configured: string | undefined;
  args: string[];
  cwd: string;
  /** Terminal title suffix and log label. */
  name: string;
}

export type RunCommandResult = { ok: true; outcome: CommandOutcome; via: "shell" | "process"; plan: ExecutablePlan } | { ok: false; error: string; problem: LaunchProblem };

export class SparringCommandRunner {
  constructor(
    private readonly log: (message: string) => void,
    private readonly terminals: TerminalPool,
  ) {}

  dispose(): void {
    // The terminals belong to the pool, which the controller disposes.
  }

  /**
   * Keep watching a submitted short command after the caller has been told
   * it could not be confirmed, so what actually became of it is on the
   * record. Nothing is retried and nothing is claimed from this: it exists
   * because "Agent Sparring cannot tell whether freeze-candidate ran" is a
   * question the log should be able to answer afterwards.
   */
  private watchLate(name: string, terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): void {
    const watch = watchExecutions(terminal);
    void watch.settle(execution, LATE_COMMAND_WATCH_MS).then((outcome) => {
      if (outcome === "never") {
        this.log(`${name}: still not started ${Math.round(LATE_COMMAND_WATCH_MS / 60000)} minutes after it was handed to "${terminal.name}"; no longer watched`);
      } else if (outcome === "closed") {
        this.log(`${name}: the terminal "${terminal.name}" it was handed to was closed, so that command can no longer run`);
      } else {
        this.log(`${name}: the shell in "${terminal.name}" ${outcome === "started" ? "started it after all" : "reported it as finished"}, long after Agent Sparring reported that it could not confirm it. The engine ran; check the terminal for what it printed.`);
      }
    });
  }

  async run(options: RunCommandOptions): Promise<RunCommandResult> {
    const configured = await planExecutable(options.configured, hostEnv(options.cwd), true);
    if (!configured.ok) {
      return { ok: false, error: configured.error, problem: configured.problem };
    }
    // The project's own terminal, for as long as this command runs — and only
    // when its shell is idle, never one the user is working in.
    const lease = this.terminals.acquire(options.cwd);
    const integration = await awaitShellIntegration(lease.terminal);
    const word = executableWord(configured.plan);
    const watch = integration ? watchExecutions(lease.terminal) : undefined;
    const request = integration ? executeThroughShell(integration, word, options.args) : undefined;
    if (request && watch) {
      lease.terminal.show(true);
      const output = collectOutput(request.execution);
      if ((await watch.settle(request.execution)) === "never") {
        // The shell has not started it. It still may: a stopped or busy shell
        // runs a submitted line when it continues. So this is neither retried
        // through another transport nor forgotten — running freeze-candidate
        // or accept-candidate a second time is not a risk worth taking — and
        // the terminal is retired while the submission is watched in the
        // background, so the log says what became of it.
        lease.retire();
        this.log(`${options.name}: the shell in "${lease.terminal.name}" has not reported the command as started; nothing is treated as run, and that terminal will not be reused`);
        this.watchLate(options.name, lease.terminal, request.execution);
        return {
          ok: false,
          error: `${word} was handed to the terminal "${lease.terminal.name}" but its shell has not reported the command as started, so Agent Sparring cannot tell whether ${options.name} ran. Check that terminal before trying again: a stopped or busy shell can still run it later, and running it twice is not safe.`,
          problem: "unconfirmed",
        };
      }
      const exitCode = await awaitExecutionEnd(request.execution, lease.terminal);
      const text = await output;
      lease.release();
      this.log(`ran ${options.name} via shell integration (${word}, ${options.args.length} args${request.quotedHere ? ", command line quoted here" : ""}, cwd ${options.cwd}); exit ${exitCode === undefined ? "unknown" : exitCode}`);
      return { ok: true, outcome: { exitCode, output: text, resolvedBy: configured.plan.kind === "shell" ? "shell" : "path" }, via: "shell", plan: configured.plan };
    }
    watch?.cancel();
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
