/**
 * Which repositories "Run plan…" may target, and which one the file you are
 * looking at belongs to.
 *
 * ### Why this is not the same question as discovery
 *
 * `locateAll` (discovery.ts) answers "where has Agent Sparring already run?" —
 * it finds `.sparring` directories. That is the right universe for the
 * cockpit, and the wrong one for *starting* a plan: the moment a repository
 * most needs to be offered is before it has any Agent Sparring state at all.
 *
 * Using discovery for both produced a reported failure with a real shape. A
 * container folder held a stray `.sparring` and a dozen checkouts:
 *
 * ```
 *   sporely/                       .sparring (no plans, no stages), not a git repository
 *     sporely-py/                  a git repository — no .sparring
 *     sporely-py-reported-statistics/   a git worktree — .sparring
 *     sporely-py-ui-cleanup/            a git worktree — .sparring
 * ```
 *
 * With a file open in `sporely/sporely-py/`, the only candidate containing it
 * was the container, so Run plan… silently targeted `sporely` — a directory
 * that is not a repository — and `sporely-py`, the actual repository, was
 * never offered. Deepest-first matching cannot fix that, because the
 * repository was not in the list to begin with.
 *
 * So the universe here is the **union**: every project Agent Sparring has
 * state in, plus every repository and worktree the built-in Git extension has
 * open ({@link launchRepositories}). A repository with no `.sparring` is a
 * first-class candidate — the engine creates what it needs under
 * `--sparring-dir` on its first write — and is marked as such so the picker
 * can say so rather than implying a history it does not have.
 *
 * ### Deepest root wins
 *
 * Repository roots nest: a worktree checked out inside its parent, a
 * repository inside a container folder, a package inside a monorepo. A file
 * inside `sporely/sporely-py/` is inside `sporely/` too, so containment alone
 * is ambiguous and the *most specific* root is the answer
 * ({@link repositoryForFile}). Depth is counted in path segments, not string
 * length, so `/code/a/b` is correctly deeper than `/code/aaaaaaaaaa`.
 *
 * Nothing here reads a branch name. Two checkouts of one repository are told
 * apart by their roots and by nothing else; a branch is what a repository is
 * *on*, never what it *is*.
 *
 * No dependency on the vscode API.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SPARRING_DIRNAME, isInsidePath, samePath, type RunSnapshot, type SparringLocation } from "./discovery";

/** A workspace folder, reduced to what a synthesised location needs. */
export interface WorkspaceFolderRef {
  path: string;
  name?: string;
}

/** One repository "Run plan…" may target. */
export interface LaunchRepository {
  /**
   * How the engine is addressed for it. For a discovered project this is the
   * location itself; for a repository with no Agent Sparring state it is
   * synthesised from the repository root, with `.sparring` named where the
   * engine would create it.
   */
  location: SparringLocation;
  /**
   * Whether Agent Sparring has state here already. `false` means the
   * `.sparring` directory in {@link location} does not exist yet and this
   * would be the repository's first plan run.
   */
  established: boolean;
  /**
   * Whether the engine can actually run a plan here, which is a statement
   * about the resolved **execution repository** (`location.repoRoot`) and not
   * about `.sparring`. See {@link launchable}.
   */
  launchable: boolean;
  /** Why not, in the user's terms; present only when {@link launchable} is false. */
  blocked?: string;
}

/**
 * Every repository a plan may be started in: Agent Sparring's own discovered
 * projects first, then every repository or worktree the Git extension has open
 * that is not already one of them.
 *
 * `gitRoots` is `undefined` when the Git extension has told us nothing — it is
 * not installed, not active yet, or offers no API version 1 — which is
 * different from an active extension with no repository open (an empty array).
 * In that case the discovered projects are all there is, and a repository with
 * no `.sparring` cannot be known about; the caller degrades to what it can
 * prove rather than scanning for `.git` itself.
 *
 * A git root is treated as already covered when a discovered location names it
 * as either its repository root or its project directory, so a worktree that
 * *does* have `.sparring` appears exactly once — as an established project,
 * keeping the spelling and the folder name discovery gave it.
 */
export async function launchRepositories(
  locations: readonly SparringLocation[],
  gitRoots: readonly string[] | undefined,
  folders: readonly WorkspaceFolderRef[] = [],
  isWorkTree: GitWorkTreeProbe = gitWorkTreeOnDisk,
): Promise<LaunchRepository[]> {
  const candidates: { location: SparringLocation; established: boolean }[] = locations.map((location) => ({ location, established: true }));
  for (const root of gitRoots ?? []) {
    const covered = candidates.some((candidate) => samePath(candidate.location.repoRoot, root) || samePath(candidate.location.projectDir, root));
    if (!covered) {
      candidates.push({ location: locationForRepository(root, folders), established: false });
    }
  }
  return Promise.all(
    candidates.map(async (candidate) => {
      const verdict = await launchable(candidate.location, gitRoots, isWorkTree);
      return { ...candidate, ...verdict };
    }),
  );
}

/**
 * Whether the engine can run a plan whose execution root is `dir`: is it
 * inside a git work tree?
 *
 * Supplied as a function so the check can be driven in a test, and defaulted
 * to {@link gitWorkTreeOnDisk}.
 */
export type GitWorkTreeProbe = (dir: string) => Promise<boolean>;

/**
 * Whether a candidate is a **launch target**, and why not when it is not.
 *
 * The question is about the resolved execution repository — `repoRoot`, which
 * `resolveRepoRoot` already takes from `[repo] root` in `project.toml` when
 * one is set — and deliberately not about `.sparring`. The two come apart in
 * both directions, and both directions were wrong before:
 *
 *  - a directory with a `.sparring` in it need not be a repository at all. The
 *    real `/Users/…/Code/sporely` holds `.sparring/handoffs` and
 *    `.sparring/prompts` from an earlier way of working, and is not a git
 *    repository — nor is anything above it. The engine cannot run a plan
 *    there: `ensure_branch_for_unattended_run` calls `current_branch`, which
 *    runs `git -C <repo_root> symbolic-ref --quiet --short HEAD` and fails,
 *    so the stage-agent run refuses. Offering it as a target was offering
 *    something that could only fail, and — because it is the *container* of a
 *    dozen real checkouts — it was the candidate that won on containment.
 *  - a git repository with no `.sparring` is a perfectly good target, and the
 *    most important one: the first plan run in a repository is exactly when
 *    there is nothing there yet, and the engine creates what it needs under
 *    `--sparring-dir` on its first write.
 *  - a project whose `project.toml` points `[repo] root` at a separate, valid
 *    git repository is launchable on the strength of *that* root, whatever the
 *    directory holding `.sparring` happens to be.
 *
 * Two sources answer it, and either suffices: a root the Git extension has
 * open at or above `repoRoot`, and `.git` present at or above it on disk. The
 * second is what covers a repository the extension has not opened (or has not
 * finished finding — see core/gitReadiness.ts), and it is the same thing git
 * itself looks for rather than a guess: `git -C` walks up for `.git`, and a
 * linked worktree's `.git` is a file rather than a directory, so existence
 * and not directory-ness is the test.
 */
async function launchable(
  location: SparringLocation,
  gitRoots: readonly string[] | undefined,
  isWorkTree: GitWorkTreeProbe,
): Promise<{ launchable: boolean; blocked?: string }> {
  const known = (gitRoots ?? []).some((root) => samePath(root, location.repoRoot) || isInsidePath(location.repoRoot, root));
  if (known || (await isWorkTree(location.repoRoot))) {
    return { launchable: true };
  }
  const via = samePath(location.repoRoot, location.projectDir) ? "" : ` (its project configuration points [repo] root there)`;
  return {
    launchable: false,
    // Worded without naming a ref, deliberately: nothing in this module reads
    // or reasons about one, and saying so here would blur the line that keeps
    // repository identity a matter of roots alone.
    blocked: `${location.repoRoot} is not inside a git repository${via}, so the engine cannot run a plan there — it refuses every unattended turn outside a git work tree.`,
  };
}

/**
 * `.git` at `dir` or any directory above it — what `git -C dir` itself looks
 * for. Existence, not directory-ness: a linked worktree's `.git` is a file
 * pointing at the real git directory.
 */
export async function gitWorkTreeOnDisk(dir: string): Promise<boolean> {
  let at = path.resolve(dir);
  for (;;) {
    try {
      await fs.stat(path.join(at, ".git"));
      return true;
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(at);
    if (parent === at) {
      return false;
    }
    at = parent;
  }
}

/**
 * The candidates "Run plan…" may actually offer.
 *
 * The rest are kept — they are still discovered, still inspectable, and still
 * in the run picker — because a `.sparring` directory in a non-repository is
 * real history and hiding it would be its own lie. What must not happen is
 * offering it as somewhere to *start* work, since the engine would refuse.
 */
export function launchTargets(candidates: readonly LaunchRepository[]): LaunchRepository[] {
  return candidates.filter((candidate) => candidate.launchable);
}

/**
 * A `SparringLocation` for a repository that has no Agent Sparring state.
 *
 * Every field is derived from the repository root, which is the only thing
 * known about it: `.sparring` is named where the engine would create it, and
 * the project directory *is* the repository root. The workspace folder is the
 * deepest one containing the root, so a repository nested inside a folder
 * reads as nested — the same thing discovery records for a project it finds
 * that way.
 */
function locationForRepository(root: string, folders: readonly WorkspaceFolderRef[]): SparringLocation {
  const folder = folders.filter((candidate) => samePath(candidate.path, root) || isInsidePath(root, candidate.path)).sort((a, b) => pathDepth(b.path) - pathDepth(a.path))[0];
  const atFolder = folder !== undefined && samePath(folder.path, root);
  return {
    sparringDir: path.join(root, SPARRING_DIRNAME),
    projectDir: root,
    repoRoot: root,
    workspaceFolder: folder?.path ?? root,
    folderName: (atFolder ? folder.name : undefined) ?? path.basename(root),
  };
}

/**
 * The repository a file belongs to: the **deepest** candidate root containing
 * it, or undefined when none does.
 *
 * Both of a location's roots are considered — a project whose `project.toml`
 * points `[repo] root` elsewhere has two — and whichever matched more deeply
 * decides. A tie keeps the earlier candidate, which is the established project,
 * so a repository Agent Sparring already knows is never displaced by a
 * synthesised duplicate of itself.
 */
export function repositoryForFile(candidates: readonly LaunchRepository[], file: string): LaunchRepository | undefined {
  let best: LaunchRepository | undefined;
  let bestDepth = -1;
  for (const candidate of candidates) {
    for (const root of [candidate.location.repoRoot, candidate.location.projectDir]) {
      if (!samePath(root, file) && !isInsidePath(file, root)) {
        continue;
      }
      const depth = pathDepth(root);
      if (depth > bestDepth) {
        best = candidate;
        bestDepth = depth;
      }
    }
  }
  return best;
}

/**
 * Which repository a launch should target, or undefined when the caller must
 * ask.
 *
 * In order: the selected run's own repository, because choosing a run is an
 * explicit statement about which repository is meant; then the deepest
 * repository containing the active file; then the only candidate there is.
 *
 * The active file is consulted *before* "there is only one", which changes
 * nothing when the file is inside that one and is what makes the nested case
 * come out right as soon as a second candidate exists.
 */
export function chooseLaunchRepository(all: readonly LaunchRepository[], selected: RunSnapshot | undefined, activeFile?: string): LaunchRepository | undefined {
  // Only launch targets, always — including for the "there is only one"
  // shortcut. A non-repository is not a place a plan can start, so it must not
  // be picked automatically, silently, or as the sole remaining option; and
  // dropping the non-targets *before* ranking is what makes a nested valid
  // repository beat the non-git container folder above it holding a stray
  // `.sparring`, which is the reported failure.
  const candidates = launchTargets(all);
  if (selected) {
    const owner = candidates.find((candidate) => samePath(candidate.location.projectDir, selected.location.projectDir));
    if (owner) {
      return owner;
    }
  }
  if (activeFile) {
    const owner = repositoryForFile(candidates, activeFile);
    if (owner) {
      return owner;
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * How deep a path is, in segments.
 *
 * Counted rather than measured: sorting roots by string length ranks
 * `/code/aaaaaaaaaa` above `/code/a/b`, which is the wrong answer to "which
 * root is more specific".
 */
export function pathDepth(target: string): number {
  return path
    .resolve(target)
    .split(/[\\/]+/)
    .filter(Boolean).length;
}
