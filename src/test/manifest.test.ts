/**
 * The execution manifest: what the extension interprets out of a human plan
 * document, and what it deliberately leaves alone.
 *
 * The plan used here is the shape that motivated the whole feature — a real
 * one, with `3A`/`3B`/`3C`/`3D` labels, a stack of dated handoff sections
 * that record what happened and define nothing, and a canonical stage
 * sequence further down.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifest, manifestFileName, renderManifest, sourceDigest, type KnownStage } from "../core/manifest";

const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_NAME = "reported-statistics.md";

const PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "The executable stage definitions are the `## Stage <label> — …` sections under",
  "*Canonical stage sequence*. The `… handoff` sections are records, newest first.",
  "",
  "## Stage 3D handoff — 2026-09-14 (current stage; candidates pushed in both repositories)",
  "",
  "Status: Stage 3D implemented and self-verified in both repositories.",
  "",
  "## Stage 3C handoff — 2026-09-13 (accepted at `3c0f65b5`)",
  "",
  "The cloud slice landed.",
  "",
  "## Stage 1 handoff — 2026-09-11 (accepted at `a0bdcd37`)",
  "",
  "The contract landed.",
  "",
  "## Canonical stage sequence",
  "",
  "The order is Stage 1 → Stage 3C → Stage 3D → Stage 4.",
  "",
  "## Stage 1 — Contract and compatibility fixtures",
  "",
  "Freeze the measurement contract and its fixtures.",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "### Goal",
  "",
  "Add the cloud schema and the RPC guards.",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "Owns the frozen-evidence representation of enhanced content.",
  "",
  "## Stage 4 — Editor and UI inspection",
  "",
  "Guarded editing in the UI.",
  "",
  "## Required regression matrix",
  "",
  "Prose that is not a stage.",
  "",
].join("\n");

function build(known: KnownStage[] = []) {
  return buildManifest({ markdown: PLAN, planLabel: PLAN_LABEL, planName: PLAN_NAME, known });
}

describe("building an execution manifest from a human plan", () => {
  it("lists the canonical stages in workflow-label order, with lettered labels intact", () => {
    const built = build();
    assert.ok(built.ok);
    assert.deepEqual(
      built.manifest.stages.map((stage) => stage.label),
      ["Stage 1", "Stage 3C", "Stage 3D", "Stage 4"],
    );
    assert.equal(built.manifest.plan_label, PLAN_LABEL);
    assert.equal(built.manifest.version, 1);
  });

  it("excludes the historical handoff sections, and says which ones", () => {
    const built = build();
    assert.ok(built.ok);
    // Stage 3C and 3D are also *mentioned* by handoff headings, but each has
    // a real defining section, so they run once and only once.
    assert.equal(built.manifest.stages.filter((stage) => stage.label === "Stage 3C").length, 1);
    assert.ok(
      built.manifest.stages.every((stage) => !stage.title.includes("handoff")),
      "no handoff record becomes an executable stage",
    );
    assert.deepEqual(built.skipped, [], "every label here also has a defining section");

    // A stage that exists only as a record is skipped, not guessed at.
    const recordOnly = buildManifest({
      markdown: `${PLAN}\n## Stage 5 handoff — 2026-09-20 (accepted)\n\nNothing defines Stage 5.\n`,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
    });
    assert.ok(recordOnly.ok);
    assert.deepEqual(
      recordOnly.manifest.stages.map((stage) => stage.label),
      ["Stage 1", "Stage 3C", "Stage 3D", "Stage 4"],
    );
    assert.deepEqual(
      recordOnly.skipped.map((problem) => problem.label),
      ["5"],
    );
    assert.match(recordOnly.skipped[0].reason, /only as a record of what happened/);
  });

  it("each brief is the plan section verbatim under the engine's own header", () => {
    const built = build();
    assert.ok(built.ok);
    const stage = built.manifest.stages.find((entry) => entry.label === "Stage 3C")!;
    assert.equal(
      stage.brief,
      [
        "# Stage brief: stage-3c-cloud-schema-rpc-and-sync-transport",
        "",
        `Stage 3C from plan \`${PLAN_NAME}\`. Implement only this section; the other stages are separate.`,
        "",
        "## Stage 3C — Cloud schema/RPC and sync transport",
        "",
        "### Goal",
        "",
        "Add the cloud schema and the RPC guards.",
        "",
      ].join("\n"),
    );
    assert.ok(!stage.brief.includes("Stage 3D"), "the next stage's section is not swept in");
    assert.ok(!stage.brief.includes("handoff"), "nor is the handoff record");
  });

  it("keeps the stage ids the project already uses, so history stays visible", () => {
    const built = build([
      { label: "1", stageId: "stage-reported-statistics-contract" },
      { label: "3C", stageId: "stage-3c-cloud-schema-rpc-and-sync-transport" },
      { label: "3D", stageId: "stage-3d-snapshot-v2-and-attachment-export-import-transport" },
    ]);
    assert.ok(built.ok);
    assert.deepEqual(
      built.manifest.stages.map((stage) => stage.stage_id),
      [
        "stage-reported-statistics-contract",
        "stage-3c-cloud-schema-rpc-and-sync-transport",
        "stage-3d-snapshot-v2-and-attachment-export-import-transport",
        // Not yet started: the id Start next stage would have proposed.
        "stage-4-editor-and-ui-inspection",
      ],
    );
  });

  it("is deterministic: the same plan and matches always produce the same bytes", () => {
    const first = build();
    const second = build();
    assert.ok(first.ok && second.ok);
    assert.equal(renderManifest(first.manifest), renderManifest(second.manifest));
    // Which matters because the engine refuses to continue a run whose
    // manifest digest changed, and the file is rewritten on every launch.
    assert.equal(first.manifest.source_digest, second.manifest.source_digest);
    assert.match(first.manifest.source_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(renderManifest(first.manifest).endsWith("\n"), true);
  });

  it("an edited plan changes the source digest even when the stage sections do not", () => {
    const edited = buildManifest({ markdown: PLAN.replace("Prose that is not a stage.", "Edited prose."), planLabel: PLAN_LABEL, planName: PLAN_NAME });
    const original = build();
    assert.ok(edited.ok && original.ok);
    assert.notEqual(edited.manifest.source_digest, original.manifest.source_digest);
    assert.equal(sourceDigest(PLAN), original.manifest.source_digest);
  });

  it("carries declared sibling repositories for a cross-repository stage", () => {
    const built = buildManifest({
      markdown: PLAN,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
      repositories: { "3D": [{ name: "sporely-web", path: "../sporely-web-worktree", branch: "feature/cloud", candidate_sha: null }] },
    });
    assert.ok(built.ok);
    const withSibling = built.manifest.stages.find((stage) => stage.label === "Stage 3D")!;
    assert.deepEqual(withSibling.repositories, [{ name: "sporely-web", path: "../sporely-web-worktree", branch: "feature/cloud", candidate_sha: null }]);
    assert.equal(built.manifest.stages.find((stage) => stage.label === "Stage 1")!.repositories, undefined, "no empty array where there is nothing to declare");
  });

  it("refuses rather than guesses when a stage is defined twice", () => {
    const ambiguous = buildManifest({
      markdown: `${PLAN}\n## Stage 4 — Editor and UI inspection, revised\n\nA second definition.\n`,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
    });
    assert.ok(!ambiguous.ok);
    assert.deepEqual(
      ambiguous.problems.map((problem) => problem.label),
      ["4"],
    );
    assert.match(ambiguous.problems[0].reason, /more than one section/);
  });

  it("refuses a stage whose section is a heading with nothing under it", () => {
    const empty = buildManifest({
      markdown: ["# Plan", "", "## Stage 1 — Foundation", "", "## Stage 2 — Next", "", "Body.", ""].join("\n"),
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
    });
    assert.ok(!empty.ok);
    assert.match(empty.problems[0].reason, /no content to brief the stage with/);
  });

  it("refuses a plan with nothing executable in it", () => {
    const prose = buildManifest({ markdown: "# Notes\n\nJust prose.\n", planLabel: PLAN_LABEL, planName: PLAN_NAME });
    assert.ok(!prose.ok);
    assert.match(prose.problems[0].reason, /no stage with a section to run/);
  });

  it("names the manifest file after the plan key, so regenerating overwrites in place", () => {
    assert.equal(manifestFileName("reported-statistics-3f9a2c1b"), "reported-statistics-3f9a2c1b.manifest.json");
  });

  it("carries no status, position, verdict or session: it is input, not a second workflow engine", () => {
    const built = build();
    assert.ok(built.ok);
    assert.deepEqual(Object.keys(built.manifest).sort(), ["plan_label", "source_digest", "stages", "version"]);
    for (const stage of built.manifest.stages) {
      assert.ok(
        Object.keys(stage).every((key) => ["stage_id", "label", "title", "brief", "repositories"].includes(key)),
        `stage carries only execution content, got ${Object.keys(stage).join(", ")}`,
      );
    }
    const text = renderManifest(built.manifest);
    for (const forbidden of ["status", "current_stage", "accepted", "session", "candidate_sha\": \"", "digest\": \"sha256:0"]) {
      assert.ok(!text.includes(`"${forbidden}"`), `no ${forbidden} field`);
    }
  });
});
