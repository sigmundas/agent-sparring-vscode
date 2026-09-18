/**
 * "Diagnose Discovery": a structured, privacy-safe trace of the production
 * discovery path for every workspace folder, whatever its scheme:
 *
 *   workspace folder → probed `.sparring` path(s) → stage / plan files →
 *   parse results (lifecycle status only) → runs → selection → why none.
 *
 * Nothing here logs file contents, prompts, evidence, session ids,
 * environment values or secrets: only paths, existence, parse success and
 * the lifecycle status words the engine itself writes.
 *
 * No dependency on the vscode API.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CONFIG_FILENAME,
  PLANS_DIRNAME,
  SPARRING_DIRNAME,
  STAGES_DIRNAME,
  STATE_FILENAME,
  discoverRuns,
  isNestedLocation,
  locateSparringDirs,
  runLabel,
  selectRun,
  type LocateOptions,
  type PlanRunSnapshot,
  type RepositoryScope,
  type RunSnapshot,
  type SparringLocation,
} from "./discovery";
import { EngineFormatError, parsePlanRunState, parseStageState } from "./engineFormats";
import { describeReadiness, type GitReadiness } from "./gitReadiness";
import type { ManifestStageIdentity } from "./manifest";
import { resolveMemberships, stageOwnership } from "./planMembership";
import { buildRunPickGroups } from "./runPick";

export interface DiagnosticFolder {
  index: number;
  name: string;
  scheme: string;
  fsPath: string;
}

export interface StageDiagnostic {
  name: string;
  stateExists: boolean;
  parsed?: boolean;
  /** Lifecycle status only (`working` / `frozen` / `accepted`). */
  status?: string;
  /** Parse failure class; never file contents. */
  parseError?: string;
}

export interface PlanDiagnostic {
  file: string;
  parsed: boolean;
  status?: string;
  parseError?: string;
}

export interface LocationDiagnostic {
  sparringDir: string;
  projectDir: string;
  repoRoot: string;
  nested: boolean;
  configExists: boolean;
  stagesExists: boolean;
  plansExists: boolean;
  stages: StageDiagnostic[];
  plans: PlanDiagnostic[];
  /** Run ids produced by discoverRuns for this location. */
  runIds: string[];
}

export interface FolderDiagnostic extends DiagnosticFolder {
  /** Set when the folder was not probed at all (non-file scheme). */
  skipped?: string;
  /** Exact `.sparring` path probed directly under the folder. */
  probed: string;
  sparringExists: boolean;
  locations: LocationDiagnostic[];
}

export interface DiscoveryDiagnostic {
  folders: FolderDiagnostic[];
  problems: { path: string; error: string }[];
  runs: { id: string; kind: string; label: string; open: boolean }[];
  preferredId?: string;
  stickyId?: string;
  /** The repository automatic selection was confined to, and the roots it was attributed against. */
  scope?: { repoRoot: string; name: string; knownRoots: string[] };
  /** Whether the built-in Git extension's API is attached; without it nothing is scoped. */
  gitAttached?: boolean;
  /**
   * How much that extension has actually told us (core/gitReadiness.ts).
   * Reported separately from `gitAttached` because the two are different
   * moments: the API object can exist while repository discovery is still
   * running, and its `repositories` array is empty and meaningless then.
   */
  gitReadiness?: GitReadiness;
  /** Runs positively attributed to another repository, so "no run here" can be told from "no run anywhere". */
  elsewhereIds?: string[];
  /** Runs no known repository root owns; never candidates for automatic selection, always in the picker. */
  unattributedIds?: string[];
  /**
   * What "Select Repository / Run" would list, in order, one string per row:
   * `<group> | <label> — <description> — <detail>`. The group is included
   * because the picker separates plan runs from standalone stages, and the
   * detail because a diagnostic is exactly where the raw stage id belongs.
   */
  pickLabels: string[];
  selectedId?: string;
  ambiguousIds: string[];
  /** Human explanation when nothing is selected. */
  noSelectionReason?: string;
}

export interface DiagnoseOptions extends LocateOptions {
  preferredId?: string;
  stickyId?: string;
  /** What the window is following; see core/activeRepository.ts. */
  scope?: RepositoryScope;
  /** Whether the Git extension's API was attached when the report was taken. */
  gitAttached?: boolean;
  /** And how far its repository discovery had got; see {@link DiscoveryDiagnostic.gitReadiness}. */
  gitReadiness?: GitReadiness;
  /**
   * The stage identities of a managed run's execution manifest, when the
   * caller can read them (the extension's cached reader). Supplying it is what
   * lets the report say which plan run each standalone stage belongs to —
   * exactly the question this diagnostic exists to answer — and without it the
   * rows are still grouped, just not annotated.
   */
  manifestStages?: (run: PlanRunSnapshot) => Promise<readonly ManifestStageIdentity[] | undefined>;
}

export async function diagnoseDiscovery(folders: DiagnosticFolder[], options: DiagnoseOptions = {}): Promise<DiscoveryDiagnostic> {
  const folderReports: FolderDiagnostic[] = [];
  const allLocations: SparringLocation[] = [];
  for (const folder of folders) {
    const probed = path.join(folder.fsPath, SPARRING_DIRNAME);
    if (folder.scheme !== "file") {
      folderReports.push({ ...folder, skipped: `scheme "${folder.scheme}" is not "file"; only local folders are probed`, probed, sparringExists: false, locations: [] });
      continue;
    }
    const locations = await locateSparringDirs(folder.fsPath, folder.name, options);
    allLocations.push(...locations);
    folderReports.push({
      ...folder,
      probed,
      sparringExists: await isDirectory(probed),
      locations: await Promise.all(locations.map((location) => diagnoseLocation(location))),
    });
  }

  const discovery = await discoverRuns(allLocations);
  for (const report of folderReports) {
    for (const location of report.locations) {
      location.runIds = discovery.runs.filter((run) => run.location.sparringDir === location.sparringDir).map((run) => run.id);
    }
  }
  const memberships = options.manifestStages ? await resolveMemberships(discovery.runs, options.manifestStages) : undefined;
  const selection = selectRun(discovery.runs, options.preferredId, options.stickyId, options.scope, memberships ? stageOwnership(memberships) : undefined);
  const report: DiscoveryDiagnostic = {
    folders: folderReports,
    problems: discovery.problems,
    runs: discovery.runs.map((run) => ({ id: run.id, kind: run.kind, label: runLabel(run), open: isOpen(run) })),
    preferredId: options.preferredId,
    stickyId: options.stickyId,
    ...(options.scope && selection.scope
      ? { scope: { repoRoot: selection.scope.repoRoot, name: selection.scope.name, knownRoots: [...(options.scope.knownRoots ?? [])] } }
      : {}),
    ...(options.gitAttached === undefined ? {} : { gitAttached: options.gitAttached }),
    ...(options.gitReadiness === undefined ? {} : { gitReadiness: options.gitReadiness }),
    ...(selection.elsewhere ? { elsewhereIds: selection.elsewhere.map((run) => run.id) } : {}),
    ...(selection.unattributed ? { unattributedIds: selection.unattributed.map((run) => run.id) } : {}),
    pickLabels: buildRunPickGroups(discovery.runs, { selectedId: selection.selected?.id, memberships }).flatMap((group) =>
      group.items.map((item) => `${group.title} | ${item.label} — ${item.description} — ${item.detail}`),
    ),
    selectedId: selection.selected?.id,
    ambiguousIds: selection.ambiguous.map((run) => run.id),
  };
  if (!selection.selected) {
    report.noSelectionReason = explainNoSelection(report);
  }
  return report;
}

function isOpen(run: RunSnapshot): boolean {
  return run.kind === "plan" ? run.state.status !== "complete" : run.stage.state?.status !== "accepted";
}

async function diagnoseLocation(location: SparringLocation): Promise<LocationDiagnostic> {
  const stagesRoot = path.join(location.sparringDir, STAGES_DIRNAME);
  const plansDir = path.join(location.sparringDir, PLANS_DIRNAME);
  const stages: StageDiagnostic[] = [];
  for (const name of (await listDir(stagesRoot)).sort()) {
    if (!(await isDirectory(path.join(stagesRoot, name)))) {
      continue;
    }
    const statePath = path.join(stagesRoot, name, STATE_FILENAME);
    const stage: StageDiagnostic = { name, stateExists: false };
    let text: string | undefined;
    try {
      text = await fs.readFile(statePath, "utf8");
      stage.stateExists = true;
    } catch {
      // no state.json: not a stage the engine created
    }
    if (text !== undefined) {
      try {
        stage.status = parseStageState(text).status;
        stage.parsed = true;
      } catch (error) {
        stage.parsed = false;
        stage.parseError = classifyParseError(error);
      }
    }
    stages.push(stage);
  }
  const plans: PlanDiagnostic[] = [];
  for (const file of (await listDir(plansDir)).filter((name) => name.endsWith(".json")).sort()) {
    try {
      plans.push({ file, parsed: true, status: parsePlanRunState(await fs.readFile(path.join(plansDir, file), "utf8")).status });
    } catch (error) {
      plans.push({ file, parsed: false, parseError: classifyParseError(error) });
    }
  }
  return {
    sparringDir: location.sparringDir,
    projectDir: location.projectDir,
    repoRoot: location.repoRoot,
    nested: isNestedLocation(location),
    configExists: await isFile(path.join(location.sparringDir, CONFIG_FILENAME)),
    stagesExists: await isDirectory(stagesRoot),
    plansExists: await isDirectory(plansDir),
    stages,
    plans,
    runIds: [],
  };
}

/**
 * Engine-format errors name a field or a status word and are safe to show;
 * anything else (JSON syntax errors quote the text) is reduced to its class.
 */
function classifyParseError(error: unknown): string {
  if (error instanceof EngineFormatError) {
    return /^malformed /.test(error.message) ? "malformed JSON" : error.message;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ? `read error ${code}` : "unreadable";
}

function explainNoSelection(report: DiscoveryDiagnostic): string {
  if (report.ambiguousIds.length > 0) {
    return `${report.ambiguousIds.length} runs look active and neither the explicit nor the remembered selection names one of them; a choice is required`;
  }
  if (report.scope && report.runs.length > 0) {
    const out = (report.elsewhereIds?.length ?? 0) + (report.unattributedIds?.length ?? 0);
    if (out === report.runs.length) {
      const parts = [
        report.elsewhereIds?.length ? `${report.elsewhereIds.length} in other repositories` : "",
        report.unattributedIds?.length ? `${report.unattributedIds.length} attributable to no repository the Git extension has opened` : "",
      ].filter(Boolean);
      return `no recorded run in ${report.scope.name}, the repository this window is in; ${parts.join(" and ")}, all reachable through Select repository / run`;
    }
  }
  if (report.runs.length > 0) {
    return "runs exist but none was selected (unexpected; see the selection rule)";
  }
  const reasons: string[] = [];
  for (const folder of report.folders) {
    const where = `folder ${folder.index} (${folder.name})`;
    if (folder.skipped) {
      reasons.push(`${where}: skipped, ${folder.skipped}`);
    } else if (folder.locations.length === 0) {
      reasons.push(`${where}: no .sparring directly under it or in any nested project within the search depth`);
    } else {
      for (const location of folder.locations) {
        reasons.push(`${where}: ${explainEmptyLocation(location)}`);
      }
    }
  }
  return `no recorded runs. ${reasons.join("; ")}`;
}

function explainEmptyLocation(location: LocationDiagnostic): string {
  const at = `${location.nested ? "nested " : ""}${location.sparringDir}`;
  if (!location.stagesExists && !location.plansExists) {
    return `${at} has neither stages/ nor plans/ (not an engine state directory, or nothing recorded yet)`;
  }
  if (location.stages.length === 0 && location.plans.length === 0) {
    return `${at} has empty stages/ and plans/`;
  }
  const withoutState = location.stages.filter((stage) => !stage.stateExists).length;
  if (withoutState === location.stages.length && location.plans.length === 0) {
    return `${at}: ${location.stages.length} stage directories, none with ${STATE_FILENAME}`;
  }
  return `${at}: stages/plans present but produced no runs (${location.stages.length} stage dirs, ${location.plans.length} plan files)`;
}

/** One line per fact, indented by level; suitable for an Output Channel. */
export function renderDiagnostic(report: DiscoveryDiagnostic): string[] {
  const lines: string[] = [];
  lines.push(`Diagnose Discovery: ${report.folders.length} workspace folder(s)`);
  for (const folder of report.folders) {
    lines.push(`folder ${folder.index}: ${folder.name}`);
    lines.push(`  scheme: ${folder.scheme}`);
    lines.push(`  fsPath: ${folder.fsPath}`);
    lines.push(`  probed: ${folder.probed}`);
    if (folder.skipped) {
      lines.push(`  skipped: ${folder.skipped}`);
      continue;
    }
    lines.push(`  .sparring exists: ${yesNo(folder.sparringExists)}`);
    lines.push(`  locations found (including nested): ${folder.locations.length}`);
    for (const location of folder.locations) {
      lines.push(`  ${location.nested ? "nested project" : "project"}: ${location.projectDir}`);
      lines.push(`    .sparring: ${location.sparringDir}`);
      lines.push(`    repo root (project.toml [repo] root, else the project dir): ${location.repoRoot}`);
      lines.push(`    ${CONFIG_FILENAME} exists: ${yesNo(location.configExists)}`);
      lines.push(`    ${STAGES_DIRNAME}/ exists: ${yesNo(location.stagesExists)}`);
      lines.push(`    ${PLANS_DIRNAME}/ exists: ${yesNo(location.plansExists)}`);
      lines.push(`    stage directories: ${location.stages.length}`);
      for (const stage of location.stages) {
        const parse = stage.stateExists ? (stage.parsed ? `parsed, status ${stage.status}` : `parse failed: ${stage.parseError}`) : "no state.json";
        lines.push(`      ${stage.name}: state.json ${yesNo(stage.stateExists)}; ${parse}`);
      }
      lines.push(`    plan run files: ${location.plans.length}`);
      for (const plan of location.plans) {
        lines.push(`      ${plan.file}: ${plan.parsed ? `parsed, status ${plan.status}` : `parse failed: ${plan.parseError}`}`);
      }
      lines.push(`    runs produced: ${location.runIds.length}`);
      for (const id of location.runIds) {
        lines.push(`      ${id}`);
      }
    }
  }
  if (report.problems.length > 0) {
    lines.push(`plan-run state files that could not be parsed: ${report.problems.length}`);
    for (const problem of report.problems) {
      lines.push(`  ${problem.path}: ${problem.error}`);
    }
  }
  lines.push(`runs discovered: ${report.runs.length}`);
  for (const run of report.runs) {
    lines.push(`  ${run.kind} ${run.label} (${run.open ? "open" : "terminal"}) id ${run.id}`);
  }
  lines.push(`Git extension API: ${report.gitAttached === undefined ? "not reported" : report.gitAttached ? "attached" : "not attached; nothing is scoped to a repository"}`);
  if (report.gitReadiness) {
    // Said separately from "attached", because a window that attached but has
    // not finished scanning offers a short repository list for reasons that
    // have nothing to do with attachment.
    lines.push(`Git repository discovery: ${report.gitReadiness} — ${describeReadiness(report.gitReadiness)}`);
  }
  lines.push(`active repository: ${report.scope ? `${report.scope.name} (${report.scope.repoRoot})` : "none resolved; selection is not confined to a repository"}`);
  if (report.scope) {
    lines.push(`  repository roots runs were attributed against: ${report.scope.knownRoots.length === 0 ? "none" : report.scope.knownRoots.join(", ")}`);
  }
  if (report.elsewhereIds && report.elsewhereIds.length > 0) {
    lines.push(`  runs in other repositories (not candidates for automatic selection): ${report.elsewhereIds.join(", ")}`);
  }
  if (report.unattributedIds && report.unattributedIds.length > 0) {
    lines.push(`  runs no known repository root owns (not candidates for automatic selection; reachable through the picker): ${report.unattributedIds.join(", ")}`);
  }
  lines.push(`explicit selection (pin): ${report.preferredId ?? "none"}`);
  lines.push(`remembered selection: ${report.stickyId ?? "none"}`);
  lines.push(`Select Repository / Run would list ${report.pickLabels.length} item(s):`);
  for (const label of report.pickLabels) {
    lines.push(`  ${label}`);
  }
  lines.push(`selected: ${report.selectedId ?? "none"}`);
  if (report.ambiguousIds.length > 0) {
    lines.push(`ambiguous: ${report.ambiguousIds.join(", ")}`);
  }
  if (report.noSelectionReason) {
    lines.push(`why none: ${report.noSelectionReason}`);
  }
  return lines;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}
