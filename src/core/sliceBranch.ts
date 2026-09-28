/**
 * Whether an intake slice needs a feature branch, as the engine reports it.
 *
 * An implementation slice never runs on a protected branch. That is the
 * engine's policy, and it is not re-implemented here: `sparring slice-branch
 * --json` says whether this slice needs a branch (`needs_branch`), what the
 * engine can do about it (`action`: create one at the current commit, or move
 * an approval sealed on a protected branch to the one checked out now), and
 * why not when it cannot (`blocked`). This module only reads that answer and
 * says it plainly; the engine's own sentences go under Technical details.
 */

import type { RunSelection, SparringLocation } from "./discovery";
import { intakeNextAction, type IntakeRunBinding, type IntakeSliceSnapshot } from "./intake";

export type SliceBranchAction = "create-branch" | "move-approval";

/** `slice-branch --json`'s `status`. */
export interface SliceBranchReport {
  runId: string;
  /** `Stage 1B`, as the engine names the slice's stages. */
  stages: string;
  repository: string;
  currentBranch: string;
  approvedBranch?: string;
  movedFrom?: string;
  needsBranch: boolean;
  action?: SliceBranchAction;
  suggestedBranch?: string;
  /** The engine's own sentence for why a branch is needed. */
  problem?: string;
  /** The engine's reason it cannot fix this itself. */
  blocked?: string;
}

/** Where to ask: the slice, and the primary repository it runs in. */
export interface SliceBranchTarget {
  intakeDir: string;
  runId: string;
  repoRoot: string;
  sparringDir: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parse `slice-branch --json` output; undefined for anything else (an older engine, a refusal). */
export function parseSliceBranch(text: string): SliceBranchReport | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  const status = payload && typeof payload === "object" ? (payload as Record<string, unknown>)["status"] : undefined;
  if (!status || typeof status !== "object") {
    return undefined;
  }
  const s = status as Record<string, unknown>;
  const runId = optionalString(s["run_id"]);
  const stages = optionalString(s["stages"]);
  const currentBranch = optionalString(s["current_branch"]);
  if (!runId || !stages || !currentBranch || typeof s["needs_branch"] !== "boolean") {
    return undefined;
  }
  const action = s["action"] === "create-branch" || s["action"] === "move-approval" ? s["action"] : undefined;
  const report: SliceBranchReport = { runId, stages, repository: optionalString(s["repository"]) ?? "", currentBranch, needsBranch: s["needs_branch"] };
  const approvedBranch = optionalString(s["approved_branch"]);
  const movedFrom = optionalString(s["moved_from"]);
  const suggestedBranch = optionalString(s["suggested_branch"]);
  const problem = optionalString(s["problem"]);
  const blocked = optionalString(s["blocked"]);
  return {
    ...report,
    ...(approvedBranch ? { approvedBranch } : {}),
    ...(movedFrom ? { movedFrom } : {}),
    ...(action ? { action } : {}),
    ...(suggestedBranch ? { suggestedBranch } : {}),
    ...(problem ? { problem } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

/** The slice the intake screen offers next, in the repository it would run in. */
export function intakeSliceTarget(intakeDir: string, slice: IntakeSliceSnapshot, locations: readonly SparringLocation[]): SliceBranchTarget | undefined {
  const repoRoot = slice.approval?.repoRoot ?? slice.primaryPath;
  if (!repoRoot) {
    return undefined;
  }
  const recorded = slice.approval?.sparringDir;
  const location = locations.find((candidate) => (recorded ? candidate.sparringDir === recorded : candidate.repoRoot === repoRoot)) ?? locations.find((candidate) => candidate.repoRoot === repoRoot);
  return location ? { intakeDir, runId: slice.runId, repoRoot: location.repoRoot, sparringDir: location.sparringDir } : undefined;
}

/** The slice a sealed intake run executes, in the repository it runs in. */
export function intakeRunTarget(binding: IntakeRunBinding, location: Pick<SparringLocation, "repoRoot" | "sparringDir">): SliceBranchTarget {
  return { intakeDir: binding.intakeDir, runId: binding.runId, repoRoot: location.repoRoot, sparringDir: location.sparringDir };
}

/** The feature-branch notice: plain sentences, at most one action, the engine's text for details. */
export interface BranchNotice {
  headline: string;
  lines: string[];
  action?: { kind: SliceBranchAction; label: string; detail: string; branch?: string };
  technical: string;
}

export const MOVE_TO_FEATURE_BRANCH = "Move to feature branch";

export function branchNotice(report: SliceBranchReport | undefined): BranchNotice | undefined {
  if (!report || !report.needsBranch) {
    return undefined;
  }
  const name = report.stages;
  const protectedBranch = report.approvedBranch ?? report.currentBranch;
  const lines: string[] = [];
  if (report.approvedBranch) {
    lines.push(`${name} was approved on ${protectedBranch}, where implementation agents never run, so it cannot start there.`);
    if (report.blocked) {
      lines.push("The engine cannot move it to a feature branch; Technical details says why.");
    } else {
      lines.push("Nothing has run yet, so the approval can be moved to a feature branch at the same commit. The approval itself is kept, and the move is recorded beside it.");
    }
  } else {
    lines.push(`${name} runs an implementation agent, which never runs on ${protectedBranch}. It needs a feature branch at the current commit before it can be approved.`);
  }
  let action: BranchNotice["action"];
  if (report.action === "create-branch" && report.suggestedBranch) {
    action = {
      kind: "create-branch",
      label: `Create branch ${report.suggestedBranch}`,
      detail: report.approvedBranch
        ? `Check out ${report.suggestedBranch} at the approved commit in ${report.repository} and move ${name}'s approval to it (sparring slice-branch --create)`
        : `Check out ${report.suggestedBranch} at the current commit in ${report.repository} (sparring slice-branch --create)`,
      branch: report.suggestedBranch,
    };
  } else if (report.action === "move-approval") {
    action = {
      kind: "move-approval",
      label: `Move ${name} to ${report.currentBranch}`,
      detail: `Move ${name}'s approval to ${report.currentBranch}, the branch checked out now, at the same commit (sparring slice-branch --move)`,
    };
  }
  const technical = [report.problem, report.blocked ? `The engine cannot move it: ${report.blocked}` : undefined].filter((line): line is string => Boolean(line)).join("\n\n");
  return { headline: `${name} needs a feature branch`, lines, ...(action ? { action } : {}), technical: technical || `${name} needs a feature branch.` };
}

/** The stage row's state when its branch is what stands in the way. */
export function branchStateLabel(report: SliceBranchReport): string {
  return report.approvedBranch ? "Approved — needs a feature branch" : "Needs a feature branch";
}

/** Whether a report concerns this slice (the probe is per slice; a stale one is ignored). */
export function reportFor(report: SliceBranchReport | undefined, slice: Pick<IntakeSliceSnapshot, "runId" | "stages">): SliceBranchReport | undefined {
  return report && report.runId === slice.runId ? report : undefined;
}

/**
 * Which slice to ask about for what is on screen: the slice a sealed intake
 * run executes, or the intake's next slice when it is waiting to be approved
 * or started. Anything else has no intake slice, and nothing is asked.
 */
export function sliceBranchTargetOf(selection: RunSelection, locations: readonly SparringLocation[]): SliceBranchTarget | undefined {
  const run = selection.selected;
  if (run) {
    return run.kind === "plan" && run.intake ? intakeRunTarget(run.intake, run.location) : undefined;
  }
  const intake = selection.intake;
  if (!intake) {
    return undefined;
  }
  const next = intakeNextAction(intake);
  return next.kind === "start" || next.kind === "approve" ? intakeSliceTarget(intake.dir, next.slice, locations) : undefined;
}
