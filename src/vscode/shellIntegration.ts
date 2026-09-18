/**
 * Waiting for a terminal's shell integration and handing it a command,
 * shared by the runner launcher (executionTracker.ts) and the short-command
 * runner (commandRunner.ts): the one place where an argument array becomes
 * something a shell reads.
 */

import * as vscode from "vscode";
import { planShellHandover, shellFamily, type ShellHandover } from "../core/cli";

export type { ShellHandover };

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

/**
 * How long the shell gets to report a handed-over command as started before
 * the caller stops waiting. It is a user-interface deadline and nothing more:
 * the operation itself outlives it (operationRegistry.ts).
 */
export const EXECUTION_START_TIMEOUT_MS = 5000;

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
 * Whether, and how, this shell can be given `word` with `args` — decided
 * *before* anything irreversible happens.
 *
 * VS Code's `executeCommand(executable, args)` escaping is exact for flags
 * and paths but mangles anything a person wrote (see
 * `vscodeQuotingIsFaithful`), so when an argument would not survive it, the
 * command line is built here instead and passed as one already-quoted
 * string. `no-shell` means this shell's quoting is not reproduced in
 * `shellCommandLine` — the caller must then reach the process without a
 * shell rather than send it something it cannot express.
 *
 * Deciding this first is what lets a caller record its durable intent to run
 * the operation only when it really is about to: an operation that can never
 * be handed to this shell must not be armed for one.
 */
export function shellHandoverFor(word: string, args: string[], shell = vscode.env.shell, platform: NodeJS.Platform = process.platform): ShellHandover {
  return planShellHandover(word, args, shellFamily(shell, platform));
}

/**
 * Hand a planned command over. The first irreversible step of a shell launch,
 * and the only one: everything the caller must record durably has to be on
 * disk before this is called.
 */
export function performShellHandover(integration: vscode.TerminalShellIntegration, word: string, args: string[], handover: ShellHandover): ShellRequest {
  if (handover.via === "command-line") {
    return { execution: integration.executeCommand(handover.commandLine), commandLine: handover.commandLine, quotedHere: true };
  }
  if (handover.via === "no-shell") {
    throw new Error("performShellHandover was called for a command this shell cannot be given");
  }
  const execution = integration.executeCommand(word, args);
  return { execution, commandLine: execution.commandLine.value, quotedHere: false };
}

/** The environment the extension host sees, for host-side PATH fallbacks. */
export function hostEnv(cwd: string): { platform: NodeJS.Platform; PATH?: string; PATHEXT?: string; cwd: string } {
  return { platform: process.platform, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, cwd };
}
