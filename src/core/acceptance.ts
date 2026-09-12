/**
 * "Accept stage" as one user-visible action over the engine's two-step
 * acceptance gate:
 *
 *   1. `sparring freeze-candidate STAGE …`  pins the exact pushed HEAD as the
 *      stage's candidate (state.json: status FROZEN, candidate_sha);
 *   2. `sparring accept-candidate STAGE …`  accepts exactly that candidate
 *      (status ACCEPTED), refusing as stale if HEAD moved in between.
 *
 * The second command is never issued when the first fails. Engine refusals
 * (cli.py prints `could not freeze candidate: …` / `could not accept
 * candidate: …` to stderr and exits 1) are translated into what the user
 * can do about them; the raw output is kept for the log.
 *
 * Re-freezing is allowed by the engine, so "try again" after a failed
 * second step simply runs both steps again.
 *
 * No dependency on the vscode API.
 */

import { buildAcceptCandidateArgs, buildFreezeCandidateArgs, isCommandNotFoundExit, type LoopInvocation } from "./cli";

/** What one CLI invocation produced. `exitCode` undefined: the shell reported no code (signal, closed terminal). */
export interface CommandOutcome {
  exitCode: number | undefined;
  /** Combined stdout/stderr as captured (may be empty when the terminal could not be read). */
  output: string;
}

export type AcceptStep = "freeze" | "accept";

export type AcceptStageResult =
  | { ok: true; candidateSha?: string; steps: AcceptStep[] }
  | {
      ok: false;
      step: AcceptStep;
      /** Human wording of the refusal, never the raw lifecycle vocabulary. */
      message: string;
      /** The engine's own output, for the Output Channel. */
      detail: string;
      /** Whether pressing Accept stage again is a sensible next step. */
      retryable: boolean;
      /** The shell could not find the executable. */
      commandNotFound?: boolean;
    };

export type CommandRunner = (args: string[]) => Promise<CommandOutcome>;

/**
 * Run freeze, then (only on success) accept. `run` executes one `sparring`
 * invocation with the given argument array and reports its outcome.
 */
export async function acceptStage(run: CommandRunner, invocation: LoopInvocation, platform: NodeJS.Platform = process.platform): Promise<AcceptStageResult> {
  const frozen = await run(buildFreezeCandidateArgs(invocation));
  if (frozen.exitCode !== 0) {
    return failure("freeze", frozen, platform);
  }
  const accepted = await run(buildAcceptCandidateArgs(invocation));
  if (accepted.exitCode !== 0) {
    return failure("accept", accepted, platform);
  }
  return { ok: true, candidateSha: acceptedSha(accepted.output) ?? frozenSha(frozen.output), steps: ["freeze", "accept"] };
}

function failure(step: AcceptStep, outcome: CommandOutcome, platform: NodeJS.Platform): AcceptStageResult {
  const explained = explainAcceptanceFailure(step, outcome, platform);
  return { ok: false, step, message: explained.message, detail: outcome.output.trim(), retryable: explained.retryable, commandNotFound: explained.commandNotFound };
}

export interface AcceptanceExplanation {
  message: string;
  retryable: boolean;
  commandNotFound?: boolean;
}

/**
 * Translate an engine refusal (acceptance.py messages, via cli.py's
 * `could not … candidate:` prefix) into the action the user can take.
 * Unknown refusals keep the engine's first line so nothing is hidden.
 */
export function explainAcceptanceFailure(step: AcceptStep, outcome: CommandOutcome, platform: NodeJS.Platform = process.platform): AcceptanceExplanation {
  const text = outcome.output;
  if (isCommandNotFoundExit(outcome.exitCode, platform)) {
    return { message: "The sparring CLI could not be found by your shell. Set agentSparring.executable to its full path.", retryable: false, commandNotFound: true };
  }
  if (outcome.exitCode === undefined) {
    return { message: "The acceptance command did not finish (it was interrupted or its terminal closed). Nothing was accepted.", retryable: true };
  }
  if (/refusing acceptance as stale|is now at [0-9a-f]{7,40}/i.test(text)) {
    return { message: "The code changed after the independent review. Run the review again before accepting this stage.", retryable: false };
  }
  if (/already ACCEPTED/i.test(text)) {
    return { message: "This stage is already accepted.", retryable: false };
  }
  if (/working tree holds changes that commit does not represent/i.test(text)) {
    return { message: "The repository has uncommitted changes. Commit or discard them, then try Accept stage again.", retryable: true };
  }
  if (/not available on the intended remote branch/i.test(text)) {
    return { message: "The current commit has not been pushed to the branch yet. Push it, then try Accept stage again.", retryable: true };
  }
  if (/expected branch .* but .* is on/i.test(text)) {
    return { message: "The repository is checked out on a different branch than this stage expects. Check out the stage's branch, then try again.", retryable: true };
  }
  if (/does not exist at/i.test(text)) {
    return { message: "The stage directory no longer exists, so nothing can be accepted.", retryable: false };
  }
  if (/lock/i.test(text) && /held|contended|another/i.test(text)) {
    return { message: "Another sparring process is working in this repository. Wait for it to finish, then try Accept stage again.", retryable: true };
  }
  if (/must be frozen before it can be accepted|not a full commit id/i.test(text)) {
    return { message: "Stage could not be finalized. Try Accept stage again.", retryable: true };
  }
  const first = firstEngineLine(text);
  if (step === "accept") {
    return { message: `Stage could not be finalized${first ? `: ${first}` : "."}`, retryable: true };
  }
  return { message: `The stage could not be accepted${first ? `: ${first}` : "."}`, retryable: true };
}

/** The engine's own explanation with cli.py's `could not …:` prefix removed; the first non-empty line otherwise. */
export function firstEngineLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const refusal = lines.find((line) => /^could not (freeze|accept) candidate:/i.test(line));
  if (refusal) {
    return refusal.replace(/^could not (freeze|accept) candidate:\s*/i, "");
  }
  return lines.find((line) => !/^fake sparring:/.test(line));
}

function acceptedSha(output: string): string | undefined {
  return /accepted candidate:\s*([0-9a-f]{7,40})/i.exec(output)?.[1];
}

function frozenSha(output: string): string | undefined {
  return /frozen candidate:\s*([0-9a-f]{7,40})/i.exec(output)?.[1];
}
