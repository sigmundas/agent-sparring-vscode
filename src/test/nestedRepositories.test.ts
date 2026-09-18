/**
 * Nested repository roots, and which one a file belongs to.
 *
 * The reported failure had a real layout. A container folder held a stray
 * `.sparring` and a dozen checkouts:
 *
 * ```
 *   sporely/                            .sparring, but not a git repository
 *     sporely-py/                       a git repository — no .sparring
 *     sporely-py-reported-statistics/   a git worktree — .sparring
 *     sporely-py-ui-cleanup/            a git worktree — .sparring
 *     sporely-web/                      a git repository — .sparring
 * ```
 *
 * With a Python file open in `sporely/sporely-py/`, Agent Sparring resolved it
 * to the container `sporely` and "Run plan…" offered `sporely` and the
 * worktrees but not `sporely-py` — the one repository the file was actually
 * in. Two separate defects, both reproduced here:
 *
 *  1. the candidates came only from `.sparring` discovery, so a repository
 *     with no Agent Sparring state could not be chosen or even offered;
 *  2. resolution therefore had nothing deeper than the container to find.
 *
 * Nothing in either fix reads a branch name: two checkouts of one repository
 * are told apart by their roots, and a branch is what a repository is *on*,
 * never what it *is*.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { locateAll, type SparringLocation } from "../core/discovery";
import { chooseLaunchRepository, launchRepositories, pathDepth, repositoryForFile } from "../core/launchRepositories";
import { repositoryOfPath, type GitSource } from "../core/activeRepository";
import { Workspace, everywhereIsAGitRepo, gitWorkTreesIn } from "./fixtures";

/** The worktrees that must stay separate repositories, named as they really are. */
const WORKTREES = ["sporely-py-reported-statistics", "sporely-py-inaturalist-republish-media", "sporely-py-taxonomy-v2-identity-reconciliation", "sporely-py-ui-cleanup"];

/**
 * The reported layout. `sporely` is a workspace folder with a `.sparring`
 * directory and no git repository of its own; `sporely-py` is a git
 * repository with no Agent Sparring state; each worktree is a git repository
 * that has both.
 */
async function sporelyWorkspace() {
  const container = await Workspace.create({ name: "sporely" });
  const nested = await Workspace.createNested(container.root, "sporely-py", { sparring: false });
  const worktrees: Workspace[] = [];
  for (const name of WORKTREES) {
    worktrees.push(await Workspace.createNested(container.root, name));
  }
  const locations = await locateAll([{ path: container.root, name: "sporely" }]);
  return {
    container,
    nested,
    worktrees,
    locations,
    folders: [{ path: container.root, name: "sporely" }],
    /** What the Git extension reports: every repository and worktree, and never the container. */
    gitRoots: [nested.root, ...worktrees.map((worktree) => worktree.root)],
    activeFile: path.join(nested.root, "foo.py"),
  };
}

describe("a file in a nested repository belongs to that repository", () => {
  it("resolves sporely/sporely-py/foo.py to sporely-py, not to the outer sporely", async () => {
    const { locations, gitRoots, folders, activeFile, nested, container } = await sporelyWorkspace();

    // The container really does contain the file, and really is a candidate:
    // it has a `.sparring` directory of its own. That is what made the old
    // answer look plausible.
    assert.ok(locations.some((location) => location.repoRoot === container.root), "the container is a discovered project");
    assert.ok(activeFile.startsWith(container.root + path.sep), "and the file is inside it");

    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    assert.equal(repositoryForFile(candidates, activeFile)?.location.repoRoot, nested.root, "the deepest root containing the file wins");
    assert.equal(chooseLaunchRepository(candidates, undefined, activeFile)?.location.repoRoot, nested.root, "so that is what a launch targets");
  });

  it("does not launch in the container for a file in the container, because it is not a repository", async () => {
    // The container is the deepest candidate containing its own README, and
    // it was therefore chosen — but it is not a git repository, and the
    // engine refuses to run a plan outside one. Containment made it the right
    // answer to the wrong question; the right answer is to ask.
    const { locations, gitRoots, folders, container } = await sporelyWorkspace();
    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    const containerCandidate = candidates.find((candidate) => candidate.location.repoRoot === container.root);
    assert.ok(containerCandidate, "it is still a discovered project, and still inspectable");
    assert.equal(containerCandidate.launchable, false, "but it is not somewhere a plan can be started");
    assert.match(containerCandidate.blocked ?? "", /not inside a git repository/);
    assert.equal(chooseLaunchRepository(candidates, undefined, path.join(container.root, "README.md")), undefined, "so nothing is chosen silently");
  });

  it("resolves a file in a worktree to that worktree, never to a sibling or the container", async () => {
    const { locations, gitRoots, folders, worktrees } = await sporelyWorkspace();
    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    for (const worktree of worktrees) {
      const resolved = chooseLaunchRepository(candidates, undefined, path.join(worktree.root, "src", "main.py"));
      assert.equal(resolved?.location.repoRoot, worktree.root, `a file in ${path.basename(worktree.root)} is that worktree's`);
    }
  });

  it("is not fooled by a long name at a shallower depth", async () => {
    // Sorting roots by string length ranks a long sibling above a deeper
    // child; depth is counted in segments instead.
    const shallowButLong: SparringLocation = location("/code/aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const deepButShort: SparringLocation = location("/code/aaaaaaaaaaaaaaaaaaaaaaaaaaaa/a/b");
    const candidates = await launchRepositories([shallowButLong, deepButShort], [], [], everywhereIsAGitRepo);
    assert.equal(repositoryForFile(candidates, "/code/aaaaaaaaaaaaaaaaaaaaaaaaaaaa/a/b/file.py")?.location.repoRoot, deepButShort.repoRoot);
    assert.ok(pathDepth("/code/a/b") > pathDepth("/code/aaaaaaaaaa"), "depth is segments, not characters");
  });
});

describe("Run plan… offers repositories that have no Agent Sparring state yet", () => {
  it("includes a git repository with no .sparring, because starting the first plan is when that matters", async () => {
    const { locations, gitRoots, folders, nested } = await sporelyWorkspace();

    // Precondition: discovery genuinely cannot see it.
    assert.ok(!locations.some((location) => location.repoRoot === nested.root), "it has no .sparring, so it is not a discovered project");
    await assert.rejects(fs.stat(path.join(nested.root, ".sparring")), "and the directory really is absent");

    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    const offered = candidates.find((candidate) => candidate.location.repoRoot === nested.root);
    assert.ok(offered, "Run plan… offers it anyway");
    assert.equal(offered.established, false, "marked as having no state, so the picker can say so rather than imply a history");
    assert.equal(offered.location.sparringDir, path.join(nested.root, ".sparring"), "with .sparring named where the engine would create it");
    assert.equal(offered.location.repoRoot, nested.root, "and the repository root the engine is invoked against");
    assert.equal(offered.location.projectDir, nested.root);
    assert.equal(offered.location.folderName, "sporely-py", "named as the Explorer names it");
    assert.equal(offered.location.workspaceFolder, path.dirname(nested.root), "nested under the workspace folder that contains it");
  });

  it("offers every repository the window can start a plan in, and nothing it cannot", async () => {
    const { locations, gitRoots, folders, container, nested, worktrees } = await sporelyWorkspace();
    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    assert.deepEqual(
      candidates.map((candidate) => candidate.location.folderName).sort(),
      [path.basename(container.root), path.basename(nested.root), ...worktrees.map((worktree) => path.basename(worktree.root))].sort(),
    );
  });

  it("keeps each separate worktree a separate repository, listed once", async () => {
    const { locations, gitRoots, folders, worktrees } = await sporelyWorkspace();
    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    for (const worktree of worktrees) {
      const matching = candidates.filter((candidate) => candidate.location.repoRoot === worktree.root);
      assert.equal(matching.length, 1, `${path.basename(worktree.root)} appears exactly once`);
      assert.equal(matching[0].established, true, "as the discovered project it is, not as a synthesised duplicate");
    }
    assert.equal(new Set(candidates.map((candidate) => candidate.location.repoRoot)).size, candidates.length, "no root is offered twice");
  });

  it("falls back to the discovered projects when the Git extension has told us nothing", async () => {
    const { locations, folders } = await sporelyWorkspace();
    // `undefined` is "the extension is not installed, not active yet, or has
    // no API version 1" — different from an active extension with nothing
    // open. Either way nothing here scans for `.git` on its own.
    const candidates = await launchRepositories(locations, undefined, folders, everywhereIsAGitRepo);
    assert.deepEqual(
      candidates.map((candidate) => candidate.location.repoRoot).sort(),
      locations.map((location) => location.repoRoot).sort(),
    );
    assert.ok(candidates.every((candidate) => candidate.established));
  });

  it("offers a repository even when the window has no Agent Sparring state at all", async () => {
    const candidates = await launchRepositories([], ["/code/fresh-repo"], [{ path: "/code", name: "code" }], gitWorkTreesIn("/code/fresh-repo"));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].established, false);
    assert.equal(chooseLaunchRepository(candidates, undefined, "/code/fresh-repo/main.py")?.location.repoRoot, "/code/fresh-repo");
  });
});

/**
 * The active-editor signal the cockpit follows. The Git extension's own
 * `getRepository` sorts its open repositories deepest-first, so it normally
 * answers correctly — but its answer was trusted outright, which made the
 * cockpit's answer only as specific as whatever it returned.
 */
describe("the active editor's repository is the deepest one containing it", () => {
  const source = (roots: string[], answer?: string): GitSource => ({
    repositories: () => roots.map((rootPath) => ({ rootPath, selected: false })),
    repositoryOf: () => answer,
  });

  it("prefers a deeper open root over a shallower answer from the Git extension", () => {
    // If the extension ever answers with the container — a submodule path
    // whose repository is not open, an older build, a spelling difference —
    // an open root that is genuinely deeper is still the better answer.
    const git = source(["/code/sporely/sporely-py", "/code/sporely"], "/code/sporely");
    assert.equal(repositoryOfPath(git, "/code/sporely/sporely-py/foo.py"), "/code/sporely/sporely-py");
  });

  it("keeps the Git extension's answer when nothing open is deeper", () => {
    const git = source(["/code/sporely"], "/code/sporely/sporely-py");
    assert.equal(repositoryOfPath(git, "/code/sporely/sporely-py/foo.py"), "/code/sporely/sporely-py", "it knows about roots the containment scan cannot see");
  });

  it("falls back to the deepest containing root when the Git extension declines", () => {
    const git = source(["/code/sporely", "/code/sporely/sporely-py"], undefined);
    assert.equal(repositoryOfPath(git, "/code/sporely/sporely-py/foo.py"), "/code/sporely/sporely-py");
  });

  it("says nothing about a file in no repository at all", () => {
    assert.equal(repositoryOfPath(source(["/code/sporely"], undefined), "/elsewhere/foo.py"), undefined);
  });
});

describe("repository identity never comes from a branch", () => {
  it("resolves by root even when two checkouts are on the same branch", async () => {
    const { locations, gitRoots, folders, worktrees } = await sporelyWorkspace();
    const candidates = await launchRepositories(locations, gitRoots, folders, gitWorkTreesIn(...gitRoots));
    const [first, second] = worktrees;
    assert.notEqual(
      chooseLaunchRepository(candidates, undefined, path.join(first.root, "a.py"))?.location.repoRoot,
      chooseLaunchRepository(candidates, undefined, path.join(second.root, "a.py"))?.location.repoRoot,
    );
  });

  it("reads no branch anywhere in the resolution", async () => {
    const module = await fs.readFile(path.join(__dirname, "..", "..", "src", "core", "launchRepositories.ts"), "utf8");
    const code = module.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/branch/i.test(code), "nothing in the launch-repository rules touches a branch");
  });
});

/**
 * Both surfaces must keep going through the shared rules, so a later change
 * cannot quietly narrow the candidates back to `.sparring` discovery.
 */
describe("the launch picker takes its candidates from the shared rules", () => {
  it("asks the controller for repositories, not for .sparring locations", async () => {
    const commands = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function pickLocation\([\s\S]*?\n}\n/.exec(commands)?.[0] ?? "";
    assert.ok(body, "pickLocation exists");
    assert.match(body, /await controller\.launchRepositories\(\)/, "the candidates are the union, not the discovered projects");
    assert.match(body, /chooseLaunchRepository\(candidates, controller\.currentSelection\.selected, activeFile\)/, "and one shared rule decides");
    assert.ok(!/controller\.sparringLocations/.test(body), "never narrowed back to .sparring discovery");
    assert.match(body, /candidate\.established \? undefined :/, "a repository with no state says so in the picker");

    const controller = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
    const reader = /async launchRepositories\([\s\S]*?\n {2}}\n/.exec(controller)?.[0] ?? "";
    assert.ok(reader, "launchRepositories exists on the controller");
    assert.match(reader, /await this\.activeRepository\.ready\(\)/, "the Git extension is awaited, so the first ask is not the short list");
    assert.match(reader, /this\.activeRepository\.knownRepoRoots/, "and the roots are the Git extension's own");
  });
});

/** A `SparringLocation` at one root, for the rules that need no files on disk. */
function location(root: string): SparringLocation {
  return { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
}
