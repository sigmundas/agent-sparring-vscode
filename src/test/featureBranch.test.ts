/**
 * Run Plan makes the feature branch it was given exist before the engine is
 * asked to start: created at the current commit when missing, tracking the
 * remote when only the remote has it, and an existing branch is never
 * moved. Each case runs against a real temporary repository.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { applyFeatureBranch, inspectFeatureBranch, runGit, type GitRunner } from "../core/featureBranch";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

function commit(repo: string, file: string, text: string): string {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", file);
  return git(repo, "rev-parse", "HEAD");
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparring-branch-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "a.txt", "a");
  return repo;
}

/** A clone whose `origin` has `feature/remote` one commit ahead of main. */
function cloneWithRemoteBranch(): { repo: string; remoteCommit: string } {
  const upstream = repository();
  git(upstream, "switch", "-q", "-c", "feature/remote");
  const remoteCommit = commit(upstream, "b.txt", "b");
  git(upstream, "switch", "-q", "main");
  const repo = path.join(path.dirname(upstream), "clone");
  execFileSync("git", ["clone", "-q", upstream, repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  return { repo, remoteCommit };
}

describe("feature branch before a new plan run", () => {
  it("uses a branch that is already checked out, and does nothing", async () => {
    const repo = repository();
    git(repo, "switch", "-q", "-c", "feature/here");
    assert.deepEqual(await inspectFeatureBranch(repo, "feature/here"), { kind: "checked-out", branch: "feature/here" });
  });

  it("uses an existing local branch as it is, without moving or checking it out", async () => {
    const repo = repository();
    git(repo, "branch", "feature/old");
    const before = git(repo, "rev-parse", "feature/old");
    commit(repo, "c.txt", "c"); // main moves on; feature/old stays behind
    const plan = await inspectFeatureBranch(repo, "feature/old");
    assert.deepEqual(plan, { kind: "existing", branch: "feature/old" });
    assert.equal(git(repo, "rev-parse", "feature/old"), before, "the existing branch is not moved");
    assert.equal(git(repo, "branch", "--show-current"), "main", "nothing is checked out");
  });

  it("creates a missing branch at the current commit and checks it out, leaving files as they are", async () => {
    const repo = repository();
    const head = git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "a.txt"), "edited"); // uncommitted work stays in place
    const plan = await inspectFeatureBranch(repo, "feature/reference-parser");
    assert.deepEqual(plan, { kind: "create", branch: "feature/reference-parser", from: { branch: "main", commit: head } });
    assert.equal(plan.kind, "create");
    if (plan.kind !== "create") return;
    assert.deepEqual(await applyFeatureBranch(repo, plan), { ok: true });
    assert.equal(git(repo, "branch", "--show-current"), "feature/reference-parser");
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "edited");
  });

  it("creates a local branch tracking the remote when only the remote has it", async () => {
    const { repo, remoteCommit } = cloneWithRemoteBranch();
    const plan = await inspectFeatureBranch(repo, "feature/remote");
    assert.equal(plan.kind, "track");
    if (plan.kind !== "track") return;
    assert.equal(plan.remoteRef, "origin/feature/remote");
    assert.equal(plan.commit, remoteCommit);
    assert.deepEqual(await applyFeatureBranch(repo, plan), { ok: true });
    assert.equal(git(repo, "branch", "--show-current"), "feature/remote");
    assert.equal(git(repo, "rev-parse", "HEAD"), remoteCommit, "the local branch is the remote's, not one at the old HEAD");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "feature/remote@{upstream}"), "origin/feature/remote");
  });

  it("refuses to track the remote over uncommitted changes", async () => {
    const { repo } = cloneWithRemoteBranch();
    fs.writeFileSync(path.join(repo, "a.txt"), "edited");
    const plan = await inspectFeatureBranch(repo, "feature/remote");
    if (plan.kind !== "track") return assert.fail(`expected track, got ${plan.kind}`);
    const outcome = await applyFeatureBranch(repo, plan);
    assert.equal(outcome.ok, false);
    assert.equal(git(repo, "branch", "--show-current"), "main");
    assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/remote"));
  });

  it("refuses an invalid name and a repository with no commit", async () => {
    const repo = repository();
    assert.equal((await inspectFeatureBranch(repo, "bad..name")).kind, "refuse");
    assert.equal((await inspectFeatureBranch(repo, "-x")).kind, "refuse");
    const empty = path.join(path.dirname(repo), "empty");
    fs.mkdirSync(empty);
    git(empty, "init", "-q");
    assert.equal((await inspectFeatureBranch(empty, "feature/x")).kind, "refuse");
  });

  it("reports a failed creation and never overwrites a branch that appeared meanwhile", async () => {
    const repo = repository();
    commit(repo, "d.txt", "d");
    const plan = await inspectFeatureBranch(repo, "feature/race");
    if (plan.kind !== "create") return assert.fail(`expected create, got ${plan.kind}`);
    // Someone else creates it, at another commit, after inspection.
    git(repo, "branch", "feature/race", "HEAD~1");
    const raced = git(repo, "rev-parse", "feature/race");
    const outcome = await applyFeatureBranch(repo, plan);
    assert.equal(outcome.ok, false);
    assert.equal(git(repo, "rev-parse", "feature/race"), raced, "the existing branch is not moved");
    assert.equal(git(repo, "branch", "--show-current"), "main");
  });

  it("refuses when HEAD moved since inspection", async () => {
    const repo = repository();
    const plan = await inspectFeatureBranch(repo, "feature/late");
    if (plan.kind !== "create") return assert.fail(`expected create, got ${plan.kind}`);
    commit(repo, "e.txt", "e");
    const outcome = await applyFeatureBranch(repo, plan);
    assert.equal(outcome.ok, false);
    assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/late"));
  });

  it("surfaces a git failure as a refusal and runs no write", async () => {
    const calls: string[][] = [];
    const failing: GitRunner = async (root, args) => {
      calls.push(args);
      if (args[0] === "show-ref") return { code: 128, stdout: "", stderr: "fatal: broken" };
      return runGit(root, args);
    };
    const repo = repository();
    const plan = await inspectFeatureBranch(repo, "feature/x", failing);
    assert.equal(plan.kind, "refuse");
    assert.match(plan.kind === "refuse" ? plan.reason : "", /broken/);
    assert.ok(!calls.some((args) => args[0] === "switch" || args[0] === "branch"), "nothing is written");
  });

  it("never asks git to force, reset or delete", async () => {
    const writes: string[][] = [];
    const recording: GitRunner = async (root, args) => {
      if (["switch", "branch", "checkout", "reset", "update-ref"].includes(args[0])) writes.push(args);
      return runGit(root, args);
    };
    const repo = repository();
    const plan = await inspectFeatureBranch(repo, "feature/y", recording);
    if (plan.kind !== "create") return assert.fail(`expected create, got ${plan.kind}`);
    await applyFeatureBranch(repo, plan, recording);
    assert.deepEqual(writes, [["switch", "-c", "feature/y"]]);
  });
});
