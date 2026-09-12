/**
 * Plan documents for the Overview, in two clearly separate senses:
 *
 *  - a **managed plan run** is the engine's own `.sparring/plans/<key>.json`
 *    (see discovery.ts); it is authoritative about which plan and which
 *    stage index a run is at, and `resume-plan` is the supported way to
 *    continue it;
 *  - an **associated plan** is a Markdown file the user pointed the
 *    extension at for a standalone stage. It lives only in VS Code
 *    workspace state, keyed by the run id (repository + stage id), is
 *    never written into engine state, and is used for display and
 *    navigation only: the engine has no operation that continues a
 *    standalone stage from a plan, so nothing here claims one.
 *
 * Which heading of an associated plan describes the stage is decided in
 * layers, each of which must name exactly one heading or nothing: the
 * user's own manual match first (also workspace state), then conservative
 * automatic matching (stage id slug, a `Stage 3B` label carried by the id
 * or by the stage's brief, the display title). Two candidates, or a weak
 * resemblance, yield no match: the Overview then asks the user.
 *
 * Heading parsing is deliberately lenient (any `## Stage <label> — <title>`
 * heading at levels 2–4, labels like `3C` included; otherwise every `##`
 * heading), unlike the engine mirror in engineFormats.ts, because an
 * associated plan is not required to be a plan the engine could run.
 *
 * No dependency on the vscode API.
 */

import { parseBriefStageMarkers } from "./brief";
import { slugify } from "./engineFormats";
import { humanizeStageId } from "./presentation";

// ---------------------------------------------------------------- storage

/**
 * Identity of a heading inside an associated plan, as the user matched it.
 * Text, not a line number: the document may be edited above the heading.
 */
export interface HeadingRef {
  /** `3B`; absent for a plain `##` heading. */
  label?: string;
  title: string;
}

export interface PlanAssociation {
  /** Absolute path of the associated Markdown file. */
  path: string;
  /** The heading the user picked for this stage, when automatic matching was not enough. */
  match?: HeadingRef;
}

/**
 * workspaceState entry: run id → association. Older entries are the bare
 * path string; both shapes are read.
 */
export type PlanAssociations = Record<string, string | PlanAssociation>;

export const PLAN_ASSOCIATIONS_KEY = "agentSparring.planAssociations";

export function planAssociationFor(associations: PlanAssociations | undefined, runId: string): PlanAssociation | undefined {
  const value = associations?.[runId];
  if (typeof value === "string") {
    return value.trim() ? { path: value } : undefined;
  }
  if (value && typeof value === "object" && typeof value.path === "string" && value.path.trim()) {
    const match = value.match;
    const validMatch = match && typeof match === "object" && typeof match.title === "string" && match.title.trim() ? { label: typeof match.label === "string" ? match.label : undefined, title: match.title } : undefined;
    return validMatch ? { path: value.path, match: validMatch } : { path: value.path };
  }
  return undefined;
}

export function associatedPlanFor(associations: PlanAssociations | undefined, runId: string): string | undefined {
  return planAssociationFor(associations, runId)?.path;
}

/** Set, change or (with undefined) remove the association. Changing the file drops any manual match: it named a heading of the old file. */
export function withAssociation(associations: PlanAssociations | undefined, runId: string, planPath: string | undefined): PlanAssociations {
  const next: PlanAssociations = { ...(associations ?? {}) };
  if (planPath) {
    const current = planAssociationFor(associations, runId);
    next[runId] = current && current.path === planPath && current.match ? { path: planPath, match: current.match } : { path: planPath };
  } else {
    delete next[runId];
  }
  return next;
}

/** Record (or with undefined, clear) the user's manual heading match; a no-op without an association. */
export function withManualMatch(associations: PlanAssociations | undefined, runId: string, match: HeadingRef | undefined): PlanAssociations {
  const current = planAssociationFor(associations, runId);
  if (!current) {
    return { ...(associations ?? {}) };
  }
  const next: PlanAssociations = { ...(associations ?? {}) };
  next[runId] = match ? { path: current.path, match: { label: match.label, title: match.title } } : { path: current.path };
  return next;
}

// ---------------------------------------------------------------- headings

export interface PlanHeading {
  /** `3`, `3C`, or undefined for a plain `##` heading. */
  label?: string;
  title: string;
  /** 1-based line number in the document, for revealing it. */
  line: number;
  /** `Stage 3C — Cloud schema` or just the title for plain headings. */
  display: string;
}

const STAGE_HEADING_RE = /^#{2,4}\s+stage\s+([A-Za-z0-9.]+)\s*[—–:-]\s*(\S.*?)\s*$/i;
const PLAIN_HEADING_RE = /^##\s+(\S.*?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Stage headings in document order. Falls back to every `##` heading when
 * the document uses none of the `## Stage …` form, so an arbitrary
 * Markdown plan still yields navigable sections. Fenced code is skipped.
 */
export function parsePlanHeadings(markdown: string): PlanHeading[] {
  const stage: PlanHeading[] = [];
  const plain: PlanHeading[] = [];
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const asStage = STAGE_HEADING_RE.exec(line);
    if (asStage) {
      stage.push({ label: asStage[1], title: asStage[2], line: index + 1, display: `Stage ${asStage[1]} — ${asStage[2]}` });
      continue;
    }
    const asPlain = PLAIN_HEADING_RE.exec(line);
    if (asPlain) {
      plain.push({ title: asPlain[1], line: index + 1, display: asPlain[1] });
    }
  }
  return stage.length > 0 ? stage : plain;
}

/** The first `# ` heading, as a display name for the document; undefined when none. */
export function planTitle(markdown: string): string | undefined {
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = /^#\s+(\S.*?)\s*$/.exec(line);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

export const SECTION_SUMMARY_MAX_LENGTH = 200;

/**
 * The first prose paragraph under the heading at `line` (1-based), for a
 * one-line summary of what a plan section is about: display only. Lists
 * and fenced code are not summaries; a section that starts with either
 * yields undefined.
 */
export function sectionSummary(markdown: string, line: number, maxLength = SECTION_SUMMARY_MAX_LENGTH): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const paragraph: string[] = [];
  for (let index = line; index < lines.length; index++) {
    const text = lines[index];
    if (/^#{1,6}\s/.test(text) || FENCE_RE.test(text) || /^\s*([-*+]|\d+[.)])\s/.test(text) || /^\s*\|/.test(text)) {
      break;
    }
    if (!text.trim()) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(text.trim());
  }
  if (paragraph.length === 0) {
    return undefined;
  }
  const text = paragraph
    .join(" ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return undefined;
  }
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : text;
}

// ---------------------------------------------------------------- matching

export type MatchSource = "manual" | "id" | "label" | "brief" | "title";

export interface PlanPosition {
  /** Index into the headings of the one that describes this stage. */
  index: number;
  current: PlanHeading;
  next?: PlanHeading;
  previous?: PlanHeading;
  /** Which layer decided the match. */
  source: MatchSource;
}

export interface StageIdentity {
  stageId: string;
  /** The stage's display title (plan title for managed stages), when it differs from the humanized id. */
  title?: string;
  /** Contents of the stage's brief.md, when it exists; only its `Stage <label>` markers are consulted. */
  briefText?: string;
  /** The user's own match, which wins over everything automatic. */
  manual?: HeadingRef;
}

/** Headings whose label+title (or, for a stored match without label, title) equals `ref`; exact text, case-insensitive. */
export function findHeading(headings: PlanHeading[], ref: HeadingRef): number {
  const wantLabel = ref.label?.toLowerCase();
  const wantTitle = ref.title.trim().toLowerCase();
  const exact = headings.findIndex((heading) => heading.title.trim().toLowerCase() === wantTitle && (heading.label?.toLowerCase() ?? undefined) === wantLabel);
  if (exact >= 0) {
    return exact;
  }
  // The label may have been renumbered; a unique title still identifies the section.
  const byTitle = headings.map((heading, index) => ({ heading, index })).filter(({ heading }) => heading.title.trim().toLowerCase() === wantTitle);
  return byTitle.length === 1 ? byTitle[0].index : -1;
}

/**
 * Which heading describes the stage. Layers, first decisive one wins:
 *
 *  1. the user's manual match (still present in the document);
 *  2. the stage id: the heading's title slug equals the id's slug once the
 *     `stage-` / `stage-<n>-` prefix is removed, or the humanized id;
 *  3. a stage label carried by the id (`stage-3b-…`) or by the brief's own
 *     title/first lines (`# Stage 3B — …`), when exactly one heading has it;
 *  4. the display title, when it slugifies to exactly one heading title.
 *
 * Two headings matching, or none, at every layer yields undefined: no guess.
 */
export function locateStage(headings: PlanHeading[], identity: string | StageIdentity): PlanPosition | undefined {
  const who: StageIdentity = typeof identity === "string" ? { stageId: identity } : identity;
  if (who.manual) {
    const index = findHeading(headings, who.manual);
    if (index >= 0) {
      return position(headings, index, "manual");
    }
  }
  const idSlug = slugify(humanizeStageId(who.stageId));
  const bare = slugify(who.stageId.replace(/^stage-(?:\d+[a-z]?-)?/i, ""));
  const byId = unique(headings, (heading) => {
    const slug = slugify(heading.title);
    return slug.length > 0 && (slug === idSlug || slug === bare);
  });
  if (byId !== undefined) {
    return position(headings, byId, "id");
  }
  const idLabel = /^stage-(\d+[a-z]?)-/i.exec(who.stageId)?.[1];
  if (idLabel) {
    const byIdLabel = uniqueLabel(headings, idLabel);
    if (byIdLabel !== undefined) {
      return position(headings, byIdLabel, "label");
    }
  }
  const markers = who.briefText ? parseBriefStageMarkers(who.briefText) : undefined;
  if (markers?.current) {
    const byBrief = uniqueLabel(headings, markers.current);
    if (byBrief !== undefined) {
      return position(headings, byBrief, "brief");
    }
  }
  if (who.title) {
    const titleSlug = slugify(who.title);
    const byTitle = unique(headings, (heading) => {
      const slug = slugify(heading.title);
      return slug.length > 0 && slug === titleSlug;
    });
    if (byTitle !== undefined) {
      return position(headings, byTitle, "title");
    }
  }
  return undefined;
}

function position(headings: PlanHeading[], index: number, source: MatchSource): PlanPosition {
  return { index, current: headings[index], next: headings[index + 1], previous: headings[index - 1], source };
}

function unique(headings: PlanHeading[], predicate: (heading: PlanHeading) => boolean): number | undefined {
  const matches = headings.map((heading, index) => ({ heading, index })).filter(({ heading }) => predicate(heading));
  return matches.length === 1 ? matches[0].index : undefined;
}

/** Index of the single heading labelled `label` (case-insensitive); undefined when none or several. */
function uniqueLabel(headings: PlanHeading[], label: string): number | undefined {
  const want = label.toLowerCase();
  return unique(headings, (heading) => heading.label?.toLowerCase() === want);
}

/**
 * Headings of the plan that the stage's brief mentions as later work
 * (`Stage 3C — …`, `Stage 4`), in document order of the plan. Display
 * context only: the brief describes intent, the plan is the document.
 */
export function briefMentionedHeadings(headings: PlanHeading[], briefText: string | undefined, excludeIndex?: number): PlanHeading[] {
  if (!briefText) {
    return [];
  }
  const markers = parseBriefStageMarkers(briefText);
  const wanted = new Set(markers.mentioned.map((label) => label.toLowerCase()));
  return headings.filter((heading, index) => index !== excludeIndex && heading.label !== undefined && wanted.has(heading.label.toLowerCase()));
}
