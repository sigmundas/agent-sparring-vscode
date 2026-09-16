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
export function launchRepositories(
  locations: readonly SparringLocation[],
  gitRoots: readonly string[] | undefined,
  folders: readonly WorkspaceFolderRef[] = [],
): LaunchRepository[] {
  const out: LaunchRepository[] = locations.map((location) => ({ location, established: true }));
  for (const root of gitRoots ?? []) {
    const covered = out.some((candidate) => samePath(candidate.location.repoRoot, root) || samePath(candidate.location.projectDir, root));
    if (!covered) {
      out.push({ location: locationForRepository(root, folders), established: false });
    }
  }
  return out;
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
export function chooseLaunchRepository(candidates: readonly LaunchRepository[], selected: RunSnapshot | undefined, activeFile?: string): LaunchRepository | undefined {
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
