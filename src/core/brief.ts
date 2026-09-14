/**
 * Display-only extraction from a stage's brief.md: the short Goal shown in
 * the Run Overview. brief.md stays authoritative and nothing decides a
 * workflow step from what is parsed here.
 *
 * No dependency on the vscode API.
 */

export const GOAL_MAX_LENGTH = 240;

const GOAL_HEADING_RE = /^#{1,6}\s+goal\s*$/i;
const ANY_HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * The first non-empty paragraph beneath a `## Goal` heading (any heading
 * level, case-insensitive), whitespace-collapsed and clamped. Returns
 * undefined when the heading is missing, empty or immediately followed by
 * another heading, or when the input is not usable text.
 */
export function parseBriefGoal(markdown: string | undefined | null, maxLength = GOAL_MAX_LENGTH): string | undefined {
  if (typeof markdown !== "string" || !markdown.trim()) {
    return undefined;
  }
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    if (FENCE_RE.test(lines[index])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && GOAL_HEADING_RE.test(lines[index].trim())) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  const paragraph: string[] = [];
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (ANY_HEADING_RE.test(line)) {
      break;
    }
    if (FENCE_RE.test(line)) {
      break; // a code block is not a goal sentence
    }
    if (!line.trim()) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line.trim());
  }
  if (paragraph.length === 0) {
    return undefined;
  }
  const text = paragraph
    .join(" ")
    .replace(/^[-*>]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : text;
}

/**
 * The brief's own opening description, for a brief that has no `## Goal`.
 *
 * A generated brief (nextStage.ts: renderNextStageBrief) is a title line, one
 * sentence of provenance ("Stage 3D from plan `…`. Implement only this
 * section…"), then the plan's section verbatim — so the paragraph worth
 * showing is the one under the *embedded section's* heading, not the
 * provenance line. Falling back through: the first paragraph after a second
 * heading, else the first paragraph after the first heading, else the first
 * paragraph at all. Lists, tables and fenced code are never a description.
 *
 * Display only, like the Goal it stands in for. Undefined when the brief has
 * no prose paragraph — and then the Overview says nothing rather than
 * complaining about the Markdown, which is a diagnostic, not something a
 * person reading a stage needs.
 */
export function parseBriefOpening(markdown: string | undefined | null, maxLength = GOAL_MAX_LENGTH): string | undefined {
  if (typeof markdown !== "string" || !markdown.trim()) {
    return undefined;
  }
  const paragraphs: { text: string; headings: number }[] = [];
  let headings = 0;
  let inFence = false;
  let current: string[] = [];
  const flush = () => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    if (text) {
      paragraphs.push({ text, headings });
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) {
      continue;
    }
    if (ANY_HEADING_RE.test(line)) {
      flush();
      headings++;
      continue;
    }
    if (!line.trim() || /^\s*(?:[-*+>|]|\d+[.)])\s/.test(line)) {
      flush(); // a blank line, a list item or a table row ends the paragraph
      continue;
    }
    current.push(line.trim());
  }
  flush();
  const chosen = paragraphs.find((entry) => entry.headings >= 2) ?? paragraphs.find((entry) => entry.headings >= 1) ?? paragraphs[0];
  if (!chosen) {
    return undefined;
  }
  return chosen.text.length > maxLength ? `${chosen.text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : chosen.text;
}

// ---------------------------------------------------------------- stage markers

export interface BriefStageMarkers {
  /**
   * The label the brief gives *this* stage: the `Stage <label>` in its
   * first heading, or failing that an opening line (before any further
   * heading) that *starts* with `Stage <label>`. Prose that merely mentions
   * a stage never counts. Undefined when the brief names none there.
   */
  current?: string;
  /** Every other `Stage <label>` the brief mentions (deferred work, follow-ups), in order, unique. */
  mentioned: string[];
}

const STAGE_MARKER_RE = /\bstage\s+(\d+[a-z]?)\b/gi;
const LEADING_MARKER_RE = /^\s*[*_]*stage\s+(\d+[a-z]?)\b/i;
const HEADING_RE = /^#{1,6}\s+(\S.*?)\s*$/;
/** How many opening lines may name the current stage when the first heading does not. */
const OPENING_LINES = 5;

/**
 * `Stage 3B` style markers in a brief. Display context and a matching
 * hint only: a brief describes intent, and nothing here decides engine
 * state. Fenced code is skipped.
 */
export function parseBriefStageMarkers(markdown: string | undefined | null): BriefStageMarkers {
  const markers: BriefStageMarkers = { mentioned: [] };
  if (typeof markdown !== "string" || !markdown.trim()) {
    return markers;
  }
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let headingsSeen = 0;
  let opening = 0;
  const seen = new Set<string>();
  const remember = (label: string) => {
    const key = label.toUpperCase();
    if (key !== markers.current?.toUpperCase() && !seen.has(key)) {
      seen.add(key);
      markers.mentioned.push(key);
    }
  };
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.trim()) {
      continue;
    }
    const heading = HEADING_RE.exec(line);
    const labels = [...line.matchAll(STAGE_MARKER_RE)].map((match) => match[1].toUpperCase());
    if (heading) {
      headingsSeen++;
    } else if (headingsSeen <= 1) {
      opening++;
    }
    const inFirstHeading = heading !== null && headingsSeen === 1;
    const leadsOpeningLine = heading === null && headingsSeen <= 1 && opening <= OPENING_LINES && LEADING_MARKER_RE.test(line);
    const mayNameCurrent = markers.current === undefined && (inFirstHeading || leadsOpeningLine);
    for (const label of labels) {
      if (mayNameCurrent && markers.current === undefined) {
        markers.current = label;
      } else {
        remember(label);
      }
    }
  }
  markers.mentioned = markers.mentioned.filter((label) => label !== markers.current);
  return markers;
}
