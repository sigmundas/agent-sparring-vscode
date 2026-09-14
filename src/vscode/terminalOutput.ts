/**
 * Reading what a shell execution printed, shared by the short-command runner
 * (which needs the engine's refusal text) and the runner launcher (which
 * needs it to report an engine failure honestly instead of guessing from an
 * exit code).
 */

import type * as vscode from "vscode";

/** How much of one execution's output is kept in memory. */
export const OUTPUT_CAP = 64 * 1024;

/** Everything the execution printed, ANSI stripped, capped; empty when the shell exposes no stream. */
export async function collectOutput(execution: vscode.TerminalShellExecution, cap = OUTPUT_CAP): Promise<string> {
  let text = "";
  try {
    for await (const chunk of execution.read()) {
      if (text.length < cap) {
        text += chunk;
      }
    }
  } catch {
    // Reading is best effort: some shells report no data stream.
  }
  return stripAnsi(text);
}

/** Remove terminal control sequences (CSI and OSC, the latter used by shell integration itself) from captured output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\r/g, "");
}

/**
 * The last `count` non-empty lines, for a notification that must show what
 * actually happened without becoming a wall of text. The whole output goes
 * to the Output Channel regardless.
 */
export function outputTail(text: string, count = 3): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  return lines.slice(-count).join(" · ");
}
