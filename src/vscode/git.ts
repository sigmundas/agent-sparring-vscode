/**
 * Read-only view of the repository owning a project: the built-in Git
 * extension's API first (vscode.git, API version 1), `.git/HEAD` as the
 * fallback when that extension is unavailable or has not opened the
 * repository. Nothing here runs git or guesses.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { readGitBranch } from "../core/cli";
import { isInsidePath } from "../core/discovery";
import { pickBranch, type GitRepositoryInfo } from "../core/runner";

interface GitApi {
  repositories: {
    rootUri: vscode.Uri;
    state: { HEAD?: { name?: string; commit?: string }; workingTreeChanges?: unknown[]; indexChanges?: unknown[]; mergeChanges?: unknown[] };
  }[];
}

interface GitRepositoryView extends GitRepositoryInfo {
  head?: string;
  /** Working-tree, staged and merge changes together; the freeze gate refuses any of them. */
  changes: number;
}

function gitRepositories(): GitRepositoryView[] | undefined {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension?.isActive) {
    return undefined;
  }
  try {
    return extension.exports.getAPI(1).repositories.map((repo) => ({
      rootPath: repo.rootUri.fsPath,
      branch: repo.state.HEAD?.name,
      head: repo.state.HEAD?.commit,
      changes: (repo.state.workingTreeChanges?.length ?? 0) + (repo.state.indexChanges?.length ?? 0) + (repo.state.mergeChanges?.length ?? 0),
    }));
  } catch {
    return undefined;
  }
}

function owns(repo: GitRepositoryInfo, repoRoot: string): boolean {
  return isInsidePath(repoRoot, repo.rootPath) || path.resolve(repo.rootPath) === path.resolve(repoRoot);
}

/**
 * The current branch of the repository owning `repoRoot`. Detached HEAD
 * (or no repository) → undefined; callers refuse rather than guess.
 */
export async function currentBranch(repoRoot: string): Promise<string | undefined> {
  const repos = gitRepositories();
  if (repos) {
    const fromApi = pickBranch(repoRoot, repos);
    if (fromApi) {
      return fromApi;
    }
    if (repos.some((repo) => owns(repo, repoRoot))) {
      return undefined; // the extension knows the repository and says it is detached
    }
  }
  return readGitBranch(repoRoot);
}

/**
 * How many changes the Git extension sees in the worktree owning
 * `repoRoot`, or `undefined` when it does not know the repository.
 *
 * `undefined` is not "clean": the extension may be inactive, or the
 * repository may not be open. Callers must make no claim in that case —
 * saying a worktree is clean when nothing was read would be worse than
 * saying nothing, because the engine's own freeze is the real check.
 */
export function pendingChanges(repoRoot: string): number | undefined {
  const owner = gitRepositories()
    ?.filter((repo) => owns(repo, repoRoot))
    .sort((a, b) => path.resolve(b.rootPath).length - path.resolve(a.rootPath).length)[0];
  return owner?.changes;
}

/**
 * Repositories this window can see, for picking a stage's sibling: the ones
 * the built-in Git extension has opened, plus any workspace folder that is
 * a repository root the extension has not reported (a folder opened before
 * the extension activated, a nested checkout). Each is returned with its
 * checked-out branch when that is known, so the picker can prefill it rather
 * than ask the user to remember.
 *
 * Read-only, and no repository is opened or scanned for: a sibling that is
 * not in the workspace is chosen through the folder dialog instead.
 */
export async function knownRepositories(): Promise<{ rootPath: string; branch?: string }[]> {
  const out = new Map<string, { rootPath: string; branch?: string }>();
  for (const repo of gitRepositories() ?? []) {
    out.set(path.resolve(repo.rootPath), { rootPath: repo.rootPath, branch: repo.branch?.trim() || undefined });
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    if (out.has(path.resolve(root))) {
      continue;
    }
    const branch = await readGitBranch(root);
    if (branch) {
      out.set(path.resolve(root), { rootPath: root, branch });
    }
  }
  return [...out.values()].sort((a, b) => path.basename(a.rootPath).localeCompare(path.basename(b.rootPath)));
}

/** Branch and HEAD commit for display; either may be unknown. */
export async function gitContext(repoRoot: string): Promise<{ branch?: string; head?: string } | undefined> {
  const repos = gitRepositories();
  const owner = repos
    ?.filter((repo) => owns(repo, repoRoot))
    .sort((a, b) => path.resolve(b.rootPath).length - path.resolve(a.rootPath).length)[0];
  if (owner) {
    return { branch: owner.branch?.trim() || undefined, head: owner.head };
  }
  const branch = await readGitBranch(repoRoot);
  return branch ? { branch } : undefined;
}
