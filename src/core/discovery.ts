/**
 * Run discovery: from one or more `.sparring` directories, build snapshots of
 * every recorded plan run (and standalone stages), then apply a deterministic
 * selection rule that never guesses between genuinely ambiguous active runs.
 *
 * Authoritative inputs only: `.sparring/plans/<key>.json`, each stage's
 * `state.json`, the plan Markdown (for stage titles/total) — or, for a run
 * of an approved plan-intake slice, that slice's sealed manifest — and the
 * current stage's `sparring.md` routing outcome. `.sparring/intake/` is read
 * to show a plan intake that has no run yet (core/intake.ts); once a run
 * exists, its state file is the authority. `activity.jsonl` is never read here.
 *
 * No dependency on the vscode API.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  planKey as planKeyOf,
  parsePlanRunState,
  parsePlanStages,
  parseSparringOutcome,
  parseStageState,
  type PlanRunState,
  type PlanStageHeading,
  type SparringOutcome,
  type StageState,
} from "./engineFormats";
import { discoverIntakes, intakeContinuation, isPreRunIntake, nextIntakeSlice, resolveIntakeRun, sliceEligible, sliceRoot, type IntakeRunBinding, type IntakeSliceSnapshot, type IntakeSnapshot } from "./intake";
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
  /**
   * Present when the project is a git worktree found through
   * `git worktree list` of a repository this window knows, outside every
   * workspace folder (see core/worktrees.ts). Its runs are as authoritative
   * as any other; they are only never selected automatically, because
   * nobody asked this window to follow that directory.
   */
  external?: { siblingOf: string; branch?: string };
}

/** A plan intake's selection id, in the same `<projectDir>|<kind>:<key>` space as runs. */
export function intakeIdFor(location: SparringLocation, intakeId: string): string {
  return `${location.projectDir}|intake:${intakeId}`;
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
  /**
   * This run *instance*'s key: which execution of {@link planKey}'s document
   * it is, and the namespace its stage ids carry. Read from the state file's
   * `run` field, falling back to its name — which is what a run recorded
   * before run instances existed is keyed by, and what its stages record as
   * their owner.
   *
   * This is the run's identity. {@link planKey} is the document's, and two
   * snapshots can share it.
   */
  runKey: string;
  /** The plan *document*'s key: what declarations and history are grouped by. */
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
  /**
   * The run's stage list, or undefined if it could not be read. From the plan
   * Markdown's headings, except for an `intake-manifest` run, whose stages are
   * its approved manifest's ({@link intake}) and never the Markdown's.
   */
  planStages?: PlanStageHeading[];
  planError?: string;
  /**
   * For an `intake-manifest` run: the approved slice it executes. `planPath`
   * is then the source Markdown the approval recorded — the human-readable
   * plan, not the input the run resumes from.
   */
  intake?: IntakeRunBinding;
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

/** A plan intake, and the project it was found in. */
export interface DiscoveredIntake extends IntakeSnapshot {
  location: SparringLocation;
}

export interface Discovery {
  locations: SparringLocation[];
  runs: RunSnapshot[];
  /**
   * Every plan intake found under `.sparring/intake/`, whatever its state.
   * Absent from a discovery built before intakes were read, which means none.
   */
  intakes?: DiscoveredIntake[];
  /** Plan-run state files (and intake records) that exist but could not be parsed. */
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

/**
 * Probe one worktree outside the workspace for a `.sparring` at its root (no
 * nested search: a worktree is a repository root, and its own project is what
 * a run there uses). `workspaceFolder` is the worktree itself, since no
 * workspace folder contains it.
 */
export async function locateExternalWorktree(worktree: { path: string; siblingOf: string; branch?: string }): Promise<SparringLocation | undefined> {
  const location = await locationAt(worktree.path, worktree.path, path.basename(worktree.path));
  return location ? { ...location, external: { siblingOf: worktree.siblingOf, ...(worktree.branch ? { branch: worktree.branch } : {}) } } : undefined;
}

/**
 * Probe a worktree the engine's own record names as a run's (`sparring runs
 * --json`) for every project in it, nested ones included: the engine runs a
 * plan picked in a nested project in the same project directory inside the
 * worktree it creates. Which run owns the worktree is still the record's to
 * say; this only finds where its state is.
 */
export async function locateRecordedWorktree(worktree: { path: string; siblingOf: string; branch?: string }, options: LocateOptions = {}): Promise<SparringLocation[]> {
  const found = await locateSparringDirs(worktree.path, path.basename(worktree.path), options);
  return found.map((location) => ({ ...location, external: { siblingOf: worktree.siblingOf, ...(worktree.branch ? { branch: worktree.branch } : {}) } }));
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
  // Run keys are minted unique, and a slice may be run from another project
  // than the one that prepared it, so every discovered run answers for its key.
  const statusByRunKey = new Map(runs.filter((run): run is PlanRunSnapshot => run.kind === "plan").map((run) => [run.runKey, run.state.status]));
  const intakes: DiscoveredIntake[] = [];
  for (const location of locations) {
    const found = await discoverIntakes(location.sparringDir, statusByRunKey);
    intakes.push(...found.intakes.map((intake) => ({ ...intake, location })));
    problems.push(...found.problems);
  }
  return { locations, runs, intakes, problems };
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
  // The file name is the run key for every run ever written: new runs are
  // filed under theirs, and a run recorded before run instances existed is
  // filed under its plan key, which *is* its run key. `state.run` is
  // preferred anyway, so a copied or renamed file cannot make a run answer
  // for another run's stages.
  const runKey = state.run ?? path.basename(statePath, ".json");
  const planKey = planKeyOf(state.plan);

  let planStages: PlanStageHeading[] | undefined;
  let planError: string | undefined;
  let planText: string | undefined;
  let intake: IntakeRunBinding | undefined;
  if (state.source === "intake-manifest") {
    // The approved manifest is the authority for this run's stages: the
    // source Markdown's labels (Stage 0, 1A, 1B) are not what the strict
    // 1..N heading parser reads, and the run executes the manifest anyway.
    try {
      intake = await resolveIntakeRun(location.sparringDir, runKey);
      planStages = intake.stages.map((stage, index) => ({ number: index + 1, stageId: stage.stageId, title: stage.title, label: stage.label }));
      if (planStages.length === 0) {
        planStages = undefined;
        planError = "the approved intake manifest declares no stages";
      }
    } catch (error) {
      planError = (error as Error).message;
    }
  }
  const planPath = intake?.sourcePath ?? resolvePlanPath(state.plan, location.repoRoot);
  try {
    planText = await fs.readFile(planPath, "utf8");
  } catch (error) {
    // For an intake run the Markdown is only the readable source; its absence
    // says nothing about the run's stages.
    if (state.source !== "intake-manifest") {
      planError = (error as Error).message;
    }
  }
  if (planText !== undefined && state.source !== "intake-manifest") {
    // The document's own title is kept whatever the engine-shaped stage parser
    // makes of the rest of it: a plan that carries handoff records is refused
    // as a stage list and still has a name a person recognises.
    try {
      planStages = parsePlanStages(planText, runKey);
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
    id: runIdFor(location, "plan", runKey),
    location,
    runKey,
    planKey,
    statePath,
    stateMtimeMs: stat.mtimeMs,
    state,
    planPath,
    planDocumentTitle: planText === undefined ? undefined : planTitle(planText),
    planStages,
    planError,
    ...(intake ? { intake } : {}),
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
    // By run key, not plan key: a managed run's stages are namespaced by the
    // run that owns them, and a stage of run B must not be claimed by run A
    // merely for executing the same document.
    prefixes.push(`${run.runKey}-stage-`);
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
  /**
   * A plan intake shown in place of finished work: one whose next eligible
   * slice is this repository's (rule 5), or one with no run yet that is newer
   * than the finished work in scope (rule 6). Only ever set by automatic selection,
   * and only when {@link selected} is not.
   */
  intake?: DiscoveredIntake;
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
   * Discovered runs positively attributed to a *different* repository. Never
   * selected automatically, and never hidden from the picker: they are why the
   * empty state can say how much work exists elsewhere instead of implying
   * there is none.
   */
  elsewhere?: RunSnapshot[];
  /**
   * Discovered runs no known repository root owns — a `.sparring` project in a
   * folder that is not a git repository, or one the Git extension has not
   * opened.
   *
   * They are kept apart from {@link elsewhere} because the two are different
   * facts: those are known to be somewhere else, these are not known to be
   * anywhere. Neither is a candidate for automatic selection while a scope is
   * in force — showing a run that cannot be attributed to B under the words
   * "Following the active repository: B" is exactly the claim this cockpit
   * must not make — and both remain reachable through the explicit picker.
   */
  unattributed?: RunSnapshot[];
  /**
   * The stored pin stopped applying on this pass, and why. The caller is
   * expected to **forget it**, which is what makes each release one-way.
   *
   * Without that, a release is a state the selection keeps flipping in and out
   * of. A `follow` pin superseded by its owning plan run came straight back
   * the moment that plan completed — `supersedingPlanRun` requires an *open*
   * owner — so finishing a plan resurrected a pin from before it started and
   * moved the screen for no reason anyone had asked for. A pin that has been
   * let go is gone; the run is still one click away in the picker.
   *
   *  - `superseded` — a `follow` pin whose owning plan run has moved on
   *    ({@link supersedingPlanRun}). `by` is that run.
   *  - `gone` — the pinned run is not in this discovery although its project
   *    still is, so it was deleted rather than merely not scanned yet.
   */
  released?:
    | { id: string; reason: "superseded"; by: PlanRunSnapshot }
    | { id: string; reason: "gone" }
    | { id: string; reason: "repository"; to: string }
    /**
     * An intake shown because an action opened it, not because a person chose
     * it, whose plan has since been prepared again: the selection shows
     * {@link intake} (the plan's current intake) and the caller re-points the
     * stored selection at `to`, keeping its origin.
     */
    | { id: string; reason: "replaced"; to: string };
  /**
   * {@link intake} is a person's explicit choice of an intake that is not its
   * plan's current one; this is the current one. Shown, never followed.
   */
  newerIntake?: DiscoveredIntake;
  /** Why {@link pinned} holds: a person's explicit pin, or an action attachment. */
  pinOrigin?: PinOrigin;
  /**
   * The active repository has moved *into* one that owns an action
   * attachment's work. The caller records this as the attachment's new
   * reference repository, so that moving on again — including back to where
   * it was made — releases it.
   */
  attachedAt?: string;
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
  /** `repoRoot` was chosen in Agent Sparring, not taken from the active editor / Source Control focus. */
  chosen?: boolean;
}

export interface RepositoryScopeView {
  /** Absolute, resolved root. */
  repoRoot: string;
  /** What to call it: the root directory's own name, disambiguated when another known root shares it. */
  name: string;
  /** See {@link RepositoryScope.chosen}. */
  chosen?: boolean;
}

/**
 * What a person calls a repository: its root directory's name, qualified by
 * its parent when another known root has the same name.
 *
 * Never a branch — a branch never identifies a repository — and never a full
 * path. Two worktrees both called `republish-media` under different parents
 * are two different repositories, and naming them both `republish-media` in
 * the context line is worse than not naming them at all.
 */
export function repositoryDisplayName(repoRoot: string, otherRoots: readonly string[] = []): string {
  const resolved = path.resolve(repoRoot);
  const base = path.basename(resolved);
  if (!base) {
    return resolved;
  }
  const clashes = otherRoots.some((other) => !samePath(other, resolved) && path.basename(path.resolve(other)) === base);
  if (!clashes) {
    return base;
  }
  const parent = path.basename(path.dirname(resolved));
  return parent ? `${parent}/${base}` : resolved;
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
export function repositoryOwning(location: Pick<SparringLocation, "repoRoot" | "projectDir">, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => containsProject(location, root))
    .sort((a, b) => canonicalPath(b).length - canonicalPath(a).length)[0];
}

function containsProject(location: Pick<SparringLocation, "repoRoot" | "projectDir">, root: string): boolean {
  for (const dir of [location.repoRoot, location.projectDir]) {
    if (samePath(dir, root) || isInsidePath(dir, root)) {
      return true;
    }
  }
  return false;
}

/** How a run relates to the repository the window is in. */
export type RunAttribution = "here" | "elsewhere" | "unattributed";

/**
 * Whether this run belongs to `repoRoot`, to another known repository, or to
 * none that can be named.
 *
 * The third answer is the one that matters: a run no known root owns is
 * **not** silently adopted by the repository that happens to be active. It
 * stays out of automatic selection and stays in the explicit picker, because
 * "Following the active repository: B" has to mean the run really is B's.
 */
export function attributeRun(run: Pick<RunSnapshot, "location">, repoRoot: string, knownRoots: readonly string[] = []): RunAttribution {
  const roots = [...new Set([repoRoot, ...knownRoots].map((root) => path.resolve(root)))];
  const owner = repositoryOwning(run.location, roots);
  if (owner === undefined) {
    return "unattributed";
  }
  return samePath(owner, repoRoot) ? "here" : "elsewhere";
}

/** The runs positively attributable to one repository; nothing else. */
export function runsInRepository(runs: readonly RunSnapshot[], repoRoot: string, knownRoots: readonly string[] = []): RunSnapshot[] {
  return runs.filter((run) => attributeRun(run, repoRoot, knownRoots) === "here");
}

export function isOpenRun(run: RunSnapshot): boolean {
  if (run.kind === "plan") {
    return run.state.status !== "complete";
  }
  return run.stage.state?.status !== "accepted";
}

/**
 * What an explicit selection *means*, which decides what may release it.
 *
 * The two are genuinely different requests and were conflated:
 *
 *  - `inspect` — the run was already finished when it was chosen. The person
 *    asked to look at history, and nothing about the live world is an answer
 *    to that: only they can end it.
 *  - `follow` — the run was still open when it was chosen. The person asked to
 *    watch *that work*, and when the managed plan run that owns it moves on,
 *    following the plan is the continuation of the same request rather than a
 *    contradiction of it.
 *  - `starting` — a `follow` that was recorded *before* the run existed,
 *    because the extension had just launched it. Identical to `follow` in
 *    every decision, with one exception: a run that is not in the discovery
 *    yet does not release this pin, since the engine writes the run's state
 *    a moment after the terminal is handed the command, and a refresh landing
 *    in that gap must not conclude the run was deleted. It becomes an
 *    ordinary `follow` the first time the run is seen, so a launch that never
 *    produced a run does not leave a pin behind for ever.
 */
export type PinIntent = "inspect" | "follow" | "starting";

/**
 * What the user explicitly chose, when, and what choosing it meant.
 *
 * `intent` is recorded at the moment of choosing because it cannot be
 * recovered later: an open run becomes a finished one, and by the time a
 * selection is being re-evaluated there is nothing left to say whether it was
 * open when it was picked.
 *
 * `atMs` is kept only for a `follow` pin, where it bounds what counts as the
 * owning plan run having advanced *since* the choice. It is deliberately not
 * consulted for an `inspect` pin: a state file's modification time says
 * nothing about whether someone is still reading the stage it belongs to, and
 * using it as though it did is what silently dropped people out of history.
 */
export interface RunPreference {
  id: string;
  /** When it was chosen (epoch ms); absent means "long ago", from before this was recorded. */
  atMs?: number;
  /**
   * What the selection meant. Absent — a pin stored before this was
   * recorded — is read as `inspect`, which is the reading that cannot lose
   * someone's place: the worst it does is keep a pin that its owner could
   * have released with one click, where the other default silently moves the
   * screen out from under them.
   */
  intent?: PinIntent;
  /**
   * Why the selection exists, which decides whether the active repository
   * can end it.
   *
   *  - `explicit` — the person chose this run or intake to keep viewing
   *    (History / Runs). It survives every repository change and only
   *    Follow active repository or another choice ends it.
   *  - `action` — the cockpit attached to it as a side effect of starting,
   *    navigating to or creating work. It is not a pin the person made, and
   *    it ends the moment the active repository moves to one that does not
   *    own it.
   *
   * Absent — a selection stored before this was recorded — reads as
   * `explicit`, the reading that cannot lose someone's place.
   */
  origin?: PinOrigin;
  /**
   * The active repository when an `action` attachment was made. A move is
   * measured against it, so an attachment made while the editor was already
   * elsewhere (the ordinary case: a plan started in another checkout) is not
   * released until the person actually changes repository.
   */
  activeRootAtPin?: string;
}

export type PinOrigin = "explicit" | "action";

/** The intent a run being chosen *now* implies: history is inspected, live work is followed. */
export function intentForChoosing(run: RunSnapshot): PinIntent {
  return isOpenRun(run) ? "follow" : "inspect";
}

/**
 * Which managed plan run owns each standalone stage, keyed by the stage run's
 * id. Built from recorded execution membership only (planMembership.ts); a
 * stage with no entry has no owner, and nothing here guesses one.
 */
export type StageOwnership = ReadonlyMap<string, string>;

/**
 * The plan run that has taken over from a **followed** stage — undefined when
 * none has, and always undefined for a stage someone is inspecting.
 *
 * The case this exists for: a managed run adopts a stage that existed on its
 * own, and when it advances, the stage it left behind becomes an accepted
 * standalone run again (the plan document's own stage list does not always
 * name it, and only the plan's *current* stage is claimed). Someone who
 * selected that stage **while it was still running** asked to watch that work,
 * so following the plan run that continued it is the same request answered;
 * leaving them on a finished screen offering actions the live plan has already
 * taken is not.
 *
 * ### What this must never do
 *
 * Release an explicit visit to history. That is why `intent` is a parameter
 * and not an inference: the ordinary way to pin a historical stage is to pin
 * one the plan has *already* moved past, so `owner.currentStage !== run` is
 * true from the very first moment and every subsequent write to the owner's
 * state file pushed `stateMtimeMs` past `sinceMs` and released the pin. A plan
 * that merely re-recorded its position — the engine writes that file on every
 * transition — silently closed the stage a person was reading. Modification
 * time is evidence that a file changed and evidence of nothing else; it was
 * standing in for "the run advanced past the stage you were following", which
 * it cannot tell you.
 *
 * `ownership` is required, and is recorded membership only: the run that takes
 * over must be the run that **executed this stage**. It used to be any open
 * plan run in the same project whose current stage differed, so an unrelated
 * plan merely being open could claim a stage it had never run.
 *
 * `sinceMs` bounds the advance to one that happened after the choice.
 */
export function supersedingPlanRun(
  run: RunSnapshot,
  runs: readonly RunSnapshot[],
  sinceMs: number,
  ownership: StageOwnership,
  intent: PinIntent = "follow",
): PlanRunSnapshot | undefined {
  // `starting` is a follow; see PinIntent.
  if (intent === "inspect") {
    return undefined;
  }
  if (run.kind !== "stage" || isOpenRun(run)) {
    return undefined;
  }
  const ownerId = ownership.get(run.id);
  if (!ownerId) {
    return undefined;
  }
  const owner = runs.find((candidate): candidate is PlanRunSnapshot => candidate.kind === "plan" && candidate.id === ownerId);
  if (!owner || !isOpenRun(owner) || owner.stateMtimeMs <= sinceMs || owner.currentStage.stageId === run.stage.stageId) {
    return undefined;
  }
  return owner;
}

/** No stage is known to be owned; every caller that has no membership data passes this. */
export const NO_STAGE_OWNERSHIP: StageOwnership = new Map<string, string>();

/**
 * Deterministic selection:
 *  0. when a `scope` is given, automatic selection only ever considers runs
 *     **positively attributable** to that repository. Runs owned by another
 *     known repository are reported as `elsewhere`, and runs no known root
 *     owns as `unattributed`; neither is a candidate. A run in another
 *     repository is never shown, not even the one shown a moment ago: the
 *     remembered (`stickyId`) run is only a candidate while it is in scope, so
 *     switching repository drops the previous repository's run rather than
 *     leaving it on screen. Switching back finds it again, because the memory
 *     was kept, only ignored;
 *  1. an explicitly preferred run (by id) that still exists wins, even when
 *     it has become terminal (complete / accepted), and **regardless of
 *     scope** — pinning a run is how someone asks to inspect history in
 *     another repository, so following the active repository must not undo it.
 *     The selection says so (`pinned`), and the Overview offers the way back.
 *
 *     Exactly three things end a pin, and all three are reported in
 *     `released` so the caller can forget it rather than keep re-deciding it:
 *     the user pinning something else, the user choosing Follow active
 *     repository (both of which simply replace or clear the stored pin), and
 *     the run itself ceasing to exist. A `follow` pin — one made while the run
 *     was still open — additionally hands over to the managed plan run that
 *     continued it (`supersedingPlanRun`). An `inspect` pin never does: a
 *     plan re-recording its position is not a reason to close the history
 *     someone is reading;
 *  2. exactly one open plan run (status running/paused) is selected;
 *  3. several open plan runs: the remembered (`stickyId`) one if it is among
 *     them, otherwise ambiguous and nothing is selected;
 *  4. no open plan run: the same for open standalone stages;
 *  5. nothing open, and a plan intake is *continuing* here: the run of an
 *     earlier slice of it is complete, and its next
 *     eligible slice — every earlier slice the engine recorded for it
 *     complete — belongs to this repository (see {@link continuingIntake}).
 *     That intake is current work wherever it was prepared, and outranks
 *     every finished run whatever their times: the plan's next step is not
 *     history. Only the newest intake of a plan counts;
 *  6. nothing open, and a plan intake in scope is waiting on a person or a
 *     first `run-plan` (prepared or slice-approved) and is *newer* than every
 *     finished run: that intake (`intake`), with no run selected. Newer is
 *     judged only from the time the engine recorded for the intake; one whose
 *     `created_at` cannot be read is never promoted, so an abandoned or
 *     unreadable intake cannot take the screen from finished work;
 *  7. otherwise: the remembered run if it still exists (a run that just
 *     finished stays on screen), else the most recently written terminal run
 *     (complete plan or accepted stage), else nothing.
 *
 * `stickyId` is what the caller last showed; it is a tie-breaker and a
 * fallback, never a reason to ignore a newly started open run.
 */
export function selectRun(
  runs: RunSnapshot[],
  preferred?: string | RunPreference,
  stickyId?: string,
  scope?: RepositoryScope,
  ownership: StageOwnership = NO_STAGE_OWNERSHIP,
  /**
   * The projects this discovery actually scanned. Only used to tell a pinned
   * run that was *deleted* from one that simply has not been located yet; with
   * none supplied, a missing pin is never reported as released, which is the
   * conservative answer.
   */
  locations: readonly SparringLocation[] = [],
  /** The discovery's plan intakes; see rules 5 and 6. */
  intakes: readonly DiscoveredIntake[] = [],
): RunSelection {
  const view: RepositoryScopeView | undefined = scope
    ? { repoRoot: path.resolve(scope.repoRoot), name: repositoryDisplayName(scope.repoRoot, scope.knownRoots ?? []), ...(scope.chosen ? { chosen: true } : {}) }
    : undefined;
  const inScope: RunSnapshot[] = [];
  const elsewhere: RunSnapshot[] = [];
  const unattributed: RunSnapshot[] = [];
  const intakesInScope = scope ? intakes.filter((intake) => attributeRun(intake, scope.repoRoot, scope.knownRoots ?? []) === "here") : intakes;
  const continuing = continuingIntake(intakes, scope);
  const automatic = (): RunSelection => selectAutomatically(inScope, stickyId, intakesInScope, continuing);
  for (const run of runs) {
    if (!scope) {
      inScope.push(run);
      continue;
    }
    const where = attributeRun(run, scope.repoRoot, scope.knownRoots ?? []);
    (where === "here" ? inScope : where === "elsewhere" ? elsewhere : unattributed).push(run);
  }
  const decorate = (selection: RunSelection): RunSelection => ({
    ...selection,
    ...(view ? { scope: view } : {}),
    ...(elsewhere.length > 0 ? { elsewhere } : {}),
    ...(unattributed.length > 0 ? { unattributed } : {}),
  });

  const pick: RunPreference | undefined = typeof preferred === "string" ? { id: preferred } : preferred;
  if (pick) {
    const origin: PinOrigin = pick.origin ?? "explicit";
    const pinnedIntake = intakes.find((intake) => intakeIdFor(intake.location, intake.record.intakeId) === pick.id);
    const chosen = runs.find((run) => run.id === pick.id);
    // An action attachment ends when the active repository has moved since
    // it was made, to one that does not own what it shows.
    let attachedAt: string | undefined;
    if (origin === "action" && scope && !sameRoot(scope.repoRoot, pick.activeRootAtPin)) {
      const target = chosen ?? pinnedIntake;
      const owned = chosen ? attributeRun(chosen, scope.repoRoot, scope.knownRoots ?? []) === "here" : pinnedIntake !== undefined && (attributeRun(pinnedIntake, scope.repoRoot, scope.knownRoots ?? []) === "here" || pinnedIntake === continuing);
      if (!target || !owned) {
        return decorate({ ...automatic(), released: { id: pick.id, reason: "repository", to: scope.repoRoot } });
      }
      attachedAt = scope.repoRoot;
    }
    if (pick.id.includes("|intake:")) {
      if (pinnedIntake) {
        // A plan's current intake is its newest USABLE one in that project;
        // an intake still being prepared, or left behind by a failed prepare,
        // is never followed to. Only a person's explicit choice keeps an
        // older one on screen, labelled.
        const current = currentIntakeOf(pinnedIntake, intakes);
        if (current !== pinnedIntake && origin !== "explicit") {
          const to = intakeIdFor(current.location, current.record.intakeId);
          return decorate({ ambiguous: [], intake: current, pinned: true, pinOrigin: origin, released: { id: pick.id, reason: "replaced", to }, ...(attachedAt ? { attachedAt } : {}) });
        }
        return decorate({
          ambiguous: [],
          intake: pinnedIntake,
          pinned: true,
          pinOrigin: origin,
          ...(current !== pinnedIntake ? { newerIntake: current } : {}),
          ...(attachedAt ? { attachedAt } : {}),
        });
      }
      const gone = locations.some((location) => runIdBelongsTo(pick.id, location));
      return decorate({ ...automatic(), ...(gone ? { released: { id: pick.id, reason: "gone" as const } } : {}) });
    }
    if (!chosen) {
      // Absent from the discovery. That is only a *release* when the project
      // it belongs to was scanned and the run was not there; a project that
      // has not been located yet (a window still starting, a folder briefly
      // unreadable) must not cost someone their pin, so the pin is simply not
      // applied this pass and is kept.
      // A pin recorded for a run that is still being started is the one
      // case where "scanned and absent" does not mean deleted: the engine
      // writes the run state just after the command reaches the terminal.
      const gone = pick.intent !== "starting" && locations.some((location) => runIdBelongsTo(pick.id, location));
      return decorate({ ...automatic(), ...(gone ? { released: { id: pick.id, reason: "gone" as const } } : {}) });
    }
    const by = supersedingPlanRun(chosen, runs, pick.atMs ?? 0, ownership, pick.intent ?? "inspect");
    if (!by) {
      return decorate({ selected: chosen, ambiguous: [], pinned: true, pinOrigin: origin, ...(attachedAt ? { attachedAt } : {}) });
    }
    return decorate({ ...automatic(), released: { id: pick.id, reason: "superseded", by } });
  }
  return decorate(automatic());
}

/**
 * The newest USABLE intake of each plan, per project. Preparing a plan again
 * supersedes the earlier proposal, but only once that newer prepare is known
 * finished ({@link IntakeSnapshot.usable}) — an intake still being written, or
 * left behind by a prepare that failed after `intake.json` but before its
 * completion marker, is never newest here, however recent its `created_at`.
 * It stays out of this list, not merely behind the older one: the caller sees
 * exactly the same result as if it did not exist yet. A plan with an intake
 * whose age cannot be read has no knowable newest intake — the unreadable one
 * may be the prepare that replaced the others — so none of that plan's
 * intakes is returned.
 */
function newestIntakePerPlan(intakes: readonly DiscoveredIntake[]): DiscoveredIntake[] {
  const newestPerPlan = new Map<string, DiscoveredIntake>();
  const unordered = new Set(intakes.filter((intake) => intake.record.createdAtMs === undefined).map((intake) => `${intake.location.projectDir}|${intake.record.planLabel}`));
  for (const intake of intakes) {
    const created = intake.record.createdAtMs;
    const key = `${intake.location.projectDir}|${intake.record.planLabel}`;
    if (created === undefined || unordered.has(key) || !intake.usable) {
      continue;
    }
    const held = newestPerPlan.get(key);
    if (!held || created > (held.record.createdAtMs ?? -Infinity)) {
      newestPerPlan.set(key, intake);
    }
  }
  return [...newestPerPlan.values()];
}

/**
 * The current intake of `intake`'s plan: the newest USABLE one prepared for
 * the same plan in the same project, which is `intake` itself when it is the
 * newest, when the plan's intakes cannot all be ordered, or when none of them
 * is usable yet (see {@link newestIntakePerPlan}) — including `intake` itself,
 * so an unusable intake is still shown as its own current rather than
 * resolving to nothing. Recent run activity and the active repository play
 * no part.
 */
export function currentIntakeOf(intake: DiscoveredIntake, intakes: readonly DiscoveredIntake[]): DiscoveredIntake {
  const key = (entry: DiscoveredIntake) => `${entry.location.projectDir}|${entry.record.planLabel}`;
  return newestIntakePerPlan(intakes.filter((entry) => key(entry) === key(intake)))[0] ?? intake;
}

/**
 * The repository an intake's next slice is approved in and run from: the
 * approval's worktree once it has one, else the path intake recorded for the
 * slice's primary repository. Display attribution only — approve-plan and
 * run-plan re-check the repository, branch and HEAD themselves.
 */
export function nextIntakeSliceRoot(intake: IntakeSnapshot): string | undefined {
  const next = nextIntakeSlice(intake);
  return next ? sliceRoot(next) : undefined;
}

/**
 * The intake an `intake-manifest` run executes a slice of, among the
 * discovered ones: the directory its binding names, never a newer proposal of
 * the same plan. Undefined for a standalone run.
 */
export function intakeOfRun(run: RunSnapshot, intakes: readonly DiscoveredIntake[] | undefined): DiscoveredIntake | undefined {
  if (run.kind !== "plan" || !run.intake) {
    return undefined;
  }
  const binding = run.intake;
  return (intakes ?? []).find((intake) => samePath(intake.dir, binding.intakeDir) && intake.slices.some((slice) => slice.runId === binding.runId));
}

/** The work What's next names for a finished intake-backed run: the intake, its next slice, and the repository it runs in. */
export interface NextWork {
  intake: DiscoveredIntake;
  slice: IntakeSliceSnapshot;
  root: string;
}

/**
 * The next work after `run`, exactly as What's next computes it — the
 * continuation of the intake the run's own binding names, not the plan's
 * newest intake — or undefined when there is none to go to yet: no intake,
 * the plan complete or waiting, or the run itself still open.
 *
 * "Show next stage" navigates to this. It must not rely on current-work
 * selection reaching the same answer: that selection only considers a plan's
 * newest intake, and a repository that does not change selects nothing new.
 */
export function nextWorkOf(run: RunSnapshot, intakes: readonly DiscoveredIntake[] | undefined): NextWork | undefined {
  const intake = intakeOfRun(run, intakes);
  if (!intake || run.kind !== "plan" || !run.intake) {
    return undefined;
  }
  const continuation = intakeContinuation(intake, run.intake.runId);
  const root = continuation.kind === "next" && !continuation.afterCurrent ? sliceRoot(continuation.slice) : undefined;
  return continuation.kind === "next" && root ? { intake, slice: continuation.slice, root } : undefined;
}

/**
 * The selection preference that shows `next`: its intake, pinned as a
 * person's explicit choice — the click is one — so it is shown whatever
 * repository is followed and is not swapped for a newer intake of the plan
 * whose next work is different. Nothing is approved or started.
 */
export function nextWorkPreference(next: NextWork, atMs: number): RunPreference {
  return { id: intakeIdFor(next.intake.location, next.intake.record.intakeId), atMs, intent: "inspect", origin: "explicit" };
}

/**
 * The repository among `roots` that owns `root` — the canonical identity
 * current-work selection uses — or undefined when none does.
 */
export function owningRoot(root: string, roots: readonly string[]): string | undefined {
  return repositoryOwning({ repoRoot: root, projectDir: root }, [...new Set(roots.map((entry) => path.resolve(entry)))]);
}

/**
 * The intake whose plan continues in the followed repository (rule 5 of
 * {@link selectRun}), if any.
 *
 * Continuing means: it is waiting on a person or a first `run-plan` (not
 * running), the run of at least one of its slices is complete — the plan has
 * actually advanced, so an approval that was never started is still judged
 * by rule 6's age test, which keeps an abandoned intake from taking the
 * screen — its next slice's
 * earlier slices — as the engine recorded them — are all complete, and that
 * next slice's repository is `scope`'s. The intake's own location does not
 * matter: a plan prepared in one repository hands its next slice to another.
 * Without a scope, any continuing intake qualifies. When several do, the
 * most recently active wins; one whose activity cannot be read never does.
 *
 * Eligibility here decides only what is shown. Whether the slice may be
 * approved or started is the engine's answer, not this function's.
 */
export function continuingIntake(intakes: readonly DiscoveredIntake[], scope?: RepositoryScope): DiscoveredIntake | undefined {
  const candidates = newestIntakePerPlan(intakes).filter((intake) => {
    if (!isPreRunIntake(intake) || intake.activityMs === undefined || !intake.slices.some((slice) => slice.state === "complete")) {
      return false;
    }
    const next = nextIntakeSlice(intake);
    const root = nextIntakeSliceRoot(intake);
    if (!next || !root) {
      return false;
    }
    if (!sliceEligible(intake, next)) {
      return false;
    }
    if (!scope) {
      return true;
    }
    const owner = owningRoot(root, [scope.repoRoot, ...(scope.knownRoots ?? [])]);
    return owner !== undefined && samePath(owner, scope.repoRoot);
  });
  return candidates.sort((a, b) => (b.activityMs ?? 0) - (a.activityMs ?? 0))[0];
}

/**
 * The pre-run plan intake that should take the place of finished work, if any
 * (rule 6 of {@link selectRun}).
 *
 * Only the newest intake of each plan counts — preparing a plan again
 * supersedes the earlier proposal — and only while it is prepared or
 * slice-approved. It must be strictly newer than every finished run in
 * scope, judged by the time the engine recorded for it; with no readable
 * `created_at` it has no age and is never promoted.
 */
export function promotableIntake(intakes: readonly DiscoveredIntake[], runs: readonly RunSnapshot[]): DiscoveredIntake | undefined {
  const candidates = newestIntakePerPlan(intakes).filter((intake) => isPreRunIntake(intake) && intake.activityMs !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }
  const newest = candidates.sort((a, b) => (b.activityMs ?? 0) - (a.activityMs ?? 0))[0];
  const lastFinishedMs = runs.filter((run) => !isOpenRun(run)).reduce((latest, run) => Math.max(latest, run.stateMtimeMs), -Infinity);
  return (newest.activityMs ?? -Infinity) > lastFinishedMs ? newest : undefined;
}

function sameRoot(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined ? a === b : samePath(a, b);
}

/** Whether a run id names a run of this location; run ids are `<projectDir>|<kind>:<key>`. */
function runIdBelongsTo(runId: string, location: SparringLocation): boolean {
  const at = runId.lastIndexOf("|");
  return at > 0 && samePath(runId.slice(0, at), location.projectDir);
}

function selectAutomatically(runs: RunSnapshot[], stickyId?: string, intakes: readonly DiscoveredIntake[] = [], continuing?: DiscoveredIntake): RunSelection {
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
  if (continuing) {
    return { ambiguous: [], intake: continuing };
  }
  const intake = promotableIntake(intakes, runs);
  if (intake) {
    return { ambiguous: [], intake };
  }
  if (sticky) {
    return { selected: sticky, ambiguous: [] };
  }
  const terminal = runs.slice().sort((a, b) => b.stateMtimeMs - a.stateMtimeMs);
  return { selected: terminal[0], ambiguous: [] };
}

export function isInsidePath(file: string, root: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(file));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * One spelling of a path, for comparison only.
 *
 * macOS and Windows default to case-insensitive file systems, so `/Users/x/Repo`
 * and `/Users/x/repo` are the same directory; the Git extension reports a
 * repository root in whatever case git recorded, while a workspace folder keeps
 * whatever case the user opened. Comparing them literally attributed a run to
 * no repository at all, which — now that an unattributable run is never
 * selected automatically — would have emptied the cockpit.
 *
 * Case is all this can fix. Symlinks (`/tmp` → `/private/tmp` on macOS) need
 * `fs.realpath`, which is I/O and therefore belongs to the caller: the
 * extension resolves the Git extension's roots and passes both spellings (see
 * SparringController.repositoryScope).
 */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** Whether two paths name the same location, as far as {@link canonicalPath} can tell. */
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
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
