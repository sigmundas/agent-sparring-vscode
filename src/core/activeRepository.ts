/**
 * Which repository Agent Sparring is in, and how that is decided.
 *
 * ### The contract, stated plainly
 *
 * ```
 * Agent Sparring repository context =
 *     the explicitly pinned Agent Sparring repository/run, if one is pinned
 *     otherwise the repository of the active editor / Source Control focus
 * ```
 *
 * That is the whole rule, and it is the rule the UI states out loud. It is
 * deliberately *not* "whatever VS Code's lower-left repository selector says":
 *
 *  - `vscode.scm` exposes only `createSourceControl`. There is no public
 *    `activeRepository`.
 *  - The lower-left selector is core's own status bar entry; its command
 *    `scm.setActiveProvider` calls `pinActiveRepository` on an internal
 *    service. No extension is told, and none can ask.
 *  - Core publishes the answer solely as the context keys
 *    `scmActiveRepositoryName` / `scmActiveRepositoryBranchName`, which a
 *    `when` clause can test but an extension cannot read as a value.
 *
 * Emulating it would mean reaching into private commands or internals, so the
 * cockpit does not claim to follow it. What it follows instead is the two
 * public signals the built-in Git extension's API version 1 does offer:
 *
 *  - `Repository.ui.selected` / `Repository.ui.onDidChange` — which repository
 *    the Source Control view has focused;
 *  - `API.getRepository(uri)` plus `window.onDidChangeActiveTextEditor` — the
 *    repository owning the document you are looking at.
 *
 * The most recently *observed* of those two wins, and Agent Sparring's own pin
 * overrides both. Because the two can disagree with the lower-left selector,
 * the repository the cockpit resolved is named at the top of the Overview and
 * in the status bar tooltip rather than left implicit: a person must never be
 * able to think the cockpit silently followed a selector it cannot see.
 *
 * ### A re-read is not an event
 *
 * {@link ActiveRepositoryFold} separates *observations* (an editor became
 * active; the Source Control view moved its focus) from *resolution* (which
 * repository root an observation names). Only an observation carries a
 * timestamp. Re-reading the Git extension — because a repository opened or
 * closed, or because the extension only just became available — re-resolves
 * the recorded observations and never stamps a new one. Without that
 * separation, an unrelated repository opening could hand the lead back to an
 * editor the user had already navigated away from.
 *
 * No dependency on the vscode API.
 */

import { canonicalPath, isInsidePath, samePath, type RunSelection, type RunSnapshot } from "./discovery";
import { pathDepth } from "./launchRepositories";

export interface ActiveRepositorySignal {
  /** Absolute repository/worktree root, exactly as the Git extension reports it. */
  rootPath: string;
  /** When this signal was last *observed* (epoch ms). Never advanced by a re-read. */
  atMs: number;
}

/**
 * The fold's whole state. Kept as data rather than hidden in a class so the
 * rules below can be tested without a VS Code window.
 */
export interface ActiveRepositoryState {
  /** Repository focused in the Source Control view (`Repository.ui.selected`). */
  focused?: ActiveRepositorySignal;
  /** Repository owning the active editor's document. */
  editor?: ActiveRepositorySignal;
}

export const NO_ACTIVE_REPOSITORY: ActiveRepositoryState = {};

/**
 * The repository the window is in: whichever signal was observed most
 * recently.
 *
 * A tie goes to the Source Control view's focus, because focusing a
 * repository there is a deliberate statement about which repository you mean,
 * while an editor can become active for many reasons.
 */
export function activeRepositoryRoot(state: ActiveRepositoryState): string | undefined {
  const signals = [state.focused, state.editor].filter((signal): signal is ActiveRepositorySignal => signal !== undefined);
  if (signals.length === 0) {
    return undefined;
  }
  return signals.sort((a, b) => b.atMs - a.atMs)[0].rootPath;
}

/**
 * Record which repository the Source Control view focused. `undefined` clears
 * the signal: no repository is focused any more (the last one was closed),
 * which is different from an editor that simply says nothing.
 *
 * Re-focusing a repository that is *already* the answer changes nothing and is
 * dropped. Re-focusing one that is not — because an editor in another
 * repository has since taken the lead — is a real change and must be recorded,
 * even though this slot already named it. Comparing against the slot instead
 * of against the answer was a bug: focus A, open a file in B, click A in the
 * Source Control view, and the cockpit stayed in B.
 */
export function withFocusedRepository(state: ActiveRepositoryState, rootPath: string | undefined, atMs: number): ActiveRepositoryState {
  if (rootPath === undefined) {
    return state.focused === undefined ? state : { ...state, focused: undefined };
  }
  if (isActive(state, rootPath)) {
    return state;
  }
  return { ...state, focused: { rootPath, atMs } };
}

/**
 * Record which repository owns the active editor's document.
 *
 * `undefined` **keeps** whatever was there. An editor outside every
 * repository — a Settings tab, the Output panel, a scratch file, or no editor
 * at all — is not a statement that you have left the repository you were in,
 * and treating it as one would empty the cockpit every time someone opened
 * the log. VS Code's own derivation retains the previous value for exactly
 * this reason.
 */
export function withEditorRepository(state: ActiveRepositoryState, rootPath: string | undefined, atMs: number): ActiveRepositoryState {
  if (rootPath === undefined) {
    return state;
  }
  if (isActive(state, rootPath)) {
    return state;
  }
  return { ...state, editor: { rootPath, atMs } };
}

/**
 * Re-resolve the Source Control focus without treating the re-read as a new
 * statement: whatever moment the focus was observed at is kept.
 *
 * `seedAtMs` is used only when there is nothing recorded yet — the case where
 * the Git extension has only just become able to answer at all, so the moment
 * we learned the focus is the only moment there is.
 */
export function withResolvedFocusedRepository(state: ActiveRepositoryState, rootPath: string | undefined, seedAtMs: number): ActiveRepositoryState {
  if (rootPath === undefined) {
    return state.focused === undefined ? state : { ...state, focused: undefined };
  }
  const atMs = state.focused?.atMs ?? seedAtMs;
  if (state.focused && state.focused.atMs === atMs && samePath(state.focused.rootPath, rootPath)) {
    return state;
  }
  return { ...state, focused: { rootPath, atMs } };
}

/**
 * Re-resolve the active editor to a repository without inventing a selection
 * event. `seedAtMs` is the moment that editor was observed to become active,
 * which is genuinely known even when the Git extension could not yet say
 * which repository it belonged to.
 *
 * This is the fix for: editor in A, then Source Control focus on B, then an
 * unrelated repository C opens — the re-read caused by C used to re-stamp A
 * and jump the cockpit back to it.
 */
export function withResolvedEditorRepository(state: ActiveRepositoryState, rootPath: string | undefined, seedAtMs: number): ActiveRepositoryState {
  if (rootPath === undefined) {
    return state;
  }
  const atMs = state.editor?.atMs ?? seedAtMs;
  if (state.editor && state.editor.atMs === atMs && samePath(state.editor.rootPath, rootPath)) {
    return state;
  }
  return { ...state, editor: { rootPath, atMs } };
}

/** Whether this repository is already the answer, in which case no signal about it is news. */
function isActive(state: ActiveRepositoryState, rootPath: string): boolean {
  const current = activeRepositoryRoot(state);
  return current !== undefined && samePath(current, rootPath);
}

/**
 * Drop signals naming a repository that is no longer open, so a closed
 * repository cannot keep the cockpit scoped to it. `undefined` means the Git
 * extension told us nothing (it is inactive, or has opened nothing yet) and
 * the state is left alone — an absent answer is not an empty one.
 */
export function withKnownRepositories(state: ActiveRepositoryState, roots: readonly string[] | undefined): ActiveRepositoryState {
  if (roots === undefined) {
    return state;
  }
  const open = new Set(roots.map((root) => canonicalPath(root)));
  const keep = (signal: ActiveRepositorySignal | undefined) => (signal && open.has(canonicalPath(signal.rootPath)) ? signal : undefined);
  const next: ActiveRepositoryState = { focused: keep(state.focused), editor: keep(state.editor) };
  return next.focused === state.focused && next.editor === state.editor ? state : next;
}

// ---------------------------------------------------------------------------
// the fold: observations in, one repository out
// ---------------------------------------------------------------------------

/** One repository as the Git extension's API version 1 reports it, reduced to what the fold needs. */
export interface GitRepositoryView {
  /** Absolute repository/worktree root (`Repository.rootUri.fsPath`). */
  rootPath: string;
  /** `Repository.ui.selected` — focused in the Source Control view. */
  selected: boolean;
}

/**
 * The built-in Git extension, as far as this fold is concerned.
 *
 * `repositories()` returning `undefined` means the extension has answered
 * nothing at all — it is not installed, not active yet, or offers no API
 * version 1 — which is a different thing from an active extension with no
 * repository open (an empty array). The distinction is what keeps a window
 * that started before the Git extension from being permanently unscoped.
 */
export interface GitSource {
  repositories(): readonly GitRepositoryView[] | undefined;
  /**
   * The Git extension's own answer for which repository owns a path
   * (`API.getRepository`), or `undefined` when it declines. It knows about
   * submodules and worktrees, so it is asked before the containment fallback
   * below.
   */
  repositoryOf(fsPath: string): string | undefined;
}

/**
 * Folds the two public signals into one repository, keeping observations and
 * re-reads strictly apart.
 *
 * Every method returns the repository root the fold now resolves to, so the
 * adapter can decide whether anything changed without a second read.
 */
export class ActiveRepositoryFold {
  private state: ActiveRepositoryState = NO_ACTIVE_REPOSITORY;
  /**
   * The document in the active editor, and when it became active. Held as the
   * *path* rather than as a resolved repository so it can be re-resolved once
   * the Git extension is able to answer, without claiming the editor became
   * active at that later moment.
   */
  private editorDocument: { fsPath: string; atMs: number } | undefined;

  constructor(
    private readonly git: GitSource,
    /** When this window's tracker started; the seed for a signal with no observable moment of its own. */
    private readonly startedAtMs: number,
  ) {}

  /** The repository this window is in, or `undefined` when no signal names one. */
  get activeRepoRoot(): string | undefined {
    return activeRepositoryRoot(this.state);
  }

  /** Every repository root the Git extension has open; `undefined` when it has told us nothing. */
  get knownRepoRoots(): string[] | undefined {
    return this.git.repositories()?.map((repository) => repository.rootPath);
  }

  /**
   * A real `onDidChangeActiveTextEditor`. `fsPath` is `undefined` for an
   * editor with no file on disk, which is recorded as "nothing new to say"
   * rather than as leaving the repository.
   */
  editorActivated(fsPath: string | undefined, atMs: number): string | undefined {
    if (fsPath === undefined) {
      // An editor with no file on disk — a Settings tab, the Output panel, an
      // untitled buffer, or no editor at all — is not a statement about
      // repositories, so the previously observed document keeps its moment.
      // Re-stamping it here would let opening the log hand the lead back to an
      // editor the Source Control view has since moved away from.
      this.reresolve();
      return this.activeRepoRoot;
    }
    this.editorDocument = { fsPath, atMs };
    this.reresolve();
    this.state = withEditorRepository(this.state, this.editorRoot(), atMs);
    return this.activeRepoRoot;
  }

  /**
   * A real `Repository.ui.onDidChange`: the Source Control view moved its
   * focus, which is a deliberate statement and is stamped now.
   */
  focusChanged(atMs: number): string | undefined {
    this.reresolve();
    this.state = withFocusedRepository(this.state, this.focusedRoot(), atMs);
    return this.activeRepoRoot;
  }

  /**
   * A re-read: a repository opened or closed, or the Git extension only just
   * became available. Resolves the recorded observations again and stamps
   * nothing.
   */
  resync(): string | undefined {
    this.reresolve();
    return this.activeRepoRoot;
  }

  /**
   * Seed the editor that was already open when this window's tracker started.
   * Its moment is the tracker's own start, which is the earliest honest claim
   * that can be made about it.
   */
  seedActiveEditor(fsPath: string | undefined): string | undefined {
    if (fsPath !== undefined && this.editorDocument === undefined) {
      this.editorDocument = { fsPath, atMs: this.startedAtMs };
    }
    return this.resync();
  }

  private reresolve(): void {
    this.state = withKnownRepositories(this.state, this.knownRepoRoots);
    this.state = withResolvedFocusedRepository(this.state, this.focusedRoot(), this.startedAtMs);
    this.state = withResolvedEditorRepository(this.state, this.editorRoot(), this.editorDocument?.atMs ?? this.startedAtMs);
  }

  private focusedRoot(): string | undefined {
    return this.git.repositories()?.find((repository) => repository.selected)?.rootPath;
  }

  private editorRoot(): string | undefined {
    const fsPath = this.editorDocument?.fsPath;
    if (fsPath === undefined) {
      return undefined;
    }
    return repositoryOfPath(this.git, fsPath);
  }
}

/**
 * Which repository owns a path: the **deepest** repository root containing it.
 *
 * Both sources are consulted and then ranked together, rather than one being
 * trusted outright:
 *
 *  - the Git extension's own `API.getRepository`, which knows about submodules
 *    and worktrees;
 *  - every open repository root that contains the path.
 *
 * Repository roots nest — a worktree checked out inside its parent, a
 * repository inside a container folder — so containment alone is ambiguous and
 * only the most specific root is a correct answer. Ranking both sources
 * together means a shallower answer can never win over a deeper open root,
 * whichever source it came from, while the Git extension still decides every
 * tie (its answer is first, and the sort is stable) and still supplies roots
 * the containment scan cannot see.
 *
 * Depth is counted in path segments, not string length: `/code/a/b` is deeper
 * than `/code/aaaaaaaaaa`, and sorting by length said otherwise.
 */
export function repositoryOfPath(git: GitSource, fsPath: string): string | undefined {
  const owner = git.repositoryOf(fsPath);
  const contained = (git.repositories() ?? []).map((repository) => repository.rootPath).filter((root) => samePath(root, fsPath) || isInsidePath(fsPath, root));
  return [...(owner ? [owner] : []), ...contained].sort((a, b) => pathDepth(b) - pathDepth(a) || canonicalPath(b).length - canonicalPath(a).length)[0];
}

// ---------------------------------------------------------------------------
// wording: the contract, said out loud
// ---------------------------------------------------------------------------

/** The one name for going back to automatic selection, wherever it is offered. */
export const FOLLOW_ACTIVE_LABEL = "Follow active repository";
/** The one name for Agent Sparring's own repository/run chooser. */
/**
 * The history picker's name. It used to be "Select repository / run…", which
 * was the only control in the cockpit's repository line and so was also the
 * way people started work — and reading a list of finished runs is not how
 * you start work. Starting a plan is its own button now (Run Plan), and this
 * is what it says it is: the runs, including the finished ones, to look at.
 */
export const SELECT_RUN_LABEL = "History / Runs…";

/** The headline above the repository name, one per mode. */
export const CONTEXT_HEADLINE = {
  following: "Following repository",
  pinned: "Viewing pinned run from",
  unscoped: "Repository context",
} as const;

/** The second line, shown whenever a pin is in force so the pin can never hide where the window actually is. */
export const ACTIVE_CONTEXT_HEADLINE = "Active repository context";

/**
 * How the cockpit is scoped right now, as the Overview and the status bar
 * both state it.
 *
 * `mode` is the contract in one word: `pinned` — an explicit Agent Sparring
 * selection is in force; `following` — the repository of the active editor /
 * Source Control focus; `unscoped` — neither could be resolved, so every
 * discovered run is a candidate, which is the behaviour from before following
 * existed.
 */
export interface RepositoryContextView {
  mode: "following" | "pinned" | "unscoped";
  /** `Following repository` / `Viewing pinned run from` / `Repository context`. */
  headline: string;
  /** The repository named under that headline; absent only when nothing could be resolved. */
  repository?: string;
  /**
   * The repository the *window* is in, named whenever a pin is in force —
   * including when the pin is in that same repository, so the policy reads
   * the same way every time.
   */
  activeRepository?: string;
  /** Present when a pin is holding the cockpit away from the active repository. */
  away?: boolean;
  /** One line for a tooltip or the status bar. */
  text: string;
  /** The label of the control that releases a pin; present only when there is a pin to release. */
  release?: string;
  /** How the context was decided, for the details layer. Never the only place a fact appears. */
  explanation: string;
}

const FOLLOWING_EXPLANATION =
  "Agent Sparring follows the repository of the active editor or the Source Control view's focus. VS Code's own repository selector in the status bar is not readable by extensions, so it is not what this follows; Run Plan asks which repository, and History / Runs pins one explicitly.";
const PINNED_EXPLANATION = `This run was pinned through ${SELECT_RUN_LABEL}, and a pin is kept even when the window moves to another repository so that history stays open while you work elsewhere. ${FOLLOW_ACTIVE_LABEL} releases it, and starting a new plan run releases it too.`;
const UNSCOPED_EXPLANATION =
  "No repository could be resolved: the built-in Git extension has opened none, or has not answered yet. Nothing is scoped away, so every discovered run is a candidate.";

/**
 * The repository context of a selection, said the same way everywhere.
 *
 * A pin is only called out as holding the cockpit *away* from somewhere when
 * it actually is: pinning a run in the repository you are already in is not a
 * conflict, and claiming otherwise would put a warning on the screen that
 * nothing is wrong with.
 */
export function describeRepositoryContext(selection: RunSelection): RepositoryContextView {
  const scope = selection.scope;
  if (selection.pinned && selection.selected) {
    const pinnedTo = selection.selected.location.folderName;
    const away = Boolean(scope) && !samePath(selection.selected.location.repoRoot, scope?.repoRoot ?? "");
    return {
      mode: "pinned",
      headline: CONTEXT_HEADLINE.pinned,
      repository: pinnedTo,
      activeRepository: scope?.name,
      ...(away ? { away: true } : {}),
      text: away
        ? `Pinned to a run in ${pinnedTo}, while this window is in ${scope?.name}.`
        : scope
          ? `Pinned to this run in ${pinnedTo}.`
          : `Pinned to a run in ${pinnedTo}; no active repository could be resolved.`,
      release: FOLLOW_ACTIVE_LABEL,
      explanation: PINNED_EXPLANATION,
    };
  }
  if (scope) {
    return {
      mode: "following",
      headline: CONTEXT_HEADLINE.following,
      repository: scope.name,
      text: `Following the active repository: ${scope.name}.`,
      explanation: FOLLOWING_EXPLANATION,
    };
  }
  return {
    mode: "unscoped",
    headline: CONTEXT_HEADLINE.unscoped,
    text: "No active repository resolved; every discovered run is a candidate.",
    explanation: UNSCOPED_EXPLANATION,
  };
}

/**
 * Title for the empty state. Naming the repository is the whole point: "No
 * active run" left it possible to believe the cockpit was still looking at
 * the repository you had just left.
 */
export function emptyStateTitle(selection: RunSelection): string {
  return selection.scope ? `No Agent Sparring run for ${selection.scope.name}` : "No active run";
}

/**
 * The sentences under that title. They say what was looked for, what exists
 * elsewhere (by name), and — because an empty cockpit is exactly where a
 * wrapper would be tempted to be helpful — that nothing has been started.
 */
export function emptyStateLines(selection: RunSelection): string[] {
  const lines: string[] = [];
  if (selection.scope) {
    lines.push(`This repository has no .sparring plan run or stage on disk. Nothing has been started or created for it.`);
  } else {
    lines.push("No recorded plan run or stage in this workspace.");
  }
  const elsewhere = describeElsewhere(selection.elsewhere ?? []);
  if (elsewhere) {
    lines.push(elsewhere);
  }
  const unattributed = describeUnattributed(selection.unattributed ?? []);
  if (unattributed) {
    lines.push(unattributed);
  }
  return lines;
}

/**
 * The runs in other repositories, named. A count on its own ("3 runs
 * elsewhere") tells someone that something exists without telling them where,
 * which is the kind of half-claim this cockpit does not make.
 */
export function describeElsewhere(runs: readonly RunSnapshot[]): string | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  return `Agent Sparring has also discovered ${countByRepository(runs)}. ${SELECT_RUN_LABEL} pins one of those to inspect it.`;
}

/**
 * Runs that no repository the Git extension has opened owns.
 *
 * They are never selected automatically — attributing them to the active
 * repository would be a guess, and a guess is exactly what produces "Following
 * the active repository: B" above a run from A. They stay in the picker, and
 * the empty state says they are there.
 */
export function describeUnattributed(runs: readonly RunSnapshot[]): string | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  return `Agent Sparring has also discovered ${countByRepository(runs)} that could not be attributed to any repository the Git extension has opened; nothing is selected from those automatically. ${SELECT_RUN_LABEL} reaches them.`;
}

function countByRepository(runs: readonly RunSnapshot[]): string {
  const byRepository = new Map<string, number>();
  for (const run of runs) {
    byRepository.set(run.location.folderName, (byRepository.get(run.location.folderName) ?? 0) + 1);
  }
  return [...byRepository.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} in ${name}`)
    .join(", ");
}
