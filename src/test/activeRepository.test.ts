/**
 * Following the active repository.
 *
 * The bug: the window's active Git repository was switched from
 * `sporely-py-reported-statistics` to `sporely-py-inaturalist-republish-media`
 * and the cockpit went on showing the completed reported-statistics plan run,
 * because run selection knew about workspace folders and nothing about which
 * repository the window was in.
 *
 * Two layers are covered here: the fold that decides which repository the
 * window is in (core/activeRepository.ts) and the scoped selection that
 * decides which run to show in it (discovery.selectRun's `scope`).
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  NO_ACTIVE_REPOSITORY,
  activeRepositoryRoot,
  describeFollowing,
  emptyStateLines,
  emptyStateTitle,
  withEditorRepository,
  withFocusedRepository,
  withKnownRepositories,
} from "../core/activeRepository";
import {
  discoverRuns,
  locateAll,
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
  it("is whichever public signal changed most recently", () => {
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
    assert.equal(model.following?.mode, "following");
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
// pinning, and the way back
// ---------------------------------------------------------------------------

describe("pinning a run, and following the active repository again", () => {
  it("an explicit pin survives the window moving to another repository, and says that it is doing so", async () => {
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

    const following = describeFollowing(selection);
    assert.equal(following.mode, "pinned");
    assert.equal(
      following.text,
      "Pinned to a run in sporely-py-reported-statistics, while this window is in sporely-py-inaturalist-republish-media.",
    );
    assert.equal(following.release, "Follow the active repository to follow sporely-py-inaturalist-republish-media again.");

    const model = buildOverviewModel(selection, undefined, undefined, NOW);
    assert.equal(model.following?.mode, "pinned");
    assert.ok(model.following?.release, "the Overview carries the way out, not only the Command Palette");
  });

  it("a pin inside the repository the window is already in is not reported as a conflict", async () => {
    const b = await Workspace.create({ name: "beta" });
    await b.writeStage("one", { status: "working" });
    await b.writeStage("two", { status: "working" });
    const runs = (await discoverRuns(await folders(b))).runs;
    const oneId = runIdFor(b.location, "stage", "one");

    const following = describeFollowing(selectRun(runs, { id: oneId, atMs: NOW }, undefined, scopeOf(b)));
    assert.equal(following.mode, "pinned");
    assert.equal(following.text, "Pinned to this run in beta.", "no claim that the pin is holding the cockpit elsewhere");
    assert.equal(following.release, "Follow the active repository instead.");
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

    // What the controller does for "Follow the active repository": the
    // preference is cleared. The sticky memory of A is deliberately kept, and
    // must not resurrect it.
    const released = selectRun(runs, undefined, aId, scope);
    assert.equal(released.selected?.id, runIdFor(b.location, "stage", "stage-b"));
    assert.equal(released.pinned, undefined);
    assert.equal(describeFollowing(released).mode, "following");

    // Returning to A finds its run again: the memory was ignored, not thrown away.
    const back = selectRun(runs, undefined, aId, scopeOf(a, b));
    assert.equal(back.selected?.id, aId);
  });

  it("with no repository resolved, nothing is scoped and every run is a candidate", async () => {
    const a = await Workspace.create({ name: "alpha" });
    await a.writeStage("stage-a", { status: "working" });
    const runs = (await discoverRuns(await folders(a))).runs;

    const selection = selectRun(runs, undefined, undefined, undefined);
    assert.equal(selection.selected?.id, runIdFor(a.location, "stage", "stage-a"));
    assert.equal(selection.scope, undefined);
    assert.equal(describeFollowing(selection).mode, "unscoped");
    assert.equal(emptyStateTitle({ ambiguous: [] }), "No active run", "unscoped keeps the old wording; it names no repository it cannot name");
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

  it("a project no known repository root owns stays visible rather than being scoped away", async () => {
    // A folder with .sparring that is not a git repository the extension has
    // opened. Scoping must not make it unreachable: it cannot be attributed,
    // so it cannot be excluded either.
    const repo = await Workspace.create({ name: "beta" });
    const loose = await Workspace.create({ name: "notes" });
    await loose.writeStage("stage-loose", { status: "working" });
    const runs = (await discoverRuns(await folders(repo, loose))).runs;

    const kept = runsInRepository(runs, repo.root, [repo.root]);
    assert.deepEqual(
      kept.map((run) => run.location.folderName),
      ["notes"],
    );
    const selection = selectRun(runs, undefined, undefined, { repoRoot: repo.root, knownRoots: [repo.root] });
    assert.equal(selection.selected?.location.folderName, "notes");
    assert.equal(selection.elsewhere, undefined);
  });
});

// ---------------------------------------------------------------------------
// the way back, on the real wire
// ---------------------------------------------------------------------------

describe("the Follow the active repository control", () => {
  /**
   * The rendered markup, the shipped webview script, the message it posts and
   * the host's own parser for it. A control that exists only in the model is
   * not a control: the click path is what makes it one.
   */
  it("is in the Overview when a pin is holding it elsewhere, and its click reaches the host", async () => {
    const a = await Workspace.create({ name: "sporely-py-reported-statistics" });
    const b = await Workspace.create({ name: "sporely-py-inaturalist-republish-media" });
    await a.writeStage("stage-reported-statistics", { status: "accepted", candidate_sha: "aaa" });
    await b.writeStage("stage-republish-media", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    const aId = runIdFor(a.location, "stage", "stage-reported-statistics");

    const pinned = selectRun(runs, { id: aId, atMs: NOW }, aId, scopeOf(b, a));
    const html = renderOverviewHtml(buildOverviewModel(pinned, undefined, undefined, NOW), "n", "vscode-resource:");
    assert.match(html, /Pinned to a run in sporely-py-reported-statistics, while this window is in sporely-py-inaturalist-republish-media\./);

    const { document, posted } = runWebviewScript(html);
    document.dispatch("click", elementFrom(html, "button", /<button[^>]*data-action="followActiveRepository"[^>]*>/, "the Follow the active repository button"));
    assert.deepEqual(posted, [{ type: "action", action: "followActiveRepository" }]);
    const message = posted[0];
    assert.ok(isActionMessage(message), "the host accepts it as an action");
    assert.equal(message.action, "followActiveRepository");

    // What the host then does, and the view rebuilt from it.
    const released = selectRun(runs, undefined, aId, scopeOf(b, a));
    const after = buildOverviewModel(released, undefined, undefined, NOW);
    assert.equal(after.following?.mode, "following");
    assert.equal(after.title, "Republish media", "the cockpit is now in the repository the window is in");
  });

  it("is not offered when nothing is pinned: it would do nothing", async () => {
    const b = await Workspace.create({ name: "beta" });
    await b.writeStage("stage-b", { status: "working" });
    const runs = (await discoverRuns(await folders(b))).runs;
    const html = renderOverviewHtml(buildOverviewModel(selectRun(runs, undefined, undefined, scopeOf(b)), undefined, undefined, NOW), "n", "vscode-resource:");
    assert.doesNotMatch(html, /data-action="followActiveRepository"/);
    assert.match(html, /Following the active repository: beta\./, "but the footer still says where the cockpit is");
  });

  it("is offered on the empty state too, where there is no run to act on", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ sparring: false, name: "beta" });
    await a.writeStage("stage-a", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;

    // Pinned to alpha's run while the window is in beta, then the pin vanishes
    // with the run: the empty state is what a person is left looking at.
    const empty = selectRun(runs, { id: "gone", atMs: NOW }, undefined, scopeOf(b, a));
    assert.equal(empty.selected, undefined);
    const html = renderOverviewHtml(buildOverviewModel(empty, undefined, undefined, NOW), "n", "vscode-resource:");
    assert.match(html, /No Agent Sparring run for beta/);
    assert.match(html, /data-action="selectRun"/, "and the way to reach the work in alpha");
  });
});
