/**
 * Launches a real VS Code (via @vscode/test-electron) on a multi-root
 * workspace built on the fly with the exact shape reported from the field:
 *
 *   window.code-workspace
 *   ├── sporely/                              (legacy .sparring: no stages, plus a nested project)
 *   │   └── nested-repo/.sparring/stages/...  (NOT a workspace folder)
 *   └── sporely-py-reported-statistics/
 *       ├── project.toml
 *       └── .sparring/stages/<3 stages>/state.json   (no plans/, no .sparring/project.toml)
 *
 * The assertions live in ./suite.ts and run inside the extension host.
 */

import { runTests } from "@vscode/test-electron";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite");
  const fixture = await buildFixture();
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [fixture.workspaceFile, "--disable-extensions", "--disable-workspace-trust"],
      extensionTestsEnv: { AGENT_SPARRING_FIXTURE: fixture.root },
    });
  } catch (error) {
    console.error("integration test failed", error);
    process.exit(1);
  }
}

async function buildFixture(): Promise<{ root: string; workspaceFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-it-"));
  const sporely = path.join(root, "sporely");
  const reported = path.join(root, "sporely-py-reported-statistics");

  // folder 0: a legacy .sparring without stages/plans and a nested engine project
  await fs.mkdir(path.join(sporely, ".sparring", "handoffs"), { recursive: true });
  await writeStage(path.join(sporely, "nested-repo"), "stage-nested-only", "working");

  // folder 1: the reported repository
  await fs.mkdir(reported, { recursive: true });
  await fs.writeFile(path.join(reported, "project.toml"), 'project = "sporely-py"\n\n[repo]\nroot = "."\n');
  await writeStage(reported, "stage-reported-statistics-contract", "accepted");
  const barrier = await writeStage(reported, "stage-reported-statistics-local-schema-barrier", "accepted");
  await fs.writeFile(path.join(barrier, "activity.jsonl"), '{"v":1,"ts":"2026-09-11T19:00:00.000Z","actor":"stage","event":"stage.created"}\n');
  await fs.writeFile(path.join(barrier, "brief.md"), "# Brief\n");
  await fs.writeFile(path.join(barrier, "handoff.md"), "# Handoff\n");
  await fs.writeFile(path.join(barrier, "sparring.md"), "# Sparring\n");
  await writeStage(reported, "stage-reported-statistics-typed-parser", "working");

  const workspaceFile = path.join(root, "window.code-workspace");
  await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: "sporely" }, { path: "sporely-py-reported-statistics" }], settings: {} }, null, 2));
  return { root, workspaceFile };
}

async function writeStage(repo: string, stageId: string, status: string): Promise<string> {
  const dir = path.join(repo, ".sparring", "stages", stageId);
  await fs.mkdir(dir, { recursive: true });
  const state = { base_sha: null, candidate_sha: status === "accepted" ? "c".repeat(40) : null, implementation_session_id: null, sparring_session_id: null, status };
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  return dir;
}

void main();
