/**
 * Runs short `sparring` commands (freeze-candidate, accept-candidate) to
 * completion and reports their exit code and output.
 *
 * Preferred path: the user's own integrated shell through terminal shell
 * integration (`executeCommand(executable, args)`: argument array, no
 * quoted command line), so a bare `sparring` resolves exactly as it does
 * when the user types it, and the output stays visible in that terminal.
 * The execution's output stream is read for the log and for translating
 * refusals.
 *
 * Fallback when shell integration never appears: the executable is resolved
 * on the extension host's side (configured path, or the bare name along
 * this process's PATH) and spawned directly with the argument array. When
 * that cannot resolve either, the caller gets an honest configuration
 * message rather than a reinstall suggestion.
 *
 * Runner liveness is untouched: these commands never register with the
 * ExecutionTracker, and they run in their own terminal, never in one that
 * hosts a loop runner.
 */

import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { CommandOutcome } from "../core/acceptance";
import { executableWord, planExecutable, type ExecutablePlan } from "../core/cli";
import { awaitExecutionEnd, awaitShellIntegration, hostEnv } from "./shellIntegration";

const OUTPUT_CAP = 64 * 1024;

export interface RunCommandOptions {
  /** The configured `agentSparring.executable`, possibly empty. */
  configured: string | undefined;
  args: string[];
  cwd: string;
  /** Terminal title suffix and log label. */
  name: string;
}

export type RunCommandResult = { ok: true; outcome: CommandOutcome; via: "shell" | "process"; plan: ExecutablePlan } | { ok: false; error: string; problem: "configured-invalid" | "unresolvable" };

export class SparringCommandRunner {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: (message: string) => void) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [key, known] of this.terminals) {
          if (known === terminal) {
            this.terminals.delete(key);
          }
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  async run(options: RunCommandOptions): Promise<RunCommandResult> {
    const configured = await planExecutable(options.configured, hostEnv(options.cwd), true);
    if (!configured.ok) {
      return { ok: false, error: configured.error, problem: configured.problem };
    }
    const terminal = this.terminalFor(options.cwd, options.name);
    const integration = await awaitShellIntegration(terminal);
    if (integration) {
      const word = executableWord(configured.plan);
      const execution = integration.executeCommand(word, options.args);
      terminal.show(true);
      const output = collectOutput(execution);
      const exitCode = await awaitExecutionEnd(execution, terminal);
      const text = await output;
      this.log(`ran ${options.name} via shell integration (${word}, ${options.args.length} args, cwd ${options.cwd}); exit ${exitCode === undefined ? "unknown" : exitCode}`);
      return { ok: true, outcome: { exitCode, output: text }, via: "shell", plan: configured.plan };
    }
    // No shell to resolve a bare name: fall back to this process's view.
    const direct = await planExecutable(options.configured, hostEnv(options.cwd), false);
    if (!direct.ok) {
      return { ok: false, error: direct.error, problem: direct.problem };
    }
    const path = executableWord(direct.plan);
    const outcome = await runProcess(path, options.args, options.cwd);
    this.log(`ran ${options.name} as a direct process (${path}, ${options.args.length} args, cwd ${options.cwd}; shell integration unavailable); exit ${outcome.exitCode === undefined ? "unknown" : outcome.exitCode}`);
    return { ok: true, outcome, via: "process", plan: direct.plan };
  }

  private terminalFor(cwd: string, name: string): vscode.Terminal {
    const known = this.terminals.get(cwd);
    if (known && known.exitStatus === undefined) {
      return known;
    }
    const terminal = vscode.window.createTerminal({ name: `Agent Sparring: ${name}`, cwd, iconPath: new vscode.ThemeIcon("debug-alt") });
    this.terminals.set(cwd, terminal);
    return terminal;
  }
}

async function collectOutput(execution: vscode.TerminalShellExecution): Promise<string> {
  let text = "";
  try {
    for await (const chunk of execution.read()) {
      if (text.length < OUTPUT_CAP) {
        text += chunk;
      }
    }
  } catch {
    // Reading is best effort: some shells report no data stream.
  }
  return stripAnsi(text);
}

/** Remove terminal control sequences (CSI and OSC, the latter used by shell integration itself) from captured output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\r/g, "");
}

function runProcess(file: string, args: string[], cwd: string): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      if (!error) {
        resolve({ exitCode: 0, output });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      if (typeof code === "number") {
        resolve({ exitCode: code, output });
      } else if (code === "ENOENT") {
        resolve({ exitCode: 127, output: `${output}${file}: not found\n` });
      } else {
        resolve({ exitCode: undefined, output: `${output}${error.message}\n` });
      }
    });
  });
}
