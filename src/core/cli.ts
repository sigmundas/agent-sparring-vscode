/**
 * Building `sparring` invocations and resolving the executable.
 *
 * Arguments are always returned as arrays for a shell-less spawn; nothing is
 * quoted or joined, so paths with spaces are safe on every platform.
 *
 * CLI surface used (cli.py at f7740e7):
 *   sparring [--sparring-dir DIR] run-plan    PLAN --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] resume-plan PLAN --repo-root ROOT --expected-branch BRANCH [--evidence TEXT]
 *   sparring [--sparring-dir DIR] run-loop    STAGE --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] freeze-candidate STAGE --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] accept-candidate STAGE --repo-root ROOT --expected-branch BRANCH
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

/** `sparring [--sparring-dir DIR] freeze-candidate STAGE --repo-root ROOT --expected-branch BRANCH` (cli.py: freeze_candidate). */
export function buildFreezeCandidateArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "freeze-candidate", invocation.stageId, ...loopArgs(invocation)];
}

/** `sparring [--sparring-dir DIR] accept-candidate STAGE --repo-root ROOT --expected-branch BRANCH` (cli.py: accept_candidate). */
export function buildAcceptCandidateArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "accept-candidate", invocation.stageId, ...loopArgs(invocation)];
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

/**
 * What to hand the terminal:
 *  - `configured`: the user set `agentSparring.executable`; the path was
 *    checked here and is used exactly;
 *  - `shell`: nothing configured; the bare command word is passed to the
 *    user's own integrated shell, which resolves it with its normal PATH
 *    and environment (the extension host's PATH is not consulted, because
 *    it routinely lacks what a login shell has);
 *  - `resolved`: nothing configured and no shell available to do the
 *    resolving, so the bare name was found along the extension host's PATH
 *    as a best effort.
 */
export type ExecutablePlan = { kind: "configured"; path: string } | { kind: "shell"; command: string } | { kind: "resolved"; path: string };

/** Why an executable could not be planned; the message is user-facing. */
export type ExecutableProblem = "configured-invalid" | "unresolvable";

export type ResolvedExecutable = { ok: true; plan: ExecutablePlan } | { ok: false; problem: ExecutableProblem; error: string };

export const UNRESOLVABLE_MESSAGE = "Agent Sparring could not resolve the CLI from this VS Code environment. Set agentSparring.executable to the full path.";

/**
 * Decide how `sparring` will be invoked. `shellAvailable` says whether the
 * command will run through the user's integrated shell (terminal shell
 * integration); when it will, a bare `sparring` is never pre-rejected here,
 * because only that shell knows its PATH. A configured path is validated
 * regardless; without a shell, the bare name falls back to a PATH search
 * in this process and, failing that, an honest configuration message
 * (never a suggestion to reinstall the engine).
 */
export async function planExecutable(configured: string | undefined, env: ResolveEnv, shellAvailable: boolean): Promise<ResolvedExecutable> {
  const name = (configured ?? "").trim();
  const isWindows = env.platform === "win32";
  if (name) {
    const hasSeparator = name.includes("/") || (isWindows && name.includes("\\"));
    const candidate = path.isAbsolute(name) ? name : hasSeparator ? path.resolve(env.cwd ?? process.cwd(), name) : undefined;
    if (candidate === undefined) {
      // A bare name was configured: treat it like the default command word.
      return planBare(name, env, shellAvailable);
    }
    for (const variant of withExtensions(candidate, isWindows, env.PATHEXT)) {
      if (await isExecutableFile(variant, isWindows)) {
        return { ok: true, plan: { kind: "configured", path: variant } };
      }
    }
    return { ok: false, problem: "configured-invalid", error: `agentSparring.executable points at ${candidate}, which does not exist or is not executable.` };
  }
  return planBare(DEFAULT_EXECUTABLE, env, shellAvailable);
}

async function planBare(command: string, env: ResolveEnv, shellAvailable: boolean): Promise<ResolvedExecutable> {
  if (shellAvailable) {
    return { ok: true, plan: { kind: "shell", command } };
  }
  const found = await searchPath(command, env);
  if (found) {
    return { ok: true, plan: { kind: "resolved", path: found } };
  }
  return { ok: false, problem: "unresolvable", error: UNRESOLVABLE_MESSAGE };
}

/** The first executable named `command` along `env.PATH`, honouring PATHEXT on Windows; undefined when none. */
export async function searchPath(command: string, env: ResolveEnv): Promise<string | undefined> {
  const isWindows = env.platform === "win32";
  const dirs = (env.PATH ?? "").split(isWindows ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const variant of withExtensions(path.join(dir, command), isWindows, env.PATHEXT)) {
      if (await isExecutableFile(variant, isWindows)) {
        return variant;
      }
    }
  }
  return undefined;
}

/** The word or path the terminal is given for a plan. */
export function executableWord(plan: ExecutablePlan): string {
  return plan.kind === "shell" ? plan.command : plan.path;
}

/**
 * Whether an exit code means the shell could not find the command: 127 on
 * POSIX shells, 9009 from cmd.exe. PowerShell reports 1 for an unknown
 * command, which is indistinguishable from an ordinary failure, so it is
 * not claimed here.
 */
export function isCommandNotFoundExit(exitCode: number | undefined, platform: NodeJS.Platform): boolean {
  if (exitCode === undefined) {
    return false;
  }
  return exitCode === 127 || (platform === "win32" && exitCode === 9009);
}

/** The message shown when the user's shell itself reported the command missing. */
export function commandNotFoundMessage(word: string): string {
  return `Your shell could not find '${word}'. Set agentSparring.executable to the full path of the sparring CLI, or make it available on your shell's PATH.`;
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
