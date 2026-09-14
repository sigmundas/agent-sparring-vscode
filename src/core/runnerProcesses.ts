/**
 * Answering "is a sparring runner alive for this project?" from a process
 * snapshot, for a run this window has no execution record of.
 *
 * Every other liveness source in this extension follows a process the
 * window itself watched start (executionTracker.ts). That leaves one real
 * gap: a run whose runner died while the window was not watching — its
 * terminal closed and the window later reloaded, or the loop was started
 * from outside VS Code entirely. Telemetry then holds an unmatched
 * `turn.started` for ever, and `unknown` was the only honest answer the
 * extension could give. It is a useless one: the plan is recorded at a
 * stage, nothing is running, and the Overview offered no way forward.
 *
 * The process table settles it. The engine's worktree lock means one
 * runner per project at a time, so the question is about the project, not
 * about one particular run id, and `--repo-root` / `--sparring-dir` (which
 * every launch from this extension passes absolutely) is what ties a
 * command line to a project.
 *
 * Three outcomes, kept apart on purpose — `unattributable` is not `none`:
 * a sparring runner that exists but cannot be tied to a project must never
 * be reported as "nothing is running", because acting on that would start a
 * second runner over a live one.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import type { SparringLocation } from "./discovery";
import type { ProcessInfo } from "./processTree";
import { parseSparringCommand } from "./sparringCommand";

export type RunnerProbe =
  /** A sparring runner for this project is in the process table. */
  | { kind: "alive"; process: ProcessInfo }
  /** No sparring runner process exists for this project, and none is unaccounted for. */
  | { kind: "none" }
  /** A sparring runner exists whose project cannot be established; nothing may be concluded. */
  | { kind: "unattributable"; process: ProcessInfo };

/**
 * Classify `processes` for one project. Only absolute `--repo-root` /
 * `--sparring-dir` values attribute a command line: `ps` reports no working
 * directory, so a relative path cannot be resolved and the process stays
 * unattributable rather than being assigned to a guess.
 */
export function probeRunnerProcesses(processes: ProcessInfo[], location: SparringLocation): RunnerProbe {
  let unattributable: ProcessInfo | undefined;
  for (const process of processes) {
    const parsed = parseSparringCommand(process.command);
    if (!parsed) {
      continue;
    }
    const repoRoot = absolute(parsed.repoRoot);
    const sparringDir = absolute(parsed.sparringDir);
    if ((sparringDir && same(sparringDir, location.sparringDir)) || (repoRoot && same(repoRoot, location.repoRoot))) {
      return { kind: "alive", process };
    }
    if (!repoRoot && !sparringDir) {
      unattributable ??= process;
      continue;
    }
    // Attributable, and to a different project: not ours, and not a reason
    // to withhold a conclusion about ours.
  }
  return unattributable ? { kind: "unattributable", process: unattributable } : { kind: "none" };
}

function absolute(value: string | undefined): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? path.resolve(value) : undefined;
}

function same(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
