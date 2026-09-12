/**
 * Waiting for a terminal's shell integration, shared by the runner launcher
 * (executionTracker.ts) and the short-command runner (commandRunner.ts).
 */

import * as vscode from "vscode";

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

/** The environment the extension host sees, for host-side PATH fallbacks. */
export function hostEnv(cwd: string): { platform: NodeJS.Platform; PATH?: string; PATHEXT?: string; cwd: string } {
  return { platform: process.platform, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, cwd };
}
