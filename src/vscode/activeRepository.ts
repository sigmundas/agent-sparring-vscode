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
 *
 * ### Attached is not ready
 *
 * Getting the API is the *first* of two moments. The Git extension finds the
 * workspace's repositories asynchronously and publishes its progress as
 * `API.state` / `API.onDidChangeState` (API version 1), and while that state
 * is `"uninitialized"` its `repositories` array is legitimately empty. So
 * both are tracked here, through core/gitReadiness.ts, and the difference is
 * load-bearing in two places: `repositories()` answers `undefined` rather
 * than `[]` until discovery has finished, so nothing reads "not scanned yet"
 * as "no repository is open"; and {@link ActiveRepositoryTracker.ready} waits
 * for `initialized` rather than for the API object — bounded, so a Git
 * extension that never publishes a state cannot hang a command.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ActiveRepositoryFold, type GitRepositoryView, type GitSource } from "../core/activeRepository";
import { GitReadinessFold, describeReadiness, type GitApiState, type GitReadiness } from "../core/gitReadiness";

/** The slice of the Git extension's public API version 1 this file uses. */
interface GitRepository {
  rootUri: vscode.Uri;
  ui: { selected: boolean; onDidChange: vscode.Event<void> };
}

interface GitApi {
  /**
   * `"uninitialized"` until the Git extension has finished finding the
   * workspace's repositories. Part of API version 1 (see core/gitReadiness.ts
   * for why this, and not the API's existence, is what "ready" means).
   */
  state: GitApiState;
  onDidChangeState: vscode.Event<GitApiState>;
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

/**
 * How long a caller that needs the repository list waits for the Git
 * extension to finish finding repositories.
 *
 * A bound is necessary and is not a guess at how long a scan takes: readiness
 * already resolves the instant the state turns `initialized`, and the
 * `unavailable` state already settles without waiting. This is for the case
 * neither covers — an extension that activated, handed over an API, and then
 * never published a state at all. The alternative is a `Run plan…` that never
 * opens, which is worse than one that opens with a list it says is incomplete.
 */
const READY_TIMEOUT_MS = 5_000;

export class ActiveRepositoryTracker implements vscode.Disposable {
  private api: GitApi | undefined;
  /** How much the Git extension has told us; `attached` is not `ready`. */
  private readonly readiness = new GitReadinessFold();
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
      // Gated on the same readiness: an answer taken while the extension is
      // still scanning is not one to rank against a containment match.
      repositoryOf: (fsPath) => (this.readiness.repositoriesKnown ? this.api?.getRepository(vscode.Uri.file(fsPath))?.rootUri.fsPath : undefined),
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
    // Released before anything else: a window closing must not leave a
    // `ready()` promise that nothing will ever settle.
    this.readiness.dispose();
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
   * How much the Git extension has told us — `attaching`, `uninitialized`,
   * `initialized` or `unavailable` (core/gitReadiness.ts). Attached is not
   * ready, and the diagnostic says which of the two it is.
   */
  get gitReadiness(): GitReadiness {
    return this.readiness.readiness;
  }

  /**
   * Resolve once the Git extension has **finished finding repositories**, or
   * once it is clear that it never will.
   *
   * This used to resolve as soon as `getAPI(1)` handed back an object, which
   * is a different and much earlier moment: the Git extension scans the
   * workspace asynchronously, publishes `state: "uninitialized"` while it
   * does, and its `repositories` array is legitimately empty until it is
   * done. So a window that activated first offered `Run plan…` a list
   * containing only the `.sparring` locations discovery had found — missing
   * exactly the first-run repositories that exist nowhere else — and did it
   * only in the first seconds of the window, which is the hardest kind of
   * wrongness to report.
   *
   * It settles on the first of: the state turning `initialized`; the
   * extension turning out to be unavailable, where waiting cannot help; this
   * tracker being disposed; or {@link READY_TIMEOUT_MS}, so a Git extension
   * that activated and then published nothing cannot hang a command for ever.
   * Callers are expected to check {@link repositoriesKnown} afterwards and
   * say so rather than assume: this resolving does not promise an answer, only
   * that waiting longer would not have produced one.
   */
  async ready(): Promise<void> {
    void this.attach("the repository list was needed");
    if (this.readiness.settled) {
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        cancel();
        resolve();
      };
      const timer = setTimeout(() => {
        this.log(`waited ${READY_TIMEOUT_MS}ms for the built-in Git extension to finish finding repositories and it has not; ${describeReadiness(this.readiness.readiness)}`);
        finish();
      }, READY_TIMEOUT_MS);
      const cancel = this.readiness.onSettled(finish);
    });
  }

  /**
   * Whether the repository list may be believed. `false` means *unknown* —
   * still scanning, or no Git extension — and never "there are none".
   */
  get repositoriesKnown(): boolean {
    return this.readiness.repositoriesKnown;
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
      // Not installed, or disabled. Settled rather than pending: waiting
      // cannot help, so nothing waits. `onDidChange` brings us back if the
      // installed set changes.
      this.settleUnavailable("the built-in Git extension is not installed or is disabled");
      return;
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
        this.settleUnavailable(`the built-in Git extension could not be attached (${(error as Error).message}); the cockpit is not scoped to a repository`);
        return;
      }
      const api = this.api;
      if (!api) {
        this.settleUnavailable("the built-in Git extension offered no API version 1; the cockpit is not scoped to a repository");
        return;
      }
      this.disposables.push(
        api.onDidOpenRepository(() => this.resync("a repository was opened")),
        api.onDidCloseRepository(() => this.resync("a repository was closed")),
        // Repository discovery finishing is the moment the list becomes
        // believable, and the moment anything waiting on it may proceed.
        api.onDidChangeState((state) => this.onReadinessChanged(state)),
      );
      // Read the state *now* as well as subscribing: a window that attaches
      // after the scan has already finished would otherwise wait for an event
      // that has already fired.
      this.readiness.attached(api.state === "initialized" ? "initialized" : "uninitialized");
      this.log(`attached to the built-in Git extension's API version 1 — ${why}; ${describeReadiness(this.readiness.readiness)}`);
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

  /**
   * Repository discovery finished (or restarted). Logged and re-synced,
   * because the answer to "which repository is this window in" can only
   * change once the repositories are known.
   */
  private onReadinessChanged(state: GitApiState): void {
    const before = this.readiness.readiness;
    const after = this.readiness.stateChanged(state === "initialized" ? "initialized" : "uninitialized");
    if (before !== after) {
      this.log(describeReadiness(after));
    }
    this.resync("the Git extension's repository discovery changed state");
  }

  /** Record that the Git extension cannot answer for now, and release anything waiting on it. */
  private settleUnavailable(message: string): void {
    if (this.readiness.readiness !== "unavailable") {
      this.log(message);
    }
    this.readiness.unavailable();
  }

  /**
   * The repositories the Git extension has open, or `undefined` when it has
   * told us nothing we may believe.
   *
   * `undefined` while the state is `uninitialized` is the whole point: the
   * array is empty then, and reading that as "no repository is open" is a
   * positive claim about a scan that has not finished. Every caller already
   * distinguishes "told us nothing" from "told us there are none" (see
   * `GitSource` and `launchRepositories`), so the honest answer is the one
   * they are built for.
   */
  private repositoryViews(): GitRepositoryView[] | undefined {
    if (!this.readiness.repositoriesKnown) {
      return undefined;
    }
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
