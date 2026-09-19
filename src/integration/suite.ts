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
import { stageScopeKey, stageScopeOf } from "../core/stageScope";
import { planKey } from "../core/sparringCommand";
import { BINDING_VERSION, bindingFileName, manifestFileName, parseExecutionManifest, renderBindingRecord } from "../core/manifest";
import { isActionMessage, isAgentConfigMessage, isAutoPushMessage, isCopyPromptMessage, isHumanCheckMessage, isHumanFeedbackMessage, isOpenPromptSourceMessage, renderOverviewHtml } from "../core/overviewHtml";
import { withHumanCheck, type HumanCheckDrafts } from "../core/humanChecks";
import { PROVIDER_DEFAULT_LABEL, parseEngineConfig } from "../core/effectiveConfig";
import type { ExecutionRecord, LivenessState, RunnerLiveness } from "../core/liveness";
import { buildOverviewModel, type CapturedPrompt, type ManifestStageView, type OverviewArtifacts } from "../core/overviewModel";
import { ExecutionTracker } from "../vscode/executionTracker";
import { listProcesses, processProbeSupported } from "../vscode/processProbe";
import type { ProcessInfo } from "../core/processTree";
import { OperationRegistry, OPERATIONS_KEY } from "../vscode/operationRegistry";
import type { TerminalLease, TerminalPool } from "../vscode/terminalPool";

const STAGES = ["stage-reported-statistics-contract", "stage-reported-statistics-local-schema-barrier", "stage-reported-statistics-typed-parser", "stage-review-complete", "stage-review-complete-dirty", "stage-stale-turn"];

interface LivenessReport {
  state: LivenessState;
  source: RunnerLiveness["source"];
  turnActive: boolean;
  interrupted: boolean;
  /** Where a requested interruption of this exact execution stands. */
  stop?: RunnerLiveness["stop"];
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
    ["pushauth", () => pushAuthorizationAssertions()],
    ["prompt", () => promptInspectorAssertions()],
    ["disclosure", () => disclosurePersistenceAssertions()],
    ["actorcards", () => actorCardControlAssertions()],
    ["evidence", () => evidenceLaunchAssertions(reportedRepo, fixtureRoot)],
    ["stagescope", () => stageScopeAssertions(reportedRepo)],
    ["advance", () => advancementAssertions(reportedRepo)],
    ["terminals", () => terminalReuseAssertions(report, reportedRepo)],
    ["closed", () => closedTerminalAssertions(report, reportedRepo)],
    ["occupied", () => occupiedTerminalAssertions(report, reportedRepo, fixtureRoot)],
    ["falserunner", () => falseRunnerAssertions(reportedRepo, fixtureRoot)],
    ["latestart", () => lateStartAssertions(report, reportedRepo)],
    ["shortcommand", () => shortCommandAssertions(report, reportedRepo)],
    ["override", () => overrideAssertions(report, reportedRepo)],
    ["launchable", () => launchTargetAssertions(fixtureRoot, reportedRepo)],
    ["declarations", () => declarationScopeAssertions(reportedRepo, fixtureRoot)],
    ["outlives", () => directExecutionOutlivesTheWindowAssertions()],
    ["settings", () => settingsAssertions(report, reportedRepo)],
    ["agentconfig", () => agentConfigAssertions(report, reportedRepo, fixtureRoot)],
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
      // The label is the stage's readable name; the raw id stays in the detail,
      // which the diagnostic includes precisely so it can be grepped for.
      report.pickLabels.some((label) => label.startsWith("STANDALONE / HISTORICAL STAGES | ") && label.endsWith(`sporely-py-reported-statistics · ${stage}`)),
      `Select Repository / Run lists ${stage} under the standalone group`,
    );
  }
  assert.ok(report.pickLabels.some((label) => label.endsWith("nested-repo · stage-nested-only")));
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
  await runStage();
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
  await runStage();
  const second = await waitFor(runId, (liveness) => liveness.state === "running" && liveness.execution?.startedAtMs !== stopped.execution?.startedAtMs, 15_000, "a second launch after a known stop is Running again");
  assert.notEqual(second.execution?.id, stopped.execution?.id);
  await waitFor(runId, (liveness) => liveness.turnActive, 10_000, "run 2 telemetry");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // What the screen says while it is working, and what it offers.
  const overview = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const working = await overview();
  assert.equal(working.busyState?.label, "Working", "a runner observed alive reads Working");
  assert.equal(working.busyState?.state, "running");
  assert.equal(working.runner?.label, "Stop", "and Stop is offered beside it");
  assert.equal(working.runner?.executionId, second.execution?.id, "bound to the execution on screen");
  assert.equal(working.stageAction, undefined, "nothing that would start a second copy is offered");

  // Stop names the exact execution it is aiming at, exactly as the rendered
  // control does, and interrupts through that run's own terminal.
  const target = second.execution?.id as string;
  const requested = await vscode.commands.executeCommand<{ requested: boolean; via?: string }>("agentSparring._test.stop", runId, target);
  assert.deepEqual(requested, { requested: true, via: "terminal" }, "Stop reaches the hosting terminal");
  const interrupted = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "Ctrl-C ends the execution");
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.turnActive, false);
  // And only now — with that exact execution observed ending — is it Stopped.
  assert.equal(interrupted.stop, "stopped", "a requested stop becomes Stopped only on the execution's own end");
  assert.equal(interrupted.execution?.id, target, "and it is the execution Stop was aimed at");
  // Stopping an execution that is no longer the live one changes nothing.
  const stale = await vscode.commands.executeCommand<{ requested: boolean; reason?: string }>("agentSparring._test.stop", runId, target);
  assert.equal(stale.requested, false, "a stale panel cannot interrupt anything");

  // And what the screen says afterwards: stopped, with the same managed
  // work offered again rather than a new one, and nothing left to stop.
  await vscode.commands.executeCommand("agentSparring.refresh");
  const after = await overview();
  assert.equal(after.status?.label, "Stopped — ready to resume");
  assert.equal(after.runner, undefined, "there is nothing left to interrupt");
  assert.equal(after.busyState, undefined, "and nothing claims it is still working");
  assert.ok(after.stageAction, "the stage can be run again, because the guard was released by real evidence");
  console.log(`integration: Stop → "${after.status?.label}", offering "${after.stageAction?.label}"`);
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
  agentConfig?: {
    lines: { role: string; text: string; detail: string }[];
    controls: {
      role: string;
      label: string;
      provider: { value: string; fixedText?: string; options?: { value: string; label: string }[] };
      model: { value: string; options?: { value: string }[]; fixedText?: string };
      effort?: { value: string; options?: { value: string; label: string }[] };
    }[];
    configPath?: string;
    configExists?: boolean;
    scope?: string;
    activeRunNote?: string;
    note?: string;
    settings: { label: string; detail: string };
  };
  /** The live-run pill: Working / Stop requested… / Run status unknown. */
  busyState?: { label: string; detail: string; state: string };
  /** The Stop control, present only when an exact operation can be interrupted. */
  runner?: { alive: boolean; label: string; executionId: string; detail: string };
  /** The manual-verification panel, as far as the stage-scope scenario reads it. */
  actionRequired?: {
    progress?: string;
    required: { key: string; record?: { outcome?: string; note?: string } }[];
    submit: { enabled: boolean; detail: string };
    feedback: { draft?: string };
    submitting?: { label: string };
    submissionFailure?: { preserved: string; reason: string; error?: string };
  };
  status?: { label: string; tone: string };
  planAction?: { kind: string; label: string; primary: boolean };
  unknownRunner?: { label: string; executionId: string; operationId?: string };
}

interface AgentConfigOutcome {
  applied: boolean;
  refused?: string;
  error?: string;
}

interface SettingsOutcome {
  opened?: string;
  offered?: boolean;
  created?: boolean;
  problem?: string;
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
    await runStage();
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
    await runStage();
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
/**
 * Derived, never written down: the engine names a plan run's state file from
 * the plan's repo-relative label (`plan.py: plan_key`), so a hand-written
 * constant can disagree with it — and this one did. A fixture whose state
 * file is named something the engine would never produce quietly exempts
 * itself from every code path that recomputes the key from the plan path.
 */
const GATE_PLAN_LABEL = "plans/reported-statistics.md";
const GATE_PLAN_KEY = planKey(GATE_PLAN_LABEL);
/** The reviewer's stable check id: a slug, which is exactly the shape the host used to refuse. */
const GATE_CHECK_ID = "pre-activation-desktop-v2-feed";

/**
 * The one thing a rendered snapshot cannot show: that clicking Pass — or
 * typing a finding into the freeform field — does anything.
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
 * recordHumanCheck`, `isHumanFeedbackMessage(m) → recordHumanFeedback`)
 * covered by the unit tests. Everything else on the wire is the shipped code,
 * running where it really runs.
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
  // Drafts are stored under the run *and* the stage it is current at, so
  // this reads them the way the host does (core/stageScope.ts).
  const scope = stageScopeKey(stageScopeOf(selection.selected!));
  const view = (drafts: HumanCheckDrafts, feedback?: string) => {
    const artifacts: OverviewArtifacts = { handoff: false, sparring: true, brief: false, plan: false, git: { branch: "feature/x" }, humanChecks: drafts[scope] ?? {}, humanFeedback: feedback, manifestStages };
    return buildOverviewModel(selection, undefined, artifacts, Date.now());
  };

  const before = view({});
  assert.equal(before.actionRequired?.required[0]?.key, GATE_CHECK_ID, "the gate's own id is the control's key");
  assert.equal(before.actionRequired?.progress, "0 / 1 verified · 1 remaining");
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

    const after = view(withHumanCheck({}, scope, message.key as string, { outcome: "pass" }));
    assert.equal(after.actionRequired?.required[0]?.record?.outcome, "pass");
    assert.equal(after.actionRequired?.progress, "1 / 1 verified");
    assert.equal(after.actionRequired?.submit.enabled, true);
    const html = renderOverviewHtml(after, nonce, panel.webview.cspSource);
    assert.match(html, new RegExp(`class="choice pass on" data-check="${GATE_CHECK_ID}"`), "Pass is visibly selected on the next render");
    assert.match(html, /data-action="submitForReview" title="[^"]*">Submit result and continue</, "and Submit result and continue is enabled");

    // The other half of the gate, on the same real wire: a multi-line
    // finding that belongs to no check. Typed into the real textarea, posted
    // by the shipped listener, and it must arrive byte for byte — a
    // reproduction path whose newlines are lost is not a reproduction path.
    const feedback = ["App crashes while entering the reference workflow:", "Observation → Add reference → Cancel → crash.", "", "It's reproducible; I can't reach the editor to run the check above."].join("\n");
    const feedbackNonce = crypto.randomBytes(16).toString("base64");
    const gotFeedback = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no feedback message arrived from the webview within 15s")), 15_000);
      panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
        if (message?.["type"] === "humanFeedback") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    const typer = `<script nonce="${feedbackNonce}">var f = document.querySelector('textarea[data-feedback]'); f.value = ${JSON.stringify(feedback)}; f.dispatchEvent(new Event('focusout', { bubbles: true }));</script>`;
    panel.webview.html = renderOverviewHtml(after, feedbackNonce, panel.webview.cspSource).replace("</body>", `${typer}</body>`);
    const feedbackMessage = await gotFeedback;

    assert.deepEqual(feedbackMessage, { type: "humanFeedback", text: feedback }, "every line of it crossed the wire, and it carries no check key");
    assert.ok(isHumanFeedbackMessage(feedbackMessage), "the host accepts it as feedback");
    assert.ok(!isHumanCheckMessage(feedbackMessage), "and can never file it as a check result");

    // And with it in the box, the freeform action is offered while all of the
    // reviewer's checks are still unanswered.
    const withFeedback = view({}, feedbackMessage.text as string);
    assert.equal(withFeedback.actionRequired?.feedback.draft, feedback);
    assert.equal(withFeedback.actionRequired?.feedback.send.enabled, true);
    assert.equal(withFeedback.actionRequired?.progress, "0 / 1 verified · 1 remaining", "and it claims nothing about the check");
    assert.equal(withFeedback.actionRequired?.submit.enabled, false);
  } finally {
    panel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- push authorization, on the real wire

/**
 * The permission panel, in a real Chromium webview.
 *
 * Two things can only be proven here. The **toggle** is a checkbox, and a
 * checkbox reports through `change`, not `click` — a listener wired to the
 * wrong event renders a control that looks right and does nothing, which is
 * exactly the class of failure this panel exists to end. And **Allow push**
 * has to reach the host as an action the host will accept, since a message
 * the guard drops is a dead button.
 *
 * The click is a real DOM event on the real document, and everything it
 * reaches is the shipped listener.
 */
async function pushAuthorizationAssertions(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-push-"));
  const candidate = "f2e455c9a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const branch = "feature/add-reference-dialog-redesign";
  const stages = path.join(root, ".sparring", "stages");
  await fs.mkdir(path.join(stages, GATE_STAGE), { recursive: true });
  await fs.writeFile(path.join(stages, GATE_STAGE, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl", sparring_session_id: "spar" }));
  await fs.writeFile(
    path.join(stages, GATE_STAGE, "sparring.md"),
    ["# Sparring: gate", "", "## Routing outcome", "", "- Action: `READY`", "- Summary: The change is correct and complete.", ""].join("\n"),
  );
  await fs.mkdir(path.join(root, ".sparring", "plans"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".sparring", "plans", `${GATE_PLAN_KEY}.json`),
    JSON.stringify({
      current_stage: GATE_STAGE,
      current_stage_index: 0,
      expected_branch: branch,
      plan: GATE_PLAN_LABEL,
      plan_digest: "0".repeat(64),
      source: "manifest",
      status: "paused",
      awaiting: {
        kind: "push_authorization_required",
        stage_id: GATE_STAGE,
        candidate_sha: candidate,
        branch,
        remote: "origin",
        remote_branch: branch,
        detail: `${candidate} is not reachable from origin/${branch} (abc1234)`,
      },
      push_authorization: null,
    }),
  );
  await fs.mkdir(path.join(root, "plans"), { recursive: true });
  await fs.writeFile(path.join(root, "plans", "reported-statistics.md"), "# Reported statistics\n\n## Stage 3D — Transport\n\nThe transport.\n");

  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
  const selection = selectRun((await discoverRuns([location])).runs);
  assert.ok(selection.selected, "the paused managed plan run is discovered");
  const view = (autoPushDraft: boolean) =>
    buildOverviewModel(selection, undefined, { handoff: false, sparring: true, brief: false, plan: false, git: { branch }, autoPushDraft }, Date.now());

  const before = view(false);
  assert.equal(before.pushAuthorization?.candidateSha, candidate, "the panel is built from the engine's typed pause");
  assert.equal(before.pushAuthorization?.autoPush.checked, false);
  assert.equal(before.actionRequired, undefined, "and it is not a manual-verification panel");

  const panel = vscode.window.createWebviewPanel("agentSparring.pushAuthTest", "push authorization", { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
  try {
    // No check control is on the page at all: the permission panel is not a
    // test, and the version of it that looked like one is the defect.
    const document = renderOverviewHtml(before, "probe", panel.webview.cspSource);
    for (const forbidden of ['data-outcome="pass"', 'data-action="submitForReview"']) {
      assert.ok(!document.includes(forbidden), `the rendered page must not contain ${forbidden}`);
    }
    const waitFor = (type: string, timeoutMs = 15_000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} message arrived from the webview within ${timeoutMs}ms`)), timeoutMs);
        panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
          if (message?.["type"] === type) {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });

    // 1. Ticking the toggle. A checkbox does not report through `click`.
    const toggleNonce = crypto.randomBytes(16).toString("base64");
    const gotToggle = waitFor("autoPush");
    const ticker = `<script nonce="${toggleNonce}">document.querySelector('input[data-autopush]').click();</script>`;
    panel.webview.html = renderOverviewHtml(before, toggleNonce, panel.webview.cspSource).replace("</body>", `${ticker}</body>`);
    const toggle = await gotToggle;
    assert.deepEqual(toggle, { type: "autoPush", enabled: true }, "the real checkbox reported its new position");
    assert.ok(isAutoPushMessage(toggle), "and the host accepts it");

    // The stored choice comes back on the next render, so the box does not
    // move under the person while they read the panel.
    const after = view(true);
    assert.equal(after.pushAuthorization?.autoPush.checked, true);
    assert.match(renderOverviewHtml(after, toggleNonce, panel.webview.cspSource), /data-autopush="run" checked/);

    // 2. Allow push itself, as an action the host will accept.
    const allowNonce = crypto.randomBytes(16).toString("base64");
    const gotAction = waitFor("action");
    const clicker = `<script nonce="${allowNonce}">document.querySelector('button[data-action="allowPush"]').click();</script>`;
    panel.webview.html = renderOverviewHtml(after, allowNonce, panel.webview.cspSource).replace("</body>", `${clicker}</body>`);
    const action = await gotAction;
    assert.deepEqual(action, { type: "action", action: "allowPush" }, "the button posted the action");
    assert.ok(isActionMessage(action), "and the host accepts it — a dropped message is a dead button");

    // 3. And there is a non-destructive way out, on the same document.
    const dismissNonce = crypto.randomBytes(16).toString("base64");
    const gotDismiss = waitFor("action");
    const decliner = `<script nonce="${dismissNonce}">document.querySelector('button[data-action="doNotAllowPush"]').click();</script>`;
    panel.webview.html = renderOverviewHtml(after, dismissNonce, panel.webview.cspSource).replace("</body>", `${decliner}</body>`);
    assert.deepEqual(await gotDismiss, { type: "action", action: "doNotAllowPush" });
    console.log(
      "integration: the typed push request renders a permission, its real checkbox reports through change and comes back ticked, Allow push and Do not allow both reach the host, and no check control is on the page",
    );
  } finally {
    panel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the prompt inspector's controls, in a real browser

/**
 * The prompt inspector's two controls both sit inside a `<summary>`, whose
 * activation toggles the section it heads. So "open the file this section
 * came from" could post exactly the right message and still be useless,
 * because the section it was clicked in collapses at the same moment. The
 * unit test's DOM shim cannot say anything about that: it has no
 * `<details>` behaviour at all.
 *
 * Here a real Chromium webview renders the real document, a real `click()`
 * on the real button reaches the shipped listener, and the probe reports
 * whether the enclosing `<details>` stayed put.
 *
 * What this does *not* isolate: removing the listener's `preventDefault`
 * leaves these assertions passing, because Chromium already declines to
 * toggle a `<summary>` when the click lands on an interactive descendant.
 * The guard is defensive, and what is verified here is the behaviour a
 * person sees — the control acts and the section it is in stays open —
 * which would still catch the control being rendered as something other
 * than a button, or moved somewhere the listener does not reach.
 */
async function promptInspectorAssertions(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-prompt-"));
  const stage = "stage-5-independent-final-review-and-activation-decision";
  const stages = path.join(root, ".sparring", "stages");
  await fs.mkdir(path.join(stages, stage), { recursive: true });
  await fs.writeFile(path.join(stages, stage, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl", sparring_session_id: null }));

  const brief = "## Stage brief\n\nA fresh top-level reviewer verifies frozen candidate SHAs.";
  const scope = "## Scope reminder\n\nStay within this stage's bounded goal above.";
  const text = `${brief}\n\n${scope}\n`;
  const source = `stages/${stage}/brief.md`;
  const capturedPrompts: CapturedPrompt[] = [
    {
      entry: {
        seq: 1,
        ts: new Date().toISOString(),
        role: "stage",
        stageId: stage,
        turnKind: "original",
        resumed: false,
        expectedBranch: "feature/x",
        file: "0001-stage-original.md",
        chars: text.length,
        sections: [
          { heading: "Stage brief", origin: "file", source, start: 0, end: brief.length },
          { heading: "Scope reminder", origin: "engine", start: brief.length + 2, end: text.length - 1 },
        ],
      },
      text,
    },
  ];

  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
  const selection = selectRun((await discoverRuns([location])).runs);
  assert.ok(selection.selected, "the standalone stage is discovered");
  const artifacts: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false, capturedPrompts };
  const model = buildOverviewModel(selection, undefined, artifacts, Date.now());
  assert.equal(model.stageAgent?.prompt?.turn, "Implementation turn");

  const nonce = crypto.randomBytes(16).toString("base64");
  const panel = vscode.window.createWebviewPanel("agentSparring.promptClickTest", "prompt click", { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
  try {
    const posted: Record<string, unknown>[] = [];
    const probed = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no probe arrived from the webview within 15s")), 15_000);
      panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
        posted.push(message);
        if (message?.["type"] === "promptProbe") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    // `acquireVsCodeApi` may only be called once per webview, and the shipped
    // script calls it. So the probe borrows the same handle rather than
    // asking for a second one.
    const shipped = `<script nonce="${nonce}">`;
    const preamble = `<script nonce="${nonce}">var __api; var __acquire = acquireVsCodeApi; acquireVsCodeApi = function () { __api = __acquire(); return __api; };</script>`;
    const probe = `<script nonce="${nonce}">
      var card = document.querySelector('.card.actor details.instr');
      var section = document.querySelector('details.promptsec');
      card.open = true;
      section.open = true;
      var openBefore = section.open;
      document.querySelector('button[data-openprompt]').click();
      var afterOpenSource = section.open;
      document.querySelector('button[data-copyprompt]').click();
      __api.postMessage({ type: 'promptProbe', openBefore: openBefore, afterOpenSource: afterOpenSource, cardStillOpen: card.open });
    </script>`;
    panel.webview.html = renderOverviewHtml(model, nonce, panel.webview.cspSource).replace(shipped, `${preamble}${shipped}`).replace("</body>", `${probe}</body>`);
    const report = await probed;

    assert.equal(report["openBefore"], true);
    assert.equal(report["afterOpenSource"], true, "opening a section's source must not collapse the section it was clicked in");
    assert.equal(report["cardStillOpen"], true, "nor the actor card around it");

    const open = posted.find((message) => message["type"] === "openPromptSource");
    assert.ok(open, "the shipped listener posted the open-source message from a real click");
    assert.deepEqual(open, { type: "openPromptSource", source }, "carrying the path the engine recorded");
    assert.ok(isOpenPromptSourceMessage(open), "and the host accepts it");

    const copy = posted.find((message) => message["type"] === "copyPrompt");
    assert.ok(copy, "and the copy button posted too");
    assert.deepEqual(copy, { type: "copyPrompt", role: "stage" });
    assert.ok(isCopyPromptMessage(copy), "which the host also accepts");
  } finally {
    panel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- what the person opened stays open across a rerender

/**
 * The reported bug, in a real Chromium webview: open "Show instructions"
 * during a live run, and two or three seconds later the Overview rerenders
 * and it closes again.
 *
 * The unit tests drive the shipped script against a DOM shim, which can
 * show that the restore logic does what it says. Only this can show that it
 * survives the thing that actually happens — the host assigning
 * `webview.html`, which throws the whole document away and builds a new one
 * in the same webview. What carries the state across that is the webview's
 * own `setState` store, and whether *that* survives is a fact about VS Code
 * rather than about this extension, so it is asserted where VS Code is
 * real.
 *
 * Both halves matter and both are checked: the section the person opened
 * comes back open, and a section they left closed comes back closed.
 */
async function disclosurePersistenceAssertions(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-disclosure-"));
  const stage = "stage-7-disclosure";
  const stages = path.join(root, ".sparring", "stages");
  await fs.mkdir(path.join(stages, stage), { recursive: true });
  await fs.writeFile(path.join(stages, stage, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl", sparring_session_id: null }));

  const brief = "## Stage brief\n\nImplement only this section.";
  // Long enough that the renderer starts it collapsed, so the "left closed
  // stays closed" half is about a real section rather than a contrivance.
  const context = `## Project context\n\n${"Everything the agent should know. ".repeat(80)}`;
  const text = `${brief}\n\n${context}\n`;
  const capturedPrompts: CapturedPrompt[] = [
    {
      entry: {
        seq: 1,
        ts: new Date().toISOString(),
        role: "stage",
        stageId: stage,
        turnKind: "original",
        resumed: false,
        expectedBranch: "feature/x",
        file: "0001-stage-original.md",
        chars: text.length,
        sections: [
          { heading: "Stage brief", origin: "file", source: `stages/${stage}/brief.md`, start: 0, end: brief.length },
          { heading: "Project context", origin: "engine", start: brief.length + 2, end: text.length - 1 },
        ],
      },
      text,
    },
  ];

  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
  const selection = selectRun((await discoverRuns([location])).runs);
  assert.ok(selection.selected, "the standalone stage is discovered");
  const artifacts: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false, capturedPrompts };
  const model = buildOverviewModel(selection, undefined, artifacts, Date.now());

  const panel = vscode.window.createWebviewPanel("agentSparring.disclosureTest", "disclosure", { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
  try {
    const reports: Record<string, unknown>[] = [];
    const waitForProbe = (which: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${which} probe arrived from the webview within 15s`)), 15_000);
        const subscription = panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
          if (message?.["type"] === which) {
            clearTimeout(timer);
            subscription.dispose();
            reports.push(message);
            resolve(message);
          }
        });
      });

    /**
     * The page, plus a probe. The shipped script calls `acquireVsCodeApi`,
     * which may only be called once per document, so the probe borrows the
     * handle the shipped script took.
     */
    const draw = (nonce: string, probe: string) => {
      const shipped = `<script nonce="${nonce}">`;
      const preamble = `<script nonce="${nonce}">var __api; var __acquire = acquireVsCodeApi; acquireVsCodeApi = function () { __api = __acquire(); return __api; };</script>`;
      return renderOverviewHtml(model, nonce, panel.webview.cspSource).replace(shipped, `${preamble}${shipped}`).replace("</body>", `<script nonce="${nonce}">${probe}</script></body>`);
    };

    // First draw: open the actor card the way a person does, by clicking its
    // summary, so the shipped `toggle` listener is what records it.
    const openNonce = crypto.randomBytes(16).toString("base64");
    const opening = waitForProbe("openedProbe");
    panel.webview.html = draw(
      openNonce,
      `var card = document.querySelector('.card.actor details.instr[data-disclose]');
       var big = document.querySelector('details.promptsec:not([open])[data-disclose]');
       card.querySelector('summary').click();
       // A details element fires its toggle event asynchronously, and the
       // shipped listener records the state from that event. Reporting in
       // the same task as the click would be asking whether the state had
       // been written before the browser had said it changed.
       setTimeout(function () {
         __api.postMessage({ type: 'openedProbe', cardOpen: card.open, cardKey: card.getAttribute('data-disclose'), bigOpen: big ? big.open : null, bigKey: big ? big.getAttribute('data-disclose') : null, state: __api.getState() });
       }, 50);`,
    );
    const opened = await opening;
    assert.equal(opened["cardOpen"], true, "the person opened Show instructions");
    assert.equal(opened["bigOpen"], false, "and left the long section collapsed, as the renderer wrote it");

    // The live run updates, so the host replaces the whole document. This is
    // the exact line that caused the bug.
    const redrawNonce = crypto.randomBytes(16).toString("base64");
    const redrawn = waitForProbe("redrawnProbe");
    panel.webview.html = draw(
      redrawNonce,
      `var card = document.querySelector('.card.actor details.instr[data-disclose]');
       var big = document.querySelector('details.promptsec[data-disclose="${String(opened["bigKey"])}"]');
       __api.postMessage({ type: 'redrawnProbe', cardOpen: card.open, cardKey: card.getAttribute('data-disclose'), bigOpen: big ? big.open : null, state: __api.getState() });`,
    );
    const after = await redrawn;

    console.log(`integration: disclosure state after open ${JSON.stringify(opened["state"])}, after redraw ${JSON.stringify(after["state"])}`);
    assert.equal(after["cardKey"], opened["cardKey"], "the same section, under the same stable key");
    assert.equal(after["cardOpen"], true, "Show instructions is still open after the rerender — the reported bug");
    assert.equal(after["bigOpen"], false, "and a section the person never opened is still closed");
  } finally {
    panel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the controls that now live inside an actor card

/**
 * The model and effort controls, in a real Chromium webview, inside the card
 * whose role they configure.
 *
 * This is the behaviour that decided the markup. While the whole card was a
 * `<details>`, a control inside it sat inside a `<summary>`, and clicking a
 * dropdown there is an activation of the summary: the card would collapse
 * under the person's cursor as they changed a model. That is invisible in a
 * rendered snapshot and cannot be observed in a DOM shim, because it is
 * Chromium's own `<summary>` behaviour — so it is asserted here, where the
 * webview is real.
 *
 * What is checked is what a person does: open the instructions, change the
 * effort, type a model. The page must post both changes, with the scope it
 * was drawn from, and the section they opened must still be open.
 */
async function actorCardControlAssertions(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-actorcard-"));
  const stage = "stage-2-schema-and-api";
  const stages = path.join(root, ".sparring", "stages");
  await fs.mkdir(path.join(stages, stage), { recursive: true });
  await fs.writeFile(path.join(stages, stage, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl-1", sparring_session_id: null }));

  const text = "## Stage brief\n\nDo the bounded thing.\n";
  const capturedPrompts: CapturedPrompt[] = [
    {
      entry: {
        seq: 1,
        ts: new Date().toISOString(),
        role: "stage",
        stageId: stage,
        turnKind: "original",
        resumed: false,
        file: "0001-stage-original.md",
        chars: text.length,
        sections: [{ heading: "Stage brief", origin: "file", source: `stages/${stage}/brief.md`, start: 0, end: text.length - 1 }],
      },
      text,
    },
  ];

  // The engine's own answer, with a level no provider ships, so an option
  // that appears can only have come from this JSON.
  const configPath = path.join(root, ".sparring", "project.toml");
  const report = parseEngineConfig(
    JSON.stringify({
      config_path: configPath,
      config_exists: true,
      project: "demo",
      error: null,
      stage: { role: "stage", provider: "claude-cli", provider_display_name: "Claude", provider_source: "project", model: "a-model", model_source: "project", effort: null, effort_source: "provider-default", effort_supported: true, effort_levels: ["brisk", "glacial"] },
      sparring: { role: "sparring", provider: "codex-cli", provider_display_name: "Codex", provider_source: "project", model: null, model_source: "provider-default", effort: null, effort_source: "provider-default", effort_supported: true, effort_levels: ["minimal"] },
    }),
  );
  assert.ok(report, "the engine payload parses");

  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
  const selection = selectRun((await discoverRuns([location])).runs);
  assert.ok(selection.selected, "the standalone stage is discovered");
  const artifacts: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false, capturedPrompts, agentConfig: { kind: "report", report } };
  const model = buildOverviewModel(selection, undefined, artifacts, Date.now());

  const nonce = crypto.randomBytes(16).toString("base64");
  const panel = vscode.window.createWebviewPanel("agentSparring.actorCardTest", "actor cards", { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
  try {
    const posted: Record<string, unknown>[] = [];
    const probed = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no probe arrived from the webview within 15s")), 15_000);
      panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
        posted.push(message);
        if (message?.["type"] === "cardProbe") {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
    const shipped = `<script nonce="${nonce}">`;
    const preamble = `<script nonce="${nonce}">var __api; var __acquire = acquireVsCodeApi; acquireVsCodeApi = function () { __api = __acquire(); return __api; };</script>`;
    const probe = `<script nonce="${nonce}">
      var card = document.querySelector('.card.actor');
      var instr = card.querySelector('details.instr');
      var effort = card.querySelector('select[data-field="effort"]');
      var levels = Array.prototype.map.call(effort.options, function (option) { return option.value; });
      // Open the instructions the way a person does, then use the controls.
      instr.querySelector('summary').click();
      var openedInstructions = instr.open;
      effort.value = 'glacial';
      effort.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(function () {
        // Measured rather than assumed: that the role really reads as the
        // heading, and that the controls really are laid out inside the
        // card, are facts about the rendered box tree.
        var rolename = card.querySelector('.rolename');
        var providerLine = card.querySelector('.provider');
        var cardBox = card.getBoundingClientRect();
        var effortBox = effort.getBoundingClientRect();
        // The model as the page actually renders it: read-only text, with
        // nothing focusable or typable behind it.
        var modelText = card.querySelector('.agentconfig-fixed');
        var modelBox = modelText.getBoundingClientRect();
        var size = function (node) { return parseFloat(getComputedStyle(node).fontSize); };
        __api.postMessage({
          type: 'cardProbe',
          role: rolename.textContent,
          provider: providerLine.textContent,
          levels: levels,
          openedInstructions: openedInstructions,
          stillOpen: instr.open,
          panels: document.querySelectorAll('.agentconfig').length,
          cards: document.querySelectorAll('.card.actor').length,
          roleSize: size(rolename),
          providerSize: size(providerLine),
          roleColor: getComputedStyle(rolename).color,
          providerColor: getComputedStyle(providerLine).color,
          roleAbove: rolename.getBoundingClientRect().top < providerLine.getBoundingClientRect().top,
          effortInsideCard: effortBox.top >= cardBox.top && effortBox.bottom <= cardBox.bottom && effortBox.left >= cardBox.left && effortBox.right <= cardBox.right,
          modelTag: modelText.tagName,
          modelValue: modelText.textContent,
          modelEditable: card.querySelectorAll('input[data-field], [contenteditable]').length,
          // Both start on the same column, which is the alignment the
          // read-only value's padding exists to preserve.
          modelAlignsWithEffort: Math.abs(modelBox.left - effortBox.left) < 1,
        });
      }, 50);
    </script>`;
    panel.webview.html = renderOverviewHtml(model, nonce, panel.webview.cspSource).replace(shipped, `${preamble}${shipped}`).replace("</body>", `${probe}</body>`);
    const seen = await probed;

    assert.equal(seen["role"], "Stage agent", "the role is the card's heading");
    assert.equal(seen["provider"], "Claude", "and the provider is the line under it");
    assert.deepEqual(seen["levels"], ["", "brisk", "glacial"], "every option came from the engine's JSON");
    assert.equal(seen["panels"], 0, "there is no separate Agents panel any more");
    assert.equal(seen["openedInstructions"], true, "the person opened Show instructions");
    assert.equal(seen["stillOpen"], true, "and using the card's own controls did not collapse it");
    assert.equal(seen["cards"], 2, "two cards, one per role");
    assert.equal(seen["roleAbove"], true, "the role is above the provider, not beside it in brackets");
    assert.ok((seen["roleSize"] as number) > (seen["providerSize"] as number), `the role is the larger text (${String(seen["roleSize"])} vs ${String(seen["providerSize"])})`);
    assert.notEqual(seen["roleColor"], seen["providerColor"], "the role carries the actor's colour; the provider is subdued");
    assert.equal(seen["effortInsideCard"], true, "the effort control is laid out inside its own role's card");
    assert.equal(seen["modelTag"], "SPAN", "the model is text on the card, not a control");
    assert.equal(seen["modelValue"], "a-model", "showing exactly what the engine resolved");
    assert.equal(seen["modelEditable"], 0, "and nothing on the card can be typed into");
    assert.equal(seen["modelAlignsWithEffort"], true, "the read value starts on the same column as the dropdown");
    console.log(`integration: role ${String(seen["roleSize"])}px ${String(seen["roleColor"])} over provider ${String(seen["providerSize"])}px ${String(seen["providerColor"])}`);

    const changes = posted.filter((message) => message["type"] === "agentConfig");
    assert.deepEqual(
      changes,
      [{ type: "agentConfig", role: "stage", field: "effort", value: "glacial", scope: configPath }],
      "the one change went out on the existing wire, carrying the project.toml the card was drawn from",
    );
    for (const change of changes) {
      assert.ok(isAgentConfigMessage(change), "and the host accepts each one");
    }
    console.log("integration: the actor cards state their own model and carry their own effort control, built from the engine's levels, and using it leaves the card and its instructions exactly as the person left them");
  } finally {
    panel.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the managed run advances, and the cockpit follows

/**
 * Stage 3D, finished and explicitly chosen; then a managed plan run that
 * executed it advances to Stage 4.
 *
 * The reported bug was that this screen kept showing
 * "Standalone stage · Stage 3D · Accepted" **and offered the actions the live
 * plan had already taken** — Continue plan automatically, Start next stage.
 * Two separate things were wrong there, and only the second one was about
 * what is on screen:
 *
 *  - the stage was not shown as history of the run that executed it, so
 *    nothing said where the work actually was;
 *  - and the wrong actions were offered, in the screen *and* in the command
 *    path behind it.
 *
 * Taking the selection away was the wrong fix for either, and this section
 * asserts the right one. The stage here is **accepted when it is chosen**, so
 * choosing it is a deliberate visit to history: the pin holds, whatever the
 * plan does next (see core/discovery.ts, `supersedingPlanRun`). What changes
 * is everything else — the screen reads as a historical stage, names the run
 * that has taken over and where it now is, offers one way back to it, and
 * refuses to adopt work that run already did.
 *
 * A pin made while a stage is still *running* is the other case, and there
 * handing over to the plan run that continued it is right; that is covered in
 * managedRunTakesOver.test.ts, where the stage's status can be controlled
 * precisely.
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
  // The manifest this managed run executes, as the extension wrote it when
  // the plan was adopted: it is what gives Stage 4 its plan identity.
  //
  // Everything that makes it *this run's* is written too, because none of it
  // is optional: the file goes under the name the extension itself uses
  // (scoped to this project as well as to the plan key), beside the binding
  // record that says which worktree it was written for, and the plan-run state
  // records the executable digest of exactly those bytes — which is what the
  // engine does when it starts a run from a manifest.
  const manifests = (await vscode.commands.executeCommand("agentSparring._test.manifestDirectory")) as string;
  await fs.mkdir(manifests, { recursive: true });
  const manifestFile = path.join(manifests, manifestFileName(GATE_PLAN_KEY, reportedRepo));
  const THE_STAGES = [
    { stage_id: GATE_STAGE, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport", brief: "The transport." },
    { stage_id: stage4, label: "Stage 4", title: "Editor and UI inspection and guarded editing", brief: "The editor." },
  ];

  /** Write the manifest and its binding record; `record: false` leaves the run's recorded identity alone. */
  const writeExecutionManifest = async (stages: unknown[], options: { record?: boolean } = {}): Promise<void> => {
    const text = JSON.stringify({ version: 1, plan_label: GATE_PLAN_LABEL, source_digest: `sha256:${"0".repeat(64)}`, stages });
    const digest = parseExecutionManifest(text)?.digest;
    assert.ok(digest, "the manifest an integration scenario writes is one the engine would accept");
    await fs.writeFile(manifestFile, text);
    await fs.writeFile(
      path.join(manifests, bindingFileName(GATE_PLAN_KEY, reportedRepo)),
      renderBindingRecord({ version: BINDING_VERSION, manifestFile: path.basename(manifestFile), manifestDigest: digest, planKey: GATE_PLAN_KEY, planLabel: GATE_PLAN_LABEL, projectDir: reportedRepo }),
    );
    if (options.record !== false) {
      await fs.writeFile(planState, JSON.stringify({ current_stage: stage4, current_stage_index: 6, expected_branch: "feature/reported-statistics", plan: GATE_PLAN_LABEL, plan_digest: digest, source: "manifest", status: "running" }));
    }
  };

  await writeExecutionManifest(THE_STAGES);
  await vscode.commands.executeCommand("agentSparring.refresh");

  // The stage was accepted when it was chosen, so choosing it was a visit to
  // history — and the plan moving on is news about another run, not a reason
  // to close the page someone is reading. What the advance *does* change is
  // that the screen now knows whose history this is.
  const after = await model();
  assert.equal(after.runKind, "Historical stage", `the deliberate visit is kept, got ${String(after.runKind)} · ${String(after.stageHeading)}`);
  assert.match(after.stageHeading ?? "", /^Stage 3D — Snapshot v2/, `still the stage that was chosen, got ${String(after.stageHeading)}`);
  assert.match(after.followPlan?.text ?? "", /now at Stage 4/, "and the screen names the run that has taken over, and where it is");
  assert.equal(after.followPlan?.label, "Back to plan run", "with one way across, rather than the cockpit moving on its own");

  // Choosing it again changes nothing, which is the point: there is no state
  // here that a second look could disturb.
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", stageRunId), stageRunId);
  // With the plan linked to the finished stage, this screen is exactly the
  // one that offered Continue plan automatically and Start next stage.
  const planFile = path.join(reportedRepo, "plans", "reported-statistics.md");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.associatePlan", planFile), planFile);
  const history = await model();
  assert.equal(history.runKind, "Historical stage", "a deliberate visit is respected, and reads as history");
  assert.match(history.followPlan?.text ?? "", /now at Stage 4/, "and it names the run that has taken over");
  assert.equal(history.followPlan?.label, "Back to plan run");
  assert.match(history.stageHeading ?? "", /^Stage 3D — Snapshot v2/, "the stage is named as its own plan run names it");
  assert.equal(history.continueAutomatically, undefined, "adopting again is not offered");
  assert.equal(history.whatsNext?.kind, "next-created", "nor creating a stage the engine already created");

  // Withholding the button is not enough: the command itself must refuse.
  // "Continue plan automatically" is reachable from the Command Palette and
  // from a keybinding, and what it would do to a stage this run already
  // executed is create or adopt a *second* plan run over the same work.
  const refused = (await vscode.commands.executeCommand("agentSparring._test.continueAutomatically")) as { ok: boolean; reason?: string; message?: string };
  assert.equal(refused.ok, false, "the command path refuses, not just the screen");
  assert.equal(refused.reason, "owned", `refused because the stage is owned, got ${String(refused.reason)}`);
  assert.match(refused.message ?? "", /Stage 3D/, `and it names the stage and its run, got ${String(refused.message)}`);

  // No second plan run was created or adopted: the project still has exactly
  // the one the engine recorded.
  const afterRefusal = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;
  assert.deepEqual(
    afterRefusal.runs.filter((run) => run.kind === "plan").map((run) => run.id),
    [before.runs.find((run) => run.id.endsWith(`plan:${GATE_PLAN_KEY}`))?.id ?? `${reportedRepo}|plan:${GATE_PLAN_KEY}`].filter(Boolean),
    "exactly one plan run, the recorded one",
  );

  // A manifest that no longer describes the run is not half-believed: the
  // stage goes back to standing on its own rather than being attributed to a
  // run that cannot be shown to have executed it.
  await writeExecutionManifest([{ stage_id: "stage-9-rewritten", label: "Stage 9", title: "Rewritten", brief: "x" }], { record: false });
  await vscode.commands.executeCommand("agentSparring.refresh");
  await vscode.commands.executeCommand("agentSparring._test.chooseRun", stageRunId);
  const unbound = await model();
  assert.equal(unbound.runKind, "Standalone stage", `an unbound manifest attributes nothing, got ${String(unbound.runKind)}`);
  assert.equal(unbound.followPlan, undefined, "and there is no dead Back to plan run");

  // And that button switches to it.
  await writeExecutionManifest(THE_STAGES, { record: false });
  await vscode.commands.executeCommand("agentSparring.refresh");
  await vscode.commands.executeCommand("agentSparring._test.associatePlan", undefined);
  await vscode.commands.executeCommand("agentSparring._test.chooseRun", stageRunId);
  await vscode.commands.executeCommand("agentSparring._test.overviewAction", "openPlanRun");
  const followed = await model();
  assert.equal(followed.runKind, "Plan run");
  assert.equal(followed.stageId, stage4);
  console.log(
    "integration: after the managed run advanced, the deliberate visit to the finished stage is kept and reads as history of that run, one button crosses to it at Stage 4, an unbound manifest attributes nothing, and adopting the stage a second time is refused in the command path",
  );
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

  await runStage();
  const first = await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "the first run starts");
  const opened = ownTerminals();
  assert.equal(opened.length, 1, `one terminal, named for the project, got: ${JSON.stringify(vscode.window.terminals.map((terminal) => terminal.name))}`);
  assert.equal(opened[0].name, "Agent Sparring — sporely-py-reported-statistics");
  const stopped = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and it ends");
  assert.equal(stopped.execution?.exitCode, 0, "a finished execution cannot keep the UI running");

  await runStage();
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
  await runStage();
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

// ---------------------------------------------------------------- the user is working in the extension's terminal

/** The pool's own view: which owned terminals may be written to, and why not. */
async function ownedTerminalReport(): Promise<{ name: string; cwd: string; unavailable?: string }[]> {
  return (await vscode.commands.executeCommand("agentSparring._test.ownedTerminals")) as { name: string; cwd: string; unavailable?: string }[];
}

async function waitForOccupancy(name: string, expected: string | undefined, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = (await ownedTerminalReport()).find((terminal) => terminal.name === name);
    if ((last as { unavailable?: string } | undefined)?.unavailable === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`timed out waiting for: ${what}; last ${JSON.stringify(last)}`);
}

/**
 * An interactive occupant for a real terminal: it holds the shell's
 * foreground until it is killed, ignores ^C the way an interactive agent CLI
 * does — `shellIntegration.executeCommand` is documented to send ^C "as
 * necessary to interrupt any running command", and a `cat` that dies from it
 * would not reproduce anything — and writes down everything typed at it, so
 * `file` is the receipt for whether the terminal was written to.
 */
function occupy(terminal: vscode.Terminal, file: string): void {
  terminal.sendText(`sh -c 'trap "" INT; cat > ${file}'`, true);
}

/**
 * The reported defect, reproduced with a real shell.
 *
 * Agent Sparring had created and reused its project terminal; the engine
 * command finished; the person then started an interactive CLI in that same
 * terminal and left it running. The next engine command was handed to that
 * terminal anyway — because the only thing consulted was Agent Sparring's own
 * lease — so the `sparring …` line was typed into the interactive process
 * instead of being executed, and the extension went on to report "a runner
 * for this plan is alive in a terminal of this window" for a process that had
 * never been started.
 *
 * The occupant here is `cat > <file>`: an interactive command that holds the
 * shell's foreground for as long as it is left alone, and that writes down
 * anything typed at it — so the file is the receipt for whether the terminal
 * was written to. It must stay empty, the runner must be in a second Agent
 * Sparring terminal, and the occupant must still be running afterwards.
 */
async function occupiedTerminalAssertions(report: DiscoveryDiagnostic, reportedRepo: string, fixtureRoot: string): Promise<void> {
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; occupied-terminal scenario skipped");
    return;
  }
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");

  // 1. Agent Sparring opens its project terminal and finishes a command in it.
  await runStage();
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "the first run starts in the project's terminal");
  const [owned] = ownTerminals();
  assert.ok(owned, "the extension's terminal is open");
  const ownedName = "Agent Sparring — sporely-py-reported-statistics";
  assert.equal(owned.name, ownedName);
  const first = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and ends, leaving the terminal idle");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.hostingTerminal", runId), undefined, "a finished execution hosts nothing");
  await waitForOccupancy(ownedName, undefined, 10_000, "the idle terminal is available for reuse again");

  // 2. The user starts something interactive in it and leaves it running.
  const typed = path.join(fixtureRoot, "typed-into-the-occupied-terminal.txt");
  await fs.rm(typed, { force: true });
  occupy(owned, typed);
  await waitForOccupancy(ownedName, "occupied", 15_000, "the user's command makes the extension's own terminal unavailable");

  // 3. Run the stage again. Nothing may be written into the occupied terminal.
  await runStage();
  const second = await waitFor(runId, (liveness) => liveness.state === "running" && liveness.execution?.id !== first.execution?.id, 15_000, "the new run starts although the project's terminal is occupied");
  assert.equal(second.execution?.source, "launched", "and it was launched by this window, not inferred");

  const host = (await vscode.commands.executeCommand("agentSparring._test.hostingTerminal", runId)) as string | undefined;
  assert.notEqual(host, ownedName, "the runner is not in the terminal the user is working in");
  assert.equal(host, `${ownedName} (2)`, `a second Agent Sparring terminal ran it, got ${String(host)}`);
  const pool = await ownedTerminalReport();
  assert.deepEqual(
    pool.map((terminal) => [terminal.name, terminal.unavailable]),
    [
      [ownedName, "occupied"],
      [`${ownedName} (2)`, "leased"],
    ],
    `the occupied terminal is still the user's and the new one is ours, got ${JSON.stringify(pool)}`,
  );

  const received = await fs.readFile(typed, "utf8");
  assert.equal(received, "", `the occupied terminal received nothing, got ${JSON.stringify(received)}`);
  assert.equal(owned.exitStatus, undefined, "and the user's shell was neither interrupted nor closed");

  // 4. Only the runner that exists is tracked as live.
  const launches = ((await vscode.commands.executeCommand("agentSparring._test.persistedLaunches")) as { runId: string; state: string }[]).filter(
    (launch) => launch.runId === runId && launch.state === "running",
  );
  assert.equal(launches.length, 1, `exactly one live runner is recorded for this run, got ${JSON.stringify(launches)}`);

  await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "the new runner ends on its own");
  await waitForOccupancy(ownedName, "occupied", 5000, "and the user's command is still running after all of it");
  owned.dispose(); // ends the interactive occupant that was left running
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  console.log("integration: a terminal the user occupied received nothing, a second Agent Sparring terminal ran the engine, and only that runner is recorded as live");
}

// ---------------------------------------------------------------- a command the shell never took must not leave a runner

/** A workspaceState stand-in for a tracker built inside this suite. */
/**
 * A birth time in the exact shape `ps -o lstart=` prints (`Thu Sep 18
 * 11:12:13 2026`). Written from a real instant rather than a literal, because
 * a candidate process's age relative to an operation's hand-over is part of
 * what decides whether it can be that operation at all.
 */
function psLstart(atMs: number): string {
  const at = new Date(atMs);
  const [weekday, month, day] = at.toDateString().split(" ");
  return `${weekday} ${month} ${day} ${at.toTimeString().slice(0, 8)} ${at.getFullYear()}`;
}

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (<T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback)) as vscode.Memento["get"],
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

/**
 * The other half of the same defect: what must happen when a command *is*
 * handed to a shell that does not run it.
 *
 * Handing `shellIntegration.executeCommand` a command line writes that line
 * into the terminal; it does not guarantee that the shell runs it, and it does
 * not guarantee that the shell never will. The extension used to record a
 * runner as live on the strength of the hand-over alone — "a runner for this
 * plan is alive in a terminal of this window" with no sparring process
 * anywhere — and then, when that was fixed by discarding the submission at
 * the timeout, it lost the identity of a command that could still start.
 *
 * Both halves are built here on purpose, with a tracker whose pool hands out a
 * terminal regardless of occupancy:
 *
 *  A. a shell whose foreground belongs to an interactive process that eats the
 *     command line. Nothing may be recorded as running, nothing persisted, the
 *     terminal never written to again, the engine never run — and the
 *     submission stays unresolved. Closing that terminal was once treated as
 *     the one thing that proved the command could no longer run; it proves
 *     nothing, because this window cannot know the shell did not read the line
 *     first, so the guard remains and only the person settles it.
 *  B. a shell stopped with SIGSTOP, the reviewer's reproduction: the command is
 *     taken now and executed minutes later. Until then nothing is running and
 *     a second copy is refused; when the shell continues, that exact execution
 *     must be promoted to a real runner, persisted, and ended normally.
 */
async function falseRunnerAssertions(reportedRepo: string, fixtureRoot: string): Promise<void> {
  if (!(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: shell integration unavailable in this host; false-runner scenario skipped");
    return;
  }
  const executable = vscode.workspace.getConfiguration("agentSparring").get<string>("executable", "");
  const argvLog = path.join(fixtureRoot, "fake-argv.log");

  // ---- A. the command line is eaten by whatever holds the shell ----------
  {
    const terminal = vscode.window.createTerminal({ name: "user's own terminal (false-runner regression)", cwd: reportedRepo });
    const integration = await shellIntegrationFor(terminal, 8000);
    if (!integration) {
      terminal.dispose();
      console.log("integration: shell integration did not activate for a plain terminal; false-runner scenario skipped");
      return;
    }
    const typed = path.join(fixtureRoot, "typed-into-the-bypassed-terminal.txt");
    await fs.rm(typed, { force: true });
    await fs.rm(argvLog, { force: true });
    occupy(terminal, typed);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // let the occupant take the foreground

    const { lease, retired } = bypassLease(terminal);
    const logged: string[] = [];
    const { tracker, registry, dispose } = trackerOver(lease, logged);
    const runId = "false-runner-regression";
    try {
      const result = await tracker.launch({
        configured: executable,
        args: ["run-plan", "plans/never-executed.md", "--repo-root", reportedRepo],
        cwd: reportedRepo,
        name: "false-runner regression",
        runId,
        kind: "run-plan",
        reveal: false,
      });
      assert.equal(result.ok, false, "a command the shell has not started is not a launch");
      assert.equal(result.ok ? undefined : result.problem, "unconfirmed", "and it is not reported as a configuration problem");
      assert.match(result.ok ? "" : result.error, /has not been able to confirm whether it started/);
      assert.doesNotMatch(result.ok ? "" : result.error, /runner .*alive/i, "and never as a live runner");
      assert.equal(tracker.executionFor(runId), undefined, "no runner record: not running, not even ended");
      assert.equal(tracker.hostingTerminal(runId), undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(tracker.persisted(), [], "and a window reload would find no live runner either");
      assert.equal(retired(), true, "the terminal is quarantined: never written to again");
      assert.equal(terminal.exitStatus, undefined, "while the user's command is left alone, not interrupted");
      assert.ok(!(await fs.stat(argvLog).then(() => true, () => false)), "the engine never ran: the fake sparring recorded no argv");

      // The submission itself is kept: nothing here can prove that command
      // will never run, so a second one is refused rather than submitted.
      const pending = registry.unresolved();
      assert.equal(pending.length, 1, `the submission is retained, got ${JSON.stringify(pending)}`);
      assert.equal(pending[0].state, "submitted-shell");
      assert.equal(pending[0].waitExpired, true, "its wait ran out, which changes nothing about the guard");
      assert.equal(pending[0].runId, runId);
      const second = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md", "--repo-root", reportedRepo], cwd: reportedRepo, name: "false-runner regression (again)", runId, kind: "run-plan", reveal: false });
      assert.equal(second.ok, false, "a second copy of the same operation is refused while the first may still start");
      assert.equal(second.ok ? undefined : second.problem, "unconfirmed");
      assert.equal(registry.unresolved().length, 1, "and nothing new was submitted");

      // Closing that terminal settles nothing. It used to resolve the
      // submission as `cannot-execute`, on the argument that the shell holding
      // the queued line had gone with the pty — but this window cannot know
      // that the shell did not read the line first, and an engine it started
      // would be reparented rather than killed. So the guard stays, the record
      // says observation was lost, and only the person settles it.
      terminal.dispose();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const afterClose = registry.unresolved();
      assert.equal(afterClose.length, 1, `closing the terminal leaves the submission exactly where it was, got ${JSON.stringify(afterClose)}`);
      assert.equal(afterClose[0].state, "submitted-shell");
      assert.equal(afterClose[0].observationLost, true, "with the record saying that what was lost is the observation");
      assert.ok(
        !logged.some((line) => /resolved as cannot-execute/.test(line)),
        `and nothing was resolved as cannot-execute, got ${JSON.stringify(logged.filter((line) => /resolved as/.test(line)))}`,
      );
      assert.equal(tracker.executionFor(runId), undefined, "still no execution: nothing was ever observed running");
      const thirdTime = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md", "--repo-root", reportedRepo], cwd: reportedRepo, name: "false-runner regression (after the close)", runId, kind: "run-plan", reveal: false });
      assert.equal(thirdTime.ok, false, "so a duplicate is still refused");
      assert.match(thirdTime.ok ? "" : thirdTime.error, /cannot determine whether that command ran/, "and the reason is the honest one");

      // The explicit human override, on that exact operation id, is the way
      // out — recorded as the person's statement, never as evidence.
      assert.equal(registry.override(afterClose[0].id, "the person checked the terminal after closing it").overridden, true);
      assert.deepEqual(registry.unresolved(), [], "after which the operation may be given again");
      assert.ok(logged.some((line) => /resolved as human-override/.test(line)), "recorded as an override");
      const received = await fs.readFile(typed, "utf8").catch(() => "");
      console.log(`integration: the bypassed terminal's occupant received ${JSON.stringify(received.trim().slice(0, 60))}`);
    } finally {
      dispose();
      terminal.dispose();
    }
  }

  // ---- B. a stopped shell runs the command minutes later ------------------
  if (process.platform === "win32") {
    console.log("integration: SIGSTOP is not available on this platform; late-start half skipped");
    return;
  }
  {
    const terminal = vscode.window.createTerminal({ name: "a stopped shell (late-start regression)", cwd: reportedRepo });
    const integration = await shellIntegrationFor(terminal, 8000);
    const pid = await terminal.processId;
    if (!integration || pid === undefined) {
      terminal.dispose();
      console.log("integration: no shell integration or pid for the stopped-shell terminal; late-start half skipped");
      return;
    }
    await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");
    await fs.rm(argvLog, { force: true });
    const { lease, retired } = bypassLease(terminal);
    const logged: string[] = [];
    const { tracker, registry, dispose } = trackerOver(lease, logged);
    const runId = "late-start-regression";
    const stage = "stage-reported-statistics-typed-parser";
    let stopped = false;
    try {
      process.kill(pid, "SIGSTOP");
      stopped = true;
      const result = await tracker.launch({
        configured: executable,
        args: ["run-loop", stage, "--repo-root", reportedRepo, "--expected-branch", "feature/reported-statistics"],
        cwd: reportedRepo,
        name: "late-start regression",
        runId,
        kind: "run-loop",
        stageId: stage,
        reveal: false,
      });
      assert.equal(result.ok, false, "the stopped shell has not started it, so this is not a launch");
      assert.equal(result.ok ? undefined : result.problem, "unconfirmed");
      assert.equal(tracker.executionFor(runId), undefined, "and nothing is running");
      assert.equal(retired(), true, "its terminal is quarantined while its fate is unknown");
      const waiting = registry.unresolved();
      assert.equal(waiting.length, 1, "the identity of the submitted command is kept");
      assert.equal(waiting[0].state, "submitted-shell");

      // The shell continues, reads the line it was given, and runs it.
      process.kill(pid, "SIGCONT");
      stopped = false;
      const promoted = await waitUntil(() => tracker.executionFor(runId), 20_000, "the late start is promoted to a real running execution");
      assert.equal(promoted.state, "running", "the exact execution became the runner");
      assert.equal(promoted.source, "launched", "promoted by execution identity, not rediscovered from a command line");
      assert.equal(tracker.hostingTerminal(runId), terminal.name);
      // Started is not "safe to start another". The same record advances to
      // running, keeps refusing a duplicate, and is released by this
      // execution's own end.
      assert.equal(registry.inFlightFor(`run:${runId}`)?.state, "running-shell", "the same record now guards it as running");
      assert.deepEqual(registry.unresolved(), [], "and this window is watching it, so there is nothing to ask a person about");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(
        tracker.persisted().filter((launch) => launch.runId === runId),
        [{ runId, state: "running" }],
        "a reload would now find exactly this one live runner",
      );
      assert.ok(logged.some((line) => /started it .*long after the wait had expired/.test(line)), `the log says it started late, got ${JSON.stringify(logged)}`);
      assert.ok(await fs.stat(argvLog).then(() => true, () => false), "and the engine really did run");

      const ended = await waitUntil(() => {
        const record = tracker.executionFor(runId);
        return record?.state === "ended" ? record : undefined;
      }, 25_000, "its end is observed in the ordinary way");
      assert.equal(ended.exitCode, 0, "with the shell's own exit code");
      assert.deepEqual(tracker.persisted().filter((launch) => launch.runId === runId), [{ runId, state: "ended" }]);
    } finally {
      if (stopped) {
        try {
          process.kill(pid, "SIGCONT");
        } catch {
          // the shell is already gone
        }
      }
      dispose();
      terminal.dispose();
    }
  }
  // ---- C. a window reload finds a submission it cannot recognise --------
  //
  // VS Code cannot hand a `TerminalShellExecution` back, so a reloaded window
  // can no longer promote a late start by identity. That must fail safe, and
  // failing safe is not the same as giving up after six seconds: the
  // reconnect grace period says only that VS Code did not bring a terminal
  // back in time, which is no evidence at all about whether a shell is alive.
  // The submission survives it, and what can settle it afterwards is a fact
  // about a process that was positively tied to it — never a command line
  // that merely matches, which may be another window's, another invocation's,
  // or older than the hand-over.
  {
    const runId = "reloaded-submission-regression";
    const shellPid = 2147480000; // a pid no process on this machine has
    const persisted = [
      {
        id: "submission-from-the-previous-window",
        key: `run:${runId}`,
        transport: "runner",
        label: "run-plan plans/never-executed.md",
        cwd: reportedRepo,
        subcommand: "run-plan",
        runId,
        runnerKind: "run-plan",
        planPath: "plans/never-executed.md",
        word: executable,
        // The exact invocation, as the durable intent records it for every
        // transport. A relative plan path cannot be compared against anything
        // `ps` prints, so this argument array is the only thing that can
        // recognise this command in a process table.
        invocation: { word: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo },
        submittedAtMs: Date.now() - 4000,
        terminalPid: shellPid,
        terminalName: "Agent Sparring — sporely-py-reported-statistics",
      },
    ];

    // C1: no process probe on this platform — the submission must simply stay.
    {
      const stored = memento();
      await stored.update(OPERATIONS_KEY, persisted);
      const logged: string[] = [];
      const registry = new OperationRegistry({ workspaceState: stored } as unknown as vscode.ExtensionContext, (message: string) => logged.push(message), () => false, async () => []);
      const tracker = trackerWith(registry, stored, logged);
      try {
        const reattaching = tracker.reattach();
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.deepEqual(
          registry.unresolved().map((item) => [item.runId, item.state, item.restored]),
          [[runId, "submitted-shell", true]],
          "restored as still submitted to a shell, and it says it came from before the reload",
        );
        assert.equal(tracker.executionFor(runId), undefined, "no runner is claimed for it");
        const refused = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo, name: "after the reload", runId, kind: "run-plan", reveal: false });
        assert.equal(refused.ok, false, "and a duplicate is not submitted on the assumption that nothing happened");
        assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");
        assert.match(refused.ok ? "" : refused.error, /window has reloaded since/, "the reason is the reload, and it is said so");

        // The grace period passes with no terminal coming back. That settles
        // nothing, and the submission must still be there.
        await reattaching;
        assert.equal(registry.unresolved().length, 1, "the reconnect grace period is not evidence and does not clear it");
        const again = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo, name: "after the grace period", runId, kind: "run-plan", reveal: false });
        assert.equal(again.ok, false, "so a duplicate is still refused");
        assert.ok(logged.some((line) => /no process probe is available/.test(line)), `and the log says why nothing can settle it here, got ${JSON.stringify(logged)}`);

        // Only a person can settle it on such a platform, and that is an
        // override, recorded as theirs.
        const held = registry.inFlightFor(`run:${runId}`);
        assert.ok(held, "the restored record is there");
        assert.equal(registry.override(held.id, "the person checked the terminal").overridden, true);
        assert.deepEqual(registry.unresolved(), [], "after which the operation may be given again");
        assert.ok(logged.some((line) => /resolved as human-override/.test(line)), "recorded as an override, not as evidence");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    }

    // C2: the process table can speak, and says that shell is gone — which is
    // not an answer. The shell may have read the line and died afterwards, and
    // an engine it started is reparented rather than killed, so a missing
    // shell plus an empty table is exactly "nobody knows". This used to
    // resolve the operation as `cannot-execute` and admit a duplicate.
    {
      const stored = memento();
      await stored.update(OPERATIONS_KEY, persisted);
      const logged: string[] = [];
      const registry = new OperationRegistry({ workspaceState: stored } as unknown as vscode.ExtensionContext, (message: string) => logged.push(message), () => true, async () => [{ pid: 1, ppid: 0, command: "/sbin/launchd" }]);
      const tracker = trackerWith(registry, stored, logged);
      try {
        await tracker.reattach();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const held = registry.unresolved();
        assert.equal(held.length, 1, `a shell that is gone does not settle a line it may already have read, got ${JSON.stringify(held)}`);
        assert.equal(held[0].state, "submitted-shell");
        assert.equal(held[0].observationLost, true, "the record says the observation is what was lost");
        assert.ok(!logged.some((line) => /resolved as cannot-execute/.test(line)), `and nothing was resolved as cannot-execute, got ${JSON.stringify(logged)}`);
        assert.equal(tracker.executionFor(runId), undefined, "nothing is recorded as having run either: that is equally unknown");
        const refused = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo, name: "while it is unknown", runId, kind: "run-plan", reveal: false });
        assert.equal(refused.ok, false, "so the duplicate stays refused");
        assert.equal(registry.override(held[0].id, "the person checked").overridden, true, "and only the person settles it");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    }

    // C2b: a process that was positively tied to this operation *before* its
    // shell was lost. The shell has since gone and the engine has been
    // reparented to pid 1, and none of that matters: the record carries that
    // pid and its birth time, so the question is about a process and is
    // answered correctly wherever in the tree it has ended up.
    {
      const engine = `${executable} run-plan plans/never-executed.md`;
      const born = psLstart(Date.now() - 4000);
      const stored = memento();
      await stored.update(OPERATIONS_KEY, [{ ...persisted[0], state: "running-shell", enginePid: 2147480500, generation: born }]);
      const logged: string[] = [];
      let table = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        { pid: 2147480500, ppid: 1, command: engine, started: born },
      ];
      const registry = new OperationRegistry({ workspaceState: stored } as unknown as vscode.ExtensionContext, (message: string) => logged.push(message), () => true, async () => table);
      const tracker = trackerWith(registry, stored, logged);
      try {
        await tracker.reattach();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const [running] = registry.unresolved();
        assert.equal(running?.state, "running-shell", "the identity it already had is still its identity after the reparenting");
        assert.equal(running.enginePid, 2147480500, "on the pid that was bound to it, not on a command line found again");
        assert.ok(!logged.some((line) => /resolved as/.test(line)), `and nothing was resolved on the way there, got ${JSON.stringify(logged.filter((line) => /resolved as/.test(line)))}`);
        const refused = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo, name: "over a live reparented engine", runId, kind: "run-plan", reveal: false });
        assert.equal(refused.ok, false, "a duplicate over a live engine is refused");

        // That pid going is the evidence, and the only evidence.
        table = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];
        await waitUntil(() => (registry.unresolved().length === 0 ? true : undefined), 15_000, "the guard to be released once that process is gone");
        assert.ok(logged.some((line) => /resolved as completed \(engine-process-gone\)/.test(line)), `settled by a fact about that process, got ${JSON.stringify(logged.filter((line) => /resolved as/.test(line)))}`);
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    }

    // C2c: the same table, and nothing ever tied any of it to this hand-over.
    // A process running byte-identically what this operation was given may be
    // another window's, another invocation's, or older than the line itself,
    // and adopting it would mean its exit releases our guard. This is what
    // the whole-table search used to do here.
    {
      const engine = `${executable} run-plan plans/never-executed.md`;
      const stored = memento();
      await stored.update(OPERATIONS_KEY, persisted);
      const logged: string[] = [];
      let table = [
        { pid: 1, ppid: 0, command: "/sbin/launchd" },
        { pid: 2147480501, ppid: 1, command: engine, started: psLstart(Date.now() - 4000) },
      ];
      const registry = new OperationRegistry({ workspaceState: stored } as unknown as vscode.ExtensionContext, (message: string) => logged.push(message), () => true, async () => table);
      const tracker = trackerWith(registry, stored, logged);
      try {
        await tracker.reattach();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const [held] = registry.unresolved();
        assert.equal(held?.state, "submitted-shell", `an unattributed look-alike is not this operation's process, got ${JSON.stringify(registry.unresolved())}`);
        assert.equal(held.enginePid, undefined, "so no pid was bound to it");
        assert.equal(held.observationLost, true, "what was lost is the observation, and it stays lost");
        assert.ok(!logged.some((line) => /resolved as/.test(line)), "and nothing was resolved");

        // That process ending is not our evidence, because it was never ours.
        table = [{ pid: 1, ppid: 0, command: "/sbin/launchd" }];
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(registry.unresolved()[0]?.state, "submitted-shell", "a stranger's exit releases nothing");
        assert.ok(!logged.some((line) => /resolved as/.test(line)), "still nothing resolved");
        const refused = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo, name: "while nothing can identify it", runId, kind: "run-plan", reveal: false });
        assert.equal(refused.ok, false, "so the duplicate stays refused");
        assert.equal(registry.override(held.id, "the person checked").overridden, true, "and only the person settles it");
        assert.ok(logged.some((line) => /resolved as human-override/.test(line)), "recorded as an override, never as evidence");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    }

    // C3: the process table can speak, and the shell is still alive. Nothing
    // is proved, so the submission stays and a duplicate stays refused.
    {
      const stored = memento();
      await stored.update(OPERATIONS_KEY, persisted);
      const logged: string[] = [];
      const registry = new OperationRegistry({ workspaceState: stored } as unknown as vscode.ExtensionContext, (message: string) => logged.push(message), () => true, async () => [{ pid: shellPid, ppid: 1, command: "-zsh" }]);
      const tracker = trackerWith(registry, stored, logged);
      try {
        await tracker.reattach();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(registry.unresolved().length, 1, "a shell that is still alive settles nothing");
        const refused = await tracker.launch({ configured: executable, args: ["run-plan", "plans/never-executed.md"], cwd: reportedRepo, name: "while the shell lives", runId, kind: "run-plan", reveal: false });
        assert.equal(refused.ok, false, "and the duplicate stays refused");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    }
  }

  // ---- D. an unrelated runner in the same project proves nothing ---------
  //
  // The project probe answers "is there a runner in this project". A queued
  // `run-plan --manifest X` is not answered by a `run-loop` for some other
  // stage, and the two must coexist: the probed runner may come and go while
  // the submission keeps refusing a duplicate.
  {
    const runId = "unrelated-runner-regression";
    const other = `${executable} run-loop stage-some-other-thing --repo-root ${reportedRepo}`;
    const shellPid = 2147480001;
    const manifest = "/store/manifests/reported-statistics.manifest.json";
    const stored = memento();
    await stored.update(OPERATIONS_KEY, [
      {
        id: "operation-awaiting-its-fate",
        key: `run:${runId}`,
        state: "submitted-shell",
        transport: "shell",
        caller: "runner",
        label: "run-plan reported-statistics.manifest.json",
        repoRoot: reportedRepo,
        cwd: reportedRepo,
        subcommand: "run-plan",
        runId,
        runnerKind: "run-plan",
        manifest,
        word: executable,
        submittedAtMs: Date.now() - 4000,
        terminalPid: shellPid,
        terminalName: "Agent Sparring — sporely-py-reported-statistics",
      },
    ]);
    const logged: string[] = [];
    // The process table holds that other runner *and* the shell that took our
    // command, so neither "the shell is gone" nor "this is my operation"
    // applies.
    let processes: ProcessInfo[] = [
      { pid: shellPid, ppid: 1, command: "-zsh" },
      { pid: 4242, ppid: 1, command: other },
    ];
    const registry = new OperationRegistry({ workspaceState: stored } as unknown as vscode.ExtensionContext, (message: string) => logged.push(message), () => true, async () => processes);
    const tracker = trackerWith(registry, stored, logged);
    try {
      registry.restore();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(registry.unresolved().length, 1, "an unrelated run-loop does not answer for a queued run-plan");

      // The unrelated runner ends. That says nothing about our operation either.
      processes = [{ pid: shellPid, ppid: 1, command: "-zsh" }];
      await registry.probeAll();
      assert.equal(registry.unresolved().length, 1, "and its ending does not answer for it retrospectively");
      const refused = await tracker.launch({ configured: executable, args: ["run-plan", "--manifest", manifest], cwd: reportedRepo, name: "while another stage runs", runId, kind: "run-plan", manifest, reveal: false });
      assert.equal(refused.ok, false, "so the duplicate run-plan stays refused throughout");
      assert.equal(refused.ok ? undefined : refused.problem, "unconfirmed");

      // The same command line, in another repository. It is a different
      // operation and must not touch this one — this is the reviewer's
      // reproduction, and it used to resolve the guard.
      processes = [
        { pid: shellPid, ppid: 1, command: "-zsh" },
        { pid: 4343, ppid: shellPid, command: `${executable} run-plan --manifest ${manifest} --repo-root /some/other/repo` },
      ];
      await registry.probeAll();
      assert.equal(registry.unresolved().length, 1, "a run-plan for another repository is another operation");

      // The same manifest basename at another full path. Also a different
      // operation, and also used to resolve this one.
      processes = [
        { pid: shellPid, ppid: 1, command: "-zsh" },
        { pid: 4344, ppid: shellPid, command: `${executable} run-plan --manifest /elsewhere/reported-statistics.manifest.json --repo-root ${reportedRepo}` },
      ];
      await registry.probeAll();
      assert.equal(registry.unresolved().length, 1, "a manifest of the same name elsewhere is another manifest");

      // This exact command, running under the shell that was given the line.
      // That proves it started — and "started" is a reason to keep refusing
      // a duplicate, not to stop: the record advances, and stays guarded.
      processes = [
        { pid: shellPid, ppid: 1, command: "-zsh" },
        { pid: 4345, ppid: shellPid, command: `${executable} run-plan --manifest ${manifest} --repo-root ${reportedRepo}` },
      ];
      await registry.probeAll();
      assert.equal(registry.inFlightFor(`run:${runId}`)?.state, "running-shell", "the exact command under that exact shell proves it started");
      const stillRefused = await tracker.launch({ configured: executable, args: ["run-plan", "--manifest", manifest], cwd: reportedRepo, name: "while it is running", runId, kind: "run-plan", manifest, reveal: false });
      assert.equal(stillRefused.ok, false, "and a duplicate is still refused, because it is executing");

      // Only its disappearance from the table ends it.
      processes = [{ pid: shellPid, ppid: 1, command: "-zsh" }];
      await registry.probeAll();
      assert.deepEqual(registry.unresolved(), [], "and it is over when that process is gone");
      assert.ok(logged.some((line) => /resolved as completed \(engine-process-gone\)/.test(line)), `settled by evidence about that process, got ${JSON.stringify(logged.filter((line) => line.includes("resolved")))}`);
    } finally {
      tracker.dispose();
      registry.dispose();
    }
  }

  console.log(
    "integration: an unconfirmed submission keeps its identity and refuses a second copy; its terminal closing and its shell disappearing both leave it guarded, a process already tied to it is followed through reparenting while a mere look-alike is never adopted, an unrelated runner never answers for it, and a stopped shell that runs it later is promoted to a real, persisted, normally-ended runner",
  );
}

// ---------------------------------------------------------------- what a direct execution's lifetime is actually tied to

/**
 * Whether an engine operation this window started *without* a shell can
 * outlive the window. The submission record's safety identity for those two
 * transports depended on the answer, and the answer had been assumed.
 *
 * The dedicated-terminal fallback (executionTracker.ts) is the half that can
 * be settled here: a terminal's process is not spawned by the extension host
 * at all — VS Code's pty host owns it — so restarting the extension host,
 * which is what a window reload does, cannot end it. This asserts that from
 * the process table: the extension host (`process.pid`) is nowhere in the
 * terminal process's ancestry. Terminal reconnection after a reload is then
 * ordinary VS Code behaviour (`terminal.integrated.enablePersistentSessions`,
 * on by default), and the tracker already relies on it — `reattachTo` finds a
 * dedicated terminal by its pid and calls the runner alive.
 *
 * The execFile fallback (commandRunner.ts) cannot be reload-tested in this
 * host either, but its lifetime is the same POSIX fact and is asserted in
 * src/test/directExecutionSurvival.test.ts against a parent that is really
 * SIGKILLed: the child survives, reparented to pid 1, with its command line
 * intact in the process table.
 */
async function directExecutionOutlivesTheWindowAssertions(): Promise<void> {
  if (!processProbeSupported()) {
    console.log(`integration: no process probe on ${process.platform}; direct-execution lifetime section skipped`);
    return;
  }
  const persistent = vscode.workspace.getConfiguration("terminal.integrated").get<boolean>("enablePersistentSessions");
  const terminal = vscode.window.createTerminal({ name: "a dedicated runner terminal", shellPath: "/bin/sh", shellArgs: ["-c", "sleep 120"] });
  try {
    const pid = await terminal.processId;
    assert.ok(pid !== undefined, "the dedicated terminal's process id");
    const processes = await listProcesses();
    const byPid = new Map(processes.map((item) => [item.pid, item]));
    const ancestry: ProcessInfo[] = [];
    for (let current = byPid.get(pid); current && current.pid !== 1 && ancestry.length < 12; current = byPid.get(current.ppid)) {
      ancestry.push(current);
    }
    assert.ok(ancestry.length > 1, `the terminal process has an ancestry, got ${JSON.stringify(ancestry)}`);
    assert.equal(ancestry[0].pid, pid, "the chain starts at the terminal's own process");
    assert.ok(
      !ancestry.some((item) => item.pid === process.pid),
      `the extension host (pid ${process.pid}) must not be in the terminal process's ancestry, got ${JSON.stringify(ancestry.map((item) => [item.pid, item.command.slice(0, 60)]))}`,
    );
    console.log(
      `integration: a dedicated terminal's process (${pid}) is owned by ${JSON.stringify(ancestry[1]?.command.slice(0, 80) ?? "?")}, not by the extension host (${process.pid}); persistent sessions ${persistent === false ? "off" : "on"} — so a window reload cannot end it`,
    );
  } finally {
    terminal.dispose();
  }
}

// ---------------------------------------------------------------- a short engine command submitted to a stopped shell

/**
 * The reviewer's third reproduction: the duplicate the *short* commands could
 * still do.
 *
 * `freeze-candidate` and `accept-candidate` change engine state, and they go
 * to a shell the same way a runner does. When that shell is stopped, the
 * command is taken and not run — and the previous implementation only wrote a
 * log line about it, so pressing Accept stage again submitted a second copy
 * and both ran when the shell continued.
 *
 * They now use the same durable submission authority as the runner commands:
 * the retry is refused, nothing is written anywhere, and when the shell
 * continues the one submitted command runs once.
 */
async function shortCommandAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  if (process.platform === "win32" || !(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: SIGSTOP or shell integration unavailable in this host; short-command scenario skipped");
    return;
  }
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const stage = "stage-review-complete-dirty";
  const runId = runIdOf(report, reportedRepo, stage);
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  const callsLog = path.join(reportedRepo, ".sparring", "fake-calls.log");
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");
  await fs.rm(callsLog, { force: true });

  // One ordinary run so the project's terminal exists, is ours and is idle.
  await runStage();
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "a first run opens the project's terminal");
  await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and leaves it idle");
  const [owned] = ownTerminals();
  const pid = await owned.processId;
  assert.ok(owned && pid !== undefined, "the extension's terminal and its shell's pid");
  await fs.rm(callsLog, { force: true });

  const warnings = captureWarnings();
  let stopped = false;
  try {
    process.kill(pid, "SIGSTOP");
    stopped = true;
    const first = (await vscode.commands.executeCommand("agentSparring._test.acceptStage")) as { ok: boolean } | undefined;
    assert.equal(first, undefined, "Accept stage cannot report a result for a command the shell has not run");
    const submissions = await pendingSubmissions();
    assert.deepEqual(
      submissions.map((item) => [item.subcommand, item.state]),
      [["freeze-candidate", "submitted-shell"]],
      `the short command is on the same durable record as a runner command, got ${JSON.stringify(submissions)}`,
    );

    // The retry. This is the duplicate the reviewer produced.
    warnings.messages.length = 0;
    const retry = (await vscode.commands.executeCommand("agentSparring._test.acceptStage")) as { ok: boolean } | undefined;
    assert.equal(retry, undefined, "the retry does not run either");
    assert.ok(
      warnings.messages.some((message) => /has not been able to confirm whether it started/.test(message)),
      `it is refused for the right reason, got ${JSON.stringify(warnings.messages)}`,
    );
    assert.equal((await pendingSubmissions()).length, 1, "and no second copy was submitted");
    assert.equal(ownTerminals().length, 1, "nor a second terminal opened for one");
    assert.equal(await fs.readFile(callsLog, "utf8").catch(() => ""), "", "the engine has run nothing at all so far");

    // The shell continues. The one submitted freeze-candidate runs, once.
    process.kill(pid, "SIGCONT");
    stopped = false;
    const calls = await waitUntil(async () => {
      const text = await fs.readFile(callsLog, "utf8").catch(() => "");
      return text.includes("freeze-candidate") ? text : undefined;
    }, 20_000, "the submitted freeze-candidate runs when the shell continues");
    assert.deepEqual(calls.trim().split("\n"), [`freeze-candidate ${stage}`], "exactly once, and nothing else");
    await waitUntil(async () => ((await pendingSubmissions()).length === 0 ? true : undefined), 15_000, "and its fate is reconciled by its own execution's end, not by its start");
  } finally {
    if (stopped) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // already gone
      }
    }
    warnings.restore();
    for (const terminal of ownTerminals()) {
      terminal.dispose();
    }
  }
  console.log("integration: a short engine command submitted to a stopped shell blocks its own retry durably, runs exactly once when the shell continues, and is reconciled");
}

// ---------------------------------------------------------------- the reviewer's reproduction, through the product

/**
 * The same late start, but through the commands a person actually presses.
 *
 * `Run stage` on an idle owned terminal whose shell has been stopped
 * (SIGSTOP): shell integration takes the command line, the shell runs nothing,
 * and five seconds later the extension has to say something. What it must not
 * say is that a runner is alive, and what it must not do is submit a second
 * copy — the stopped shell will run the first one the moment it continues,
 * which is what this asserts.
 */
async function lateStartAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  if (process.platform === "win32" || !(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: SIGSTOP or shell integration unavailable in this host; late-start scenario skipped");
    return;
  }
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");

  // An ordinary run first, so the terminal is one of ours, idle, and proven.
  await runStage();
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "the first run starts");
  const first = await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and ends, leaving the terminal idle");
  const [owned] = ownTerminals();
  const pid = await owned.processId;
  assert.ok(owned && pid !== undefined, "the extension's terminal and its shell's pid");

  const warnings = captureWarnings();
  let stopped = false;
  try {
    process.kill(pid, "SIGSTOP");
    stopped = true;
    // Not awaited: the assertions below are about the window *while* the
    // extension is waiting for a start that is not coming yet.
    const launching = runStage();

    // Before the wait expires: a submission is not a runner.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const early = await livenessOf(runId);
    assert.notEqual(early.state, "running", "a submitted command is not a running runner");
    assert.notEqual(early.execution?.state, "running", `and no running execution record is exposed, got ${JSON.stringify(early.execution)}`);
    assert.equal(early.execution?.id, first.execution?.id, "the newest record is still the previous, ended one");
    const pendingEarly = await pendingSubmissions();
    assert.deepEqual(
      pendingEarly.map((item) => [item.runId, item.state]),
      [[runId, "submitted-shell"]],
      `the submission is tracked separately, got ${JSON.stringify(pendingEarly)}`,
    );
    assert.deepEqual(await runningLaunches(runId), [], "and nothing is persisted as an established running launch");

    // After it expires: still no runner, and the person is told what is
    // actually known.
    await launching;
    assert.notEqual((await livenessOf(runId)).state, "running");
    assert.deepEqual((await pendingSubmissions()).map((item) => [item.state, item.waitExpired]), [["submitted-shell", true]], "the submission survives the wait, unchanged in substance");
    assert.ok(
      warnings.messages.some((message) => /has not been able to confirm whether it started/.test(message)),
      `the wording says exactly that, got ${JSON.stringify(warnings.messages)}`,
    );
    assert.ok(!warnings.messages.some((message) => /runner .*alive/i.test(message)), "and never claims a live runner");
    const pool = await ownedTerminalReport();
    assert.ok(!pool.some((terminal) => terminal.name === owned.name), `the quarantined terminal is out of the pool, got ${JSON.stringify(pool)}`);

    // A retry is refused for that reason, and submits nothing.
    warnings.messages.length = 0;
    await runStage();
    assert.ok(
      warnings.messages.some((message) => /has not been able to confirm whether it started/.test(message)),
      `the retry is refused as unconfirmed, got ${JSON.stringify(warnings.messages)}`,
    );
    assert.equal((await pendingSubmissions()).length, 1, "no second command was submitted");
    assert.equal(ownTerminals().length, 1, "and no second terminal was opened for it");

    // The shell continues and runs the command it was given five seconds ago.
    process.kill(pid, "SIGCONT");
    stopped = false;
    const late = await waitFor(runId, (liveness) => liveness.state === "running", 20_000, "the late start becomes a real running runner");
    assert.equal(late.execution?.source, "launched", "promoted by execution identity");
    assert.notEqual(late.execution?.id, first.execution?.id);
    // The guard is not lifted by the start — it advances with it, and this
    // window is now watching that execution, so there is nothing left to ask
    // a person about.
    assert.deepEqual(await pendingSubmissions(), [], "and there is nothing outstanding for a person once this window watches it");
    assert.equal(await vscode.commands.executeCommand("agentSparring._test.hostingTerminal", runId), owned.name);
    assert.deepEqual(await runningLaunches(runId), [{ runId, state: "running" }], "now, and only now, a reload would find a live runner");

    const ended = await waitFor(runId, (liveness) => liveness.state === "stopped", 25_000, "and its end clears the state in the ordinary way");
    assert.equal(ended.execution?.exitCode, 0);
  } finally {
    if (stopped) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // already gone
      }
    }
    warnings.restore();
    for (const terminal of ownTerminals()) {
      terminal.dispose();
    }
  }
  console.log("integration: a command submitted to a stopped shell is never a runner, refuses a second copy with its own wording, and is promoted, persisted and ended normally when the shell continues");
}

// ---------------------------------------------------------------- the human override

/**
 * The only way out of an unresolvable submission that is not evidence.
 *
 * Agent Sparring cannot cancel a line a shell has already been given, so
 * "Discard submission" would have been a lie: clicking it proves nothing about
 * whether the command will run. It is therefore an explicit override — the
 * person states that they have checked the terminal and that the command
 * cannot start — it takes a modal confirmation, and it is recorded as theirs
 * rather than as an observation.
 */
async function overrideAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  if (process.platform === "win32" || !(await shellIntegrationAvailable(reportedRepo))) {
    console.log("integration: SIGSTOP or shell integration unavailable in this host; override scenario skipped");
    return;
  }
  for (const terminal of ownTerminals()) {
    terminal.dispose();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  const runId = runIdOf(report, reportedRepo, "stage-reported-statistics-typed-parser");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await fs.writeFile(path.join(reportedRepo, ".sparring", "fake-runner.conf"), "sleep_for=1\nexit_with=0\n");
  await runStage();
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "a first run opens the project's terminal");
  await waitFor(runId, (liveness) => liveness.state === "stopped", 20_000, "and leaves it idle");
  const [owned] = ownTerminals();
  const pid = await owned.processId;
  assert.ok(owned && pid !== undefined);

  const warnings = captureWarnings();
  let stopped = false;
  try {
    process.kill(pid, "SIGSTOP");
    stopped = true;
    await runStage();
    assert.equal((await pendingSubmissions()).length, 1, "the submission is unresolved");

    // Dismissing the dialog is not an override: nothing changes.
    assert.equal((await pendingSubmissions()).length, 1, "a dismissed dialog settles nothing");

    // The offer is a confirmation, and its wording says what it costs.
    assert.ok(
      warnings.messages.some((message) => /If that command cannot run any more, confirm it/.test(message)),
      `the way out is stated as a confirmation, got ${JSON.stringify(warnings.messages)}`,
    );

    // The person confirms. This is an override, recorded as such — never as
    // evidence that the command did not run.
    // By the exact operation id, never by the key: the dialog was about one
    // record, and confirming it must not touch whatever holds that key now.
    const operationId = (await pendingSubmissions())[0].id;
    assert.equal(
      await vscode.commands.executeCommand("agentSparring._test.overrideSubmission", operationId, "the person checked the terminal and confirmed the command cannot still run"),
      true,
    );
    assert.equal(
      await vscode.commands.executeCommand("agentSparring._test.overrideSubmission", operationId, "the same stale dialog, confirmed twice"),
      false,
      "and a record that has already been resolved is reported as such rather than searched for again",
    );
    assert.deepEqual(await pendingSubmissions(), [], "after which the operation may be given again");
    assert.notEqual((await livenessOf(runId)).state, "running", "and nothing about a runner was claimed by any of it");
  } finally {
    if (stopped) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // already gone
      }
    }
    warnings.restore();
    for (const terminal of ownTerminals()) {
      terminal.dispose();
    }
  }
  console.log("integration: an unresolvable submission is cleared only by an explicit human override, recorded as an override and not as evidence");
}

/** A tracker over one terminal the pool would never hand out, with its own registry. */
function trackerOver(lease: TerminalLease, logged: string[]): { tracker: ExecutionTracker; registry: OperationRegistry; dispose: () => void } {
  const stored = memento();
  const context = { workspaceState: stored } as unknown as vscode.ExtensionContext;
  const registry = new OperationRegistry(context, (message: string) => logged.push(message));
  const tracker = new ExecutionTracker(context, (message) => logged.push(message), () => [], { acquire: () => lease } as unknown as TerminalPool, registry);
  return {
    tracker,
    registry,
    dispose: () => {
      tracker.dispose();
      registry.dispose();
    },
  };
}

/** A tracker over a given registry, for the reload and attribution scenarios. */
function trackerWith(registry: OperationRegistry, stored: vscode.Memento, logged: string[]): ExecutionTracker {
  const context = { workspaceState: stored } as unknown as vscode.ExtensionContext;
  const terminal = { name: "never used", dispose: () => undefined } as unknown as vscode.Terminal;
  const pool = { acquire: () => bypassLease(terminal).lease } as unknown as TerminalPool;
  return new ExecutionTracker(context, (message) => logged.push(message), () => [], pool, registry);
}

/** A lease over a terminal the pool would never hand out, for the bypass scenarios. */
function bypassLease(terminal: vscode.Terminal): { lease: TerminalLease; retired: () => boolean } {
  let retired = false;
  return {
    lease: { terminal, idle: () => true, release: () => undefined, discard: () => undefined, retire: () => { retired = true; } },
    retired: () => retired,
  };
}

/** The warnings the extension showed, with every dialog dismissed. */
/**
 * Run a real command and fail as an assertion if it tries to open a *modal*
 * dialog.
 *
 * VS Code's DialogService refuses modal dialogs in a test host: it throws
 * from inside the extension host, so the whole run dies with a stack trace
 * rather than with a statement about what went wrong. Worse, whether a
 * command reaches a modal can depend on state an earlier section left behind
 * — a run whose telemetry still claims an open turn makes `Run stage` ask for
 * an override — so the failure is intermittent, which is how it was first
 * seen (one run in four).
 *
 * This makes that case deterministic and legible rather than suppressing it.
 * Ordinary, non-modal messages go on to whatever is installed (the real
 * window, or `captureWarnings`), so every existing assertion about wording
 * still holds; a modal request is recorded and reported as the assertion it
 * ought to be, naming the command and the message. Production behaviour is
 * untouched: this wraps only the window API, only for the duration of one
 * command invocation, and only inside this suite.
 */
async function withoutModal<T>(what: string, body: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const names = ["showWarningMessage", "showInformationMessage", "showErrorMessage"];
  const originals = names.map((name) => [name, window[name]] as const);
  const modals: string[] = [];
  const isModal = (item: unknown): boolean => typeof item === "object" && item !== null && (item as { modal?: boolean }).modal === true;
  for (const [name, original] of originals) {
    window[name] = (message: string, ...rest: unknown[]) => {
      if (rest.some(isModal)) {
        modals.push(message);
        return Promise.resolve(undefined);
      }
      return (original as (...args: unknown[]) => unknown)(message, ...rest);
    };
  }
  let result: T;
  try {
    result = await body();
  } finally {
    for (const [name, original] of originals) {
      window[name] = original;
    }
  }
  assert.deepEqual(modals, [], `${what} must not need a modal confirmation here — the state this section set up should not require one. Got: ${JSON.stringify(modals)}`);
  return result;
}

/** `Run stage`, as a person presses it, asserted never to need a modal here. */
const runStage = (): Promise<unknown> => withoutModal("Run stage", () => vscode.commands.executeCommand("agentSparring.runStage"));

/**
 * Wait until every timestamp already in an activity log is in the past.
 *
 * The fixture's fake engine stamps its telemetry with the *end* of the second
 * it was launched in (`…:SS.999Z`, see runTests.ts), so a turn it wrote can
 * read as having begun up to a second after the launch actually happened.
 * That is the fixture's clock, not the product's, and a test that records a
 * runner as ended inside that second would leave the run's own open turn
 * looking newer than the end of the runner that wrote it — an honest but
 * quite different state ("a newer turn has since started; nothing has
 * observed that runner"), which then makes the next `Run stage` ask for an
 * override. So the ordering is settled here rather than raced on.
 */
async function waitPastLoggedTimestamps(activityFile: string): Promise<void> {
  const text = await fs.readFile(activityFile, "utf8").catch(() => "");
  const stamps = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return Date.parse((JSON.parse(line) as { ts?: string }).ts ?? "");
      } catch {
        return Number.NaN;
      }
    })
    .filter((ms) => Number.isFinite(ms));
  const newest = Math.max(0, ...stamps);
  const left = newest + 1 - Date.now();
  if (left > 0) {
    await new Promise((resolve) => setTimeout(resolve, left));
  }
}

function captureWarnings(): { messages: string[]; restore: () => void } {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window["showWarningMessage"];
  const messages: string[] = [];
  window["showWarningMessage"] = async (message: string) => {
    messages.push(message);
    return undefined;
  };
  return {
    messages,
    restore: () => {
      window["showWarningMessage"] = original;
    },
  };
}

async function pendingSubmissions(): Promise<{ id: string; runId?: string; key: string; state: string; waitExpired: boolean; subcommand: string }[]> {
  return (await vscode.commands.executeCommand("agentSparring._test.unresolvedSubmissions")) as { id: string; runId?: string; key: string; state: string; waitExpired: boolean; subcommand: string }[];
}

/** The one record holding a run's duplicate guard, whatever state it is in. */
async function guardFor(runId: string): Promise<{ id: string; state: string; observationLost?: boolean } | undefined> {
  return (await vscode.commands.executeCommand("agentSparring._test.guardFor", runId)) as { id: string; state: string; observationLost?: boolean } | undefined;
}

async function runningLaunches(runId: string): Promise<{ runId: string; state: string }[]> {
  const launches = (await vscode.commands.executeCommand("agentSparring._test.persistedLaunches")) as { runId: string; state: string }[];
  return launches.filter((launch) => launch.runId === runId && launch.state === "running");
}

/** Poll a synchronous answer until it is there (for the tracker built inside this suite). */
async function waitUntil<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

// ---------------------------------------------------------------- the terminal closed mid-run

/**
 * What the user actually did: closed `Agent Sparring — <project>` while the
 * runner inside it was working, and later reloaded the window.
 *
 * This section used to assert that closing the terminal killed the shell and
 * with it the runner, so the extension could record the execution as ended
 * there and then. Real testing in VS Code disproved the premise: a HUP- and
 * TERM-resistant engine process survives `terminal.dispose()` and goes on
 * working. Closing a terminal is therefore the end of what this window can
 * *watch*, and nothing more.
 *
 * So the contract asserted here is the conservative one:
 *
 *  - liveness becomes `unknown`, with the sentence that says why, and never
 *    `stopped` — which would be a claim nothing here can make, and would
 *    invite a second runner over a live one;
 *  - that unknown state is persisted, so a reload finds it rather than an
 *    unmatched `turn.started` and a silent dead end;
 *  - the duplicate guard for that run is untouched by any of it;
 *  - and the way out is the person's explicit statement, acting on the exact
 *    execution and the exact operation the panel was built from.
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
  await runStage();
  await waitFor(runId, (liveness) => liveness.state === "running", 15_000, "the runner starts");
  // Whether the fake runner's turn.started has reached the fold by now is a
  // property of this host's file watching, not of what is being tested here.
  // It only decides whether "interrupted" is meaningful below.
  const turnWasOpen = Boolean(await waitForMaybe(runId, (liveness) => liveness.turnActive, 10_000));

  const live = (await vscode.commands.executeCommand("agentSparring._test.persistedLaunches")) as { runId: string; state: string }[];
  assert.ok(
    live.some((launch) => launch.runId === runId && launch.state === "running"),
    "while it runs, a reload would find it recorded as running",
  );

  const [terminal] = ownTerminals();
  assert.ok(terminal, "the extension's terminal is open");
  const guardedBefore = await guardFor(runId);
  assert.equal(guardedBefore?.state, "running-shell", "while it runs, the duplicate guard is on the execution the shell reported");
  terminal.dispose();

  const lost = await waitFor(runId, (liveness) => liveness.state === "unknown", 15_000, "closing the terminal makes liveness unknown rather than stopped");
  assert.equal(lost.execution?.state, "unknown", "the execution is not claimed to have ended: nothing observed that");
  assert.match(lost.detail, /cannot determine whether the previous runner is still active/, "and the reason is said in the words a person can act on");
  assert.notEqual(lost.state, "stopped", "a closed terminal is not a dead process");
  // `interrupted` is a claim about a turn that ended; nothing ended here, so
  // an open turn stays open and is simply no longer being watched.
  if (turnWasOpen) {
    assert.equal(lost.interrupted, false, "an open turn is not presented as interrupted by a terminal going away");
  }

  const after = (await vscode.commands.executeCommand("agentSparring._test.persistedLaunches")) as { runId: string; state: string }[];
  assert.ok(
    after.some((launch) => launch.runId === runId && launch.state === "unknown"),
    `a reload must find this runner recorded as unknown, got ${JSON.stringify(after)}`,
  );
  assert.ok(
    !after.some((launch) => launch.runId === runId && launch.state === "ended"),
    "and must not find it recorded as ended, which nothing established",
  );
  const guardedAfter = await guardFor(runId);
  assert.equal(guardedAfter?.id, guardedBefore?.id, "the duplicate guard is the same record it was before the terminal closed");
  assert.equal(guardedAfter?.state, "running-shell", "in the same state: nothing about that process was established");
  assert.equal(guardedAfter?.observationLost, true, "with the record saying that what was lost is the observation");

  // The way out is the person's, and it acts on the ids the panel carries.
  const model = (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  assert.ok(model.unknownRunner, "the Overview offers the explicit recovery where the person is");
  // And the screen says the state and what it costs, before anything is
  // clicked: the run may still be active, so a second copy is refused.
  assert.equal(model.busyState?.label, "Run status unknown", "not Working, and not a failure");
  assert.equal(model.busyState?.state, "unknown");
  assert.match(model.busyState?.detail ?? "", /Run may still be active — starting another copy is blocked\./);
  assert.equal(model.runner, undefined, "no Stop is offered against a process that can no longer be identified");
  assert.equal(model.stageAction, undefined, "and nothing that would start a second copy");
  assert.equal(model.planAction, undefined);
  console.log(`integration: observation lost → "${model.busyState?.label}"; Stop withheld, a second copy withheld`);
  assert.equal(model.unknownRunner.executionId, lost.execution?.id, "naming the exact execution it was built from");

  // A stale pair — an execution id this run is not waiting on — must do
  // nothing at all, however tempting the run id is.
  const stale = (await vscode.commands.executeCommand("agentSparring._test.confirmRunnerInactive", "an-execution-that-is-not-this-one", model.unknownRunner.operationId)) as { confirmed: boolean; overrode: boolean };
  assert.equal(stale.confirmed, false, "a confirmation for another execution confirms nothing");
  assert.equal(stale.overrode, false, "and releases no guard");
  assert.equal((await guardFor(runId))?.id, guardedBefore?.id, "the guard is still the same untouched record");

  // The runner this section deliberately orphaned is still running and its
  // `turn.started` is stamped with the end of the second it launched in, so
  // the confirmation is made after that instant has passed. Otherwise the
  // run's own open turn reads as a *newer* runner's, and the next section's
  // `Run stage` asks for an override — which is honest, and was an
  // intermittent failure rather than a statement about anything.
  await waitPastLoggedTimestamps(path.join(reportedRepo, ".sparring", "stages", "stage-reported-statistics-typed-parser", "activity.jsonl"));
  const confirmed = (await vscode.commands.executeCommand("agentSparring._test.confirmRunnerInactive")) as { confirmed: boolean; overrode: boolean };
  assert.equal(confirmed.confirmed, true, "the person's own statement settles that execution");
  assert.equal(confirmed.overrode, true, "and releases the guard on that exact operation, as an override");
  assert.equal(await guardFor(runId), undefined, "after which another run may be started");
  const settled = await livenessOf(runId);
  assert.equal(settled.execution?.state, "ended", "recorded as ended, as their statement and not as an observation");
  assert.match(settled.execution?.detail ?? "", /You confirmed/, "and the record says whose statement it is");
  assert.equal(
    settled.turnActive,
    false,
    `the open turn is attributed to the runner the person confirmed rather than read as a newer one, so the next Run stage needs no second override; got ${JSON.stringify(settled)}`,
  );
  console.log("integration: closing the extension's terminal leaves liveness unknown and the guard intact, and the person's confirmation is the way out");
}

// ---------------------------------------------------------------- a previous stage's submission, and what "Can't test" means

const SCOPE_STAGE_2 = "stage-4-live-cloud-behaviour";
const SCOPE_CHECKS = [
  { id: "live-push-pull", instruction: "Push from desktop A and pull on desktop B; the row is byte-identical." },
  { id: "cas-retry", instruction: "Force a concurrent edit and confirm the CAS retry keeps the extension group intact." },
  { id: "cross-client", instruction: "Reconcile two signed-in clients and confirm no field is lost." },
  { id: "jsonb-read", instruction: "Read the row back through PostgREST and confirm the JSONB rendering." },
  { id: "pre-migration-reject", instruction: "Confirm a deployed pre-migration server rejects the enhanced write." },
];

/** A five-check gate for the second stage, in the engine's own shape. */
function fiveCheckSparring(): string {
  const gate = {
    category: "DEVICE_MANUAL_CHECK",
    title: "Live cloud behaviour has to be seen by a person",
    checks: SCOPE_CHECKS.map((check) => ({ id: check.id, instruction: check.instruction, pass_criteria: "It behaves as the plan describes.", source: null })),
  };
  return ["# Sparring: stage 4", "", "## Routing outcome", "", "- Action: `NEEDS_YOU`", "- Summary: Five manual checks are the acceptance blockers.", "- Needs-you reason: DEVICE/MANUAL CHECK -- live cloud behaviour.", "", "## NEEDS YOU", "", "<!-- human-gate:v1 -->", "", "```json", JSON.stringify(gate, null, 2), "```", ""].join("\n");
}

/**
 * The reported workflow, in a real window: a managed plan run whose Stage 3D
 * submission failed, which then advanced to Stage 4.
 *
 * Nothing here is simulated in the model. The evidence is recorded through
 * the host command the webview's own click reaches, the engine is the
 * fixture's fake launched through the integrated shell, its non-zero exit is
 * what produces the failure record, and the run advances by its plan-run
 * state file changing on disk exactly as the engine advances it. What is
 * asserted is what the person saw: the red banner belongs to the stage it
 * happened on, and Stage 4 renders clean.
 *
 * The second half is the other report: five checks a person could not run
 * are five verifications that could not be obtained, not five things blocking
 * the stage. Those five clicks are real DOM clicks on the shipped document in
 * a real webview, and each result reaches the host over VS Code's own
 * message channel.
 */
async function stageScopeAssertions(reportedRepo: string): Promise<void> {
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const sparring = path.join(reportedRepo, ".sparring");
  const planState = path.join(sparring, "plans", `${GATE_PLAN_KEY}.json`);
  const stateOf = (stageId: string, index: number): string =>
    JSON.stringify({ current_stage: stageId, current_stage_index: index, expected_branch: "feature/reported-statistics", plan: GATE_PLAN_LABEL, plan_digest: "0".repeat(64), source: "manifest", status: "paused" });

  await fs.mkdir(path.join(sparring, "plans"), { recursive: true });
  await fs.mkdir(path.join(sparring, "stages", GATE_STAGE), { recursive: true });
  await fs.mkdir(path.join(sparring, "stages", SCOPE_STAGE_2), { recursive: true });
  await fs.writeFile(path.join(sparring, "stages", GATE_STAGE, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl", sparring_session_id: "spar" }));
  await fs.writeFile(path.join(sparring, "stages", GATE_STAGE, "sparring.md"), gateSparring());
  await fs.writeFile(path.join(sparring, "stages", SCOPE_STAGE_2, "state.json"), JSON.stringify({ status: "working", base_sha: null, candidate_sha: null, implementation_session_id: "impl2", sparring_session_id: "spar2" }));
  await fs.writeFile(path.join(sparring, "stages", SCOPE_STAGE_2, "sparring.md"), fiveCheckSparring());
  await fs.mkdir(path.join(reportedRepo, "plans"), { recursive: true });
  await fs.writeFile(
    path.join(reportedRepo, "plans", "reported-statistics.md"),
    ["# Reported statistics", "", "## Stage 3D — Snapshot v2 and attachment/export/import transport", "", "The transport.", "", "## Stage 4 — Live cloud behaviour", "", "The cloud.", ""].join("\n"),
  );
  await fs.writeFile(planState, stateOf(GATE_STAGE, 0));
  await vscode.commands.executeCommand("agentSparring.refresh");
  const report = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;
  const runId = report.runs.find((run) => run.id.startsWith(`${reportedRepo}|`) && run.id.includes("plan:"))?.id;
  assert.ok(runId, "the managed plan run is discovered");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);

  const advanceTo = async (stageId: string, index: number): Promise<void> => {
    await fs.writeFile(planState, stateOf(stageId, index));
    await vscode.commands.executeCommand("agentSparring.refresh");
    await waitUntil(async () => ((await model()).stageId === stageId ? true : undefined), 15_000, `the Overview follows the run to ${stageId}`);
  };

  // ---- the stale banner, end to end -------------------------------------
  if (await shellIntegrationAvailable(reportedRepo)) {
    await vscode.commands.executeCommand("agentSparring._test.recordHumanCheck", GATE_CHECK_ID, "pass", "Ran the oldest supported build; the row kept its details.");
    await fs.writeFile(path.join(sparring, "fake-runner.conf"), "resume_exit=1\nresume_output='sparring: resume-plan refused: the recorded digest does not match'\n");
    const restore = stubDialogs("feature/reported-statistics", "Submit for review");
    try {
      await vscode.commands.executeCommand("agentSparring._test.overviewAction", "submitForReview");
      const failed = await waitUntil(async () => (await model()).actionRequired?.submissionFailure, 25_000, "the engine's non-zero exit is reported as a failed submission on the stage it happened on");
      assert.match(failed.preserved, /your check results and feedback were preserved/, "and it leads with what was preserved");
      const onStage1 = await model();
      assert.equal(onStage1.stageId, GATE_STAGE);
      assert.equal(onStage1.actionRequired?.required[0]?.record?.outcome, "pass", "with the result the person recorded still drafted");
    } finally {
      restore();
      await fs.writeFile(path.join(sparring, "fake-runner.conf"), "sleep_for=3\nexit_with=0\n");
    }

    // The run advances, exactly as the engine advances it. The failure
    // record is untouched in workspace state; what changes is which stage
    // the Overview is about.
    await advanceTo(SCOPE_STAGE_2, 1);
    const onStage2 = await model();
    assert.equal(onStage2.actionRequired?.submissionFailure, undefined, "Stage 3D's failure is not Stage 4's; this is the banner that stayed on screen");
    assert.equal(onStage2.actionRequired?.submitting, undefined, "nor does Stage 4 look like it is submitting");
    assert.deepEqual(
      onStage2.actionRequired?.required.map((item) => item.record?.outcome),
      SCOPE_CHECKS.map(() => undefined),
      "and none of Stage 3D's drafted results populate Stage 4's controls",
    );
    assert.equal(onStage2.actionRequired?.feedback.draft, undefined);

    // Nothing was destroyed to get there: going back to the stage it
    // happened on still has the record.
    await advanceTo(GATE_STAGE, 0);
    assert.ok((await model()).actionRequired?.submissionFailure, "the failure is still recorded against the stage it belongs to");
    await advanceTo(SCOPE_STAGE_2, 1);
  } else {
    console.log("integration: shell integration unavailable in this host; the stale-banner half of the stage-scope scenario is skipped");
    await advanceTo(SCOPE_STAGE_2, 1);
  }

  // ---- five Can't test, clicked in a real webview ------------------------
  const nonce = crypto.randomBytes(16).toString("base64");
  const panel = vscode.window.createWebviewPanel("agentSparring.stageScopeTest", "cant test", { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, localResourceRoots: [] });
  try {
    const before = await model();
    assert.equal(before.actionRequired?.progress, "0 / 5 verified · 5 remaining", "five checks nobody has answered are five remaining, not five of anything else");

    const clicked: Record<string, unknown>[] = [];
    const allFive = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only ${clicked.length} of 5 Can't test clicks arrived within 20s`)), 20_000);
      panel.webview.onDidReceiveMessage((message: Record<string, unknown>) => {
        if (message?.["type"] === "humanCheck") {
          clicked.push(message);
          if (clicked.length === SCOPE_CHECKS.length) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    const clicker = `<script nonce="${nonce}">document.querySelectorAll('button[data-outcome="blocked"]').forEach((button) => button.click());</script>`;
    panel.webview.html = overviewHtmlFor(before, nonce, panel.webview.cspSource).replace("</body>", `${clicker}</body>`);
    await allFive;

    assert.deepEqual(
      clicked.map((message) => message["outcome"]),
      SCOPE_CHECKS.map(() => "blocked"),
      "each click posted the engine's own value, which is what the reviewer parses",
    );
    for (const message of clicked) {
      assert.ok(isHumanCheckMessage(message), "and the host accepts every one of them");
      await vscode.commands.executeCommand("agentSparring._test.recordHumanCheck", message["key"], message["outcome"]);
    }

    const after = await model();
    const progress = after.actionRequired!.progress!;
    assert.equal(progress, "0 / 5 verified · 5 couldn't test", "the reported summary said '5 blocked', which reads as five things standing in the way of the stage");
    assert.doesNotMatch(progress, /blocked/i);
    assert.doesNotMatch(progress, /failed/i, "nobody observed a failure");
    assert.equal(after.actionRequired?.submit.enabled, true, "every check has an answer, so the evidence can go to the reviewer, who decides what unavailable evidence means");

    // A note typed for the stage a person is on survives an ordinary
    // refresh: scoping state to the stage must not cost the persistence
    // that made it worth storing.
    await vscode.commands.executeCommand("agentSparring._test.recordHumanCheck", SCOPE_CHECKS[0].id, "blocked", "The staging cluster is down; I cannot reach either desktop.");
    await vscode.commands.executeCommand("agentSparring.refresh");
    const refreshed = await model();
    assert.equal(refreshed.actionRequired?.required[0]?.record?.note, "The staging cluster is down; I cannot reach either desktop.", "the note is still there after a refresh of the same stage");
    assert.equal(refreshed.actionRequired?.progress, "0 / 5 verified · 5 couldn't test", "and it is still not a result anybody obtained");

    const html = overviewHtmlFor(after, nonce, panel.webview.cspSource);
    assert.ok(!/\b5 blocked\b/.test(html), "and the word appears as a count nowhere on the page");
    assert.match(html, new RegExp(`class="choice blocked on" data-check="${SCOPE_CHECKS[0].id}"`), "each Can't test reads back as chosen");
    assert.match(html, /button\.choice\.on\.blocked \{ background: var\(--vscode-descriptionForeground\)/, "styled as absence, not as the failure red or a warning");
    console.log("integration: a previous stage's submission failure does not follow the run forward, and five Can't test results are reported as five verifications nobody could obtain");
  } finally {
    panel.dispose();
  }
}

/**
 * The document the Overview renders for the model the host just built.
 *
 * `_test.overviewModel` returns the real `OverviewModel`; `ModelReport` is
 * only this suite's narrowed reading of it, so the cast is a view of the same
 * object and not a shape invented here.
 */
function overviewHtmlFor(model: ModelReport, nonce: string, cspSource: string): string {
  return renderOverviewHtml(model as unknown as Parameters<typeof renderOverviewHtml>[0], nonce, cspSource);
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

// ---------------------------------------------------------------- Settings: the project's own project.toml, created by the engine

/**
 * Settings is a door to a file, not a settings editor.
 *
 * What this proves end to end: the door points at the repository the
 * cockpit is actually in; a missing file offers creation rather than
 * silently doing nothing; the file that appears was written by the engine's
 * own `init-config` (it shows up in the engine call log, and the extension
 * has no template of its own to write); and the Agents line the Overview
 * then shows is the engine's answer about that same file.
 */
async function settingsAssertions(report: DiscoveryDiagnostic, reportedRepo: string): Promise<void> {
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const settings = async (create?: boolean) => (await vscode.commands.executeCommand("agentSparring._test.openSettings", create)) as SettingsOutcome;
  const callsLog = path.join(reportedRepo, ".sparring", "fake-calls.log");
  const configPath = path.join(reportedRepo, ".sparring", "project.toml");
  await fs.rm(configPath, { force: true });

  const runId = runIdOf(report, reportedRepo, "stage-review-complete");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);

  // Nothing there yet: creation is offered, and declining writes nothing.
  await fs.rm(callsLog, { force: true });
  const declined = await settings(false);
  assert.deepEqual([declined.offered, declined.opened, declined.created], [true, undefined, undefined]);
  assert.equal(await fs.readFile(callsLog, "utf8").catch(() => ""), "", "declining runs no engine command");
  assert.equal(await fs.access(configPath).then(() => true, () => false), false, "and creates no file");

  // Accepting runs the engine's init-config and opens what it wrote.
  const created = await settings(true);
  assert.deepEqual([created.offered, created.created, created.opened], [true, true, configPath], `creation outcome: ${JSON.stringify(created)}`);
  assert.deepEqual((await fs.readFile(callsLog, "utf8")).trim().split("\n"), ["init-config"], "exactly one engine command, and it is the engine's own template command");
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, configPath, "the file the engine wrote is the file on screen");

  const written = await fs.readFile(configPath, "utf8");
  assert.match(written, /\[agents\.stage\]/);
  assert.match(written, /\[agents\.sparring\]/);
  // The template states no model and no effort: a provider's internal
  // default must not arrive in the file as if someone had chosen it.
  assert.doesNotMatch(written, /^\s*model\s*=/m, "no model is invented");
  assert.doesNotMatch(written, /^\s*effort\s*=/m, "no effort is invented");

  // Opening again with the file present just opens it: no offer, no engine.
  await fs.rm(callsLog, { force: true });
  const reopened = await settings();
  assert.deepEqual([reopened.opened, reopened.offered, reopened.created], [configPath, undefined, undefined]);
  assert.equal(await fs.readFile(callsLog, "utf8").catch(() => ""), "", "opening an existing file runs nothing");

  // The Overview now reports the engine's answer about that same file.
  await vscode.commands.executeCommand("agentSparring.refresh");
  const shown = await model();
  assert.equal(shown.agentConfig?.settings.label, "Settings");
  assert.equal(shown.agentConfig?.configPath, configPath, "the configuration shown is this repository's");
  assert.equal(shown.agentConfig?.configExists, true);
  assert.deepEqual(
    shown.agentConfig?.lines.map((line) => [line.role, line.text]),
    [
      ["Stage agent", "Claude · provider default"],
      ["Sparrer", "Codex · provider default"],
    ],
    "an unset model reads as the provider's default, never as an invented name",
  );

  await fs.rm(configPath, { force: true });
  await vscode.commands.executeCommand("agentSparring.refresh");
  console.log("integration: Settings opened this repository's project.toml, offered creation when absent, created it with the engine's own init-config and displayed the engine's effective configuration");
}

function runIdOf(report: DiscoveryDiagnostic, repo: string, stage: string): string {
  const id = report.runs.find((run) => run.id.startsWith(`${repo}|`) && run.id.endsWith(`stage:${stage}`))?.id;
  assert.ok(id, `run id for ${stage}`);
  return id;
}

async function livenessOf(runId: string): Promise<LivenessReport> {
  return (await vscode.commands.executeCommand("agentSparring._test.liveness", runId)) as LivenessReport;
}

/** Like waitFor, but a timeout is an answer ("it never happened"), not a failure. */
async function waitForMaybe(runId: string, predicate: (liveness: LivenessReport) => boolean, timeoutMs: number): Promise<LivenessReport | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const liveness = await livenessOf(runId);
    if (predicate(liveness)) {
      return liveness;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
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

// ---------------------------------------------------------------- Run plan… candidates, in a real window

/**
 * What `Run plan…` may target, decided by the production code path in a real
 * extension host.
 *
 * Two things are checked that only a real window can show.
 *
 * **Repository discovery, not merely the Git API.** `launchRepositories()`
 * awaits `ActiveRepositoryTracker.ready()`, which used to resolve as soon as
 * `getAPI(1)` returned an object — a moment at which the Git extension is
 * still scanning and its `repositories` array is legitimately empty. The
 * candidates that exist *only* in that array are the repositories with no
 * `.sparring` yet, so the list was briefly missing exactly the first-run case.
 * After the wait, readiness must be settled: `initialized`, or `unavailable`
 * if this host has no Git extension at all. Never still going.
 *
 * **A `.sparring` outside a repository is not a target.** The fixture has the
 * reported shape: `sporely/` holds a legacy `.sparring` and is not a git
 * repository, and neither is `sporely/nested-repo/`, while
 * `sporely-py-reported-statistics/` is one. The engine refuses every
 * unattended turn outside a git work tree, so offering the first two would be
 * offering something that can only fail — and `sporely` is the container, so
 * it is the one containment picks.
 */
async function launchTargetAssertions(fixtureRoot: string, reportedRepo: string): Promise<void> {
  const candidates = (await vscode.commands.executeCommand("agentSparring._test.launchCandidates")) as {
    repoRoot: string;
    folderName: string;
    established: boolean;
    launchable: boolean;
    blocked?: string;
  }[];

  const report = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;
  assert.ok(report.gitReadiness, "the diagnostic reports how far repository discovery got, separately from whether the API is attached");
  assert.ok(
    report.gitReadiness === "initialized" || report.gitReadiness === "unavailable",
    `after awaiting readiness the Git extension must have settled, not still be ${report.gitReadiness}`,
  );

  const at = (dir: string) => candidates.find((candidate) => path.resolve(candidate.repoRoot) === path.resolve(dir));

  const reported = at(reportedRepo);
  assert.ok(reported, "the repository with .sparring and .git is a candidate");
  assert.equal(reported.launchable, true, "and it is somewhere a plan can be started");
  assert.equal(reported.established, true, "with Agent Sparring state already");

  const container = at(path.join(fixtureRoot, "sporely"));
  assert.ok(container, "the container is still discovered, so its history stays inspectable");
  assert.equal(container.launchable, false, "but it is not a git repository, so the engine cannot run a plan there");
  assert.match(container.blocked ?? "", /not inside a git repository/, "and the reason is said, not implied");

  const nested = at(path.join(fixtureRoot, "sporely", "nested-repo"));
  assert.ok(nested, "the nested project is discovered too");
  assert.equal(nested.launchable, false, "and is excluded for the same reason: a .sparring directory is not a repository");

  assert.ok(
    candidates.some((candidate) => candidate.launchable),
    "at least one real repository is offered, or the exclusions above would be vacuous",
  );
  console.log(`integration: Run plan… offers ${candidates.filter((c) => c.launchable).length} of ${candidates.length} candidates; git discovery ${report.gitReadiness}`);
}

// ---------------------------------------------------------------- declarations belong to one worktree

/**
 * A stage's declarations — its sibling repositories *and* its mode — belong to
 * the worktree they were made in, and the values VS Code stores are enough to
 * resolve that again from cold.
 *
 * ### What this cannot do, and why it is said here
 *
 * The obvious test is: declare, restart VS Code, read back. That is not
 * achievable in this harness, and the reason is worth recording so nobody
 * spends another afternoon on it. VS Code run under `--extensionTestsPath`
 * keeps its storage **in memory**: with a shared `--user-data-dir` across two
 * launches, the same workspace-storage directory is created
 * (`User/workspaceStorage/<hash>/`) and no `state.vscdb` is ever written to
 * it — not after a settling delay, and not after a graceful
 * `workbench.action.quit`. A second window therefore starts with an empty
 * store no matter what the first one did, so a "restart" assertion would be
 * testing the harness rather than the extension.
 *
 * So this proves the two halves that *are* ours, and claims nothing about
 * VS Code's own durability:
 *
 *  1. **What is stored is enough.** The exact values VS Code holds for the two
 *     declaration keys are taken out, sent back in as data, and used to build
 *     each worktree's manifest through the same readers and the same builder
 *     production uses — a cold read, with no access to the live state. If the
 *     stored shape were missing the worktree, or ambiguous between two of
 *     them, this is where it would show.
 *  2. **Nothing is cached in the process.** Every accessor reads the Memento
 *     on the call, so whatever VS Code restores is what the extension uses;
 *     there is no in-memory copy for a reload to diverge from. That is
 *     asserted against the source, below.
 *
 * B is a real second worktree of the same repository with the same plan
 * document at the same *repo-relative* path, so both produce the same plan key
 * — which is the whole reason the scope exists. It is deliberately not a
 * workspace folder: it is here to be the checkout a declaration made next door
 * must not reach.
 *
 * Why manifests and not just the stored values: both kinds of declaration go
 * into the execution manifest, and the engine folds the manifest's executable
 * content into the digest that identifies a recorded run, refusing to continue
 * when it moves. The question that matters is not "what does workspace state
 * say" but "what would each worktree now hand the engine".
 */

interface BuiltManifest {
  ok: boolean;
  planKey?: string;
  text?: string;
  digest?: string;
  reason?: string;
}

interface StageDeclarations {
  planKey: string;
  repositories: { name: string; branch: string }[];
  mode: string;
}

/** The values VS Code holds for the declaration keys: what it would restore, and all of it. */
interface StoredDeclarations {
  modes?: unknown;
  repositories?: unknown;
}

async function declarationScopeAssertions(reportedRepo: string, fixtureRoot: string): Promise<void> {
  const sibling = path.join(fixtureRoot, "sporely-py-ui-cleanup");
  const planA = path.join(reportedRepo, ...GATE_PLAN_LABEL.split("/"));
  const planB = path.join(sibling, ...GATE_PLAN_LABEL.split("/"));

  // The same plan document at the same repo-relative path in both worktrees.
  await fs.mkdir(path.dirname(planB), { recursive: true });
  await fs.copyFile(planA, planB);

  const declarations = async (projectDir: string): Promise<StageDeclarations> =>
    (await vscode.commands.executeCommand("agentSparring._test.stageDeclarations", projectDir, "3D")) as StageDeclarations;
  const live = async (projectDir: string, planPath: string): Promise<BuiltManifest> => built(await vscode.commands.executeCommand("agentSparring._test.manifestFor", projectDir, planPath), projectDir);
  const cold = async (stored: StoredDeclarations, projectDir: string, planPath: string): Promise<BuiltManifest> =>
    built(await vscode.commands.executeCommand("agentSparring._test.manifestFromStored", stored, projectDir, planPath), projectDir);
  const stored = async (): Promise<StoredDeclarations> => {
    // Through JSON on the way out and back, exactly as VS Code serialises it:
    // a scope key is an object key containing an absolute path, and that has
    // to survive the round trip intact or the cold read finds nothing.
    const raw = (await vscode.commands.executeCommand("agentSparring._test.storedDeclarations")) as StoredDeclarations;
    return JSON.parse(JSON.stringify(raw)) as StoredDeclarations;
  };

  // Select the managed plan run explicitly rather than depending on whatever
  // the previous section left on screen: a declaration is made against the
  // selected run's plan, so the section has to own that.
  const report = (await vscode.commands.executeCommand("agentSparring.diagnoseDiscovery")) as DiscoveryDiagnostic;
  const planRunId = report.runs.find((run) => run.id.endsWith(`plan:${GATE_PLAN_KEY}`))?.id;
  assert.ok(planRunId, `the managed plan run is discovered, got ${report.runs.map((run) => run.id.split("|").pop()).join(", ")}`);
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", planRunId), planRunId);

  const aUndeclared = await live(reportedRepo, planA);
  const bUndeclared = await live(sibling, planB);
  assert.ok(!aUndeclared.text?.includes('"mode"'), "nothing is declared yet in A");
  assert.ok(!aUndeclared.text?.includes("repositories"), "in either sense");
  assert.equal(aUndeclared.planKey, bUndeclared.planKey, "both worktrees produce the same plan key — which is why the scope is needed at all");

  // ---- declare both kinds in A
  const declared = (await vscode.commands.executeCommand("agentSparring._test.declareStageRepository", "3D", {
    name: "sporely-web",
    path: path.join(fixtureRoot, "sporely-web"),
    branch: "feature/reported-statistics-cloud-transport",
  })) as { name: string }[] | undefined;
  assert.ok(declared, "a plan is associated with the selected run, so a declaration can be made");
  assert.deepEqual(
    declared.map((repository) => repository.name),
    ["sporely-web"],
  );
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.declareStageMode", "3D", "independent_review"), "independent_review");

  const a = await live(reportedRepo, planA);
  const b = await live(sibling, planB);
  assert.match(a.text ?? "", /"mode": "independent_review"/, "A's manifest now runs Stage 3D as a review");
  assert.match(a.text ?? "", /"name": "sporely-web"/, "and declares the sibling it must also pin");
  assert.notEqual(a.digest, aUndeclared.digest, "so A executes something different, and its digest says so");
  assert.equal(b.text, bUndeclared.text, "B's manifest is byte-identical to the one it built before anything was declared");
  assert.equal(b.digest, bUndeclared.digest, "so B's recorded run would keep resuming");

  // ---- the cold read: only what VS Code stores, resolved again from scratch
  const persisted = await stored();
  assert.ok(persisted.repositories && persisted.modes, "both kinds reached workspace state");
  assert.ok(
    JSON.stringify(persisted.repositories).includes(`@${reportedRepo}`),
    `the stored key names the worktree it was declared in, got ${JSON.stringify(persisted.repositories)}`,
  );
  assert.ok(!JSON.stringify(persisted.modes).includes(`@${sibling}`), "and never the other one");

  const coldA = await cold(persisted, reportedRepo, planA);
  const coldB = await cold(persisted, sibling, planB);
  assert.equal(coldA.text, a.text, "read cold, A rebuilds byte-identically to what the live session builds");
  assert.equal(coldA.digest, a.digest, "so a restored window would resume A's run rather than be refused");
  assert.equal(coldB.text, bUndeclared.text, "and B still builds the manifest of a worktree that has declared nothing");
  assert.equal(coldB.digest, bUndeclared.digest, "its digest never moved, so a declaration next door could not have stopped it");
  assert.notEqual(coldA.digest, coldB.digest, "the two worktrees execute different things, which is the point");

  // Emptied state resolves to the undeclared manifests for both — the shape a
  // window with nothing stored sees, and proof the cold read is reading the
  // values handed to it rather than reaching the live ones.
  const empty = await cold({}, reportedRepo, planA);
  assert.equal(empty.digest, aUndeclared.digest, "with nothing stored, A declares nothing");

  const here = await declarations(reportedRepo);
  const there = await declarations(sibling);
  assert.equal(here.mode, "independent_review");
  assert.equal(there.mode, "implementation", "B's mode is still the engine's default");
  assert.deepEqual(there.repositories, [], "and it has no sibling declaration");
  assert.equal(there.planKey, here.planKey, "though it is the same plan, by the same key");

  // ---- nothing is cached in the process, so what VS Code restores is what is used
  const controllerSource = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
  for (const accessor of ["stageRepositories", "stageRepositoriesFor", "stageModes", "stageModeFor"]) {
    const body = /\n {2}[a-zA-Z]+\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/.exec(controllerSource.slice(controllerSource.indexOf(`  ${accessor}(`)))?.[1] ?? "";
    assert.ok(body, `${accessor} exists`);
    assert.match(body, /this\.context\.workspaceState\.get</, `${accessor} reads workspace state on the call, so a reload cannot diverge from an in-memory copy`);
  }

  console.log(
    `integration: ${path.basename(reportedRepo)} declares sporely-web and mode=independent_review for Stage 3D and builds digest ${String(a.digest).slice(0, 12)}…; read cold from the stored values alone it rebuilds the same, while sporely-py-ui-cleanup — same plan key ${here.planKey} — declares neither and still builds ${String(b.digest).slice(0, 12)}…`,
  );
}

/** A manifest a test command built, asserted to be one this plan can actually produce. */
function built(result: unknown, projectDir: string): BuiltManifest {
  const manifest = result as BuiltManifest | undefined;
  assert.ok(manifest, `a manifest could be built for ${path.basename(projectDir)}`);
  assert.equal(manifest.ok, true, `…and the plan is executable: ${String(manifest.reason)}`);
  return manifest;
}

// ---------------------------------------------------------------- the inline agent config selector

/**
 * Changing the model and the effort from the Overview, for real.
 *
 * What this proves end to end: the controls are built from what the engine
 * reported, not from anything the extension knows; a change runs the
 * engine's own `set-config` (it shows up in the engine call log, and the
 * file it wrote is on disk) rather than the extension writing TOML; the
 * value shown afterwards is re-read from the engine rather than assumed;
 * a change the engine refuses leaves the engine's value on screen and the
 * file untouched; and a change carrying a repository this window has moved
 * on from is refused instead of being applied to the one now on screen.
 */
async function agentConfigAssertions(report: DiscoveryDiagnostic, reportedRepo: string, fixtureRoot: string): Promise<void> {
  const model = async () => (await vscode.commands.executeCommand("agentSparring._test.overviewModel")) as ModelReport;
  const change = async (message: unknown) => (await vscode.commands.executeCommand("agentSparring._test.agentConfig", message)) as AgentConfigOutcome;
  const configPath = path.join(reportedRepo, ".sparring", "project.toml");
  const callsLog = path.join(reportedRepo, ".sparring", "fake-calls.log");
  const read = () => fs.readFile(configPath, "utf8").catch(() => "");
  const calls = async () => (await fs.readFile(callsLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

  await fs.rm(configPath, { force: true });
  const runId = runIdOf(report, reportedRepo, "stage-review-complete");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  // The panel has to be open: a control can only post a change after it has
  // been rendered, and what it was rendered with is what the host compares
  // an arriving change against.
  await vscode.commands.executeCommand("agentSparring.openOverview");
  await vscode.commands.executeCommand("agentSparring.refresh");

  // The controls exist, and everything in them came from the engine.
  const initial = await model();
  const scope = initial.agentConfig?.scope;
  assert.equal(scope, configPath, "the controls are scoped to this repository's config");
  assert.deepEqual(
    initial.agentConfig?.controls.map((control) => control.role),
    ["stage", "sparring"],
  );
  const stageControl = initial.agentConfig!.controls[0];
  const sparrerControl = initial.agentConfig!.controls[1];
  assert.equal(stageControl.provider.fixedText, "Claude", "one provider for the role, so it is shown and not chosen");
  assert.equal(stageControl.provider.options, undefined);
  assert.equal(stageControl.model.options, undefined, "a model is never a closed list: nothing enumerates them");
  assert.equal(stageControl.model.fixedText, PROVIDER_DEFAULT_LABEL, "and with none configured it is read, not offered");
  // The dropdown's entries are the engine's levels: the two providers'
  // vocabularies differ, and the difference arrives from the engine.
  assert.deepEqual(
    stageControl.effort?.options?.map((option) => option.value),
    ["", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    sparrerControl.effort?.options?.map((option) => option.value),
    ["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.equal(stageControl.effort?.options?.[0].label, "Provider default");

  // A model change goes through the engine, and the engine writes the file.
  // Driven here as a message rather than from a control: the cockpit shows
  // the model and does not edit it, but `set-config --model` is still the
  // engine's own mutation and the host still has to honour it correctly.
  await fs.rm(callsLog, { force: true });
  const set = await change({ type: "agentConfig", role: "stage", field: "model", value: "opus", scope });
  assert.deepEqual([set.applied, set.error], [true, undefined], `set model: ${JSON.stringify(set)}`);
  assert.deepEqual(await calls(), ["set-config stage"], "exactly one engine command, and it is the engine's own mutation");
  assert.match(await read(), /^model = "opus"$/m, "the engine wrote the file; the extension never touched it");
  assert.equal((await model()).agentConfig?.controls[0].model.value, "opus", "and the value shown is re-read from the engine");

  // The other role is independent, and is reported from the same re-read.
  await change({ type: "agentConfig", role: "sparring", field: "model", value: "gpt-5.6-terra", scope });
  const both = await model();
  assert.equal(both.agentConfig?.controls[0].model.value, "opus");
  assert.equal(both.agentConfig?.controls[1].model.value, "gpt-5.6-terra");

  // An effort from the dropdown, then the default option, which clears it.
  await change({ type: "agentConfig", role: "stage", field: "effort", value: "xhigh", scope });
  assert.equal((await model()).agentConfig?.controls[0].effort?.value, "xhigh");
  await change({ type: "agentConfig", role: "sparring", field: "effort", value: "ultra", scope });
  assert.equal((await model()).agentConfig?.controls[1].effort?.value, "ultra", "a level only Codex has");

  // Clearing is null on the wire and the engine's own --default flag; the
  // words "provider default" are never written as a value.
  await change({ type: "agentConfig", role: "sparring", field: "model", value: null, scope });
  const cleared = await model();
  assert.equal(cleared.agentConfig?.controls[1].model.value, "", "the control shows the default option");
  assert.doesNotMatch(await read(), /provider default/i, "no such model name is ever written");
  assert.match(cleared.agentConfig?.lines[1].text ?? "", /Codex · provider default/);

  // A level the engine refuses: nothing is written, and what stays on screen
  // is the engine's value rather than the one that was asked for.
  const before = await read();
  await fs.rm(callsLog, { force: true });
  const refused = await change({ type: "agentConfig", role: "stage", field: "effort", value: "ultra", scope });
  assert.equal(refused.applied, false);
  assert.match(refused.error ?? "", /not supported by provider 'claude-cli'/, "the engine's own diagnostic, not a translation");
  assert.equal(await read(), before, "a refused change writes nothing");
  assert.equal((await model()).agentConfig?.controls[0].effort?.value, "xhigh", "the engine's value, not the requested one");
  assert.deepEqual(await calls(), ["set-config stage"], "it was attempted through the engine, and the engine said no");

  // A change naming a repository this window is no longer looking at.
  const elsewhere = path.join(fixtureRoot, "sporely", "nested-repo", ".sparring", "project.toml");
  await fs.rm(elsewhere, { force: true });
  await fs.rm(callsLog, { force: true });
  const stale = await change({ type: "agentConfig", role: "stage", field: "model", value: "sonnet", scope: elsewhere });
  assert.equal(stale.applied, false);
  assert.match(stale.refused ?? "", /active repository changed/);
  assert.deepEqual(await calls(), [], "no engine command at all");
  assert.equal(await fs.access(elsewhere).then(() => true, () => false), false, "and nothing was written next door");
  assert.equal((await model()).agentConfig?.controls[0].model.value, "opus", "this repository is untouched");

  // Switching the selected run to another repository moves the scope with
  // it, which is what makes the check above bite.
  const nested = runIdOf(report, path.join(fixtureRoot, "sporely", "nested-repo"), "stage-nested-only");
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", nested), nested);
  await vscode.commands.executeCommand("agentSparring.refresh");
  const moved = await model();
  assert.notEqual(moved.agentConfig?.scope, scope, "the controls now belong to the other repository");
  // And the old scope is now the stale one, refused in that direction too.
  const backwards = await change({ type: "agentConfig", role: "stage", field: "model", value: "sonnet", scope: scope as string });
  assert.equal(backwards.applied, false);
  assert.match(backwards.refused ?? "", /active repository changed/);
  assert.equal((await read()).includes('model = "sonnet"'), false, "the repository that is no longer selected was not written to");

  // Back, and two changes in quick succession: both are applied, in order,
  // and neither is lost to the other's write.
  assert.equal(await vscode.commands.executeCommand("agentSparring._test.chooseRun", runId), runId);
  await vscode.commands.executeCommand("agentSparring.refresh");
  const rapid = (await model()).agentConfig?.scope as string;
  const [first, second] = await Promise.all([
    change({ type: "agentConfig", role: "stage", field: "model", value: "sonnet", scope: rapid }),
    change({ type: "agentConfig", role: "stage", field: "effort", value: "max", scope: rapid }),
  ]);
  assert.deepEqual([first.applied, second.applied], [true, true]);
  const settled = await model();
  assert.equal(settled.agentConfig?.controls[0].model.value, "sonnet", "neither write clobbered the other");
  assert.equal(settled.agentConfig?.controls[0].effort?.value, "max");

  // A message that is not a well-formed change never reaches the engine.
  await fs.rm(callsLog, { force: true });
  for (const bad of [
    { type: "agentConfig", role: "reviewer", field: "model", value: "x", scope: rapid },
    { type: "agentConfig", role: "stage", field: "repo.root", value: "/elsewhere", scope: rapid },
    { type: "agentConfig", role: "stage", field: "model", value: "x" },
  ]) {
    const outcome = await change(bad);
    assert.equal(outcome.applied, false, `refused: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await calls(), [], "a malformed message runs no engine command");

  await fs.rm(configPath, { force: true });
  await vscode.commands.executeCommand("agentSparring.refresh");
  console.log("integration: the Agents controls were built from the engine's own levels, every change ran set-config and was re-read from show-config, a refused level kept the engine's value, and a change carrying another repository was never applied");
}
