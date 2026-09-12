/**
 * The items "Select Repository / Run" offers, as plain data: label,
 * description and detail per recorded run, in display order. Shared by the
 * quick pick and the discovery diagnostic so both show the same list.
 *
 * No dependency on the vscode API.
 */

import { currentStageOf, isOpenRun, runLabel, totalStagesOf, type RunSnapshot } from "./discovery";

export interface RunPickItem {
  label: string;
  description: string;
  detail: string;
  run: RunSnapshot;
}

export function describeRun(run: RunSnapshot): string {
  if (run.kind === "plan") {
    const total = totalStagesOf(run);
    return `${run.state.status} · stage ${run.state.currentStageIndex + 1}/${total ?? "?"} · ${run.state.expectedBranch}`;
  }
  return `standalone stage · ${run.stage.state?.status ?? "working"}`;
}

/** `repo: run` when several repositories are present, else just the run. */
export function runPickLabel(run: RunSnapshot, multiRepo: boolean): string {
  return multiRepo ? `${run.location.folderName}: ${runLabel(run)}` : runLabel(run);
}

/** Runs grouped by repository, open runs first, then most recently written first. */
export function buildRunPickItems(runs: RunSnapshot[], selectedId?: string): RunPickItem[] {
  const multiRepo = new Set(runs.map((run) => run.location.projectDir)).size > 1;
  return runs
    .slice()
    .sort(
      (a, b) =>
        a.location.folderName.localeCompare(b.location.folderName) || Number(isOpenRun(b)) - Number(isOpenRun(a)) || b.stateMtimeMs - a.stateMtimeMs,
    )
    .map((run) => ({
      label: `${run.id === selectedId ? "$(check) " : ""}${runPickLabel(run, multiRepo)}`,
      description: describeRun(run),
      detail: `${run.location.folderName} · ${currentStageOf(run).stageId}`,
      run,
    }));
}
