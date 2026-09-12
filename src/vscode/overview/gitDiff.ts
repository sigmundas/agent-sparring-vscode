/**
 * "Open diff" through the built-in Git extension's API: no shell, no
 * constructed git command. The SHAs come from the stage's authoritative
 * state.json (base_sha, candidate_sha); when no candidate is recorded yet
 * the comparison target is the repository's current HEAD as reported by
 * the Git extension.
 */

import * as vscode from "vscode";

// Minimal slice of the vscode.git API surface (API version 1) that is used here.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: number;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { HEAD?: { commit?: string; name?: string } };
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}
interface GitApi {
  readonly repositories: GitRepository[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

// git Status enum values that mean "no original content" / "no modified content".
const STATUS_INDEX_ADDED = 1;
const STATUS_INDEX_DELETED = 3;

export async function openCandidateDiff(repoRoot: string, baseSha: string, targetSha: string | undefined, title: string): Promise<void> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) {
    void vscode.window.showWarningMessage("Agent Sparring: the built-in Git extension is not available, so the diff cannot be opened.");
    return;
  }
  const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
  const rootUri = vscode.Uri.file(repoRoot);
  const repository = api.getRepository(rootUri) ?? api.repositories.find((repo) => repo.rootUri.fsPath === rootUri.fsPath);
  if (!repository) {
    void vscode.window.showWarningMessage("Agent Sparring: no Git repository is open for this run's repo root.");
    return;
  }
  const target = targetSha ?? repository.state.HEAD?.commit;
  if (!target) {
    void vscode.window.showWarningMessage("Agent Sparring: no candidate SHA is recorded and HEAD is unknown; nothing to diff.");
    return;
  }
  let changes: GitChange[];
  try {
    changes = await repository.diffBetween(baseSha, target);
  } catch (error) {
    void vscode.window.showWarningMessage(`Agent Sparring: git could not diff ${short(baseSha)}…${short(target)}: ${(error as Error).message}`);
    return;
  }
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(`Agent Sparring: no changes between ${short(baseSha)} and ${short(target)}.`);
    return;
  }
  const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = changes.map((change) => {
    const modified = change.renameUri ?? change.uri;
    const original = change.status === STATUS_INDEX_ADDED ? undefined : api.toGitUri(change.originalUri, baseSha);
    const current = change.status === STATUS_INDEX_DELETED ? undefined : api.toGitUri(modified, target);
    return [modified, original, current];
  });
  await vscode.commands.executeCommand("vscode.changes", `${title}: ${short(baseSha)} … ${short(target)}`, resources);
}

function short(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}
