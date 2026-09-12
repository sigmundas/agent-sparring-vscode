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
  ];
  const only = (process.env.AGENT_SPARRING_IT_ONLY ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  for (const [name, section] of sections) {
    if (only.length === 0 || only.includes(name)) {
      await section();
    }
  }
  console.log(only.length > 0 ? `integration: sections ${only.join(", ")} verified` : "integration: discovery, stale telemetry, launched runner exit, Ctrl-C, observed terminal command, bare executable via the shell, command-not-found, Accept stage and plan association all verified");
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

// ---------------------------------------------------------------- bare `sparring` resolved by the shell, not the extension host

interface ModelReport {
  stageStatus?: string;
  stageLine?: string;
  runKind?: string;
  stageAction?: { kind: string; label: string; primary: boolean };
  secondaryAction?: { kind: string; label: string };
  banner?: { kind: string; text: string };
  actions?: { plan: boolean; choosePlan: boolean; changePlan: boolean; matchStage: boolean };
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
