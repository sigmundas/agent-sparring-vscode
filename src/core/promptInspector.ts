/**
 * What an actor was actually told, read from the engine's captured prompts.
 *
 * The engine writes every turn's exact provider-facing prompt into the
 * stage's `prompts/` directory at the moment it hands it to the provider,
 * and appends one `index.jsonl` line describing it (see the engine's
 * `prompt_capture` module). This module turns those two files into the view
 * the actor cards show.
 *
 * Two things it deliberately does not do.
 *
 * **It does not re-parse the prompt.** Each section's character span comes
 * from the engine, so a section's text is a slice of the captured bytes.
 * Splitting the prompt on `##` headings here would be a second, divergent
 * idea of what the sections are — and the prompt's own content contains
 * Markdown headings, so it would also be wrong.
 *
 * **It does not re-derive the turn kind.** Whether a turn was an original,
 * a correction, a review of a human's evidence or a bounded commit turn is
 * something only the engine knew when it built the prompt; some of it is
 * not recoverable from anything on disk afterwards. It is read, never
 * guessed.
 *
 * Pure: no vscode API, no filesystem access. The caller supplies the texts.
 */

/**
 * Roles, as the engine names them in the index.
 *
 * `reviewer` is the independent reviewer of a review-only stage, and it is
 * its own role rather than a `sparrer` because the two are not the same
 * actor: a sparrer reviews one stage agent's work with that agent still
 * behind it, and a reviewer reviews a candidate set that is already accepted
 * with no implementation agent behind it at all. Showing one as the other
 * would describe a pairing that does not exist for that stage — which is
 * precisely the thing someone opens this view to check.
 */
export type CaptureRole = "stage" | "sparrer" | "reviewer";

/** Where a section's content came from, as the engine recorded it. */
export type SectionOrigin = "file" | "engine";

export interface CaptureSection {
  heading: string;
  origin: SectionOrigin;
  /** Path relative to the project's `.sparring` directory; absent for engine-authored text. */
  source?: string;
  start: number;
  end: number;
}

/** One `index.jsonl` line: a captured turn. */
export interface CaptureEntry {
  seq: number;
  ts: string;
  role: CaptureRole;
  stageId: string;
  turnKind: string;
  resumed: boolean;
  expectedBranch?: string;
  /** Filename of the captured prompt inside `prompts/`. */
  file: string;
  /** Length of the captured prompt, used to detect a file that no longer matches its index line. */
  chars: number;
  sections: CaptureSection[];
}

/** The directory the engine captures prompts into, inside a stage directory. */
export const PROMPTS_DIRNAME = "prompts";
export const PROMPT_INDEX_FILENAME = "index.jsonl";

/**
 * Parse `index.jsonl`, skipping anything malformed.
 *
 * Tolerant on purpose: the index is derived data the engine can rewrite at
 * any time, and one unreadable line must not hide every other captured
 * turn. A line that cannot be understood is dropped, never guessed at.
 */
export function parseCaptureIndex(text: string | undefined): CaptureEntry[] {
  if (!text) {
    return [];
  }
  const entries: CaptureEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = toEntry(raw);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function toEntry(raw: unknown): CaptureEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const role = value.role;
  if (role !== "stage" && role !== "sparrer" && role !== "reviewer") {
    return undefined;
  }
  if (typeof value.file !== "string" || typeof value.seq !== "number") {
    return undefined;
  }
  return {
    seq: value.seq,
    ts: typeof value.ts === "string" ? value.ts : "",
    role,
    stageId: typeof value.stageId === "string" ? value.stageId : String(value.stage_id ?? ""),
    turnKind: typeof value.turn_kind === "string" ? value.turn_kind : "",
    resumed: value.resumed === true,
    expectedBranch: typeof value.expected_branch === "string" ? value.expected_branch : undefined,
    file: value.file,
    chars: typeof value.chars === "number" ? value.chars : -1,
    sections: toSections(value.sections),
  };
}

function toSections(raw: unknown): CaptureSection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const sections: CaptureSection[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const value = item as Record<string, unknown>;
    const origin = value.origin === "file" ? "file" : "engine";
    if (typeof value.start !== "number" || typeof value.end !== "number") {
      continue;
    }
    sections.push({
      heading: typeof value.heading === "string" ? value.heading : "",
      origin,
      source: typeof value.source === "string" ? value.source : undefined,
      start: value.start,
      end: value.end,
    });
  }
  return sections;
}

/** The most recently captured turn for one role, or undefined if there is none. */
export function latestCapture(entries: CaptureEntry[], role: CaptureRole): CaptureEntry | undefined {
  let latest: CaptureEntry | undefined;
  for (const entry of entries) {
    if (entry.role === role && (latest === undefined || entry.seq > latest.seq)) {
      latest = entry;
    }
  }
  return latest;
}

/** One section of the readable view: a slice of the captured prompt, with where it came from. */
export interface PromptViewSection {
  heading: string;
  origin: SectionOrigin;
  /** Path relative to `.sparring`, for display and for opening the file. */
  source?: string;
  text: string;
}

export interface PromptView {
  /** `Implementation turn`, `Review turn`, `Commit turn`, `Independent reviewer` — what this turn asks for. */
  turn: string;
  /** The short phrase after it: `first turn of this stage`, `correction after review`, … */
  detail: string;
  /** True while the actor is busy: this is the turn running right now, not the last one. */
  live: boolean;
  branch?: string;
  /** Empty when the index and the captured file disagree; the exact prompt is still shown. */
  sections: PromptViewSection[];
  /** The captured prompt, verbatim. */
  exact: string;
  /** Set when the sections could not be trusted, saying why in one sentence. */
  sectionsUnavailable?: string;
}

/**
 * How each turn kind is described. The engine's own vocabulary is the key;
 * an unrecognised kind falls through to showing the engine's word rather
 * than a guess, so a new turn kind degrades to "honest but plain" instead
 * of being mislabelled as something it is not.
 */
const TURN_WORDS: Record<string, { turn: string; detail: string }> = {
  "stage:original": { turn: "Implementation turn", detail: "first turn of this stage" },
  "stage:resume": { turn: "Implementation turn", detail: "correction after review" },
  "stage:finalization": { turn: "Commit turn", detail: "commit and push the reviewed work, change nothing" },
  "sparrer:original": { turn: "Review turn", detail: "first review of this candidate" },
  "sparrer:resume": { turn: "Review turn", detail: "re-review after a correction" },
  "sparrer:evidence_review": { turn: "Review turn", detail: "judging the evidence you recorded" },
  "sparrer:finalized_review": { turn: "Review turn", detail: "reviewing the committed candidate" },
  // A review-only stage. Named after the actor rather than after the turn,
  // because the fact worth seeing at a glance here is *who* is working: that
  // the active actor is a fresh independent reviewer and not the stage agent
  // this card would otherwise be showing.
  "reviewer:original": { turn: "Independent reviewer", detail: "original review of the accepted candidate set" },
  "reviewer:resume": { turn: "Independent reviewer", detail: "continuing the same review" },
  "reviewer:evidence_review": { turn: "Independent reviewer", detail: "judging the evidence you recorded" },
};

function words(role: CaptureRole, turnKind: string): { turn: string; detail: string } {
  const known = TURN_WORDS[`${role}:${turnKind}`];
  if (known) {
    return known;
  }
  const turn = role === "stage" ? "Implementation turn" : role === "reviewer" ? "Independent reviewer" : "Review turn";
  return {
    turn,
    detail: turnKind ? `engine turn kind: ${turnKind}` : "turn kind not recorded",
  };
}

/**
 * The view for one actor card.
 *
 * `live` says whether this capture is the turn running right now or the last
 * one that ran; the caller decides that from the same liveness the card's
 * Working/Waiting word already uses, so the two can never disagree.
 *
 * If the captured file's length does not match what the index recorded for
 * it, the spans cannot be trusted to address the right text, so no sections
 * are produced at all. The exact prompt is still shown — it is the file
 * itself and remains true regardless of what the index says about it.
 */
export function buildPromptView(entry: CaptureEntry, promptText: string, options: { live: boolean }): PromptView {
  const { turn, detail } = words(entry.role, entry.turnKind);
  const base: PromptView = {
    turn,
    detail,
    live: options.live,
    branch: entry.expectedBranch,
    sections: [],
    exact: promptText,
  };
  if (entry.chars >= 0 && entry.chars !== promptText.length) {
    return { ...base, sectionsUnavailable: "The captured prompt no longer matches what the engine recorded about it, so it is shown whole rather than split into sections." };
  }
  const sections: PromptViewSection[] = [];
  for (const section of entry.sections) {
    if (section.start < 0 || section.end > promptText.length || section.end < section.start) {
      return { ...base, sectionsUnavailable: "The recorded section offsets fall outside the captured prompt, so it is shown whole rather than split into sections." };
    }
    sections.push({
      heading: section.heading,
      origin: section.origin,
      source: section.source,
      text: promptText.slice(section.start, section.end),
    });
  }
  return { ...base, sections };
}
