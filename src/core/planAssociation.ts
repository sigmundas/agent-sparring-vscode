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
  /** `3`, `3C` (normalised to upper case), or undefined for a plain `##` heading. */
  label?: string;
  /** For `## Stage 3C — Cloud schema` the part after the dash; otherwise the heading text without its `(Stage 3C)` marker. */
  title: string;
  /** 1-based line number in the document, for revealing it. */
  line: number;
  /** `Stage 3C — Cloud schema`, or the heading's own text for mentions and plain headings. */
  display: string;
  /**
   * `definition`: the heading *is* the stage (`## Stage 3C — …`);
   * `mention`: the heading names a stage in passing (`## Reviewer handoff (Stage 3B)`);
   * `plain`: no stage label at all.
   */
  form: "definition" | "mention" | "plain";
  /** The heading reads as a record of what happened (handoff, acceptance, a date) rather than as the stage's definition. */
  historical: boolean;
}

const HEADING_RE = /^(#{2,4})\s+(\S.*?)\s*$/;
const DEFINITION_RE = /^stage\s+(\d+[A-Za-z]?)\s*[—–:-]\s*(\S.*?)$/i;
const MARKER_RE = /\(?\bstage\s+(\d+[A-Za-z]?)\b\)?/i;
const HISTORICAL_RE = /\b(hand-?off|accepted|acceptance|candidate|status|history|historical|changelog)\b|\b\d{4}-\d{2}-\d{2}\b/i;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Headings in document order, levels `##`–`####`. When any heading carries
 * a stage label (`## Stage 3C — …`, or a `(Stage 3B)` marker anywhere in
 * the text) only labelled headings are returned; otherwise every `##`
 * heading, so an arbitrary Markdown plan still yields navigable sections.
 * Document order is kept for revealing lines, never for workflow order:
 * see buildStageIndex. Fenced code is skipped.
 */
export function parsePlanHeadings(markdown: string): PlanHeading[] {
  const labelled: PlanHeading[] = [];
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
    const heading = HEADING_RE.exec(line);
    if (!heading) {
      continue;
    }
    const text = heading[2];
    const historical = HISTORICAL_RE.test(text);
    const definition = DEFINITION_RE.exec(text);
    if (definition) {
      const label = definition[1].toUpperCase();
      labelled.push({ label, title: definition[2], line: index + 1, display: `Stage ${label} — ${definition[2]}`, form: "definition", historical });
      continue;
    }
    const marker = MARKER_RE.exec(text);
    if (marker) {
      const label = marker[1].toUpperCase();
      const title = text.replace(MARKER_RE, "").replace(/\s{2,}/g, " ").replace(/\s+([—–:-])\s*$/, "").trim() || text;
      labelled.push({ label, title, line: index + 1, display: text, form: "mention", historical });
      continue;
    }
    if (heading[1].length === 2) {
      plain.push({ title: text, line: index + 1, display: text, form: "plain", historical });
    }
  }
  return labelled.length > 0 ? labelled : plain;
}

// ---------------------------------------------------------------- stage index (workflow order)

/**
 * One logical stage of the plan: every heading that carries its label,
 * collapsed. `canonical` is the heading that defines the stage, chosen
 * only when the choice is clear: among non-historical headings, the single
 * `## Stage <label> — …` definition, else the single non-historical one.
 * A stage mentioned only historically has no canonical section; one with
 * several plausible definitions is `ambiguous` and gets none either.
 */
export interface StageEntry {
  label: string;
  /** The canonical section's title, when there is one. */
  title?: string;
  /** `Stage 3C — Cloud schema`, or just `Stage 3C` without a canonical section. */
  display: string;
  canonical?: PlanHeading;
  /** All headings carrying this label, in document order. */
  occurrences: PlanHeading[];
  ambiguous: boolean;
}

/** Split `3B` into its numeric and letter parts; undefined for labels that are not of that shape. */
function parseLabel(label: string): { number: number; suffix: string } | undefined {
  const match = /^(\d+)([A-Za-z]?)$/.exec(label);
  return match ? { number: Number(match[1]), suffix: match[2].toUpperCase() } : undefined;
}

/** Workflow order of stage labels: 1 < 2 < 3 < 3A < 3B < 3C < 4. Unparsable labels sort last, alphabetically. */
export function compareStageLabels(a: string, b: string): number {
  const pa = parseLabel(a);
  const pb = parseLabel(b);
  if (pa && pb) {
    if (pa.number !== pb.number) {
      return pa.number - pb.number;
    }
    return pa.suffix < pb.suffix ? -1 : pa.suffix > pb.suffix ? 1 : 0;
  }
  if (pa) {
    return -1;
  }
  if (pb) {
    return 1;
  }
  return a.localeCompare(b);
}

/** The plan's logical stages in workflow (label) order, built from labelled headings only. */
export function buildStageIndex(headings: PlanHeading[]): StageEntry[] {
  const groups = new Map<string, PlanHeading[]>();
  for (const heading of headings) {
    if (heading.label === undefined) {
      continue;
    }
    const list = groups.get(heading.label) ?? [];
    list.push(heading);
    groups.set(heading.label, list);
  }
  const entries: StageEntry[] = [];
  for (const [label, occurrences] of groups) {
    const prospective = occurrences.filter((heading) => !heading.historical);
    const definitions = prospective.filter((heading) => heading.form === "definition");
    let canonical: PlanHeading | undefined;
    let ambiguous = false;
    if (definitions.length === 1) {
      canonical = definitions[0];
    } else if (definitions.length === 0 && prospective.length === 1) {
      canonical = prospective[0];
    } else if (prospective.length > 1) {
      ambiguous = true;
    }
    entries.push({ label, title: canonical?.title, display: canonical ? `Stage ${label} — ${canonical.title}` : `Stage ${label}`, canonical, occurrences, ambiguous });
  }
  return entries.sort((a, b) => compareStageLabels(a.label, b.label));
}

export function stageEntryFor(index: StageEntry[], label: string | undefined): StageEntry | undefined {
  return label === undefined ? undefined : index.find((entry) => entry.label === label.toUpperCase());
}

/** The stage whose label follows `label` in workflow order: `found`, `last` (none later) or `unknown` (the label is not in the plan). */
export function nextStageAfter(index: StageEntry[], label: string | undefined): { state: "found"; next: StageEntry } | { state: "last" } | { state: "unknown" } {
  const current = stageEntryFor(index, label);
  if (!current) {
    return { state: "unknown" };
  }
  const later = index.filter((entry) => compareStageLabels(entry.label, current.label) > 0);
  return later.length > 0 ? { state: "found", next: later[0] } : { state: "last" };
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

/**
 * Where a stage sits in an associated plan. `current` is the heading that
 * was matched (revealed by Open in plan); `stage` is the logical stage it
 * belongs to, with the canonical section's title when the plan defines
 * one; `next` follows from stage *labels* in workflow order, never from
 * the heading that happens to come next in the file.
 */
export interface PlanPosition {
  current: PlanHeading;
  /** The logical stage of `current`; undefined for a plain, unlabelled heading. */
  stage?: StageEntry;
  /** Display for the current stage: the canonical `Stage 3B — title`, else the matched heading's own text. */
  display: string;
  next: { state: "found"; stage: StageEntry } | { state: "last" } | { state: "unlabelled" };
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

/**
 * The heading a stored match refers to: by label when the plan has that
 * stage (whichever of its headings the user picked, the stage is the same),
 * else by exact title (a renumbered plan), and only when that is unique.
 */
export function findHeading(headings: PlanHeading[], ref: HeadingRef): number {
  if (ref.label) {
    const entry = stageEntryFor(buildStageIndex(headings), ref.label);
    if (entry) {
      return headings.indexOf(entry.canonical ?? entry.occurrences[0]);
    }
  }
  const wantTitle = ref.title.trim().toLowerCase();
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
 *     title/first lines (`# Stage 3B — …`), when the plan has that stage;
 *  4. the display title, when it slugifies to exactly one heading title.
 *
 * Two headings matching, or none, at every layer yields undefined: no guess.
 */
export function locateStage(headings: PlanHeading[], identity: string | StageIdentity): PlanPosition | undefined {
  const who: StageIdentity = typeof identity === "string" ? { stageId: identity } : identity;
  const index = buildStageIndex(headings);
  if (who.manual) {
    const at = findHeading(headings, who.manual);
    if (at >= 0) {
      return position(headings, index, at, "manual");
    }
  }
  const idSlug = slugify(humanizeStageId(who.stageId));
  const bare = slugify(who.stageId.replace(/^stage-(?:\d+[a-z]?-)?/i, ""));
  const byId = unique(headings, (heading) => {
    const slug = slugify(heading.title);
    return slug.length > 0 && (slug === idSlug || slug === bare);
  });
  if (byId !== undefined) {
    return position(headings, index, byId, "id");
  }
  const idLabel = /^stage-(\d+[a-z]?)-/i.exec(who.stageId)?.[1];
  const byIdLabel = stageEntryFor(index, idLabel);
  if (byIdLabel) {
    return position(headings, index, headings.indexOf(byIdLabel.canonical ?? byIdLabel.occurrences[0]), "label");
  }
  const markers = who.briefText ? parseBriefStageMarkers(who.briefText) : undefined;
  const byBrief = stageEntryFor(index, markers?.current);
  if (byBrief) {
    return position(headings, index, headings.indexOf(byBrief.canonical ?? byBrief.occurrences[0]), "brief");
  }
  if (who.title) {
    const titleSlug = slugify(who.title);
    const byTitle = unique(headings, (heading) => {
      const slug = slugify(heading.title);
      return slug.length > 0 && slug === titleSlug;
    });
    if (byTitle !== undefined) {
      return position(headings, index, byTitle, "title");
    }
  }
  return undefined;
}

function position(headings: PlanHeading[], index: StageEntry[], at: number, source: MatchSource): PlanPosition {
  const current = headings[at];
  const stage = stageEntryFor(index, current.label);
  const after = nextStageAfter(index, current.label);
  return {
    current,
    stage,
    // The canonical title when the plan defines the stage once; a bare
    // `Stage 3B` when it defines it several times (no title is claimed);
    // the heading's own text when the plan only mentions the stage.
    display: stage?.canonical || stage?.ambiguous ? stage.display : current.display,
    next: after.state === "found" ? { state: "found", stage: after.next } : after.state === "last" ? { state: "last" } : { state: "unlabelled" },
    source,
  };
}

function unique(headings: PlanHeading[], predicate: (heading: PlanHeading) => boolean): number | undefined {
  const matches = headings.map((heading, index) => ({ heading, index })).filter(({ heading }) => predicate(heading));
  return matches.length === 1 ? matches[0].index : undefined;
}

/**
 * Stages of the plan that the stage's brief mentions as later work
 * (`Stage 3C — …`, `Stage 4`), in workflow order. Display context only:
 * the brief describes intent, the plan is the document.
 */
export function briefMentionedStages(index: StageEntry[], briefText: string | undefined): StageEntry[] {
  if (!briefText) {
    return [];
  }
  const wanted = new Set(parseBriefStageMarkers(briefText).mentioned.map((label) => label.toUpperCase()));
  return index.filter((entry) => wanted.has(entry.label));
}
