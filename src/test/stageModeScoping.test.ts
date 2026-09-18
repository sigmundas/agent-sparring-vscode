/**
 * A stage mode is declared for a plan **in a worktree**, and nowhere else.
 *
 * Two worktrees of one repository, each with `docs/plans/active/reported.md`
 * checked out and each running it, is not an edge case — it is how two stages
 * of a plan get worked on side by side. A plan key is a hash of the plan's
 * *repo-relative* path (`plan.py: plan_key`), so both produce the same key,
 * and a declaration keyed by plan alone applied to both.
 *
 * That is not a display problem. The mode goes into the execution manifest,
 * the engine folds a non-default mode into the digest that identifies a
 * recorded run, and it refuses to continue a run whose digest changed. So
 * declaring Stage 5 review-only in worktree A could stop worktree B's
 * in-flight run with a complaint about changed executable content, for a
 * change nobody made in B.
 *
 * The migration is tested against the real shape it has to survive: one
 * declaration made before scoping existed, for a plan with exactly one
 * discovered run — and the two shapes where it must refuse to guess.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifest, manifestDigest, renderManifest } from "../core/manifest";
import { migrateStageModes, modeForStage, modesForPlan, stageModeScope, withStageMode, type StageModes } from "../core/stageModes";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const A = "/code/sporely/sporely-py-reported-statistics";
const B = "/code/sporely/sporely-py-ui-cleanup";

const PLAN = [
  "# Reported statistics",
  "",
  "## Stage 4 — Editor and UI inspection",
  "",
  "Guarded editing in the UI.",
  "",
  "## Stage 5 — Independent final review and activation decision",
  "",
  "A fresh top-level reviewer verifies frozen candidate SHAs and every gate.",
  "",
].join("\n");

/** The manifest one worktree would hand the engine, given the whole declaration state. */
function manifestFor(state: StageModes | undefined, projectDir: string): string {
  const built = buildManifest({
    markdown: PLAN,
    planLabel: PLAN_LABEL,
    planName: "reported-statistics.md",
    modes: modesForPlan(state, PLAN_KEY, projectDir),
  });
  assert.ok(built.ok);
  return renderManifest(built.manifest);
}

function digestFor(state: StageModes | undefined, projectDir: string): string | undefined {
  const built = buildManifest({
    markdown: PLAN,
    planLabel: PLAN_LABEL,
    planName: "reported-statistics.md",
    modes: modesForPlan(state, PLAN_KEY, projectDir),
  });
  assert.ok(built.ok);
  return manifestDigest(built.manifest);
}

/** A discovered plan run, as the migration reads one. */
function run(projectDir: string, planKey = PLAN_KEY) {
  return { planKey, location: { projectDir } };
}

describe("two worktrees with the same relative plan path", () => {
  it("declaring a mode in A changes A's manifest", () => {
    const before = manifestFor(undefined, A);
    const state = withStageMode(undefined, PLAN_KEY, A, "5", "independent_review");
    const after = manifestFor(state, A);
    assert.notEqual(after, before, "A now runs Stage 5 as a review");
    assert.match(after, /"mode": "independent_review"/);
    assert.equal(modeForStage(state, PLAN_KEY, A, "5"), "independent_review");
  });

  it("…and does not change B's manifest, nor its digest", () => {
    const state = withStageMode(undefined, PLAN_KEY, A, "5", "independent_review");
    assert.equal(manifestFor(state, B), manifestFor(undefined, B), "byte-identical to the undeclared manifest");
    assert.equal(digestFor(state, B), digestFor(undefined, B), "so B's recorded run keeps resuming");
    assert.ok(!manifestFor(state, B).includes('"mode"'));
    assert.equal(modeForStage(state, PLAN_KEY, B, "5"), "implementation");
  });

  it("keeps the two declarations apart when both worktrees declare", () => {
    let state = withStageMode(undefined, PLAN_KEY, A, "5", "independent_review");
    state = withStageMode(state, PLAN_KEY, B, "4", "independent_review");
    assert.equal(modeForStage(state, PLAN_KEY, A, "5"), "independent_review");
    assert.equal(modeForStage(state, PLAN_KEY, A, "4"), "implementation");
    assert.equal(modeForStage(state, PLAN_KEY, B, "4"), "independent_review");
    assert.equal(modeForStage(state, PLAN_KEY, B, "5"), "implementation");
    assert.deepEqual(Object.keys(state).sort(), [stageModeScope(PLAN_KEY, A), stageModeScope(PLAN_KEY, B)].sort());
  });

  it("clearing A's declaration leaves B's alone", () => {
    let state = withStageMode(undefined, PLAN_KEY, A, "5", "independent_review");
    state = withStageMode(state, PLAN_KEY, B, "5", "independent_review");
    state = withStageMode(state, PLAN_KEY, A, "5", "implementation");
    assert.equal(modeForStage(state, PLAN_KEY, A, "5"), "implementation");
    assert.equal(modeForStage(state, PLAN_KEY, B, "5"), "independent_review");
  });

  it("survives being written out and read back, as workspace state is", () => {
    // workspaceState is JSON, and the scope key travels through it as a key.
    const state = withStageMode(withStageMode(undefined, PLAN_KEY, A, "5", "independent_review"), PLAN_KEY, B, "4", "independent_review");
    const reloaded = JSON.parse(JSON.stringify(state)) as StageModes;
    assert.equal(modeForStage(reloaded, PLAN_KEY, A, "5"), "independent_review");
    assert.equal(modeForStage(reloaded, PLAN_KEY, B, "5"), "implementation");
    assert.equal(modeForStage(reloaded, PLAN_KEY, B, "4"), "independent_review");
  });

  it("treats two spellings of one worktree as one worktree", () => {
    const state = withStageMode(undefined, PLAN_KEY, `${A}/`, "5", "independent_review");
    assert.equal(modeForStage(state, PLAN_KEY, A, "5"), "independent_review", "path.resolve normalises the scope");
    assert.equal(modeForStage(state, PLAN_KEY, `${A}/./`, "5"), "independent_review");
  });
});

describe("declarations made before modes were scoped to a worktree", () => {
  /** Exactly what is in workspace state for a declaration made by an earlier build. */
  const legacy: StageModes = { [PLAN_KEY]: { "5": "independent_review" } };

  it("are not applied to anything until they can be attributed", () => {
    assert.equal(modeForStage(legacy, PLAN_KEY, A, "5"), "implementation", "an unscoped declaration runs nothing");
    assert.equal(modeForStage(legacy, PLAN_KEY, B, "5"), "implementation");
    assert.deepEqual(modesForPlan(legacy, PLAN_KEY, A), {});
  });

  it("move to the one worktree that has a recorded run of that plan", () => {
    // The real case: the reported-statistics Stage 5 declaration, with one
    // checkout of the plan discovered.
    const { next, migrated, ambiguous } = migrateStageModes(legacy, [run(A)]);
    assert.deepEqual(ambiguous, []);
    assert.deepEqual(migrated, [{ planKey: PLAN_KEY, projectDir: A, labels: ["5"] }]);
    assert.equal(modeForStage(next, PLAN_KEY, A, "5"), "independent_review", "recovered");
    assert.equal(modeForStage(next, PLAN_KEY, B, "5"), "implementation", "and only there");
    assert.deepEqual(Object.keys(next), [stageModeScope(PLAN_KEY, A)], "the unscoped entry is retired");
  });

  it("refuse to guess when two worktrees could own them", () => {
    const { next, migrated, ambiguous } = migrateStageModes(legacy, [run(A), run(B)]);
    assert.deepEqual(migrated, []);
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(ambiguous[0].candidates.sort(), [A, B].sort());
    assert.deepEqual(next, legacy, "kept, so nothing is destroyed");
    assert.equal(modeForStage(next, PLAN_KEY, A, "5"), "implementation", "and applied to neither");
    assert.equal(modeForStage(next, PLAN_KEY, B, "5"), "implementation");
  });

  it("are kept, not dropped, when the worktree they belong to is not open", () => {
    const { next, migrated, ambiguous } = migrateStageModes(legacy, [run("/code/other", "some-other-plan-aaaaaaaa")]);
    assert.deepEqual(migrated, []);
    assert.deepEqual(ambiguous[0].candidates, [], "nothing to attribute it to");
    assert.deepEqual(next, legacy, "closing a folder must not destroy a declaration");
  });

  it("are idempotent: a second pass changes nothing", () => {
    const once = migrateStageModes(legacy, [run(A)]);
    const twice = migrateStageModes(once.next, [run(A)]);
    assert.deepEqual(twice.next, once.next);
    assert.deepEqual(twice.migrated, []);
    assert.deepEqual(twice.ambiguous, []);
  });

  it("never overwrite a declaration already made in that worktree", () => {
    // The scoped entry is the newer statement; the unscoped one is what is
    // being retired, and must not win over it.
    const mixed: StageModes = { ...legacy, [stageModeScope(PLAN_KEY, A)]: { "5": "implementation", "4": "independent_review" } };
    const { next } = migrateStageModes(mixed, [run(A)]);
    assert.equal(modeForStage(next, PLAN_KEY, A, "5"), "implementation", "the explicit later choice stands");
    assert.equal(modeForStage(next, PLAN_KEY, A, "4"), "independent_review");
  });

  it("leave an already-scoped entry completely alone", () => {
    const scoped = withStageMode(undefined, PLAN_KEY, A, "5", "independent_review");
    const { next, migrated, ambiguous } = migrateStageModes(scoped, [run(A), run(B)]);
    assert.deepEqual(next, scoped);
    assert.deepEqual(migrated, []);
    assert.deepEqual(ambiguous, [], "a scoped key has no legacy form to be ambiguous about");
  });

  it("do not mistake a project directory containing @ for an unscoped key", () => {
    const odd = "/code/@scope/worktree";
    const state = withStageMode(undefined, PLAN_KEY, odd, "5", "independent_review");
    assert.equal(modeForStage(state, PLAN_KEY, odd, "5"), "independent_review");
    const { migrated } = migrateStageModes(state, [run(odd)]);
    assert.deepEqual(migrated, [], "it is already scoped");
  });
});
