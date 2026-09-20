/**
 * Waiting for a terminal's shell integration and handing it a command,
 * shared by the runner launcher (executionTracker.ts) and the short-command
 * runner (commandRunner.ts): the one place where an argument array becomes
 * something a shell reads.
 */

import * as vscode from "vscode";
import { planShellHandover, type ShellHandover } from "../core/cli";

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
  /** The line the shell will read, as the host reports it. */
  commandLine: string;
  /**
   * Reading back what the host said it handed over failed, *after* the shell
   * had already been given the command. The command line above is then this
   * extension's own description of what it asked for rather than the host's
   * report of it — and, far more importantly, the hand-over still happened.
   */
  metadataError?: Error;
}

/**
 * What one call of `executeCommand` did, with the irreversible boundary in the
 * type rather than in a comment.
 *
 * `handedOver: false` is emitted only from *before* that call — the plan said
 * this shell cannot be given the command, or the call itself threw. Once
 * `executeCommand` has returned, the shell has the command line and nothing
 * that happens afterwards can produce that answer: reading the returned
 * execution's own metadata is observation, and a failure there is reported as
 * `metadataError` on a hand-over that did happen.
 *
 * This shape exists because the two used to be one `try` block. `executeCommand`
 * succeeded, `execution.commandLine.value` threw, and the caller classified
 * the whole thing as "the hand-over threw" — which resolved the operation as
 * `cannot-execute` while the shell was holding the command.
 */
export type HandoverAttempt =
  | { handedOver: false; error: Error }
  | { handedOver: true; request: ShellRequest };

/**
 * Whether, and how, this shell can be given `word` with `args` — decided
 * *before* anything irreversible happens.
 *
 * VS Code's `executeCommand(executable, args)` escaping is exact for flags
 * and paths, so those are handed over as `arguments` and nothing changes.
 * Everything else — above all anything carrying text a person wrote — is
 * `no-shell`: the caller must reach the process with an exact argument array
 * and no shell anywhere in between. The rule itself lives in core
 * (`transportSafety`); this is only the VS Code-facing name for it, and it
 * takes no shell or platform, because the answer does not depend on which
 * shell the person uses. No shell gets to see such a command.
 *
 * Deciding this first is what lets a caller record its durable intent to run
 * the operation only when it really is about to: an operation that can never
 * be handed to a shell must not be armed for one.
 */
export function shellHandoverFor(word: string, args: string[]): ShellHandover {
  return planShellHandover(word, args);
}

/**
 * Hand a planned command over. The first irreversible step of a shell launch,
 * and the only one: everything the caller must record durably has to be on
 * disk before this is called.
 *
 * The call is structured in three parts, and the order is the whole point:
 *
 *  1. **prepare** — anything that can decide "this cannot be handed over" is
 *     done before the call, and returns `handedOver: false`;
 *  2. **`executeCommand`** — the irreversible boundary. It is the only thing
 *     inside its own `try`, so a throw from it, and nothing else, means the
 *     shell was given nothing;
 *  3. **observe** — reading the returned execution's metadata. A throw here is
 *     carried as `metadataError` on a hand-over that *did* happen, never as a
 *     failure to hand over. The shell has the command line by then, and no
 *     caller may treat it as never executed.
 */
export function performShellHandover(integration: vscode.TerminalShellIntegration, word: string, args: string[], handover: ShellHandover): HandoverAttempt {
  // 1. prepare
  if (handover.via === "no-shell") {
    return { handedOver: false, error: new Error("performShellHandover was called for a command this shell cannot be given") };
  }
  // 2. the irreversible boundary: nothing but this call is in the try.
  //    Always the (word, args) form — this extension never builds a physical
  //    command line for a shell to re-read.
  let execution: vscode.TerminalShellExecution;
  try {
    execution = integration.executeCommand(word, args);
  } catch (error) {
    return { handedOver: false, error: error as Error };
  }
  // 3. observation. The shell has the command; from here on nothing may
  //    downgrade that to "it was never handed over".
  try {
    return { handedOver: true, request: { execution, commandLine: execution.commandLine.value } };
  } catch (error) {
    return { handedOver: true, request: { execution, commandLine: [word, ...args].join(" "), metadataError: error as Error } };
  }
}

/** The environment the extension host sees, for host-side PATH fallbacks. */
export function hostEnv(cwd: string): { platform: NodeJS.Platform; PATH?: string; PATHEXT?: string; cwd: string } {
  return { platform: process.platform, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, cwd };
}
