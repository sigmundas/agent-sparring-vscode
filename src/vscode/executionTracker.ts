/**
 * Observes `sparring` runner processes so liveness never rests on telemetry.
 *
 * Sources, most exact first:
 *  - launches by this extension through the terminal shell-integration API
 *    (`executeCommand(executable, args)`: argument array, no quoting), ended
 *    by the matching shell-execution end event;
 *  - launches in a dedicated terminal whose process is the runner, used only
 *    when shell integration never becomes available; ended when that
 *    terminal closes (VS Code closes it as soon as the process exits);
 *  - commands typed by the user in any integrated terminal, recognised from
 *    the shell-integration start event's command line and cwd;
 *  - launches recorded in workspaceState before a window reload, re-found by
 *    their terminal's process id and, on POSIX, confirmed alive by a
 *    process-table probe; without a probe they stay `unknown`.
 *
 * Any shell execution starting or ending in a terminal that hosts a tracked
 * runner, and the terminal closing, end that runner: a shell runs one
 * foreground command at a time. Ended records are kept (until the next
 * launch for the same run) so a stale `turn.started` can be presented as
 * "interrupted" instead of "running".
 */

import * as vscode from "vscode";
import type { SparringLocation } from "../core/discovery";
import type { ExecutionRecord, ExecutionSource } from "../core/liveness";
import { findDescendant } from "../core/processTree";
import { commandLineRuns, matchSparringCommand, parseSparringCommand, type SparringSubcommand } from "../core/sparringCommand";
import { listProcesses, processProbeSupported } from "./processProbe";

const LAUNCHES_KEY = "agentSparring.launches";
/** How long a fresh terminal gets to report shell integration before the dedicated-terminal fallback is used. */
export const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
/** After a reload, how long reconnected terminals get to appear before a recorded launch is declared gone. */
export const RECONNECT_GRACE_MS = 6000;
const PROBE_INTERVAL_MS = 4000;

export interface LaunchOptions {
  executable: string;
  args: string[];
  cwd: string;
  /** Terminal title suffix and log label. */
  name: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  reveal: boolean;
}

interface Tracked {
  record: ExecutionRecord;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  terminal?: vscode.Terminal;
  terminalPid?: number;
  execution?: vscode.TerminalShellExecution;
  probeTimer?: ReturnType<typeof setInterval>;
}

interface PersistedLaunch {
  id: string;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  planPath?: string;
  source: ExecutionSource;
  startedAtMs: number;
  terminalPid: number;
  terminalName: string;
}

export type TrackerChange = "started" | "ended" | "changed";

export class ExecutionTracker implements vscode.Disposable {
  private readonly tracked = new Map<string, Tracked>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<TrackerChange>();
  readonly onDidChange = this.changeEmitter.event;
  private counter = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly locations: () => SparringLocation[],
  ) {
    this.disposables.push(
      this.changeEmitter,
      vscode.window.onDidStartTerminalShellExecution((event) => this.onExecutionStarted(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => this.onExecutionEnded(event)),
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal)),
    );
  }

  dispose(): void {
    for (const item of this.tracked.values()) {
      this.stopProbe(item);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  // ---------------------------------------------------------------- queries

  /** The latest execution known for a run: running, unknown, or the last one that ended. */
  executionFor(runId: string | undefined): ExecutionRecord | undefined {
    if (!runId) {
      return undefined;
    }
    let best: ExecutionRecord | undefined;
    for (const { record } of this.tracked.values()) {
      if (record.runId === runId && (!best || record.startedAtMs > best.startedAtMs)) {
        best = record;
      }
    }
    return best;
  }

  /** Send Ctrl-C to the exact terminal hosting this run's live execution. */
  stop(runId: string): boolean {
    const item = this.liveItemFor(runId);
    if (!item?.terminal) {
      return false;
    }
    item.terminal.sendText("\u0003", false); // ETX, i.e. Ctrl-C
    item.terminal.show(true);
    this.log(`sent Ctrl-C to the terminal running ${describe(item)}`);
    return true;
  }

  private liveItemFor(runId: string): Tracked | undefined {
    return [...this.tracked.values()].filter((item) => item.record.runId === runId && item.record.state !== "ended").sort((a, b) => b.record.startedAtMs - a.record.startedAtMs)[0];
  }

  // ---------------------------------------------------------------- launching

  /**
   * Run `executable args` in a fresh integrated terminal (the user's normal
   * shell, cwd = project) through shell integration. Falls back to a
   * dedicated terminal whose process is the runner when shell integration
   * does not appear in time. Never builds a quoted command line.
   */
  async launch(options: LaunchOptions): Promise<ExecutionRecord> {
    this.dropEnded(options.runId);
    const title = `Agent Sparring: ${options.name}`;
    const shellTerminal = vscode.window.createTerminal({ name: title, cwd: options.cwd, iconPath: new vscode.ThemeIcon("debug-alt") });
    if (options.reveal) {
      shellTerminal.show(true);
    }
    const integration = await this.awaitShellIntegration(shellTerminal);
    if (integration) {
      const execution = integration.executeCommand(options.executable, options.args);
      const item = this.track(options, "launched", shellTerminal, execution);
      this.log(`launched ${options.name} via shell integration (${options.args.length} args, cwd ${options.cwd})`);
      void this.persistWithPid(item, shellTerminal);
      this.changeEmitter.fire("started");
      return item.record;
    }
    shellTerminal.dispose();
    const dedicated = vscode.window.createTerminal({
      name: title,
      shellPath: options.executable,
      shellArgs: options.args,
      cwd: options.cwd,
      iconPath: new vscode.ThemeIcon("debug-alt"),
    });
    if (options.reveal) {
      dedicated.show(true);
    }
    const item = this.track(options, "terminal", dedicated, undefined);
    this.log(`launched ${options.name} in a dedicated terminal (shell integration unavailable; ${options.args.length} args, cwd ${options.cwd})`);
    void this.persistWithPid(item, dedicated);
    this.changeEmitter.fire("started");
    return item.record;
  }

  private awaitShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
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
      const timer = setTimeout(() => done(undefined), SHELL_INTEGRATION_TIMEOUT_MS);
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

  private track(options: Pick<LaunchOptions, "runId" | "kind" | "stageId" | "planPath">, source: ExecutionSource, terminal: vscode.Terminal | undefined, execution: vscode.TerminalShellExecution | undefined, startedAtMs = Date.now()): Tracked {
    const id = `${startedAtMs}-${++this.counter}`;
    const item: Tracked = {
      record: { id, runId: options.runId, kind: options.kind, source, state: "running", startedAtMs },
      kind: options.kind,
      stageId: options.stageId,
      planPath: options.planPath,
      terminal,
      execution,
    };
    this.tracked.set(id, item);
    return item;
  }

  private dropEnded(runId: string): void {
    for (const [id, item] of this.tracked) {
      if (item.record.runId === runId && item.record.state === "ended") {
        this.tracked.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------- shell integration events

  private onExecutionStarted(event: vscode.TerminalShellExecutionStartEvent): void {
    const own = this.itemForExecution(event.execution);
    if (own) {
      return; // our own launch; already tracked as running
    }
    // A shell runs one foreground command at a time: anything else starting
    // in a terminal that hosts a tracked runner means that runner has ended.
    for (const item of this.itemsHostedIn(event.terminal)) {
      this.end(item, undefined, "Another command started in its terminal, so the runner had already ended.");
    }
    const parsed = parseSparringCommand(event.execution.commandLine.value);
    if (!parsed) {
      return;
    }
    const cwd = event.execution.cwd?.fsPath ?? event.shellIntegration.cwd?.fsPath;
    const match = matchSparringCommand(parsed, cwd, this.locations());
    if (!match) {
      this.log(`saw a sparring ${parsed.subcommand} command in a terminal but could not tie it to a known project (cwd ${cwd ?? "unknown"})`);
      return;
    }
    this.dropEnded(match.runId);
    const item = this.track({ runId: match.runId, kind: match.kind, stageId: match.stageId, planPath: match.planPath }, "observed", event.terminal, event.execution);
    this.log(`observed ${describe(item)} start in terminal "${event.terminal.name}"`);
    void this.persistWithPid(item, event.terminal);
    this.changeEmitter.fire("started");
  }

  private onExecutionEnded(event: vscode.TerminalShellExecutionEndEvent): void {
    const own = this.itemForExecution(event.execution);
    if (own) {
      this.end(own, event.exitCode, undefined);
      return;
    }
    // An in-flight command from before a reload finishing: VS Code may report
    // its end without our ever having seen it start.
    for (const item of this.itemsHostedIn(event.terminal)) {
      this.end(item, event.exitCode, undefined);
    }
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    for (const item of this.itemsHostedIn(terminal)) {
      const code = item.record.source === "terminal" ? terminal.exitStatus?.code : undefined;
      this.end(item, code, item.record.source === "terminal" ? undefined : "Its terminal was closed.");
    }
  }

  private itemForExecution(execution: vscode.TerminalShellExecution): Tracked | undefined {
    for (const item of this.tracked.values()) {
      if (item.execution === execution) {
        return item;
      }
    }
    return undefined;
  }

  private itemsHostedIn(terminal: vscode.Terminal): Tracked[] {
    return [...this.tracked.values()].filter((item) => item.terminal === terminal && item.record.state !== "ended");
  }

  private end(item: Tracked, exitCode: number | undefined, detail: string | undefined): void {
    if (item.record.state === "ended") {
      return;
    }
    this.stopProbe(item);
    item.record = { ...item.record, state: "ended", endedAtMs: Date.now(), exitCode, detail };
    const how = exitCode === undefined ? "ended without an exit code (Ctrl-C, signal or terminal closed)" : exitCode === 0 ? "exited normally" : `exited with code ${exitCode}`;
    this.log(`${describe(item)} ${how}${detail ? ` — ${detail}` : ""}`);
    void this.persist();
    this.changeEmitter.fire("ended");
  }

  // ---------------------------------------------------------------- persistence + reload

  private async persistWithPid(item: Tracked, terminal: vscode.Terminal): Promise<void> {
    try {
      item.terminalPid = await terminal.processId;
    } catch {
      item.terminalPid = undefined;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const launches: PersistedLaunch[] = [];
    for (const item of this.tracked.values()) {
      if (item.record.state !== "ended" && item.terminalPid !== undefined && item.terminal) {
        launches.push({
          id: item.record.id,
          runId: item.record.runId,
          kind: item.kind,
          stageId: item.stageId,
          planPath: item.planPath,
          source: item.record.source,
          startedAtMs: item.record.startedAtMs,
          terminalPid: item.terminalPid,
          terminalName: item.terminal.name,
        });
      }
    }
    await this.context.workspaceState.update(LAUNCHES_KEY, launches);
  }

  /**
   * After activation: every launch recorded before the window reloaded is
   * re-tied to its terminal by process id. Found and a dedicated runner
   * terminal → running (the terminal exists only while the process does).
   * Found and a shell terminal → a POSIX process probe decides running /
   * ended; elsewhere the state stays `unknown`. Not found within the
   * reconnect grace period → ended (the shell that hosted it is gone).
   */
  async reattach(): Promise<void> {
    const launches = this.context.workspaceState.get<PersistedLaunch[]>(LAUNCHES_KEY, []);
    if (launches.length === 0) {
      return;
    }
    const pending = new Map<string, PersistedLaunch>(launches.map((launch) => [launch.id, launch]));
    for (const launch of launches) {
      const item: Tracked = {
        record: {
          id: launch.id,
          runId: launch.runId,
          kind: launch.kind,
          source: launch.source,
          state: "unknown",
          startedAtMs: launch.startedAtMs,
          detail: "The window reloaded; looking for the terminal that hosted this run.",
        },
        kind: launch.kind,
        stageId: launch.stageId,
        planPath: launch.planPath,
        terminalPid: launch.terminalPid,
      };
      this.tracked.set(launch.id, item);
    }
    this.changeEmitter.fire("changed");
    this.log(`window reloaded with ${launches.length} recorded launch(es); re-establishing runner liveness`);

    const tryTerminal = async (terminal: vscode.Terminal) => {
      let pid: number | undefined;
      try {
        pid = await terminal.processId;
      } catch {
        return;
      }
      for (const [id, launch] of pending) {
        if (launch.terminalPid === pid) {
          pending.delete(id);
          await this.reattachTo(this.tracked.get(id) as Tracked, terminal);
        }
      }
    };
    const opened = vscode.window.onDidOpenTerminal((terminal) => void tryTerminal(terminal));
    await Promise.all(vscode.window.terminals.map(tryTerminal));
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_MS));
    opened.dispose();
    for (const id of pending.keys()) {
      const item = this.tracked.get(id);
      if (item && item.record.state !== "ended") {
        this.end(item, undefined, "The terminal that hosted this run was not found after the window reloaded, so the runner cannot still be alive.");
      }
    }
    await this.persist();
  }

  private async reattachTo(item: Tracked, terminal: vscode.Terminal): Promise<void> {
    item.terminal = terminal;
    if (item.record.source === "terminal") {
      // The terminal's process is the runner: present means alive.
      item.record = { ...item.record, state: "running", source: "reattached", detail: undefined };
      this.log(`${describe(item)}: its dedicated terminal survived the reload; runner alive`);
      this.changeEmitter.fire("changed");
      return;
    }
    if (!processProbeSupported()) {
      item.record = {
        ...item.record,
        state: "unknown",
        detail: `The terminal "${terminal.name}" that hosted this run survived the reload, but VS Code exposes no way to tell whether the command inside it is still running, and no process probe is available on this platform.`,
      };
      this.log(`${describe(item)}: terminal found after reload; liveness unknown on ${process.platform}`);
      this.changeEmitter.fire("changed");
      return;
    }
    await this.probe(item, true);
    if (item.record.state === "running") {
      item.probeTimer = setInterval(() => void this.probe(item, false), PROBE_INTERVAL_MS);
    }
  }

  private async probe(item: Tracked, first: boolean): Promise<void> {
    if (item.record.state === "ended" || item.terminalPid === undefined) {
      this.stopProbe(item);
      return;
    }
    let found = false;
    try {
      const processes = await listProcesses();
      found = findDescendant(processes, item.terminalPid, (commandLine) => commandLineRuns(commandLine, { kind: item.kind, stageId: item.stageId, planPath: item.planPath })) !== undefined;
    } catch (error) {
      item.record = { ...item.record, state: "unknown", detail: `The terminal that hosted this run survived the reload, but the process probe failed: ${(error as Error).message}` };
      this.stopProbe(item);
      this.changeEmitter.fire("changed");
      return;
    }
    if (found) {
      if (item.record.state !== "running") {
        item.record = { ...item.record, state: "running", source: "reattached", detail: undefined };
        this.log(`${describe(item)}: process found under its reconnected terminal; runner alive`);
        this.changeEmitter.fire("changed");
      }
      return;
    }
    this.end(item, undefined, first ? "The terminal that hosted this run survived the reload, but no runner process is running under it any more." : "Its process is no longer running under the reconnected terminal.");
  }

  private stopProbe(item: Tracked): void {
    if (item.probeTimer) {
      clearInterval(item.probeTimer);
      item.probeTimer = undefined;
    }
  }
}

function describe(item: Tracked): string {
  return `${item.kind} ${item.stageId ?? item.planPath ?? ""}`.trim();
}
