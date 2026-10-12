/**
 * Read-only context repositories for `start-plan --context-repository
 * NAME=PATH`: which ones the engine said it was not given, and which open
 * repository is the one a plan names.
 *
 * A repository is found by the identity the engine itself gives it —
 * `project.toml`'s `project`, else the repository folder's name
 * (`_project_repository_name` in the engine's `cli.py`) — never by a folder
 * name that merely looks close. Nothing here chooses for the person: one
 * match is proposed for confirmation, several are offered side by side, and
 * none means the person selects the folder. The engine still validates
 * whatever is supplied.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import type { StartPlanFinding } from "./startPlan";

/** The engine's finding for a repository the plan names but intake was not given. */
export const SIBLING_NOT_SUPPLIED = "sibling_not_supplied";

/**
 * Findings that follow from the same missing repository: a stage spanning
 * repositories has no candidate strategy while the sibling was not
 * inspected. Shown grouped under the missing repository, not as separate
 * problems to fix in the plan.
 */
const FOLLOWS_FROM_MISSING_REPOSITORY = new Set([SIBLING_NOT_SUPPLIED, "cross_repository_without_candidate_strategy"]);

/**
 * The repositories the engine reported as not supplied, by name, in report
 * order, without those already supplied. The name is read from the
 * engine's sentence (`the plan names repository 'NAME' …`); a finding this
 * cannot read is left out, and stays visible among the findings.
 */
export function missingContextRepositories(findings: readonly StartPlanFinding[], supplied: Readonly<Record<string, string>> = {}): string[] {
  const names: string[] = [];
  for (const finding of findings) {
    if (finding.code !== SIBLING_NOT_SUPPLIED) {
      continue;
    }
    const name = /repository '([^']+)'/.exec(finding.message)?.[1]?.trim();
    if (name && !names.includes(name) && !(name in supplied)) {
      names.push(name);
    }
  }
  return names;
}

/** Whether a finding is explained by a missing context repository. */
export function followsFromMissingRepository(code: string): boolean {
  return FOLLOWS_FROM_MISSING_REPOSITORY.has(code);
}

/** The top-level `project = "…"` of a project.toml, before any table; undefined when absent. */
export function projectNameFromToml(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      return undefined;
    }
    const match = /^\s*project\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (match) {
      return (match[1] ?? match[2]).trim() || undefined;
    }
  }
  return undefined;
}

export interface RepositoryIdentity {
  /** Repository root. */
  path: string;
  /** The name the engine gives it. */
  name: string;
  source: "project.toml" | "folder name";
}

/**
 * The engine's name for the repository at `repoRoot`: `.sparring/project.toml`'s
 * `project` (as `sparringDir` locates it), else the folder name.
 */
export async function repositoryIdentity(repoRoot: string, readText: (file: string) => Promise<string | undefined>, sparringDir: string = path.join(repoRoot, ".sparring")): Promise<RepositoryIdentity> {
  const text = await readText(path.join(sparringDir, "project.toml"));
  const project = text === undefined ? undefined : projectNameFromToml(text);
  return project ? { path: repoRoot, name: project, source: "project.toml" } : { path: repoRoot, name: path.basename(path.resolve(repoRoot)), source: "folder name" };
}

/** The candidates whose identity is exactly `name`, one per path. */
export function repositoriesNamed(name: string, identities: readonly RepositoryIdentity[]): RepositoryIdentity[] {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = path.resolve(identity.path);
    if (identity.name !== name || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** `--context-repository NAME=PATH` pairs, in name order. */
export function contextRepositoryArgs(repositories: Readonly<Record<string, string>> | undefined): string[] {
  return Object.keys(repositories ?? {})
    .sort()
    .flatMap((name) => ["--context-repository", `${name}=${repositories![name]}`]);
}
