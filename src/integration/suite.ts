/**
 * Runs inside the extension host (see runTests.ts). Uses the real
 * `vscode.workspace.workspaceFolders`, the real activation path and the
 * production `agentSparring.diagnoseDiscovery` command, whose return value
 * is the structured report the Output Channel is rendered from.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { DiscoveryDiagnostic } from "../core/diagnose";

const STAGES = ["stage-reported-statistics-contract", "stage-reported-statistics-local-schema-barrier", "stage-reported-statistics-typed-parser"];

export async function run(): Promise<void> {
  const fixtureRoot = process.env.AGENT_SPARRING_FIXTURE;
  assert.ok(fixtureRoot, "AGENT_SPARRING_FIXTURE must point at the generated workspace");

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

  // folder 1: the reported repository, probed directly
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
    ],
  );
  assert.equal(location.runIds.length, 3, "the second workspace folder produces recorded runs");

  // folder 0: legacy .sparring without stages, plus the nested project below it
  const sporely = report.folders[0];
  assert.equal(sporely.sparringExists, true);
  assert.equal(sporely.locations.length, 2);
  assert.equal(sporely.locations[0].nested, false);
  assert.equal(sporely.locations[0].runIds.length, 0);
  assert.equal(sporely.locations[1].nested, true);
  assert.equal(sporely.locations[1].projectDir, path.join(sporely.fsPath, "nested-repo"));
  assert.equal(sporely.locations[1].runIds.length, 1);

  // Select Repository / Run contents
  assert.equal(report.runs.length, 4);
  for (const stage of STAGES) {
    assert.ok(
      report.pickLabels.some((label) => label.includes(`sporely-py-reported-statistics: ${stage}`)),
      `Select Repository / Run lists ${stage}`,
    );
  }
  assert.ok(report.pickLabels.some((label) => label.includes("nested-repo: stage-nested-only")));
  // Two open stages in two repositories: ambiguous, never guessed, and the report says so.
  assert.equal(report.ambiguousIds.length, 2);
  assert.equal(report.selectedId, undefined);
  assert.match(report.noSelectionReason ?? "", /2 runs look active/);

  console.log(`integration: ${report.runs.length} runs discovered across ${report.folders.length} folders; pick list has ${report.pickLabels.length} items`);
}
