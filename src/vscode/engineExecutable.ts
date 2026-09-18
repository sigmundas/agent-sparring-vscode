/**
 * The one reader of `agentSparring.executable`.
 *
 * Every caller that launches or questions the engine needs the same value,
 * and two readers of the same setting is one more than there should be.
 */

import * as vscode from "vscode";

/** The configured path, or the empty string when the user set none. */
export function configuredExecutable(): string {
  return vscode.workspace.getConfiguration("agentSparring").get<string>("executable", "");
}
