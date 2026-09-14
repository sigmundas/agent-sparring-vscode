/**
 * Declaring the sibling repositories a plan stage's candidate spans.
 *
 * The point of the declaration is the engine's acceptance gate: it pins
 * every declared sibling at the freeze boundary and re-verifies each pin at
 * acceptance, so a stage cannot claim acceptance while a reviewed sibling
 * quietly moves. These tests hold the two properties that make that safe —
 * one entry per name, and never a hand-supplied commit — plus the shape the
 * manifest carries.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  manifestRepositories,
  relativeRepositoryPath,
  repositoriesForPlan,
  repositoriesForStage,
  repositoryLabelKey,
  withStageRepository,
  withoutStageRepository,
  type StageRepositories,
} from "../core/stageRepositories";

const PLAN = "reported-statistics-3f9a2c1b";
const WEB = { name: "sporely-web", path: "/Code/sporely/sporely-web-reported-statistics", branch: "feature/reported-statistics-cloud-transport" };

describe("declaring a stage's sibling repositories", () => {
  it("records one per stage label and reads it back however the label is written", () => {
    const state = withStageRepository(undefined, PLAN, "3D", WEB);

    assert.deepEqual(repositoriesForStage(state, PLAN, "3D"), [WEB]);
    assert.deepEqual(repositoriesForStage(state, PLAN, "3d"), [WEB]);
    assert.deepEqual(repositoriesForStage(state, PLAN, "Stage 3D"), [WEB]);
    assert.deepEqual(repositoriesForStage(state, PLAN, "3C"), [], "a declaration belongs to one stage, not to the plan");
    assert.deepEqual(repositoriesForStage(state, "another-plan", "3D"), []);
  });

  it("declaring the same name again corrects the branch instead of adding a second candidate", () => {
    // The engine records pins by name; two entries called the same thing
    // would be one candidate silently overwriting the other.
    const first = withStageRepository(undefined, PLAN, "3D", WEB);
    const corrected = withStageRepository(first, PLAN, "3D", { ...WEB, branch: "feature/other" });

    assert.deepEqual(
      repositoriesForStage(corrected, PLAN, "3D").map((entry) => entry.branch),
      ["feature/other"],
    );
  });

  it("keeps several distinct siblings in a stable order", () => {
    const state = withStageRepository(withStageRepository(undefined, PLAN, "3D", WEB), PLAN, "3D", { name: "sporely-docs", path: "/Code/sporely-docs", branch: "main" });
    assert.deepEqual(
      repositoriesForStage(state, PLAN, "3D").map((entry) => entry.name),
      ["sporely-docs", "sporely-web"],
    );
  });

  it("removing the last declaration leaves nothing behind", () => {
    const state = withStageRepository(undefined, PLAN, "3D", WEB);
    const empty = withoutStageRepository(state, PLAN, "3D", "sporely-web");

    assert.deepEqual(repositoriesForStage(empty, PLAN, "3D"), []);
    assert.deepEqual(repositoriesForPlan(empty, PLAN), {}, "no empty husks");
    assert.deepEqual(empty[PLAN], undefined);
  });

  it("removing one of several keeps the rest", () => {
    const state = withStageRepository(withStageRepository(undefined, PLAN, "3D", WEB), PLAN, "3D", { name: "sporely-docs", path: "/Code/sporely-docs", branch: "main" });
    assert.deepEqual(
      repositoriesForStage(withoutStageRepository(state, PLAN, "3D", "sporely-docs"), PLAN, "3D").map((entry) => entry.name),
      ["sporely-web"],
    );
  });

  it("drops junk from workspace state rather than throwing on it", () => {
    const corrupt = {
      [PLAN]: {
        "3D": [WEB, { name: "no-branch", path: "/x" }, { name: "", path: "/y", branch: "main" }, "not an object", null],
        "3C": [],
      },
    } as unknown as StageRepositories;

    assert.deepEqual(repositoriesForStage(corrupt, PLAN, "3D"), [WEB]);
    assert.deepEqual(repositoriesForPlan(corrupt, PLAN), { "3D": [WEB] });
    assert.deepEqual(repositoriesForPlan(undefined, PLAN), {});
    assert.deepEqual(repositoriesForPlan({ [PLAN]: "nonsense" } as unknown as StageRepositories, PLAN), {});
  });

  it("normalises labels the same way wherever they come from", () => {
    assert.equal(repositoryLabelKey(" stage 3d "), "3D");
    assert.equal(repositoryLabelKey("Stage 12"), "12");
    assert.equal(repositoryLabelKey("3C"), "3C");
  });
});

describe("what the manifest carries", () => {
  it("never carries a candidate commit: the freeze boundary resolves and pins it", () => {
    // A hand-typed SHA is exactly the stale pin the engine's verification
    // exists to catch, so the extension never supplies one.
    const emitted = manifestRepositories({ "3D": [WEB] }, "/Code/sporely/sporely-py-reported-statistics");
    assert.deepEqual(
      emitted["3D"].map((entry) => entry.candidate_sha),
      [null],
    );
    assert.deepEqual(Object.keys(emitted["3D"][0]).sort(), ["branch", "candidate_sha", "name", "path"]);
  });

  it("emits paths relative to the primary repository, which is what the engine resolves against", () => {
    const emitted = manifestRepositories({ "3D": [WEB] }, "/Code/sporely/sporely-py-reported-statistics");
    assert.deepEqual(emitted["3D"], [{ name: "sporely-web", path: "../sporely-web-reported-statistics", branch: WEB.branch, candidate_sha: null }]);
  });

  it("leaves a path absolute when no relative one exists, rather than mangling it", () => {
    assert.equal(relativeRepositoryPath("/Code/a", "/Code/b"), "../b");
    assert.equal(relativeRepositoryPath("/Code/a", "../already-relative"), "../already-relative");
    assert.equal(relativeRepositoryPath("/Code/a", "/Code/a"), "/Code/a", "the primary repository is not a sibling of itself");
  });
});
