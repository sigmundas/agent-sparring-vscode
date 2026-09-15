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
import { planTitle } from "./planAssociation";

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
  /**
   * The directory that owns `.sparring` (its parent): the project the engine
   * manages. Equal to `workspaceFolder` for a `.sparring` directly under a
   * workspace folder; deeper for a repository nested inside one (e.g. a git
   * worktree checked out under a parent folder). Every run id is prefixed
   * with it, so two repositories with identical stage ids never collide and
   * a persisted selection names the repository too.
   */
  projectDir: string;
  /** Absolute repository root the engine would use (see resolveRepoRoot). */
  repoRoot: string;
  /** fsPath of the VS Code workspace folder the project was found under. */
  workspaceFolder: string;
  /**
   * Short display name: the workspace folder's name, or for a nested
   * project the name of its directory (what the Explorer shows as the node).
   */
  folderName: string;
}

export function runIdFor(location: SparringLocation, kind: "plan" | "stage", key: string): string {
  return `${location.projectDir}|${kind}:${key}`;
}

/** Whether a location's project is nested below (not directly at) its workspace folder. */
export function isNestedLocation(location: SparringLocation): boolean {
  return path.resolve(location.projectDir) !== path.resolve(location.workspaceFolder);
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
  /**
   * The plan document's own `# ` title, when it has one. What a person calls
   * the job — "Reported statistics and explicit range semantics" — as opposed
   * to `state.plan`, which is the repo-relative file path the engine records.
   * Read from the same document as `planStages`, and available even when the
   * engine-shaped stage parser refuses it.
   */
  planDocumentTitle?: string;
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
  return locationAt(folder, folder, folderName ?? path.basename(folder));
}

async function locationAt(projectDir: string, workspaceFolder: string, folderName: string): Promise<SparringLocation | undefined> {
  const sparringDir = path.join(projectDir, SPARRING_DIRNAME);
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
    projectDir,
    repoRoot: await resolveRepoRoot(sparringDir),
    workspaceFolder,
    folderName,
  };
}

/** How deep below a workspace folder nested projects are looked for by default. */
export const DEFAULT_NESTED_SEARCH_DEPTH = 2;

/**
 * Directory names never descended into while looking for nested projects.
 * Hidden directories (leading dot) are skipped as well. The engine never
 * writes `.sparring` inside any of these.
 */
export const NESTED_SEARCH_SKIP: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "venv",
  "__pycache__",
  "site-packages",
  "vendor",
  "bower_components",
  "coverage",
]);

export interface LocateOptions {
  /**
   * Maximum depth below a workspace folder at which a nested project's
   * `.sparring` is still discovered; 0 probes only the folder itself.
   */
  nestedSearchDepth?: number;
}

/**
 * Probe one workspace folder: `.sparring` directly under it, plus every
 * nested project directory (`<folder>/<a>/.sparring`, `<folder>/<a>/<b>/.sparring`,
 * ... up to `nestedSearchDepth`). A directory that owns a `.sparring` is a
 * project root and is not searched further down; hidden and build/dependency
 * directories are never entered; symbolic links are not followed.
 *
 * Nested projects are what the Explorer shows as child nodes of a workspace
 * folder (a git worktree checked out under a parent folder, a monorepo
 * package): a `.sparring/stages/<id>/state.json` there is as authoritative
 * as one directly under the folder.
 */
export async function locateSparringDirs(folder: string, folderName?: string, options: LocateOptions = {}): Promise<SparringLocation[]> {
  const maxDepth = Math.max(0, options.nestedSearchDepth ?? DEFAULT_NESTED_SEARCH_DEPTH);
  const found: SparringLocation[] = [];
  const top = await locationAt(folder, folder, folderName ?? path.basename(folder));
  if (top) {
    found.push(top);
  }
  let frontier = [folder];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      for (const child of await listSearchableSubdirs(dir)) {
        const location = await locationAt(child, folder, path.basename(child));
        if (location) {
          found.push(location); // a project root: do not look inside it
        } else {
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return found;
}

async function listSearchableSubdirs(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !NESTED_SEARCH_SKIP.has(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Probe every workspace folder independently (each including its nested
 * projects) and keep every `.sparring` found. Folders are never merged.
 */
export async function locateAll(folders: { path: string; name?: string }[], options: LocateOptions = {}): Promise<SparringLocation[]> {
  const found = await Promise.all(folders.map((folder) => locateSparringDirs(folder.path, folder.name, options)));
  return found.flat();
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
  let planText: string | undefined;
  try {
    planText = await fs.readFile(planPath, "utf8");
  } catch (error) {
    planError = (error as Error).message;
  }
  if (planText !== undefined) {
    // The document's own title is kept whatever the engine-shaped stage parser
    // makes of the rest of it: a plan that carries handoff records is refused
    // as a stage list and still has a name a person recognises.
    try {
      planStages = parsePlanStages(planText, planKey);
      if (planStages.length === 0) {
        planStages = undefined;
        planError = "plan declares no stages";
      }
    } catch (error) {
      planError = (error as Error).message;
    }
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
    planDocumentTitle: planText === undefined ? undefined : planTitle(planText),
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
  /**
   * The repository automatic selection was confined to, when the window is
   * following one (see {@link RepositoryScope}). Present whether or not a run
   * was found there, because "no run in this repository" is only an honest
   * thing to say if we can name the repository.
   */
  scope?: RepositoryScopeView;
  /** True when `selected` is the user's explicit pin rather than automatic selection. */
  pinned?: boolean;
  /**
   * Discovered runs in other repositories. Never selected automatically, and
   * never hidden from the picker: they are why the empty state can say how
   * much work exists elsewhere instead of implying there is none.
   */
  elsewhere?: RunSnapshot[];
}

/**
 * Confine automatic selection to one repository: the one this window is
 * currently in (see core/activeRepository.ts).
 *
 * `knownRoots` is every repository root the window can see, and it matters:
 * a run is attributed to the *deepest* known root that contains it, so a
 * nested checkout or a worktree living inside a parent repository belongs to
 * itself rather than to its container. Repository roots only — a branch name
 * never identifies a repository, and two worktrees of the same repository are
 * two repositories here.
 */
export interface RepositoryScope {
  /** Absolute root of the repository the window is following. */
  repoRoot: string;
  /** Every repository root the window can see, including `repoRoot`. */
  knownRoots?: readonly string[];
}

export interface RepositoryScopeView {
  /** Absolute, resolved root. */
  repoRoot: string;
  /** What to call it: the root directory's own name. */
  name: string;
}

/** What a person calls a repository: its root directory's name. Never a branch, never a path. */
export function repositoryDisplayName(repoRoot: string): string {
  return path.basename(path.resolve(repoRoot)) || path.resolve(repoRoot);
}

/**
 * Which of `roots` owns this project: the deepest one containing it, or
 * `undefined` when none does.
 *
 * Deepest wins because repository roots nest — a worktree checked out under
 * its parent repository, a monorepo package that is its own checkout. Matching
 * shallowest-first would hand every nested project to the container and make
 * two unrelated repositories look like one.
 */
export function repositoryOwning(location: SparringLocation, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => containsProject(location, root))
    .sort((a, b) => path.resolve(b).length - path.resolve(a).length)[0];
}

function containsProject(location: SparringLocation, root: string): boolean {
  const resolved = path.resolve(root);
  for (const dir of [location.repoRoot, location.projectDir]) {
    if (path.resolve(dir) === resolved || isInsidePath(dir, resolved)) {
      return true;
    }
  }
  return false;
}

/**
 * The runs belonging to one repository.
 *
 * A run that no known root owns is **kept**: it could not be attributed, so
 * scoping must not hide it. That is what keeps a `.sparring` project in a
 * folder that is not a git repository — or one the Git extension has not
 * opened — visible instead of silently unreachable.
 */
export function runsInRepository(runs: readonly RunSnapshot[], repoRoot: string, knownRoots: readonly string[] = []): RunSnapshot[] {
  const target = path.resolve(repoRoot);
  const roots = [...new Set([repoRoot, ...knownRoots].map((root) => path.resolve(root)))];
  return runs.filter((run) => {
    const owner = repositoryOwning(run.location, roots);
    return owner === undefined || path.resolve(owner) === target;
  });
}

export function isOpenRun(run: RunSnapshot): boolean {
  if (run.kind === "plan") {
    return run.state.status !== "complete";
  }
  return run.stage.state?.status !== "accepted";
}

/**
 * What the user explicitly chose, and when. The timestamp is what lets an
 * old choice be told from a deliberate one: a managed plan run that has
 * advanced *since* the choice has overtaken it (see `supersedingPlanRun`),
 * while opening a finished stage as history right now is respected.
 */
export interface RunPreference {
  id: string;
  /** When it was chosen (epoch ms); absent means "long ago", from before this was recorded. */
  atMs?: number;
}

/**
 * The open plan run that has taken over from `run` — undefined when none
 * has. A managed run adopts stages that existed on their own; when it then
 * advances, the stage it has left behind becomes an accepted standalone run
 * again (the plan document's own stage list does not always name it, and
 * only the plan's *current* stage is claimed). Following that stage would
 * show a finished screen offering actions the live plan has already taken.
 *
 * `sinceMs` keeps a deliberate visit to that history: only a plan run whose
 * state was written after that moment counts as having advanced past it.
 */
export function supersedingPlanRun(run: RunSnapshot, runs: readonly RunSnapshot[], sinceMs = 0): PlanRunSnapshot | undefined {
  if (run.kind !== "stage" || isOpenRun(run)) {
    return undefined;
  }
  return runs.find(
    (candidate): candidate is PlanRunSnapshot =>
      candidate.kind === "plan" &&
      isOpenRun(candidate) &&
      candidate.location.projectDir === run.location.projectDir &&
      candidate.stateMtimeMs > sinceMs &&
      candidate.currentStage.stageId !== run.stage.stageId,
  );
}

/**
 * Deterministic selection:
 *  0. when a `scope` is given, automatic selection only ever considers runs in
 *     that repository, and every run elsewhere is reported as `elsewhere`. A
 *     run in another repository is never shown, not even the one shown a
 *     moment ago: the remembered (`stickyId`) run is only a candidate while it
 *     is in scope, so switching repository drops the previous repository's run
 *     rather than leaving it on screen. Switching back finds it again, because
 *     the memory was kept, only ignored;
 *  1. an explicitly preferred run (by id) that still exists wins, even when
 *     it has become terminal (complete / accepted), and **regardless of
 *     scope** — pinning a run is how someone asks to inspect history in
 *     another repository, so following the active repository must not undo it.
 *     The selection says so (`pinned`), and the Overview offers the way back.
 *     The one exception is unchanged: a managed plan run in the same project
 *     that has advanced past it since it was chosen takes over
 *     (`supersedingPlanRun`);
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
export function selectRun(runs: RunSnapshot[], preferred?: string | RunPreference, stickyId?: string, scope?: RepositoryScope): RunSelection {
  const view: RepositoryScopeView | undefined = scope
    ? { repoRoot: path.resolve(scope.repoRoot), name: repositoryDisplayName(scope.repoRoot) }
    : undefined;
  const inScope = scope ? runsInRepository(runs, scope.repoRoot, scope.knownRoots ?? []) : runs;
  const elsewhere = scope ? runs.filter((run) => !inScope.includes(run)) : [];
  const decorate = (selection: RunSelection): RunSelection => ({
    ...selection,
    ...(view ? { scope: view } : {}),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
  });

  const pick = typeof preferred === "string" ? { id: preferred } : preferred;
  if (pick) {
    const chosen = runs.find((run) => run.id === pick.id);
    if (chosen && !supersedingPlanRun(chosen, runs, pick.atMs ?? 0)) {
      return decorate({ selected: chosen, ambiguous: [], pinned: true });
    }
  }
  return decorate(selectAutomatically(inScope, stickyId));
}

function selectAutomatically(runs: RunSnapshot[], stickyId?: string): RunSelection {
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
    const owner = locations.find((location) => location.projectDir === selected.location.projectDir);
    if (owner) {
      return owner;
    }
  }
  if (locations.length === 1) {
    return locations[0];
  }
  if (activeFile) {
    // A nested project's directory lies inside its parent's too: the deepest
    // (most specific) match owns the file.
    return locations
      .filter((location) => isInsidePath(activeFile, location.repoRoot) || isInsidePath(activeFile, location.projectDir))
      .sort((a, b) => b.projectDir.length - a.projectDir.length)[0];
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
