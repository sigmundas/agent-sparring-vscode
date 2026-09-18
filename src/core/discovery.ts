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
  released?: { id: string; reason: "superseded"; by: PlanRunSnapshot } | { id: string; reason: "gone" };
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
  /** What to call it: the root directory's own name, disambiguated when another known root shares it. */
  name: string;
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
export function repositoryOwning(location: SparringLocation, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => containsProject(location, root))
    .sort((a, b) => canonicalPath(b).length - canonicalPath(a).length)[0];
}

function containsProject(location: SparringLocation, root: string): boolean {
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
export function attributeRun(run: RunSnapshot, repoRoot: string, knownRoots: readonly string[] = []): RunAttribution {
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
 */
export type PinIntent = "inspect" | "follow";

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
}

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
 *  5. nothing open: the remembered run if it still exists (a run that just
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
): RunSelection {
  const view: RepositoryScopeView | undefined = scope
    ? { repoRoot: path.resolve(scope.repoRoot), name: repositoryDisplayName(scope.repoRoot, scope.knownRoots ?? []) }
    : undefined;
  const inScope: RunSnapshot[] = [];
  const elsewhere: RunSnapshot[] = [];
  const unattributed: RunSnapshot[] = [];
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

  const pick = typeof preferred === "string" ? { id: preferred } : preferred;
  if (pick) {
    const chosen = runs.find((run) => run.id === pick.id);
    if (!chosen) {
      // Absent from the discovery. That is only a *release* when the project
      // it belongs to was scanned and the run was not there; a project that
      // has not been located yet (a window still starting, a folder briefly
      // unreadable) must not cost someone their pin, so the pin is simply not
      // applied this pass and is kept.
      const gone = locations.some((location) => runIdBelongsTo(pick.id, location));
      return decorate({ ...selectAutomatically(inScope, stickyId), ...(gone ? { released: { id: pick.id, reason: "gone" as const } } : {}) });
    }
    const by = supersedingPlanRun(chosen, runs, pick.atMs ?? 0, ownership, pick.intent ?? "inspect");
    if (!by) {
      return decorate({ selected: chosen, ambiguous: [], pinned: true });
    }
    return decorate({ ...selectAutomatically(inScope, stickyId), released: { id: pick.id, reason: "superseded", by } });
  }
  return decorate(selectAutomatically(inScope, stickyId));
}

/** Whether a run id names a run of this location; run ids are `<projectDir>|<kind>:<key>`. */
function runIdBelongsTo(runId: string, location: SparringLocation): boolean {
  const at = runId.lastIndexOf("|");
  return at > 0 && samePath(runId.slice(0, at), location.projectDir);
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
