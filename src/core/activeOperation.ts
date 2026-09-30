/**
 * What the Overview says Agent Sparring is doing *right now*.
 *
 * Observed in real use: while `prepare-plan` was running, the intake screen
 * showed `sparring approve-plan … --run run_3w_web` under "Engine command".
 * That line was the command the intake's *next button* would run, derived
 * from the intake on screen — not anything that was executing — and it was
 * the only command on screen, so it read as the current one. The Output
 * channel said prepare-plan; the Overview said approve-plan.
 *
 * The active operation therefore comes from one place only: the operation
 * registry's durable record (vscode/operationRegistry.ts), which is what
 * admission, the terminal hand-over and reload recovery already agree on. It
 * is never derived from the intake's approval metadata, the selected run, a
 * historical run or a button definition.
 *
 * Nothing here invents liveness. A command the shell has reported started is
 * "Engine process running" — not "the model is generating" — and an operation
 * whose process cannot be proven alive (restored after a reload, or its
 * terminal lost) has no elapsed counter at all.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";

/** The explicit liveness of one operation. */
export type OperationLiveness = "starting" | "running" | "waiting_for_user" | "succeeded" | "failed" | "liveness_unknown";

/**
 * The registry's view of an operation, reduced to what presentation needs.
 * Structurally a subset of `OperationView`, so the vscode layer passes views
 * straight through.
 */
export interface OperationRecord {
  id: string;
  label: string;
  subcommand: string;
  runId?: string;
  repoRoot: string;
  cwd: string;
  /** The stage, plan or intake the operation acts on, when it has one. */
  target?: string;
  stageId?: string;
  /** When the durable intent was written (or the claim taken). */
  submittedAtMs: number;
  /** The registry state: reserved, armed, submitted-shell, running-shell, running-direct, running-dedicated. */
  state: string;
  waitExpired: boolean;
  restored: boolean;
  observationLost?: boolean;
  shellReportedStart: boolean;
  terminalName?: string;
  /** Only when something authoritative reported them; never guessed. */
  provider?: string;
  model?: string;
}

/** An operation that has ended, as the registry last settled it in this window. */
export interface SettledOperationRecord {
  label: string;
  subcommand: string;
  repoRoot: string;
  cwd: string;
  target?: string;
  submittedAtMs: number;
  endedAtMs: number;
  /** The engine's exit code, when its end reported one. */
  exitCode?: number;
}

export interface ActiveOperationView {
  liveness: OperationLiveness;
  /** "Preparing updated intake", "Approving Stage 3R", "Running Stage 3R". */
  title: string;
  /** Provider and model, each only when something authoritative reported it. */
  meta: string[];
  /**
   * When the elapsed counter starts; absent when the process cannot be
   * proven alive. The counter itself is rendered from this (see
   * {@link workingFor}), so the model does not change every second.
   */
  startedAtMs?: number;
  /** `prepare-plan` and its target, one per line. */
  command: string[];
  /** The factual transitions reached so far. */
  activity: string[];
  /** Said instead of an elapsed counter when liveness is unknown. */
  note?: string;
  terminalName?: string;
}

export function operationLiveness(record: OperationRecord): OperationLiveness {
  if (record.restored || record.observationLost === true) {
    return "liveness_unknown";
  }
  switch (record.state) {
    case "reserved":
    case "armed":
      return "starting";
    case "submitted-shell":
      // Handed to a shell that has not said it started. Within the start
      // wait that is still starting; past it nothing is known.
      return record.waitExpired ? "liveness_unknown" : "starting";
    case "running-shell":
    case "running-direct":
    case "running-dedicated":
      return "running";
    default:
      return "liveness_unknown";
  }
}

export function settledLiveness(record: SettledOperationRecord): OperationLiveness | undefined {
  if (record.exitCode === undefined) {
    return undefined;
  }
  return record.exitCode === 0 ? "succeeded" : "failed";
}

/** "Preparing updated intake", "Approving Stage 3R", "Running Stage 3R". */
export function operationTitle(record: Pick<OperationRecord, "subcommand" | "label" | "stageId">): string {
  const stage = stageName(record);
  switch (record.subcommand) {
    case "prepare-plan":
      return "Preparing updated intake";
    case "approve-plan":
      return stage ? `Approving ${stage}` : "Approving plan stage";
    case "run-plan":
    case "resume-plan":
    case "run-loop":
    case "resume-loop":
      return stage ? `Running ${stage}` : "Running plan";
    case "run-sparring":
      return stage ? `Reviewing ${stage}` : "Reviewing stage";
    default:
      // The engine's subcommand is shown under Technical details.
      return "Running an Agent Sparring command";
  }
}

/** "Approve Stage 3R" → "Stage 3R"; "run-plan: run_3r_py" → "run_3r_py". */
function stageName(record: Pick<OperationRecord, "label" | "stageId">): string | undefined {
  const fromLabel = /\b(Stage\s+\S+)/.exec(record.label)?.[1];
  if (fromLabel) {
    return fromLabel;
  }
  return record.stageId && !record.stageId.includes(path.sep) && !record.stageId.includes("#") ? record.stageId : undefined;
}

/** "2m 13s", "45s", "1h 04m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function displayTarget(record: Pick<OperationRecord, "target" | "repoRoot">): string | undefined {
  if (!record.target) {
    return undefined;
  }
  // An intake target is `<dir>#<run>`; a plan target is a path. Either reads
  // best relative to its repository.
  const [where, fragment] = record.target.split("#");
  const relative = path.isAbsolute(where) && where.startsWith(record.repoRoot + path.sep) ? path.relative(record.repoRoot, where) : where;
  return fragment ? `${relative} --run ${fragment}` : relative;
}

/** What the screen is about: its repository, and the intake or run it shows. */
export interface OperationScope {
  repoRoot?: string;
  /** The intake directory on screen; an approve-plan targets `<dir>#<run>` from whichever slice repository it runs in. */
  intakeDir?: string;
  runId?: string;
}

/** Whether `record` acts on what `scope` shows. */
export function relevantTo(
  record: Pick<OperationRecord, "repoRoot" | "cwd" | "target"> & { runId?: string },
  scope: OperationScope,
  same: (a: string, b: string) => boolean = (a, b) => path.resolve(a) === path.resolve(b),
): boolean {
  if (scope.repoRoot && (same(record.repoRoot, scope.repoRoot) || same(record.cwd, scope.repoRoot))) {
    return true;
  }
  if (scope.intakeDir && record.target && same(record.target.split("#")[0], scope.intakeDir)) {
    return true;
  }
  return scope.runId !== undefined && record.runId === scope.runId;
}

/**
 * The banner for the active operation among `records` (already narrowed to
 * the screen with {@link relevantTo}), or undefined when there is none. When
 * several are held — a reload restored one and this window started another —
 * the one this window can account for wins, then the newest.
 */
export function activeOperationView(records: readonly OperationRecord[]): ActiveOperationView | undefined {
  const mine = records;
  if (mine.length === 0) {
    return undefined;
  }
  const rank = (record: OperationRecord) => (operationLiveness(record) === "liveness_unknown" ? 1 : 0);
  const record = [...mine].sort((a, b) => rank(a) - rank(b) || b.submittedAtMs - a.submittedAtMs)[0];
  const liveness = operationLiveness(record);
  const target = displayTarget(record);
  const command = [record.subcommand, ...(target ? [target] : [])];
  const known = liveness !== "liveness_unknown";
  const meta = [record.provider, record.model].filter((part): part is string => Boolean(part));
  return {
    liveness,
    title: operationTitle(record),
    meta,
    ...(known ? { startedAtMs: record.submittedAtMs } : {}),
    command,
    activity: activityOf(record, liveness),
    ...(known
      ? {}
      : {
          note: record.restored
            ? "Previous operation status unknown after reload"
            : record.observationLost
              ? "Status unknown: its terminal is no longer observable"
              : "Status unknown: the shell has not reported the command as started",
        }),
    ...(record.terminalName ? { terminalName: record.terminalName } : {}),
  };
}

function activityOf(record: OperationRecord, liveness: OperationLiveness): string[] {
  const out: string[] = [];
  if (record.state !== "reserved") {
    out.push("Command recorded");
  }
  if (record.state === "submitted-shell" || record.state === "running-shell") {
    out.push(record.terminalName ? `Handed to the shell in ${record.terminalName}` : "Handed to the shell");
  }
  if (liveness === "running") {
    out.push(record.state === "running-shell" && !record.shellReportedStart ? "Engine process found running" : "Engine process running");
  }
  return out;
}

/** "working for 2m 13s", from the operation's start; undefined when liveness is unknown. */
export function workingFor(view: Pick<ActiveOperationView, "startedAtMs">, nowMs: number): string | undefined {
  return view.startedAtMs === undefined ? undefined : `working for ${formatElapsed(nowMs - view.startedAtMs)}`;
}

/** "prepare-plan succeeded at 19:14:32, after 4m 26s" — the last settled operation, never rendered as active. */
/**
 * The last operation, for the person: what happened in plain words and
 * when. The engine's own command line and exit code go in `technical`,
 * which is shown only under Technical details.
 */
export interface SettledOperationLine {
  liveness: OperationLiveness;
  text: string;
  technical?: string[];
}

export function settledOperationLine(record: SettledOperationRecord | undefined): SettledOperationLine | undefined {
  if (!record) {
    return undefined;
  }
  const liveness = settledLiveness(record);
  if (!liveness) {
    return undefined;
  }
  const at = new Date(record.endedAtMs);
  const clock = [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
  const took = formatElapsed(record.endedAtMs - record.submittedAtMs);
  const target = displayTarget(record);
  return {
    liveness,
    text: `${liveness === "succeeded" ? settledTitle(record) : `${operationTitle(record)} failed`} at ${clock}, after ${took}`,
    technical: [[record.subcommand, ...(target ? [target] : [])].join(" "), `exit code ${record.exitCode}`],
  };
}

/** What a finished operation did, in the past tense. */
function settledTitle(record: Pick<OperationRecord, "subcommand" | "label" | "stageId">): string {
  const stage = stageName(record);
  switch (record.subcommand) {
    case "prepare-plan":
      return "Updated intake prepared";
    case "approve-plan":
      return stage ? `${stage} approved` : "Plan stage approved";
    case "run-plan":
    case "resume-plan":
    case "run-loop":
    case "resume-loop":
      return stage ? `Run of ${stage} finished` : "Plan run finished";
    case "run-sparring":
      return stage ? `Review of ${stage} finished` : "Review finished";
    default:
      return "Agent Sparring command finished";
  }
}
