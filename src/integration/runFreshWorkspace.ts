/**
 * Launches a real VS Code on an empty git repository that has never seen
 * Agent Sparring, and runs ./freshWorkspaceSuite.ts inside it: the first-run
 * activation path, which the main fixture (runTests.ts) cannot exercise
 * because every folder there already contains `.sparring`.
 */

import { runTests } from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("VSCODE_")) {
      delete process.env[name];
    }
  }
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-fresh-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, "..", ".."),
      extensionTestsPath: path.resolve(__dirname, "freshWorkspaceSuite"),
      launchArgs: [repo, "--disable-extensions", "--disable-workspace-trust"],
    });
  } catch (error) {
    console.error("fresh-workspace integration test failed", error);
    process.exit(1);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
}

void main();
