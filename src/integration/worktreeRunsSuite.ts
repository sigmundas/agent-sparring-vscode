/**
 * Runs inside the extension host (see runWorktreeRuns.ts). The window's only
 * folder is `app`; the run lives in its sibling worktree `app-agent-run`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  await letteredManifestPlanAssertions();
  await mergeCleanUpAssertions(sibling);
  // Last: a successful Prepare intake creates and checks out a feature branch.
  await prepareIntakeAssertions();
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
function stubDialogs(pick: string | undefined, confirm: string | undefined, typed?: string): { asked: string[]; inputs: vscode.InputBoxOptions[]; picks: string[][]; restore: () => void } {
  const window = vscode.window as unknown as Record<string, unknown>;
  const names = ["showQuickPick", "showInputBox", "showWarningMessage", "showInformationMessage", "showErrorMessage"];
  const originals = names.map((name) => [name, window[name]] as const);
  const asked: string[] = [];
  const inputs: vscode.InputBoxOptions[] = [];
  const picks: string[][] = [];
  window["showQuickPick"] = async (items: readonly vscode.QuickPickItem[]) => {
    picks.push(items.map((item) => item.label));
    return items.find((item) => item.label === pick);
  };
  // An input box is answered with what the person types (`typed`), else with what it proposes.
  window["showInputBox"] = async (options?: vscode.InputBoxOptions) => {
    asked.push(options?.prompt ?? options?.title ?? "input");
    inputs.push(options ?? {});
    return typed ?? options?.value;
  };
  for (const name of ["showWarningMessage", "showInformationMessage", "showErrorMessage"]) {
    window[name] = async (message: string, ...rest: unknown[]) => {
      asked.push(message);
      return rest.find((item) => item === confirm);
    };
  }
  return {
    asked,
    inputs,
    picks,
    restore: () => {
      for (const [name, original] of originals) {
        window[name] = original;
      }
    },
  };
}

/**
 * Run Plan classifies the chosen document with the engine first, then asks
 * where the run goes, and each answer builds its own invocation.
 */
async function runPlanChoiceAssertions(): Promise<void> {
  const app = vscode.workspace.workspaceFolders![0].uri.fsPath;
  await planningInputAssertions(app);
  const plan = path.join(app, "docs-plan.md");
  for (const [choice, managed] of [
    ["Run in its own workspace (recommended)", true],
    ["Run in this checkout", false],
    // Asked again after this checkout was used: the managed run still comes first.
    ["Run in its own workspace (recommended)", true],
  ] as const) {
    const before = (await callsOf("run-plan")).length;
    // In this checkout the person types the branch: nothing is proposed.
    const dialogs = stubDialogs(choice, undefined, managed ? undefined : "main");
    try {
      assert.ok(await vscode.commands.executeCommand<boolean>("agentSparring._test.runPlan", app, plan), "the repository is a known location");
    } finally {
      dialogs.restore();
    }
    assert.deepEqual(dialogs.picks[0], ["Run in its own workspace (recommended)", "Run in this checkout"], "both choices are offered, the managed run first whatever was chosen last");
    if (managed) {
      assert.equal(dialogs.inputs.length, 0, `a managed run asks for no branch: ${JSON.stringify(dialogs.asked)}`);
    } else {
      assert.equal(dialogs.inputs.length, 1, "this checkout asks for the feature branch");
      assert.equal(dialogs.inputs[0].value, "", "the checked-out branch (main) is never proposed as the feature branch");
      assert.match(dialogs.inputs[0].prompt ?? "", /Checked out now: main\./, "it is named as context");
    }
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
  console.log("worktree runs: Run Plan offered its own workspace first and this checkout, asked no branch for a managed run, proposed none in this checkout, and launched run-plan with --managed --target-branch or --expected-branch accordingly");
}

/**
 * A document with no stage sections, chosen on main: the engine's check-plan
 * classifies it first, and its screen — Make Plan… — is the first thing
 * shown. No workspace or branch question, no start-plan or run-plan. Close
 * leaves a neutral view of the repository, not some other plan.
 */
async function planningInputAssertions(app: string): Promise<void> {
  const ideas = path.join(app, "ideas.md");
  // `--help` is the capability probe, not a launch.
  const launches = async () => [...(await callsOf("run-plan")), ...(await callsOf("start-plan"))].filter((line) => !/ --help$/.test(line)).length;
  const before = await launches();
  const dialogs = stubDialogs("Run in this checkout", undefined, "main");
  try {
    assert.ok(await vscode.commands.executeCommand<boolean>("agentSparring._test.runPlan", app, ideas));
  } finally {
    dialogs.restore();
  }
  assert.deepEqual(dialogs.picks, [], "no workspace choice is asked for planning input");
  assert.deepEqual(dialogs.inputs, [], "and no feature branch");
  assert.equal(await launches(), before, "nothing is launched against main");
  const real = await fs.realpath(ideas);
  assert.ok((await callsOf("check-plan")).some((line) => line.startsWith(`check-plan ${real} `) || line.startsWith(`check-plan ${ideas} `)), "the engine classified it");
  type Model = { kind: string; startPlan?: { stateLabel: string; planningInput?: { reason: string }; refusal?: string; planName: string }; emptyLines?: string[] };
  const shown = await vscode.commands.executeCommand<Model>("agentSparring._test.overviewModel");
  assert.equal(shown.kind, "startPlan", "the chosen document is what the Overview shows");
  assert.equal(shown.startPlan?.planName, "ideas.md");
  assert.ok(shown.startPlan?.planningInput, "as planning input: Prepare intake or Make Plan…");
  assert.equal(shown.startPlan?.refusal, undefined, "not as a refusal");
  assert.equal(shown.startPlan?.stateLabel, "Planning input");

  // Prepare intake is the engine's start-plan; this fake engine has none, so
  // it says so — before asking any branch — and launches nothing.
  const prepare = stubDialogs(undefined, undefined, "feature/intake");
  try {
    await vscode.commands.executeCommand("agentSparring._test.startPlanMessage", { type: "startPlan", action: "prepareIntake" });
  } finally {
    prepare.restore();
  }
  assert.deepEqual(prepare.inputs, [], "no branch is asked when the engine cannot prepare an intake");
  assert.ok(prepare.asked.some((line) => /has no start-plan/.test(line)), `the reason is said: ${JSON.stringify(prepare.asked)}`);
  assert.equal(await launches(), before, "and nothing is launched");

  await vscode.commands.executeCommand("agentSparring._test.startPlanMessage", { type: "startPlan", action: "dismiss" });
  const closed = await vscode.commands.executeCommand<Model>("agentSparring._test.overviewModel");
  assert.equal(closed.kind, "empty", `Close returns to a neutral view of the repository: ${JSON.stringify(closed)}`);
  assert.match(closed.emptyLines?.join(" ") ?? "", /Run Plan was closed; nothing was started/);
  console.log("worktree runs: planning input was classified by check-plan before any branch or workspace question, offered Prepare intake and Make Plan…, launched nothing, and Close left a neutral view");
}

type StartPlanModel = { kind: string; startPlan?: { planName: string; planningInput?: { reason: string }; stateLabel: string }; emptyLines?: string[] };

/**
 * Automatic continuation runs a staged plan as the manifest the extension
 * builds. A plan whose raw Markdown the engine refuses (lettered stages) but
 * whose manifest it accepts is still offered the managed run, not stopped
 * at classification. (The fake engine's preflight inputs or the declined
 * confirmation then stop it; nothing runs.)
 */
async function letteredManifestPlanAssertions(): Promise<void> {
  const app = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const settings = vscode.workspace.getConfiguration("agentSparring");
  await settings.update("planContinuation", "automatic", vscode.ConfigurationTarget.Workspace);
  const before = (await callsOf("run-plan")).length;
  const dialogs = stubDialogs("Run in its own workspace (recommended)", undefined);
  try {
    assert.ok(await vscode.commands.executeCommand<boolean>("agentSparring._test.runPlan", app, path.join(app, "lettered.md")));
  } finally {
    dialogs.restore();
    await settings.update("planContinuation", "manual", vscode.ConfigurationTarget.Workspace);
  }
  assert.ok((await callsOf("check-plan")).some((line) => / --manifest --repo-root /.test(line)), "the manifest that would run was checked by the engine");
  assert.deepEqual(dialogs.picks[0], ["Run in its own workspace (recommended)", "Run in this checkout"], `the managed run is offered: ${JSON.stringify(dialogs.asked)}`);
  assert.ok(!dialogs.asked.some((line) => /could not classify|lettered stage numbers/.test(line)), `not refused at classification: ${JSON.stringify(dialogs.asked)}`);
  // `--help` is a capability probe; the managed path's own preflight or confirmation stops it here.
  assert.deepEqual((await callsOf("run-plan")).slice(before).filter((line) => !/ --help$/.test(line)), [], `nothing ran: ${JSON.stringify(dialogs.asked)}`);
  console.log("worktree runs: a lettered plan refused as Markdown but accepted as its manifest was offered the managed run");
}

/**
 * Prepare intake through its real helper, against an engine with start-plan:
 * Close during a cold capability probe and replacement during the branch
 * question both stop it before any branch is changed or start-plan runs; a
 * double click prepares once; and an undisturbed one asks the branch, creates
 * it and hands the document to the engine's start-plan.
 */
async function prepareIntakeAssertions(): Promise<void> {
  const app = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const ideas = path.join(app, "ideas.md");
  const settings = vscode.workspace.getConfiguration("agentSparring");
  const original = settings.get<string>("executable");
  await settings.update("executable", process.env.AGENT_SPARRING_TEST_START_PLAN, vscode.ConfigurationTarget.Workspace);
  const slow = process.env.AGENT_SPARRING_TEST_SLOW_HELP ?? "";
  const prepared = async () => (await callsOf("start-plan")).filter((line) => !/ --help$/.test(line));
  const branch = () => execFileSync("git", ["-C", app, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const show = async (file: string) => {
    const quiet = stubDialogs(undefined, undefined);
    try {
      await vscode.commands.executeCommand("agentSparring._test.runPlan", app, file);
    } finally {
      quiet.restore();
    }
    const model = await vscode.commands.executeCommand<StartPlanModel>("agentSparring._test.overviewModel");
    assert.equal(model.startPlan?.planName, path.basename(file));
    assert.ok(model.startPlan?.planningInput);
  };
  const prepare = () => vscode.commands.executeCommand("agentSparring._test.startPlanMessage", { type: "startPlan", action: "prepareIntake" });
  try {
    // Closed while the cold `start-plan --help` probe is still running.
    await show(ideas);
    await fs.writeFile(slow, "");
    let dialogs = stubDialogs(undefined, "Create branch", "feature/intake");
    try {
      const pending = prepare();
      await eventually(() => callsOf("start-plan"), (lines) => lines.some((line) => / --help$/.test(line)), "the capability probe started");
      await vscode.commands.executeCommand("agentSparring._test.startPlanMessage", { type: "startPlan", action: "dismiss" });
      await pending;
    } finally {
      dialogs.restore();
      await fs.rm(slow, { force: true });
    }
    assert.deepEqual(dialogs.inputs, [], "no branch is asked after Close");
    assert.deepEqual(await prepared(), [], "and start-plan never runs");
    assert.equal(branch(), "main", "nothing was checked out");
    assert.equal((await vscode.commands.executeCommand<StartPlanModel>("agentSparring._test.overviewModel")).kind, "empty", "Close stays closed");

    // Replaced by another document while the branch is being asked.
    await show(ideas);
    dialogs = stubDialogs(undefined, "Create branch", "feature/intake");
    const window = vscode.window as unknown as Record<string, unknown>;
    const answer = window["showInputBox"] as (options?: vscode.InputBoxOptions) => Promise<string | undefined>;
    window["showInputBox"] = async (options?: vscode.InputBoxOptions) => {
      await vscode.commands.executeCommand("agentSparring._test.runPlan", app, path.join(app, "more-ideas.md"));
      return answer(options);
    };
    try {
      await prepare();
    } finally {
      dialogs.restore();
    }
    assert.equal(dialogs.inputs.length, 1, "the branch was asked once");
    assert.deepEqual(await prepared(), [], "the replaced document is not prepared");
    assert.equal(branch(), "main", "and no branch was created for it");
    const replaced = await vscode.commands.executeCommand<StartPlanModel>("agentSparring._test.overviewModel");
    assert.equal(replaced.startPlan?.planName, "more-ideas.md", "the newer document stays on screen");

    // Closed while the branch is being prepared: after the person confirmed
    // Create branch, while the pre-write reads run, the screen goes away.
    await show(ideas);
    dialogs = stubDialogs(undefined, "Create branch", "feature/intake");
    const confirm = window["showInformationMessage"] as (message: string, ...rest: unknown[]) => Promise<unknown>;
    window["showInformationMessage"] = async (message: string, ...rest: unknown[]) => {
      const choice = await confirm(message, ...rest);
      if (choice === "Create branch") {
        await vscode.commands.executeCommand("agentSparring._test.startPlanMessage", { type: "startPlan", action: "dismiss" });
      }
      return choice;
    };
    try {
      await prepare();
    } finally {
      dialogs.restore();
    }
    assert.ok(dialogs.asked.some((line) => /^Create feature\/intake/.test(line)), `the branch was confirmed: ${JSON.stringify(dialogs.asked)}`);
    assert.equal(branch(), "main", "but closed before the write, so it was not created");
    assert.ok(!execFileSync("git", ["-C", app, "branch", "--list", "feature/intake"], { encoding: "utf8" }).trim(), "no branch exists");
    assert.deepEqual(await prepared(), []);

    // Replaced by a runnable document whose workspace question is then dismissed.
    await show(ideas);
    dialogs = stubDialogs(undefined, "Create branch", "feature/intake");
    const typed = window["showInputBox"] as (options?: vscode.InputBoxOptions) => Promise<string | undefined>;
    window["showInputBox"] = async (options?: vscode.InputBoxOptions) => {
      await vscode.commands.executeCommand("agentSparring._test.runPlan", app, path.join(app, "docs-plan.md"));
      return typed(options);
    };
    try {
      await prepare();
    } finally {
      dialogs.restore();
    }
    assert.ok(dialogs.picks.length > 0, "the runnable document reached its workspace question");
    assert.equal(branch(), "main", "the replaced intake did not change the branch");
    assert.deepEqual(await prepared(), [], "nor prepare");

    // Undisturbed, clicked twice: one branch question, one start-plan.
    await show(ideas);
    dialogs = stubDialogs(undefined, "Create branch", "feature/intake");
    try {
      await Promise.all([prepare(), prepare()]);
      await eventually(prepared, (lines) => lines.length > 0, "start-plan was invoked");
    } finally {
      dialogs.restore();
    }
    assert.equal(dialogs.inputs.length, 1, `the branch is asked once: ${JSON.stringify(dialogs.asked)}`);
    assert.equal(dialogs.inputs[0].value, "", "main is not proposed");
    assert.equal(branch(), "feature/intake", "the feature branch was created and checked out");
    const runs = await prepared();
    assert.equal(runs.length, 1, `prepared once: ${JSON.stringify(runs)}`);
    assert.match(runs[0], /ideas\.md .*--expected-branch feature\/intake/, runs[0]);
    console.log("worktree runs: Prepare intake stopped when closed during the cold probe or replaced during the branch question, prepared once on a double click, and otherwise created the branch and ran start-plan");
  } finally {
    await settings.update("executable", original, vscode.ConfigurationTarget.Workspace);
    execFileSync("git", ["-C", app, "checkout", "-q", "main"]);
  }
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
