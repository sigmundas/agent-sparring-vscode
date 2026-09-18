/**
 * The last step of a shell launch: putting the command line into a terminal
 * whose shell is idle *at that instant*.
 *
 * Both shell transports — the runner launcher (executionTracker.ts) and the
 * short-command runner (commandRunner.ts) — used to do this:
 *
 *     acquire an idle terminal
 *       → await shell integration
 *       → await operations.arm()            (the durable execution intent)
 *       → executeCommand on the terminal that *was* idle
 *
 * Two awaits separate the occupancy check from the hand-over, and the person
 * can start their own command in that terminal while they run: a `python`
 * REPL, an interactive `claude`. The engine's command line was then written
 * into their foreground process, which is both a lost engine command and text
 * typed into someone else's program.
 *
 * So the final check and the hand-over happen here as one step with no
 * `await` between them. A terminal that is no longer observably idle is left
 * completely alone — nothing is written to it and it is not interrupted; it is
 * retired from reuse and another genuinely idle terminal is acquired, which
 * needs its own shell integration and is then checked again the same way.
 *
 * The operation identity is untouched by any of this. It was armed before the
 * first attempt, and while a safe terminal is being looked for it stays armed:
 * nothing has executed, so there is nothing to resolve and nothing to
 * re-claim. Only when no terminal can be found at all does the caller settle
 * it — and then with the one fact it positively knows, that the hand-over was
 * never invoked.
 */

import * as vscode from "vscode";
import { awaitShellIntegration, performShellHandover, shellHandoverFor, type ShellRequest } from "./shellIntegration";
import type { TerminalLease, TerminalPool } from "./terminalPool";

/** How many terminals are tried before the caller is told nothing could be handed over. */
export const IDLE_TERMINAL_ATTEMPTS = 3;

export type HandoverOutcome =
  | { ok: true; lease: TerminalLease; request: ShellRequest }
  /** Nothing was written anywhere: every terminal tried was in use by someone else. */
  | { ok: false; reason: "no-idle-terminal"; detail: string }
  /** `executeCommand` itself threw, so the shell was given nothing. */
  | { ok: false; reason: "threw"; error: Error };

/**
 * Both `ok: false` answers mean the same thing, and it is the only thing a
 * caller may resolve an operation on: `executeCommand` was never reached, or
 * it threw, so this window knows from its own instruction stream that no shell
 * was given anything. Anything that goes wrong *after* it returns comes back
 * as `ok: true` with `request.metadataError` set, because by then the shell has
 * the command line (shellIntegration.ts, `performShellHandover`).
 */

export interface HandoverRequest {
  pool: Pick<TerminalPool, "acquire">;
  cwd: string;
  /** The lease whose shell integration the caller already has. */
  lease: TerminalLease;
  integration: vscode.TerminalShellIntegration;
  word: string;
  args: string[];
  /** Shown when a replacement terminal has to be used, so the person sees where the command went. */
  reveal: boolean;
  log: (message: string) => void;
  attempts?: number;
}

/**
 * Hand `word` plus `args` to an idle shell, replacing the terminal as often
 * as necessary. The returned lease is the one the command was actually given
 * to, which may not be the one that was passed in.
 */
export async function handOverToIdleShell(request: HandoverRequest): Promise<HandoverOutcome> {
  let lease = request.lease;
  let integration: vscode.TerminalShellIntegration | undefined = request.integration;
  const attempts = request.attempts ?? IDLE_TERMINAL_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (integration) {
      const handover = shellHandoverFor(request.word, request.args);
      // The critical step: the check and the hand-over, with nothing awaited
      // in between, so no user activity can come between them.
      if (handover.via !== "no-shell" && lease.idle()) {
        // Deliberately no `try` around this: `performShellHandover` keeps
        // `executeCommand` alone inside its own, and reports anything that
        // goes wrong afterwards as a hand-over that happened. A `catch` here
        // would put the irreversible call and the observation of its result
        // back inside one block, which is the defect being removed.
        const attempt = performShellHandover(integration, request.word, request.args, handover);
        if (attempt.handedOver) {
          if (attempt.request.metadataError) {
            request.log(
              `"${lease.terminal.name}" was given the command, but reading back what the host said it handed over failed (${attempt.request.metadataError.message}). The shell has the command line; only how it can be described here is affected.`,
            );
          }
          return { ok: true, lease, request: attempt.request };
        }
        return { ok: false, reason: "threw", error: attempt.error };
      }
      if (handover.via === "no-shell") {
        // This shell's quoting cannot be written here. That is a fact about
        // the shell, not about the terminal, so trying another one of the
        // same shell would fail identically.
        return { ok: false, reason: "no-idle-terminal", detail: "this shell's quoting cannot be written safely, so nothing was handed to it" };
      }
      request.log(
        `"${lease.terminal.name}" is no longer idle — something was started in it while Agent Sparring was recording what it was about to run. Nothing is written into it and nothing in it is interrupted; it is retired from reuse and another terminal is used.`,
      );
      lease.retire();
    }
    if (attempt === attempts) {
      break;
    }
    lease = request.pool.acquire(request.cwd);
    if (request.reveal) {
      lease.terminal.show(true);
    }
    integration = await awaitShellIntegration(lease.terminal);
    if (!integration) {
      // A shell that never reported integration cannot be written to or
      // watched; it is of no use to anyone and is closed again.
      lease.discard();
    }
  }
  return {
    ok: false,
    reason: "no-idle-terminal",
    detail: `no terminal of this project had an idle, observable shell after ${attempts} attempt(s); nothing was written into any of them`,
  };
}
