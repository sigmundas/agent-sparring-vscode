/**
 * What Run Plan does first with the document a person chose: classify it,
 * before anything about a branch or a workspace is asked.
 *
 * A branch is only a question for a plan the engine would run, so the
 * engine's own `sparring check-plan --json` — which reads a plan exactly as
 * run-plan would and records nothing — decides whether it is runnable. The
 * extension's heading probe (`## Stage` headings, `stageHeadings`) never
 * decides that; it only tells a document with no stage sections at all
 * (planning input, for Make Plan…) from a staged plan the engine refused
 * (invalid, shown with the engine's reason).
 */

export type PlanClassification =
  /** check-plan read it as a plan (or could not be asked and it has stage sections; the engine still validates at start). */
  | { kind: "runnable" }
  /** No `## Stage <n>` sections: input for Make Plan…, not something to run. */
  | { kind: "planning-input"; reason: string }
  /** Stage sections the engine refused: its reason, verbatim. */
  | { kind: "invalid"; reason: string }
  /** The file could not be read. */
  | { kind: "unreadable"; reason: string };

/** `check-plan --json`'s answer, when the engine could be asked at all. */
export interface CheckPlanAnswer {
  exitCode: number;
  stdout: string;
}

const NO_STAGES = "The document has no '## Stage <n> — <title>' sections.";

/**
 * `stageHeadings` is the number of `## Stage` headings the file has, or
 * undefined when it could not be read. `check` is undefined when the engine
 * could not be asked (a shell-only executable, or a failed spawn).
 */
export function classifyPlanDocument(stageHeadings: number | undefined, check: CheckPlanAnswer | undefined): PlanClassification {
  if (stageHeadings === undefined) {
    return { kind: "unreadable", reason: "The plan document could not be read." };
  }
  const answer = check ? parseCheckPlan(check.stdout) : undefined;
  if (answer?.valid) {
    return { kind: "runnable" };
  }
  if (stageHeadings === 0) {
    return { kind: "planning-input", reason: answer?.error || NO_STAGES };
  }
  if (answer) {
    return { kind: "invalid", reason: answer.error || "check-plan refused the plan without saying why." };
  }
  // No answer this version reads (an engine without check-plan): the engine
  // validates the plan itself when the run starts.
  return { kind: "runnable" };
}

function parseCheckPlan(stdout: string): { valid: boolean; error?: string } | undefined {
  try {
    const raw: unknown = JSON.parse(stdout);
    if (typeof raw !== "object" || raw === null || typeof (raw as { valid?: unknown }).valid !== "boolean") {
      return undefined;
    }
    const { valid, error } = raw as { valid: boolean; error?: unknown };
    return { valid, ...(typeof error === "string" && error ? { error } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * The feature-branch prompt for a new run in this checkout. The checked-out
 * branch is named as context and never filled in: it may be a protected
 * branch (the engine's policy, not repeated here), and a field labelled
 * "Feature branch" must not offer one to confirm with Enter. Whatever is
 * typed still goes to the engine, whose branch guard decides.
 */
export function featureBranchPrompt(current: string | undefined): { value: string; prompt: string; placeholder: string } {
  const where = current ? `Checked out now: ${current}. ` : "";
  return {
    value: "",
    prompt: `${where}Name the feature branch this plan runs on. If it does not exist, Agent Sparring creates it from the current commit. The engine refuses a protected branch such as main.`,
    placeholder: "feature/…",
  };
}
