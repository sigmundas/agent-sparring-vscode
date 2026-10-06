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
  `To get started with Agent Sparring: audit the repository first, then use Claude or Codex with the Agent Sparring planning skill (${PLANNING_SKILL}) to turn it into a staged plan. Run Plan only executes an existing plan.`;

export const NOT_A_PLAN_TITLE = "This file is not a runnable Agent Sparring plan.";

/** The modal detail under {@link NOT_A_PLAN_TITLE}. */
export function notAPlanDetail(fileName: string): string {
  return [
    `${fileName} has no '## Stage <n> — <title>' sections.`,
    "",
    "Recommended workflow:",
    "1. Audit the repository and the idea.",
    `2. Use Claude or Codex with the Agent Sparring planning skill (${PLANNING_SKILL}) to create/refine a staged plan.`,
    "3. Review the generated plan.",
    "4. Return here and choose Run Plan.",
  ].join("\n");
}
