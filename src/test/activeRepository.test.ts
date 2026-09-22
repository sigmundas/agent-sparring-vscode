/**
 * The repository context: which repository Agent Sparring is in, how it got
 * there, and what it is allowed to claim about it.
 *
 * The original bug: the window's active Git repository was switched from
 * `sporely-py-reported-statistics` to `sporely-py-inaturalist-republish-media`
 * and the cockpit went on showing the completed reported-statistics plan run,
 * because run selection knew about workspace folders and nothing about which
 * repository the window was in.
 *
 * The contract, as the UI now states it:
 *
 * ```
 * Agent Sparring repository context =
 *     the explicitly pinned Agent Sparring repository/run, if one is pinned
 *     otherwise the repository of the active editor / Source Control focus
 * ```
 *
 * It is deliberately not "whatever VS Code's lower-left repository selector
 * says" — no public API exposes that — so the resolved repository is named on
 * screen rather than left to be assumed.
 *
 * Four layers are covered here: the fold that decides which repository the
 * window is in (core/activeRepository.ts), its lifecycle against a Git
 * extension that is not ready yet, the scoped selection that decides which run
 * to show (discovery.selectRun's `scope`), and what the Overview and status
 * bar say about all of it.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  ACTIVE_CONTEXT_HEADLINE,
  ActiveRepositoryFold,
  CONTEXT_HEADLINE,
  FOLLOW_ACTIVE_LABEL,
  NO_ACTIVE_REPOSITORY,
  SELECT_RUN_LABEL,
  activeRepositoryRoot,
  describeRepositoryContext,
  emptyStateLines,
  emptyStateTitle,
  withEditorRepository,
  withFocusedRepository,
  withKnownRepositories,
  type GitRepositoryView,
  type GitSource,
} from "../core/activeRepository";
import {
  attributeRun,
  discoverRuns,
  locateAll,
  repositoryDisplayName,
  repositoryOwning,
  runIdFor,
  runsInRepository,
  selectRun,
  type RepositoryScope,
  type RunSnapshot,
  type SparringLocation,
} from "../core/discovery";
import { isActionMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel } from "../core/overviewModel";
import { deriveStatus } from "../core/status";
import { Workspace } from "./fixtures";
import { elementFrom, runWebviewScript } from "./webviewShim";

const NOW = Date.parse("2026-09-15T20:00:00.000Z");

async function folders(...workspaces: Workspace[]) {
  return locateAll(workspaces.map((ws) => ({ path: ws.root, name: path.basename(ws.root) })));
}

/** The scope the controller builds: the repository the window is in, plus every root it can see. */
function scopeOf(active: Workspace, ...open: Workspace[]): RepositoryScope {
  return { repoRoot: active.root, knownRoots: [active, ...open].map((ws) => ws.root) };
}

function idsOf(runs: readonly RunSnapshot[] | undefined): string[] {
  return (runs ?? []).map((run) => run.id);
}

// ---------------------------------------------------------------------------
// which repository the window is in
// ---------------------------------------------------------------------------

describe("the repository this window is in", () => {
  it("is whichever public signal was observed most recently", () => {
    let state = withEditorRepository(NO_ACTIVE_REPOSITORY, "/code/alpha", 1_000);
    assert.equal(activeRepositoryRoot(state), "/code/alpha");

    // Focusing beta in the Source Control view is the newer statement.
    state = withFocusedRepository(state, "/code/beta", 2_000);
    assert.equal(activeRepositoryRoot(state), "/code/beta");

    // Opening a file in alpha again is newer still.
    state = withEditorRepository(state, "/code/alpha", 3_000);
    assert.equal(activeRepositoryRoot(state), "/code/alpha");
  });

  it("an editor that belongs to no repository says nothing, and does not empty the answer", () => {
    const state = withEditorRepository(NO_ACTIVE_REPOSITORY, "/code/alpha", 1_000);
    // A Settings tab, the Output panel, a scratch buffer, or no editor at all.
    assert.equal(activeRepositoryRoot(withEditorRepository(state, undefined, 2_000)), "/code/alpha");
  });

  it("re-focusing the repository an editor has since led away from does move the answer back", () => {
    let state = withFocusedRepository(NO_ACTIVE_REPOSITORY, "/code/alpha", 1_000);
    state = withEditorRepository(state, "/code/beta", 2_000);
    assert.equal(activeRepositoryRoot(state), "/code/beta");
    // Clicking alpha again in the Source Control view. The focus slot already
    // said alpha, but alpha is not the answer any more, so this is news.
    state = withFocusedRepository(state, "/code/alpha", 3_000);
    assert.equal(activeRepositoryRoot(state), "/code/alpha");
  });

  it("a signal naming the repository that is already the answer changes nothing", () => {
    const state = withFocusedRepository(NO_ACTIVE_REPOSITORY, "/code/alpha", 1_000);
    assert.equal(withFocusedRepository(state, "/code/alpha", 2_000), state);
    assert.equal(withEditorRepository(state, "/code/alpha", 2_000), state);
  });

  it("a closed repository stops scoping the window; an absent answer changes nothing", () => {
    let state = withFocusedRepository(NO_ACTIVE_REPOSITORY, "/code/beta", 2_000);
    state = withEditorRepository(state, "/code/alpha", 1_000);
    assert.equal(activeRepositoryRoot(withKnownRepositories(state, ["/code/alpha"])), "/code/alpha", "beta was closed");
    assert.equal(activeRepositoryRoot(withKnownRepositories(state, [])), undefined, "nothing open, nothing claimed");
    assert.equal(
      activeRepositoryRoot(withKnownRepositories(state, undefined)),
      "/code/beta",
      "the Git extension told us nothing; that is not the same as telling us nothing is open",
    );
  });
});

// ---------------------------------------------------------------------------
// the fold's lifecycle: a Git extension that is not ready yet, and re-reads
// ---------------------------------------------------------------------------

/** A stand-in for the built-in Git extension's API version 1, which can start out unavailable. */
class FakeGit implements GitSource {
  /** `undefined` until `activate()`: the extension has answered nothing at all. */
  private open: GitRepositoryView[] | undefined;

  activate(repositories: { rootPath: string; selected?: boolean }[]): void {
    this.open = repositories.map((repository) => ({ rootPath: repository.rootPath, selected: repository.selected ?? false }));
  }

  openRepository(rootPath: string, selected = false): void {
    (this.open ??= []).push({ rootPath, selected });
  }

  focus(rootPath: string): void {
    for (const repository of this.open ?? []) {
      repository.selected = repository.rootPath === rootPath;
    }
  }

  repositories(): readonly GitRepositoryView[] | undefined {
    return this.open;
  }

  repositoryOf(fsPath: string): string | undefined {
    return (this.open ?? [])
      .map((repository) => repository.rootPath)
      .filter((root) => fsPath === root || fsPath.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length)[0];
  }
}

describe("the fold against a Git extension that activates late", () => {
  /**
   * The blocking case from the independent review. Agent Sparring is activated
   * by `workspaceContains:.sparring` and can easily beat the Git extension,
   * which is activated by `*`. Reading `isActive` once and giving up made that
   * a permanent failure — `vscode.extensions.onDidChange` fires when the set
   * of *installed* extensions changes, not when one activates, so nothing came
   * back. The adapter now awaits `Extension.activate()` and retries from every
   * later signal; the fold must resolve as soon as the API can answer.
   */
  it("resolves the repository once Git activates, and again on the next editor/SCM signal", () => {
    const git = new FakeGit();
    const fold = new ActiveRepositoryFold(git, 1_000);

    // Agent Sparring started first. The editor is open, but nothing can say
    // which repository it belongs to yet.
    assert.equal(fold.seedActiveEditor("/code/alpha/src/main.ts"), undefined, "no answer while the Git extension is silent");
    assert.equal(fold.knownRepoRoots, undefined, "and 'unknown' is not the same as 'no repositories open'");

    // An editor change before Git is ready is still recorded, and still
    // resolves to nothing.
    assert.equal(fold.editorActivated("/code/alpha/src/other.ts", 2_000), undefined);

    // Git activates. The re-read alone resolves the editor that was already
    // open — this is the retry path, and it must not need a new gesture.
    git.activate([{ rootPath: "/code/alpha" }, { rootPath: "/code/beta" }]);
    assert.equal(fold.resync(), "/code/alpha", "the editor that was already open resolves as soon as Git can answer");
    assert.deepEqual(fold.knownRepoRoots, ["/code/alpha", "/code/beta"]);

    // And a signal arriving after activation resolves correctly too.
    assert.equal(fold.editorActivated("/code/beta/src/main.ts", 3_000), "/code/beta");
    git.focus("/code/alpha");
    assert.equal(fold.focusChanged(4_000), "/code/alpha");
  });

  it("resolves from an SCM focus alone when no editor was ever open", () => {
    const git = new FakeGit();
    const fold = new ActiveRepositoryFold(git, 1_000);
    assert.equal(fold.seedActiveEditor(undefined), undefined);

    git.activate([{ rootPath: "/code/alpha", selected: true }]);
    assert.equal(fold.resync(), "/code/alpha");
  });

  /**
   * The second blocking case. A re-read carries no new selection, so it must
   * not stamp one — otherwise an unrelated repository opening hands the lead
   * back to an editor the user navigated away from.
   */
  it("a repository opening elsewhere does not re-stamp the editor and jump the cockpit back", () => {
    const git = new FakeGit();
    git.activate([{ rootPath: "/code/alpha" }, { rootPath: "/code/beta" }]);
    const fold = new ActiveRepositoryFold(git, 1_000);

    // editor A → SCM focus B.
    assert.equal(fold.editorActivated("/code/alpha/src/main.ts", 2_000), "/code/alpha");
    git.focus("/code/beta");
    assert.equal(fold.focusChanged(3_000), "/code/beta");

    // An unrelated repository C opens. Nothing about the user's attention
    // changed, so nothing about the answer may change.
    git.openRepository("/code/gamma");
    assert.equal(fold.resync(), "/code/beta", "the re-read invented no new editor selection");

    // Twice more, for good measure: a re-read is never an event.
    assert.equal(fold.resync(), "/code/beta");
    git.openRepository("/code/delta");
    assert.equal(fold.resync(), "/code/beta");

    // A real editor change still wins, because it really is news.
    assert.equal(fold.editorActivated("/code/alpha/src/main.ts", 4_000), "/code/alpha");
  });

  it("an editor with no file on disk does not re-stamp the one before it", () => {
    const git = new FakeGit();
    git.activate([{ rootPath: "/code/alpha" }, { rootPath: "/code/beta" }]);
    const fold = new ActiveRepositoryFold(git, 1_000);

    assert.equal(fold.editorActivated("/code/alpha/src/main.ts", 2_000), "/code/alpha");
    git.focus("/code/beta");
    assert.equal(fold.focusChanged(3_000), "/code/beta");

    // Opening the Output panel, Settings, or an untitled buffer.
    assert.equal(fold.editorActivated(undefined, 4_000), "/code/beta", "reading the log does not move the cockpit");
    assert.equal(fold.editorActivated(undefined, 5_000), "/code/beta");
  });

  it("a repository closing releases the window from it", () => {
    const git = new FakeGit();
    git.activate([{ rootPath: "/code/alpha" }, { rootPath: "/code/beta" }]);
    const fold = new ActiveRepositoryFold(git, 1_000);
    assert.equal(fold.editorActivated("/code/beta/src/main.ts", 2_000), "/code/beta");

    git.activate([{ rootPath: "/code/alpha" }]);
    assert.equal(fold.resync(), undefined, "beta is gone, and nothing else has been named");
  });

  it("a worktree inside its parent repository owns its own files", () => {
    const git = new FakeGit();
    git.activate([{ rootPath: "/code/sporely" }, { rootPath: "/code/sporely/worktrees/republish" }]);
    const fold = new ActiveRepositoryFold(git, 1_000);
    assert.equal(fold.editorActivated("/code/sporely/worktrees/republish/src/main.ts", 2_000), "/code/sporely/worktrees/republish");
    assert.equal(fold.editorActivated("/code/sporely/src/main.ts", 3_000), "/code/sporely");
  });
});

// ---------------------------------------------------------------------------
// switching the active repository switches the cockpit
// ---------------------------------------------------------------------------

describe("switching the active repository switches the cockpit", () => {
  it("active repository A → active repository B selects B's run and drops A's", async () => {
    const a = await Workspace.create({ name: "sporely-py-reported-statistics" });
    const b = await Workspace.create({ name: "sporely-py-inaturalist-republish-media" });
    await a.writeStage("stage-reported-statistics", { status: "accepted", candidate_sha: "aaa" });
    await b.writeStage("stage-republish-media", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    const aId = runIdFor(a.location, "stage", "stage-reported-statistics");
    const bId = runIdFor(b.location, "stage", "stage-republish-media");

    // In A, with A remembered: A is what the cockpit shows.
    let selection = selectRun(runs, undefined, aId, scopeOf(a, b));
    assert.equal(selection.selected?.id, aId);
    assert.equal(selection.scope?.name, "sporely-py-reported-statistics");

    // The window moves to B. A is still the remembered run, and must lose.
    selection = selectRun(runs, undefined, aId, scopeOf(b, a));
    assert.equal(selection.selected?.id, bId, "the cockpit follows the window into B");
    assert.equal(selection.scope?.name, "sporely-py-inaturalist-republish-media");
    assert.deepEqual(idsOf(selection.elsewhere), [aId]);
    assert.equal(selection.pinned, undefined, "automatic selection, not a pin");
  });

  it("repository B with no run clears A rather than displaying stale A", async () => {
    const a = await Workspace.create({ name: "sporely-py-reported-statistics" });
    const b = await Workspace.create({ sparring: false, name: "sporely-py-inaturalist-republish-media" });
    await a.writePlan();
    await a.writePlanRun("reported-statistics-0badc0de", {
      plan: "docs/plans/foo.md",
      status: "complete",
      current_stage_index: 2,
      current_stage: "reported-statistics-0badc0de-stage-3-device-ui-check",
    });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    assert.equal(runs.length, 1, "only A has recorded anything");
    const aId = runs[0].id;

    // B has no .sparring at all. locateAll therefore reports no location for
    // it, which is exactly the case that used to leave A on screen.
    const selection = selectRun(runs, undefined, aId, scopeOf(b, a));
    assert.equal(selection.selected, undefined, "A's completed plan run is not shown while the window is in B");
    assert.deepEqual(selection.ambiguous, []);
    assert.equal(selection.scope?.name, "sporely-py-inaturalist-republish-media");
    assert.deepEqual(idsOf(selection.elsewhere), [aId]);

    // And the empty state names the repository rather than saying "No active run".
    assert.equal(emptyStateTitle(selection), "No Agent Sparring run for sporely-py-inaturalist-republish-media");
    const lines = emptyStateLines(selection);
    assert.match(lines[0], /no \.sparring plan run or stage on disk/);
    assert.match(lines[0], /Nothing has been started or created/, "the wrapper does not offer to invent a run");
    assert.match(lines[1], /1 in sporely-py-reported-statistics/, "what exists elsewhere is named, not just counted");

    const view = deriveStatus(selection, undefined, NOW);
    assert.equal(view.text, "$(circle-outline) Agent Sparring: No run for sporely-py-inaturalist-republish-media");
    assert.match(view.tooltip, /^No Agent Sparring run for sporely-py-inaturalist-republish-media/);

    const model = buildOverviewModel(selection, undefined, undefined, NOW);
    assert.equal(model.kind, "empty");
    assert.equal(model.title, "No Agent Sparring run for sporely-py-inaturalist-republish-media");
    assert.equal(model.repositoryContext?.mode, "following");
  });

  it("repository B with a run selects B even while A has the livelier run", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    // A has an open plan run: the strongest thing automatic selection can find.
    await a.writePlan();
    await a.writePlanRun("foo-1cd13d24", {
      plan: "docs/plans/foo.md",
      status: "running",
      current_stage_index: 0,
      current_stage: "foo-1cd13d24-stage-1-contract",
    });
    await a.writeStage("foo-1cd13d24-stage-1-contract", { status: "working" });
    // B has only an accepted stage.
    await b.writeStage("stage-republish-media", { status: "accepted", candidate_sha: "bbb" });
    const runs = (await discoverRuns(await folders(a, b))).runs;

    const selection = selectRun(runs, undefined, undefined, scopeOf(b, a));
    assert.equal(selection.selected?.location.folderName, "beta");
    assert.equal(selection.selected?.id, runIdFor(b.location, "stage", "stage-republish-media"));
    assert.deepEqual(
      idsOf(selection.elsewhere),
      [runIdFor(a.location, "plan", "foo-1cd13d24")],
      "A's plan run is out of scope, not gone: the picker still lists it",
    );
  });

  it("several open runs in the active repository are still ambiguous — scoping narrows, it does not guess", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await b.writeStage("one", { status: "working" });
    await b.writeStage("two", { status: "working" });
    await a.writeStage("elsewhere", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;

    const selection = selectRun(runs, undefined, undefined, scopeOf(b, a));
    assert.equal(selection.selected, undefined);
    assert.deepEqual(
      selection.ambiguous.map((run) => run.location.folderName),
      ["beta", "beta"],
      "only the active repository's runs are candidates",
    );
  });
});

// ---------------------------------------------------------------------------
// strict attribution: what may be shown under "Following the active repository"
// ---------------------------------------------------------------------------

describe("a run is only B's when it can be shown to be B's", () => {
  /**
   * The blocking finding. A run that no known repository root owns used to be
   * kept as a candidate wherever the window happened to be, so the cockpit
   * could display A's work under the words "Following the active repository:
   * B". It is not attributable, so it is not attributed — and it stays in the
   * explicit picker, which is the honest place for it.
   */
  it("a run no known repository root owns is never selected automatically", async () => {
    const repo = await Workspace.create({ name: "beta" });
    const loose = await Workspace.create({ name: "notes" });
    await loose.writeStage("stage-loose", { status: "working" });
    const runs = (await discoverRuns(await folders(repo, loose))).runs;
    const looseId = runIdFor(loose.location, "stage", "stage-loose");

    assert.equal(attributeRun(runs[0], repo.root, [repo.root]), "unattributed");
    assert.deepEqual(runsInRepository(runs, repo.root, [repo.root]), [], "nothing here is beta's");

    const selection = selectRun(runs, undefined, undefined, { repoRoot: repo.root, knownRoots: [repo.root] });
    assert.equal(selection.selected, undefined, "the honest empty state, not somebody else's run");
    assert.deepEqual(idsOf(selection.unattributed), [looseId]);
    assert.equal(selection.elsewhere, undefined, "it is not known to be elsewhere either; it is not known to be anywhere");

    // Said out loud, so the run is reachable rather than merely invisible.
    const lines = emptyStateLines(selection);
    assert.ok(
      lines.some((line) => /could not be attributed to any repository/.test(line) && /1 in notes/.test(line)),
      `the empty state names them: ${lines.join(" | ")}`,
    );
    assert.ok(
      lines.some((line) => line.includes(SELECT_RUN_LABEL)),
      "and says how to reach them",
    );
  });

  it("a remembered run that has become unattributable does not come back as B's", async () => {
    const repo = await Workspace.create({ name: "beta" });
    const loose = await Workspace.create({ name: "notes" });
    await loose.writeStage("stage-loose", { status: "accepted", candidate_sha: "aaa" });
    const runs = (await discoverRuns(await folders(repo, loose))).runs;
    const looseId = runIdFor(loose.location, "stage", "stage-loose");

    const selection = selectRun(runs, undefined, looseId, { repoRoot: repo.root, knownRoots: [repo.root] });
    assert.equal(selection.selected, undefined, "remembering it is not evidence that it belongs here");
  });

  it("but an explicit pin still reaches it: not selectable automatically is not unreachable", async () => {
    const repo = await Workspace.create({ name: "beta" });
    const loose = await Workspace.create({ name: "notes" });
    await loose.writeStage("stage-loose", { status: "working" });
    const runs = (await discoverRuns(await folders(repo, loose))).runs;
    const looseId = runIdFor(loose.location, "stage", "stage-loose");

    const pinned = selectRun(runs, { id: looseId, atMs: NOW }, undefined, { repoRoot: repo.root, knownRoots: [repo.root] });
    assert.equal(pinned.selected?.id, looseId);
    assert.equal(pinned.pinned, true);
    assert.equal(describeRepositoryContext(pinned).mode, "pinned");
  });

  it("with no repository resolved at all, nothing is scoped and every run is a candidate", async () => {
    const a = await Workspace.create({ name: "alpha" });
    await a.writeStage("stage-a", { status: "working" });
    const runs = (await discoverRuns(await folders(a))).runs;

    const selection = selectRun(runs, undefined, undefined, undefined);
    assert.equal(selection.selected?.id, runIdFor(a.location, "stage", "stage-a"));
    assert.equal(selection.scope, undefined);
    assert.equal(describeRepositoryContext(selection).mode, "unscoped");
    assert.equal(emptyStateTitle({ ambiguous: [] }), "No active run", "unscoped keeps the old wording; it names no repository it cannot name");
  });
});

// ---------------------------------------------------------------------------
// pinning, and the way back
// ---------------------------------------------------------------------------

describe("pinning a run, and following the active repository again", () => {
  it("an explicit pin survives the window moving to another repository, and names both repositories", async () => {
    const a = await Workspace.create({ name: "sporely-py-reported-statistics" });
    const b = await Workspace.create({ name: "sporely-py-inaturalist-republish-media" });
    await a.writeStage("stage-reported-statistics", { status: "accepted", candidate_sha: "aaa" });
    await b.writeStage("stage-republish-media", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    const aId = runIdFor(a.location, "stage", "stage-reported-statistics");

    // The user pinned A's finished stage to inspect it, then moved to B.
    const selection = selectRun(runs, { id: aId, atMs: NOW }, aId, scopeOf(b, a));
    assert.equal(selection.selected?.id, aId, "explicit inspection is not undone by following");
    assert.equal(selection.pinned, true);

    const context = describeRepositoryContext(selection);
    assert.equal(context.mode, "pinned");
    assert.equal(context.headline, CONTEXT_HEADLINE.pinned);
    assert.equal(context.repository, "sporely-py-reported-statistics", "the repository the pinned run is from");
    assert.equal(context.activeRepository, "sporely-py-inaturalist-republish-media", "and the one this window is actually in");
    assert.equal(context.away, true);
    assert.equal(context.release, FOLLOW_ACTIVE_LABEL);

    const model = buildOverviewModel(selection, undefined, undefined, NOW);
    assert.equal(model.repositoryContext?.mode, "pinned");
    assert.ok(model.repositoryContext?.release, "the Overview carries the way out, not only the Command Palette");
  });

  it("a pin inside the repository the window is already in is not reported as a conflict", async () => {
    const b = await Workspace.create({ name: "beta" });
    await b.writeStage("one", { status: "working" });
    await b.writeStage("two", { status: "working" });
    const runs = (await discoverRuns(await folders(b))).runs;
    const oneId = runIdFor(b.location, "stage", "one");

    const context = describeRepositoryContext(selectRun(runs, { id: oneId, atMs: NOW }, undefined, scopeOf(b)));
    assert.equal(context.mode, "pinned");
    assert.equal(context.away, undefined, "no claim that the pin is holding the cockpit elsewhere");
    assert.equal(context.text, "Pinned to this run in beta.");
    assert.equal(context.activeRepository, "beta", "both lines are still shown, so the policy reads the same way every time");
  });

  it("releasing the pin returns to automatic selection in the active repository", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await a.writeStage("stage-a", { status: "accepted", candidate_sha: "aaa" });
    await b.writeStage("stage-b", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    const aId = runIdFor(a.location, "stage", "stage-a");
    const scope = scopeOf(b, a);

    const pinned = selectRun(runs, { id: aId, atMs: NOW }, aId, scope);
    assert.equal(pinned.selected?.id, aId);

    // What the controller does for "Follow active repository": the preference
    // is cleared. The sticky memory of A is deliberately kept, and must not
    // resurrect it.
    const released = selectRun(runs, undefined, aId, scope);
    assert.equal(released.selected?.id, runIdFor(b.location, "stage", "stage-b"));
    assert.equal(released.pinned, undefined);
    assert.equal(describeRepositoryContext(released).mode, "following");

    // Returning to A finds its run again: the memory was ignored, not thrown away.
    const back = selectRun(runs, undefined, aId, scopeOf(a, b));
    assert.equal(back.selected?.id, aId);
  });
});

// ---------------------------------------------------------------------------
// worktrees and nested checkouts
// ---------------------------------------------------------------------------

describe("repositories with different roots do not bleed into each other", () => {
  it("two worktrees of the same repository, side by side, are two repositories", async () => {
    const main = await Workspace.create({ name: "sporely-py-inaturalist-republish-media" });
    const worktree = await Workspace.create({ name: "sporely-py-inaturalist-republish-media-wt" });
    await main.writeStage("stage-on-main", { status: "accepted", candidate_sha: "aaa" });
    await worktree.writeStage("stage-on-worktree", { status: "working" });
    const runs = (await discoverRuns(await folders(main, worktree))).runs;

    // The branch checked out in each is irrelevant: only the roots decide.
    const inMain = selectRun(runs, undefined, undefined, scopeOf(main, worktree));
    assert.equal(inMain.selected?.id, runIdFor(main.location, "stage", "stage-on-main"));
    const inWorktree = selectRun(runs, undefined, undefined, scopeOf(worktree, main));
    assert.equal(inWorktree.selected?.id, runIdFor(worktree.location, "stage", "stage-on-worktree"));
  });

  it("a worktree checked out inside its parent repository belongs to itself, not to the parent", async () => {
    const parent = await Workspace.create({ name: "sporely" });
    const nested = await Workspace.createNested(parent.root, "worktrees/republish-media");
    await parent.writeStage("stage-in-parent", { status: "working" });
    await nested.writeStage("stage-in-worktree", { status: "working" });
    const locations = await folders(parent);
    assert.equal(locations.length, 2, "the nested project is discovered under the workspace folder");
    const runs = (await discoverRuns(locations)).runs;
    const roots = [parent.root, nested.root];

    // Deepest root wins, so the container does not swallow the worktree.
    const nestedLocation = locations.find((location) => location.projectDir === nested.root) as SparringLocation;
    assert.equal(repositoryOwning(nestedLocation, roots), nested.root);

    const inNested = selectRun(runs, undefined, undefined, { repoRoot: nested.root, knownRoots: roots });
    assert.equal(inNested.selected?.location.projectDir, nested.root);
    assert.deepEqual(
      idsOf(inNested.elsewhere).map((id) => id.split("|").pop()),
      ["stage:stage-in-parent"],
    );

    const inParent = selectRun(runs, undefined, undefined, { repoRoot: parent.root, knownRoots: roots });
    assert.equal(inParent.selected?.location.projectDir, parent.root);
    assert.deepEqual(
      idsOf(inParent.elsewhere).map((id) => id.split("|").pop()),
      ["stage:stage-in-worktree"],
    );
  });

  /**
   * Two worktrees can easily have the same directory name under different
   * parents, and a context line that calls both of them `republish-media` is
   * worse than no context line at all.
   */
  it("worktrees with the same basename are told apart by their parent", () => {
    const roots = ["/code/main/republish-media", "/code/worktrees/republish-media", "/code/other"];
    assert.equal(repositoryDisplayName("/code/main/republish-media", roots), "main/republish-media");
    assert.equal(repositoryDisplayName("/code/worktrees/republish-media", roots), "worktrees/republish-media");
    assert.equal(repositoryDisplayName("/code/other", roots), "other", "a name nothing clashes with stays plain");
  });

  it("a repository root reached through a different spelling is still the same repository", async () => {
    // Case differs on macOS and Windows, where the file system does not care.
    const ws = await Workspace.create({ name: "Beta" });
    await ws.writeStage("stage-b", { status: "working" });
    const runs = (await discoverRuns(await folders(ws))).runs;
    const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
    const spelled = caseInsensitive ? ws.root.replace(/Beta$/, "beta") : ws.root;

    const selection = selectRun(runs, undefined, undefined, { repoRoot: spelled, knownRoots: [spelled] });
    assert.equal(selection.selected?.id, runIdFor(ws.location, "stage", "stage-b"), "the run is not orphaned by a spelling");
  });
});

// ---------------------------------------------------------------------------
// what the screen says, on the real wire
// ---------------------------------------------------------------------------

describe("the repository context on screen", () => {
  /**
   * The rendered markup, the shipped webview script, the message it posts and
   * the host's own parser for it. A control that exists only in the model is
   * not a control: the click path is what makes it one.
   */
  it("names both repositories at the top when a pin holds it elsewhere, and its release click reaches the host", async () => {
    const a = await Workspace.create({ name: "sporely-py-reported-statistics" });
    const b = await Workspace.create({ name: "sporely-py-inaturalist-republish-media" });
    await a.writeStage("stage-reported-statistics", { status: "accepted", candidate_sha: "aaa" });
    await b.writeStage("stage-republish-media", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    const aId = runIdFor(a.location, "stage", "stage-reported-statistics");

    const pinned = selectRun(runs, { id: aId, atMs: NOW }, aId, scopeOf(b, a));
    const html = renderOverviewHtml(buildOverviewModel(pinned, undefined, undefined, NOW), "n", "vscode-resource:");
    assert.ok(html.includes(`${CONTEXT_HEADLINE.pinned}:</span><span class="name">sporely-py-reported-statistics`), "the pinned repository is named");
    assert.ok(
      html.includes(`${ACTIVE_CONTEXT_HEADLINE}:</span><span class="name">sporely-py-inaturalist-republish-media`),
      "and so is the repository this window is in",
    );

    // Before the run, not after it: this is the first thing on the page.
    assert.ok(html.indexOf('class="repocontext') < html.indexOf('class="top"'), "the repository context is above the run, not in a footer");

    const { document, posted } = runWebviewScript(html);
    document.dispatch("click", elementFrom(html, "button", /<button[^>]*data-action="followActiveRepository"[^>]*>/, "the Follow active repository button"));
    assert.deepEqual(posted, [{ type: "action", action: "followActiveRepository" }]);
    const message = posted[0];
    assert.ok(isActionMessage(message), "the host accepts it as an action");
    assert.equal(message.action, "followActiveRepository");

    // What the host then does, and the view rebuilt from it.
    const released = selectRun(runs, undefined, aId, scopeOf(b, a));
    const after = buildOverviewModel(released, undefined, undefined, NOW);
    assert.equal(after.repositoryContext?.mode, "following");
    assert.equal(after.title, "Republish media", "the cockpit is now in the repository the window is in");
  });

  it("says which repository it is following even when nothing is pinned", async () => {
    const b = await Workspace.create({ name: "beta" });
    await b.writeStage("stage-b", { status: "working" });
    const runs = (await discoverRuns(await folders(b))).runs;
    const html = renderOverviewHtml(buildOverviewModel(selectRun(runs, undefined, undefined, scopeOf(b)), undefined, undefined, NOW), "n", "vscode-resource:");
    assert.ok(html.includes(`${CONTEXT_HEADLINE.following}:</span><span class="name">beta`));
    assert.doesNotMatch(html, /data-action="followActiveRepository"/, "there is no pin to release, so the control would do nothing");
  });

  /**
   * Switching context must not depend on a VS Code gesture this extension
   * cannot observe, so Agent Sparring's own chooser is on every screen — with
   * a run, without one, and while several look active.
   */
  it("offers Agent Sparring's own repository/run chooser on every screen", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ sparring: false, name: "beta" });
    await a.writeStage("stage-a", { status: "working" });
    await a.writeStage("stage-a2", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;

    const withRun = selectRun(runs, { id: runIdFor(a.location, "stage", "stage-a"), atMs: NOW }, undefined, scopeOf(a, b));
    const ambiguous = selectRun(runs, undefined, undefined, scopeOf(a, b));
    const empty = selectRun(runs, undefined, undefined, scopeOf(b, a));
    assert.equal(ambiguous.ambiguous.length, 2, "two open stages and no choice");
    assert.equal(empty.selected, undefined);

    for (const [what, selection] of [
      ["run", withRun],
      ["ambiguous", ambiguous],
      ["empty", empty],
    ] as const) {
      const html = renderOverviewHtml(buildOverviewModel(selection, undefined, undefined, NOW), "n", "vscode-resource:");
      assert.match(html, /data-action="selectRun"/, `${what}: the chooser is reachable`);
      assert.ok(html.includes(SELECT_RUN_LABEL), `${what}: and it is named the same way everywhere`);
    }
  });

  it("the status bar tooltip says which repository, and how it got there", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await a.writeStage("stage-a", { status: "accepted", candidate_sha: "aaa" });
    await b.writeStage("stage-b", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    const aId = runIdFor(a.location, "stage", "stage-a");

    const following = deriveStatus(selectRun(runs, undefined, undefined, scopeOf(b, a)), undefined, NOW);
    assert.match(following.tooltip, /Following the active repository: beta\./);

    const pinned = deriveStatus(selectRun(runs, { id: aId, atMs: NOW }, aId, scopeOf(b, a)), undefined, NOW);
    assert.match(pinned.tooltip, /Pinned to a run in alpha, while this window is in beta\./);
    assert.ok(pinned.tooltip.includes(FOLLOW_ACTIVE_LABEL), "and how to get back");
  });
});
