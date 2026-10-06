/**
 * `git worktree list --porcelain` for each repository root this window knows,
 * cached briefly because discovery refreshes often and the answer changes
 * only when a worktree is added or removed.
 *
 * Read-only: this never creates, moves or prunes a worktree. A root git
 * refuses (not a repository, git missing, timed out) simply contributes no
 * worktrees; it is logged once per distinct failure, not on every refresh.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { canonicalPath } from "../core/discovery";
import { parseWorktreeList, type GitWorktree } from "../core/worktrees";

/** How long one root's answer is reused. Explicit refresh bypasses it. */
export const WORKTREE_CACHE_MS = 15_000;

export class WorktreeProbe {
  private readonly cache = new Map<string, { atMs: number; worktrees: GitWorktree[] }>();
  private readonly reported = new Set<string>();

  constructor(private readonly log: (message: string) => void) {}

  /** Drop cached answers, so the next {@link list} asks git again. */
  invalidate(): void {
    this.cache.clear();
  }

  async list(repoRoots: readonly string[]): Promise<{ repoRoot: string; worktrees: GitWorktree[] }[]> {
    const unique = new Map<string, string>();
    for (const root of repoRoots) {
      unique.set(canonicalPath(root), root);
    }
    return Promise.all([...unique.entries()].map(async ([key, root]) => ({ repoRoot: root, worktrees: await this.listOne(key, root) })));
  }

  private async listOne(key: string, root: string): Promise<GitWorktree[]> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.atMs < WORKTREE_CACHE_MS) {
      return cached.worktrees;
    }
    const worktrees = await new Promise<GitWorktree[]>((resolve) => {
      execFile("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          const reason = `${path.basename(root)}: ${String(stderr || error.message).trim().split("\n")[0]}`;
          if (!this.reported.has(reason)) {
            this.reported.add(reason);
            this.log(`could not list git worktrees of ${root}; runs in its other worktrees are not discovered (${reason})`);
          }
          resolve([]);
          return;
        }
        resolve(parseWorktreeList(stdout));
      });
    });
    this.cache.set(key, { atMs: Date.now(), worktrees });
    return worktrees;
  }
}
