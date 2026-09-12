/**
 * Run discovery: from one or more `.sparring` directories, build snapshots of
 * every recorded plan run (and standalone stages), then apply a deterministic
 * selection rule that never guesses between genuinely ambiguous active runs.
 *
 * Authoritative inputs only: `.sparring/plans/<key>.json`, each stage's
 * `state.json`, the plan Markdown (for stage titles/total) and the current
 * stage's `sparring.md` routing outcome. `activity.jsonl` is never read here.
 *
 * No dependency on the vscode API.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  parsePlanRunState,
  parsePlanStages,
  parseSparringOutcome,
  parseStageState,
  type PlanRunState,
  type PlanStageHeading,
  type SparringOutcome,
  type StageState,
} from "./engineFormats";

export const SPARRING_DIRNAME = ".sparring";
export const PLANS_DIRNAME = "plans";
export const STAGES_DIRNAME = "stages";
export const STATE_FILENAME = "state.json";
export const ACTIVITY_FILENAME = "activity.jsonl";
export const SPARRING_FILENAME = "sparring.md";
export const HANDOFF_FILENAME = "handoff.md";
export const BRIEF_FILENAME = "brief.md";
export const NOTES_FILENAME = "notes.md";
export const CONFIG_FILENAME = "project.toml";

export interface SparringLocation {
  /** Absolute path of the `.sparring` directory. */
  sparringDir: string;
  /** Absolute repository root the engine would use (see resolveRepoRoot). */
  repoRoot: string;
  /**
   * Identity of the owning VS Code workspace folder (its fsPath). Every run
   * id is prefixed with it, so two repositories with identical stage ids
   * never collide and a persisted selection names the repository too.
   */
  workspaceFolder: string;
  /** Short display name of the owning workspace folder. */
  folderName: string;
}

export function runIdFor(location: SparringLocation, kind: "plan" | "stage", key: string): string {
  return `${location.workspaceFolder}|${kind}:${key}`;
}

export interface StageSnapshot {
  stageId: string;
  /** Absolute stage directory (may not exist yet for future planned stages). */
  dir: string;
  exists: boolean;
  /** 1-based position in the plan; undefined for standalone stages. */
  number?: number;
  title?: string;
  state?: StageState;
  stateError?: string;
}

export interface PlanRunSnapshot {
  kind: "plan";
  /** Stable identity across reloads: `plan:<state file path>`. */
  id: string;
  location: SparringLocation;
  planKey: string;
  statePath: string;
  stateMtimeMs: number;
  state: PlanRunState;
  /** Absolute path of the plan document, resolved from the recorded label. */
  planPath: string;
  /** Parsed headings, or undefined if the plan is unreadable/malformed. */
  planStages?: PlanStageHeading[];
  planError?: string;
  stages: StageSnapshot[];
  currentStage: StageSnapshot;
  /** Routing outcome recorded in the current stage's sparring.md, if any. */
  currentOutcome?: SparringOutcome;
}

export interface StandaloneStageSnapshot {
  kind: "stage";
  /** `stage:<stage dir path>` */
  id: string;
  location: SparringLocation;
  stage: StageSnapshot;
  stateMtimeMs: number;
  outcome?: SparringOutcome;
}

export type RunSnapshot = PlanRunSnapshot | StandaloneStageSnapshot;

export interface Discovery {
  locations: SparringLocation[];
  runs: RunSnapshot[];
  /** Plan-run state files that exist but could not be parsed. */
  problems: { path: string; error: string }[];
}

// ---------------------------------------------------------------------------
// location helpers
// ---------------------------------------------------------------------------

/**
 * The engine's default repo root is the parent of `.sparring`, unless
 * project.toml sets `[repo] root = "..."` (resolved against that parent).
 * Only that one key is read; this is not a TOML parser.
 */
export async function resolveRepoRoot(sparringDir: string): Promise<string> {
  const projectRoot = path.dirname(sparringDir);
  let text: string;
  try {
    text = await fs.readFile(path.join(sparringDir, CONFIG_FILENAME), "utf8");
  } catch {
    return projectRoot;
  }
  const configured = readTomlRepoRoot(text);
  if (!configured) {
    return projectRoot;
  }
  return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
}

export function readTomlRepoRoot(toml: string): string | undefined {
  let inRepo = false;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inRepo = table[1].trim() === "repo";
      continue;
    }
    if (!inRepo) {
      continue;
    }
    const kv = /^root\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(line);
    if (kv) {
      return kv[1] ?? kv[2];
    }
  }
  return undefined;
}

/**
 * Look for `.sparring` directly under one workspace folder. Each folder of a
 * multi-root workspace is probed on its own; folders are never merged.
 */
export async function locateSparringDir(folder: string, folderName?: string): Promise<SparringLocation | undefined> {
  const sparringDir = path.join(folder, SPARRING_DIRNAME);
  try {
    const stat = await fs.stat(sparringDir);
    if (!stat.isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    sparringDir,
    repoRoot: await resolveRepoRoot(sparringDir),
    workspaceFolder: folder,
    folderName: folderName ?? path.basename(folder),
  };
}

/** Probe every workspace folder independently and keep those with `.sparring`. */
export async function locateAll(folders: { path: string; name?: string }[]): Promise<SparringLocation[]> {
  const found = await Promise.all(folders.map((folder) => locateSparringDir(folder.path, folder.name)));
  return found.filter((location): location is SparringLocation => location !== undefined);
}

/** Resolve a recorded plan label (plan.py: plan_label) back to an absolute path. */
export function resolvePlanPath(label: string, repoRoot: string): string {
  if (path.isAbsolute(label) || /^[A-Za-z]:[\\/]/.test(label)) {
    return path.normalize(label);
  }
  return path.join(repoRoot, ...label.split("/"));
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

export async function discoverRuns(locations: SparringLocation[]): Promise<Discovery> {
  const runs: RunSnapshot[] = [];
  const problems: Discovery["problems"] = [];
  for (const location of locations) {
    const planRuns = await discoverPlanRuns(location, problems);
    runs.push(...planRuns);
    runs.push(...(await discoverStandaloneStages(location, planRuns)));
  }
  return { locations, runs, problems };
}

async function discoverPlanRuns(location: SparringLocation, problems: Discovery["problems"]): Promise<PlanRunSnapshot[]> {
  const plansDir = path.join(location.sparringDir, PLANS_DIRNAME);
  const entries = await listDir(plansDir);
  const runs: PlanRunSnapshot[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const statePath = path.join(plansDir, entry);
    try {
      runs.push(await snapshotPlanRun(location, statePath));
    } catch (error) {
      problems.push({ path: statePath, error: (error as Error).message });
    }
  }
  return runs;
}

async function snapshotPlanRun(location: SparringLocation, statePath: string): Promise<PlanRunSnapshot> {
  const [text, stat] = await Promise.all([fs.readFile(statePath, "utf8"), fs.stat(statePath)]);
  const state = parsePlanRunState(text);
  const planKey = path.basename(statePath, ".json");
  const planPath = resolvePlanPath(state.plan, location.repoRoot);

  let planStages: PlanStageHeading[] | undefined;
  let planError: string | undefined;
  try {
    planStages = parsePlanStages(await fs.readFile(planPath, "utf8"), planKey);
    if (planStages.length === 0) {
      planStages = undefined;
      planError = "plan declares no stages";
    }
  } catch (error) {
    planError = (error as Error).message;
  }

  const stagesRoot = path.join(location.sparringDir, STAGES_DIRNAME);
  const stages: StageSnapshot[] = [];
  if (planStages) {
    for (const heading of planStages) {
      stages.push(await snapshotStage(path.join(stagesRoot, heading.stageId), heading.stageId, heading));
    }
  }
  // The recorded current stage is authoritative even if the plan file is
  // gone or was edited: fall back to a snapshot of it by id.
  let currentStage = stages.find((stage) => stage.stageId === state.currentStage);
  if (!currentStage) {
    currentStage = await snapshotStage(path.join(stagesRoot, state.currentStage), state.currentStage, undefined);
    if (planStages && state.currentStageIndex < planStages.length) {
      currentStage.number = state.currentStageIndex + 1;
    }
  }
  const currentOutcome = await readOutcome(currentStage.dir);

  return {
    kind: "plan",
    id: runIdFor(location, "plan", planKey),
    location,
    planKey,
    statePath,
    stateMtimeMs: stat.mtimeMs,
    state,
    planPath,
    planStages,
    planError,
    stages,
    currentStage,
    currentOutcome,
  };
}

async function snapshotStage(dir: string, stageId: string, heading: PlanStageHeading | undefined): Promise<StageSnapshot> {
  const snapshot: StageSnapshot = { stageId, dir, exists: false };
  if (heading) {
    snapshot.number = heading.number;
    snapshot.title = heading.title;
  }
  try {
    snapshot.exists = (await fs.stat(dir)).isDirectory();
  } catch {
    return snapshot;
  }
  try {
    snapshot.state = parseStageState(await fs.readFile(path.join(dir, STATE_FILENAME), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      snapshot.stateError = (error as Error).message;
    }
  }
  return snapshot;
}

async function readOutcome(stageDir: string): Promise<SparringOutcome | undefined> {
  try {
    return parseSparringOutcome(await fs.readFile(path.join(stageDir, SPARRING_FILENAME), "utf8"));
  } catch {
    return undefined;
  }
}

async function discoverStandaloneStages(location: SparringLocation, planRuns: PlanRunSnapshot[]): Promise<StandaloneStageSnapshot[]> {
  const stagesRoot = path.join(location.sparringDir, STAGES_DIRNAME);
  const claimed = new Set<string>();
  const prefixes: string[] = [];
  for (const run of planRuns) {
    prefixes.push(`${run.planKey}-stage-`);
    for (const stage of run.stages) {
      claimed.add(stage.stageId);
    }
    claimed.add(run.currentStage.stageId);
  }
  const out: StandaloneStageSnapshot[] = [];
  for (const name of (await listDir(stagesRoot)).sort()) {
    if (claimed.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    const dir = path.join(stagesRoot, name);
    const statePath = path.join(dir, STATE_FILENAME);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(statePath)).mtimeMs;
    } catch {
      continue; // not a stage the engine created (no state.json)
    }
    const stage = await snapshotStage(dir, name, undefined);
    out.push({ kind: "stage", id: runIdFor(location, "stage", name), location, stage, stateMtimeMs: mtimeMs, outcome: await readOutcome(dir) });
  }
  return out;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

export interface RunSelection {
  selected?: RunSnapshot;
  /** Non-empty when several runs look active and none was explicitly chosen. */
  ambiguous: RunSnapshot[];
}

export function isOpenRun(run: RunSnapshot): boolean {
  if (run.kind === "plan") {
    return run.state.status !== "complete";
  }
  return run.stage.state?.status !== "accepted";
}

/**
 * Deterministic selection:
 *  1. an explicitly preferred run (by id) that still exists always wins, even
 *     when it has become terminal (complete / accepted);
 *  2. exactly one open plan run (status running/paused) is selected;
 *  3. several open plan runs: the remembered (`stickyId`) one if it is among
 *     them, otherwise ambiguous and nothing is selected;
 *  4. no open plan run: the same for open standalone stages;
 *  5. nothing open: the remembered run if it still exists (a run that just
 *     finished stays on screen), else the most recently written terminal run
 *     (complete plan or accepted stage), else nothing.
 *
 * `stickyId` is what the caller last showed; it is a tie-breaker and a
 * fallback, never a reason to ignore a newly started open run.
 */
export function selectRun(runs: RunSnapshot[], preferredId?: string, stickyId?: string): RunSelection {
  if (preferredId) {
    const preferred = runs.find((run) => run.id === preferredId);
    if (preferred) {
      return { selected: preferred, ambiguous: [] };
    }
  }
  const sticky = stickyId ? runs.find((run) => run.id === stickyId) : undefined;

  const openPlans = runs.filter((run): run is PlanRunSnapshot => run.kind === "plan" && isOpenRun(run));
  if (openPlans.length === 1) {
    return { selected: openPlans[0], ambiguous: [] };
  }
  if (openPlans.length > 1) {
    return sticky && openPlans.includes(sticky as PlanRunSnapshot) ? { selected: sticky, ambiguous: [] } : { ambiguous: openPlans };
  }
  const openStages = runs.filter((run): run is StandaloneStageSnapshot => run.kind === "stage" && isOpenRun(run));
  if (openStages.length === 1) {
    return { selected: openStages[0], ambiguous: [] };
  }
  if (openStages.length > 1) {
    return sticky && openStages.includes(sticky as StandaloneStageSnapshot) ? { selected: sticky, ambiguous: [] } : { ambiguous: openStages };
  }
  if (sticky) {
    return { selected: sticky, ambiguous: [] };
  }
  const terminal = runs.slice().sort((a, b) => b.stateMtimeMs - a.stateMtimeMs);
  return { selected: terminal[0], ambiguous: [] };
}

/**
 * Which repository a launch (Run Plan) should target: the selected run's
 * repository first, then the only repository, then the one containing the
 * active document; undefined means the caller must ask.
 */
export function chooseLaunchLocation(locations: SparringLocation[], selected: RunSnapshot | undefined, activeFile?: string): SparringLocation | undefined {
  if (selected) {
    const owner = locations.find((location) => location.workspaceFolder === selected.location.workspaceFolder);
    if (owner) {
      return owner;
    }
  }
  if (locations.length === 1) {
    return locations[0];
  }
  if (activeFile) {
    return locations.find((location) => isInsidePath(activeFile, location.repoRoot) || isInsidePath(activeFile, location.workspaceFolder));
  }
  return undefined;
}

export function isInsidePath(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The stage whose activity.jsonl should be tailed for a run. */
export function activityPathFor(run: RunSnapshot): string {
  const dir = run.kind === "plan" ? run.currentStage.dir : run.stage.dir;
  return path.join(dir, ACTIVITY_FILENAME);
}

export function currentStageOf(run: RunSnapshot): StageSnapshot {
  return run.kind === "plan" ? run.currentStage : run.stage;
}

export function totalStagesOf(run: RunSnapshot): number | undefined {
  return run.kind === "plan" ? run.planStages?.length : undefined;
}

/** Short human label for a run: the plan label or the stage id. */
export function runLabel(run: RunSnapshot): string {
  return run.kind === "plan" ? run.state.plan : run.stage.stageId;
}
