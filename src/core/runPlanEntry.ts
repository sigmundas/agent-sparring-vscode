/**
 * What Run Plan does first with the document a person chose: classify it,
 * before anything about a branch or a workspace is asked.
 *
 * A branch is only a question for a plan the engine would run, so the
 * engine's own `sparring check-plan --json` — which reads a plan exactly as
 * run-plan would and records nothing — decides whether it is runnable. The
 * extension's heading probe (`## Stage` headings, `stageHeadings`) never
 * decides that; it only tells a document with no stage sections at all
 * (planning input, for Prepare intake or Make Plan…) from a staged plan the
 * engine refused (invalid, shown with the engine's reason). When the engine
 * cannot be asked or its answer cannot be read, nothing proceeds.
 */

export type PlanClassification =
  /** check-plan read it as a plan — the Markdown itself, or the execution manifest built from it. */
  | { kind: "runnable" }
  /** No `## Stage <n>` sections: input for Prepare intake or Make Plan…, not something to run. */
  | { kind: "planning-input"; reason: string }
  /** Stage sections the engine refused: its reason, verbatim. */
  | { kind: "invalid"; reason: string }
  /** The engine could not classify it (unavailable, no check-plan, unreadable answer): nothing is asked or run. */
  | { kind: "unclassified"; reason: string }
  /** The file could not be read. */
  | { kind: "unreadable"; reason: string };

/** One `check-plan --json` query: the engine's answer, or why it could not be asked. */
export type CheckPlanQuery = { ok: true; exitCode: number; stdout: string } | { ok: false; reason: string };

const NO_STAGES = "The document has no '## Stage <n> — <title>' sections.";

type CheckPlanReading = { valid: true } | { valid: false; error: string } | { failed: string };

/**
 * check-plan's answer as its contract states it: exit 0 with `valid: true`,
 * or exit 1 with `valid: false` and an error. Anything else — no answer, a
 * usage error from an engine without check-plan, output that is not that
 * JSON, or a status that contradicts its exit code — is a failure to
 * classify, with the reason kept for the person.
 */
export function readCheckPlan(query: CheckPlanQuery): CheckPlanReading {
  if (!query.ok) {
    return { failed: `check-plan could not be run: ${query.reason}` };
  }
  if (query.exitCode !== 0 && query.exitCode !== 1) {
    // Outside the contract (a usage error, a crash), whatever it printed.
    const said = query.stdout.trim().split("\n")[0]?.slice(0, 300) ?? "";
    const what = query.exitCode === 2 ? "the installed engine does not accept check-plan --json (usage error, exit 2)" : `check-plan exited ${query.exitCode}, which is neither a plan (0) nor a refusal (1)`;
    return { failed: said ? `${what}: ${said}` : `${what}.` };
  }
  const parsed = parseCheckPlan(query.stdout);
  if (!parsed) {
    const said = query.stdout.trim().split("\n")[0]?.slice(0, 300) ?? "";
    const what = `check-plan exited ${query.exitCode} without a JSON answer`;
    return { failed: said ? `${what}: ${said}` : `${what}.` };
  }
  if (parsed.valid !== (query.exitCode === 0)) {
    return { failed: `check-plan answered valid: ${parsed.valid} with exit code ${query.exitCode}, which contradict each other.` };
  }
  return parsed.valid ? { valid: true } : { valid: false, error: parsed.error || "check-plan refused the plan without saying why." };
}

/**
 * `stageHeadings` is the number of `## Stage` headings outside fenced blocks
 * ({@link countStageHeadings}), or undefined when the file could not be read.
 * `markdown` is check-plan over the document. `manifest`, when given, is
 * check-plan `--manifest` over the execution manifest the extension would
 * run instead: a Markdown refusal does not make a plan unrunnable when the
 * input actually executed is accepted.
 */
export function classifyPlanDocument(stageHeadings: number | undefined, markdown: CheckPlanQuery | undefined, manifest?: CheckPlanQuery): PlanClassification {
  if (stageHeadings === undefined) {
    return { kind: "unreadable", reason: "The plan document could not be read." };
  }
  if (!markdown) {
    return { kind: "unclassified", reason: "check-plan was not asked." };
  }
  const answer = readCheckPlan(markdown);
  if ("failed" in answer) {
    return { kind: "unclassified", reason: answer.failed };
  }
  if (answer.valid) {
    return { kind: "runnable" };
  }
  if (stageHeadings === 0) {
    return { kind: "planning-input", reason: answer.error || NO_STAGES };
  }
  if (manifest) {
    const built = readCheckPlan(manifest);
    if ("failed" in built) {
      return { kind: "unclassified", reason: built.failed };
    }
    if (built.valid) {
      return { kind: "runnable" };
    }
  }
  return { kind: "invalid", reason: answer.error };
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
 * `## Stage` headings outside fenced code blocks — presentation only, to
 * tell planning input from a staged plan the engine refused. An example
 * plan inside a ``` or ~~~ fence is not a section of this document.
 */
export function countStageHeadings(text: string): number {
  let fence: { char: string; length: number } | undefined;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      }
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    if (/^##\s+stage\b/i.test(line)) {
      count += 1;
    }
  }
  return count;
}

/**
 * The neutral repository view after Run Plan was closed. It names the
 * repository of the document that was closed, and holds while navigation
 * stays where it was at Close: the same stored selection and the same
 * followed repository. Comparing against the followed repository *at Close*
 * — not against the closed document's repository, which may differ when the
 * picker chose another — is what keeps it from ending the moment it starts.
 */
export interface RunPlanClosed {
  repoRoot: string;
  followedAtClose: string | undefined;
  selectionEpoch: string;
}

export function runPlanClosedHolds(closed: RunPlanClosed, now: { followed: string | undefined; selectionEpoch: string }, same: (a: string, b: string) => boolean): boolean {
  if (closed.selectionEpoch !== now.selectionEpoch) {
    return false;
  }
  if (closed.followedAtClose === undefined || now.followed === undefined) {
    return closed.followedAtClose === now.followed;
  }
  return same(closed.followedAtClose, now.followed);
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
