/**
 * Declaring that a plan stage is a review of work rather than work.
 *
 * The line these tests hold is the one that matters: the declaration is a
 * human's and it is explicit. A stage titled "Independent final review and
 * activation decision" is not review-only because of its title, and the
 * manifest says nothing about a mode until someone says so.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifest, renderManifest } from "../core/manifest";
import {
  modeForStage,
  modeLabelKey,
  modesForPlan,
  withStageMode,
  type StageModes,
} from "../core/stageModes";

const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_NAME = "reported-statistics.md";

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

function build(modes?: Record<string, "implementation" | "independent_review">) {
  return buildManifest({ markdown: PLAN, planLabel: PLAN_LABEL, planName: PLAN_NAME, modes });
}

/** The manifest this plan builds to, as the file the engine would read. */
function rendered(modes?: Record<string, "implementation" | "independent_review">): string {
  const built = build(modes);
  assert.ok(built.ok);
  return renderManifest(built.manifest);
}

describe("stage mode declarations", () => {
  it("defaults to implementation and normalises how a stage is addressed", () => {
    assert.equal(modeForStage(undefined, "plan", "5"), "implementation");
    const state = withStageMode(undefined, "plan", "Stage 5", "independent_review");
    assert.equal(modeForStage(state, "plan", "5"), "independent_review");
    assert.equal(modeForStage(state, "plan", "stage 5"), "independent_review");
    assert.equal(modeLabelKey(" Stage 3c "), "3C");
  });

  it("declaring the default removes the entry, so there is one way to say it", () => {
    const declared = withStageMode(undefined, "plan", "5", "independent_review");
    const back = withStageMode(declared, "plan", "5", "implementation");
    assert.deepEqual(back, {}, "no declaration and declared-as-default are the same state");
    assert.equal(modeForStage(back, "plan", "5"), "implementation");
  });

  it("drops shapes it does not recognise rather than throwing on them", () => {
    const corrupt = { plan: { "5": "review", "4": null, "3": "independent_review" } } as unknown as StageModes;
    assert.deepEqual(modesForPlan(corrupt, "plan"), { "3": "independent_review" });
    assert.deepEqual(modesForPlan(undefined, "plan"), {});
  });
});

describe("the mode in the execution manifest", () => {
  it("emits nothing until a mode is declared, whatever the stage is called", () => {
    const built = build();
    assert.ok(built.ok);
    const stage5 = built.manifest.stages.find((stage) => stage.label === "Stage 5")!;
    assert.match(stage5.title, /Independent final review/);
    assert.equal(stage5.mode, undefined, "a title is not a declaration");
    assert.ok(!renderManifest(built.manifest).includes('"mode"'));
  });

  it("emits the declared review mode for exactly that stage", () => {
    const built = build({ "5": "independent_review" });
    assert.ok(built.ok);
    assert.deepEqual(
      built.manifest.stages.map((stage) => [stage.label, stage.mode]),
      [
        ["Stage 4", undefined],
        ["Stage 5", "independent_review"],
      ],
    );
  });

  it("never emits the default mode, so an unchanged manifest stays byte-identical", () => {
    // The engine folds a declared mode into the digest identifying a
    // recorded run, so writing "implementation" would change that digest
    // without changing what runs — and end the run.
    const plain = rendered();
    assert.equal(rendered({ "5": "implementation" }), plain);
    assert.notEqual(rendered({ "5": "independent_review" }), plain);
  });

  it("puts mode in a fixed position, so regenerating the file is deterministic", () => {
    const first = rendered({ "5": "independent_review" });
    const second = rendered({ "5": "independent_review" });
    assert.equal(first, second);
    const parsed = JSON.parse(first) as { stages: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(parsed.stages[1]), ["stage_id", "label", "title", "brief", "mode"]);
  });
});
