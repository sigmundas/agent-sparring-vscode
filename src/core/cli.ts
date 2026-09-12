/**
 * Building `sparring` invocations and resolving the executable.
 *
 * Arguments are always returned as arrays for a shell-less spawn; nothing is
 * quoted or joined, so paths with spaces are safe on every platform.
 *
 * CLI surface used (cli.py at f7740e7):
 *   sparring [--sparring-dir DIR] run-plan    PLAN --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] resume-plan PLAN --repo-root ROOT --expected-branch BRANCH [--evidence TEXT]
 *
 * No dependency on the vscode API.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_EXECUTABLE = "sparring";

export interface PlanInvocation {
  planPath: string;
  repoRoot: string;
  expectedBranch: string;
  /** Passed as the global `--sparring-dir` when it is not `<repoRoot>/.sparring`. */
  sparringDir?: string;
}

export function buildRunPlanArgs(invocation: PlanInvocation): string[] {
  return [...globalArgs(invocation), "run-plan", invocation.planPath, ...loopArgs(invocation)];
}

export function buildResumePlanArgs(invocation: PlanInvocation & { evidence?: string }): string[] {
  const args = [...globalArgs(invocation), "resume-plan", invocation.planPath, ...loopArgs(invocation)];
  if (invocation.evidence && invocation.evidence.trim()) {
    args.push("--evidence", invocation.evidence.trim());
  }
  return args;
}

export interface LoopInvocation {
  stageId: string;
  repoRoot: string;
  expectedBranch: string;
  sparringDir?: string;
}

/** `sparring [--sparring-dir DIR] run-loop STAGE --repo-root ROOT --expected-branch BRANCH` (cli.py: run_loop). */
export function buildRunLoopArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "run-loop", invocation.stageId, ...loopArgs(invocation)];
}

function globalArgs(invocation: { repoRoot: string; sparringDir?: string }): string[] {
  if (!invocation.sparringDir) {
    return [];
  }
  const implicit = path.join(invocation.repoRoot, ".sparring");
  if (path.resolve(invocation.sparringDir) === path.resolve(implicit)) {
    return [];
  }
  return ["--sparring-dir", invocation.sparringDir];
}

function loopArgs(invocation: { repoRoot: string; expectedBranch: string }): string[] {
  return ["--repo-root", invocation.repoRoot, "--expected-branch", invocation.expectedBranch];
}

// ---------------------------------------------------------------------------
// executable resolution
// ---------------------------------------------------------------------------

export interface ResolveEnv {
  platform: NodeJS.Platform;
  PATH?: string;
  PATHEXT?: string;
  /** Base directory for a relative configured path (the workspace folder). */
  cwd?: string;
}

export type ResolvedExecutable = { ok: true; path: string } | { ok: false; error: string };

/**
 * Resolve the configured executable (or plain `sparring`) to an absolute
 * path without invoking a shell: an explicit path is checked directly; a
 * bare name is searched along PATH, honouring PATHEXT on Windows.
 */
export async function resolveExecutable(configured: string | undefined, env: ResolveEnv): Promise<ResolvedExecutable> {
  const name = (configured ?? "").trim() || DEFAULT_EXECUTABLE;
  const isWindows = env.platform === "win32";
  const hasSeparator = name.includes("/") || (isWindows && name.includes("\\"));

  if (hasSeparator || path.isAbsolute(name)) {
    const candidate = path.isAbsolute(name) ? name : path.resolve(env.cwd ?? process.cwd(), name);
    for (const variant of withExtensions(candidate, isWindows, env.PATHEXT)) {
      if (await isExecutableFile(variant, isWindows)) {
        return { ok: true, path: variant };
      }
    }
    return { ok: false, error: `configured executable not found or not executable: ${candidate}` };
  }

  const dirs = (env.PATH ?? "").split(isWindows ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const variant of withExtensions(path.join(dir, name), isWindows, env.PATHEXT)) {
      if (await isExecutableFile(variant, isWindows)) {
        return { ok: true, path: variant };
      }
    }
  }
  return {
    ok: false,
    error: `'${name}' was not found on PATH. Install agent-sparring (pip install -e <path>) or set agentSparring.executable.`,
  };
}

function withExtensions(candidate: string, isWindows: boolean, pathext: string | undefined): string[] {
  if (!isWindows) {
    return [candidate];
  }
  const exts = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = candidate.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return [candidate];
  }
  return [candidate, ...exts.map((ext) => candidate + ext)];
}

async function isExecutableFile(file: string, isWindows: boolean): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return false;
    }
    if (isWindows) {
      return true;
    }
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// git branch (for the required --expected-branch)
// ---------------------------------------------------------------------------

/**
 * Read the checked-out branch from `.git/HEAD` (following a worktree
 * `.git` file). Returns undefined when detached or unreadable; the caller
 * must then ask the user.
 */
export async function readGitBranch(repoRoot: string): Promise<string | undefined> {
  let gitDir = path.join(repoRoot, ".git");
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isFile()) {
      const pointer = (await fs.readFile(gitDir, "utf8")).trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) {
        return undefined;
      }
      gitDir = path.resolve(repoRoot, match[1].trim());
    }
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : undefined;
  } catch {
    return undefined;
  }
}
