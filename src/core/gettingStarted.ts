/**
 * What a new user is told about where a plan comes from: Run Plan executes a
 * staged plan, it does not write one. One wording, used by the empty
 * Overview, the Run Plan picker and the refusal of a file that is not a plan.
 *
 * No dependency on the vscode API.
 */

/** The engine's planning skill, by the name it is invoked with in Claude Code. */
export const PLANNING_SKILL = "/agent-sparring:sparring-plan";

export const GETTING_STARTED =
  `To get started with Agent Sparring: use Make Plan… to audit the repository and turn an idea or INBOX into a staged plan with Claude or Codex and the Agent Sparring planning skill (${PLANNING_SKILL}). Run Plan only executes an existing plan.`;

export const NOT_A_PLAN_TITLE = "This looks like planning input rather than a staged plan.";

/** Make Plan…'s tooltip: what it does and what it does not. */
export const MAKE_PLAN_TITLE = "Turn an idea, INBOX or notes into a staged plan with Claude or Codex. Planning only: nothing is implemented or run.";

/** The button that turns the refused file into a plan. */
export const MAKE_PLAN_FROM_THIS = "Make Plan from this…";

/** What to do with planning input: one wording for the modal and the Overview. */
export const PLANNING_INPUT_ADVICE = "Use Make Plan… to audit the idea and create a runnable plan with Claude or Codex, review it, then return to Run Plan.";

/** The modal detail under {@link NOT_A_PLAN_TITLE}. */
export function notAPlanDetail(fileName: string): string {
  return [`${fileName} has no '## Stage <n> — <title>' sections.`, "", PLANNING_INPUT_ADVICE].join("\n");
}
