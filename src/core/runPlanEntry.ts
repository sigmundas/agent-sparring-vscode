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

/** One Markdown file the Run Plan picker considered. */
export interface PlanFileCandidate {
  file: string;
  /** Repository-relative path, `/`-separated. */
  relative: string;
  /** The file's head (at most {@link PLAN_PICKER_LIMITS.headBytes}), not necessarily all of it. */
  text: string;
  mtimeMs: number;
}

/** Bounds that keep the picker responsive in a large repository. */
export const PLAN_PICKER_LIMITS = {
  /** Markdown files listed (stat only). */
  listed: 2000,
  /** Newest files whose head is read. */
  read: 200,
  /** Bytes read from each file's head. */
  headBytes: 64 * 1024,
  /** Entries shown before Browse…. */
  shown: 50,
} as const;

/**
 * Of the listed Markdown files, the ones worth reading, in the same order
 * the picker shows ({@link planRecency}), capped at `limit`. Only paths and
 * mtimes are used, so nothing is read and nothing asks the engine.
 */
export function planCandidatesToRead<T extends { relative: string; mtimeMs: number }>(files: readonly T[], limit: number = PLAN_PICKER_LIMITS.read): T[] {
  return [...files]
    .sort((a, b) => planRecency(b) - planRecency(a) || a.relative.localeCompare(b.relative))
    .slice(0, limit);
}

/**
 * 2 under an `active` folder of a `plans` folder (wherever that sits), 1
 * under another `plans/` folder, else 0. A ranking hint only: no plan
 * directory is assumed to exist.
 */
export function planLocationRank(relative: string): number {
  const dirs = relative.split("/").slice(0, -1);
  if (dirs.some((dir, i) => dir === "plans" && dirs[i + 1] === "active")) {
    return 2;
  }
  return dirs.includes("plans") ? 1 : 0;
}

/** How much a likely plan location counts for, as if this much newer. */
const LOCATION_BONUS_MS = 6 * 60 * 60 * 1000;

/** Modification time, with a likely plan location counted a few hours newer. */
function planRecency(file: { relative: string; mtimeMs: number }): number {
  return file.mtimeMs + planLocationRank(file.relative) * LOCATION_BONUS_MS;
}

/**
 * What the Run Plan picker lists, newest first, then **Browse…** last.
 * Discovery only — a cheap local heuristic, never a runnability verdict: the
 * engine classifies whatever is chosen. Plan-like: stage-like sections
 * outside fences (`## Stage 1`, `## Stage S1`, …), or a file under a `plans`
 * directory. A likely plan location wins over a file modified within a few
 * hours of it. `now` makes the human-readable time testable.
 */
export function planPickerItems(
  candidates: readonly PlanFileCandidate[],
  now: number,
  limit: number = PLAN_PICKER_LIMITS.shown,
): { file: string; label: string; description: string; detail: string }[] {
  const plans = candidates
    .map((candidate) => ({ candidate, stages: countStageHeadings(candidate.text) }))
    .filter(({ candidate, stages }) => stages > 0 || planLocationRank(candidate.relative) > 0)
    .sort((a, b) => planRecency(b.candidate) - planRecency(a.candidate) || a.candidate.relative.localeCompare(b.candidate.relative))
    .slice(0, limit)
    .map(({ candidate, stages }) => ({
      file: candidate.file,
      label: candidate.relative.split("/").pop() ?? candidate.relative,
      description: candidate.relative,
      detail: `${stages > 0 ? `${stages} stage section${stages === 1 ? "" : "s"}` : "no stage sections (planning input)"} · modified ${modifiedAgo(candidate.mtimeMs, now)}`,
    }));
  return [...plans, { file: "", label: "$(folder-opened) Browse…", description: "choose another Markdown file", detail: "" }];
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", or a local date. */
export function modifiedAgo(mtimeMs: number, now: number): string {
  const minutes = Math.floor((now - mtimeMs) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  const d = new Date(mtimeMs);
  return `on ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One row of the feature-branch picker. `branch` undefined: name a new one. */
export interface FeatureBranchChoice {
  label: string;
  description?: string;
  detail?: string;
  branch?: string;
}

/**
 * The feature-branch picker for a run in this checkout. "New feature
 * branch…" is first, so Enter never confirms an existing branch — the one
 * checked out may be protected (the engine's policy, not repeated here).
 * The checked-out branch is the next row, one deliberate step away, then
 * other recent local branches. Whatever is chosen still goes to the engine,
 * whose branch guard decides.
 */
export function featureBranchChoices(current: string | undefined, recent: readonly string[], limit = 10): FeatureBranchChoice[] {
  const choices: FeatureBranchChoice[] = [{ label: "$(add) New feature branch…", detail: "Name a branch; if it does not exist, Agent Sparring creates it from the current commit." }];
  if (current) {
    choices.push({ label: `$(check) ${current}`, description: "checked out now", detail: "Use this branch as it is. The engine refuses a protected branch such as main.", branch: current });
  }
  for (const branch of recent.filter((name) => name && name !== current).slice(0, limit)) {
    choices.push({ label: `$(git-branch) ${branch}`, description: "local branch", branch });
  }
  return choices;
}
