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

import { currentStageOf, isOpenRun, samePath, totalStagesOf, type RunSelection, type RunSnapshot } from "./discovery";
import type { RunIndex, RunIndexEntry } from "./runIndex";
import { formatWhen, stagePositionText, summarizeRun } from "./runSummary";
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

// ---------------------------------------------------------------- open runs first

/** Text that marks the pinned row in addition to its tick, so it never reads as the keyboard highlight. */
export const PINNED_MARK = "pinned";

export interface RunQuickPickSection {
  title: string;
  items: RunPickItem[];
}

export interface RunQuickPickOptions {
  /** The run the user pinned, if any: ticked and marked `pinned`. */
  pinnedId?: string;
  nowMs: number;
}

/**
 * The quick pick's run rows, from the shared run index (core/runIndex.ts):
 * OPEN, RECENT, then one section per other repository. Each label leads with
 * the status, so a long title can never truncate it away; the run key and the
 * worktree are secondary, in `detail`.
 */
export function buildRunQuickPickSections(index: RunIndex, options: RunQuickPickOptions): RunQuickPickSection[] {
  const row = ({ run, summary }: RunIndexEntry): RunPickItem => {
    const pinned = run.id === options.pinnedId;
    const where = summary.repository.external ? `${summary.repository.name} (worktree outside this workspace)` : summary.repository.name;
    return {
      label: `${pinned ? "$(check) " : ""}${summary.statusWord}  ${summary.title}`,
      description: [pinned ? PINNED_MARK : undefined, stagePositionText(summary), formatWhen(summary.updatedAtMs, options.nowMs)].filter(Boolean).join(" · "),
      detail: `${where} · ${summary.runKey}`,
      run,
    };
  };
  return [
    { title: "OPEN", items: index.open.map(row) },
    { title: "RECENT", items: index.recent.map(row) },
    ...index.other.map((repository) => ({ title: `OTHER REPOSITORY · ${repository.name}`, items: repository.entries.map(row) })),
  ].filter((section) => section.items.length > 0);
}

/**
 * Which run the quick pick should highlight first: the pinned run; else the
 * run on screen when it is in the followed repository; else the one running
 * run in the followed repository, when there is exactly one; else nothing.
 * A run from another repository is never highlighted while a different one
 * is followed — Enter would silently move the cockpit there.
 */
export function initialRunFocus(runs: readonly RunSnapshot[], pinnedId: string | undefined, followedRoot: string | undefined, shownId?: string): RunSnapshot | undefined {
  const pinned = pinnedId ? runs.find((run) => run.id === pinnedId) : undefined;
  if (pinned) {
    return pinned;
  }
  if (!followedRoot) {
    return undefined;
  }
  const shown = shownId ? runs.find((run) => run.id === shownId && samePath(run.location.repoRoot, followedRoot)) : undefined;
  if (shown) {
    return shown;
  }
  const running = runs.filter((run) => run.kind === "plan" && run.state.status === "running" && samePath(run.location.repoRoot, followedRoot));
  return running.length === 1 ? running[0] : undefined;
}

// ---------------------------------------------------------------- ambiguity rows

/** One open run the overview offers when several are open and none is chosen. */
export interface AmbiguousRunRow {
  /** The discovered run id; the only thing the webview sends back. */
  runId: string;
  status: string;
  stage?: string;
  runKey: string;
  /** The plan document's title, or a stage's display name. */
  plan: string;
  folderName: string;
  /** Running, so probably what the person wants — shown, never acted on. */
  likely: boolean;
}

export function ambiguousRunRows(runs: readonly RunSnapshot[], memberships?: ReadonlyMap<string, PlanMembership>): AmbiguousRunRow[] {
  const entries = runs.map((run) => ({ run, summary: summarizeRun(run, memberships) }));
  const order: Record<string, number> = { running: 0, "needs-you": 1, paused: 2, open: 3, complete: 4 };
  entries.sort((a, b) => order[a.summary.phase] - order[b.summary.phase] || b.summary.updatedAtMs - a.summary.updatedAtMs);
  return entries.map(({ run, summary }) => ({
    runId: run.id,
    status: summary.statusWord,
    ...(stagePositionText(summary) ? { stage: stagePositionText(summary) } : {}),
    runKey: summary.runKey,
    plan: summary.title,
    folderName: run.location.folderName,
    likely: summary.phase === "running",
  }));
}

/**
 * The run an ambiguity row's click names, or undefined when that id is not
 * one of the runs currently offered. A webview message is untrusted input:
 * only an id from the present ambiguous set may be pinned.
 */
export function resolveAmbiguousChoice(selection: Pick<RunSelection, "selected" | "ambiguous">, runId: unknown): RunSnapshot | undefined {
  if (selection.selected || typeof runId !== "string" || runId === "") {
    return undefined;
  }
  return selection.ambiguous.find((run) => run.id === runId);
}
