/**
 * The vscode adapter for core/activeRepository.ts: subscribe to the two
 * public signals, fold them there, and fire when the answer changes.
 *
 * Only the built-in Git extension's API version 1 and the window's own
 * active-editor event are used. No private command is intercepted, no context
 * key is read, and nothing here runs git.
 *
 * What this cannot see, and says so rather than pretending otherwise: the
 * explicit pin made through the lower-left repository selector. That command
 * (`scm.setActiveProvider`) calls core's `pinActiveRepository`, which reaches
 * no extension — see core/activeRepository.ts. The two signals below are the
 * same ones core itself folds *underneath* that pin, so following them is the
 * closest supported approximation; Agent Sparring's own pin covers the rest.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
  NO_ACTIVE_REPOSITORY,
  activeRepositoryRoot,
  withEditorRepository,
  withFocusedRepository,
  withKnownRepositories,
  type ActiveRepositoryState,
} from "../core/activeRepository";
import { isInsidePath } from "../core/discovery";

/** The slice of the Git extension's public API version 1 this file uses. */
interface GitRepository {
  rootUri: vscode.Uri;
  ui: { selected: boolean; onDidChange: vscode.Event<void> };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

export class ActiveRepositoryTracker implements vscode.Disposable {
  private state: ActiveRepositoryState = NO_ACTIVE_REPOSITORY;
  private api: GitApi | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Per-repository `ui.onDidChange` subscriptions, keyed by resolved root. */
  private readonly uiSubscriptions = new Map<string, vscode.Disposable>();

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the repository this window is in changes (never on an unchanged re-read). */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly log: (message: string) => void) {
    this.disposables.push(this.changeEmitter);
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditor(editor)));
    // The Git extension may activate after us (it is activated by `*`, but
    // ordering is not guaranteed), so its API is resolved lazily and the
    // extension list is watched for it appearing.
    this.disposables.push(vscode.extensions.onDidChange(() => this.attach()));
    this.attach();
  }

  dispose(): void {
    for (const subscription of this.uiSubscriptions.values()) {
      subscription.dispose();
    }
    this.uiSubscriptions.clear();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  /**
   * The repository this window is in, as an absolute root, or `undefined`
   * when no signal has named one. `undefined` means *unknown*, and callers
   * must treat it as "do not scope anything" rather than "no repository".
   */
  get activeRepoRoot(): string | undefined {
    return activeRepositoryRoot(this.state);
  }

  /** Every repository root the Git extension has open; `undefined` when it has told us nothing. */
  get knownRepoRoots(): string[] | undefined {
    return this.api?.repositories.map((repository) => repository.rootUri.fsPath);
  }

  // ------------------------------------------------------------------ signals

  private attach(): void {
    if (this.api) {
      return;
    }
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension?.isActive) {
      return;
    }
    try {
      this.api = extension.exports.getAPI(1);
    } catch {
      return; // an API version this build does not offer; stay unscoped
    }
    const api = this.api;
    this.disposables.push(
      api.onDidOpenRepository(() => this.resync("a repository was opened")),
      api.onDidCloseRepository(() => this.resync("a repository was closed")),
    );
    this.log(`following the active repository through the Git extension API (${api.repositories.length} repository/repositories open)`);
    this.resync("the Git extension became available");
  }

  /**
   * Re-read everything the API can tell us: which repositories are open,
   * which one the Source Control view has focused, and which owns the active
   * editor. Also (re)subscribes each repository's `ui.onDidChange`.
   *
   * `api.repositories` hands back a fresh wrapper object on every access, so
   * repositories are keyed by resolved root path and never by identity.
   */
  private resync(why: string): void {
    const api = this.api;
    if (!api) {
      return;
    }
    const before = this.activeRepoRoot;
    const roots = api.repositories.map((repository) => repository.rootUri.fsPath);
    const open = new Set(roots.map((root) => path.resolve(root)));
    for (const [key, subscription] of this.uiSubscriptions) {
      if (!open.has(key)) {
        subscription.dispose();
        this.uiSubscriptions.delete(key);
      }
    }
    for (const repository of api.repositories) {
      const key = path.resolve(repository.rootUri.fsPath);
      if (!this.uiSubscriptions.has(key)) {
        this.uiSubscriptions.set(key, repository.ui.onDidChange(() => this.onFocusChanged()));
      }
    }
    this.state = withKnownRepositories(this.state, roots);
    // A re-read is not an event. Only a focus that differs from what we
    // already recorded is news here; re-stamping the same one would let a
    // repository opening somewhere else quietly steal the lead from the
    // editor the user is actually looking at.
    const focused = this.focusedRoot();
    if (focused !== this.state.focused?.rootPath) {
      this.state = withFocusedRepository(this.state, focused, Date.now());
    }
    this.state = withEditorRepository(this.state, this.repositoryOfActiveEditor(), Date.now());
    this.settle(before, why);
  }

  /**
   * The Source Control view moved its focus, which is a statement about which
   * repository the user means — so it is stamped now, even if it names the
   * repository this slot already held.
   */
  private onFocusChanged(): void {
    const before = this.activeRepoRoot;
    this.state = withFocusedRepository(this.state, this.focusedRoot(), Date.now());
    this.settle(before, "the Source Control view's focus changed");
  }

  private focusedRoot(): string | undefined {
    return this.api?.repositories.find((repository) => repository.ui.selected)?.rootUri.fsPath;
  }

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    const before = this.activeRepoRoot;
    this.state = withEditorRepository(this.state, this.repositoryOf(editor?.document.uri), Date.now());
    this.settle(before, "the active editor changed");
  }

  private repositoryOfActiveEditor(): string | undefined {
    return this.repositoryOf(vscode.window.activeTextEditor?.document.uri);
  }

  /**
   * Which repository owns a document, by repository root.
   *
   * `getRepository` is asked first, because it is the Git extension's own
   * answer and it knows about submodules and worktrees. The containment
   * fallback exists for schemes it declines (`git:`, `output:`, an untitled
   * buffer): there the deepest open root containing the path wins, so a
   * worktree checked out inside its parent repository is not mistaken for the
   * parent.
   */
  private repositoryOf(uri: vscode.Uri | undefined): string | undefined {
    if (!uri || !this.api) {
      return undefined;
    }
    if (uri.scheme === "file") {
      const owner = this.api.getRepository(uri);
      if (owner) {
        return owner.rootUri.fsPath;
      }
      return this.api.repositories
        .map((repository) => repository.rootUri.fsPath)
        .filter((root) => isInsidePath(uri.fsPath, root) || path.resolve(root) === path.resolve(uri.fsPath))
        .sort((a, b) => path.resolve(b).length - path.resolve(a).length)[0];
    }
    return undefined;
  }

  private settle(before: string | undefined, why: string): void {
    const after = this.activeRepoRoot;
    if (before === after) {
      return;
    }
    this.log(`active repository: ${after ? path.basename(after) : "none"}${before ? ` (was ${path.basename(before)})` : ""} — ${why}`);
    this.changeEmitter.fire();
  }
}
