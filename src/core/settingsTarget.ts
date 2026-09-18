/**
 * Which project's settings the cockpit's Settings action would open.
 *
 * The cockpit is always looking at exactly one repository — the run it has
 * selected, or, with no run, the repository this window is following (see
 * activeRepository.ts). Settings follows that same answer, so the file that
 * opens is the one whose configuration the rest of the screen is
 * describing. Changing repositories changes the target; there is no
 * separate "settings repository" to get out of step.
 */

import * as path from "node:path";
import type { RunSelection } from "./discovery";

export const SPARRING_DIRNAME = ".sparring";
export const PROJECT_CONFIG_FILENAME = "project.toml";

export interface SettingsTarget {
  /** The project the engine manages (the parent of `.sparring`). */
  projectDir: string;
  sparringDir: string;
  /** Absolute path of the project.toml, whether or not it exists yet. */
  configPath: string;
  /** What a person calls the repository, for messages. */
  repository: string;
}

/**
 * The target, or `undefined` when this window has neither a selected run nor
 * a resolved active repository — in which case there is no project whose
 * settings could honestly be opened.
 */
export function settingsTarget(selection: RunSelection): SettingsTarget | undefined {
  const selected = selection.selected;
  if (selected) {
    return describe(selected.location.projectDir, selected.location.sparringDir, selected.location.folderName);
  }
  const scope = selection.scope;
  if (scope) {
    return describe(scope.repoRoot, path.join(scope.repoRoot, SPARRING_DIRNAME), scope.name);
  }
  return undefined;
}

function describe(projectDir: string, sparringDir: string, repository: string): SettingsTarget {
  return { projectDir, sparringDir, configPath: path.join(sparringDir, PROJECT_CONFIG_FILENAME), repository };
}
