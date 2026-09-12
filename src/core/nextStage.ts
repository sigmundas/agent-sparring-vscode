/**
 * Starting the next standalone stage from an associated plan, with the
 * engine's own lifecycle and nothing else:
 *
 *   sparring new-stage <id>     creates the stage skeleton (stage.py: Stage.create)
 *   edit brief.md               the user's step, as documented by the engine
 *   sparring run-loop <id> …    runs it (already offered as Run stage)
 *
 * The engine has no operation that writes a standalone stage's brief from
 * a plan section (plan.py's render_brief is internal to run-plan), so the
 * extension proposes the id, confirms, runs new-stage, and then opens the
 * fresh brief.md beside the plan section for the user to fill in. It
 * never writes anything under .sparring itself.
 *
 * No dependency on the vscode API.
 */

import { buildNewStageArgs, isCommandNotFoundExit, type NewStageInvocation } from "./cli";
import { slugify } from "./engineFormats";
import type { CommandOutcome } from "./acceptance";
import type { StageEntry } from "./planAssociation";

/** stage.py: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. */
export const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface NextStageProposal {
  /** `stage-3c-cloud-schema-and-synchronization`: the label keeps later automatic matching unambiguous. */
  stageId: string;
  label: string;
  title: string;
  /** `Stage 3C — Cloud schema and synchronization`. */
  display: string;
  /** 1-based line of the canonical section in the plan. */
  line: number;
}

/**
 * The stage id to create for a plan stage, or undefined when the plan does
 * not define that stage clearly (no canonical section, or several). The
 * id follows the `stage-<slug>` convention of standalone stages, prefixed
 * with the label so that `stage-3c-…` later matches `Stage 3C` on its own.
 */
export function proposeNextStage(next: StageEntry): NextStageProposal | undefined {
  if (!next.canonical || next.ambiguous || !next.title) {
    return undefined;
  }
  const label = next.label.toLowerCase();
  const slug = slugify(next.title);
  const stageId = `stage-${label}${slug ? `-${slug}` : ""}`.slice(0, 128).replace(/-+$/, "");
  if (!STAGE_ID_RE.test(stageId)) {
    return undefined;
  }
  return { stageId, label: next.label, title: next.title, display: next.display, line: next.canonical.line };
}

export type NewStageResult = { ok: true; stageId: string } | { ok: false; message: string; detail: string; commandNotFound?: boolean; alreadyExists?: boolean };

export type CommandRunner = (args: string[]) => Promise<CommandOutcome>;

/** Run `sparring new-stage` once and translate its outcome. */
export async function createStage(run: CommandRunner, invocation: NewStageInvocation, platform: NodeJS.Platform = process.platform): Promise<NewStageResult> {
  const outcome = await run(buildNewStageArgs(invocation));
  if (outcome.exitCode === 0) {
    return { ok: true, stageId: invocation.stageId };
  }
  return { ok: false, ...explainNewStageFailure(outcome, platform), detail: outcome.output.trim() };
}

/** cli.py prints `could not create stage: …` and exits 1; stage.py's messages are translated here. */
export function explainNewStageFailure(outcome: CommandOutcome, platform: NodeJS.Platform = process.platform): { message: string; commandNotFound?: boolean; alreadyExists?: boolean } {
  const text = outcome.output;
  if (isCommandNotFoundExit(outcome.exitCode, platform)) {
    return { message: "The sparring CLI could not be found by your shell. Set agentSparring.executable to its full path.", commandNotFound: true };
  }
  if (outcome.exitCode === undefined) {
    return { message: "The new-stage command did not finish (it was interrupted or its terminal closed). No stage was created." };
  }
  if (/already exists/i.test(text)) {
    return { message: "A stage with this id already exists.", alreadyExists: true };
  }
  if (/invalid stage id/i.test(text)) {
    return { message: "The engine refused the proposed stage id." };
  }
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^could not create stage:/i.test(line))
    ?.replace(/^could not create stage:\s*/i, "");
  return { message: `The stage could not be created${first ? `: ${first}` : "."}` };
}
