import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  UNRESOLVABLE_MESSAGE,
  buildAcceptCandidateArgs,
  buildFreezeCandidateArgs,
  buildResumePlanArgs,
  buildRunPlanArgs,
  commandNotFoundMessage,
  executableWord,
  isCommandNotFoundExit,
  planExecutable,
  readGitBranch,
} from "../core/cli";
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

describe("acceptance command construction", () => {
  it("freeze-candidate and accept-candidate mirror cli.py: positional stage, --repo-root, --expected-branch", () => {
    const invocation = { stageId: "stage-x", repoRoot: "/my repo", expectedBranch: "feature/x", sparringDir: "/my repo/.sparring" };
    assert.deepEqual(buildFreezeCandidateArgs(invocation), ["freeze-candidate", "stage-x", "--repo-root", "/my repo", "--expected-branch", "feature/x"]);
    assert.deepEqual(buildAcceptCandidateArgs(invocation), ["accept-candidate", "stage-x", "--repo-root", "/my repo", "--expected-branch", "feature/x"]);
    assert.deepEqual(buildFreezeCandidateArgs({ ...invocation, sparringDir: "/elsewhere/.sparring" }).slice(0, 3), ["--sparring-dir", "/elsewhere/.sparring", "freeze-candidate"]);
  });
});

describe("executable planning", () => {
  async function fakeBin(dirName: string): Promise<{ dir: string; file: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-bin-"));
    const dir = path.join(base, dirName);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "sparring");
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { dir, file };
  }

  it("with a shell available, bare `sparring` is handed to the shell and never pre-rejected from the extension host's PATH", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-empty-"));
    assert.deepEqual(await planExecutable("", { platform: "darwin", PATH: empty }, true), { ok: true, plan: { kind: "shell", command: "sparring" } });
    assert.deepEqual(await planExecutable(undefined, { platform: "linux", PATH: "" }, true), { ok: true, plan: { kind: "shell", command: "sparring" } });
    assert.equal(executableWord({ kind: "shell", command: "sparring" }), "sparring");
  });

  it("a configured absolute path wins over the shell and is validated", async () => {
    const { file } = await fakeBin("bin");
    assert.deepEqual(await planExecutable(file, { platform: "darwin", PATH: "" }, true), { ok: true, plan: { kind: "configured", path: file } });
    assert.deepEqual(await planExecutable(file, { platform: "darwin", PATH: "" }, false), { ok: true, plan: { kind: "configured", path: file } });
    const missing = await planExecutable(path.join(path.dirname(file), "nope"), { platform: "darwin", PATH: "" }, true);
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.problem, "configured-invalid");
    assert.match(!missing.ok ? missing.error : "", /agentSparring.executable points at .*nope, which does not exist/);
    assert.ok(!(!missing.ok && /pip install/.test(missing.error)), "never a reinstall suggestion");
  });

  it("resolves a relative configured path against the workspace", async () => {
    const { dir, file } = await fakeBin("bin");
    assert.deepEqual(await planExecutable("./bin/sparring", { platform: "darwin", PATH: "", cwd: path.dirname(dir) }, true), { ok: true, plan: { kind: "configured", path: file } });
  });

  it("without a shell, bare `sparring` falls back to this process's PATH, else an honest configuration message", async () => {
    const { dir, file } = await fakeBin("bin with spaces");
    assert.deepEqual(await planExecutable("", { platform: "darwin", PATH: `/nonexistent:${dir}` }, false), { ok: true, plan: { kind: "resolved", path: file } });
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-empty-"));
    const result = await planExecutable("", { platform: "linux", PATH: empty }, false);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.problem, "unresolvable");
    assert.equal(!result.ok && result.error, UNRESOLVABLE_MESSAGE);
    assert.match(UNRESOLVABLE_MESSAGE, /could not resolve the CLI from this VS Code environment/);
    assert.ok(!/pip install|reinstall/i.test(UNRESOLVABLE_MESSAGE), "lacking shell PATH visibility is not an installation problem");
  });

  it("applies PATHEXT and ';' separators when told it is Windows", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-win-"));
    const file = path.join(base, "sparring.EXE");
    await fs.writeFile(file, "");
    assert.deepEqual(await planExecutable("", { platform: "win32", PATH: `C:\\nope;${base}`, PATHEXT: ".COM;.EXE;.BAT" }, false), { ok: true, plan: { kind: "resolved", path: file } });
  });

  it("recognises the shell's command-not-found exit code, and words the error as a configuration problem", () => {
    assert.equal(isCommandNotFoundExit(127, "darwin"), true);
    assert.equal(isCommandNotFoundExit(127, "linux"), true);
    assert.equal(isCommandNotFoundExit(9009, "win32"), true);
    assert.equal(isCommandNotFoundExit(9009, "darwin"), false);
    assert.equal(isCommandNotFoundExit(1, "darwin"), false);
    assert.equal(isCommandNotFoundExit(undefined, "darwin"), false);
    assert.match(commandNotFoundMessage("sparring"), /Your shell could not find 'sparring'/);
    assert.match(commandNotFoundMessage("sparring"), /agentSparring.executable/);
    assert.ok(!/pip install/.test(commandNotFoundMessage("sparring")));
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
