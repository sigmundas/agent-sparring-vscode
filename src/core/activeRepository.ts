/**
 * Which repository this VS Code window is *in*, folded from the signals the
 * public API actually offers.
 *
 * VS Code has the concept internally — `ISCMViewService.activeRepository` is
 * `pinned ?? latestChangedOf(activeEditorRepository, scmFocusedRepository)`,
 * and the lower-left repository selector is the status bar entry
 * `status.scm.provider`, whose command `scm.setActiveProvider` calls
 * `pinActiveRepository`. None of that is public: `vscode.scm` exposes only
 * `createSourceControl`, and core publishes the active repository solely as
 * the context keys `scmActiveRepositoryName` / `scmActiveRepositoryBranchName`,
 * which an extension can test in a `when` clause but cannot read as values.
 *
 * What *is* public, and stable, is the built-in Git extension's API version 1:
 *
 *  - `Repository.ui.selected` / `Repository.ui.onDidChange` — fed by core from
 *    `scmViewService.onDidFocusRepository`, so it tracks which repository is
 *    focused in the Source Control view. Exactly one repository is selected at
 *    a time; the previous one is set back to false.
 *  - `API.getRepository(uri)`, plus `vscode.window.onDidChangeActiveTextEditor`
 *    — the repository owning the document you are looking at.
 *
 * Those are the same two inputs core folds together, so this module folds them
 * the same way: the most recently changed one wins. The one input we cannot
 * see is the user's explicit *pin* from the lower-left selector, which reaches
 * no extension at all. Agent Sparring therefore offers its own explicit pin
 * (see discovery.selectRun's `preferred`) and says which repository it has
 * resolved, so a disagreement is visible and correctable rather than silent.
 *
 * The wording for all of this lives here too, so the status bar, the Run
 * Overview and the run picker can never disagree about which repository the
 * cockpit is in or whether it is following or pinned.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import type { RunSelection, RunSnapshot } from "./discovery";

export interface ActiveRepositorySignal {
  /** Absolute repository/worktree root, exactly as the Git extension reports it. */
  rootPath: string;
  /** When this signal last changed (epoch ms). */
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
 * The repository the window is in: whichever signal changed most recently.
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

/** Whether this repository is already the answer, in which case no signal about it is news. */
function isActive(state: ActiveRepositoryState, rootPath: string): boolean {
  const current = activeRepositoryRoot(state);
  return current !== undefined && path.resolve(current) === path.resolve(rootPath);
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
  const open = new Set(roots.map((root) => path.resolve(root)));
  const keep = (signal: ActiveRepositorySignal | undefined) => (signal && open.has(path.resolve(signal.rootPath)) ? signal : undefined);
  const next: ActiveRepositoryState = { focused: keep(state.focused), editor: keep(state.editor) };
  return next.focused === state.focused && next.editor === state.editor ? state : next;
}

// ---------------------------------------------------------------------------
// wording: following, pinned, and the honest empty state
// ---------------------------------------------------------------------------

/** The one name for going back to automatic selection, wherever it is offered. */
export const FOLLOW_ACTIVE_LABEL = "Follow the active repository";

export interface FollowingView {
  /**
   * `following` — automatic selection, confined to the repository this window
   * is in; `pinned` — the user chose one run explicitly and it is kept even
   * when the window moves to another repository; `unscoped` — no repository
   * could be resolved (the Git extension told us nothing), so every discovered
   * run is a candidate, which is the behaviour from before following existed.
   */
  mode: "following" | "pinned" | "unscoped";
  /** One line for a footer or tooltip. */
  text: string;
  /** Present only when the pin is holding the cockpit away from the active repository. */
  release?: string;
}

/**
 * How the cockpit is currently scoped, said plainly.
 *
 * A pin is only called out as holding the cockpit *away* from somewhere when
 * it actually is: pinning a run in the repository you are already in is not a
 * conflict, and claiming otherwise would put a warning on the screen that
 * nothing is wrong with.
 */
export function describeFollowing(selection: RunSelection): FollowingView {
  const scope = selection.scope;
  if (selection.pinned && selection.selected) {
    const pinnedTo = selection.selected.location.folderName;
    if (!scope || path.resolve(selection.selected.location.repoRoot) === scope.repoRoot) {
      return { mode: "pinned", text: `Pinned to this run in ${pinnedTo}.`, release: `${FOLLOW_ACTIVE_LABEL} instead.` };
    }
    return {
      mode: "pinned",
      text: `Pinned to a run in ${pinnedTo}, while this window is in ${scope.name}.`,
      release: `${FOLLOW_ACTIVE_LABEL} to follow ${scope.name} again.`,
    };
  }
  if (scope) {
    return { mode: "following", text: `Following the active repository: ${scope.name}.` };
  }
  return { mode: "unscoped", text: "No active repository resolved; every discovered run is a candidate." };
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
  const byRepository = new Map<string, number>();
  for (const run of runs) {
    byRepository.set(run.location.folderName, (byRepository.get(run.location.folderName) ?? 0) + 1);
  }
  const parts = [...byRepository.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => `${count} in ${name}`);
  return `Agent Sparring has also discovered ${parts.join(", ")}. Select Repository / Run pins one of those to inspect it.`;
}
