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
 * Heading parsing is deliberately lenient (any `## Stage <label> — <title>`
 * heading, labels like `3C` included; otherwise every `##` heading), unlike
 * the engine mirror in engineFormats.ts, because an associated plan is not
 * required to be a plan the engine could run.
 *
 * No dependency on the vscode API.
 */

import { slugify } from "./engineFormats";
import { humanizeStageId } from "./presentation";

/** workspaceState entry: run id → absolute path of the associated Markdown file. */
export type PlanAssociations = Record<string, string>;

export const PLAN_ASSOCIATIONS_KEY = "agentSparring.planAssociations";

export function associatedPlanFor(associations: PlanAssociations | undefined, runId: string): string | undefined {
  const value = associations?.[runId];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function withAssociation(associations: PlanAssociations | undefined, runId: string, planPath: string | undefined): PlanAssociations {
  const next: PlanAssociations = { ...(associations ?? {}) };
  if (planPath) {
    next[runId] = planPath;
  } else {
    delete next[runId];
  }
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

const STAGE_HEADING_RE = /^##\s+stage\s+([A-Za-z0-9.]+)\s*[—–:-]\s*(\S.*?)\s*$/i;
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

// ---------------------------------------------------------------- matching

export interface PlanPosition {
  /** Index into the headings of the one that describes this stage. */
  index: number;
  current: PlanHeading;
  next?: PlanHeading;
  previous?: PlanHeading;
}

/**
 * Which heading describes `stageId`, only when the match is unambiguous:
 * the heading's slug equals the stage id's slug once the `stage-` /
 * `stage-<n>-` prefix is removed, or the humanized id equals the title.
 * Two headings matching, or none, yields undefined: no guess.
 */
export function locateStage(headings: PlanHeading[], stageId: string): PlanPosition | undefined {
  const idSlug = slugify(humanizeStageId(stageId));
  const bare = slugify(stageId.replace(/^stage-(?:\d+-)?/i, ""));
  const matches = headings
    .map((heading, index) => ({ heading, index }))
    .filter(({ heading }) => {
      const slug = slugify(heading.title);
      return slug.length > 0 && (slug === idSlug || slug === bare);
    });
  if (matches.length !== 1) {
    return undefined;
  }
  const { index } = matches[0];
  return { index, current: headings[index], next: headings[index + 1], previous: headings[index - 1] };
}
