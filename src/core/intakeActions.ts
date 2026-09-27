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
import { buildApprovePlanArgs, buildRunPlanArgs } from "./cli";
import { runIdFor, samePath, type SparringLocation } from "./discovery";
import type { IntakeSliceSnapshot, IntakeSnapshot } from "./intake";

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

export function approveInvocation(intake: IntakeSnapshot, slice: IntakeSliceSnapshot, locations: readonly SparringLocation[]): IntakeInvocation {
  if (!slice.primaryRepository) {
    return { ok: false, problem: `the intake does not record which repository run slice ${slice.runId} is approved from. Open the intake report.` };
  }
  if (!slice.primaryPath) {
    return { ok: false, problem: `intake did not record a path for repository ${slice.primaryRepository}, where run slice ${slice.runId} is approved. Open the intake report.` };
  }
  const repoRoot = slice.primaryPath;
  const sparringDir = sparringDirFor(repoRoot, locations);
  const args = buildApprovePlanArgs({ intakeDir: intake.dir, runId: slice.runId, repoRoot, repositoryName: slice.primaryRepository, sparringDir });
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
    return { ok: false, problem: `run slice ${slice.runId} has no sealed approval without a run.` };
  }
  const recordedIn = approval.sparringDir ?? path.join(approval.repoRoot, ".sparring");
  const location = locations.find((candidate) => samePath(candidate.sparringDir, recordedIn) || samePath(canonical(candidate.sparringDir), canonical(recordedIn)));
  if (!location) {
    return { ok: false, problem: `run slice ${slice.runId} runs in ${approval.repoRoot}, which is not open in this window. Open that repository, then start the slice.` };
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
