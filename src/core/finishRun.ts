/**
 * Merge & clean up for a plan run in its own workspace.
 *
 * Every decision here is the engine's. Whether a run can be merged, how
 * (fast-forward or merge commit), which ignored files go with the workspace
 * and whether there is a remote all come from `finish-run --dry-run --json`;
 * the extension translates them into plain words, asks the person, and issues
 * exactly the engine command they chose. It never runs Git itself and never
 * decides that a merge or a cleanup is safe.
 *
 * The flow is written against injected effects so that what is shown and
 * what is issued can be tested without a terminal or an engine.
 */

import { buildFinishRunArgs } from "./cli";
import { EngineFormatError, parseFinishCheck, parseFinishResult, type FinishCheck, type FinishCheckItem, type FinishResult } from "./engineFormats";

/** The run to finish, as the engine's own record lists it (`runs --json`). */
export interface FinishTarget {
  /** The repository's primary checkout: where the engine finds the record and the target branch. */
  repoRoot: string;
  runKey: string;
  /** The branch the run merges into, from the record. */
  targetBranch: string;
  /** The run's own branch, from the record; technical detail only. */
  branch: string;
  planLabel: string;
}

/** One way of going ahead, each mapped to exactly one engine invocation. */
export interface FinishChoice {
  label: string;
  pushTarget: boolean;
  allowMergeCommit: boolean;
}

/** A modal question: `message` in plain words, `detail` the engine's facts, then the choices. */
export interface FinishPrompt {
  kind: "confirm" | "merge-commit";
  message: string;
  detail: string;
  choices: FinishChoice[];
}

export type FinishNotice =
  | { kind: "ineligible"; message: string; reasons: string[]; technical: string[] }
  | { kind: "error"; message: string }
  | { kind: "finished"; message: string }
  | { kind: "stopped"; message: string; stoppedAt: string; reason: string | undefined; remaining: string[] };

export interface FinishRunEffects {
  /** Run the read-only dry run, not in a terminal. Exit 0 is eligible, 3 refused; anything else failed. */
  dryRun(args: string[]): Promise<{ ok: true; exitCode: number; stdout: string } | { ok: false; reason: string }>;
  /** Ask modally; `undefined` when the person cancelled. */
  choose(prompt: FinishPrompt): Promise<FinishChoice | undefined>;
  /** Run the confirmed command through the tracked command runner. */
  run(args: string[]): Promise<{ ok: true; exitCode: number | undefined; output: string } | { ok: false; reason: string }>;
  notify(notice: FinishNotice): Promise<void> | void;
}

export type FinishOutcome =
  | { kind: "cancelled" }
  | { kind: "ineligible" }
  | { kind: "error" }
  | { kind: "finished"; result: FinishResult }
  | { kind: "stopped"; result: FinishResult | undefined };

/**
 * Check → (ask about a merge commit → check again) → confirm → finish.
 * Nothing destructive is issued unless the engine's own dry run, for the
 * exact flags about to be passed, said the run can be merged and cleaned up
 * and the person confirmed it.
 */
export async function mergeAndCleanUp(target: FinishTarget, effects: FinishRunEffects): Promise<FinishOutcome> {
  let allowMergeCommit = false;
  for (;;) {
    const checked = await dryRun(target, allowMergeCommit, effects);
    if (!checked) {
      return { kind: "error" };
    }
    if (!allowMergeCommit && needsOnlyMergeCommit(checked)) {
      const choice = await effects.choose(mergeCommitPrompt(target, checked));
      if (!choice) {
        return { kind: "cancelled" };
      }
      allowMergeCommit = true;
      continue;
    }
    if (!readyToMerge(checked)) {
      await effects.notify(ineligibleNotice(target, checked));
      return { kind: "ineligible" };
    }
    const choice = await effects.choose(confirmPrompt(target, checked, allowMergeCommit));
    if (!choice) {
      return { kind: "cancelled" };
    }
    return finish(target, choice, effects);
  }
}

/** "Ready to merge": the engine's dry run said both merge and cleanup can go ahead. Never inferred from "complete". */
export function readyToMerge(finish: FinishCheck | undefined): boolean {
  return Boolean(finish && finish.eligible.merge && finish.eligible.cleanup);
}

/** Whether the person can choose to finish with a remote push: the engine reports a remote branch it keeps. */
export function hasRemote(finish: FinishCheck): boolean {
  return finish.kept.some((item) => item.action === "keep_remote_branch");
}

async function dryRun(target: FinishTarget, allowMergeCommit: boolean, effects: FinishRunEffects): Promise<FinishCheck | undefined> {
  const answer = await effects.dryRun(buildFinishRunArgs({ repoRoot: target.repoRoot, runKey: target.runKey, dryRun: true, allowMergeCommit }));
  if (!answer.ok) {
    await effects.notify({ kind: "error", message: `Could not check whether this run can be merged: ${answer.reason}` });
    return undefined;
  }
  if (answer.exitCode !== 0 && answer.exitCode !== 3) {
    await effects.notify({ kind: "error", message: `Could not check whether this run can be merged: the engine exited ${answer.exitCode}${answer.stdout.trim() ? `: ${answer.stdout.trim().split("\n")[0]}` : "."}` });
    return undefined;
  }
  try {
    const report = parseFinishCheck(answer.stdout);
    if (report.kind === "version-mismatch") {
      await effects.notify({ kind: "error", message: `Engine/extension mismatch: finish-run reported schema_version ${JSON.stringify(report.version)}, and this extension reads only 1. Nothing was merged.` });
      return undefined;
    }
    if (report.finish.runKey !== target.runKey) {
      await effects.notify({ kind: "error", message: `The engine answered for run ${report.finish.runKey}, not ${target.runKey}. Nothing was merged.` });
      return undefined;
    }
    return report.finish;
  } catch (error) {
    const reason = error instanceof EngineFormatError ? error.message : String(error);
    await effects.notify({ kind: "error", message: `The engine's finish-run check could not be read: ${reason}` });
    return undefined;
  }
}

/** The only thing between this run and a merge is that the target moved on: a merge commit is needed. */
function needsOnlyMergeCommit(finish: FinishCheck): boolean {
  const failed = finish.checks.filter((check) => !check.ok).map((check) => check.code);
  return finish.mergeMode === "merge_commit" && failed.length === 1 && failed[0] === "target_advanced";
}

function mergeCommitPrompt(target: FinishTarget, finish: FinishCheck): FinishPrompt {
  return {
    kind: "merge-commit",
    message: `${target.targetBranch} has moved on since this run started, so it can only be merged with a merge commit.`,
    detail: [
      `This run's work cannot simply be added on top of ${target.targetBranch}. A merge commit joins the two histories instead. Nothing is merged yet: Agent Sparring checks again with a merge commit allowed, then asks you to confirm.`,
      technical(target, finish),
    ].join("\n\n"),
    choices: [{ label: "Check with a merge commit", pushTarget: false, allowMergeCommit: true }],
  };
}

function confirmPrompt(target: FinishTarget, finish: FinishCheck, allowMergeCommit: boolean): FinishPrompt {
  const into = target.targetBranch;
  const how =
    finish.mergeMode === "already_merged"
      ? `${into} already contains this run's work, so nothing is merged.`
      : finish.mergeMode === "merge_commit"
        ? `This run's work is merged into ${into} with a new merge commit, because ${into} has moved on since the run started.`
        : `${into} is moved forward to this run's last accepted commit (a fast-forward; no merge commit).`;
  const deleted = finish.deletedIgnoredPaths;
  const lines = [
    how,
    "Then the run's workspace is removed and its local branch deleted. The run's Agent Sparring records are archived first.",
    deleted.length > 0
      ? `These ignored files in the workspace are deleted with it:\n${deleted.map((item) => `  • ${item}`).join("\n")}`
      : "No ignored files are deleted with the workspace.",
  ];
  const remote = hasRemote(finish);
  if (remote) {
    lines.push(`The run's branch on the remote is kept; Agent Sparring never deletes it. ${into} is pushed only if you choose "Merge, push ${into} & clean up".`);
  }
  lines.push(technical(target, finish));
  const mergeCommit = allowMergeCommit && finish.mergeMode === "merge_commit";
  const verb = mergeCommit ? "Merge with a merge commit" : "Merge";
  const choices: FinishChoice[] = [{ label: `${verb} & clean up`, pushTarget: false, allowMergeCommit: mergeCommit }];
  if (remote) {
    choices.push({ label: `${verb}, push ${into} & clean up`, pushTarget: true, allowMergeCommit: mergeCommit });
  }
  return { kind: "confirm", message: `Merge "${target.planLabel}" into ${into} and clean up its workspace?`, detail: lines.join("\n\n"), choices };
}

function technical(target: FinishTarget, finish: FinishCheck): string {
  const rows = [`Technical details: run ${target.runKey}, branch ${target.branch} → ${target.targetBranch}`, ...finish.actions.map((action) => `would: ${action}`), ...finish.kept.map((kept) => `kept (${kept.code}): ${kept.detail}`)];
  return rows.join("\n");
}

function ineligibleNotice(target: FinishTarget, finish: FinishCheck): FinishNotice {
  const failing = finish.checks.filter((check) => !check.ok);
  const reasons = failing.map((check) => checkSentence(check, target));
  return {
    kind: "ineligible",
    message: `"${target.planLabel}" cannot be merged and cleaned up yet. Nothing was changed.`,
    reasons: reasons.length > 0 ? reasons : [finish.summary],
    technical: failing.map((check) => `${check.code}: ${check.detail}`),
  };
}

/**
 * A failing finish check in plain words. The codes are the engine's
 * (docs/plans.md, "Finish checks"); one this version does not know is shown
 * as the engine's own sentence rather than guessed at.
 */
export function checkSentence(check: FinishCheckItem, target: Pick<FinishTarget, "targetBranch">): string {
  const into = target.targetBranch;
  switch (check.code) {
    case "unmanaged":
      return "Agent Sparring has no record that it created this run's workspace, so it never merges or removes it.";
    case "run_not_complete":
      return "The run is not complete, or a stage is not accepted at the run's last commit.";
    case "human_gate_pending":
      return "A check is still waiting for your answer.";
    case "runner_live":
      return "Something is still running in this run's workspace.";
    case "worktree_missing":
      return "The run's workspace folder is missing.";
    case "branch_mismatch":
      return "The run's workspace is not on the run's own branch.";
    case "worktree_dirty":
      return "The run's workspace has uncommitted changes.";
    case "candidate_mismatch":
      return "The workspace's latest commit is not the one the reviewer accepted.";
    case "candidate_not_pushed":
      return "The accepted commit has not been pushed to the remote yet.";
    case "branch_in_use":
      return "The run's branch is checked out somewhere else.";
    case "target_checkout_dirty":
      return `The checkout of ${into} has uncommitted changes.`;
    case "target_operation_in_progress":
      return `A merge, rebase or similar operation is in progress in the checkout of ${into}.`;
    case "target_advanced":
      return `${into} has moved on since the run started, or no longer exists.`;
    case "merge_conflict":
      return `Merging this run into ${into} would conflict.`;
    case "unarchived_project_state":
      return "The run's Agent Sparring records cannot be archived, so its workspace cannot be removed.";
    default:
      return check.detail;
  }
}

const STEP_WORDS: Record<string, string> = {
  checks: "the final checks",
  merge: "merging",
  push_target: "pushing the target branch",
  archive_state: "archiving the run's records",
  remove_worktree: "removing the workspace",
  delete_branch: "deleting the local branch",
};

async function finish(target: FinishTarget, choice: FinishChoice, effects: FinishRunEffects): Promise<FinishOutcome> {
  const args = buildFinishRunArgs({ repoRoot: target.repoRoot, runKey: target.runKey, pushTarget: choice.pushTarget, allowMergeCommit: choice.allowMergeCommit });
  const ran = await effects.run(args);
  if (!ran.ok) {
    await effects.notify({ kind: "error", message: `Merge & clean up was not confirmed to start: ${ran.reason}` });
    return { kind: "error" };
  }
  const result = readResult(ran.output, target.runKey);
  if (ran.exitCode === 0 && result && result.stoppedAt === null) {
    await effects.notify({ kind: "finished", message: `"${target.planLabel}" is merged into ${target.targetBranch} and its workspace is cleaned up.` });
    return { kind: "finished", result };
  }
  if (result && result.stoppedAt !== null) {
    const step = STEP_WORDS[result.stoppedAt] ?? result.stoppedAt;
    await effects.notify({
      kind: "stopped",
      message: `Merge & clean up stopped at ${step}. What is not yet done is left in place; running it again continues.`,
      stoppedAt: result.stoppedAt,
      reason: result.reason ?? undefined,
      remaining: result.remaining,
    });
    return { kind: "stopped", result };
  }
  const exit = ran.exitCode === undefined ? "with no exit code reported" : `with exit code ${ran.exitCode}`;
  await effects.notify({ kind: "error", message: `finish-run ended ${exit} and no report this version reads; see its terminal for what it did.` });
  return { kind: "stopped", result: undefined };
}

/** The engine's JSON report out of a terminal's output, which may carry other lines around it. */
function readResult(output: string, runKey: string): FinishResult | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const report = parseFinishResult(output.slice(start, end + 1));
    return report.kind === "result" && report.result.runKey === runKey ? report.result : undefined;
  } catch {
    return undefined;
  }
}
