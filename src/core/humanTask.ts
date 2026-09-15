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
 * The same module also owns how a check is *named*, for the places where the
 * alternative is a collective phrase ("both rollout switches") when the
 * reviewer's own concrete names are sitting right there.
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

/** `DEVICE_MANUAL_CHECK` → `Device manual check`; the engine's own category, just made readable. */
export function categoryWord(category: string | undefined): string {
  if (!category) {
    return "Human gate";
  }
  const words = category.toLowerCase().replace(/_/g, " ").trim();
  return words ? capitalize(words) : "Human gate";
}

/**
 * How a check is referred to *by name*.
 *
 * A gate check has a name the reviewer chose and the engine keeps stable
 * across turns — its id — and that is the thing to say when the alternative
 * is a vague collective ("both rollout switches", "all 2 remaining checks").
 * A derived check has no such name, only its position, so it gets one;
 * inventing a name for it would be inventing data.
 *
 * `description` is the short human sentence that goes with the name: the
 * instruction's first sentence, so the name is never shown bare.
 */
export interface CheckName {
  /** The reviewer's stable id when there is one; `Check 2` otherwise. */
  name: string;
  /** True when `name` is the reviewer's own id rather than a position. */
  named: boolean;
  description: string;
}

/**
 * Only `gateId` counts as a name: a gate check whose id the panel could not
 * round-trip is keyed by a hash of its instruction, and presenting that hash
 * as "the reviewer's id" would be stating something the gate does not say.
 */
export function checkName(check: { text: string; gateId?: string }, position: number): CheckName {
  const named = Boolean(check.gateId);
  return { name: check.gateId ?? `Check ${position}`, named, description: sentences(check.text)[0] ?? check.text };
}

/**
 * The names of several checks, for a sentence that would otherwise say "all
 * N of them": `a, b and c`. Undefined when the checks carry no reviewer-given
 * names, or when there are too many for a sentence to stay readable — then the
 * count really is the honest short form.
 */
export const NAMES_IN_A_SENTENCE_MAX = 4;

export function checkNameList(checks: { text: string; gateId?: string }[]): string | undefined {
  const names = checks.map((check, index) => checkName(check, index + 1)).filter((entry) => entry.named);
  if (names.length === 0 || names.length !== checks.length || names.length > NAMES_IN_A_SENTENCE_MAX) {
    return undefined;
  }
  const words = names.map((entry) => entry.name);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
