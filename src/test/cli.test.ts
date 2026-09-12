import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs, buildRunPlanArgs, readGitBranch, resolveExecutable } from "../core/cli";
import { Workspace } from "./fixtures";

describe("CLI argument building", () => {
  it("run-plan mirrors cli.py's positional + required flags, unquoted", () => {
    const args = buildRunPlanArgs({
      planPath: "/my repo/docs/plans/foo bar.md",
      repoRoot: "/my repo",
      expectedBranch: "feature/x",
      sparringDir: "/my repo/.sparring",
    });
    assert.deepEqual(args, ["run-plan", "/my repo/docs/plans/foo bar.md", "--repo-root", "/my repo", "--expected-branch", "feature/x"]);
  });

  it("passes --sparring-dir globally only when it is not the implicit one", () => {
    const args = buildRunPlanArgs({ planPath: "p.md", repoRoot: "/r", expectedBranch: "b", sparringDir: "/elsewhere/.sparring" });
    assert.deepEqual(args.slice(0, 3), ["--sparring-dir", "/elsewhere/.sparring", "run-plan"]);
  });

  it("resume-plan adds --evidence only when non-empty", () => {
    const base = { planPath: "p.md", repoRoot: "/r", expectedBranch: "b" };
    assert.deepEqual(buildResumePlanArgs({ ...base, evidence: "  " }), ["resume-plan", "p.md", "--repo-root", "/r", "--expected-branch", "b"]);
    assert.deepEqual(buildResumePlanArgs({ ...base, evidence: "Tested on a Pixel 7" }).slice(-2), ["--evidence", "Tested on a Pixel 7"]);
  });
});

describe("executable resolution", () => {
  async function fakeBin(dirName: string): Promise<{ dir: string; file: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-bin-"));
    const dir = path.join(base, dirName);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "sparring");
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { dir, file };
  }

  it("reports a missing executable with guidance instead of throwing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-empty-"));
    const result = await resolveExecutable("", { platform: "linux", PATH: empty });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /not found on PATH/);
    assert.match(!result.ok ? result.error : "", /agentSparring.executable/);
  });

  it("finds a fake sparring on a PATH entry containing spaces", async () => {
    const { dir, file } = await fakeBin("bin with spaces");
    const result = await resolveExecutable(undefined, { platform: "darwin", PATH: `/nonexistent:${dir}` });
    assert.deepEqual(result, { ok: true, path: file });
  });

  it("honours an explicit configured path and rejects a missing one", async () => {
    const { file } = await fakeBin("bin");
    assert.deepEqual(await resolveExecutable(file, { platform: "darwin", PATH: "" }), { ok: true, path: file });
    const missing = await resolveExecutable(path.join(path.dirname(file), "nope"), { platform: "darwin", PATH: "" });
    assert.equal(missing.ok, false);
  });

  it("resolves a relative configured path against the workspace", async () => {
    const { dir, file } = await fakeBin("bin");
    const result = await resolveExecutable("./bin/sparring", { platform: "darwin", PATH: "", cwd: path.dirname(dir) });
    assert.deepEqual(result, { ok: true, path: file });
  });

  it("applies PATHEXT and ';' separators when told it is Windows", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-win-"));
    const file = path.join(base, "sparring.EXE");
    await fs.writeFile(file, "");
    const result = await resolveExecutable("", { platform: "win32", PATH: `C:\\nope;${base}`, PATHEXT: ".COM;.EXE;.BAT" });
    assert.deepEqual(result, { ok: true, path: file });
  });
});

describe("git branch detection", () => {
  it("reads the checked-out branch from .git/HEAD and handles detached HEAD", async () => {
    const ws = await Workspace.create();
    await fs.mkdir(path.join(ws.root, ".git"));
    await fs.writeFile(path.join(ws.root, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    assert.equal(await readGitBranch(ws.root), "feature/x");
    await fs.writeFile(path.join(ws.root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    assert.equal(await readGitBranch(ws.root), undefined);
  });

  it("follows a worktree .git pointer file", async () => {
    const ws = await Workspace.create();
    const gitdir = path.join(ws.root, "..", "gitdir");
    await fs.mkdir(gitdir, { recursive: true });
    await fs.writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(ws.root, ".git"), `gitdir: ${gitdir}\n`);
    assert.equal(await readGitBranch(ws.root), "main");
  });
});
