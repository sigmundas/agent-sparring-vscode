/**
 * Choosing the followed repository directly.
 *
 * The controller reads the chosen repository from workspace state on every
 * refresh and resolves the scope with {@link followedRepository}; these tests
 * drive that same pipeline — stored value → followed repository → scope →
 * selectRun — over the cross-repository intake world, with the active editor
 * tracked by the real {@link ActiveRepositoryFold}. A "reload" is a fresh
 * pipeline over the same stored values.
 *
 * Held here:
 *  - choosing web while the editor stays in app shows web's current work
 *    (the Taxonomy-v3-shaped intake whose next slice is web's);
 *  - opening a file in app does not override the choice;
 *  - Follow active editor resumes active-repository behaviour;
 *  - an explicit run pin outranks the chosen repository's current work, and
 *    releasing it returns to that repository, not the editor's;
 *  - a reload keeps the mode, a closed chosen repository is set aside;
 *  - the choices are the known roots once each, and the Overview's repository
 *    name is the chooser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActiveRepositoryFold, describeRepositoryContext, followedRepository, repositoryChoices, type GitSource } from "../core/activeRepository";
import { intakeIdFor, selectRun, type Discovery, type RunPreference } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel } from "../core/overviewModel";
import { crossRepositoryIntake } from "./fixtures";

class Git implements GitSource {
  constructor(private readonly roots: string[]) {}
  repositories() {
    return this.roots.map((rootPath) => ({ rootPath, selected: false }));
  }
  repositoryOf(fsPath: string) {
    return this.roots.find((root) => fsPath.startsWith(`${root}/`));
  }
}

/** What the controller keeps in workspace state, and how it turns it into a selection. */
function session(world: Awaited<ReturnType<typeof crossRepositoryIntake>>, stored: { chosen?: string; pin?: RunPreference }) {
  const known = [world.app.repoRoot, world.web.repoRoot];
  const fold = new ActiveRepositoryFold(new Git(known), 0);
  const select = (discovery: Discovery) => {
    const followed = followedRepository(stored.chosen, fold.activeRepoRoot, fold.knownRepoRoots);
    const scope = followed.root ? { repoRoot: followed.root, knownRoots: known, ...(followed.chosen ? { chosen: true } : {}) } : undefined;
    return selectRun(discovery.runs, stored.pin, undefined, scope, undefined, [world.app, world.web], discovery.intakes);
  };
  return { fold, select };
}

const intakeShown = (selection: ReturnType<typeof selectRun>) => (selection.intake ? intakeIdFor(selection.intake.location, selection.intake.record.intakeId) : undefined);

describe("choosing the followed repository", () => {
  it("choosing web while the editor stays in app shows web's current work", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const stored: { chosen?: string } = {};
    const { fold, select } = session(world, stored);
    fold.editorActivated(`${world.app.repoRoot}/main.py`, 1_000);
    assert.equal(select(discovery).selected?.id, world.appRunId, "following the editor: app");
    stored.chosen = world.web.repoRoot;
    const selection = select(discovery);
    assert.equal(intakeShown(selection), world.intakeId, "web's next slice, with no file opened in web");
    assert.equal(selection.scope?.chosen, true);
    assert.equal(describeRepositoryContext(selection).chosen, true);
  });

  it("opening a file in app does not override the choice of web", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const { fold, select } = session(world, { chosen: world.web.repoRoot });
    fold.editorActivated(`${world.app.repoRoot}/main.py`, 1_000);
    fold.editorActivated(`${world.app.repoRoot}/other.py`, 2_000);
    assert.equal(intakeShown(select(discovery)), world.intakeId);
    assert.equal(select(discovery).scope?.repoRoot, world.web.repoRoot);
  });

  it("Follow active editor resumes active-repository behaviour", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const stored: { chosen?: string } = { chosen: world.web.repoRoot };
    const { fold, select } = session(world, stored);
    fold.editorActivated(`${world.app.repoRoot}/main.py`, 1_000);
    stored.chosen = undefined;
    assert.equal(select(discovery).selected?.id, world.appRunId);
    assert.equal(select(discovery).scope?.chosen, undefined);
    fold.editorActivated(`${world.web.repoRoot}/src/app.ts`, 2_000);
    assert.equal(intakeShown(select(discovery)), world.intakeId, "and moving the editor moves the cockpit again");
  });

  it("an explicit run pin outranks the chosen repository; releasing it returns to that repository", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const stored: { chosen?: string; pin?: RunPreference } = { chosen: world.web.repoRoot, pin: { id: world.stageId, origin: "explicit", intent: "inspect", atMs: 0 } };
    const { fold, select } = session(world, stored);
    fold.editorActivated(`${world.app.repoRoot}/main.py`, 1_000);
    assert.equal(select(discovery).selected?.id, world.stageId);
    assert.equal(select(discovery).pinned, true);
    stored.pin = undefined; // Follow active repository: releases the pin, keeps the chosen repository
    assert.equal(intakeShown(select(discovery)), world.intakeId, "web's current work, not the editor's app");
  });

  it("a reload keeps the mode: the same stored choice gives the same selection in a fresh session", async () => {
    const world = await crossRepositoryIntake();
    const stored = { chosen: world.web.repoRoot };
    for (const pass of [0, 1]) {
      const { fold, select } = session(world, stored);
      fold.seedActiveEditor(`${world.app.repoRoot}/main.py`);
      assert.equal(intakeShown(select(await world.discover())), world.intakeId, `session ${pass}`);
    }
    const automatic = session(world, {});
    automatic.fold.seedActiveEditor(`${world.app.repoRoot}/main.py`);
    assert.equal(automatic.select(await world.discover()).selected?.id, world.appRunId, "no stored choice: the editor's repository, as before");
  });

  it("a chosen repository that is no longer open is set aside, and applies again once it is back", () => {
    assert.deepEqual(followedRepository("/code/web", "/code/app", ["/code/app"]), { root: "/code/app", chosen: false });
    assert.deepEqual(followedRepository("/code/web", "/code/app", ["/code/app", "/code/web"]), { root: "/code/web", chosen: true });
    assert.deepEqual(followedRepository("/code/web", undefined, undefined), { root: "/code/web", chosen: true }, "the Git extension has said nothing yet");
    assert.deepEqual(followedRepository(undefined, "/code/app", ["/code/app"]), { root: "/code/app", chosen: false });
  });

  it("the choices are every known root once each, by name, with the followed one marked", () => {
    const choices = repositoryChoices(["/code/sporely-web", "/code/sporely-py", "/code/sporely-web", "/other/sporely-py"], "/code/sporely-web");
    assert.deepEqual(
      choices.map((choice) => [choice.name, choice.current]),
      [
        ["code/sporely-py", false],
        ["other/sporely-py", false],
        ["sporely-web", true],
      ],
    );
  });

  it("the Overview's repository name is the chooser, and Follow active editor appears only while a repository is chosen", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const chosen = session(world, { chosen: world.web.repoRoot });
    const html = renderOverviewHtml(buildOverviewModel(chosen.select(discovery), undefined), "nonce", "csp");
    assert.match(html, /<button type="button" class="name chooser" data-action="chooseRepository"[^>]*>web<span class="caret"/);
    assert.match(html, /data-action="followActiveEditor"/);
    const following = session(world, {});
    following.fold.editorActivated(`${world.web.repoRoot}/src/app.ts`, 1_000);
    const plain = renderOverviewHtml(buildOverviewModel(following.select(discovery), undefined), "nonce", "csp");
    assert.match(plain, /data-action="chooseRepository"/);
    assert.doesNotMatch(plain, /data-action="followActiveEditor"/);
  });
});
