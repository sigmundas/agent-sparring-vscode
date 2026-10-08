/**
 * `sparring runs --json` for each repository root this window knows: the
 * engine's own list of runs in their own workspaces, and the only source of
 * which worktree belongs to which run.
 *
 * Cached for as long as {@link WORKTREE_CACHE_MS}, the git worktree list's
 * own cadence, and dropped by the same explicit rediscovery. Read-only. A
 * root the engine cannot answer for (not a repository, an engine that
 * predates `runs`, an executable only the user's shell can resolve)
 * contributes no runs; a report in a schema this version does not read is
 * said once as an engine/extension mismatch and contributes none either.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { buildRunsArgs, planExecutable } from "../core/cli";
import { canonicalPath } from "../core/discovery";
import { EngineFormatError, ISOLATED_RUNS_SCHEMA_VERSION, parseIsolatedRuns, type IsolatedRun } from "../core/engineFormats";
import type { IsolatedRunsOfRepository } from "../core/worktrees";
import { hostEnv } from "./shellIntegration";
import { WORKTREE_CACHE_MS } from "./worktreeProbe";

/** How the engine is asked: injectable so tests read a stubbed report. */
export type RunsReader = (repoRoot: string) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>;

export class IsolatedRunsProbe {
  private readonly cache = new Map<string, { atMs: number; ok: boolean; runs: IsolatedRun[] }>();
  private readonly reported = new Set<string>();
  private readonly mismatchShown = new Set<string>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly read: RunsReader,
    /** Shows an engine/extension mismatch to the person (non-modal); called once per reported version per session. */
    private readonly showMismatch: (message: string) => void = () => undefined,
  ) {}

  /** Drop cached answers, so the next {@link list} asks the engine again. */
  invalidate(): void {
    this.cache.clear();
  }

  async list(repoRoots: readonly string[]): Promise<IsolatedRunsOfRepository[]> {
    const unique = new Map<string, string>();
    for (const root of repoRoots) {
      unique.set(canonicalPath(root), root);
    }
    return Promise.all([...unique.entries()].map(async ([key, root]) => ({ repoRoot: root, ...(await this.listOne(key, root)) })));
  }

  private async listOne(key: string, root: string): Promise<{ ok: boolean; runs: IsolatedRun[] }> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.atMs < WORKTREE_CACHE_MS) {
      return { ok: cached.ok, runs: cached.runs };
    }
    const answer = await this.ask(root);
    this.cache.set(key, { atMs: Date.now(), ...answer });
    return answer;
  }

  /** The engine's report; `ok: false` when it gave none this version reads (never "no runs"). */
  private async ask(root: string): Promise<{ ok: boolean; runs: IsolatedRun[] }> {
    const answer = await this.read(root);
    if (!answer.ok) {
      this.once(`${path.basename(root)}: ${answer.reason}`, `could not list the runs in their own workspaces of ${root}; those runs are found only if their worktree is (${answer.reason})`);
      return { ok: false, runs: [] };
    }
    try {
      const report = parseIsolatedRuns(answer.stdout);
      if (report.kind === "version-mismatch") {
        this.once(
          `${root}: schema ${String(report.version)}`,
          `engine/extension mismatch: sparring runs --json for ${root} reported schema_version ${JSON.stringify(report.version)}, and this extension reads only ${ISOLATED_RUNS_SCHEMA_VERSION}. Runs in their own workspaces are not associated with their worktrees until the two agree.`,
        );
        const shown = String(report.version);
        if (!this.mismatchShown.has(shown)) {
          this.mismatchShown.add(shown);
          this.showMismatch(
            `Agent Sparring: the engine and this extension do not match — the engine's list of runs uses a format (schema_version ${JSON.stringify(report.version)}) this extension does not read. Runs in their own workspaces are not followed until the two are updated to match.`,
          );
        }
        return { ok: false, runs: [] };
      }
      // Stamped on receipt: "Ready to merge" is shown only while this answer is fresh.
      const atMs = Date.now();
      for (const run of report.runs) {
        if (run.finishProblem) {
          this.once(`${root}: ${run.runKey}: ${run.finishProblem}`, `sparring runs --json for ${root}, run ${run.runKey}: ${run.finishProblem}. Ready to merge is not shown for it.`);
        }
      }
      return { ok: true, runs: report.runs.map((run) => (run.finish ? { ...run, finishCheckedAtMs: atMs } : run)) };
    } catch (error) {
      const reason = error instanceof EngineFormatError ? error.message : String(error);
      this.once(`${root}: ${reason}`, `sparring runs --json for ${root} could not be read: ${reason}`);
      return { ok: false, runs: [] };
    }
  }

  private once(key: string, message: string): void {
    if (!this.reported.has(key)) {
      this.reported.add(key);
      this.log(message);
    }
  }
}

/**
 * The production reader: the configured engine, spawned without a shell.
 * An executable only the user's shell can resolve cannot be asked here; that
 * is "no answer", never "no runs" said with authority.
 */
export function engineRunsReader(configured: () => string): RunsReader {
  return async (repoRoot) => {
    // As a direct launch resolves it: the configured path, or a bare name
    // along this host's PATH. Only the terminal's shell PATH is out of reach.
    const planned = await planExecutable(configured(), hostEnv(repoRoot), false);
    if (!planned.ok || planned.plan.kind === "shell") {
      return { ok: false, reason: planned.ok ? "the sparring executable is resolved only by the shell" : planned.error };
    }
    const file = planned.plan.path;
    return new Promise((resolve) => {
      execFile(file, buildRunsArgs(repoRoot), { cwd: repoRoot, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, reason: String(stderr || error.message).trim().split("\n")[0] });
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  };
}

/**
 * Run a read-only engine query (`finish-run … --dry-run --json`) without a
 * terminal and return its exit code and stdout. A non-zero exit is an
 * answer too (`3`: refused by its checks); only a command that could not
 * run at all, or the shell-only executable, is no answer.
 */
export async function engineReadOnlyQuery(configured: string, args: string[], cwd: string): Promise<{ ok: true; exitCode: number; stdout: string } | { ok: false; reason: string }> {
  const planned = await planExecutable(configured, hostEnv(cwd), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return { ok: false, reason: "the sparring executable is resolved only by the shell; set agentSparring.executable to its full path" };
  }
  const file = planned.plan.path;
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, exitCode: 0, stdout });
        return;
      }
      if (typeof error.code === "number") {
        resolve({ ok: true, exitCode: error.code, stdout: stdout || String(stderr) });
        return;
      }
      resolve({ ok: false, reason: String(stderr || error.message).trim().split("\n")[0] });
    });
  });
}
