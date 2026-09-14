/**
 * Which section of one plan each existing stage of a project is — all of
 * them at once, rather than one stage at a time.
 *
 * "Change match…" answers the question for the stage on screen. That is the
 * right shape for the common case and the wrong shape for the case that
 * actually needs answering: a *historical* stage that nothing could place.
 * Reaching for the only matching control there is means opening the panel —
 * which is showing the current stage — and remapping that one instead. The
 * mistake is silent, and it moves a stage's whole history to another section.
 *
 * So this is the plan-level view. It says, per existing stage, where it
 * lands and what is wrong with that, and the caller turns each row into a
 * fix for *that* stage.
 *
 * Why it matters beyond tidiness: an unplaced stage does not just look
 * untidy, it makes automatic continuation propose a brand-new stage for that
 * section, which would re-implement work that is already accepted.
 *
 * No dependency on the vscode API.
 */

import { buildStageIndex, locateStage, type HeadingRef, type MatchSource, type PlanHeading } from "./planAssociation";

/** One existing stage, with everything needed to place it in the plan. */
export interface StageToMatch {
  /** Run id, so the caller can record a manual match against the right stage. */
  runId: string;
  stageId: string;
  /** Display name for the row (`humanizeStageId`, or the plan title when known). */
  name: string;
  title?: string;
  briefText?: string;
  /** The user's manual match, when it was made against *this* plan. */
  manual?: HeadingRef;
}

export interface StageMatchRow extends StageToMatch {
  /** The plan label it resolves to (`3D`), or undefined when nothing placed it. */
  label?: string;
  matchedBy?: MatchSource;
  /** Why the row needs attention; absent when it is simply placed. */
  problem?: string;
}

export const UNPLACED_PROBLEM = "Nothing in the plan matched this stage unambiguously, so a managed run would create a new stage for that section instead of adopting this one.";

/**
 * Place every stage, flag the ones that need a person, and order the result
 * so the ones that do come first — then by where they sit in the plan.
 *
 * Two things count as needing a person, and both are refusals to guess:
 * nothing placed the stage, or two stages placed themselves on the same
 * section (only one of them can be that stage, and picking for the user
 * would silently orphan the other).
 */
export function stageMatchRows(headings: PlanHeading[], stages: StageToMatch[]): StageMatchRow[] {
  const order = buildStageIndex(headings).map((entry) => entry.label);
  const rows: StageMatchRow[] = stages.map((stage) => {
    const position = locateStage(headings, { stageId: stage.stageId, title: stage.title, briefText: stage.briefText, manual: stage.manual });
    const label = position?.stage?.label;
    return { ...stage, label, matchedBy: position?.source, problem: label ? undefined : UNPLACED_PROBLEM };
  });
  for (const row of rows) {
    if (row.label && rows.filter((other) => other.label === row.label).length > 1) {
      row.problem = `More than one stage resolves to Stage ${row.label}; only one of them can be that stage.`;
    }
  }
  const rank = (row: StageMatchRow) => (row.problem ? -1 : (order.indexOf(row.label ?? "") + 1 || Number.MAX_SAFE_INTEGER));
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
