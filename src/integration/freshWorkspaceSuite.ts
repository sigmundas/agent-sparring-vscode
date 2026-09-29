/**
 * Runs inside the extension host (see runFreshWorkspace.ts), in a window
 * whose only folder is an empty git repository with no `.sparring` anywhere.
 *
 * None of the `workspaceContains` activation events can match there, so this
 * proves the path a brand-new user takes: invoking a contributed command
 * activates the extension. VS Code (>= 1.74) derives that activation from
 * `contributes.commands`, so no explicit `onCommand` events are declared.
 */

import assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  assert.equal(folders.length, 1, "the window is the single fresh repository");

  const extension = vscode.extensions.getExtension("sintef.agent-sparring-vscode");
  assert.ok(extension, "extension is installed in the test host");
  assert.equal(extension.isActive, false, "nothing in a fresh repository activates the extension by itself");

  await vscode.commands.executeCommand("agentSparring.showLog");
  assert.equal(extension.isActive, true, "invoking a contributed command activates the extension");

  const commands = await vscode.commands.getCommands(true);
  for (const id of ["agentSparring.runPlan", "agentSparring.openSettings"]) {
    assert.ok(commands.includes(id), `${id} is registered once the extension is active`);
  }
  console.log("fresh workspace: command activation ok");
}
