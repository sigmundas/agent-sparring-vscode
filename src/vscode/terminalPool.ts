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
 * open. The lease exists so that
 *
 *  - a terminal that is busy is never sent a second command (a shell runs one
 *    foreground command at a time): the next caller gets its own terminal;
 *  - a terminal the user closed, or whose shell exited, is dropped and
 *    recreated on the next command;
 *  - projects never share one, because they never share a cwd.
 *
 * Only terminals created here are ever used. A command the user typed in
 * their own terminal is observed, never written to.
 */

import * as path from "node:path";
import * as vscode from "vscode";

export interface TerminalLease {
  terminal: vscode.Terminal;
  /** Hand the terminal back so the next command may reuse it. Idempotent. */
  release(): void;
  /** Close and forget it: a shell that never reported integration is of no use. */
  discard(): void;
}

interface Entry {
  terminal: vscode.Terminal;
  cwd: string;
  busy: boolean;
}

export class TerminalPool implements vscode.Disposable {
  private readonly entries: Entry[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: (message: string) => void) {
    this.disposables.push(vscode.window.onDidCloseTerminal((terminal) => this.forget(terminal)));
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
    const known = this.entries.find((entry) => entry.cwd === cwd && !entry.busy);
    if (known) {
      known.busy = true;
      return this.lease(known);
    }
    const sameProject = this.entries.filter((entry) => entry.cwd === cwd).length;
    const name = `Agent Sparring — ${path.basename(cwd)}${sameProject > 0 ? ` (${sameProject + 1})` : ""}`;
    const terminal = vscode.window.createTerminal({ name, cwd, iconPath: new vscode.ThemeIcon("debug-alt") });
    this.log(sameProject > 0 ? `opened a second terminal for ${cwd}: this project's terminal is busy` : `opened the terminal ${name}`);
    const entry: Entry = { terminal, cwd, busy: true };
    this.entries.push(entry);
    return this.lease(entry);
  }

  /** Whether a terminal is one of ours and currently running one of our commands. */
  isBusy(terminal: vscode.Terminal): boolean {
    return this.entries.some((entry) => entry.terminal === terminal && entry.busy);
  }

  private lease(entry: Entry): TerminalLease {
    let done = false;
    return {
      terminal: entry.terminal,
      release: () => {
        if (!done) {
          done = true;
          entry.busy = false;
        }
      },
      discard: () => {
        done = true;
        this.forget(entry.terminal);
        entry.terminal.dispose();
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
