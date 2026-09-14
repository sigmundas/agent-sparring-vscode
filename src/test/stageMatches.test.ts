/**
 * The plan-level view of which stage is which.
 *
 * The bug it exists for: matching is deliberately conservative, so a
 * historical stage whose brief opens by mentioning three stage numbers
 * matches none of them. The only control for fixing that was "Change
 * match…", which remaps the stage the panel is showing — so trying to place
 * a historical Stage 1 silently remapped the *current* Stage 3D instead.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parsePlanHeadings } from "../core/planAssociation";
import { UNPLACED_PROBLEM, stageMatchRows, type StageToMatch } from "../core/stageMatches";

const PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Stage 1 handoff — 2026-09-11 (accepted at `a0bdcd37`)",
  "",
  "The contract landed.",
  "",
  "## Stage 1 — Contract and compatibility fixtures",
  "",
  "Freeze the contract.",
  "",
  "## Stage 2 — Typed contract and parser specification",
  "",
  "The parser.",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "The transport.",
  "",
].join("\n");

const HEADINGS = parsePlanHeadings(PLAN);

/** The real one: its opening paragraph names Stages 1, 3 and 2, so nothing places it. */
const CONTRACT: StageToMatch = {
  runId: "repo|stage|stage-reported-statistics-contract",
  stageId: "stage-reported-statistics-contract",
  name: "Reported statistics contract",
  briefText: "# Stage brief\n\nThis is Stage 1 of the canonical plan; see also Stage 3 and Stage 2.\n",
};

const SNAPSHOT: StageToMatch = {
  runId: "repo|stage|stage-3d-snapshot-v2-and-attachment-export-import-transport",
  stageId: "stage-3d-snapshot-v2-and-attachment-export-import-transport",
  name: "3d snapshot v2 and attachment export import transport",
};

describe("reviewing every stage's plan match at once", () => {
  it("flags the historical stage nothing could place, and says why it matters", () => {
    const rows = stageMatchRows(HEADINGS, [SNAPSHOT, CONTRACT]);

    const contract = rows.find((row) => row.stageId === CONTRACT.stageId)!;
    assert.equal(contract.label, undefined);
    assert.equal(contract.problem, UNPLACED_PROBLEM);
    assert.match(contract.problem!, /create a new stage for that section/, "the consequence, not just the fact");
    // And the stage that *is* placed is left alone.
    const snapshot = rows.find((row) => row.stageId === SNAPSHOT.stageId)!;
    assert.equal(snapshot.label, "3D");
    assert.equal(snapshot.problem, undefined);
  });

  it("puts what needs a person first, then follows the plan's own order", () => {
    const rows = stageMatchRows(HEADINGS, [
      SNAPSHOT,
      { runId: "r|s|two", stageId: "stage-2-typed-parser", name: "Typed parser", manual: { label: "2", title: "Typed contract and parser specification" } },
      CONTRACT,
    ]);
    assert.deepEqual(
      rows.map((row) => row.label ?? "unmatched"),
      ["unmatched", "2", "3D"],
    );
  });

  it("a manual match places the stage that was unplaceable, and only that stage", () => {
    const fixed = stageMatchRows(HEADINGS, [SNAPSHOT, { ...CONTRACT, manual: { label: "1", title: "Contract and compatibility fixtures" } }]);

    const contract = fixed.find((row) => row.stageId === CONTRACT.stageId)!;
    assert.equal(contract.label, "1");
    assert.equal(contract.matchedBy, "manual");
    assert.equal(contract.problem, undefined);
    assert.equal(fixed.find((row) => row.stageId === SNAPSHOT.stageId)!.label, "3D", "Stage 3D is untouched by fixing Stage 1");
    assert.ok(
      fixed.every((row) => row.problem === undefined),
      "nothing is left needing a person",
    );
  });

  it("refuses to pick when two stages claim the same section", () => {
    // Guessing would silently orphan the other one.
    const rows = stageMatchRows(HEADINGS, [SNAPSHOT, { ...CONTRACT, manual: { label: "3D", title: "Snapshot v2 and attachment/export/import transport" } }]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.problem ?? "", /More than one stage resolves to Stage 3D/);
    }
  });

  it("the handoff heading is not a section a stage can be", () => {
    const rows = stageMatchRows(HEADINGS, [{ ...CONTRACT, manual: { label: "1", title: "Contract and compatibility fixtures" } }]);
    assert.equal(rows[0].label, "1");
    // The plan mentions Stage 1 twice; the definition is what a stage is.
    assert.equal(rows[0].problem, undefined);
  });

  it("no stages, no rows", () => {
    assert.deepEqual(stageMatchRows(HEADINGS, []), []);
  });
});

describe("the two controls cannot be confused for each other", () => {
  it('"Change match…" names the stage it will remap, in the dialog title', async () => {
    // The accident this prevents: trying to place a historical Stage 1 by
    // using the only matching control on screen — which was showing Stage 3D
    // — and silently remapping Stage 3D to Stage 1 instead.
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function matchStageCommand[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.ok(body, "matchStageCommand exists");
    assert.match(body, /title: `Match "\$\{named\}" to which plan section\?`/);
    assert.match(body, /const named = current\?\.stage\?\.display \?\? stageDisplayName\(stage\)/, "the stage's own name, not the plan's");
    assert.match(body, /placeHolder: `Only \$\{stage\.stageId\} is remapped/);
    // And it writes to exactly one run: the target's, or the selected one.
    assert.equal((body.match(/setManualMatch\(/g) ?? []).length, 2, "clear, or set — both against runId");
    assert.ok(!/setManualMatch\((?!runId)/.test(body), "never against anything but the addressed stage");
  });

  it('"All stage matches…" is a separate, plan-level control that changes nothing on its own', async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function reviewStageMatchesCommand[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.ok(body, "reviewStageMatchesCommand exists");
    assert.ok(!/setManualMatch|setAssociatedPlan/.test(body), "it only lists; the per-stage dialog does the writing");
    assert.match(body, /matchStageCommand\(controller, overview, \{ runId: picked\.row\.runId, stage: picked\.row\.stage, planPath \}\)/, "and it addresses the stage the user picked, not the selected one");
  });
});
