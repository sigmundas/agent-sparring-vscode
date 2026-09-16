/**
 * A sibling repository is declared for a plan stage **in a worktree**, and
 * nowhere else.
 *
 * The same defect the stage-mode scoping fixed, in the other kind of
 * declaration and with the same consequence. A plan key is a hash of the
 * plan's *repo-relative* path (`plan.py: plan_key`), so two worktrees with
 * `docs/plans/active/reported-statistics.md` checked out produce the same key
 * — and running two stages of a plan side by side in two worktrees is how the
 * work is actually done here.
 *
 * Keyed by plan alone, declaring `sporely-web` as Stage 3D's sibling in
 * worktree A changed what worktree B hands the engine. That is not a display
 * setting: each declared repository's name, path, branch and candidate SHA go
 * into the execution manifest and into the digest that identifies a recorded
 * run, so A's declaration could stop B's in-flight run with a complaint about
 * changed executable content, for a change nobody made in B. Worse than the
 * mode case, in fact: a mode is one word per stage, while a sibling
 * declaration also carries a *path*, which differs per worktree, so the digest
 * moves even when both worktrees meant the same thing.
 *
 * The identity and the migration are shared with stage modes
 * (declarationScope.ts) rather than reinvented: two schemes for one question
 * is how two surfaces end up disagreeing about which worktree they mean.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { declarationScope } from "../core/declarationScope";
import { buildManifest, manifestDigest, renderManifest } from "../core/manifest";
import {
  manifestRepositories,
  migrateStageRepositories,
  repositoriesForPlan,
  repositoriesForStage,
  stageRepositoryScope,
  withStageRepository,
  withoutStageRepository,
  type DeclaredRepository,
  type StageRepositories,
} from "../core/stageRepositories";
import { migrateStageModes, stageModeScope } from "../core/stageModes";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const A = "/code/sporely/sporely-py-reported-statistics";
const B = "/code/sporely/sporely-py-ui-cleanup";
const WEB: DeclaredRepository = { name: "sporely-web", path: "/code/sporely/sporely-web-reported-statistics", branch: "feature/reported-statistics-cloud-transport" };
const DOCS: DeclaredRepository = { name: "sporely-docs", path: "/code/sporely/sporely-docs", branch: "main" };

const PLAN = [
  "# Reported statistics",
  "",
  "## Stage 3D — Snapshot v2 and attachment transport",
  "",
  "The transport.",
  "",
  "## Stage 4 — Editor and UI",
  "",
  "The editor.",
  "",
].join("\n");

/** The manifest one worktree would hand the engine, given the whole declaration state. */
function built(state: StageRepositories | undefined, projectDir: string) {
  const result = buildManifest({
    markdown: PLAN,
    planLabel: PLAN_LABEL,
    planName: "reported-statistics.md",
    repositories: manifestRepositories(repositoriesForPlan(state, PLAN_KEY, projectDir), projectDir),
  });
  assert.ok(result.ok);
  return { text: renderManifest(result.manifest), digest: manifestDigest(result.manifest) };
}

/** A discovered plan run, as the migration reads one. */
function run(projectDir: string, planKey = PLAN_KEY) {
  return { planKey, location: { projectDir } };
}

describe("two worktrees with the same relative plan path and the same stage labels", () => {
  it("declaring a sibling in A is visible in A", () => {
    const state = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, A, "3D"), [WEB]);
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, A, "Stage 3d"), [WEB], "however the label is written");
    assert.match(built(state, A).text, /"name": "sporely-web"/, "and it reaches A's manifest");
  });

  it("…and is not visible in B", () => {
    const state = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, B, "3D"), [], "B declares nothing");
    assert.deepEqual(repositoriesForPlan(state, PLAN_KEY, B), {});
  });

  it("changes only A's manifest and digest; B stays byte-identical", () => {
    const before = built(undefined, B);
    const state = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    const a = built(state, A);
    const b = built(state, B);

    assert.notEqual(a.digest, built(undefined, A).digest, "A executes something different now");
    assert.ok(!a.text.includes('"repositories": []'));
    assert.equal(b.text, before.text, "B's manifest is byte-identical to the undeclared one");
    assert.equal(b.digest, before.digest, "so B's recorded run keeps resuming");
    assert.ok(!b.text.includes("repositories"), "B carries no repositories key at all");
  });

  it("keeps two worktrees' different declarations apart", () => {
    let state = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    state = withStageRepository(state, PLAN_KEY, B, "3D", DOCS);
    assert.deepEqual(
      repositoriesForStage(state, PLAN_KEY, A, "3D").map((entry) => entry.name),
      ["sporely-web"],
    );
    assert.deepEqual(
      repositoriesForStage(state, PLAN_KEY, B, "3D").map((entry) => entry.name),
      ["sporely-docs"],
    );
    assert.notEqual(built(state, A).digest, built(state, B).digest);
    assert.deepEqual(Object.keys(state).sort(), [stageRepositoryScope(PLAN_KEY, A), stageRepositoryScope(PLAN_KEY, B)].sort());
  });

  it("removing A's declaration leaves B's alone", () => {
    let state = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    state = withStageRepository(state, PLAN_KEY, B, "3D", WEB);
    const bBefore = built(state, B).digest;
    state = withoutStageRepository(state, PLAN_KEY, A, "3D", "sporely-web");
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, A, "3D"), []);
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, B, "3D"), [WEB]);
    assert.equal(built(state, B).digest, bBefore, "B's digest never moved");
  });

  it("survives being written out and read back, as workspace state is", () => {
    // workspaceState is JSON, and the scope key travels through it as a key.
    let state = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    state = withStageRepository(state, PLAN_KEY, B, "4", DOCS);
    const reloaded = JSON.parse(JSON.stringify(state)) as StageRepositories;

    assert.deepEqual(repositoriesForStage(reloaded, PLAN_KEY, A, "3D"), [WEB]);
    assert.deepEqual(repositoriesForStage(reloaded, PLAN_KEY, A, "4"), [], "A declared nothing for Stage 4");
    assert.deepEqual(repositoriesForStage(reloaded, PLAN_KEY, B, "3D"), [], "nor B for Stage 3D");
    assert.deepEqual(repositoriesForStage(reloaded, PLAN_KEY, B, "4"), [DOCS]);
    assert.equal(built(reloaded, A).digest, built(state, A).digest, "and the manifests survive the round trip");
    assert.equal(built(reloaded, B).digest, built(state, B).digest);
  });

  it("treats two spellings of one worktree as one worktree", () => {
    const state = withStageRepository(undefined, PLAN_KEY, `${A}/`, "3D", WEB);
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, A, "3D"), [WEB], "path.resolve normalises the scope");
    assert.deepEqual(repositoriesForStage(state, PLAN_KEY, `${A}/./`, "3D"), [WEB]);
  });

  it("uses the same scope identity as a stage's mode", () => {
    // Not a stylistic point: if the two ever disagreed about which worktree a
    // declaration belongs to, one manifest would carry a mode for a worktree
    // whose siblings came from another.
    assert.equal(stageRepositoryScope(PLAN_KEY, A), stageModeScope(PLAN_KEY, A));
    assert.equal(stageRepositoryScope(PLAN_KEY, A), declarationScope(PLAN_KEY, A));
    assert.notEqual(stageRepositoryScope(PLAN_KEY, A), stageRepositoryScope(PLAN_KEY, B));
  });
});

describe("sibling declarations made before they were scoped to a worktree", () => {
  /** Exactly what is in workspace state for a declaration made by an earlier build. */
  const legacy: StageRepositories = { [PLAN_KEY]: { "3D": [WEB] } };

  it("are not applied to any worktree until they can be attributed", () => {
    assert.deepEqual(repositoriesForStage(legacy, PLAN_KEY, A, "3D"), [], "an unscoped declaration reaches no manifest");
    assert.deepEqual(repositoriesForStage(legacy, PLAN_KEY, B, "3D"), []);
    assert.equal(built(legacy, A).digest, built(undefined, A).digest, "so no digest moves on the strength of one");
  });

  it("move to the one worktree that has a recorded run of that plan", () => {
    const { next, migrated, ambiguous } = migrateStageRepositories(legacy, [run(A)]);
    assert.deepEqual(ambiguous, []);
    assert.deepEqual(migrated, [{ planKey: PLAN_KEY, projectDir: A, labels: ["3D"] }]);
    assert.deepEqual(repositoriesForStage(next, PLAN_KEY, A, "3D"), [WEB], "recovered");
    assert.deepEqual(repositoriesForStage(next, PLAN_KEY, B, "3D"), [], "and only there");
    assert.deepEqual(Object.keys(next), [stageRepositoryScope(PLAN_KEY, A)], "the unscoped entry is retired");
  });

  it("fail closed when two worktrees could own them", () => {
    const { next, migrated, ambiguous } = migrateStageRepositories(legacy, [run(A), run(B)]);
    assert.deepEqual(migrated, []);
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].candidates.sort(), [A, B].sort());
    assert.deepEqual(next, legacy, "kept, so nothing is destroyed");
    assert.deepEqual(repositoriesForStage(next, PLAN_KEY, A, "3D"), [], "and applied to neither");
    assert.deepEqual(repositoriesForStage(next, PLAN_KEY, B, "3D"), []);
    assert.equal(built(next, A).digest, built(undefined, A).digest, "so neither worktree's digest moves");
    assert.equal(built(next, B).digest, built(undefined, B).digest);
  });

  it("are kept, not dropped, when the worktree they belong to is not open", () => {
    const { next, migrated, ambiguous } = migrateStageRepositories(legacy, [run("/code/other", "some-other-plan-aaaaaaaa")]);
    assert.deepEqual(migrated, []);
    assert.deepEqual(ambiguous[0].candidates, [], "nothing to attribute it to");
    assert.deepEqual(next, legacy, "closing a folder must not destroy a declaration");
  });

  it("are idempotent: a second pass changes nothing", () => {
    const once = migrateStageRepositories(legacy, [run(A)]);
    const twice = migrateStageRepositories(once.next, [run(A)]);
    assert.deepEqual(twice.next, once.next);
    assert.deepEqual(twice.migrated, []);
    assert.deepEqual(twice.ambiguous, []);
  });

  it("never overwrite a declaration already made in that worktree", () => {
    // The scoped entry is the newer statement; the unscoped one is being
    // retired and must not win over it.
    const mixed: StageRepositories = { ...legacy, [stageRepositoryScope(PLAN_KEY, A)]: { "3D": [DOCS] } };
    const { next } = migrateStageRepositories(mixed, [run(A)]);
    assert.deepEqual(
      repositoriesForStage(next, PLAN_KEY, A, "3D").map((entry) => entry.name),
      ["sporely-docs"],
      "the explicit later choice stands",
    );
  });

  it("carry a stage the worktree had not declared, without displacing one it had", () => {
    const mixed: StageRepositories = { [PLAN_KEY]: { "3D": [WEB], "4": [DOCS] }, [stageRepositoryScope(PLAN_KEY, A)]: { "3D": [DOCS] } };
    const { next } = migrateStageRepositories(mixed, [run(A)]);
    assert.deepEqual(
      repositoriesForStage(next, PLAN_KEY, A, "3D").map((entry) => entry.name),
      ["sporely-docs"],
    );
    assert.deepEqual(
      repositoriesForStage(next, PLAN_KEY, A, "4").map((entry) => entry.name),
      ["sporely-docs"],
      "Stage 4 had no scoped declaration, so the legacy one moves across",
    );
  });

  it("leave an already-scoped entry completely alone", () => {
    const scoped = withStageRepository(undefined, PLAN_KEY, A, "3D", WEB);
    const { next, migrated, ambiguous } = migrateStageRepositories(scoped, [run(A), run(B)]);
    assert.deepEqual(next, scoped);
    assert.deepEqual(migrated, []);
    assert.deepEqual(ambiguous, [], "a scoped key has no legacy form to be ambiguous about");
  });

  it("migrate independently of stage modes, through the same rule", () => {
    // Both kinds go through one helper, so a window that can attribute one
    // can attribute the other, and neither is applied when it cannot.
    const modes = { [PLAN_KEY]: { "5": "independent_review" as const } };
    assert.deepEqual(migrateStageModes(modes, [run(A)]).migrated, [{ planKey: PLAN_KEY, projectDir: A, labels: ["5"] }]);
    assert.deepEqual(migrateStageRepositories(legacy, [run(A)]).migrated, [{ planKey: PLAN_KEY, projectDir: A, labels: ["3D"] }]);
    assert.deepEqual(migrateStageModes(modes, [run(A), run(B)]).migrated, []);
    assert.deepEqual(migrateStageRepositories(legacy, [run(A), run(B)]).migrated, []);
  });
});
