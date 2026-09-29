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
 * Only terminals created here are ever used. A window reload empties the
 * pool, and VS Code restores the old terminals; that used to add one terminal
 * per worktree per reload, which is how twenty accumulated. A restored
 * terminal is now adopted only when the process table proves its shell idle
 * (`reconcile`); otherwise it stays an orphan, untouched and not counted, and
 * at most one new terminal serves every later command for that worktree. A
 * second ordinary command in a busy worktree is refused by the launchers, not
 * given a second terminal. A command the user typed in their own terminal is
 * observed, never written to.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { descendantsOf, processExists, type ProcessInfo } from "../core/processTree";
import { listProcesses, processProbeSupported } from "./processProbe";
import { chooseOwnedTerminal, explainCreation, redundantTerminals, terminalKey, unavailability, type OwnedTerminalState } from "../core/terminalOccupancy";

/** The name prefix of every terminal this extension creates. */
export const RUNNER_TERMINAL_PREFIX = "Agent Sparring — ";

/** What Clean Up Terminals did: closed and kept, each with why, and those whose liveness is unknown. */
export interface CleanupResult {
  closed: { name: string; reason: string }[];
  kept: { name: string; reason: string }[];
  /** Left open and not closed without asking: liveness cannot be established. */
  unknown: vscode.Terminal[];
}

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
  /** {@link terminalKey} of `cwd`: what "this repository's terminal" is matched by. */
  key: string;
  /** A terminal whose process is the engine command itself: tracked for cleanup, never reused. */
  dedicated: boolean;
  /** The exit code of the last command that ended in it. */
  lastExitCode?: number;
  /** Held by an Agent Sparring command. */
  leased: boolean;
  /** Shell executions running in it right now, ours and the user's alike. */
  active: Set<vscode.TerminalShellExecution>;
  /** Shell integration has reported for this terminal, so its executions are visible here. */
  observable: boolean;
}

export class TerminalPool implements vscode.Disposable {
  private readonly entries: Entry[] = [];
  /**
   * Agent Sparring terminals this window is not using: those VS Code restored
   * after a reload, and those retired from reuse. Executions seen in them
   * since are tracked, so `reconcile` never mistakes a busy one for idle.
   */
  private readonly orphans = new Map<vscode.Terminal, { active: Set<vscode.TerminalShellExecution> }>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly log: (message: string) => void,
    private readonly processes: () => Promise<ProcessInfo[]> = listProcesses,
    private readonly probeSupported: boolean = processProbeSupported(),
  ) {
    for (const terminal of vscode.window.terminals) {
      if (terminal.name.startsWith(RUNNER_TERMINAL_PREFIX)) {
        this.orphans.set(terminal, { active: new Set() });
      }
    }
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.forget(terminal);
        this.orphans.delete(terminal);
      }),
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
    const key = terminalKey(cwd);
    const choice = chooseOwnedTerminal(this.entries.map((entry) => this.stateOf(entry)), key);
    let entry: Entry;
    if (choice.kind === "reuse") {
      entry = this.entries[choice.index];
      entry.leased = true;
      this.log(`terminal reused: ${entry.terminal.name}`);
    } else {
      // One stable name per worktree. Numbered or operation-specific names
      // made every extra terminal look like a separate thing worth keeping.
      const name = runnerTerminalName(cwd);
      const terminal = vscode.window.createTerminal({ name, cwd, iconPath: new vscode.ThemeIcon("debug-alt") });
      this.log(explainCreation(choice.because, name, cwd));
      entry = { terminal, cwd, key, dedicated: false, leased: true, active: new Set(), observable: terminal.shellIntegration !== undefined };
      this.entries.push(entry);
    }
    this.closeRedundant(key, entry);
    return this.lease(entry);
  }

  /**
   * Before `acquire(cwd)`: when this worktree has no terminal in the pool,
   * adopt one of its orphaned terminals whose shell is *proven* idle, so a
   * reload does not add one terminal per worktree every time.
   *
   * VS Code reports no "is anything running" state for a terminal it
   * restored, and no execution events for a command started before the
   * reload. The process table does: a shell with no child process is running
   * nothing (a foreground or suspended job is a child). So a terminal is
   * adopted only when all of these hold —
   *
   *  - its shell reports integration (so it is a shell, and its executions
   *    are visible from now on) and it has not exited;
   *  - it was not created with a process of its own (a dedicated engine
   *    terminal has no shell to be idle);
   *  - it was opened for this worktree;
   *  - no execution has been seen starting in it without ending;
   *  - its pid is not one the operation registry still attributes an
   *    operation to (`claimedPids`);
   *  - `ps` lists its pid with no descendants.
   *
   * Anything else stays an orphan: untouched, and not this worktree's
   * terminal. Unsupported platforms never adopt.
   */
  async reconcile(cwd: string, claimedPids: ReadonlySet<number> = new Set()): Promise<void> {
    const key = terminalKey(cwd);
    if (!this.probeSupported || this.entries.some((entry) => entry.key === key && !entry.dedicated && entry.terminal.exitStatus === undefined)) {
      return;
    }
    const candidates: { terminal: vscode.Terminal; pid: number }[] = [];
    for (const [terminal, orphan] of this.orphans) {
      if (terminal.exitStatus !== undefined || !terminal.shellIntegration || orphan.active.size > 0 || ownProcess(terminal) || !openedHere(terminal, cwd, key)) {
        continue;
      }
      const pid = await terminal.processId;
      if (pid !== undefined && pid > 0 && !claimedPids.has(pid)) {
        candidates.push({ terminal, pid });
      }
    }
    if (candidates.length === 0) {
      return;
    }
    let table: ProcessInfo[];
    try {
      table = await this.processes();
    } catch {
      return;
    }
    for (const { terminal, pid } of candidates) {
      const orphan = this.orphans.get(terminal);
      // Re-checked after the awaits: anything started meanwhile disqualifies it.
      if (!orphan || orphan.active.size > 0 || terminal.exitStatus !== undefined || !processExists(table, pid) || descendantsOf(table, pid).length > 0) {
        continue;
      }
      if (this.entries.some((entry) => entry.key === key && !entry.dedicated)) {
        return;
      }
      this.orphans.delete(terminal);
      this.entries.push({ terminal, cwd, key, dedicated: false, leased: false, active: new Set(), observable: true });
      this.log(`terminal adopted after reload: ${terminal.name} — its shell (pid ${pid}) has no running child process`);
      return;
    }
  }

  /**
   * Track a terminal whose own process is an engine command, so it can be
   * closed once that process has ended. It is never leased or written to.
   */
  adoptDedicated(terminal: vscode.Terminal, cwd: string): void {
    this.entries.push({ terminal, cwd, key: terminalKey(cwd), dedicated: true, leased: false, active: new Set(), observable: false });
  }

  /**
   * Agent Sparring: Clean Up Terminals. Every terminal with our name prefix
   * is classified, and only those proven to be running nothing are closed:
   *
   *  - Active — leased, occupied, a dedicated engine still running, or an
   *    orphan whose shell `ps` shows with a child process: kept;
   *  - Current reusable — the one idle pooled terminal per worktree: kept;
   *  - Idle redundant — another idle pooled terminal, or an orphan whose
   *    shell `ps` proves idle and no operation claims: closed;
   *  - Ended — its process has exited: closed;
   *  - Unknown — liveness cannot be established (no process table on this
   *    platform, no shell integration, a pid an operation still claims):
   *    never closed here, returned in `unknown` for the caller to ask about.
   *
   * A person's own terminals are never looked at.
   */
  async cleanUp(claimedPids: ReadonlySet<number> = new Set()): Promise<CleanupResult> {
    const result: CleanupResult = { closed: [], kept: [], unknown: [] };
    const close = (terminal: vscode.Terminal, why: string) => {
      result.closed.push({ name: terminal.name, reason: why });
      this.forget(terminal);
      this.orphans.delete(terminal);
      terminal.dispose();
    };
    const current = new Set<string>();
    for (const entry of [...this.entries]) {
      const state = this.stateOf(entry);
      const reason = unavailability(state);
      if (reason === "exited") {
        close(entry.terminal, "ended");
      } else if (reason === undefined && !current.has(entry.key)) {
        current.add(entry.key);
        result.kept.push({ name: entry.terminal.name, reason: "current reusable terminal for its worktree" });
      } else if (reason === undefined) {
        close(entry.terminal, "idle and redundant");
      } else {
        result.kept.push({ name: entry.terminal.name, reason: describeKept(reason) });
      }
    }
    const pooled = new Set(this.entries.map((entry) => entry.terminal));
    const others = vscode.window.terminals.filter((terminal) => !pooled.has(terminal) && terminal.name.startsWith(RUNNER_TERMINAL_PREFIX));
    let table: ProcessInfo[] | undefined;
    if (this.probeSupported && others.some((terminal) => terminal.exitStatus === undefined)) {
      table = await this.processes().catch(() => undefined);
    }
    for (const terminal of others) {
      if (terminal.exitStatus !== undefined) {
        close(terminal, "ended");
        continue;
      }
      const pid = await terminal.processId;
      const seen = this.orphans.get(terminal)?.active.size ?? 0;
      if (table && pid !== undefined && pid > 0 && !claimedPids.has(pid) && processExists(table, pid)) {
        if (descendantsOf(table, pid).length > 0 || seen > 0) {
          result.kept.push({ name: terminal.name, reason: "a process is running in it" });
          continue;
        }
        if (terminal.shellIntegration && !ownProcess(terminal)) {
          close(terminal, "idle and redundant (its shell has no running child process)");
          continue;
        }
      }
      result.unknown.push(terminal);
    }
    return result;
  }

  /** Close terminals a person confirmed closing from `cleanUp().unknown`. */
  closeConfirmed(terminals: readonly vscode.Terminal[]): string[] {
    const names: string[] = [];
    for (const terminal of terminals) {
      if (vscode.window.terminals.includes(terminal)) {
        names.push(terminal.name);
        this.orphans.delete(terminal);
        this.forget(terminal);
        terminal.dispose();
      }
    }
    return names;
  }

  /**
   * Once `keep` is this repository's terminal, close its other terminals that
   * are known to have ended cleanly, so one per repository is what remains.
   */
  private closeRedundant(key: string, keep: Entry): void {
    const states = this.entries.map((entry) => this.stateOf(entry));
    for (const index of redundantTerminals(states, key, this.entries.indexOf(keep)).reverse()) {
      const entry = this.entries[index];
      this.log(`closed ${entry.terminal.name}: its command had ended, and ${keep.terminal.name} is this repository's runner terminal`);
      this.entries.splice(index, 1);
      entry.terminal.dispose();
    }
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

  /**
   * Reveal the terminal an explicit "Show terminal" asks for: the one named
   * `name` when it is one of ours, otherwise this repository's pooled
   * terminal. Nothing else ever calls `show()` for a routine command.
   */
  reveal(cwd: string | undefined, name?: string): boolean {
    const byName = name ? vscode.window.terminals.find((terminal) => terminal.name === name && terminal.name.startsWith(RUNNER_TERMINAL_PREFIX)) : undefined;
    const key = cwd ? terminalKey(cwd) : undefined;
    // The pool's own terminal first: names are per repository, so a name can
    // also match a terminal an earlier window left behind.
    const leased = key ? this.entries.find((entry) => entry.key === key && entry.leased) : undefined;
    const any = key ? this.entries.find((entry) => entry.key === key) : undefined;
    const terminal = leased?.terminal ?? byName ?? any?.terminal;
    if (!terminal) {
      return false;
    }
    terminal.show(false);
    return true;
  }

  private stateOf(entry: Entry): OwnedTerminalState {
    return {
      cwd: entry.key,
      dedicated: entry.dedicated,
      ...(entry.lastExitCode !== undefined ? { lastExitCode: entry.lastExitCode } : {}),
      exited: entry.terminal.exitStatus !== undefined,
      leased: entry.leased,
      activeExecutions: entry.active.size,
      observable: entry.observable,
    };
  }

  private onExecutionStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    this.orphans.get(event.terminal)?.active.add(event.execution);
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
    this.orphans.get(event.terminal)?.active.delete(event.execution);
    const entry = this.entries.find((candidate) => candidate.terminal === event.terminal);
    if (entry) {
      entry.observable = true;
      entry.active.delete(event.execution);
      entry.lastExitCode = event.exitCode;
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
        // Still open and still ours: never written to again unless the
        // process table later proves its shell idle (see `reconcile`).
        this.orphans.set(entry.terminal, { active: new Set(entry.active) });
      },
    };
  }

  private forget(terminal: vscode.Terminal): void {
    const index = this.entries.findIndex((entry) => entry.terminal === terminal);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }
  }

  /**
   * Terminals whose process has exited are never reused. One whose last
   * command ended cleanly is closed; one that failed keeps its tab, and its
   * output, until Clean Up Terminals.
   */
  private prune(): void {
    for (const entry of [...this.entries]) {
      const exit = entry.terminal.exitStatus;
      if (exit === undefined) {
        continue;
      }
      const code = entry.dedicated ? exit.code : entry.lastExitCode;
      if (code === undefined || code === 0) {
        this.forget(entry.terminal);
        entry.terminal.dispose();
      }
    }
  }
}

/** `Agent Sparring — <worktree>`: the one name a worktree's terminals ever have. */
export function runnerTerminalName(cwd: string): string {
  return `${RUNNER_TERMINAL_PREFIX}${path.basename(cwd)}`;
}

/** The worktree a terminal was opened for, from its creation options. */
function openedFor(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions as vscode.TerminalOptions | undefined;
  const cwd = options?.cwd;
  const where = typeof cwd === "string" ? cwd : cwd?.fsPath;
  return where ? terminalKey(where) : undefined;
}

/**
 * Opened for this worktree: by its creation options, or — when a restored
 * terminal no longer carries them — by its stable name together with the
 * working directory its shell reports.
 */
function openedHere(terminal: vscode.Terminal, cwd: string, key: string): boolean {
  const opened = openedFor(terminal);
  return opened !== undefined ? opened === key : terminal.name === runnerTerminalName(cwd) && reportedCwd(terminal) === key;
}

/** The worktree its shell says it is in, when shell integration reports one. */
function reportedCwd(terminal: vscode.Terminal): string | undefined {
  const where = terminal.shellIntegration?.cwd?.fsPath;
  return where ? terminalKey(where) : undefined;
}

/** Created with a process of its own (a dedicated engine terminal), not a shell. */
function ownProcess(terminal: vscode.Terminal): boolean {
  const options = terminal.creationOptions as vscode.TerminalOptions | undefined;
  return options?.shellPath !== undefined || (options?.shellArgs !== undefined && options.shellArgs.length > 0);
}

function describeKept(reason: string | undefined): string {
  switch (reason) {
    case "leased":
      return "an Agent Sparring command is running in it";
    case "occupied":
      return "a command is running in it";
    case "dedicated":
      return "its engine command is still running";
    case "unobservable":
      return "whether it is still running cannot be established";
    default:
      return "it may still be in use";
  }
}
