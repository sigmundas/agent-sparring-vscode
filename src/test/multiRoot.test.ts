import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, locateAll, runIdFor, selectRun, type StandaloneStageSnapshot } from "../core/discovery";
import { chooseLaunchRepository, launchRepositories } from "../core/launchRepositories";
import { buildOverviewModel } from "../core/overviewModel";
import { deriveStatus } from "../core/status";
import { Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-12T20:00:00.000Z");

async function folders(...workspaces: Workspace[]) {
  return locateAll(workspaces.map((ws) => ({ path: ws.root, name: path.basename(ws.root) })));
}

describe("multi-root workspaces", () => {
  it("two folders, only the second contains .sparring", async () => {
    const a = await Workspace.create({ sparring: false, name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await b.writeStage("stage-local-schema-barrier", { status: "accepted", candidate_sha: "c" });
    const locations = await folders(a, b);
    assert.deepEqual(
      locations.map((l) => l.folderName),
      ["beta"],
    );
    const discovery = await discoverRuns(locations);
    const selection = selectRun(discovery.runs);
    assert.equal(selection.selected?.kind, "stage");
    assert.equal(selection.selected?.location.folderName, "beta");
    const view = deriveStatus(selection, undefined, NOW);
    assert.equal(view.text, "$(check) Agent Sparring: Local schema barrier · accepted");
    assert.match(view.tooltip, /Repository: beta/);
    assert.equal(buildOverviewModel(selection, undefined, undefined, NOW).kind, "run");
  });

  it("two folders, only the first contains .sparring", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ sparring: false, name: "beta" });
    await a.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns(await folders(a, b))).runs);
    assert.equal(selection.selected?.location.folderName, "alpha");
  });

  it("identical stage ids in two repositories get distinct run ids and are ambiguous when both open", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await a.writeStage("hotfix-1", { status: "working" });
    await b.writeStage("hotfix-1", { status: "working" });
    const runs = (await discoverRuns(await folders(a, b))).runs;
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].id, runs[1].id);
    assert.equal(runs[0].id, runIdFor(a.location, "stage", "hotfix-1"));
    assert.equal(runs[1].id, runIdFor(b.location, "stage", "hotfix-1"));
    const selection = selectRun(runs);
    assert.equal(selection.selected, undefined);
    assert.equal(selection.ambiguous.length, 2);
    const model = buildOverviewModel(selection, undefined, undefined, NOW);
    assert.deepEqual(model.choices, ["alpha: hotfix-1", "beta: hotfix-1"]);
    // Each run tails its own repository's activity file.
    assert.ok((runs[1] as StandaloneStageSnapshot).stage.dir.startsWith(b.root));
  });

  it("a remembered run in repository B is preserved across rediscovery", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await a.writeStage("hotfix-1", { status: "working" });
    await b.writeStage("hotfix-1", { status: "working" });
    const bId = runIdFor(b.location, "stage", "hotfix-1");
    let selection = selectRun((await discoverRuns(await folders(a, b))).runs, undefined, bId);
    assert.equal(selection.selected?.id, bId);

    // B becomes terminal while A is still open: B is only kept when chosen explicitly.
    await b.writeStage("hotfix-1", { status: "accepted" });
    selection = selectRun((await discoverRuns(await folders(a, b))).runs, undefined, bId);
    assert.equal(selection.selected?.location.folderName, "alpha", "remembered terminal run yields to the open one");
    selection = selectRun((await discoverRuns(await folders(a, b))).runs, bId);
    assert.equal(selection.selected?.id, bId, "explicit selection keeps the accepted run in B");
  });

  it("the selected repository removed from the workspace falls back to what remains", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await a.writeStage("hotfix-1", { status: "accepted" });
    await b.writeStage("hotfix-2", { status: "working" });
    const bId = runIdFor(b.location, "stage", "hotfix-2");
    const withoutB = selectRun((await discoverRuns(await folders(a))).runs, bId, bId);
    assert.equal(withoutB.selected?.location.folderName, "alpha");
    const empty = selectRun((await discoverRuns(await folders())).runs, bId, bId);
    assert.equal(empty.selected, undefined);
  });

  it(".sparring appearing later in one folder is discovered on the next probe", async () => {
    const a = await Workspace.create({ sparring: false, name: "alpha" });
    const b = await Workspace.create({ sparring: false, name: "beta" });
    assert.deepEqual(await folders(a, b), []);
    await b.createSparring();
    await b.writeStage("hotfix-1", { status: "working" });
    const locations = await folders(a, b);
    assert.equal(locations.length, 1);
    assert.equal(locations[0].workspaceFolder, b.root);
    assert.equal(selectRun((await discoverRuns(locations)).runs).selected?.location.folderName, "beta");
  });

  it("Run Plan targets the selected repository, then the active document's, then asks", async () => {
    const a = await Workspace.create({ name: "alpha" });
    const b = await Workspace.create({ name: "beta" });
    await a.writeStage("hotfix-1", { status: "working" });
    await b.writeStage("hotfix-2", { status: "accepted" });
    const locations = await folders(a, b);
    const runs = (await discoverRuns(locations)).runs;
    const selectedB = runs.find((run) => run.location.folderName === "beta");
    assert.equal(chooseLaunchRepository(launchRepositories(locations, []), selectedB, path.join(a.root, "docs", "plan.md"))?.location.folderName, "beta");
    assert.equal(chooseLaunchRepository(launchRepositories(locations, []), undefined, path.join(a.root, "docs", "plan.md"))?.location.folderName, "alpha");
    assert.equal(chooseLaunchRepository(launchRepositories(locations, []), undefined, undefined), undefined);
    assert.equal(chooseLaunchRepository(launchRepositories(locations, []), undefined, "/elsewhere/plan.md"), undefined);
  });

  it("single-root behaviour is unchanged", async () => {
    const a = await Workspace.create({ name: "solo" });
    await a.writeStage("hotfix-1", { status: "working" });
    const locations = await folders(a);
    const selection = selectRun((await discoverRuns(locations)).runs);
    assert.equal(selection.selected?.location.folderName, "solo");
    assert.equal(chooseLaunchRepository(launchRepositories(locations, []), undefined, undefined)?.location.folderName, "solo");
    const view = deriveStatus(selection, undefined, NOW);
    assert.equal(view.text, "$(circle-filled) Agent Sparring: Hotfix 1 · working");
  });
});
