/**
 * Making the feature branch a new plan run names exist, before the engine
 * is asked to start it.
 *
 * `start-plan` and `run-plan` never create a branch: they require the
 * repository to already be on `--expected-branch`, and refuse otherwise.
 * Typing a new branch name into Run Plan therefore used to end in that
 * refusal and a manual `git switch -c`. This module does that step, and
 * only that step, for a fresh run:
 *
 *  - already checked out → nothing to do;
 *  - a local branch of that name exists → nothing to do either. It is used
 *    exactly as before, and the engine's own check decides; it is never
 *    moved, reset or checked out from here;
 *  - only a remote-tracking branch exists → a local branch tracking it is
 *    created and checked out (`git switch -c <b> --track <remote>/<b>`),
 *    rather than an unrelated branch at this commit;
 *  - nothing exists → it is created at the current commit and checked out
 *    (`git switch -c <b>`), which leaves the worktree exactly as it is.
 *
 * Every write is a plain `switch -c`, which git refuses when the branch
 * already exists, so a branch that appeared between inspection and
 * creation is refused rather than overwritten. Nothing is fetched, forced,
 * reset or deleted. The engine's expected-branch check is untouched and
 * still runs afterwards.
 */

import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git -C <repoRoot> …args`; injectable so the decision is testable. */
export type GitRunner = (repoRoot: string, args: string[]) => Promise<GitResult>;

export const runGit: GitRunner = (repoRoot, args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoRoot, ...args],
      { encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        // A non-numeric code means git did not run (missing, timed out).
        const code = !error ? 0 : typeof error.code === "number" ? error.code : -1;
        resolve({ code, stdout, stderr: stderr || (code === -1 && error ? error.message : "") });
      },
    );
  });

/** Where a new branch would start: the checked-out branch (if any) and its commit. */
export interface BranchOrigin {
  branch?: string;
  commit: string;
}

export type FeatureBranchPlan =
  /** The repository is already on it. */
  | { kind: "checked-out"; branch: string }
  /** A local branch exists and is not checked out; it is left exactly as it is. */
  | { kind: "existing"; branch: string }
  /** Create it at the current commit and check it out. */
  | { kind: "create"; branch: string; from: BranchOrigin }
  /** Create a local branch tracking `remoteRef` (e.g. `origin/feature/x`) and check it out. */
  | { kind: "track"; branch: string; remoteRef: string; commit: string; from: BranchOrigin }
  /** Nothing can be done safely; `reason` says why, for the person. */
  | { kind: "refuse"; branch: string; reason: string };

function detail(result: GitResult): string {
  return (result.stderr || result.stdout).trim() || `git exited with ${result.code}`;
}

/** `show-ref --verify --quiet`: 0 exists, 1 missing, anything else is an error. */
async function refExists(git: GitRunner, repoRoot: string, ref: string): Promise<boolean | GitResult> {
  const result = await git(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
  if (result.code === 0) {
    return true;
  }
  return result.code === 1 ? false : result;
}

async function currentOrigin(git: GitRunner, repoRoot: string): Promise<BranchOrigin | GitResult> {
  const head = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code !== 0 || !head.stdout.trim()) {
    return head;
  }
  const symbolic = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return { commit: head.stdout.trim(), ...(symbolic.code === 0 && symbolic.stdout.trim() ? { branch: symbolic.stdout.trim() } : {}) };
}

function isOrigin(value: BranchOrigin | GitResult): value is BranchOrigin {
  return typeof (value as BranchOrigin).commit === "string";
}

/** Read-only: what would have to happen for `repoRoot` to be on `requested`. */
export async function inspectFeatureBranch(repoRoot: string, requested: string, git: GitRunner = runGit): Promise<FeatureBranchPlan> {
  const branch = requested.trim();
  const refuse = (reason: string): FeatureBranchPlan => ({ kind: "refuse", branch, reason });

  const format = await git(repoRoot, ["check-ref-format", "--branch", branch]);
  if (format.code !== 0 || branch.startsWith("-")) {
    return refuse(`"${branch}" is not a valid branch name.`);
  }
  const origin = await currentOrigin(git, repoRoot);
  if (!isOrigin(origin)) {
    return refuse(`the current commit of ${repoRoot} could not be read (${detail(origin)}). A repository with no commits has nothing to branch from.`);
  }
  if (origin.branch === branch) {
    return { kind: "checked-out", branch };
  }
  const local = await refExists(git, repoRoot, `refs/heads/${branch}`);
  if (typeof local !== "boolean") {
    return refuse(`git could not tell whether ${branch} exists (${detail(local)}).`);
  }
  if (local) {
    return { kind: "existing", branch };
  }

  const remotes = await git(repoRoot, ["remote"]);
  if (remotes.code !== 0) {
    return refuse(`git could not list the remotes (${detail(remotes)}).`);
  }
  const matches: string[] = [];
  for (const remote of remotes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const found = await refExists(git, repoRoot, `refs/remotes/${remote}/${branch}`);
    if (typeof found !== "boolean") {
      return refuse(`git could not tell whether ${remote}/${branch} exists (${detail(found)}).`);
    }
    if (found) {
      matches.push(`${remote}/${branch}`);
    }
  }
  if (matches.length > 1) {
    return refuse(`${branch} exists on more than one remote (${matches.join(", ")}), so which one to track is your choice. Create the local branch yourself, then run the plan again.`);
  }
  if (matches.length === 1) {
    const remoteRef = matches[0];
    const commit = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}^{commit}`]);
    if (commit.code !== 0 || !commit.stdout.trim()) {
      return refuse(`the commit of ${remoteRef} could not be read (${detail(commit)}).`);
    }
    return { kind: "track", branch, remoteRef, commit: commit.stdout.trim(), from: origin };
  }
  return { kind: "create", branch, from: origin };
}

/** `superseded`: the flow that asked for the branch ended before the write; nothing was changed. */
export type FeatureBranchOutcome = { ok: true } | { ok: false; reason: string; superseded?: true };

/**
 * Carry out a `create` or `track` plan. Re-checks that HEAD has not moved
 * since inspection, and — for `track`, which changes the checked-out files
 * — that the worktree is clean, so nothing local is carried onto another
 * commit. Both writes use `switch -c` without force: git refuses if the
 * branch exists by now, and nothing existing is ever moved.
 *
 * `stillCurrent` is asked once more right before `git switch`, after every
 * read: a flow closed or replaced meanwhile changes nothing.
 */
export async function applyFeatureBranch(
  repoRoot: string,
  plan: Extract<FeatureBranchPlan, { kind: "create" | "track" }>,
  git: GitRunner = runGit,
  stillCurrent: () => boolean = () => true,
): Promise<FeatureBranchOutcome> {
  const now = await currentOrigin(git, repoRoot);
  if (!isOrigin(now) || now.commit !== plan.from.commit || now.branch !== plan.from.branch) {
    return { ok: false, reason: "the repository's HEAD changed after it was inspected; nothing was created. Run the plan again." };
  }
  if (plan.kind === "track") {
    const status = await git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.code !== 0) {
      return { ok: false, reason: `git could not read the worktree status (${detail(status)}).` };
    }
    if (status.stdout.trim()) {
      return { ok: false, reason: `checking out ${plan.remoteRef} would carry uncommitted changes onto another commit. Commit or stash them first.` };
    }
  }
  if (!stillCurrent()) {
    return { ok: false, reason: "the flow that asked for this branch was closed or replaced; nothing was created.", superseded: true };
  }
  const args = plan.kind === "create" ? ["switch", "-c", plan.branch] : ["switch", "-c", plan.branch, "--track", plan.remoteRef];
  const result = await git(repoRoot, args);
  if (result.code !== 0) {
    return { ok: false, reason: `git ${args.join(" ")} failed: ${detail(result)}` };
  }
  return { ok: true };
}

/** Local branch names, most recently committed first; empty when git cannot say. */
export async function recentLocalBranches(repoRoot: string, git: GitRunner = runGit, count = 15): Promise<string[]> {
  const result = await git(repoRoot, ["for-each-ref", "--sort=-committerdate", `--count=${count}`, "--format=%(refname:short)", "refs/heads"]);
  return result.code === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}
