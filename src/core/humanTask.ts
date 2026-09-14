/**
 * Presenting one structured gate check as a task a person can act on.
 *
 * The reviewer writes a check for precision: one `instruction` that names
 * the build, the account, the data shape and the steps in a single
 * paragraph, and one `pass_criteria` that states both what passing looks
 * like and what failing looks like. Correct, and unreadable as a wall of
 * text when all a human wants to know is *what do I do* and *what counts as
 * a pass*.
 *
 * So the same words are laid out differently: the instruction becomes its
 * own sentences, in order, as steps; the pass criteria is split at the
 * reviewer's own "Fail if …" boundary so the primary line says what passing
 * means and the failure wording stays available underneath. Nothing is
 * paraphrased, summarised or dropped — every word of the reviewer's text is
 * still on the page, either in the task or in the technical details — because
 * a shortened instruction is a different test, and no summariser here can
 * know which clause is the one that matters.
 *
 * Deterministic and pure: no model call, no vscode API.
 */

/** A gate check as the primary layer shows it. */
export interface HumanTask {
  /** The instruction's sentences, in order. A one-sentence instruction is one step. */
  steps: string[];
  /** What passing means, with the reviewer's own "Pass if" lead-in removed. */
  passIf?: string;
  /** The reviewer's failure wording, when it was stated as its own sentence; demoted, never dropped. */
  failIf?: string;
}

/** Sentence ends, minus the ones that are not: `e.g.`, `schema_version 2.` mid-clause, file names. */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z(`"'])/;
/** The reviewer's own lead-in to what a pass looks like. */
const PASS_LEAD_RE = /^pass(?:es)?\s+(?:if|when)\b[:,]?\s*/i;
/** A sentence that starts stating what a failure looks like. */
const FAIL_LEAD_RE = /^fail(?:s|ure)?\s+(?:if|when)\b/i;

export function humanTask(check: { text: string; passCriteria?: string }): HumanTask {
  return { steps: sentences(check.text), ...splitPassCriteria(check.passCriteria) };
}

/**
 * The sentences of a paragraph, whitespace-collapsed. Text that cannot be
 * split stays one step, so a caller always has something to show.
 */
export function sentences(text: string | undefined): string[] {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) {
    return [];
  }
  return flat
    .split(SENTENCE_SPLIT_RE)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Pass criteria split at the reviewer's "Fail if …" sentence. The pass half
 * loses its "Pass if" lead-in (the label says it) and keeps a capital; the
 * fail half is returned whole, for the details layer. Criteria written as one
 * sentence with no lead-in are the pass half unchanged.
 */
export function splitPassCriteria(criteria: string | undefined): { passIf?: string; failIf?: string } {
  const parts = sentences(criteria);
  if (parts.length === 0) {
    return {};
  }
  const at = parts.findIndex((sentence) => FAIL_LEAD_RE.test(sentence));
  const passPart = (at < 0 ? parts : parts.slice(0, at)).join(" ");
  const failPart = at < 0 ? undefined : parts.slice(at).join(" ");
  const passIf = capitalize(passPart.replace(PASS_LEAD_RE, "").trim());
  return { passIf: passIf || undefined, failIf: failPart };
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
