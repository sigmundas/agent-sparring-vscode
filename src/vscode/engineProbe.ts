/**
 * One question about the installed engine: does its `run-plan` take
 * `--manifest`?
 *
 * Automatic continuation is worth nothing against an engine that predates
 * the manifest input — the run would fail on an unknown flag after the
 * confirmation, in a terminal, having done nothing. Asking `--help` once
 * turns that into a sentence before anything starts.
 *
 * It is a *probe*, not an authority: it only ever answers "supported" or
 * "could not tell", never "unsupported for sure" on the strength of a
 * failed spawn. When the CLI is a bare name that only the user's own shell
 * can resolve, there is nothing here to run and the answer is "could not
 * tell" — the extension then says nothing rather than guessing, and the
 * engine's own refusal remains the authority.
 */

import { execFile } from "node:child_process";
import { planExecutable } from "../core/cli";
import { hostEnv } from "./shellIntegration";

export type EngineSupport = "supported" | "missing-manifest" | "unknown";

const cache = new Map<string, EngineSupport>();

/**
 * Whether `sparring run-plan --manifest` exists. Cached per resolved
 * executable path for the window's lifetime: the answer is a property of the
 * installed engine, and re-probing on every click would put a process spawn
 * behind a button.
 */
export async function manifestSupport(configured: string | undefined, cwd: string): Promise<EngineSupport> {
  const planned = await planExecutable(configured, hostEnv(cwd), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return "unknown";
  }
  const file = planned.plan.path;
  const known = cache.get(file);
  if (known !== undefined) {
    return known;
  }
  const answer = await probe(file, cwd);
  // A "could not tell" is not cached: a transient failure must not silence
  // the check for the rest of the window.
  if (answer !== "unknown") {
    cache.set(file, answer);
  }
  return answer;
}

function probe(file: string, cwd: string): Promise<EngineSupport> {
  return new Promise((resolve) => {
    execFile(file, ["run-plan", "--help"], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      if (!output.trim()) {
        resolve("unknown"); // it did not run, or said nothing: no claim either way
        return;
      }
      if (output.includes("--manifest")) {
        resolve("supported");
        return;
      }
      // It printed a usage message for run-plan and that usage has no
      // --manifest: that is an answer, whatever the exit code was.
      resolve(/usage|run-plan/i.test(output) && !error ? "missing-manifest" : "unknown");
    });
  });
}

/** Testing seam: forget what was probed. */
export function resetManifestSupportCache(): void {
  cache.clear();
}
