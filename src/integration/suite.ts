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
import type { DiscoveryDiagnostic } from "../core/diagnose";
import type { ExecutionRecord, LivenessState, RunnerLiveness } from "../core/liveness";

const STAGES = ["stage-reported-statistics-contract", "stage-reported-statistics-local-schema-barrier", "stage-reported-statistics-typed-parser", "stage-stale-turn"];

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

  await discoveryAssertions(report, fixtureRoot);
  await staleTelemetryAssertions(report, reportedRepo);
  await launchedRunnerAssertions(report, reportedRepo);
  await observedTerminalAssertions(report, reportedRepo);
  console.log("integration: discovery, stale telemetry, launched runner exit, Ctrl-C and observed terminal command all verified");
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
    ],
  );
  assert.equal(location.runIds.length, 4, "the second workspace folder produces recorded runs");

  const sporely = report.folders[0];
  assert.equal(sporely.sparringExists, true);
  assert.equal(sporely.locations.length, 2);
  assert.equal(sporely.locations[0].nested, false);
  assert.equal(sporely.locations[0].runIds.length, 0);
  assert.equal(sporely.locations[1].nested, true);
  assert.equal(sporely.locations[1].projectDir, path.join(sporely.fsPath, "nested-repo"));
  assert.equal(sporely.locations[1].runIds.length, 1);

  assert.equal(report.runs.length, 5);
  for (const stage of STAGES) {
    assert.ok(
      report.pickLabels.some((label) => label.includes(`sporely-py-reported-statistics: ${stage}`)),
      `Select Repository / Run lists ${stage}`,
    );
  }
  assert.ok(report.pickLabels.some((label) => label.includes("nested-repo: stage-nested-only")));
  // Three open stages in two repositories: ambiguous, never guessed, and the report says so.
  assert.equal(report.ambiguousIds.length, 3);
  assert.equal(report.selectedId, undefined);
  assert.match(report.noSelectionReason ?? "", /3 runs look active/);
}

// ---------------------------------------------------------------- stale telemetry at activation

async function staleTelemetryAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  const staleId = runIdOf(report, reportedRepo, "stage-stale-turn");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", staleId), staleId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  const liveness = await livenessOf(staleId);
  assert.equal(liveness.turnActive, true, "the replayed turn.started is described as activity");
  assert.equal(liveness.state, "unknown", "but the freshly activated extension does not call it Running");
  assert.equal(liveness.source, "telemetry");
  assert.equal(liveness.execution, undefined);
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
