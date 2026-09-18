/**
 * The items "Select Repository / Run" offers, as plain data: label,
 * description and detail per recorded run, in display order. Shared by the
 * quick pick and the discovery diagnostic so both show the same list.
 *
 * The list is **grouped**, because the two kinds of row answer different
 * questions and used to sit side by side in one dense list: a plan run is the
 * whole job (pick it to see the timeline), a standalone stage is one old stage
 * to inspect. Plan runs come first, and a stage that belongs to a discovered
 * plan run says so rather than looking like separate work.
 *
 * Labels prefer what a person calls things — the plan document's title, the
 * plan's own `Stage 3D — …` name for a stage — and keep the raw stage id and
 * the repository in `detail`, where an identifier belongs.
 *
 * No dependency on the vscode API.
 */

import { currentStageOf, isOpenRun, totalStagesOf, type RunSnapshot } from "./discovery";
import { planRunDisplayName, type PlanMembership } from "./planMembership";
import { presentRunStage, stageDisplayName } from "./presentation";

export interface RunPickItem {
  label: string;
  description: string;
  detail: string;
  run: RunSnapshot;
}

/** The two groups, in order. Separator titles, shown above their rows. */
export const PLAN_RUNS_GROUP = "PLAN RUNS";
export const STANDALONE_STAGES_GROUP = "STANDALONE / HISTORICAL STAGES";

export interface RunPickGroup {
  title: string;
  /** One sentence saying what picking from this group means; for the diagnostic and tooltips. */
  note: string;
  items: RunPickItem[];
}

export interface RunPickOptions {
  selectedId?: string;
  /** Which managed plan run each standalone stage belongs to (planMembership.ts). */
  memberships?: ReadonlyMap<string, PlanMembership>;
}

/** Human word for a plan run's recorded status. */
function planStatusWord(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * How many stages a plan run executes: the engine-parsed plan list, else the
 * count its own manifest carries (which is the only answer for a run whose
 * plan document the engine-shaped parser refuses — see planMembership.ts).
 */
function totalStagesFor(run: RunSnapshot, memberships: ReadonlyMap<string, PlanMembership> | undefined): number | undefined {
  const parsed = totalStagesOf(run);
  if (parsed) {
    return parsed;
  }
  for (const membership of memberships?.values() ?? []) {
    if (membership.planRunId === run.id && membership.totalStages) {
      return membership.totalStages;
    }
  }
  return undefined;
}

export function describeRun(run: RunSnapshot, memberships?: ReadonlyMap<string, PlanMembership>): string {
  if (run.kind === "plan") {
    const total = totalStagesFor(run, memberships);
    const at = run.state.currentStageIndex + 1;
    return `${planStatusWord(run.state.status)} · ${total ? `${at}/${total}` : `stage ${at}`} · ${run.state.expectedBranch}`;
  }
  const state = presentRunStage(run).label;
  const membership = memberships?.get(run.id);
  if (!membership) {
    return `${state} · stage on its own`;
  }
  const where = membership.position && membership.totalStages ? ` (${membership.position} of ${membership.totalStages})` : "";
  return `${state} · stage of ${membership.planName}${where}`;
}

/** `repo: run` when several repositories are present, else just the run. */
export function runPickLabel(run: RunSnapshot, multiRepo: boolean, memberships?: ReadonlyMap<string, PlanMembership>): string {
  const name = runDisplayName(run, memberships);
  return multiRepo ? `${run.location.folderName}: ${name}` : name;
}

/**
 * What a person calls this run: a plan run by its document's title, a stage by
 * the plan's own name for it when a managed run claims it, else by its
 * humanized stage id. Never the raw id, and never a filesystem path.
 */
export function runDisplayName(run: RunSnapshot, memberships?: ReadonlyMap<string, PlanMembership>): string {
  if (run.kind === "plan") {
    return planRunDisplayName(run);
  }
  const membership = memberships?.get(run.id);
  if (membership?.stageLabel && membership.stageTitle) {
    return `${membership.stageLabel} — ${membership.stageTitle}`;
  }
  return membership?.stageLabel ?? stageDisplayName(run.stage);
}

/**
 * Runs grouped by kind, then by repository, open runs first, then most
 * recently written first. The managed plan runs are the first group because
 * they are what someone wanting the overall workflow should pick.
 */
export function buildRunPickGroups(runs: RunSnapshot[], options: RunPickOptions = {}): RunPickGroup[] {
  const multiRepo = new Set(runs.map((run) => run.location.projectDir)).size > 1;
  const ordered = runs
    .slice()
    .sort(
      (a, b) =>
        a.location.folderName.localeCompare(b.location.folderName) || Number(isOpenRun(b)) - Number(isOpenRun(a)) || b.stateMtimeMs - a.stateMtimeMs,
    )
    .map((run) => ({
      label: `${run.id === options.selectedId ? "$(check) " : ""}${runPickLabel(run, multiRepo, options.memberships)}`,
      description: describeRun(run, options.memberships),
      detail: `${run.location.folderName} · ${currentStageOf(run).stageId}`,
      run,
    }));
  const groups: RunPickGroup[] = [
    { title: PLAN_RUNS_GROUP, note: "The whole job: its stages in order, with the timeline.", items: ordered.filter((item) => item.run.kind === "plan") },
    {
      title: STANDALONE_STAGES_GROUP,
      note: "One stage on its own, for inspecting what it recorded. A stage of a plan run above is history; pick the plan run for the workflow.",
      items: ordered.filter((item) => item.run.kind === "stage"),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}

/** The same rows as one flat list, in group order; for callers that cannot show separators. */
export function buildRunPickItems(runs: RunSnapshot[], selectedId?: string, memberships?: ReadonlyMap<string, PlanMembership>): RunPickItem[] {
  return buildRunPickGroups(runs, { selectedId, memberships }).flatMap((group) => group.items);
}
