/**
 * Manual verification for a stage the reviewer handed back to the human
 * (NEEDS_YOU / ESCALATE).
 *
 * **The gate decides.** When the recorded sparring result carries a
 * structured `human_gate` (engine `human_gate.py`; parsed by
 * engineFormats.ts), its `checks` are *exactly* the Pass / Fail / Blocked
 * controls this panel shows — one per check, in the reviewer's order,
 * with its instruction, its pass criteria and its plan reference. Nothing
 * is added from the plan, and nothing is mined from prose.
 *
 * That rule exists because mining could not tell what actually blocks a
 * stage. A reviewer who says, in one paragraph, that a pre-activation
 * desktop must be tested, that production deployment stays with the release
 * owner, and that the rollout gates remain closed, is naming one check and
 * two things that happen after acceptance. Sentence-splitting produced
 * three, and asked a human to "pass" two of them.
 *
 * Everything below the gate is the **legacy path**, used only for results
 * recorded before the engine emitted structured gates:
 *
 *  - **plan checks** come from the matched plan stage section. When the
 *    section has an explicit `### Manual verification` sub-heading with
 *    task-list items (`- [ ] …`), each item is one check, verbatim. Without
 *    one, the list items that name the human (`Human-gated …`, `Manual: …`)
 *    are kept verbatim as *parent requirements*: prose is never split into
 *    a checklist it does not spell out. The plan file is never modified
 *    (stage sections are digest-guarded by the engine);
 *  - **reviewer requested checks** are the request clauses of the latest
 *    sparring result (`## Deferred`, else the needs-you reason), split only
 *    at sentence and semicolon boundaries and always labelled as the
 *    reviewer's, never shown as plan text.
 *
 * Both paths then share:
 *
 *  - **recorded evidence** is the `## Human evidence` section of notes.md
 *    (the engine's own place for a human's check results; stage.py:
 *    HUMAN_EVIDENCE_HEADING). A gate check counts as recorded when an entry
 *    names its id; otherwise when an entry names its text exactly (the lines
 *    Submit for review writes) or overlaps it clearly without saying the
 *    check is still pending. Recorded checks leave "Still required";
 *  - the outcomes the user is recording now (Pass / Fail / Blocked plus a
 *    note) are drafts in VS Code workspace state until submitted, when they
 *    are rendered as prose under `## Human evidence` and the reviewer is
 *    asked to rule again. Nothing here marks anything READY or accepted.
 *
 * Beside all of that, and independent of it, there is **freeform feedback**:
 * what the human found that is not a result for any requested check — a
 * crash on the way to the feature, a wording or design problem, a reason the
 * checks cannot be performed yet. It has its own draft, its own
 * `### Additional human feedback` sub-heading under `## Human evidence`, and
 * it never becomes an outcome or moves `N / M verified`.
 *
 * No dependency on the vscode API.
 */

import type { HumanGate, SparringOutcome } from "./engineFormats";
import { extractPlanSection } from "./nextStage";

// ---------------------------------------------------------------- plan checks

export interface ManualCheck {
  /** Stable identity: a hash of the normalised text, so a draft survives the plan being edited above it. */
  key: string;
  /** The list item's text exactly as the plan has it (continuation lines joined with single spaces). */
  text: string;
  /** 1-based line of the list item in the plan document. */
  line: number;
  /** The `###` heading the item sits under, when there is one. */
  heading?: string;
}

export interface PlanChecks {
  /** Task-list items under `### Manual verification`: one check each, 1:1 with the plan. */
  explicit: ManualCheck[];
  /** Human-worded list items elsewhere in the section: parent requirements, kept as prose. */
  parents: ManualCheck[];
}

/** Wording that says a human, not the agents, performs the check. */
const HUMAN_RE = /\b(human|humans|human-gated|manual|manually|by hand|branch owner|operator|device|interactive|interactively)\b/i;
/** Sub-headings whose list items are verification steps rather than scope. */
const VERIFICATION_HEADING_RE = /\b(verif\w*|check\w*|test\w*|acceptance|validation|gate\w*|evidence)\b/i;
/** The explicit checklist heading; only its task-list items are precise checks. */
const MANUAL_VERIFICATION_HEADING_RE = /^manual verification\b/i;
const HEADING_RE = /^(#{1,6})\s+(\S.*?)\s*$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(\S.*)$/;
const TASK_RE = /^\[( |x|X)\]\s+(\S.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * The plan's manual checks for the stage whose section heading is at
 * `sectionLine` (1-based). Explicit: every task-list item under a `###
 * Manual verification` heading of the section (its `[ ]`/`[x]` mark is
 * ignored: completion is recorded in notes.md, never in the plan).
 * Parents: human-worded list items of the verification-flavoured
 * sub-sections (else of the whole section), excluding that checklist.
 * Nested items fold into their parent item; fenced code is skipped.
 */
export function planChecks(markdown: string, sectionLine: number): PlanChecks {
  const section = extractPlanSection(markdown, sectionLine);
  if (!section) {
    return { explicit: [], parents: [] };
  }
  const items = listItems(section, sectionLine);
  const explicit = items.filter((item) => item.heading !== undefined && MANUAL_VERIFICATION_HEADING_RE.test(item.heading) && item.task).map(toCheck);
  const rest = items.filter((item) => !(item.heading !== undefined && MANUAL_VERIFICATION_HEADING_RE.test(item.heading)));
  const underVerification = rest.filter((item) => item.heading !== undefined && VERIFICATION_HEADING_RE.test(item.heading));
  const pool = underVerification.length > 0 ? underVerification : rest;
  return { explicit, parents: pool.filter((item) => HUMAN_RE.test(item.text)).map(toCheck) };
}

/** @deprecated kept for callers that only want the human-worded items; prefer planChecks. */
export function extractManualChecks(markdown: string, sectionLine: number): ManualCheck[] {
  const { explicit, parents } = planChecks(markdown, sectionLine);
  return explicit.length > 0 ? explicit : parents;
}

interface ListItem {
  text: string;
  line: number;
  heading?: string;
  /** The item was written as a task (`- [ ] …`). */
  task: boolean;
}

function toCheck(item: ListItem): ManualCheck {
  return { key: checkKey(item.text), text: item.text, line: item.line, heading: item.heading };
}

function listItems(section: string, sectionLine: number): ListItem[] {
  const lines = section.split("\n");
  const out: ListItem[] = [];
  let heading: string | undefined;
  let current: { parts: string[]; line: number; heading?: string; indent: number; task: boolean } | undefined;
  let inFence = false;
  const flush = () => {
    if (current) {
      out.push({ text: current.parts.join(" ").replace(/\s+/g, " ").trim(), line: current.line, heading: current.heading, task: current.task });
      current = undefined;
    }
  };
  // Line 0 of the section is the stage heading itself.
  for (let index = 1; index < lines.length; index++) {
    const text = lines[index];
    if (FENCE_RE.test(text)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) {
      continue;
    }
    const head = HEADING_RE.exec(text);
    if (head) {
      flush();
      heading = head[2];
      continue;
    }
    const bullet = BULLET_RE.exec(text);
    if (bullet) {
      const indent = bullet[1].length;
      if (current && indent > current.indent) {
        current.parts.push(bullet[2].replace(TASK_RE, "$2")); // nested item: part of its parent check
        continue;
      }
      flush();
      const task = TASK_RE.exec(bullet[2]);
      current = { parts: [task ? task[2] : bullet[2]], line: sectionLine + index, heading, indent, task: Boolean(task) };
      continue;
    }
    if (!text.trim()) {
      flush();
      continue;
    }
    if (current && /^\s+\S/.test(text)) {
      current.parts.push(text.trim()); // continuation line of a wrapped item
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/**
 * The engine's own limit on a gate check id (human_gate.py: _MAX_ID_LENGTH).
 * A draft key is never longer, because a gate check's key *is* that id.
 */
export const CHECK_KEY_MAX_LENGTH = 128;

/**
 * Is this a draft key this extension could have written into a control?
 *
 * Two shapes reach the same place, and forgetting the second one is what
 * made every structured gate's Pass / Fail / Can't test button inert: a
 * check derived from plan or reviewer prose is keyed by {@link checkKey}, a
 * short hex hash, but a **gate check is keyed by the reviewer's own stable
 * id** (`pre-activation-desktop-v2-feed`) — that is the entire point of the
 * id, since it is what makes a recorded result survive the reviewer
 * rewording the check. A host-side guard that only knew the hash shape
 * silently dropped every message the gate panel sent.
 *
 * So this is the one definition of the shape, used by the renderer (which
 * must never emit a control the host would refuse) and by the host's own
 * check on messages arriving from the webview. The engine accepts any
 * non-empty text up to 128 characters; refused here are only the characters
 * that would break a surface the key crosses — control characters, and the
 * backtick that delimits the id inside the `## Human evidence` line.
 */
export function isCheckKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CHECK_KEY_MAX_LENGTH && !UNUSABLE_IN_KEY.test(value);
}

/** A backtick delimits the id inside a `## Human evidence` line; control characters belong in no key at all. */
// eslint-disable-next-line no-control-regex -- refusing control characters is precisely the point
const UNUSABLE_IN_KEY = /[\u0060\u0000-\u001f\u007f]/;

/**
 * The separator between a gate instance and a check key in a draft key.
 * Two characters the engine allows in neither half, so the halves can never
 * be confused for one another.
 */
export const DRAFT_KEY_SEPARATOR = "::";

/** A gate instance (the engine caps these at 128), the separator, and a check key. */
export const DRAFT_KEY_MAX_LENGTH = 128 + DRAFT_KEY_SEPARATOR.length + CHECK_KEY_MAX_LENGTH;

/**
 * Is this a key a check's controls could have been rendered with?
 *
 * Separate from {@link isCheckKey}, and longer, because a draft key is a
 * *composite*: a gate check's draft is stored under its asking as well as
 * its id (see `CheckItem.draftKey`). Reusing the 128-character check-key
 * limit here would refuse the composite for any reviewer id over 94
 * characters — and a refused message is a button that does nothing, which is
 * the exact failure {@link isCheckKey}'s own note describes.
 *
 * The one definition of the shape, used by the renderer, which must never
 * emit a control the host would drop, and by the host's guard on messages
 * arriving from the webview.
 */
export function isDraftKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= DRAFT_KEY_MAX_LENGTH && !UNUSABLE_IN_KEY.test(value);
}

/** djb2 over the whitespace-normalised, case-folded text; short hex. */
export function checkKey(text: string): string {
  const normalised = normalise(text);
  let hash = 5381;
  for (let index = 0; index < normalised.length; index++) {
    hash = ((hash << 5) + hash + normalised.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------- reviewer requested checks

/** A clause reads as something the reviewer asks to be done, not as a remark. */
const REQUEST_RE = /\b(verify|verified|verification|exercise|check|checks|confirm|deploy|deployed|apply|applied|test|tested|run|ensure|validate|observe|prove|reproduce|record|inspect|measure|push|pull|review|compare|pending|remain|remains|required)\b/i;
/** A clause that hands work to another stage or declares it out of scope is not a check for this stage. */
const DEFERRAL_RE = /\b(deferred to|separate stage|remains? stage|remain stage|out of scope|later stage|next stage|stage \d+[a-z]?\b(?![^.;]*\b(server|client|schema|write|row|migration)\b))/i;
/** Lead-ins that introduce a list of checks and are not themselves a check. */
const LEAD_IN_RE = /^(?:[A-Z][A-Z -]*--\s*|human-gated checks? (?:remain|remaining)(?: pending)?:\s*|remaining(?: checks?)?:\s*|still (?:pending|required|needed)(?:, not claimed)?:\s*|deferred:\s*)/i;

/**
 * The reviewer's requested checks, from the latest sparring result: list
 * items when the reviewer wrote a list; otherwise the request-like clauses
 * of its prose, split at sentence ends and semicolons only (commas are not
 * boundaries: "push, pull, CAS retry" stays one clause). `## Deferred` is
 * used when present, else the needs-you reason. Clauses that defer work to
 * another stage are dropped; a leading "Human-gated checks remain:" or an
 * `EXTERNAL CONDITION --` category is trimmed. The wording stays the
 * reviewer's; callers label it so.
 */
export function reviewerChecks(outcome: SparringOutcome | undefined): string[] {
  const source = outcome?.deferred?.trim() || outcome?.needsYouReason?.trim();
  if (!source) {
    return [];
  }
  const lines = source.split(/\r?\n/);
  const bullets = lines.map((line) => BULLET_RE.exec(line)?.[2]?.trim()).filter((text): text is string => Boolean(text));
  const candidates = bullets.length > 0 ? bullets : clauses(source);
  const out: string[] = [];
  for (const raw of candidates) {
    const text = raw.replace(LEAD_IN_RE, "").replace(/^(?:and|then|also)\s+/i, "").trim().replace(/[.;]+$/, "");
    if (!text || DEFERRAL_RE.test(text) || !REQUEST_RE.test(text)) {
      continue;
    }
    const finished = text.charAt(0).toUpperCase() + text.slice(1);
    if (!out.some((existing) => normalise(existing) === normalise(finished))) {
      out.push(finished);
    }
  }
  return out;
}

/** Sentences, then their semicolon-separated clauses; abbreviations like `e.g.` and file names like `x.sql` do not end a sentence. */
function clauses(prose: string): string[] {
  const flat = prose.replace(/\s+/g, " ").trim();
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z(`"'])/);
  const out: string[] = [];
  for (const sentence of sentences) {
    for (const clause of sentence.split(/;\s*/)) {
      const trimmed = clause.trim();
      if (trimmed) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- word overlap

const STOPWORDS = new Set(["that", "this", "with", "from", "into", "under", "over", "after", "before", "against", "their", "there", "these", "those", "which", "where", "when", "then", "than", "also", "only", "both", "either", "remain", "remains", "required", "still", "pending", "verify", "check", "checks", "behaviour", "behavior", "stage", "plan", "human", "gated", "human-gated", "claim", "without", "evidence", "condition", "external", "should", "must", "have", "been", "were", "will", "does", "not", "the", "and", "for", "its"]);

/** Significant tokens of a sentence for overlap matching: words of 3+ letters that are not filler. */
export function significantTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const token = raw.replace(/^-+|-+$/g, "");
    if (token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token)) {
      tokens.add(token);
      for (const part of token.split("-")) {
        if (part.length >= 3 && !STOPWORDS.has(part)) {
          tokens.add(part);
        }
      }
    }
  }
  return tokens;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of b) {
    if (a.has(token)) {
      count++;
    }
  }
  return count;
}

/** Shared significant tokens needed before a reviewer sentence counts as the same check as a plan item. */
export const REVIEWER_MATCH_MIN_OVERLAP = 2;

/**
 * The check a sentence most plausibly is: the one sharing the most
 * significant words with it, when that is at least `min` and unique.
 * Undefined otherwise: no guess.
 */
export function matchReviewerRequest(checks: { text: string }[], request: string, min = REVIEWER_MATCH_MIN_OVERLAP): number | undefined {
  const wanted = significantTokens(request);
  let best = -1;
  let bestScore = 0;
  let tie = false;
  checks.forEach((check, index) => {
    const score = overlap(significantTokens(check.text), wanted);
    if (score > bestScore) {
      best = index;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  });
  return best >= 0 && bestScore >= min && !tie ? best : undefined;
}

// ---------------------------------------------------------------- recorded outcomes (drafts)

/**
 * The three things a person can say about a requested check, and the three
 * only.
 *
 *  - `pass` — they performed the check and it met its criteria;
 *  - `fail` — they performed the check and it did not;
 *  - `blocked` — they could not perform it, so there is **no result**.
 *
 * `blocked` is the engine's own value, written into notes.md as `Blocked`
 * and parsed back by {@link parseHumanEvidence}, so it is what goes on the
 * wire and nothing here translates it. What it *means* is the third case
 * above, and this UI says so: "Can't test" on the button, "couldn't test" in
 * the summary. It is neither a pass nor a failure, and counting it as either
 * would tell the reviewer — and the person reading the panel — something
 * nobody established. A check with no recorded outcome at all is a fourth,
 * separate thing: still outstanding, and counted as remaining.
 */
export type CheckOutcome = "pass" | "fail" | "blocked";

export const CHECK_OUTCOMES: readonly CheckOutcome[] = ["pass", "fail", "blocked"];

/** The words written into notes.md. The engine's vocabulary, not the panel's. */
export const OUTCOME_WORDS: Record<CheckOutcome, string> = { pass: "Pass", fail: "Fail", blocked: "Blocked" };

export interface CheckRecord {
  outcome?: CheckOutcome;
  /** Free-text evidence or note; optional. */
  note?: string;
}

/**
 * workspaceState entry: stage scope key → check key → record. Drafts until
 * submitted.
 *
 * Scoped to the *stage* the results were entered for, not just the run: a
 * managed plan run keeps one id across all its stages, so run-keyed drafts
 * reappeared under the next stage's checks. See core/stageScope.ts.
 */
export type HumanCheckDrafts = Record<string, Record<string, CheckRecord>>;

export const HUMAN_CHECKS_KEY = "agentSparring.humanChecks";

export function humanChecksFor(drafts: HumanCheckDrafts | undefined, scope: string): Record<string, CheckRecord> {
  const value = drafts?.[scope];
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: Record<string, CheckRecord> = {};
  for (const [key, record] of Object.entries(value)) {
    if (record && typeof record === "object") {
      const outcome = (CHECK_OUTCOMES as readonly string[]).includes(String(record.outcome)) ? (record.outcome as CheckOutcome) : undefined;
      const note = typeof record.note === "string" && record.note.trim() ? record.note : undefined;
      if (outcome || note) {
        out[key] = { outcome, note };
      }
    }
  }
  return out;
}

/**
 * Record one check's outcome and/or note, merging with what is already
 * drafted for it; an empty record removes the draft.
 *
 * **`undefined` means "not part of this change", never "clear it".** The two
 * controls of a check report separately — a Pass / Fail / Can't test click
 * carries an outcome and no note, a keystroke in the note field carries a
 * note and no outcome — and the caller fills the absent half in as
 * `undefined`. Spreading that over the stored record used to overwrite the
 * other control's work: typing a note under a Can't test silently reset it to
 * no outcome, and clicking an outcome silently discarded the note someone had
 * just written as their evidence. Neither was visible when it happened,
 * because a note is stored without re-rendering the page.
 *
 * A note is therefore withdrawn by recording an empty one (which is what
 * emptying the textarea sends), and an outcome is replaced by recording
 * another; nothing here clears a field by omission.
 */
export function withHumanCheck(drafts: HumanCheckDrafts | undefined, scope: string, key: string, change: CheckRecord): HumanCheckDrafts {
  const next: HumanCheckDrafts = { ...(drafts ?? {}) };
  const forRun = { ...humanChecksFor(drafts, scope) };
  const merged: CheckRecord = { ...forRun[key] };
  if (change.outcome !== undefined) {
    merged.outcome = change.outcome;
  }
  if (change.note !== undefined) {
    merged.note = change.note;
  }
  if (merged.note !== undefined && !merged.note.trim()) {
    delete merged.note;
  }
  if (merged.outcome || merged.note) {
    forRun[key] = merged;
  } else {
    delete forRun[key];
  }
  if (Object.keys(forRun).length > 0) {
    next[scope] = forRun;
  } else {
    delete next[scope];
  }
  return next;
}

export function withoutHumanChecks(drafts: HumanCheckDrafts | undefined, scope: string): HumanCheckDrafts {
  const next: HumanCheckDrafts = { ...(drafts ?? {}) };
  delete next[scope];
  return next;
}

// ---------------------------------------------------------------- freeform human feedback (drafts)

/**
 * What a person found that is *not* one of the reviewer's checks.
 *
 * The structured controls force every observation into one of the checks the
 * reviewer predefined, and a real verification session does not stay inside
 * that list: a stage-4 check can be interrupted by a reproducible crash on
 * the way to the feature, by a table that still says "Typical min/max" when
 * the parser knows the values are P5/P95, or by a design decision the human
 * wants revisited before spending time on the five requested checks. None of
 * those is a Pass, a Fail or a Can't test of anything the reviewer asked for.
 *
 * So freeform feedback is a separate channel, stored separately, rendered
 * separately and recorded separately — never a fourth outcome word, never a
 * check, and it never moves `N / M verified`. It is evidence *for the
 * reviewer's routing decision*: the reviewer reads it against the unchanged
 * candidate and decides whether it means SEND_BACK, the same checks again,
 * revised checks, or (only if its own acceptance rules already allow it)
 * READY. It is not an instruction to the implementing agent.
 *
 * One draft per stage of a run, because it is one text box and it belongs to
 * the stage it was written about; it lives in workspace state
 * beside the check drafts so it survives a rerender, a details disclosure and
 * a window reload, and it is cleared only by a submission that actually
 * launched.
 */
export type HumanFeedbackDrafts = Record<string, string>;

export const HUMAN_FEEDBACK_KEY = "agentSparring.humanFeedback";

/** The unsubmitted feedback for one stage scope; undefined when there is none (whitespace is none). */
export function humanFeedbackFor(drafts: HumanFeedbackDrafts | undefined, scope: string): string | undefined {
  const value = drafts?.[scope];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Store the text as typed (trailing spaces and blank lines included); empty text removes the draft. */
export function withHumanFeedback(drafts: HumanFeedbackDrafts | undefined, scope: string, text: string): HumanFeedbackDrafts {
  const next: HumanFeedbackDrafts = { ...(drafts ?? {}) };
  if (text.trim()) {
    next[scope] = text;
  } else {
    delete next[scope];
  }
  return next;
}

export function withoutHumanFeedback(drafts: HumanFeedbackDrafts | undefined, scope: string): HumanFeedbackDrafts {
  const next: HumanFeedbackDrafts = { ...(drafts ?? {}) };
  delete next[scope];
  return next;
}

// ---------------------------------------------------------------- recorded evidence (notes.md ## Human evidence)

export const HUMAN_EVIDENCE_HEADING = "## Human evidence";

/**
 * The sub-heading freeform feedback is recorded under, inside
 * `## Human evidence`. It is a `###` so the engine's own section keeps its
 * one heading, and so that everything under it can be told apart from a
 * check result by structure rather than by reading the prose.
 */
export const HUMAN_FEEDBACK_HEADING = "### Additional human feedback";

const FEEDBACK_HEADING_RE = /^additional human feedback\b/i;
const SUB_HEADING_RE = /^#{3,6}\s+(\S.*?)\s*$/;

/** One entry of `## Human evidence`: a list item (with continuation lines) or a paragraph. */
export interface EvidenceEntry {
  text: string;
  /** Set for the structured lines Submit for review writes (`- Pass — <check>`). */
  outcome?: CheckOutcome;
  /** The check text of such a line, origin and id suffixes removed. */
  checkText?: string;
  /** The gate check's stable id, when the line names one (`· check `pre-activation-desktop``). */
  checkId?: string;
  /**
   * Which asking of the gate this line answered (`· gate `5b22…``), when it
   * names one. Absent on every line written before results were attributed
   * to a gate instance, and on a line whose gate had no instance to name.
   */
  gateInstanceId?: string;
  /** The entry says something is still pending / not claimed; it is not evidence of completion. */
  negative: boolean;
  /**
   * The entry sits under `### Additional human feedback`: it is freeform
   * feedback a human sent, so it is never evidence *for a check* — not even
   * when its words happen to overlap one. That is the whole point of
   * recording it under its own sub-heading.
   */
  feedback: boolean;
}

/** Wording by which a human entry says a check is *not* done; such an entry never counts as completion evidence. */
const NEGATIVE_RE = /\b(still pending|not claimed|not yet|cannot|can no longer|could not|unverified|not (?:done|verified|observed|run|tested|checked|exercised)|remains? (?:pending|open|outstanding|unverified)|outstanding:)\b/i;
/**
 * A result line this panel wrote: the outcome, the check's own wording, and
 * optional markers. `· check \`<id>\`` carries the gate check's stable id,
 * which is what makes a recorded result survive the reviewer rewording the
 * same check on a later turn; `· gate \`<id>\`` carries the gate instance
 * the result answered, which is what keeps it from answering a *later*
 * asking of the same check.
 *
 * Both suffixes are optional and the gate one is last, so every line written
 * before gate instances existed still parses exactly as it did.
 */
const STRUCTURED_RE = /^(Pass|Fail|Blocked)\s+—\s+(.+?)(?:\s+·\s+check\s+`([^`]+)`)?(?:\s+·\s+reviewer request)?(?:\s+·\s+gate\s+`([^`]+)`)?$/;

/** The `## Human evidence` section of notes.md as entries; empty when absent. */
export function parseHumanEvidence(notes: string | undefined): EvidenceEntry[] {
  if (!notes) {
    return [];
  }
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === HUMAN_EVIDENCE_HEADING);
  if (start < 0) {
    return [];
  }
  const entries: EvidenceEntry[] = [];
  let current: string[] = [];
  let currentIsBullet = false;
  let inFeedback = false;
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    // A structured result line is its bullet's first line; the indented note beneath does not change what it names.
    const structured = currentIsBullet && current.length > 0 ? STRUCTURED_RE.exec(current[0].trim()) : null;
    const feedback = inFeedback;
    current = [];
    if (!text) {
      return;
    }
    entries.push({
      text,
      outcome: structured ? (structured[1].toLowerCase() as CheckOutcome) : undefined,
      checkText: structured ? structured[2] : undefined,
      checkId: structured ? structured[3] : undefined,
      gateInstanceId: structured ? structured[4] : undefined,
      negative: NEGATIVE_RE.test(text),
      feedback,
    });
  };
  let inFence = false;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      break;
    }
    const sub = SUB_HEADING_RE.exec(line);
    if (sub) {
      // A sub-heading is a boundary, not content: it ends the entry above it
      // and decides whether what follows is feedback or a check result.
      flush();
      inFeedback = FEEDBACK_HEADING_RE.test(sub[1]);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet && bullet[1].length === 0) {
      flush();
      currentIsBullet = true;
      current.push(bullet[2]);
      continue;
    }
    if (current.length === 0) {
      currentIsBullet = false;
    }
    current.push(line.trim());
  }
  flush();
  return entries;
}

/**
 * The `### Additional human feedback` blocks of `## Human evidence`,
 * verbatim and in the order they were recorded.
 *
 * Verbatim, and one block per submission, because this is a person's own
 * report of something the workflow did not ask about: a reproduction path
 * loses its meaning when its lines are joined, and a second submission is a
 * second observation rather than a correction of the first. What is dropped
 * is only the heading line itself.
 */
export function parseHumanFeedback(notes: string | undefined): string[] {
  if (!notes) {
    return [];
  }
  const lines = notes.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === HUMAN_EVIDENCE_HEADING);
  if (start < 0) {
    return [];
  }
  const blocks: string[] = [];
  let current: string[] | undefined;
  let inFence = false;
  const flush = () => {
    const text = current?.join("\n").trim();
    if (text) {
      blocks.push(text);
    }
    current = undefined;
  };
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    }
    if (!inFence && /^#{1,2}\s/.test(line)) {
      break;
    }
    const sub = !inFence ? SUB_HEADING_RE.exec(line) : null;
    if (sub) {
      flush();
      if (FEEDBACK_HEADING_RE.test(sub[1])) {
        current = [];
      }
      continue;
    }
    current?.push(line);
  }
  flush();
  return blocks;
}

/** Shared significant words needed before a prose entry counts as evidence for a check (stricter than reviewer matching). */
export const EVIDENCE_MATCH_MIN_OVERLAP = 3;

export interface RecordedEvidence {
  /** The entry, shortened for display. */
  excerpt: string;
  /** From a structured line; undefined for prose evidence (which is shown as recorded, never as passed). */
  outcome?: CheckOutcome;
  /** `id`: the entry names this gate check's stable id. `exact`: it quotes the check. `prose`: word overlap. */
  how: "id" | "exact" | "prose";
}

/**
 * The recorded evidence for a check, if any, in decreasing order of
 * certainty: a structured line naming the check's stable gate id; else one
 * whose check text is this check (exact, normalised); else the prose entry
 * sharing the most significant words with it, at least
 * EVIDENCE_MATCH_MIN_OVERLAP, uniquely, and not itself negative. The
 * excerpt is shown so the reader can see why the check counts as recorded.
 *
 * This is the **derived** path: the legacy plan/prose checks, which are not
 * a reviewer's structured gate and so have no asking to belong to. A gate
 * check is resolved by {@link evidenceForGateInstance} instead, which is
 * stricter because a gate can be asked more than once.
 */
export function recordedEvidenceFor(check: { text: string; key?: string; origin?: CheckOrigin }, entries: EvidenceEntry[]): RecordedEvidence | undefined {
  // Freeform feedback is not a result for anything, however much of a check's
  // wording it repeats: a person reporting that they cannot perform a check
  // must never turn that check green.
  const candidates = entries.filter((entry) => !entry.feedback);
  if (check.origin === "gate" && check.key) {
    const byId = candidates.filter((entry) => entry.checkId === check.key).pop();
    if (byId) {
      return { excerpt: excerpt(byId.text), outcome: byId.outcome, how: "id" };
    }
  }
  const exact = candidates.filter((entry) => entry.checkText !== undefined && normalise(entry.checkText) === normalise(check.text)).pop();
  if (exact) {
    return { excerpt: excerpt(exact.text), outcome: exact.outcome, how: "exact" };
  }
  const prose = candidates.filter((entry) => entry.checkText === undefined && !entry.negative);
  const at = matchReviewerRequest(prose, check.text, EVIDENCE_MATCH_MIN_OVERLAP);
  return at === undefined ? undefined : { excerpt: excerpt(prose[at].text), how: "prose" };
}

/**
 * Split the recorded evidence for **one gate check** into the answer to the
 * asking in front of the person, and the answers to earlier askings.
 *
 * This is the whole of the re-issued-check fix, and the rule is short: an
 * entry answers *this* gate only if it names this gate instance. A reviewer
 * re-issues a check under the same id exactly when the answer it got was
 * insufficient, so matching on the check id alone hands back the answer the
 * reviewer has already rejected and reports the question as settled — after
 * which there is nothing to submit and no way to answer. The check id still
 * does its job: it is what gathers the earlier answers under the right
 * question, as history.
 *
 * When the gate names no instance, nothing can be *proven* to answer it, so
 * nothing does. That is the conservative reading and the only honest one: a
 * gate recorded before instances existed may be a first asking or a fourth,
 * and this cannot tell. The cost is asking a person to answer something they
 * may have answered before, with their earlier answer shown to them; the
 * alternative cost is the unanswerable check this exists to remove. Their
 * earlier answers are never rewritten either way.
 */
export function evidenceForGateInstance(
  check: { text: string; key?: string; origin?: CheckOrigin },
  entries: EvidenceEntry[],
  gateInstance: string | undefined,
): { current?: RecordedEvidence; previous: RecordedEvidence[] } {
  const candidates = entries.filter((entry) => !entry.feedback);
  const structured = candidates.filter((entry) => entry.outcome !== undefined && matchesCheck(check, entry));
  const current = gateInstance === undefined ? undefined : structured.filter((entry) => entry.gateInstanceId === gateInstance).pop();
  const previous: RecordedEvidence[] = structured
    .filter((entry) => entry !== current)
    .map((entry) => ({ excerpt: excerpt(entry.text), outcome: entry.outcome, how: entry.checkId === check.key ? ("id" as const) : ("exact" as const) }));
  // A `## Human evidence` paragraph that names this check but carries no
  // outcome and no ids. It cannot be attributed to an asking, so it is never
  // the current answer — but it is still somebody's report about this check,
  // and dropping it would lose information this panel used to show.
  const prose = candidates.filter((entry) => entry.checkText === undefined && entry.outcome === undefined && !entry.negative);
  const at = matchReviewerRequest(prose, check.text, EVIDENCE_MATCH_MIN_OVERLAP);
  if (at !== undefined) {
    previous.push({ excerpt: excerpt(prose[at].text), how: "prose" });
  }
  return {
    current: current ? { excerpt: excerpt(current.text), outcome: current.outcome, how: "id" } : undefined,
    previous,
  };
}

/** Whether a structured entry is about this check: by the reviewer's stable id, else by the check's exact wording. */
function matchesCheck(check: { text: string; key?: string }, entry: EvidenceEntry): boolean {
  if (entry.checkId !== undefined) {
    return entry.checkId === check.key;
  }
  return entry.checkText !== undefined && normalise(entry.checkText) === normalise(check.text);
}

export const EXCERPT_MAX_LENGTH = 160;

function excerpt(text: string, max = EXCERPT_MAX_LENGTH): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---------------------------------------------------------------- putting it together

export type CheckOrigin = "gate" | "plan" | "reviewer";

/** One verification check as the panel shows it, with where it came from and what is known about it. */
export interface CheckItem {
  key: string;
  text: string;
  origin: CheckOrigin;
  /**
   * The reviewer's own stable id, when the gate gave one this panel can
   * round-trip; `key` is then equal to it. Absent for a derived check, and for
   * a gate check whose id had to fall back to a hash — so anything that shows
   * a check *by name* can tell the reviewer's id from a key we invented, and
   * never presents the second as the first.
   */
  gateId?: string;
  /** The reviewer's own pass/fail criteria; gate checks only. */
  passCriteria?: string;
  /**
   * The asking this check belongs to, when the gate named one.
   *
   * `draftKey` already encodes it, but it is needed *by itself* by anything
   * that has to address the check back to the engine — a deferred result is
   * sent as `<gate instance>:<check id>`, because the same check id can be
   * owed by two different askings at the same checkpoint and the engine
   * refuses to guess between them.
   */
  gateInstanceId?: string;
  /**
   * The stage whose review raised this check, for a deferred obligation.
   *
   * Absent for an immediate gate, where the check belongs to the stage in
   * front of the person by construction. Present at the plan's verification
   * checkpoint, where the whole point is that these came from stages that
   * finished some time ago.
   */
  originStageId?: string;
  /** Where the full test is defined, as the reviewer named it; gate checks only. */
  source?: string;
  /** Plan line for plan checks. */
  line?: number;
  /**
   * Where this check's draft is stored, which is **not** `key`.
   *
   * A draft belongs to the asking it was typed for. Keying it on the check
   * id alone would carry an unsent draft from one asking of a check to the
   * next, which is the same mistake as carrying the evidence across — the
   * reviewer asked again because the last answer was not enough, so the
   * last answer must not be pre-filled as this one. For a gate check with
   * an instance this is `<instance>::<key>`; otherwise it is `key`.
   *
   * One consequence, accepted: a draft typed before this existed is stored
   * under the bare key, so it is still read for a gate that names no
   * asking, and is *not* read once the engine records one that does. That
   * loses an unsent draft — a round of typing, once, for a person who was
   * mid-answer when the extension updated. The alternative is reading a
   * draft as the answer to a question it was not typed for, which is the
   * defect this whole key exists to prevent.
   */
  draftKey: string;
  /**
   * Whether the gate this check came from said which asking it is.
   *
   * False for a gate recorded before instances existed, and for a derived
   * check. It changes nothing about the rules — unattributable evidence is
   * previous either way — but it changes what the panel may *say*: with no
   * asking recorded, "the reviewer has asked this again" is a claim nothing
   * here can support.
   */
  askingIdentified: boolean;
  /** The user's unsubmitted draft for *this* asking. */
  record?: CheckRecord;
  /** Evidence in notes.md that answers *this* asking; present ⇒ not outstanding. */
  evidence?: RecordedEvidence;
  /**
   * Answers to earlier askings of this same check, oldest first. Shown as
   * history so a person can see what they already reported and why they are
   * being asked again; never counted as answering the current gate, never
   * re-submitted, and never removed from notes.md.
   */
  previous: RecordedEvidence[];
}

export interface VerificationView {
  /**
   * Where the check list came from. `gate`: the reviewer's structured
   * human_gate, which is authoritative and complete. `derived`: the legacy
   * plan/prose path, for a result recorded before gates existed.
   */
  source: "gate" | "derived";
  /** The gate's own category and title, when the reviewer supplied one, and which asking it is. */
  gate?: { category: string; title: string; instanceId?: string };
  /** Prose requirements from the plan, verbatim (legacy path only). */
  parents: ManualCheck[];
  explicitCount: number;
  reviewerCount: number;
  /** Checks the current gate instance already has recorded evidence for. */
  recorded: CheckItem[];
  /** Checks still outstanding for the current gate instance, with the user's drafts. */
  required: CheckItem[];
  /** `N / M verified`; undefined without checks. */
  progress?: string;
  /**
   * Exactly what Submit would write: the outstanding checks that have a
   * drafted outcome, in the reviewer's order.
   *
   * It lives on the view rather than being recomputed by the submit command
   * because the panel and the command disagreeing about it is a bug this
   * code has already had. `ready` below is defined in terms of *this array*,
   * so "the panel says the evidence is complete" and "the command has
   * something to send" cannot come apart: they are one fact.
   */
  submittable: RecordedCheck[];
  /**
   * There is evidence to send, and it answers every outstanding check.
   *
   * Both halves matter. The second is the obvious one. The first is what was
   * missing: with no outstanding checks at all, `required.every(...)` is
   * vacuously true, so the panel reported the evidence complete while the
   * submit path had an empty list and refused — the split-brain state. An
   * empty `submittable` is never ready, whatever else is true.
   *
   * Readiness says the reviewer's evidence is complete enough to send back.
   * It decides nothing about the stage; the reviewer rules on it.
   */
  ready: boolean;
}

/**
 * Derive the panel's lists.
 *
 * With a structured gate, the checks are the gate's checks and nothing else.
 * Without one, the legacy path applies: the explicit plan checks plus the
 * reviewer's requested clauses (a clause overlapping an explicit plan check
 * is the same check and is dropped); without either, the parent
 * requirements themselves are the recordable units.
 *
 * Either way, each check is then either recorded (notes.md names it) or
 * still required.
 */
export function deriveVerification(plan: PlanChecks, outcome: SparringOutcome | undefined, evidence: EvidenceEntry[], drafts: Record<string, CheckRecord>): VerificationView {
  const gate = outcome?.humanGate;
  const items = gate ? gateItems(gate) : derivedItems(plan, outcome);
  for (const item of items) {
    if (item.origin === "gate") {
      // A gate check answers one asking. Everything else about it is history.
      const split = evidenceForGateInstance(item, evidence, gate?.instanceId);
      item.evidence = split.current;
      item.previous = split.previous;
    } else {
      // The derived path has no askings: a plan check is a standing
      // requirement, not a question a reviewer put twice.
      item.evidence = recordedEvidenceFor(item, evidence);
    }
    if (!item.evidence) {
      item.record = drafts[item.draftKey];
    }
  }
  const recorded = items.filter((item) => item.evidence);
  const required = items.filter((item) => !item.evidence);
  const submittable: RecordedCheck[] = required
    .filter((item) => item.record?.outcome)
    .map((item) => ({ text: item.text, origin: item.origin, record: item.record as CheckRecord, id: item.origin === "gate" ? item.key : undefined, gateInstanceId: item.origin === "gate" ? gate?.instanceId : undefined }));
  return {
    source: gate ? "gate" : "derived",
    gate: gate ? { category: gate.category, title: gate.title, instanceId: gate.instanceId } : undefined,
    parents: gate ? [] : plan.parents,
    explicitCount: gate ? 0 : plan.explicit.length,
    reviewerCount: gate ? 0 : items.filter((item) => item.origin === "reviewer").length,
    recorded,
    required,
    progress: progressText(items),
    submittable,
    // One definition, and it is this line. Both halves: something to send,
    // and nothing outstanding left unanswered.
    ready: submittable.length > 0 && submittable.length === required.length,
  };
}

/**
 * The gate's checks, 1:1 and in the reviewer's order. The check's own `id`
 * is the draft key, so a draft survives the reviewer restating the gate
 * with different wording — which is the whole reason the engine requires a
 * stable id.
 */
/**
 * The panel's lists for the plan's **deferred-verification checkpoint**.
 *
 * Same machinery as {@link deriveVerification}, and deliberately so: these
 * are gate checks, with reviewer ids, pass criteria and askings, and
 * inventing a second evidence system for them would mean a second set of
 * rules about which recorded answer counts — the exact thing the gate
 * instance exists to settle. What differs is only that the checks come from
 * *several* gates, raised by *several* stages, gathered into one checkpoint
 * so a person is interrupted once rather than four times.
 *
 * Provenance is kept per check: `originStageId` says which stage's review
 * raised it, and `gateInstanceId` says which asking it answers. Both travel
 * as far as the engine, which is addressed as `<instance>:<check id>`.
 *
 * `results` is the engine's ledger, not notes.md, and **only a `pass`
 * settles a check**. That is the engine's rule, not a presentation choice: a
 * `fail` leaves the obligation FAILED and a `blocked` leaves it unanswered
 * (`deferred_gate.py`: `DeferredObligation.unanswered` / `status`), so in
 * both cases the run stays stopped on it. Treating either as recorded took
 * the check out of the list, left nothing to submit, and dead-ended the plan
 * at a panel that said in one breath that the check must be answered again
 * and that there was nothing further to send. So a non-pass result stays
 * outstanding, with what was recorded shown beside it as history.
 */
export function deriveDeferredVerification(
  obligations: {
    stageId: string;
    gate: HumanGate;
    results: { checkId: string; outcome: CheckOutcome; note?: string }[];
  }[],
  drafts: Record<string, CheckRecord>,
): VerificationView {
  const items: CheckItem[] = [];
  // The reviewer's own check id, which is what the engine is addressed with.
  // `item.key` may be a hash of the instruction, for an id this panel cannot
  // round-trip into a notes.md line — but nothing is written to notes.md
  // here, and sending the hash would produce a reference the engine refuses.
  const wireId = new Map<string, string>();
  for (const obligation of obligations) {
    const rendered = gateItems(obligation.gate);
    rendered.forEach((item, index) => {
      item.originStageId = obligation.stageId;
      wireId.set(item.draftKey, obligation.gate.checks[index].id);
      const recorded = obligation.results.find((result) => result.checkId === obligation.gate.checks[index].id);
      if (recorded?.outcome === "pass") {
        // Settled. A person who already passed this at an earlier visit to
        // the checkpoint must not be asked again, and must not have their
        // answer re-sent.
        item.evidence = { excerpt: recorded.note ?? item.text, outcome: "pass", how: "id" };
      } else {
        // Answered, and still owed. Shown as history so the person can see
        // what they reported last time and why they are being asked again.
        //
        // The ledger is the only history read here, deliberately. The engine
        // writes a deferred answer into the *originating* stage's notes.md,
        // which is not the stage this panel is looking at, so mining this
        // stage's `## Human evidence` would be looking in the wrong file and
        // finding nothing — which reads like code that does something.
        item.previous = recorded ? [{ excerpt: recorded.note ?? item.text, outcome: recorded.outcome, how: "id" }] : [];
        item.record = drafts[item.draftKey];
      }
      items.push(item);
    });
  }
  const recorded = items.filter((item) => item.evidence);
  const required = items.filter((item) => !item.evidence);
  const submittable: RecordedCheck[] = required
    .filter((item) => item.record?.outcome)
    .map((item) => ({
      text: item.text,
      origin: item.origin,
      record: item.record as CheckRecord,
      id: wireId.get(item.draftKey) ?? item.key,
      gateInstanceId: item.gateInstanceId,
    }));
  return {
    source: "gate",
    parents: [],
    explicitCount: 0,
    reviewerCount: 0,
    recorded,
    required,
    progress: progressText(items),
    submittable,
    ready: submittable.length > 0 && submittable.length === required.length,
  };
}

function gateItems(gate: HumanGate): CheckItem[] {
  return gate.checks.map((check) => {
    // The reviewer's id, unless it is a shape the panel cannot round-trip —
    // then the instruction's own hash, so the control still works and the
    // result is matched by its wording instead. A check whose button does
    // nothing is worse than one whose result is matched less precisely.
    const usable = isCheckKey(check.id);
    const key = usable ? check.id : checkKey(check.instruction);
    return {
      key,
      draftKey: draftKeyFor(key, gate.instanceId),
      gateInstanceId: gate.instanceId,
      askingIdentified: gate.instanceId !== undefined,
      gateId: usable ? check.id : undefined,
      text: check.instruction,
      origin: "gate" as const,
      passCriteria: check.passCriteria,
      source: check.source,
      previous: [],
    };
  });
}

/**
 * Where a check's draft is stored. Scoped to the asking when there is one,
 * so an unsent draft never answers a question it was not typed for; bare
 * when there is not, which keeps every draft written before this readable
 * exactly where it already is.
 */
export function draftKeyFor(key: string, gateInstanceId: string | undefined): string {
  return gateInstanceId ? `${gateInstanceId}${DRAFT_KEY_SEPARATOR}${key}` : key;
}

function derivedItems(plan: PlanChecks, outcome: SparringOutcome | undefined): CheckItem[] {
  const items: CheckItem[] = plan.explicit.map((check) => ({ key: check.key, draftKey: check.key, askingIdentified: false, text: check.text, origin: "plan", line: check.line, previous: [] }));
  for (const text of reviewerChecks(outcome)) {
    if (plan.explicit.length > 0 && matchReviewerRequest(plan.explicit, text) !== undefined) {
      continue;
    }
    const key = checkKey(text);
    items.push({ key, draftKey: key, askingIdentified: false, text, origin: "reviewer", previous: [] });
  }
  if (items.length === 0) {
    items.push(...plan.parents.map((check): CheckItem => ({ key: check.key, draftKey: check.key, askingIdentified: false, text: check.text, origin: "plan", line: check.line, previous: [] })));
  }
  return items;
}

/**
 * The one-line tally beside the checks heading: `2 / 5 verified · 1 failed ·
 * 1 couldn't test · 1 remaining`.
 *
 * Every outcome is counted as itself. An earlier version reported the
 * engine's word for the third one, and five checks a person could not run
 * came out as "0 / 5 verified · 5 blocked" — which reads as five things
 * standing in the way of the stage, when what actually happened is that no
 * verification result could be obtained for any of them. A check nobody has
 * answered yet is counted separately again, as `remaining`: unanswered and
 * "couldn't test" are different statements and must not share a bucket.
 *
 * The verified count keeps its `n / total` shape, because that is the one
 * number a person is tracking towards; the rest are omitted when zero, so a
 * clean run says `5 / 5 verified` and nothing else.
 */
export function progressText(items: { record?: CheckRecord; evidence?: RecordedEvidence }[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const outcomeOf = (item: { record?: CheckRecord; evidence?: RecordedEvidence }): CheckOutcome | undefined => (item.evidence ? (item.evidence.outcome ?? "pass") : item.record?.outcome);
  const outcomes = items.map(outcomeOf);
  const count = (wanted: CheckOutcome | undefined): number => outcomes.filter((outcome) => outcome === wanted).length;
  const extra = [
    count("fail") ? `${count("fail")} failed` : "",
    count("blocked") ? `${count("blocked")} ${PROGRESS_UNTESTED_WORD}` : "",
    count(undefined) ? `${count(undefined)} remaining` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `${count("pass")} / ${items.length} verified${extra ? ` · ${extra}` : ""}`;
}

/**
 * How the summary names a check nobody could perform. One word list, so the
 * button ("Can't test"), the recorded label and this tally cannot drift
 * apart — and so a test can assert that "blocked" is not among them.
 */
export const PROGRESS_UNTESTED_WORD = "couldn't test";

// ---------------------------------------------------------------- evidence rendering

export interface RecordedCheck {
  text: string;
  origin: CheckOrigin;
  record: CheckRecord;
  /** The gate check's stable id, written into the line so the result is matched by id next turn. */
  id?: string;
  /**
   * The gate instance this result answers, written into the line so a later
   * asking of the same check can tell this result apart from its own. Absent
   * when the gate named no instance, which is what makes the result
   * unattributable — and so, next turn, history rather than an answer.
   */
  gateInstanceId?: string;
}

/**
 * The prose entry for `## Human evidence`: one line per check with a
 * recorded outcome, the check's own wording quoted, the note beneath it.
 * A gate check's line carries its stable id, so the reviewer restating the
 * same check with different wording still finds this result; a legacy
 * reviewer-derived check is marked as such. Checks without an outcome are
 * not mentioned (nothing is claimed about them). The date is the only thing
 * added that the user did not type.
 */
export function renderHumanEvidence(checks: RecordedCheck[], date: Date, planName?: string): string | undefined {
  const recorded = checks.filter((check) => check.record.outcome);
  if (recorded.length === 0) {
    return undefined;
  }
  const day = date.toISOString().slice(0, 10);
  const against = planName ? ` against the checks of ${planName}` : "";
  const lines = [`${day} — manual verification recorded in VS Code${against}:`, ""];
  for (const check of recorded) {
    const suffix = check.id ? ` · check \`${check.id}\`` : check.origin === "reviewer" ? " · reviewer request" : "";
    // Which asking this answered. Last, and only when there is one, so every
    // line this has ever written still parses and still reads the same.
    const gate = check.id && check.gateInstanceId ? ` · gate \`${check.gateInstanceId}\`` : "";
    lines.push(`- ${OUTCOME_WORDS[check.record.outcome as CheckOutcome]} — ${check.text}${suffix}${gate}`);
    if (check.record.note?.trim()) {
      for (const noteLine of check.record.note.trim().split(/\r?\n/)) {
        lines.push(`  ${noteLine}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * The `## Human evidence` entry for freeform feedback: the sub-heading that
 * marks it as *not* a check result, a dated lead-in in the same shape the
 * check results use, and then the person's text exactly as they typed it.
 *
 * Nothing is added, reworded or classified. The reviewer is the one who
 * decides what the text means for routing, and any summarising here would be
 * this extension deciding that instead — from the one place that has no
 * evidence to decide it with.
 */
export function renderHumanFeedback(text: string, date: Date): string | undefined {
  const body = text.replace(/\s+$/, "");
  if (!body.trim()) {
    return undefined;
  }
  const day = date.toISOString().slice(0, 10);
  return [HUMAN_FEEDBACK_HEADING, "", `${day} — reported in VS Code by the human this stage is waiting on, alongside the requested checks:`, "", body].join("\n");
}

/**
 * The checks Submit for review will write.
 *
 * An accessor, deliberately: this used to recompute the list from
 * `view.required`, and the panel's `ready` flag was computed separately from
 * the same array. The two agreed until a gate arrived whose checks were all
 * already recorded — then `required` was empty, `ready` was vacuously true,
 * the panel said "Evidence ready for review" and this returned nothing, so
 * Submit answered "record a result for the remaining checks first" about
 * checks it was simultaneously reporting as done. One array, derived once,
 * in {@link deriveVerification}; there is nothing left here to disagree with.
 */
export function submittableChecks(view: VerificationView): RecordedCheck[] {
  return view.submittable;
}

/**
 * Append `entry` under `## Human evidence` in notes.md, creating the
 * heading on first use, exactly as the engine does (plan.py:
 * record_human_evidence). Nothing else in the file is touched.
 */
export function appendHumanEvidence(notes: string, entry: string): string {
  let body = notes.replace(/\n+$/, "");
  const hasHeading = body.split(/\r?\n/).some((line) => line.trim() === HUMAN_EVIDENCE_HEADING);
  if (!hasHeading) {
    body += `\n\n${HUMAN_EVIDENCE_HEADING}`;
  }
  return `${body}\n\n${entry.trim()}\n`;
}

// The extension used to mirror the same entry into the stage's handoff.md,
// because the reviewer's prompt embedded handoff.md verbatim and only a
// *stage-agent* turn folded notes.md's evidence into it — so evidence sent
// without running the stage agent was invisible. The engine now reads the
// `## Human evidence` section of notes.md live when it builds the sparring
// prompt (sparring_prompt.py), so notes.md is the one canonical place and
// nothing here maintains a duplicate.
