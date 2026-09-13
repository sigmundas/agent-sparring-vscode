/**
 * Manual verification for a stage the reviewer handed back to the human
 * (NEEDS_YOU / ESCALATE). Everything here is *derived presentation* of the
 * stage's existing artifacts; nothing is a second source of truth:
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
 *    reviewer's, never shown as plan text;
 *  - **recorded evidence** is the `## Human evidence` section of notes.md
 *    (the engine's own place for a human's check results; stage.py:
 *    HUMAN_EVIDENCE_HEADING). A check counts as recorded when an entry of
 *    that section names it: exactly (the lines Submit evidence writes) or
 *    by clear word overlap with an entry that does not itself say the
 *    check is still pending. Recorded checks leave "Still required";
 *  - the outcomes the user is recording now (Pass / Fail / Blocked plus a
 *    note) are drafts in VS Code workspace state until submitted, when they
 *    are rendered as prose under `## Human evidence` and the same stage
 *    resumes. Nothing here marks anything READY or accepted.
 *
 * No dependency on the vscode API.
 */

import type { SparringOutcome } from "./engineFormats";
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
  /** Set for the structured lines Submit evidence writes (`- Pass — <check>`). */
  outcome?: CheckOutcome;
  /** The check text of such a line, origin suffix removed. */
  checkText?: string;
  /** The entry says something is still pending / not claimed; it is not evidence of completion. */
  negative: boolean;
}

/** Wording by which a human entry says a check is *not* done; such an entry never counts as completion evidence. */
const NEGATIVE_RE = /\b(still pending|not claimed|not yet|cannot|can no longer|could not|unverified|not (?:done|verified|observed|run|tested|checked|exercised)|remains? (?:pending|open|outstanding|unverified)|outstanding:)\b/i;
const STRUCTURED_RE = /^(Pass|Fail|Blocked)\s+—\s+(.+?)(?:\s+·\s+reviewer request)?$/;

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
  how: "exact" | "prose";
}

/**
 * The recorded evidence for a check, if any: a structured line whose check
 * text is this check (exact, normalised), else the prose entry sharing the
 * most significant words with it, at least EVIDENCE_MATCH_MIN_OVERLAP,
 * uniquely, and not itself negative. The excerpt is shown so the reader
 * can see why the check counts as recorded.
 */
export function recordedEvidenceFor(check: { text: string }, entries: EvidenceEntry[]): RecordedEvidence | undefined {
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

export type CheckOrigin = "plan" | "reviewer";

/** One verification check as the panel shows it, with where it came from and what is known about it. */
export interface CheckItem {
  key: string;
  text: string;
  origin: CheckOrigin;
  /** Plan line for plan checks. */
  line?: number;
  /** The user's unsubmitted draft. */
  record?: CheckRecord;
  /** Evidence already in notes.md; present ⇒ the check is no longer outstanding. */
  evidence?: RecordedEvidence;
}

export interface VerificationView {
  /** Prose requirements from the plan, verbatim (fallback when the plan has no explicit checklist). */
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
 * Derive the panel's lists. Recordable checks are the explicit plan checks
 * plus the reviewer's requested checks (a reviewer clause that overlaps an
 * explicit plan check is the same check and is dropped); without either,
 * the parent requirements themselves are the recordable units. Each check
 * is then either recorded (notes.md names it) or still required.
 */
export function deriveVerification(plan: PlanChecks, outcome: SparringOutcome | undefined, evidence: EvidenceEntry[], drafts: Record<string, CheckRecord>): VerificationView {
  const items: CheckItem[] = plan.explicit.map((check) => ({ key: check.key, text: check.text, origin: "plan", line: check.line }));
  let reviewerCount = 0;
  for (const text of reviewerChecks(outcome)) {
    if (plan.explicit.length > 0 && matchReviewerRequest(plan.explicit, text) !== undefined) {
      continue;
    }
    items.push({ key: checkKey(text), text, origin: "reviewer" });
    reviewerCount++;
  }
  if (items.length === 0) {
    items.push(...plan.parents.map((check): CheckItem => ({ key: check.key, text: check.text, origin: "plan", line: check.line })));
  }
  for (const item of items) {
    item.evidence = recordedEvidenceFor(item, evidence);
    if (!item.evidence) {
      item.record = drafts[item.key];
    }
  }
  const recorded = items.filter((item) => item.evidence);
  const required = items.filter((item) => !item.evidence);
  return {
    parents: plan.parents,
    explicitCount: plan.explicit.length,
    reviewerCount,
    recorded,
    required,
    progress: progressText(items),
    ready: items.length > 0 && required.every((item) => item.record?.outcome !== undefined),
  };
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
}

/**
 * The prose entry for `## Human evidence`: one line per check with a
 * recorded outcome, the check's own wording quoted (reviewer checks
 * marked as such), the note beneath it. Checks without an outcome are not
 * mentioned (nothing is claimed about them). The date is the only thing
 * added that the user did not type.
 */
export function renderHumanEvidence(checks: RecordedCheck[], date: Date, planName?: string): string | undefined {
  const recorded = checks.filter((check) => check.record.outcome);
  if (recorded.length === 0) {
    return undefined;
  }
  const day = date.toISOString().slice(0, 10);
  const lines = [`${day} — manual verification recorded in VS Code${planName ? ` against the plan checks of ${planName}` : ""}:`, ""];
  for (const check of recorded) {
    lines.push(`- ${OUTCOME_WORDS[check.record.outcome as CheckOutcome]} — ${check.text}${check.origin === "reviewer" ? " · reviewer request" : ""}`);
    if (check.record.note?.trim()) {
      for (const noteLine of check.record.note.trim().split(/\r?\n/)) {
        lines.push(`  ${noteLine}`);
      }
    }
  }
  return lines.join("\n");
}

/** The checks Submit evidence will write: outstanding checks with a drafted outcome. */
export function submittableChecks(view: VerificationView): RecordedCheck[] {
  const out: RecordedCheck[] = [];
  for (const item of view.required) {
    if (item.record?.outcome) {
      out.push({ text: item.text, origin: item.origin, record: item.record });
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

/**
 * The same entry inside a stage's `handoff.md`, at the end of its existing
 * `## Human evidence` section (handoff.py renders that section from notes.md
 * in the middle of the document, so appending at the end of the file would
 * file the entry under whatever section comes last). Without such a section
 * the heading and entry are appended at the end, which is where handoff.py
 * puts a first one relative to the sections that follow it.
 *
 * Why write handoff.md at all: the sparring prompt shows the reviewer the
 * stage brief, the project context and `handoff.md` verbatim
 * (sparring_prompt.py), and the engine only folds notes.md's human evidence
 * into the handoff when the *stage agent* regenerates it. Sending evidence
 * to the reviewer without running the stage agent therefore means putting it
 * where the reviewer actually reads, in the engine's own section and shape.
 * The next handoff the engine generates replaces the file wholesale from
 * notes.md, which holds the same entry.
 */
export function insertHandoffEvidence(handoff: string, entry: string): string {
  const lines = handoff.replace(/\n+$/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === HUMAN_EVIDENCE_HEADING);
  if (start < 0) {
    return `${lines.join("\n")}\n\n${HUMAN_EVIDENCE_HEADING}\n\n${entry.trim()}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,2}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, end);
  while (before.length > 0 && !before[before.length - 1].trim()) {
    before.pop();
  }
  return `${[...before, "", entry.trim(), "", ...lines.slice(end)].join("\n").replace(/\n+$/, "")}\n`;
}
