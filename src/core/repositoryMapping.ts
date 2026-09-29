/**
 * Whether a repository name → path mapping recorded by an earlier intake may
 * be handed to prepare-plan again: the path is still the root of a git
 * worktree, and — when intake recorded the repository's git common
 * directory — of the same repository. A worktree of that repository at
 * another branch is still the same repository; what branch it has checked
 * out is approve-plan's question, not this one.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RepositoryMappingCheck } from "./intakeActions";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  });
}

async function real(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch {
    return path.resolve(file);
  }
}

export async function checkRepositoryMapping(_name: string, repoPath: string, recordedGitDir: string | undefined): Promise<RepositoryMappingCheck> {
  try {
    if (!(await fs.stat(repoPath)).isDirectory()) {
      return { valid: false, reason: "it is not a directory" };
    }
  } catch {
    return { valid: false, reason: "it no longer exists" };
  }
  let lines: string[];
  try {
    lines = (await git(repoPath, ["rev-parse", "--show-toplevel", "--git-common-dir"])).split("\n");
  } catch {
    return { valid: false, reason: "it is not a git repository" };
  }
  const [top, commonDir] = lines;
  if (!top || (await real(top)) !== (await real(repoPath))) {
    return { valid: false, reason: "it is not the root of a git repository" };
  }
  if (recordedGitDir && commonDir && (await real(path.resolve(repoPath, commonDir))) !== (await real(recordedGitDir))) {
    return { valid: false, reason: "it is now a different git repository than intake inspected" };
  }
  return { valid: true };
}
