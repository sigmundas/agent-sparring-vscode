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
