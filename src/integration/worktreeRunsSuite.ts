/**
 * Runs inside the extension host (see runWorktreeRuns.ts). The window's only
 * folder is `app`; the run lives in its sibling worktree `app-agent-run`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

  await runPlanChoiceAssertions();
  await mergeCleanUpAssertions(sibling);
}

const calls = process.env.AGENT_SPARRING_TEST_CALLS ?? "";

async function callsOf(subcommand: string): Promise<string[]> {
  const text = await fs.readFile(calls, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.startsWith(`${subcommand} `));
}

/**
 * Stand in for the person at the dialogs: the QuickPick answers with the
 * item whose label is `pick`, an input box with its proposed value, every warning/information dialog with
 * `confirm` when offered (and is recorded). Restored by the returned function.
 */
function stubDialogs(pick: string | undefined, confirm: string | undefined): { asked: string[]; picks: string[][]; restore: () => void } {
  const window = vscode.window as unknown as Record<string, unknown>;
  const names = ["showQuickPick", "showInputBox", "showWarningMessage", "showInformationMessage", "showErrorMessage"];
  const originals = names.map((name) => [name, window[name]] as const);
  const asked: string[] = [];
  const picks: string[][] = [];
  window["showQuickPick"] = async (items: readonly vscode.QuickPickItem[]) => {
    picks.push(items.map((item) => item.label));
    return items.find((item) => item.label === pick);
  };
  // The branch question is answered with what it proposes: the branch checked out.
  window["showInputBox"] = async (options?: vscode.InputBoxOptions) => {
    asked.push(options?.prompt ?? options?.title ?? "input");
    return options?.value;
  };
  for (const name of ["showWarningMessage", "showInformationMessage", "showErrorMessage"]) {
    window[name] = async (message: string, ...rest: unknown[]) => {
      asked.push(message);
      return rest.find((item) => item === confirm);
    };
  }
  return {
    asked,
    picks,
    restore: () => {
      for (const [name, original] of originals) {
        window[name] = original;
      }
    },
  };
}

/** Run Plan asks where the run goes, and each answer builds its own invocation. */
async function runPlanChoiceAssertions(): Promise<void> {
  const app = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const plan = path.join(app, "docs-plan.md");
  for (const [choice, managed] of [
    ["Run in its own workspace (recommended)", true],
    ["Run in this checkout", false],
  ] as const) {
    const before = (await callsOf("run-plan")).length;
    const dialogs = stubDialogs(choice, undefined);
    try {
      assert.ok(await vscode.commands.executeCommand<boolean>("agentSparring._test.runPlan", app, plan), "the repository is a known location");
    } finally {
      dialogs.restore();
    }
    // Both answers so far follow an own-workspace run (none, then this one), so it stays first.
    assert.deepEqual(dialogs.picks[0], ["Run in its own workspace (recommended)", "Run in this checkout"], "both choices are offered, the recommended one first");
    const launched = await eventually(async () => (await callsOf("run-plan")).slice(before), (lines) => lines.length > 0, `${choice}: run-plan was invoked`);
    const line = launched[0];
    if (managed) {
      assert.match(line, / --managed --target-branch main( |$)/, `own workspace: --managed from the branch checked out here: ${line}`);
      assert.doesNotMatch(line, /--expected-branch/, `and no --expected-branch: ${line}`);
    } else {
      assert.doesNotMatch(line, /--managed|--target-branch/, `this checkout: today's invocation: ${line}`);
      assert.match(line, /--expected-branch main( |$)/, `on the branch checked out here: ${line}`);
    }
    assert.match(line, /--run-key docs-plan-/, `with a run key the extension minted: ${line}`);
  }
  console.log("worktree runs: Run Plan offered its own workspace and this checkout, and launched run-plan with --managed --target-branch or --expected-branch accordingly");
}

/**
 * Merge & clean up on the run in its own workspace: the engine's dry run
 * first, read without a terminal, then the person's confirmation, then
 * exactly the finish-run they confirmed. Cancelling issues nothing.
 */
async function mergeCleanUpAssertions(sibling: string): Promise<void> {
  const ids = (await vscode.commands.executeCommand<string[]>("agentSparring._test.runIds")) ?? [];
  const runId = ids.find((id) => id.startsWith(`${sibling}|`) && id.includes("tidy-1"));
  assert.ok(runId, `the run in its own workspace is discovered: ${JSON.stringify(ids)}`);
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  const app = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const primary = await fs.realpath(app);

  // Cancelled at the confirmation: a dry run, and nothing else.
  let dialogs = stubDialogs(undefined, undefined);
  try {
    await vscode.commands.executeCommand("agentSparring.mergeCleanUp");
  } finally {
    dialogs.restore();
  }
  let finish = await callsOf("finish-run");
  assert.equal(finish.length, 1, `one engine call: ${JSON.stringify(finish)}`);
  assert.equal(finish[0], `finish-run --repo-root ${primary} --run-key tidy-1 --dry-run --json`, "the read-only dry run, from the primary checkout");
  assert.ok(dialogs.asked.includes('Merge "docs/plans/tidy.md" into main and clean up its workspace?'), `the confirmation is asked in plain words: ${JSON.stringify(dialogs.asked)}`);

  // Confirmed: exactly the finish-run the person chose.
  dialogs = stubDialogs(undefined, "Merge & clean up");
  try {
    await vscode.commands.executeCommand("agentSparring.mergeCleanUp");
    finish = await eventually(() => callsOf("finish-run"), (lines) => lines.length >= 3, "the confirmed finish-run is issued");
  } finally {
    dialogs.restore();
  }
  assert.equal(finish[1], `finish-run --repo-root ${primary} --run-key tidy-1 --dry-run --json`, "checked again before anything is changed");
  assert.equal(finish[2], `finish-run --repo-root ${primary} --run-key tidy-1 --json`, "then finish-run without --push-target or --allow-merge-commit, which nobody chose");
  assert.equal(finish.length, 3, "and nothing more");
  console.log("worktree runs: Merge & clean up ran the engine's dry run, issued nothing when cancelled, and exactly the confirmed finish-run otherwise");

}
