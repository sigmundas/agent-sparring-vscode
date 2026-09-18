/**
 * Which repositories `Run plan…` may actually target.
 *
 * The reported failure had a real and unhelpful shape:
 *
 * ```
 *   sporely/                      .sparring (handoffs and prompts only), NOT a git repository
 *     sporely-py/                 a git repository — no .sparring
 *     sporely-py-reported-statistics/   a git worktree — .sparring
 *     sporely-py-ui-cleanup/            a git worktree — .sparring
 * ```
 *
 * `sporely` is genuinely not a repository — nothing at or above it has a
 * `.git` — and the engine cannot run a plan there: its unattended-run guard
 * asks git for the checked-out ref of the execution root, git answers "not a
 * git repository", and the stage-agent run refuses. Yet `sporely` was the
 * candidate that won, because it is the *container* and therefore the deepest
 * `.sparring` location containing anything inside the tree.
 *
 * The rule the tests below fix in place is that a launch target is decided by
 * the **resolved execution repository** and not by the presence of
 * `.sparring`, which comes apart from it in both directions: a `.sparring` in
 * a non-repository is not a target, and a repository with no `.sparring` is
 * one — the latter being the case that matters most, because the first plan
 * run in a repository is exactly when there is nothing there yet.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SPARRING_DIRNAME, type SparringLocation } from "../core/discovery";
import { chooseLaunchRepository, gitWorkTreeOnDisk, launchRepositories, launchTargets } from "../core/launchRepositories";
import { Workspace, gitWorkTreesIn } from "./fixtures";

function locationFor(projectDir: string, repoRoot = projectDir): SparringLocation {
  return {
    sparringDir: path.join(projectDir, SPARRING_DIRNAME),
    projectDir,
    repoRoot,
    workspaceFolder: path.dirname(projectDir),
    folderName: path.basename(projectDir),
  };
}

describe("a stray .sparring in a directory that is not a git repository", () => {
  it("is not a launch target, and says why", async () => {
    const container = locationFor("/code/sporely");
    const candidates = await launchRepositories([container], [], [], gitWorkTreesIn("/code/sporely/sporely-py"));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].launchable, false);
    assert.match(candidates[0].blocked ?? "", /not inside a git repository/);
    assert.deepEqual(launchTargets(candidates), [], "nothing to offer");
  });

  it("is still discovered, so its history stays inspectable", async () => {
    const container = locationFor("/code/sporely");
    const candidates = await launchRepositories([container], [], [], gitWorkTreesIn());
    assert.equal(candidates.length, 1, "it is not dropped from the candidate set");
    assert.equal(candidates[0].established, true, "and it is still a project Agent Sparring has state in");
  });

  it("is never chosen silently, not even as the only candidate", async () => {
    const container = locationFor("/code/sporely");
    const candidates = await launchRepositories([container], [], [], gitWorkTreesIn());
    assert.equal(chooseLaunchRepository(candidates, undefined, "/code/sporely/README.md"), undefined, "containment does not make it runnable");
    assert.equal(chooseLaunchRepository(candidates, undefined, undefined), undefined, "and neither does being the only one");
  });
});

describe("a git repository with no .sparring", () => {
  it("is a launch target, because the first plan run is exactly when there is nothing there", async () => {
    const candidates = await launchRepositories([], ["/code/sporely/sporely-py"], [{ path: "/code/sporely", name: "sporely" }], gitWorkTreesIn("/code/sporely/sporely-py"));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].established, false, "there is no Agent Sparring state yet");
    assert.equal(candidates[0].launchable, true, "which is not a reason to withhold it");
    assert.equal(candidates[0].location.sparringDir, path.join("/code/sporely/sporely-py", ".sparring"), "named where the engine would create it");
  });

  it("wins over a non-git ancestor that does have one", async () => {
    // The whole reported shape: the file is inside both, and only one of them
    // can run anything.
    const container = locationFor("/code/sporely");
    const candidates = await launchRepositories(
      [container],
      ["/code/sporely/sporely-py"],
      [{ path: "/code/sporely", name: "sporely" }],
      gitWorkTreesIn("/code/sporely/sporely-py"),
    );
    const chosen = chooseLaunchRepository(candidates, undefined, "/code/sporely/sporely-py/main.py");
    assert.equal(chosen?.location.repoRoot, "/code/sporely/sporely-py", "the nested repository is the target");
  });
});

describe("a project whose configuration points elsewhere", () => {
  it("is launchable on the strength of the git root it names, not of the directory holding .sparring", async () => {
    // `.sparring` lives in a directory that is not a repository, but
    // `[repo] root` resolves to one that is. The engine runs against that
    // root, so that is what decides.
    const project = locationFor("/code/meta/plans", "/code/real-repo");
    const candidates = await launchRepositories([project], [], [], gitWorkTreesIn("/code/real-repo"));
    assert.equal(candidates[0].launchable, true);
    assert.equal(launchTargets(candidates).length, 1);
  });

  it("is refused when the root it names is not a repository either", async () => {
    const project = locationFor("/code/meta/plans", "/code/not-a-repo");
    const candidates = await launchRepositories([project], [], [], gitWorkTreesIn("/code/real-repo"));
    assert.equal(candidates[0].launchable, false);
    assert.match(candidates[0].blocked ?? "", /\/code\/not-a-repo/, "the refused root is named, not the .sparring directory");
    assert.match(candidates[0].blocked ?? "", /project configuration/, "and the indirection is explained");
  });
});

describe("what counts as a git repository", () => {
  it("accepts a root the Git extension has open even when nothing is on disk to probe", async () => {
    // The extension's own answer is authoritative and covers repositories
    // whose layout the probe cannot see.
    const candidates = await launchRepositories([locationFor("/code/opened")], ["/code/opened"], [], gitWorkTreesIn());
    assert.equal(candidates[0].launchable, true);
  });

  it("accepts a root inside a repository the Git extension has open", async () => {
    // `git -C` walks up, so a subdirectory of an open repository is fine.
    const candidates = await launchRepositories([locationFor("/code/opened/packages/api")], ["/code/opened"], [], gitWorkTreesIn());
    assert.equal(candidates[0].launchable, true);
  });

  it("finds .git on disk when the Git extension has not opened the repository", async () => {
    // The real case during startup, and the reason the probe exists at all:
    // the Git extension has not finished finding repositories, so its list is
    // unknown (see core/gitReadiness.ts) and the disk is the only answer.
    const ws = await Workspace.create();
    await fs.mkdir(path.join(ws.root, ".git"), { recursive: true });
    const candidates = await launchRepositories([ws.location], undefined, [], gitWorkTreeOnDisk);
    assert.equal(candidates[0].launchable, true, "a .git directory at the root is a repository");
  });

  it("accepts a linked worktree, whose .git is a file rather than a directory", async () => {
    const ws = await Workspace.create();
    await fs.writeFile(path.join(ws.root, ".git"), "gitdir: /code/main/.git/worktrees/feature\n");
    assert.equal(await gitWorkTreeOnDisk(ws.root), true, "existence, not directory-ness, is the test");
  });

  it("walks up for .git, exactly as git itself does", async () => {
    const ws = await Workspace.create();
    await fs.mkdir(path.join(ws.root, ".git"), { recursive: true });
    const deep = path.join(ws.root, "packages", "api", "src");
    await fs.mkdir(deep, { recursive: true });
    assert.equal(await gitWorkTreeOnDisk(deep), true);
  });

  it("says no, rather than hanging, at the filesystem root", async () => {
    const ws = await Workspace.create();
    assert.equal(await gitWorkTreeOnDisk(ws.root), false, "a temporary directory under no repository");
  });
});
