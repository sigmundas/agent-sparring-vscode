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
  repositories: { rootUri: vscode.Uri; state: { HEAD?: { name?: string; commit?: string } } }[];
}

interface GitRepositoryView extends GitRepositoryInfo {
  head?: string;
}

function gitRepositories(): GitRepositoryView[] | undefined {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension?.isActive) {
    return undefined;
  }
  try {
    return extension.exports.getAPI(1).repositories.map((repo) => ({ rootPath: repo.rootUri.fsPath, branch: repo.state.HEAD?.name, head: repo.state.HEAD?.commit }));
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
