/**
 * Starting the next standalone stage from an associated plan, with the
 * engine's own lifecycle and nothing else:
 *
 *   sparring new-stage <id> --brief-file <tmp>   creates the stage skeleton with the
 *                                                plan section as brief.md (stage.py: Stage.create)
 *   sparring run-loop <id> …                     runs it (already offered as Run stage)
 *
 * The brief is the plan's own section for that stage, extracted here
 * deterministically (heading and body verbatim, up to the next heading of
 * the same or a higher level) under the same two-line header run-plan
 * gives a planned stage (plan.py: render_brief). Nothing is paraphrased;
 * a sparse section stays sparse. The extension writes that Markdown to a
 * temporary file outside .sparring and hands the path to the engine, which
 * owns the stage directory, state.json and brief.md.
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

// ---------------------------------------------------------------- the brief: the plan section, verbatim

const HEADING_RE = /^(#{1,6})\s+\S/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * The Markdown section that starts with the heading at `line` (1-based):
 * that heading line and everything up to, not including, the next heading
 * of the same or a higher level outside fenced code (plan.py's
 * _section_end, generalised to the heading's own level). Trailing blank
 * lines are dropped and one newline appended, as the engine does; nothing
 * inside is altered. Undefined when `line` is not a heading.
 */
export function extractPlanSection(markdown: string, line: number): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = line - 1;
  if (start < 0 || start >= lines.length) {
    return undefined;
  }
  const heading = HEADING_RE.exec(lines[start]);
  if (!heading) {
    return undefined;
  }
  const level = heading[1].length;
  let end = lines.length;
  let inFence = false;
  for (let index = start + 1; index < lines.length; index++) {
    const text = lines[index];
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const other = HEADING_RE.exec(text);
    if (other && other[1].length <= level) {
      end = index;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n").replace(/\s+$/, "")}\n`;
}

export type BriefRendering = { ok: true; brief: string; section: string } | { ok: false; message: string };

/**
 * The initial brief.md for the proposed stage: the plan section under the
 * two-line header run-plan writes (plan.py: render_brief), with the stage
 * label in place of a position (`Stage 3C from plan …`), so the brief also
 * names its own stage for later matching (brief.ts). The section is the
 * plan's text, not a summary of it; a heading-only section is refused
 * because there would be nothing to implement from.
 */
export function renderNextStageBrief(markdown: string, proposal: NextStageProposal, planName: string): BriefRendering {
  const section = extractPlanSection(markdown, proposal.line);
  if (section === undefined) {
    return { ok: false, message: `The plan no longer has a heading at line ${proposal.line}; it may have changed since it was read.` };
  }
  const body = section.split("\n").slice(1).join("\n").trim();
  if (!body) {
    return { ok: false, message: `The section ${proposal.display} has a heading but no content to brief the stage with.` };
  }
  const brief = `# Stage brief: ${proposal.stageId}\n\nStage ${proposal.label} from plan \`${planName}\`. Implement only this section; the other stages are separate.\n\n${section}`;
  return { ok: true, brief, section };
}

// ---------------------------------------------------------------- running the engine

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
  if (/could not read --brief-file/i.test(text)) {
    return { message: "The engine could not read the brief it was given; no stage was created." };
  }
  if (/unrecognized arguments:.*--brief-file/i.test(text)) {
    return { message: "This sparring CLI is older than the extension expects: its new-stage has no --brief-file option. Update the engine (agent-sparring 7b6b2d8 or later)." };
  }
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^could not create stage:/i.test(line))
    ?.replace(/^could not create stage:\s*/i, "");
  return { message: `The stage could not be created${first ? `: ${first}` : "."}` };
}
