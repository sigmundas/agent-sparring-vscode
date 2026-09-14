/**
 * Runs inside the extension host (see runTests.ts). Uses the real
 * `vscode.workspace.workspaceFolders`, the real activation path, the
 * production commands and real integrated terminals with a fake `sparring`
 * executable, so runner lifecycle is exercised end to end: shell execution
 * start → Running; exit / Ctrl-C → Stopped despite telemetry that never
 * records turn.finished; stale telemetry at activation → never Running.
 *
 * Developer: Reload Window is not automated here: reloading the window
 * tears down this test host. See README "Manual verification".
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { DiscoveryDiagnostic } from "../core/diagnose";
import { discoverRuns, selectRun } from "../core/discovery";
import { isHumanCheckMessage, renderOverviewHtml } from "../core/overviewHtml";
import { withHumanCheck, type HumanCheckDrafts } from "../core/humanChecks";
import type { ExecutionRecord, LivenessState, RunnerLiveness } from "../core/liveness";
import { buildOverviewModel, type ManifestStageView, type OverviewArtifacts } from "../core/overviewModel";

const STAGES = ["stage-reported-statistics-contract", "stage-reported-statistics-local-schema-barrier", "stage-reported-statistics-typed-parser", "stage-review-complete", "stage-review-complete-dirty", "stage-stale-turn"];

interface LivenessReport {
  state: LivenessState;
  source: RunnerLiveness["source"];
  turnActive: boolean;
  interrupted: boolean;
  detail: string;
  execution?: ExecutionRecord;
}

export async function run(): Promise<void> {
  const fixtureRoot = process.env.AGENT_SPARRING_FIXTURE;
  assert.ok(fixtureRoot, "AGENT_SPARRING_FIXTURE must point at the generated workspace");
  const reportedRepo = path.join(fixtureRoot, "sporely-py-reported-statistics");

  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.equal(folders.length, 2, "the window is the two-folder multi-root workspace");
  assert.deepEqual(
    folders.map((folder) => [folder.uri.scheme, folder.name]),
    [
      ["file", "sporely"],
      ["file", "sporely-py-reported-statistics"],
    ],
  );

  const extension = vscode.extensions.getExtension("sintef.agent-sparring-vscode");
  assert.ok(extension, "extension is installed in the test host");
  await extension.activate();
  await vscode.commands.executeCommand("agentSparring.refresh");
  const report = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;

  // AGENT_SPARRING_IT_ONLY=accept,plan runs a subset of sections (a development aid
  // when one section is being worked on); unset, everything runs in order.
  const sections: [string, () => Promise<void>][] = [
    ["discovery", () => discoveryAssertions(report, fixtureRoot)],
    ["stale", () => staleTelemetryAssertions(report, reportedRepo)],
    ["launched", () => launchedRunnerAssertions(report, reportedRepo)],
    ["observed", () => observedTerminalAssertions(report, reportedRepo)],
    ["bare", () => bareExecutableAssertions(report, reportedRepo, fixtureRoot)],
    ["notfound", () => commandNotFoundAssertions(report, reportedRepo)],
    ["accept", () => acceptStageAssertions(report, reportedRepo)],
    ["plan", () => planAssociationAssertions(report, reportedRepo, fixtureRoot)],
    ["gate", () => gateClickAssertions()],
    ["evidence", () => evidenceLaunchAssertions(reportedRepo, fixtureRoot)],
    ["advance", () => advancementAssertions(reportedRepo)],
    ["terminals", () => terminalReuseAssertions(report, reportedRepo)],
    ["closed", () => closedTerminalAssertions(report, reportedRepo)],
  ];
  const only = (process.env.AGENT_SPARRING_IT_ONLY ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  for (const [name, section] of sections) {
    if (only.length === 0 || only.includes(name)) {
      await section();
    }
  }
  console.log(only.length > 0 ? `integration: sections ${only.join(", ")} verified` : "integration: discovery, stale telemetry, launched runner exit, Ctrl-C, observed terminal command, bare executable via the shell, command-not-found, Accept stage, plan association and the structured-gate click path all verified");
}

// ---------------------------------------------------------------- discovery (unchanged shape)

async function discoveryAssertions(report: DiscoveryDiagnostic, fixtureRoot: string): Promise<void> {
  const reported = report.folders[1];
  assert.equal(reported.fsPath, path.join(fixtureRoot, "sporely-py-reported-statistics"));
  assert.equal(reported.probed, path.join(reported.fsPath, ".sparring"));
  assert.equal(reported.sparringExists, true);
  assert.equal(reported.locations.length, 1);
  const location = reported.locations[0];
  assert.equal(location.nested, false);
  assert.equal(location.configExists, false, "no .sparring/project.toml is required");
  assert.equal(location.plansExists, false, "no plan run is required");
  assert.deepEqual(
    location.stages.map((stage) => [stage.name, stage.stateExists, stage.parsed, stage.status]),
    [
      [STAGES[0], true, true, "accepted"],
      [STAGES[1], true, true, "accepted"],
      [STAGES[2], true, true, "working"],
      [STAGES[3], true, true, "working"],
      [STAGES[4], true, true, "working"],
      [STAGES[5], true, true, "working"],
    ],
  );
  assert.equal(location.runIds.length, 6, "the second workspace folder produces recorded runs");

  const sporely = report.folders[0];
  assert.equal(sporely.sparringExists, true);
  assert.equal(sporely.locations.length, 2);
  assert.equal(sporely.locations[0].nested, false);
  assert.equal(sporely.locations[0].runIds.length, 0);
  assert.equal(sporely.locations[1].nested, true);
  assert.equal(sporely.locations[1].projectDir, path.join(sporely.fsPath, "nested-repo"));
  assert.equal(sporely.locations[1].runIds.length, 1);

  assert.equal(report.runs.length, 7);
  for (const stage of STAGES) {
    assert.ok(
      report.pickLabels.some((label) => label.includes(`sporely-py-reported-statistics: ${stage}`)),
      `Select Repository / Run lists ${stage}`,
    );
  }
  assert.ok(report.pickLabels.some((label) => label.includes("nested-repo: stage-nested-only")));
  // Five open stages in two repositories: ambiguous, never guessed, and the report says so.
  assert.equal(report.ambiguousIds.length, 5);
  assert.equal(report.selectedId, undefined);
  assert.match(report.noSelectionReason ?? "", /5 runs look active/);
}

// ---------------------------------------------------------------- stale telemetry at activation

async function staleTelemetryAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  const staleId = runIdOf(report, reportedRepo, "stage-stale-turn");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", staleId), staleId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  const liveness = await livenessOf(staleId);
  assert.notEqual(liveness.state, "running", "a replayed turn.started is never promoted to Running");

  if (process.platform !== "darwin" && process.platform !== "linux") {
    assert.equal(liveness.state, "unknown", "without a process table there is nothing to resolve it with");
    assert.equal(liveness.source, "telemetry");
    assert.equal(liveness.execution, undefined);
    return;
  }

  // On a platform with `ps` the extension does not stop at "unknown": no
  // sparring runner exists for this project, so the replayed turn cannot be
  // executing and the run is stopped. Leaving it unknown for ever was the
  // dead end that hid Resume plan (see core/runnerProcesses.ts).
  assert.equal(liveness.state, "stopped", "the process table settles it");
  assert.equal(liveness.source, "execution");
  assert.equal(liveness.execution?.source, "probed", "and says so: nothing in this window watched that runner");
  assert.equal(liveness.interrupted, true, "the turn was open when the runner disappeared");
  assert.equal(liveness.turnActive, false, "so no turn is presented as in progress");
  assert.match(liveness.detail, /no longer running/);
}

// ---------------------------------------------------------------- launched runner: exit, then Ctrl-C

async function launchedRunnerAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  assert.equal((await livenessOf(runId)).state, "unknown");
  assert.equal((await livenessOf(runId)).turnActive, false);

  // Run 1: the fake runner writes turn.started, never turn.finished, and exits 3 after ~4 s.
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=4\nexit_with=3\n");
  await vscode.commands.executeCommand("agentSparring.runStage");
  let running = await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "runner observed alive after Run stage");
  assert.ok(running.execution?.source === "launched" || running.execution?.source === "terminal", `exact source, got ${running.execution?.source}`);
  console.log(`integration: run 1 observed via ${running.execution?.source}`);
  running = await waitFor(runId, (liveness) => liveness.turnActive, 10_000, "fake telemetry turn.started reaches the fold while running");
  assert.equal(running.state, "running");

  const stopped = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "liveness clears when the process exits, without any turn.finished");
  assert.equal(stopped.interrupted, true, "an unmatched turn at exit is presented as interrupted");
  assert.equal(stopped.turnActive, false, "the duration stops: no active turn is presented");
  assert.equal(stopped.execution?.state, "ended");
  if (stopped.execution?.exitCode !== undefined) {
    assert.equal(stopped.execution.exitCode, 3, "the shell-reported exit code is kept when available");
  }
  const activity = await fs.readFile(path.join(reportedRepo, ".sparring", "stages", "stage-reported-statistics-typed-parser", "activity.jsonl"), "utf8");
  assert.ok(!activity.includes("turn.finished"), "the fixture never wrote turn.finished; the UI did not wait for it");

  // Run 2: a long-running fake, interrupted with Ctrl-C through the extension's Stop.
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=120\nexit_with=0\n");
  await vscode.commands.executeCommand("agentSparring.runStage");
  const second = await waitFor(runId, (liveness) => liveness.state === "running" && liveness.execution?.startedAtMs !== stopped.execution?.startedAtMs, 15_000, "a second launch after a known stop is Running again");
  assert.notEqual(second.execution?.id, stopped.execution?.id);
  await waitFor(runId, (liveness) => liveness.turnActive, 10_000, "run 2 telemetry");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.stop", runId), true, "Stop reaches the hosting terminal");
  const interrupted = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "Ctrl-C ends the execution");
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.turnActive, false);
  console.log(`integration: Ctrl-C exit code reported as ${String(interrupted.execution?.exitCode)}`);
}

// ---------------------------------------------------------------- a command typed by the user in a terminal

async function observedTerminalAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  const terminal = vscode.window.createTerminal({ name: "user terminal", cwd: reportedRepo });
  const integration = await shellIntegrationFor(terminal, 8000);
  if (!integration) {
    terminal.dispose();
    console.log("integration: shell integration did not activate for a plain terminal in this host; observed-command scenario skipped");
    return;
  }
  const executable = vscode.workspace.getConfiguration("agentSparring").get<string>("executable") ?? "";
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=4\nexit_with=0\n");
  // Typed as a user would; only shell integration's start event tells the extension about it.
  terminal.sendText(`${executable} run-loop stage-reported-statistics-typed-parser --repo-root . --expected-branch feature/reported-statistics`, true);
  const running = await waitFor(runId, (liveness) => liveness.state === "running" && liveness.execution?.source === "observed", 15_000, "a typed sparring command is observed as an exact execution");
  assert.equal(running.execution?.kind, "run-loop");
  const stopped = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "its end is observed too");
  assert.equal(stopped.interrupted, true, "again no turn.finished was ever written");
  terminal.dispose();
}

// ---------------------------------------------------------------- bare `sparring` resolved by the shell, not the extension host

interface ModelReport {
  stageStatus?: string;
  stageLine?: string;
  runKind?: string;
  stageAction?: { kind: string; label: string; primary: boolean };
  secondaryAction?: { kind: string; label: string };
  banner?: { kind: string; text: string };
  actions?: { plan: boolean; choosePlan: boolean; changePlan: boolean; matchStage: boolean };
  stageId?: string;
  stageHeading?: string;
  followPlan?: { runId: string; label: string; text: string };
  continueAutomatically?: { label: string; kind: string };
  plan?: { source: string; name: string; current?: string; matched?: string; next?: { display: string; line: number; summary?: string } };
  whatsNext?: { kind: string; heading?: string; summary?: string; text: string; hints?: string[]; start?: { stageId: string; label: string } };
}

interface StartOutcome {
  ok: boolean;
  stageId?: string;
  runId?: string;
  reason?: string;
  brief?: string;
}

async function shellIntegrationAvailable(cwd: string): Promise<boolean> {
  const terminal = vscode.window.createTerminal({ name: "probe", cwd });
  const integration = await shellIntegrationFor(terminal, 8000);
  terminal.dispose();
  return integration !== undefined;
}

async function bareExecutableAssertions(report: DiscoveryDiagnostic, reportedRepo: string, fixtureRoot: string): Promise<void> {
  const fakeBin = path.join(fixtureRoot, "bin");
  assert.ok(!(process.env.PATH ?? "").split(path.delimiter).includes(fakeBin), "the extension host's PATH must not contain the fake: only the integrated shell's does");
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; bare-executable scenario skipped");
    return;
  }
  const configuration = vscode.workspace.getConfiguration("agentSparring");
  const original = configuration.inspect<string>("executable")?.workspaceValue;
  await configuration.update("executable", "", vscode.ConfigurationTarget.Workspace);
  try {
    const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
    assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
    await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=3\nexit_with=0\n");
    await vscode.commands.executeCommand("agentSparring.runStage");
    const running = await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "bare `sparring` launched through the shell is observed alive (no extension-host PATH precheck)");
    assert.equal(running.execution?.source, "launched", "handed to the shell through shell integration");
    const stopped = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and it ends normally");
    assert.equal(stopped.execution?.exitCode, 0);
    console.log("integration: bare `sparring` resolved by the integrated shell although the extension host cannot see it");
  } finally {
    await configuration.update("executable", original, vscode.ConfigurationTarget.Workspace);
  }
}

// ---------------------------------------------------------------- the shell itself reports command-not-found

async function commandNotFoundAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; command-not-found scenario skipped");
    return;
  }
  const configuration = vscode.workspace.getConfiguration("agentSparring");
  const original = configuration.inspect<string>("executable")?.workspaceValue;
  const missingWord = "sparring-missing-for-agent-sparring-test";
  await configuration.update("executable", missingWord, vscode.ConfigurationTarget.Workspace);
  try {
    const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
    assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
    await vscode.commands.executeCommand("agentSparring.runStage");
    const deadline = Date.now() + 15_000;
    let seen: { runId: string; word: string; exitCode: number } | undefined;
    while (Date.now() < deadline && !seen) {
      seen = (await vscode.commands.executeCommand("agentSparring._test.lastCommandNotFound")) as typeof seen;
      if (!seen) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(seen, "the shell's command-not-found exit is recognised and reported as a configuration problem");
    assert.equal(seen.word, missingWord);
    assert.equal(seen.runId, runId);
    assert.equal(seen.exitCode, 127);
    const liveness = await livenessOf(runId);
    assert.equal(liveness.state, "stopped", "a not-found launch is never left Running");
    console.log(`integration: command-not-found reported for '${missingWord}' with exit ${seen.exitCode}`);
  } finally {
    await configuration.update("executable", original, vscode.ConfigurationTarget.Workspace);
  }
}

// ---------------------------------------------------------------- Accept stage: freeze, then accept

async function acceptStageAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  const callsLog = path.join(reportedRepo, ".sparring", "fake-calls.log");
  const stateOf = async (stage: string) => JSON.parse(await fs.readFile(path.join(reportedRepo, ".sparring", "stages", stage, "state.json"), "utf8")) as { status: string; candidate_sha: string | null };
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;

  // Success: freeze then accept, in order, as one action.
  const okId = runIdOf(report, reportedRepo, "stage-review-complete");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", okId), okId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  let before = await model();
  assert.equal(before.stageStatus, "Review complete");
  assert.equal(before.stageAction?.label, "Accept stage");
  assert.equal(before.secondaryAction?.label, "Run loop again");
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");
  await fs.rm(callsLog, { force: true });
  const result = (await vscode.commands.executeCommand("agentSparring._test.acceptStage")) as { ok: boolean; step?: string; message?: string; candidateSha?: string } | undefined;
  assert.ok(result, "Accept stage ran");
  assert.equal(result.ok, true, `Accept stage succeeded: ${JSON.stringify(result)}`);
  assert.equal(result.candidateSha, "c0ffee0000000000000000000000000000000000", "the accepted SHA is read back from the engine's output");
  const calls = (await fs.readFile(callsLog, "utf8")).trim().split("\n");
  assert.deepEqual(calls, ["freeze-candidate stage-review-complete", "accept-candidate stage-review-complete"], "freeze first, accept second, nothing else");
  assert.equal((await stateOf("stage-review-complete")).status, "accepted");
  await vscode.commands.executeCommand("agentSparring.refresh");
  const after = await model();
  assert.equal(after.stageStatus, "Accepted", "the existing Overview refreshed to the accepted state");
  assert.equal(after.stageLine, "Stage complete.");
  assert.equal(after.stageAction, undefined);
  assert.equal(after.banner, undefined, "no third acceptance indicator");
  assert.equal(after.whatsNext?.kind, "choose", "the accepted screen asks for a plan to say what comes next");

  // Refusal at the first step: the second command is never issued, wording is the user's.
  const dirtyId = runIdOf(report, reportedRepo, "stage-review-complete-dirty");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", dirtyId), dirtyId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  before = await model();
  assert.equal(before.stageAction?.label, "Accept stage");
  await fs.writeFile(
    path.join(reportedRepo, ".sparring", "fake-runner.conf"),
    "sleep_for=1\nexit_with=0\nfreeze_refusal='refusing to freeze c0ffee as the candidate for stage x: the working tree holds changes that commit does not represent (src/a.py). Commit or discard them first.'\n",
  );
  await fs.rm(callsLog, { force: true });
  const refused = (await vscode.commands.executeCommand("agentSparring._test.acceptStage")) as { ok: boolean; step?: string; message?: string; detail?: string } | undefined;
  assert.ok(refused);
  assert.equal(refused.ok, false);
  assert.equal(refused.step, "freeze");
  assert.match(refused.message ?? "", /uncommitted changes/, `engine stderr was read and translated (detail: ${JSON.stringify(refused.detail)})`);
  assert.deepEqual((await fs.readFile(callsLog, "utf8")).trim().split("\n"), ["freeze-candidate stage-review-complete-dirty"], "accept-candidate is never called after a refused freeze");
  assert.equal((await stateOf("stage-review-complete-dirty")).status, "working");
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");
  console.log("integration: Accept stage ran freeze then accept; a refused freeze stopped before accept with translated wording");
}

// ---------------------------------------------------------------- plan association (VS Code state only)

async function planAssociationAssertions(report: DiscoveryDiagnostic, reportedRepo: string, fixtureRoot: string): Promise<void> {
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const runId = runIdOf(report, reportedRepo, "stage-review-complete");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  const none = await model();
  assert.equal(none.actions?.choosePlan, true);
  assert.equal(none.actions?.plan, false);

  // The plan may live anywhere: here outside the repository entirely.
  const planFile = path.join(fixtureRoot, "notes", "roadmap.md");
  await fs.mkdir(path.dirname(planFile), { recursive: true });
  await fs.writeFile(planFile, "# Roadmap\n\n## Stage 1 — Review complete\n\n## Stage 2 — Cloud schema and synchronization\n");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.associatePlan", planFile), planFile);
  const associated = await model();
  assert.equal(associated.runKind, "Standalone stage", "still standalone: no managed plan run was invented");
  assert.equal(associated.actions?.plan, true);
  assert.equal(associated.actions?.changePlan, true);
  assert.equal(associated.plan?.source, "associated");
  assert.equal(associated.plan?.current, "Stage 1 — Review complete");
  assert.equal(associated.plan?.matched, "id");
  assert.equal(associated.plan?.next?.display, "Stage 2 — Cloud schema and synchronization");
  assert.equal(associated.whatsNext?.kind, "next-stage", "the stage was accepted earlier in this run");
  assert.equal(associated.whatsNext?.heading, "Stage 2 — Cloud schema and synchronization");
  const stageDir = path.join(reportedRepo, ".sparring", "stages", "stage-review-complete");
  assert.deepEqual((await fs.readdir(stageDir)).sort(), ["sparring.md", "state.json"], "the association never touches engine state");

  // A plan whose headings do not name the stage: the Overview asks; the user's pick is kept in workspace state.
  const rangePlan = path.join(fixtureRoot, "notes", "range.md");
  await fs.writeFile(rangePlan, "# Range semantics\n\n## Stage 3A — Contract\n\n## Stage 3B — Barrier\n\nThe barrier.\n\n## Stage 3C — Cloud schema\n\nCloud side.\n");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.associatePlan", rangePlan), rangePlan);
  const unmatched = await model();
  assert.equal(unmatched.plan?.current, undefined);
  assert.equal(unmatched.actions?.matchStage, true);
  assert.equal(unmatched.whatsNext?.kind, "match");
  assert.deepEqual(await vscode.commands.executeCommand("agentSparring._test.matchStage", { label: "3B", title: "Barrier" }), { label: "3B", title: "Barrier" });
  const matched = await model();
  assert.equal(matched.plan?.current, "Stage 3B — Barrier");
  assert.equal(matched.plan?.matched, "manual");
  assert.deepEqual(matched.whatsNext && [matched.whatsNext.kind, matched.whatsNext.heading, matched.whatsNext.summary], ["next-stage", "Stage 3C — Cloud schema", "Cloud side."]);
  assert.deepEqual((await fs.readdir(stageDir)).sort(), ["sparring.md", "state.json"], "a manual match never touches engine state either");
  // Changing the match, and a match kept across a fresh discovery (the same workspace state a reload restores).
  assert.deepEqual(await vscode.commands.executeCommand("agentSparring._test.matchStage", { label: "3C", title: "Cloud schema" }), { label: "3C", title: "Cloud schema" });
  await vscode.commands.executeCommand("agentSparring.refresh");
  const changed = await model();
  assert.equal(changed.plan?.current, "Stage 3C — Cloud schema");
  assert.equal(changed.whatsNext?.kind, "last-stage");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.matchStage", undefined), undefined);
  assert.equal((await model()).whatsNext?.kind, "match", "removing the match returns to asking");

  assert.equal(await vscode.commands.executeCommand("agentSparring._test.associatePlan", undefined), undefined);
  const removed = await model();
  assert.equal(removed.actions?.choosePlan, true);
  assert.equal(removed.plan, undefined);
  assert.equal(removed.whatsNext?.kind, "choose");
  console.log("integration: plan association and manual heading match stored, displayed, changed and removed without touching engine state");
  await startNextStageAssertions(report, reportedRepo, rangePlan);
}

// ---------------------------------------------------------------- Start next stage: the engine's new-stage, through the configured executable

async function startNextStageAssertions(report: DiscoveryDiagnostic, reportedRepo: string, rangePlan: string): Promise<void> {
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const callsLog = path.join(reportedRepo, ".sparring", "fake-calls.log");
  const runId = runIdOf(report, reportedRepo, "stage-review-complete");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.associatePlan", rangePlan), rangePlan);
  await vscode.commands.executeCommand("agentSparring._test.matchStage", { label: "3B", title: "Barrier" });
  const before = await model();
  assert.equal(before.whatsNext?.kind, "next-stage");
  assert.equal(before.whatsNext?.start?.stageId, "stage-3c-cloud-schema");
  await fs.rm(callsLog, { force: true });
  const outcome = (await vscode.commands.executeCommand("agentSparring._test.startNextStage")) as StartOutcome | undefined;
  assert.ok(outcome?.ok, `Start next stage succeeded: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.stageId, "stage-3c-cloud-schema");
  assert.deepEqual((await fs.readFile(callsLog, "utf8")).trim().split("\n"), ["new-stage stage-3c-cloud-schema --brief-file"], "exactly one engine command, with the brief handed over by file, via the configured fake executable");
  const created = path.join(reportedRepo, ".sparring", "stages", "stage-3c-cloud-schema");
  assert.deepEqual((await fs.readdir(created)).sort(), ["brief.md", "state.json"], "the engine wrote the stage; the extension wrote nothing under .sparring");
  const expectedBrief = "# Stage brief: stage-3c-cloud-schema\n\nStage 3C from plan `range.md`. Implement only this section; the other stages are separate.\n\n## Stage 3C — Cloud schema\n\nCloud side.\n";
  assert.equal(await fs.readFile(path.join(created, "brief.md"), "utf8"), expectedBrief, "the brief is the plan's Stage 3C section verbatim under the engine's brief header");
  assert.equal(outcome.brief, expectedBrief);
  const after = await model();
  assert.equal(after.runKind, "Standalone stage");
  assert.equal(after.stageStatus, "Ready to start", "the Overview switched to the new, never-run stage");
  assert.equal(after.stageLine, "Ready to start. Run stage begins implementation.");
  assert.equal(after.stageAction?.label, "Run stage", "Run stage is the next primary action; no loop was launched");
  assert.equal(after.plan?.current, "Stage 3C — Cloud schema", "the plan association and its match followed the new stage");
  assert.equal(after.plan?.matched, "manual");
  assert.equal(after.whatsNext, undefined, "not accepted yet");
  // Starting again from the previous stage finds the existing directory and creates nothing.
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await fs.rm(callsLog, { force: true });
  const again = (await vscode.commands.executeCommand("agentSparring._test.startNextStage")) as StartOutcome | undefined;
  assert.deepEqual(again && [again.ok, again.reason, again.stageId], [false, "exists", "stage-3c-cloud-schema"]);
  assert.equal(await fs.readFile(callsLog, "utf8").catch(() => ""), "", "no engine command was issued for an existing stage");
  await vscode.commands.executeCommand("agentSparring._test.associatePlan", undefined);
  console.log("integration: Start next stage created the next stage with the engine's new-stage through the configured executable and carried the plan match over");
}

// ---------------------------------------------------------------- a structured gate's Pass button, clicked for real

const GATE_STAGE = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const GATE_PLAN_KEY = "reported-statistics-1cd13d24";
const GATE_PLAN_LABEL = "plans/reported-statistics.md";
/** The reviewer's stable check id: a slug, which is exactly the shape the host used to refuse. */
const GATE_CHECK_ID = "pre-activation-desktop-v2-feed";

/**
 * The one thing a rendered snapshot cannot show: that clicking Pass does
 * anything.
 *
 * A real Chromium webview inside this real VS Code renders the document the
 * Overview renders, its own shipped script binds the click listener, a real
 * `click()` on the real button bubbles to it, and the message it posts
 * arrives over VS Code's own webview channel. The host's parser then decides
 * whether that message is usable — the step that dropped every structured
 * gate's message — and the draft it produces is fed back through the model.
 *
 * The panel this uses is the test's own: the extension's Overview cannot be
 * clicked from here, and its handler is one line (`isHumanCheckMessage(m) →
 * recordHumanCheck`) covered by the unit tests. Everything else on the wire
 * is the shipped code, running where it really runs.
 */
async function gateClickAssertions(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-gate-"));
  const stages = path.join(root, ".sparring", "stages");
  await fs.mkdir(path.join(stages, GATE_STAGE), { recursive: true });
  await fs.mkdir(path.join(stages, "stage-1-contract"), { recursive: true });
  await fs.writeFile(path.join(stages, "stage-1-contract", "state.json"), JSON.stringify({ status: "accepted", base_sha: null, candidate_sha: "c".repeat(40), implementation_session_id: null, sparring_session_id: null }));
  await fs.writeFile(path.join(stages, GATE_STAGE, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl", sparring_session_id: "spar" }));
  await fs.writeFile(path.join(stages, GATE_STAGE, "sparring.md"), gateSparring());
  await fs.mkdir(path.join(root, ".sparring", "plans"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".sparring", "plans", `${GATE_PLAN_KEY}.json`),
    JSON.stringify({ current_stage: GATE_STAGE, current_stage_index: 1, expected_branch: "feature/x", plan: GATE_PLAN_LABEL, plan_digest: "0".repeat(64), source: "manifest", status: "paused" }),
  );
  await fs.mkdir(path.join(root, "plans"), { recursive: true });
  await fs.writeFile(path.join(root, "plans", "reported-statistics.md"), "# Reported statistics\n\n## Stage 3D — Snapshot v2 and attachment/export/import transport\n\nThe transport.\n");

  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
  const manifestStages: ManifestStageView[] = [
    { stageId: "stage-1-contract", label: "Stage 1", title: "Contract", status: "accepted" },
    { stageId: GATE_STAGE, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport", status: "working" },
  ];
  const selection = selectRun((await discoverRuns([location])).runs);
  const runId = selection.selected?.id;
  assert.ok(runId, "the managed plan run is discovered");
  const view = (drafts: HumanCheckDrafts) => {
    const artifacts: OverviewArtifacts = { handoff: false, sparring: true, brief: false, plan: false, git: { branch: "feature/x" }, humanChecks: drafts[runId] ?? {}, manifestStages };
    return buildOverviewModel(selection, undefined, artifacts, Date.now());
  };

  const before = view({});
  assert.equal(before.actionRequired?.required[0]?.key, GATE_CHECK_ID, "the gate's own id is the control's key");
  assert.equal(before.actionRequired?.progress, "0 / 1 verified");
  assert.equal(before.actionRequired?.submit.enabled, false);

  const nonce = crypto.randomBytes(16).toString("base64");
  const panel = vscode.window.createWebviewPanel("agentSparring.gateClickTest", "gate click", { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
  try {
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message arrived from the webview within 15s")), 15_000);
      panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
        if (message?.["type"] === "humanCheck") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    // The document the Overview renders, plus one script that clicks the
    // button a person would click. The click is a real DOM event; everything
    // it reaches is the shipped listener.
    const clicker = `<script nonce="${nonce}">document.querySelector('button[data-outcome="pass"]').click();</script>`;
    panel.webview.html = renderOverviewHtml(before, nonce, panel.webview.cspSource).replace("</body>", `${clicker}</body>`);
    const message = await received;

    assert.deepEqual(message, { type: "humanCheck", key: GATE_CHECK_ID, outcome: "pass" }, "the click posted the gate's id and the outcome");
    assert.ok(isHumanCheckMessage(message), "and the host accepts it — this is what silently failed");

    const after = view(withHumanCheck({}, runId, message.key as string, { outcome: "pass" }));
    assert.equal(after.actionRequired?.required[0]?.record?.outcome, "pass");
    assert.equal(after.actionRequired?.progress, "1 / 1 verified");
    assert.equal(after.actionRequired?.submit.enabled, true);
    const html = renderOverviewHtml(after, nonce, panel.webview.cspSource);
    assert.match(html, new RegExp(`class="choice pass on" data-check="${GATE_CHECK_ID}"`), "Pass is visibly selected on the next render");
    assert.match(html, /data-action="submitForReview" title="[^"]*">Submit result and continue</, "and Submit result and continue is enabled");
  } finally {
    panel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the managed run advances, and the cockpit follows

/**
 * Stage 3D on its own, explicitly chosen; then a managed plan run adopts it,
 * accepts it and advances to Stage 4. The Overview must follow the managed
 * run — the reported bug was that it kept showing
 * "Standalone stage · Stage 3D · Accepted" and the actions that go with it.
 *
 * The plan document is written the way the real one is, with `## Stage 3D
 * handoff — …` records above the stage sections: the engine-shaped parser
 * refuses it, so the plan run claims no stage list and the stage it advances
 * past really does become a standalone run again.
 */
async function advancementAssertions(reportedRepo: string): Promise<void> {
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const sparring = path.join(reportedRepo, ".sparring");
  const planState = path.join(sparring, "plans", `${GATE_PLAN_KEY}.json`);
  const stage4 = "stage-4-editor-and-ui-inspection-and-guarded-editing";
  await fs.mkdir(path.join(reportedRepo, "plans"), { recursive: true });
  await fs.mkdir(path.join(sparring, "plans"), { recursive: true });
  await fs.mkdir(path.join(sparring, "stages", GATE_STAGE), { recursive: true });
  await fs.writeFile(
    path.join(reportedRepo, "plans", "reported-statistics.md"),
    [
      "# Reported statistics",
      "",
      "## Stage 3D handoff — 2026-09-14 (current stage)",
      "",
      "Status: implemented and self-verified.",
      "",
      "## Stage 3D — Snapshot v2 and attachment/export/import transport",
      "",
      "The transport.",
      "",
      "## Stage 4 — Editor and UI inspection and guarded editing",
      "",
      "The editor.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(sparring, "stages", GATE_STAGE, "state.json"), JSON.stringify({ status: "accepted", base_sha: null, candidate_sha: "c".repeat(40), implementation_session_id: "impl", sparring_session_id: "spar" }));

  // Before adoption: Stage 3D stands on its own and the user chooses it.
  await fs.rm(planState, { force: true });
  await vscode.commands.executeCommand("agentSparring.refresh");
  const before = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;
  const stageRunId = before.runs.find((run) => run.id.endsWith(`stage:${GATE_STAGE}`))?.id;
  assert.ok(stageRunId, "the stage is discovered on its own");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", stageRunId), stageRunId);
  assert.equal((await model()).runKind, "Standalone stage", "which is what the Overview shows");

  // The managed run has since accepted it and advanced to Stage 4.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.mkdir(path.join(sparring, "stages", stage4), { recursive: true });
  await fs.writeFile(path.join(sparring, "stages", stage4, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: null, sparring_session_id: null }));
  await fs.writeFile(planState, JSON.stringify({ current_stage: stage4, current_stage_index: 6, expected_branch: "feature/reported-statistics", plan: GATE_PLAN_LABEL, plan_digest: "0".repeat(64), source: "manifest", status: "running" }));
  // The manifest this managed run executes, as the extension wrote it when
  // the plan was adopted: it is what gives Stage 4 its plan identity.
  const manifests = (await vscode.commands.executeCommand("agentSparring._test.manifestDirectory")) as string;
  await fs.mkdir(manifests, { recursive: true });
  await fs.writeFile(
    path.join(manifests, `${GATE_PLAN_KEY}.manifest.json`),
    JSON.stringify({
      version: 1,
      plan: GATE_PLAN_LABEL,
      plan_digest: "0".repeat(64),
      stages: [
        { stage_id: GATE_STAGE, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport", brief: "The transport." },
        { stage_id: stage4, label: "Stage 4", title: "Editor and UI inspection and guarded editing", brief: "The editor." },
      ],
    }),
  );
  await vscode.commands.executeCommand("agentSparring.refresh");

  const after = await model();
  assert.equal(after.runKind, "Plan run", `the cockpit follows the managed run, got ${String(after.runKind)} · ${String(after.stageHeading)}`);
  assert.equal(after.stageId, stage4, "at the stage that run is actually on");
  assert.match(after.stageHeading ?? "", /^Stage 4 — Editor and UI inspection/, `named as the plan names it, got ${String(after.stageHeading)}`);
  assert.notEqual(after.stageStatus, "Accepted", "not the finished stage it came from");

  // Opening that finished stage deliberately is still allowed, and then the
  // screen says where the work is instead of offering to sequence it here.
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", stageRunId), stageRunId);
  // With the plan linked to the finished stage, this screen is exactly the
  // one that offered Continue plan automatically and Start next stage.
  const planFile = path.join(reportedRepo, "plans", "reported-statistics.md");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.associatePlan", planFile), planFile);
  const history = await model();
  assert.equal(history.runKind, "Standalone stage", "a deliberate visit is respected");
  assert.match(history.followPlan?.text ?? "", /now at Stage 4/, "and it names the run that has taken over");
  assert.equal(history.followPlan?.label, "Show running plan");
  assert.equal(history.continueAutomatically, undefined, "adopting again is not offered");
  assert.equal(history.whatsNext?.kind, "next-created", "nor creating a stage the engine already created");

  // And that button switches to it.
  await vscode.commands.executeCommand("agentSparring._test.associatePlan", undefined);
  await vscode.commands.executeCommand("agentSparring._test.chooseRun", stageRunId);
  await vscode.commands.executeCommand("agentSparring._test.overviewAction", "showRunningPlan");
  const followed = await model();
  assert.equal(followed.runKind, "Plan run");
  assert.equal(followed.stageId, stage4);
  console.log("integration: after the managed run advanced, the Overview follows it to Stage 4; the finished stage stays reachable as history");
}

// ---------------------------------------------------------------- one reusable terminal per project

/** The terminals this extension owns, in the order VS Code lists them. */
function ownTerminals(): vscode.Terminal[] {
  return vscode.window.terminals.filter((terminal) => terminal.name.startsWith("Agent Sparring"));
}

/**
 * A plan is a long series of engine commands, and each one used to leave a
 * terminal behind. One terminal per project is reused instead — while every
 * execution in it is still tracked, ended and reported on its own.
 */
async function terminalReuseAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; terminal-reuse scenario skipped");
    return;
  }
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");

  await vscode.commands.executeCommand("agentSparring.runStage");
  const first = await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "the first run starts");
  const opened = ownTerminals();
  assert.equal(opened.length, 1, `one terminal, named for the project, got: ${JSON.stringify(vscode.window.terminals.map((terminal) => terminal.name))}`);
  assert.equal(opened[0].name, "Agent Sparring — sporely-py-reported-statistics");
  const stopped = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and it ends");
  assert.equal(stopped.execution?.exitCode, 0, "a finished execution cannot keep the UI running");

  await vscode.commands.executeCommand("agentSparring.runStage");
  const second = await waitFor(runId, (liveness) => liveness.state === "running" && liveness.execution?.id !== stopped.execution?.id, 15_000, "a second Run stage");
  assert.deepEqual(ownTerminals(), opened, "the same terminal object ran it: nothing new was opened");
  assert.notEqual(second.execution?.id, first.execution?.id, "while the two executions are tracked separately");
  await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "the second ends too");

  // Accept stage is a different code path (the short-command runner) and
  // must land in the same terminal rather than one of its own.
  const acceptId = runIdOf(report, reportedRepo, "stage-review-complete");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", acceptId), acceptId);
  await vscode.commands.executeCommand("agentSparring._test.acceptStage");
  assert.deepEqual(ownTerminals(), opened, "freeze and accept reused it as well");

  // A terminal the user closed is replaced, not resurrected.
  opened[0].dispose();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await vscode.commands.executeCommand("agentSparring.runStage");
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "a run after the terminal was closed");
  const reopened = ownTerminals();
  assert.equal(reopened.length, 1, "exactly one again");
  assert.notEqual(reopened[0], opened[0], "a fresh one, because the old one is gone");
  await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and it ends");
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  console.log("integration: four engine commands, one reusable terminal per project, each execution tracked on its own");
}

// ---------------------------------------------------------------- the terminal closed mid-run

/**
 * What the user actually did: closed `Agent Sparring — <project>` while the
 * runner inside it was working, and later reloaded the window.
 *
 * Closing the terminal kills the shell and with it the runner, so the
 * extension must treat that as the end of the execution there and then —
 * and the record of that end must survive a reload, because a reload does
 * not un-observe a death. Without both halves the run came back after the
 * reload with nothing but an unmatched `turn.started`, and the Overview sat
 * at "Run status unknown" with every action withheld.
 */
async function closedTerminalAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; closed-terminal scenario skipped");
    return;
  }
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  // A runner that writes turn.started and then works for two minutes: the
  // turn is open when the terminal goes away, exactly as it was.
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=120\nexit_with=0\n");
  await vscode.commands.executeCommand("agentSparring.runStage");
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "the runner starts");
  await waitFor(runId, (liveness) => liveness.turnActive, 10_000, "and a turn is open");

  const live = (await vscode.commands.executeCommand("agentSparring._test.persistedLaunches")) as { runId: string; state: string }[];
  assert.ok(
    live.some((launch) => launch.runId === runId && launch.state === "running"),
    "while it runs, a reload would find it recorded as running",
  );

  const [terminal] = ownTerminals();
  assert.ok(terminal, "the extension's terminal is open");
  terminal.dispose();

  const stopped = await waitFor(runId, (liveness) => liveness.state === "stopped", 15_000, "closing the terminal ends the execution immediately");
  assert.equal(stopped.interrupted, true, "the open turn is presented as interrupted, never as still working");
  assert.equal(stopped.turnActive, false);
  assert.equal(stopped.execution?.state, "ended");

  const after = (await vscode.commands.executeCommand("agentSparring._test.persistedLaunches")) as { runId: string; state: string }[];
  assert.ok(
    after.some((launch) => launch.runId === runId && launch.state === "ended"),
    `a reload must still find that this runner died, got ${JSON.stringify(after)}`,
  );
  assert.ok(
    !after.some((launch) => launch.runId === runId && launch.state === "running"),
    "and must not find it recorded as running",
  );
  console.log("integration: closing the extension's terminal ends the execution at once, and the reload record says so");
}

// ---------------------------------------------------------------- Submit result and continue: resume-plan --evidence reaches the engine

/**
 * The reported regression, in the shape it was reported in: a managed
 * manifest plan run at a structured NEEDS_YOU, one gate check recorded PASS,
 * and Submit result and continue pressed. The engine is the fixture's fake,
 * configured as an absolute path exactly as the user configures theirs, and
 * it records the argv it was given.
 *
 * What is asserted is what the user could not get: the configured executable
 * itself runs, and the multi-line `## Human evidence` entry — backticked
 * check id, apostrophes and all — arrives as one argument after --evidence
 * rather than as shell syntax. Then the fake exits 127 deliberately, and the
 * extension must report that the engine failed, never that the shell could
 * not find a CLI it has just run.
 */
async function evidenceLaunchAssertions(reportedRepo: string, fixtureRoot: string): Promise<void> {
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; evidence-launch scenario skipped");
    return;
  }
  const sparring = path.join(reportedRepo, ".sparring");
  const argvLog = path.join(fixtureRoot, "fake-argv.log");
  await fs.mkdir(path.join(sparring, "stages", GATE_STAGE), { recursive: true });
  await fs.writeFile(path.join(sparring, "stages", GATE_STAGE, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl", sparring_session_id: "spar" }));
  await fs.writeFile(path.join(sparring, "stages", GATE_STAGE, "sparring.md"), gateSparring());
  await fs.mkdir(path.join(sparring, "plans"), { recursive: true });
  await fs.writeFile(
    path.join(sparring, "plans", `${GATE_PLAN_KEY}.json`),
    JSON.stringify({ current_stage: GATE_STAGE, current_stage_index: 0, expected_branch: "feature/reported-statistics", plan: GATE_PLAN_LABEL, plan_digest: "0".repeat(64), source: "manifest", status: "paused" }),
  );
  await fs.mkdir(path.join(reportedRepo, "plans"), { recursive: true });
  await fs.writeFile(path.join(reportedRepo, "plans", "reported-statistics.md"), "# Reported statistics\n\n## Stage 3D — Snapshot v2 and attachment/export/import transport\n\nThe transport.\n");
  // The engine is launched, runs, and fails on its own terms.
  await fs.writeFile(path.join(sparring, "fake-runner.conf"), "resume_exit=127\nresume_output='sparring: resume-plan refused: the recorded digest does not match'\n");
  await fs.rm(argvLog, { force: true });

  await vscode.commands.executeCommand("agentSparring.refresh");
  const report = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;
  const runId = report.runs.find((run) => run.id.startsWith(`${reportedRepo}|`) && run.id.includes("plan:"))?.id;
  assert.ok(runId, "the managed plan run is discovered");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  const recorded = await vscode.commands.executeCommand("agentSparring._test.recordHumanCheck", GATE_CHECK_ID, "pass", "Checked on the reviewer's build; the placeholder doesn't flash.");
  assert.deepEqual(recorded, { outcome: "pass", note: "Checked on the reviewer's build; the placeholder doesn't flash." }, "the gate check is recorded PASS, as clicking Pass records it");

  const beforeNotFound = await vscode.commands.executeCommand("agentSparring._test.lastCommandNotFound");
  const restore = stubDialogs("feature/reported-statistics", "Submit for review");
  try {
    await vscode.commands.executeCommand("agentSparring._test.overviewAction", "submitForReview");
    const argv = await waitForFile(argvLog, 20_000, "the configured executable is reached by Submit result and continue");
    assert.match(argv, /\[end\]/, "the whole argv was recorded");
    const executable = /^\[(.+)\]$/m.exec(argv)?.[1];
    const args = [...argv.matchAll(/<([^]*?)>\n/g)].map((match) => match[1]);

    assert.equal(executable, vscode.workspace.getConfiguration("agentSparring").get<string>("executable"), "the exact configured absolute executable ran");
    assert.equal(args.length, 9, `resume-plan carries nine arguments, not a sentence split into words: ${JSON.stringify(args)}`);
    assert.equal(args[0], "resume-plan");
    assert.deepEqual([args[1], args[3], args[5], args[7]], ["--manifest", "--repo-root", "--expected-branch", "--evidence"], "each flag with its own value");
    assert.equal(args[4], reportedRepo);
    assert.equal(args[6], "feature/reported-statistics");
    const evidence = args[8];
    assert.match(evidence, new RegExp(`check \\\`${GATE_CHECK_ID}\\\``), "the backticked gate id arrives as text, not as command substitution");
    assert.match(evidence, /Checked on the reviewer's build; the placeholder doesn't flash\./, "apostrophes and the semicolon survive");
    assert.ok(evidence.includes("\n"), "and it is still one multi-line entry");
    assert.match(evidence, /^\d{4}-\d{2}-\d{2} — manual verification recorded in VS Code/, "the whole entry, from its first character");

    // The fake exited 127 with its own complaint. That is an engine failure.
    const failure = (await waitFor127()) as { runId: string; kind: string; exitCode: number; output: string } | undefined;
    assert.ok(failure, "a non-zero exit from a launched engine is reported");
    assert.equal(failure.kind, "resume-plan");
    assert.equal(failure.exitCode, 127);
    assert.match(failure.output, /the recorded digest does not match/, `what the engine printed is what the user is shown, got: ${JSON.stringify(failure.output)}`);
    assert.deepEqual(
      await vscode.commands.executeCommand("agentSparring._test.lastCommandNotFound"),
      beforeNotFound,
      "and nothing claims the shell could not find an executable it just ran",
    );
    console.log("integration: resume-plan --evidence reached the configured executable as 9 arguments; its 127 was reported as an engine failure");
  } finally {
    restore();
    await fs.writeFile(path.join(sparring, "fake-runner.conf"), "sleep_for=3\nexit_with=0\n");
  }
}

/** Answer the branch prompt and the Submit confirmation the way a person does. */
function stubDialogs(branch: string, confirm: string): () => void {
  const window = vscode.window as unknown as Record<string, unknown>;
  const inputBox = window["showInputBox"];
  const information = window["showInformationMessage"];
  window["showInputBox"] = async () => branch;
  window["showInformationMessage"] = async (_message: string, ...rest: unknown[]) => (rest.flat().includes(confirm) ? confirm : undefined);
  return () => {
    window["showInputBox"] = inputBox;
    window["showInformationMessage"] = information;
  };
}

/** Wait for the fake engine's argv log to be complete (it ends with its own marker). */
async function waitForFile(file: string, timeoutMs: number, what: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text?.includes("[end]")) {
      return text;
    }
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function waitFor127(): Promise<unknown> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const failure = await vscode.commands.executeCommand("agentSparring._test.lastEngineFailure");
    if (failure || Date.now() >= deadline) {
      return failure;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function gateSparring(): string {
  const gate = {
    category: "DEVICE_MANUAL_CHECK",
    title: "Confirm the supported pre-activation desktop reads snapshot-v2 feeds safely",
    checks: [{ id: GATE_CHECK_ID, instruction: "Run the oldest supported desktop build against a feed containing one snapshot_version 2 row.", pass_criteria: "Pass if the feed loads and the row keeps its details.", source: null }],
  };
  return [
    "# Sparring: stage 3d",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: One compatibility check is the sole acceptance blocker.",
    "- Needs-you reason: DEVICE/MANUAL CHECK -- a pre-activation desktop against a v2 feed.",
    "",
    "## NEEDS YOU",
    "",
    "<!-- human-gate:v1 -->",
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- helpers

function runIdOf(report: DiscoveryDiagnostic, repo: string, stage: string): string {
  const id = report.runs.find((run) => run.id.startsWith(`${repo}|`) && run.id.endsWith(`stage:${stage}`))?.id;
  assert.ok(id, `run id for ${stage}`);
  return id;
}

async function livenessOf(runId: string): Promise<LivenessReport> {
  return (await vscode.commands.executeCommand("agentSparring._test.liveness", runId)) as LivenessReport;
}

async function waitFor(runId: string, predicate: (liveness: LivenessReport) => boolean, timeoutMs: number, what: string): Promise<LivenessReport> {
  const deadline = Date.now() + timeoutMs;
  let last: LivenessReport | undefined;
  while (Date.now() < deadline) {
    last = await livenessOf(runId);
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`timed out waiting for: ${what}; last liveness ${JSON.stringify(last)}`);
}

function shellIntegrationFor(terminal: vscode.Terminal, timeoutMs: number): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve(undefined);
    }, timeoutMs);
    const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timer);
        listener.dispose();
        resolve(event.shellIntegration);
      }
    });
  });
}
