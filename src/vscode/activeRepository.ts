/**
 * The vscode adapter for core/activeRepository.ts: subscribe to the two public
 * signals, hand them to the fold there, and fire when the answer changes.
 *
 * Only the built-in Git extension's public API version 1 and the window's own
 * active-editor event are used. No private command is intercepted, no context
 * key is read, and nothing here runs git. In particular the lower-left
 * repository selector is *not* emulated — it cannot be, through any public
 * API — and the cockpit does not claim to follow it; see the contract at the
 * top of core/activeRepository.ts.
 *
 * ### Activation
 *
 * The Git extension is activated by `*`, so it is usually already active when
 * this runs — but ordering between `*` extensions is not guaranteed, and a
 * workspace that activates Agent Sparring through `workspaceContains:.sparring`
 * can easily get there first. Reading `isActive` and giving up was therefore a
 * permanent failure: `vscode.extensions.onDidChange` fires when the set of
 * *installed* extensions changes, not when one activates, so nothing ever came
 * back to try again and the window stayed unscoped for its whole life.
 *
 * The supported lifecycle path is `Extension.activate()`, which resolves with
 * the extension's exports and is exactly what the Git extension's own
 * documentation tells an extension to call. It is awaited once at
 * construction, and attachment is retried from every later signal — an editor
 * change, the installed-extension set changing — so a window that starts
 * before the Git extension attaches as soon as anything happens.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActiveRepositoryFold, type GitRepositoryView, type GitSource } from "../core/activeRepository";

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
  private api: GitApi | undefined;
  private readonly fold: ActiveRepositoryFold;
  private readonly disposables: vscode.Disposable[] = [];
  /** Per-repository `ui.onDidChange` subscriptions, keyed by resolved root. */
  private readonly uiSubscriptions = new Map<string, vscode.Disposable>();
  /** In-flight `Extension.activate()`, so a burst of signals asks once. */
  private attaching: Promise<void> | undefined;
  private disposed = false;
  private answer: string | undefined;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires when the repository this window is in changes (never on an unchanged re-read). */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly log: (message: string) => void) {
    const source: GitSource = {
      repositories: () => this.repositoryViews(),
      repositoryOf: (fsPath) => this.api?.getRepository(vscode.Uri.file(fsPath))?.rootUri.fsPath,
    };
    this.fold = new ActiveRepositoryFold(source, Date.now());
    this.disposables.push(this.changeEmitter);
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditor(editor)));
    this.disposables.push(vscode.extensions.onDidChange(() => void this.attach("the installed extensions changed")));
    this.fold.seedActiveEditor(filePathOf(vscode.window.activeTextEditor?.document.uri));
    void this.attach("the tracker started");
  }

  dispose(): void {
    this.disposed = true;
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
    return this.fold.activeRepoRoot;
  }

  /** Every repository root the Git extension has open; `undefined` when it has told us nothing. */
  get knownRepoRoots(): string[] | undefined {
    return this.fold.knownRepoRoots;
  }

  /** Whether the Git extension's API is attached, for the diagnostic. */
  get attached(): boolean {
    return this.api !== undefined;
  }

  /**
   * Resolve once the Git extension has been attached, or once attaching has
   * been tried and failed.
   *
   * Attachment normally happens at construction, but ordering between `*`
   * extensions is not guaranteed and this window can activate first. A
   * user-initiated moment that needs the repository list — "Run plan…", which
   * offers repositories that have no Agent Sparring state and therefore exist
   * only in the Git extension's answer — waits for it rather than silently
   * working from a shorter list.
   */
  async ready(): Promise<void> {
    await this.attach("the repository list was needed");
  }

  // ------------------------------------------------------------------ activation

  /**
   * Attach to the Git extension, activating it if it has not activated yet.
   *
   * Safe to call from any signal and as often as one arrives: it returns
   * immediately once attached, and a second call while an activation is in
   * flight joins the first.
   */
  private async attach(why: string): Promise<void> {
    if (this.api || this.disposed) {
      return;
    }
    if (this.attaching) {
      return this.attaching;
    }
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension) {
      return; // not installed or disabled; `onDidChange` brings us back if that changes
    }
    this.attaching = (async () => {
      try {
        // `Extension.activate()` is the supported way to wait for another
        // extension's exports; it resolves immediately when already active.
        const exports = extension.isActive ? extension.exports : await extension.activate();
        if (this.disposed || this.api) {
          return;
        }
        this.api = exports.getAPI(1);
      } catch (error) {
        // An API version this build does not offer, or an activation failure.
        // Stay unscoped, say so once per attempt, and let a later signal retry.
        this.log(`the built-in Git extension could not be attached (${(error as Error).message}); the cockpit is not scoped to a repository`);
        return;
      }
      const api = this.api;
      if (!api) {
        return;
      }
      this.disposables.push(
        api.onDidOpenRepository(() => this.resync("a repository was opened")),
        api.onDidCloseRepository(() => this.resync("a repository was closed")),
      );
      this.log(`following the active repository through the Git extension API (${api.repositories.length} repository/repositories open) — ${why}`);
      this.resync("the Git extension became available");
    })();
    try {
      await this.attaching;
    } finally {
      this.attaching = undefined;
    }
  }

  // ------------------------------------------------------------------ signals

  /**
   * Re-read what the API can tell us and re-resolve the recorded
   * observations. A re-read is **not** an event: nothing here stamps a new
   * moment, so an unrelated repository opening or closing cannot hand the
   * lead back to an editor that was left behind.
   *
   * `api.repositories` hands back a fresh wrapper object on every access, so
   * repositories are keyed by resolved root path and never by identity.
   */
  private resync(why: string): void {
    const api = this.api;
    if (!api) {
      return;
    }
    const before = this.answer;
    const open = new Set(api.repositories.map((repository) => path.resolve(repository.rootUri.fsPath)));
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
    this.settle(before, this.fold.resync(), why);
  }

  /**
   * The Source Control view moved its focus, which is a statement about which
   * repository the user means — so it is stamped now, even if it names the
   * repository this slot already held.
   */
  private onFocusChanged(): void {
    this.settle(this.answer, this.fold.focusChanged(Date.now()), "the Source Control view's focus changed");
  }

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    // An editor change is also the moment to retry attaching: if this window
    // started before the Git extension, this is what brings the cockpit back.
    if (!this.api) {
      void this.attach("an editor became active");
    }
    this.settle(this.answer, this.fold.editorActivated(filePathOf(editor?.document.uri), Date.now()), "the active editor changed");
  }

  private repositoryViews(): GitRepositoryView[] | undefined {
    return this.api?.repositories.map((repository) => ({ rootPath: repository.rootUri.fsPath, selected: repository.ui.selected }));
  }

  private settle(before: string | undefined, after: string | undefined, why: string): void {
    this.answer = after;
    if (before === after) {
      return;
    }
    this.log(`active repository: ${after ? path.basename(after) : "none"}${before ? ` (was ${path.basename(before)})` : ""} — ${why}`);
    this.changeEmitter.fire();
  }
}

/** The file a document is, when it is one on disk; `git:`, `output:` and untitled buffers say nothing. */
function filePathOf(uri: vscode.Uri | undefined): string | undefined {
  return uri?.scheme === "file" ? uri.fsPath : undefined;
}

/**
 * `fs.realpath` for a directory, cached for the life of the window.
 *
 * On macOS a workspace opened through `/tmp/…` really lives at
 * `/private/tmp/…`, and on any platform a repository can be reached through a
 * symlinked parent. The Git extension and VS Code's workspace folders do not
 * always agree on which spelling to use, and attribution is now strict — a run
 * no known root owns is never selected — so a spelling mismatch would empty
 * the cockpit rather than merely widen it. One `realpath` per directory is
 * what lets the two be compared; the caller decides which spelling to keep.
 */
export class RealPaths {
  private readonly cache = new Map<string, string>();

  async of(target: string): Promise<string> {
    const key = path.resolve(target);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let real = key;
    try {
      real = path.resolve(await fsp.realpath(key));
    } catch {
      // Gone, or not readable: its own spelling is all there is.
    }
    this.cache.set(key, real);
    return real;
  }
}
