/**
 * Runs inside the extension host (see runWorktreeRuns.ts). The window's only
 * folder is `app`; the run lives in its sibling worktree `app-agent-run`.
 */

import assert from "node:assert/strict";
import * as vscode from "vscode";

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > until) {
      assert.fail(`${what}; last seen: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  return last;
}

type Row = { depth: number; label: string; description: string; contextValue?: string };

export async function run(): Promise<void> {
  const sibling = process.env.AGENT_SPARRING_TEST_SIBLING ?? "";
  assert.ok(sibling, "the runner says where the sibling worktree is");
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  assert.ok(!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === sibling), "the sibling worktree is not in the workspace");

  await vscode.commands.executeCommand("agentSparring.refresh");
  const rows = await eventually(
    async () => (await vscode.commands.executeCommand<Row[]>("agentSparring._test.runsTree")) ?? [],
    (tree) => tree.some((row) => row.label === "Tidy the cockpit"),
    "the run in the sibling worktree is listed in the Runs view",
  );
  const run = rows.find((row) => row.label === "Tidy the cockpit")!;
  assert.equal(rows.find((row) => row.depth === 0)?.label, "Open", "under this repository's open runs, not another repository");
  assert.match(run.description, /^Running · Stage 2 of 2 · Today \d\d:\d\d$/);
  assert.match(run.contextValue ?? "", /^run\.external/, "marked as a worktree outside the workspace");
  const facts = rows.slice(rows.indexOf(run) + 1).filter((row) => row.depth === 2).map((row) => `${row.label}: ${row.description}`);
  assert.ok(facts.includes("Next: Reviewer"), `the engine's next_turn is shown: ${facts.join(" | ")}`);
  assert.ok(facts.some((fact) => fact.startsWith("Worktree: app-agent-run")), `and where it lives: ${facts.join(" | ")}`);

  assert.equal(await vscode.commands.executeCommand<string | undefined>("agentSparring._test.selectedRun"), undefined, "an external run is never selected automatically");
  // The window opened `app` through a symlink, and git lists it by its real
  // path. That is the same directory, not a worktree outside the workspace;
  // probing it again would show every run of it twice under two identities.
  assert.deepEqual(
    await vscode.commands.executeCommand<string[]>("agentSparring._test.externalProjects"),
    [sibling],
    "only the sibling worktree is external; the workspace's own real path is not",
  );
  console.log("worktree runs: a run in a worktree outside the workspace was discovered, listed under Open with stage, next actor and worktree, and not auto-selected");

}
