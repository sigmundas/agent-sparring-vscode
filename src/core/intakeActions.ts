/**
 * The two engine commands the intake screen can issue, built from what the
 * engine's intake files record and nothing else.
 *
 *  - **Approve next slice** → `approve-plan <intake> --run <slice>`, from the
 *    slice's primary repository as intake recorded it. Whether the slice may
 *    be approved is entirely the engine's decision; a refusal is shown as the
 *    engine wrote it.
 *  - **Start slice** → `run-plan --manifest <sealed manifest> --run-key <key>
 *    --repo-root <approved worktree> --expected-branch <approved branch>`,
 *    every value taken from `approval.json` and the manifest beside it. No
 *    plan is rebuilt from Markdown.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import { buildApprovePlanArgs, buildPreparePlanArgs, buildRunPlanArgs } from "./cli";
import { runIdFor, samePath, type SparringLocation } from "./discovery";
import { sliceStageName, type IntakeSliceSnapshot, type IntakeSnapshot } from "./intake";

export type IntakeInvocation =
  | { ok: true; args: string[]; cwd: string; repoRoot: string; sparringDir: string; describe: string }
  | { ok: false; problem: string };

export type IntakeStartInvocation =
  | { ok: true; args: string[]; cwd: string; runId: string; location: SparringLocation; manifestPath: string; runKey: string; expectedBranch: string; describe: string }
  | { ok: false; problem: string };

/** Where a repository's engine state lives: an opened project's, else the engine's own default beside it. */
function sparringDirFor(repoRoot: string, locations: readonly SparringLocation[]): string {
  return locations.find((location) => samePath(location.repoRoot, repoRoot))?.sparringDir ?? path.join(repoRoot, ".sparring");
}

export function approveInvocation(
  intake: IntakeSnapshot,
  slice: IntakeSliceSnapshot,
  locations: readonly SparringLocation[],
  /** The slice's sibling repositories as a person confirmed them; see {@link proposeSiblingMappings}. */
  siblings?: Record<string, { path: string; branch: string }>,
): IntakeInvocation {
  if (!slice.primaryRepository) {
    return { ok: false, problem: `the intake does not record which repository ${sliceStageName(slice)} (run slice ${slice.runId}) is approved from. Open the intake report.` };
  }
  if (!slice.primaryPath) {
    return { ok: false, problem: `intake did not record a path for repository ${slice.primaryRepository}, where ${sliceStageName(slice)} (run slice ${slice.runId}) is approved. Open the intake report.` };
  }
  const repoRoot = slice.primaryPath;
  const sparringDir = sparringDirFor(repoRoot, locations);
  const args = buildApprovePlanArgs({ intakeDir: intake.dir, runId: slice.runId, repoRoot, repositoryName: slice.primaryRepository, sparringDir, ...(siblings ? { siblings } : {}) });
  return { ok: true, args, cwd: repoRoot, repoRoot, sparringDir, describe: `approve-plan ${intake.dir} --run ${slice.runId} (from ${slice.primaryRepository})` };
}

/**
 * The exact sealed start. Refused, launching nothing, when the slice is not
 * approved or when the project its run is recorded in (the approval's
 * `sparring_dir`) is not one this window has discovered: the run would be
 * written somewhere the cockpit cannot see, and its duplicate guard would
 * be keyed to a project it does not know.
 */
export function startInvocation(
  slice: IntakeSliceSnapshot,
  locations: readonly SparringLocation[],
  /** Resolves symlinks: the engine records `sparring_dir` fully resolved, and a window may spell it otherwise. */
  canonical: (file: string) => string = (file) => file,
): IntakeStartInvocation {
  const approval = slice.approval;
  if (slice.state !== "approved" || !approval || !slice.manifestPath) {
    return { ok: false, problem: `${sliceStageName(slice)} has no sealed approval that has not already run.` };
  }
  const recordedIn = approval.sparringDir ?? path.join(approval.repoRoot, ".sparring");
  const location = locations.find((candidate) => samePath(candidate.sparringDir, recordedIn) || samePath(canonical(candidate.sparringDir), canonical(recordedIn)));
  if (!location) {
    return { ok: false, problem: `${sliceStageName(slice)} runs in ${approval.repoRoot}, which is not open in this window. Open that repository, then start it.` };
  }
  const args = buildRunPlanArgs({
    intakeManifest: slice.manifestPath,
    runKey: approval.runKey,
    repoRoot: approval.repoRoot,
    expectedBranch: approval.expectedBranch,
    sparringDir: location.sparringDir,
  });
  return {
    ok: true,
    args,
    cwd: approval.repoRoot,
    runId: runIdFor(location, "plan", approval.runKey),
    location,
    manifestPath: slice.manifestPath,
    runKey: approval.runKey,
    expectedBranch: approval.expectedBranch,
    describe: `run-plan --manifest ${slice.manifestPath} --run-key ${approval.runKey}`,
  };
}

/**
 * Where a repository mapping stands before it is handed to the engine again:
 * `valid` when `path` is still a git worktree root of the same repository
 * (its git common directory is the one intake recorded, when it recorded
 * one), otherwise why not.
 */
export type RepositoryMappingCheck = { valid: true } | { valid: false; reason: string };

/** Answers {@link RepositoryMappingCheck} for one name → path; injected so tests need no git. */
export type RepositoryMappingValidator = (name: string, repoPath: string, recordedGitDir: string | undefined) => Promise<RepositoryMappingCheck>;

export type PrepareInvocation =
  | { ok: true; args: string[]; cwd: string; repoRoot: string; sparringDir: string; contextRepositories: Record<string, string>; describe: string }
  | { ok: false; problem: string };

/**
 * prepare-plan again for the plan `intake` read, from the project that
 * prepared it, in the same mode, with the context repositories it was given
 * — `overrides` replacing (or, as `null`, leaving out) any a person resolved.
 * Everything else, including what carries over from completed work, is the
 * engine's.
 */
export function prepareInvocation(intake: IntakeSnapshot & { location: SparringLocation }, overrides: Readonly<Record<string, string | null>> = {}): PrepareInvocation {
  const { record } = intake;
  if (!record.sourcePath) {
    return { ok: false, problem: `intake ${record.intakeId} does not record the source plan's path.` };
  }
  if (!record.primaryRepository) {
    return { ok: false, problem: `intake ${record.intakeId} does not record which repository prepared it.` };
  }
  const contextRepositories: Record<string, string> = {};
  for (const [name, recorded] of Object.entries({ ...recordedContextRepositories(intake), ...overrides })) {
    if (recorded) {
      contextRepositories[name] = recorded;
    }
  }
  const repoRoot = intake.location.repoRoot;
  const args = buildPreparePlanArgs({ planPath: record.sourcePath, repoRoot, repositoryName: record.primaryRepository, mode: record.mode, contextRepositories, sparringDir: intake.sparringDir });
  return { ok: true, args, cwd: repoRoot, repoRoot, sparringDir: intake.sparringDir, contextRepositories, describe: `prepare-plan ${record.planLabel} (from ${record.primaryRepository})` };
}

/**
 * The context repositories the previous prepare was given; for an intake that
 * did not record them, every repository it inspected except its own.
 */
export function recordedContextRepositories(intake: IntakeSnapshot): Record<string, string> {
  const { record } = intake;
  if (record.contextRepositories) {
    return { ...record.contextRepositories };
  }
  return Object.fromEntries(Object.entries(record.repositories).filter(([name]) => name !== record.primaryRepository));
}

/** Each context repository of `intake` that no longer checks out, with why. */
export async function staleContextRepositories(intake: IntakeSnapshot, validate: RepositoryMappingValidator): Promise<{ name: string; path: string; reason: string }[]> {
  const stale: { name: string; path: string; reason: string }[] = [];
  for (const [name, repoPath] of Object.entries(recordedContextRepositories(intake)).sort(([a], [b]) => a.localeCompare(b))) {
    const check = await validate(name, repoPath, intake.record.repositoryGitDirs?.[name]);
    if (!check.valid) {
      stale.push({ name, path: repoPath, reason: check.reason });
    }
  }
  return stale;
}

/**
 * The intake already prepared from the plan as it is now, newer than
 * `intake` and in the same project, if there is one: recovery then follows
 * it instead of preparing a duplicate.
 */
export function preparedFromCurrentPlan<T extends IntakeSnapshot & { location: SparringLocation }>(intake: T, intakes: readonly T[], currentDigest: string): T | undefined {
  return intakes
    .filter(
      (candidate) =>
        candidate !== intake &&
        samePath(candidate.location.projectDir, intake.location.projectDir) &&
        candidate.record.planLabel === intake.record.planLabel &&
        candidate.record.sourceDigest === currentDigest &&
        candidate.record.createdAtMs !== undefined &&
        (intake.record.createdAtMs === undefined || candidate.record.createdAtMs > intake.record.createdAtMs),
    )
    .sort((a, b) => (b.record.createdAtMs ?? 0) - (a.record.createdAtMs ?? 0))[0];
}

/** A sibling repository approve-plan needs for a slice, as proposed from what intake recorded. */
export interface SiblingProposal {
  name: string;
  /** The path intake recorded for it, when it recorded one. */
  path?: string;
  /** The branch checked out there now, when it is on one. */
  branch?: string;
  /** Why the recorded mapping cannot be proposed as it is; absent when it can. */
  problem?: string;
}

/**
 * The sibling repositories `slice` declares (the engine's recorded
 * `approval_requirements`), each proposed at the path intake inspected and
 * the branch checked out there now. A person confirms or replaces them:
 * the branch is sealed into the manifest, and approve-plan re-checks the
 * repository identity itself.
 */
export async function proposeSiblingMappings(
  intake: IntakeSnapshot,
  slice: IntakeSliceSnapshot,
  validate: RepositoryMappingValidator,
  branchOf: (repoPath: string) => Promise<string | undefined>,
): Promise<SiblingProposal[]> {
  const out: SiblingProposal[] = [];
  for (const name of slice.requirements?.siblings ?? []) {
    const recorded = intake.record.repositories[name];
    if (!recorded) {
      out.push({ name, problem: "this intake did not inspect it" });
      continue;
    }
    const check = await validate(name, recorded, intake.record.repositoryGitDirs?.[name]);
    if (!check.valid) {
      out.push({ name, path: recorded, problem: check.reason });
      continue;
    }
    const branch = await branchOf(recorded);
    out.push(branch ? { name, path: recorded, branch } : { name, path: recorded, problem: "it has no branch checked out" });
  }
  return out;
}
