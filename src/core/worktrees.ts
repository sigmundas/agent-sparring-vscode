/**
 * Git worktrees as `git worktree list --porcelain` reports them, and which of
 * them are worth probing for Agent Sparring state that this window would not
 * otherwise find.
 *
 * An agent run may create its own worktree. A person should not have to know
 * where it went, add it to the workspace, open a file there and ask the
 * cockpit to follow it before they can see the run: every worktree of every
 * repository this window knows is a place a run may live.
 *
 * Read-only and authoritative only about *where* to look. Nothing here says
 * anything about a run; discovery reads the engine's own files there exactly
 * as it does inside the workspace.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import { canonicalPath, isInsidePath, samePath } from "./discovery";
import type { IsolatedRun } from "./engineFormats";

export interface GitWorktree {
  /** Absolute worktree path, as git printed it. */
  path: string;
  /** Checked-out commit; absent for a bare repository. */
  head?: string;
  /** Short branch name (`refs/heads/` removed); absent when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  /** Present (possibly empty) when git reports the worktree locked. */
  locked?: string;
  /** Present (possibly empty) when git reports the worktree prunable: its directory is gone. */
  prunable?: string;
}

/**
 * Parse `git worktree list --porcelain` output: blank-line separated records
 * whose first line is `worktree <path>`. Unknown attributes are ignored, so a
 * newer git adding one does not lose the worktree.
 */
export function parseWorktreeList(output: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") {
      current = undefined;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      current = { path: value, bare: false, detached: false };
      out.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "locked":
        current.locked = value;
        break;
      case "prunable":
        current.prunable = value;
        break;
    }
  }
  return out.filter((worktree) => worktree.path !== "");
}

/** A worktree this window should probe for a `.sparring` directly at its root. */
export interface ExternalWorktree {
  /** Absolute worktree path. */
  path: string;
  /** The repository root git was asked about: what this worktree is a sibling of. */
  siblingOf: string;
  branch?: string;
}

/**
 * Worktrees of the known repositories that discovery would not reach on its
 * own: not bare, not prunable (their directory is gone), not already a
 * discovered project, and not inside any workspace folder (those are the
 * workspace scan's to find, at whatever depth it is configured to look).
 * Each path is returned once even when several known roots list it.
 */
export function externalWorktrees(
  lists: readonly { repoRoot: string; worktrees: readonly GitWorktree[] }[],
  workspaceFolders: readonly string[],
  discoveredProjects: readonly string[],
): ExternalWorktree[] {
  const out: ExternalWorktree[] = [];
  for (const list of lists) {
    for (const worktree of list.worktrees) {
      if (worktree.bare || worktree.prunable !== undefined || !path.isAbsolute(worktree.path)) {
        continue;
      }
      if (workspaceFolders.some((folder) => samePath(worktree.path, folder) || isInsidePath(worktree.path, folder))) {
        continue;
      }
      if (discoveredProjects.some((project) => samePath(project, worktree.path))) {
        continue;
      }
      if (out.some((seen) => samePath(seen.path, worktree.path))) {
        continue;
      }
      out.push({ path: worktree.path, siblingOf: list.repoRoot, ...(worktree.branch ? { branch: worktree.branch } : {}) });
    }
  }
  return out;
}

/**
 * Repository families from worktree lists: every worktree path maps to its
 * repository's main worktree (the first one git lists), so two worktrees of
 * one repository compare equal. A root no list mentions is its own family.
 */
export function familyResolver(lists: readonly { repoRoot: string; worktrees: readonly GitWorktree[] }[]): (root: string) => string {
  const families = new Map<string, string>();
  for (const list of lists) {
    const main = list.worktrees[0]?.path ?? list.repoRoot;
    families.set(canonicalPath(list.repoRoot), main);
    for (const worktree of list.worktrees) {
      families.set(canonicalPath(worktree.path), main);
    }
  }
  return (root: string) => families.get(canonicalPath(root)) ?? root;
}

/** What `sparring runs --json` reported for one known repository root. */
export interface IsolatedRunsOfRepository {
  /** The root the engine was asked about. */
  repoRoot: string;
  runs: readonly IsolatedRun[];
}

/**
 * The worktrees the engine's records name, as worktree lists that
 * {@link externalWorktrees} takes alongside git's: a run's worktree is a
 * place to look even when git's answer is stale or was not asked. Only
 * worktrees the record says exist; a removed one is nothing to probe.
 */
export function isolatedWorktreeLists(reports: readonly IsolatedRunsOfRepository[]): { repoRoot: string; worktrees: GitWorktree[] }[] {
  return reports.map((report) => ({
    repoRoot: report.repoRoot,
    worktrees: report.runs
      .filter((run) => run.worktreeExists)
      .map((run) => ({ path: run.worktreePath, branch: run.branch, bare: false, detached: false })),
  }));
}

/**
 * The engine's record of the run `runKey` whose worktree holds `projectDir`,
 * with the root it was reported for — or undefined. The association is the
 * record's and nothing else's: a worktree that merely looks like a run's (its
 * name, its branch, its being listed by git) is never one.
 */
export function isolatedRunAt(reports: readonly IsolatedRunsOfRepository[], runKey: string, projectDir: string): { run: IsolatedRun; repoRoot: string } | undefined {
  for (const report of reports) {
    const run = report.runs.find((candidate) => candidate.runKey === runKey && (samePath(candidate.worktreePath, projectDir) || isInsidePath(projectDir, candidate.worktreePath)));
    if (run) {
      return { run, repoRoot: report.repoRoot };
    }
  }
  return undefined;
}
