/**
 * Waiting for a terminal's shell integration and handing it a command,
 * shared by the runner launcher (executionTracker.ts) and the short-command
 * runner (commandRunner.ts): the one place where an argument array becomes
 * something a shell reads.
 */

import * as vscode from "vscode";
import { planShellHandover, shellFamily } from "../core/cli";

/** How long a fresh terminal gets to report shell integration before a fallback is used. */
export const SHELL_INTEGRATION_TIMEOUT_MS = 5000;

export function awaitShellIntegration(terminal: vscode.Terminal, timeoutMs = SHELL_INTEGRATION_TIMEOUT_MS): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise((resolve) => {
    const done = (value: vscode.TerminalShellIntegration | undefined) => {
      clearTimeout(timer);
      listener.dispose();
      closed.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        done(event.shellIntegration);
      }
    });
    const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        done(undefined);
      }
    });
  });
}

/** How long the shell gets to report that a handed-over command actually started. */
export const EXECUTION_START_TIMEOUT_MS = 5000;

/**
 * What became of a command line handed to a shell:
 *
 *  - `started` — the shell reported it as a command of its own. Only this
 *    means the engine is running;
 *  - `ended`   — it had already finished by the time we looked, which is the
 *    same guarantee arriving late;
 *  - `closed`  — the terminal went away, which ends it honestly;
 *  - `never`   — the shell reported nothing. `executeCommand` writes the
 *    line into the terminal, so this is what a shell that was not at a
 *    prompt looks like: the text went to whatever was reading stdin. Nothing
 *    was launched, and nothing may be recorded as running.
 */
export type Establishment = "started" | "ended" | "closed" | "never";

export interface ExecutionWatch {
  /** How the execution handed to the shell settled. */
  settle(execution: vscode.TerminalShellExecution, timeoutMs?: number): Promise<Establishment>;
  /** Stop listening without asking about any execution. */
  cancel(): void;
}

/**
 * Start listening for shell-execution events in `terminal` *before* a command
 * is handed to it, so a start event that arrives immediately is not missed.
 * `settle` may then be called with the execution the shell was given.
 */
export function watchExecutions(terminal: vscode.Terminal): ExecutionWatch {
  const started = new Set<vscode.TerminalShellExecution>();
  const ended = new Set<vscode.TerminalShellExecution>();
  let closed = false;
  let waiting: { execution: vscode.TerminalShellExecution; resolve: (value: Establishment) => void } | undefined;
  const settleNow = (value: Establishment) => {
    const pending = waiting;
    waiting = undefined;
    pending?.resolve(value);
  };
  const listeners = [
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (event.terminal !== terminal) {
        return;
      }
      started.add(event.execution);
      if (waiting?.execution === event.execution) {
        settleNow("started");
      }
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal !== terminal) {
        return;
      }
      ended.add(event.execution);
      if (waiting?.execution === event.execution) {
        settleNow("ended");
      }
    }),
    vscode.window.onDidCloseTerminal((candidate) => {
      if (candidate === terminal) {
        closed = true;
        settleNow("closed");
      }
    }),
  ];
  const stop = () => {
    for (const listener of listeners.splice(0)) {
      listener.dispose();
    }
  };
  return {
    cancel: stop,
    settle: (execution, timeoutMs = EXECUTION_START_TIMEOUT_MS) =>
      new Promise<Establishment>((resolve) => {
        if (started.has(execution)) {
          resolve("started");
        } else if (ended.has(execution)) {
          resolve("ended");
        } else if (closed) {
          resolve("closed");
        } else {
          const timer = setTimeout(() => settleNow("never"), timeoutMs);
          waiting = {
            execution,
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
          };
        }
      }).finally(stop),
  };
}

/** Resolves with the exit code when `execution` ends (undefined when the shell reported none). */
export function awaitExecutionEnd(execution: vscode.TerminalShellExecution, terminal: vscode.Terminal): Promise<number | undefined> {
  return new Promise((resolve) => {
    const done = (code: number | undefined) => {
      ended.dispose();
      closed.dispose();
      resolve(code);
    };
    const ended = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        done(event.exitCode);
      }
    });
    const closed = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        done(undefined);
      }
    });
  });
}

/** What was handed to the shell, for the log and for the tests. */
export interface ShellRequest {
  execution: vscode.TerminalShellExecution;
  /** The line the shell will read, however it was built. */
  commandLine: string;
  /** Whether this extension quoted it, rather than VS Code's own escaping. */
  quotedHere: boolean;
}

/**
 * Run `word` with `args` in `integration`'s shell.
 *
 * VS Code's `executeCommand(executable, args)` escaping is exact for flags
 * and paths but mangles anything a person wrote (see
 * `vscodeQuotingIsFaithful`), so when an argument would not survive it, the
 * command line is built here instead and passed as one already-quoted
 * string. Returns undefined when this shell's quoting is not reproduced in
 * `shellCommandLine` — the caller must then reach the process without a
 * shell rather than send it something it cannot express.
 */
export function executeThroughShell(integration: vscode.TerminalShellIntegration, word: string, args: string[], shell = vscode.env.shell, platform: NodeJS.Platform = process.platform): ShellRequest | undefined {
  const handover = planShellHandover(word, args, shellFamily(shell, platform));
  if (handover.via === "no-shell") {
    return undefined;
  }
  if (handover.via === "command-line") {
    return { execution: integration.executeCommand(handover.commandLine), commandLine: handover.commandLine, quotedHere: true };
  }
  const execution = integration.executeCommand(word, args);
  return { execution, commandLine: execution.commandLine.value, quotedHere: false };
}

/** The environment the extension host sees, for host-side PATH fallbacks. */
export function hostEnv(cwd: string): { platform: NodeJS.Platform; PATH?: string; PATHEXT?: string; cwd: string } {
  return { platform: process.platform, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, cwd };
}
