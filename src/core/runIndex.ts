/**
 * Which runs a person sees first, and in what order: the grouping shared by
 * the native Runs view and the run picker.
 *
 *   OPEN                 this repository's open runs — running, then needs
 *                        you, then paused/open — newest first within each
 *   RECENT               this repository's completed runs, newest first,
 *                        bounded; the rest behind "Show older runs…"
 *   OTHER REPOSITORIES   everything else, per repository, open runs first
 *
 * "This repository" is the one the window follows **and every worktree of
 * it**: a run an agent started in a worktree it created belongs here, not
 * among unrelated repositories, whether or not the worktree is open in the
 * workspace. Without a followed repository, everything is "this repository".
 *
 * A standalone stage a managed plan run claims is that plan's history, shown
 * in the plan's own timeline; it is listed here only when older runs are
 * shown.
 *
 * Ordering only. Which run the cockpit shows is decided by selectRun.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import { canonicalPath, type RunSnapshot } from "./discovery";
import type { PlanMembership } from "./planMembership";
import { summarizeRun, type RunPhase, type RunSummary } from "./runSummary";

/** How many completed runs RECENT shows before "Show older runs…". */
export const RECENT_LIMIT = 8;
/** How many completed runs each other repository shows before "Show older runs…". */
export const OTHER_RECENT_LIMIT = 3;

export interface RunIndexEntry {
  run: RunSnapshot;
  summary: RunSummary;
}

export interface RepositoryRuns {
  /** The repository family's display name (its main worktree's directory name). */
  name: string;
  /** Family key: see {@link RunIndexOptions.familyOf}. */
  key: string;
  entries: RunIndexEntry[];
}

export interface RunIndex {
  open: RunIndexEntry[];
  recent: RunIndexEntry[];
  other: RepositoryRuns[];
  /** How many runs are held back; zero when `showOlder` or nothing is. */
  hidden: number;
}

export interface RunIndexOptions {
  /** The repository root this window follows; undefined treats every run as this repository's. */
  followedRoot?: string;
  /**
   * The repository family a root belongs to: the same key for every worktree
   * of one repository (its main worktree's path, from `git worktree list`).
   * Defaults to the root itself, which makes each worktree its own family.
   */
  familyOf?: (root: string) => string;
  memberships?: ReadonlyMap<string, PlanMembership>;
  /** Show every run instead of the bounded recent history. */
  showOlder?: boolean;
  recentLimit?: number;
  otherRecentLimit?: number;
  /**
   * Runs listed whatever the bounds: the pinned run and the run on screen,
   * so the picker can mark and highlight them and the Runs view never hides
   * what the cockpit shows.
   */
  keepIds?: readonly string[];
}

const PHASE_ORDER: Record<RunPhase, number> = { running: 0, "needs-you": 1, paused: 2, open: 3, complete: 4 };

function byPhaseThenNewest(a: RunIndexEntry, b: RunIndexEntry): number {
  return PHASE_ORDER[a.summary.phase] - PHASE_ORDER[b.summary.phase] || b.summary.updatedAtMs - a.summary.updatedAtMs;
}

export function buildRunIndex(runs: readonly RunSnapshot[], options: RunIndexOptions = {}): RunIndex {
  const familyOf = (root: string): string => canonicalPath(options.familyOf ? options.familyOf(root) : root);
  const recentLimit = options.showOlder ? Infinity : (options.recentLimit ?? RECENT_LIMIT);
  const otherLimit = options.showOlder ? Infinity : (options.otherRecentLimit ?? OTHER_RECENT_LIMIT);
  const followed = options.followedRoot ? familyOf(options.followedRoot) : undefined;
  let hidden = 0;
  const keep = new Set(options.keepIds ?? []);
  // The first `limit` entries plus every kept one beyond them, in order.
  const bounded = (entries: RunIndexEntry[], limit: number): RunIndexEntry[] => entries.filter((entry, i) => i < limit || keep.has(entry.run.id));

  const listed: RunIndexEntry[] = [];
  for (const run of runs) {
    if (run.kind === "stage" && options.memberships?.has(run.id) && !options.showOlder && !keep.has(run.id)) {
      hidden += 1;
      continue;
    }
    listed.push({ run, summary: summarizeRun(run, options.memberships) });
  }

  const familyOfRun = (run: RunSnapshot): string => familyOf(run.location.external?.siblingOf ?? run.location.repoRoot);
  const here = followed === undefined ? listed : listed.filter((entry) => familyOfRun(entry.run) === followed);
  const elsewhere = followed === undefined ? [] : listed.filter((entry) => familyOfRun(entry.run) !== followed);

  const open = here.filter((entry) => entry.summary.open).sort(byPhaseThenNewest);
  const done = here.filter((entry) => !entry.summary.open).sort(byPhaseThenNewest);
  const recent = bounded(done, recentLimit);
  hidden += done.length - recent.length;

  const families = new Map<string, RunIndexEntry[]>();
  for (const entry of elsewhere) {
    const key = familyOfRun(entry.run);
    families.set(key, [...(families.get(key) ?? []), entry]);
  }
  const other: RepositoryRuns[] = [];
  for (const [key, entries] of families) {
    const sorted = entries.slice().sort(byPhaseThenNewest);
    const openHere = sorted.filter((entry) => entry.summary.open);
    const doneHere = sorted.filter((entry) => !entry.summary.open);
    const shown = [...openHere, ...bounded(doneHere, otherLimit)];
    hidden += sorted.length - shown.length;
    const display = options.familyOf ? options.familyOf(entries[0].run.location.external?.siblingOf ?? entries[0].run.location.repoRoot) : entries[0].run.location.repoRoot;
    other.push({ name: path.basename(display), key, entries: shown });
  }
  // Repositories with open work first, then the most recently active.
  other.sort(
    (a, b) =>
      Number(b.entries.some((entry) => entry.summary.open)) - Number(a.entries.some((entry) => entry.summary.open)) ||
      Math.max(...b.entries.map((entry) => entry.summary.updatedAtMs)) - Math.max(...a.entries.map((entry) => entry.summary.updatedAtMs)),
  );

  return { open, recent, other, hidden };
}
