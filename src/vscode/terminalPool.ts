/**
 * The integrated terminals this extension owns.
 *
 * A plan is a long sequence of engine commands — run-plan, a resume-plan per
 * pause, freeze, accept — and one terminal per command turned the panel into
 * a list of dead tabs. So there is one reusable terminal per project,
 * `Agent Sparring — <project>`, and a command takes it out on lease for as
 * long as it runs.
 *
 * What the lease is *not*: it is not the unit of liveness. Every shell
 * execution is still tracked on its own (executionTracker.ts) and a finished
 * command can never keep the UI Running just because its terminal is still
 * open. Nor is the lease the unit of *occupancy*: after an Agent Sparring
 * command finishes, the terminal stays open and the person may start
 * anything there — an interactive Claude CLI, a long test run — and that
 * shell is then theirs. So the pool watches every shell execution in the
 * terminals it owns, whoever started it, and a terminal is available only
 * when its shell is genuinely idle (see core/terminalOccupancy.ts). When it
 * is not, the next command gets a second terminal and the occupied one is
 * neither written to nor interrupted.
 *
 * The pool therefore guarantees that
 *
 *  - a terminal whose shell is running anything is never sent a command (a
 *    shell runs one foreground command at a time);
 *  - a terminal whose occupancy cannot be established — no shell integration
 *    ever reported, or a terminal this window did not create and watch from
 *    the start — is left alone rather than assumed idle;
 *  - a terminal the user closed, or whose shell exited, is dropped and
 *    recreated on the next command;
 *  - projects never share one, because they never share a cwd.
 *
 * Only terminals created here are ever used, and only while this window has
 * watched them. A window reload empties the pool: terminals VS Code restores
 * are not adopted, because nothing here saw what they have been doing. A
 * command the user typed in their own terminal is observed, never written to.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { chooseOwnedTerminal, explainCreation, unavailability, type OwnedTerminalState } from "../core/terminalOccupancy";

export interface TerminalLease {
  terminal: vscode.Terminal;
  /**
   * Whether this leased terminal's shell is idle *at this instant*, and
   * observably so: still in the pool, its shell alive, its executions visible
   * to this window, and nothing running in it.
   *
   * Synchronous by design, and the last thing a caller does before handing a
   * command line over. Acquiring an idle terminal and then awaiting anything
   * — shell integration, the durable record of the intent — leaves a window in
   * which the person can start their own command in that very terminal, and a
   * command written into it then would be typed into someone else's foreground
   * process. So occupancy is checked again with no `await` between the check
   * and `executeCommand`.
   */
  idle(): boolean;
  /** Hand the terminal back so the next command may reuse it. Idempotent. */
  release(): void;
  /** Close and forget it: a shell that never reported integration is of no use. */
  discard(): void;
  /**
   * Forget it without closing it: never write to this terminal again, but
   * leave whatever is in it running. For a command the shell never took —
   * the text may be sitting unread in someone else's foreground process, and
   * taking their terminal away from them is not this extension's to do.
   */
  retire(): void;
}

interface Entry {
  terminal: vscode.Terminal;
  cwd: string;
  /** Held by an Agent Sparring command. */
  leased: boolean;
  /** Shell executions running in it right now, ours and the user's alike. */
  active: Set<vscode.TerminalShellExecution>;
  /** Shell integration has reported for this terminal, so its executions are visible here. */
  observable: boolean;
}

export class TerminalPool implements vscode.Disposable {
  private readonly entries: Entry[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: (message: string) => void) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => this.forget(terminal)),
      // Occupancy, from the only events that report it. They fire only for
      // terminals with shell integration, which is also the only kind this
      // extension ever writes to.
      vscode.window.onDidStartTerminalShellExecution((event) => this.onExecutionStarted(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => this.onExecutionEnded(event)),
      vscode.window.onDidChangeTerminalShellIntegration((event) => this.onIntegration(event.terminal)),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.entries.length = 0;
  }

  /**
   * A terminal for `cwd`, reusing this project's idle one when there is one.
   * The caller must `release()` when its command has ended.
   */
  acquire(cwd: string): TerminalLease {
    this.prune();
    const choice = chooseOwnedTerminal(this.entries.map((entry) => this.stateOf(entry)), cwd);
    if (choice.kind === "reuse") {
      const known = this.entries[choice.index];
      known.leased = true;
      return this.lease(known);
    }
    const sameProject = this.entries.filter((entry) => entry.cwd === cwd).length;
    const name = `Agent Sparring — ${path.basename(cwd)}${sameProject > 0 ? ` (${sameProject + 1})` : ""}`;
    const terminal = vscode.window.createTerminal({ name, cwd, iconPath: new vscode.ThemeIcon("debug-alt") });
    this.log(explainCreation(choice.because, name, cwd));
    const entry: Entry = { terminal, cwd, leased: true, active: new Set(), observable: terminal.shellIntegration !== undefined };
    this.entries.push(entry);
    return this.lease(entry);
  }

  /**
   * The terminals in the pool and, for each, why it may not be sent a
   * command: a lease of ours, a shell execution someone else started, a
   * shell whose executions this window cannot see, or a shell that has
   * exited. `undefined` means its shell is idle and the next command for
   * that project would reuse it. Terminals that are not in the pool — one
   * VS Code restored after a reload, one that was retired — do not appear,
   * because they are never written to at all.
   */
  owned(): { name: string; cwd: string; unavailable?: string }[] {
    return this.entries.map((entry) => ({ name: entry.terminal.name, cwd: entry.cwd, unavailable: unavailability(this.stateOf(entry)) }));
  }

  private stateOf(entry: Entry): OwnedTerminalState {
    return {
      cwd: entry.cwd,
      exited: entry.terminal.exitStatus !== undefined,
      leased: entry.leased,
      activeExecutions: entry.active.size,
      observable: entry.observable,
    };
  }

  private onExecutionStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const entry = this.entries.find((candidate) => candidate.terminal === event.terminal);
    if (!entry) {
      return;
    }
    entry.observable = true;
    entry.active.add(event.execution);
    if (!entry.leased) {
      // Not ours: someone is using this terminal. It stays theirs until the
      // shell reports the command ended.
      this.log(`a command was started in ${entry.terminal.name} from outside Agent Sparring; that terminal is not available for engine commands while it runs`);
    }
  }

  private onExecutionEnded(event: vscode.TerminalShellExecutionEndEvent): void {
    const entry = this.entries.find((candidate) => candidate.terminal === event.terminal);
    if (entry) {
      entry.observable = true;
      entry.active.delete(event.execution);
    }
  }

  private onIntegration(terminal: vscode.Terminal): void {
    const entry = this.entries.find((candidate) => candidate.terminal === terminal);
    if (entry) {
      entry.observable = true;
    }
  }

  private lease(entry: Entry): TerminalLease {
    let done = false;
    return {
      terminal: entry.terminal,
      idle: () =>
        !done &&
        this.entries.includes(entry) &&
        entry.terminal.exitStatus === undefined &&
        entry.observable &&
        entry.active.size === 0,
      release: () => {
        if (!done) {
          done = true;
          entry.leased = false;
        }
      },
      discard: () => {
        done = true;
        this.forget(entry.terminal);
        entry.terminal.dispose();
      },
      retire: () => {
        done = true;
        entry.leased = false;
        this.forget(entry.terminal);
      },
    };
  }

  private forget(terminal: vscode.Terminal): void {
    const index = this.entries.findIndex((entry) => entry.terminal === terminal);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }
  }

  /** Drop terminals whose shell has exited; VS Code keeps the tab until the user closes it. */
  private prune(): void {
    for (const entry of [...this.entries]) {
      if (entry.terminal.exitStatus !== undefined) {
        this.forget(entry.terminal);
      }
    }
  }
}
