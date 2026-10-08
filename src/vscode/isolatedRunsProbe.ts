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
  private readonly cache = new Map<string, { atMs: number; runs: IsolatedRun[] }>();
  private readonly reported = new Set<string>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly read: RunsReader,
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
    return Promise.all([...unique.entries()].map(async ([key, root]) => ({ repoRoot: root, runs: await this.listOne(key, root) })));
  }

  private async listOne(key: string, root: string): Promise<IsolatedRun[]> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.atMs < WORKTREE_CACHE_MS) {
      return cached.runs;
    }
    const runs = await this.ask(root);
    this.cache.set(key, { atMs: Date.now(), runs });
    return runs;
  }

  private async ask(root: string): Promise<IsolatedRun[]> {
    const answer = await this.read(root);
    if (!answer.ok) {
      this.once(`${path.basename(root)}: ${answer.reason}`, `could not list the runs in their own workspaces of ${root}; those runs are found only if their worktree is (${answer.reason})`);
      return [];
    }
    try {
      const report = parseIsolatedRuns(answer.stdout);
      if (report.kind === "version-mismatch") {
        this.once(
          `${root}: schema ${String(report.version)}`,
          `engine/extension mismatch: sparring runs --json for ${root} reported schema_version ${JSON.stringify(report.version)}, and this extension reads only ${ISOLATED_RUNS_SCHEMA_VERSION}. Runs in their own workspaces are not associated with their worktrees until the two agree.`,
        );
        return [];
      }
      return report.runs;
    } catch (error) {
      const reason = error instanceof EngineFormatError ? error.message : String(error);
      this.once(`${root}: ${reason}`, `sparring runs --json for ${root} could not be read: ${reason}`);
      return [];
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
    const planned = await planExecutable(configured(), hostEnv(repoRoot), false);
    if (!planned.ok || planned.plan.kind === "shell") {
      return { ok: false, reason: "the sparring executable is resolved only by the shell" };
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
