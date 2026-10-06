/**
 * Launches a real VS Code on one git repository whose agent run lives in a
 * sibling worktree that is NOT part of the workspace, and runs
 * ./worktreeRunsSuite.ts inside it: the run must be found through
 * `git worktree list`, shown in the Runs view, never selected on its own,
 * and — opened through a symlink to the repository, as git never reports it
 * — not have the workspace's own directory rediscovered as a second,
 * external project. With the proposed chat sessions API enabled for this
 * extension and
 * the experimental setting on — listed as an agent session.
 */

import { runTests } from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PLAN = "# Tidy the cockpit\n\n## Stage 1 — Header\nbody\n\n## Stage 2 — Cards\nbody\n";

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("VSCODE_")) {
      delete process.env[name];
    }
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-worktrees-")));
  const app = path.join(base, "app");
  const sibling = path.join(base, "app-agent-run");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" });
  await fs.mkdir(path.join(app, ".vscode"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  await fs.writeFile(path.join(app, "README.md"), "app\n");
  git(app, "add", "README.md");
  git(app, "commit", "-q", "-m", "init");
  await fs.mkdir(path.join(app, ".sparring"), { recursive: true });
  await fs.writeFile(path.join(app, ".vscode", "settings.json"), JSON.stringify({ "agentSparring.experimental.agentSessions": true }, null, 2));
  git(app, "worktree", "add", "-q", "-b", "sparring/tidy", sibling);
  await fs.mkdir(path.join(sibling, "docs", "plans"), { recursive: true });
  await fs.writeFile(path.join(sibling, "docs", "plans", "tidy.md"), PLAN);
  await fs.mkdir(path.join(sibling, ".sparring", "plans"), { recursive: true });
  await fs.writeFile(
    path.join(sibling, ".sparring", "plans", "tidy-1.json"),
    JSON.stringify({ plan: "docs/plans/tidy.md", run: "tidy-1", status: "running", current_stage_index: 1, current_stage: "tidy-1-stage-2-cards", expected_branch: "sparring/tidy", plan_digest: "0".repeat(64) }, null, 2),
  );
  const stage = path.join(sibling, ".sparring", "stages", "tidy-1-stage-2-cards");
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, "state.json"), JSON.stringify({ status: "working", run: "tidy-1", next_turn: "sparring", base_sha: null, candidate_sha: null, implementation_session_id: null, sparring_session_id: null }, null, 2));
  // The window opens the repository through this alias; git lists it by its real path.
  const alias = path.join(base, "app-alias");
  await fs.symlink(app, alias, "dir");
  process.env.AGENT_SPARRING_TEST_SIBLING = sibling;
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, "..", ".."),
      extensionTestsPath: path.resolve(__dirname, "worktreeRunsSuite"),
      extensionTestsEnv: { AGENT_SPARRING_TEST_SIBLING: sibling },
      launchArgs: [alias, "--disable-extensions", "--disable-workspace-trust", "--enable-proposed-api", "sintef.agent-sparring-vscode"],
    });
  } catch (error) {
    console.error("worktree runs integration test failed", error);
    process.exit(1);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

void main();
