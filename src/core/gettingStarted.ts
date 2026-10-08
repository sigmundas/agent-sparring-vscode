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

/** Make Plan…'s tooltip: what it does and what it does not. */
export const MAKE_PLAN_TITLE = "Turn an idea, INBOX or notes into a staged plan with Claude or Codex. Planning only: nothing is implemented or run.";

/**
 * Planning input on Run Plan: a document with no `## Stage` sections is not
 * a dead end. The engine's start-plan intake analyzes it into runnable
 * stages; Make Plan… is an optional further planning pass, never a
 * requirement that follows from the missing headings.
 */
export const PLANNING_INPUT_TITLE = "This is planning input, ready for Agent Sparring intake.";
export const PLANNING_INPUT_LEAD = "It will be analyzed into runnable stages before anything executes.";
/** For a staged document check-plan cannot run directly (e.g. `## Stage S1`). */
export const STAGED_INTAKE_LEAD = "Its stages are read through intake rather than run directly, and nothing executes before you confirm.";
export const PREPARE_INTAKE = "Prepare intake (recommended)";
export const PREPARE_INTAKE_TITLE = "Prepare an intake with the engine's start-plan: it analyzes this document into runnable stages and asks its decisions. Nothing runs until you press Start.";
export const MAKE_PLAN_AGAIN = "Make Plan…";
export const MAKE_PLAN_AGAIN_NOTE = "Optional: run another planning/audit pass on this document first.";

/**
 * Said, not hidden: the engine's `start-plan --managed` runs only `## Stage`
 * plans today, so an intake runs in this checkout and needs a feature
 * branch there. When the engine gains managed intake runs, preparing one
 * becomes the default here and this goes away.
 */
export const MANAGED_INTAKE_LIMITATION =
  "Intake runs in this checkout for now (not yet in its own workspace), so you will be asked for a feature branch.";
