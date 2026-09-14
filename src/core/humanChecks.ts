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

export type CheckOutcome = "pass" | "fail" | "blocked";

export const CHECK_OUTCOMES: readonly CheckOutcome[] = ["pass", "fail", "blocked"];

export const OUTCOME_WORDS: Record<CheckOutcome, string> = { pass: "Pass", fail: "Fail", blocked: "Blocked" };

export interface CheckRecord {
  outcome?: CheckOutcome;
  /** Free-text evidence or note; optional. */
  note?: string;
}

/** workspaceState entry: run id → check key → record. Drafts until submitted. */
export type HumanCheckDrafts = Record<string, Record<string, CheckRecord>>;

export const HUMAN_CHECKS_KEY = "agentSparring.humanChecks";

export function humanChecksFor(drafts: HumanCheckDrafts | undefined, runId: string): Record<string, CheckRecord> {
  const value = drafts?.[runId];
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

/** Record (merge) one check's outcome and/or note; an empty record removes the draft. */
export function withHumanCheck(drafts: HumanCheckDrafts | undefined, runId: string, key: string, change: CheckRecord): HumanCheckDrafts {
  const next: HumanCheckDrafts = { ...(drafts ?? {}) };
  const forRun = { ...humanChecksFor(drafts, runId) };
  const merged: CheckRecord = { ...forRun[key], ...change };
  if (merged.note !== undefined && !merged.note.trim()) {
    delete merged.note;
  }
  if (merged.outcome || merged.note) {
    forRun[key] = merged;
  } else {
    delete forRun[key];
  }
  if (Object.keys(forRun).length > 0) {
    next[runId] = forRun;
  } else {
    delete next[runId];
  }
  return next;
}

export function withoutHumanChecks(drafts: HumanCheckDrafts | undefined, runId: string): HumanCheckDrafts {
  const next: HumanCheckDrafts = { ...(drafts ?? {}) };
  delete next[runId];
  return next;
}

// ---------------------------------------------------------------- recorded evidence (notes.md ## Human evidence)

export const HUMAN_EVIDENCE_HEADING = "## Human evidence";

/** One entry of `## Human evidence`: a list item (with continuation lines) or a paragraph. */
export interface EvidenceEntry {
  text: string;
  /** Set for the structured lines Submit for review writes (`- Pass — <check>`). */
  outcome?: CheckOutcome;
  /** The check text of such a line, origin and id suffixes removed. */
  checkText?: string;
  /** The gate check's stable id, when the line names one (`· check `pre-activation-desktop``). */
  checkId?: string;
  /** The entry says something is still pending / not claimed; it is not evidence of completion. */
  negative: boolean;
}

/** Wording by which a human entry says a check is *not* done; such an entry never counts as completion evidence. */
const NEGATIVE_RE = /\b(still pending|not claimed|not yet|cannot|can no longer|could not|unverified|not (?:done|verified|observed|run|tested|checked|exercised)|remains? (?:pending|open|outstanding|unverified)|outstanding:)\b/i;
/**
 * A result line this panel wrote: the outcome, the check's own wording, and
 * an optional origin marker. `· check \`<id>\`` carries the gate check's
 * stable id, which is what makes a recorded result survive the reviewer
 * rewording the same check on a later turn.
 */
const STRUCTURED_RE = /^(Pass|Fail|Blocked)\s+—\s+(.+?)(?:\s+·\s+check\s+`([^`]+)`)?(?:\s+·\s+reviewer request)?$/;

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
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    // A structured result line is its bullet's first line; the indented note beneath does not change what it names.
    const structured = currentIsBullet && current.length > 0 ? STRUCTURED_RE.exec(current[0].trim()) : null;
    current = [];
    if (!text) {
      return;
    }
    entries.push({
      text,
      outcome: structured ? (structured[1].toLowerCase() as CheckOutcome) : undefined,
      checkText: structured ? structured[2] : undefined,
      checkId: structured ? structured[3] : undefined,
      negative: NEGATIVE_RE.test(text),
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
 * A gate check falls back to text and prose matching too, so evidence
 * recorded before the reviewer supplied structured gates still counts.
 */
export function recordedEvidenceFor(check: { text: string; key?: string; origin?: CheckOrigin }, entries: EvidenceEntry[]): RecordedEvidence | undefined {
  if (check.origin === "gate" && check.key) {
    const byId = entries.filter((entry) => entry.checkId === check.key).pop();
    if (byId) {
      return { excerpt: excerpt(byId.text), outcome: byId.outcome, how: "id" };
    }
  }
  const exact = entries.filter((entry) => entry.checkText !== undefined && normalise(entry.checkText) === normalise(check.text)).pop();
  if (exact) {
    return { excerpt: excerpt(exact.text), outcome: exact.outcome, how: "exact" };
  }
  const prose = entries.filter((entry) => entry.checkText === undefined && !entry.negative);
  const at = matchReviewerRequest(prose, check.text, EVIDENCE_MATCH_MIN_OVERLAP);
  return at === undefined ? undefined : { excerpt: excerpt(prose[at].text), how: "prose" };
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
  /** The reviewer's own pass/fail criteria; gate checks only. */
  passCriteria?: string;
  /** Where the full test is defined, as the reviewer named it; gate checks only. */
  source?: string;
  /** Plan line for plan checks. */
  line?: number;
  /** The user's unsubmitted draft. */
  record?: CheckRecord;
  /** Evidence already in notes.md; present ⇒ the check is no longer outstanding. */
  evidence?: RecordedEvidence;
}

export interface VerificationView {
  /**
   * Where the check list came from. `gate`: the reviewer's structured
   * human_gate, which is authoritative and complete. `derived`: the legacy
   * plan/prose path, for a result recorded before gates existed.
   */
  source: "gate" | "derived";
  /** The gate's own category and title, when the reviewer supplied one. */
  gate?: { category: string; title: string };
  /** Prose requirements from the plan, verbatim (legacy path only). */
  parents: ManualCheck[];
  explicitCount: number;
  reviewerCount: number;
  /** Checks with recorded evidence in notes.md. */
  recorded: CheckItem[];
  /** Checks still outstanding, with the user's drafts. */
  required: CheckItem[];
  /** `N / M verified`; undefined without checks. */
  progress?: string;
  /**
   * Every check has an outcome — recorded in notes.md or drafted here — and
   * there is at least one. The evidence the reviewer asked for is complete,
   * so it can go back for review; nothing about the stage is decided by it.
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
    item.evidence = recordedEvidenceFor(item, evidence);
    if (!item.evidence) {
      item.record = drafts[item.key];
    }
  }
  const recorded = items.filter((item) => item.evidence);
  const required = items.filter((item) => !item.evidence);
  return {
    source: gate ? "gate" : "derived",
    gate: gate ? { category: gate.category, title: gate.title } : undefined,
    parents: gate ? [] : plan.parents,
    explicitCount: gate ? 0 : plan.explicit.length,
    reviewerCount: gate ? 0 : items.filter((item) => item.origin === "reviewer").length,
    recorded,
    required,
    progress: progressText(items),
    ready: items.length > 0 && required.every((item) => item.record?.outcome !== undefined),
  };
}

/**
 * The gate's checks, 1:1 and in the reviewer's order. The check's own `id`
 * is the draft key, so a draft survives the reviewer restating the gate
 * with different wording — which is the whole reason the engine requires a
 * stable id.
 */
function gateItems(gate: HumanGate): CheckItem[] {
  return gate.checks.map((check) => ({
    // The reviewer's id, unless it is a shape the panel cannot round-trip —
    // then the instruction's own hash, so the control still works and the
    // result is matched by its wording instead. A check whose button does
    // nothing is worse than one whose result is matched less precisely.
    key: isCheckKey(check.id) ? check.id : checkKey(check.instruction),
    text: check.instruction,
    origin: "gate" as const,
    passCriteria: check.passCriteria,
    source: check.source,
  }));
}

function derivedItems(plan: PlanChecks, outcome: SparringOutcome | undefined): CheckItem[] {
  const items: CheckItem[] = plan.explicit.map((check) => ({ key: check.key, text: check.text, origin: "plan", line: check.line }));
  for (const text of reviewerChecks(outcome)) {
    if (plan.explicit.length > 0 && matchReviewerRequest(plan.explicit, text) !== undefined) {
      continue;
    }
    items.push({ key: checkKey(text), text, origin: "reviewer" });
  }
  if (items.length === 0) {
    items.push(...plan.parents.map((check): CheckItem => ({ key: check.key, text: check.text, origin: "plan", line: check.line })));
  }
  return items;
}

/** `2 / 3 verified`: recorded evidence that is not a Fail/Blocked line, plus Pass drafts, over all checks; failed / blocked counts when any. */
export function progressText(items: { record?: CheckRecord; evidence?: RecordedEvidence }[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const outcomeOf = (item: { record?: CheckRecord; evidence?: RecordedEvidence }): CheckOutcome | undefined => (item.evidence ? (item.evidence.outcome ?? "pass") : item.record?.outcome);
  const passed = items.filter((item) => outcomeOf(item) === "pass").length;
  const failed = items.filter((item) => outcomeOf(item) === "fail").length;
  const blocked = items.filter((item) => outcomeOf(item) === "blocked").length;
  const extra = [failed ? `${failed} failed` : "", blocked ? `${blocked} blocked` : ""].filter(Boolean).join(" · ");
  return `${passed} / ${items.length} verified${extra ? ` · ${extra}` : ""}`;
}

// ---------------------------------------------------------------- evidence rendering

export interface RecordedCheck {
  text: string;
  origin: CheckOrigin;
  record: CheckRecord;
  /** The gate check's stable id, written into the line so the result is matched by id next turn. */
  id?: string;
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
    lines.push(`- ${OUTCOME_WORDS[check.record.outcome as CheckOutcome]} — ${check.text}${suffix}`);
    if (check.record.note?.trim()) {
      for (const noteLine of check.record.note.trim().split(/\r?\n/)) {
        lines.push(`  ${noteLine}`);
      }
    }
  }
  return lines.join("\n");
}

/** The checks Submit for review will write: outstanding checks with a drafted outcome. */
export function submittableChecks(view: VerificationView): RecordedCheck[] {
  const out: RecordedCheck[] = [];
  for (const item of view.required) {
    if (item.record?.outcome) {
      out.push({ text: item.text, origin: item.origin, record: item.record, id: item.origin === "gate" ? item.key : undefined });
    }
  }
  return out;
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
