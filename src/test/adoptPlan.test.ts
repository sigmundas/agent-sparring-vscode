/**
 * Adopting an existing, hand-driven sequence into a managed plan run.
 *
 * The real shape this is written from: Stage 3D is a standalone stage
 * stopped at NEEDS_YOU, with two live sessions, an associated plan and a
 * reviewer's gate the human is halfway through answering. Adoption has to be
 * *offered* there — that was the whole complaint, the mode had no entry
 * point from where the user actually was — and it has to change nothing
 * about the stage: the engine reads the recorded NEEDS_YOU and keeps the
 * pause, so the next human action is exactly what it was.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-14T10:00:00.000Z");
const STAGE_ID = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_KEY = "reported-statistics-3f9a2c1b";

const PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "The cloud slice.",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "The frozen-evidence representation.",
  "",
].join("\n");

/** A NEEDS_YOU with today's structured gate. */
const STRUCTURED = [
  `# Sparring: ${STAGE_ID}`,
  "",
  "## Finding / discussion",
  "",
  "Both repository candidates form a coherent Stage 3D implementation.",
  "",
  "## Routing outcome",
  "",
  "- Action: `NEEDS_YOU`",
  "- Summary: Only the required real-desktop compatibility gate remains before acceptance.",
  "- Needs-you reason: DEVICE/MANUAL CHECK -- desktop",
  "",
  "## NEEDS YOU",
  "",
  "Only the required real-desktop compatibility gate remains before acceptance.",
  "",
  HUMAN_GATE_MARKER,
  "",
  "```json",
  JSON.stringify(
    {
      category: "DEVICE_MANUAL_CHECK",
      title: "A pre-activation desktop must accept a feed containing snapshot v2",
      checks: [
        {
          id: "desktop-v2-feed",
          instruction: "Point a pre-activation desktop at a feed containing a valid snapshot-v2 row.",
          pass_criteria: "The desktop consumes the complete feed and does not reject it.",
          source: "Required regression matrix",
        },
      ],
    },
    null,
    2,
  ),
  "```",
  "",
].join("\n");

/** The same verdict as it was actually recorded, before gates were structured. */
const LEGACY = [
  `# Sparring: ${STAGE_ID}`,
  "",
  "## Routing outcome",
  "",
  "- Action: `NEEDS_YOU`",
  "- Summary: Only the required real-desktop compatibility gate remains before acceptance.",
  "- Needs-you reason: DEVICE/MANUAL CHECK -- verify a supported pre-activation desktop can consume a feed containing snapshot v2",
  "",
  "## NEEDS YOU",
  "",
  "Verify a supported pre-activation desktop can consume a cloud feed containing a valid snapshot-v2 row.",
  "",
].join("\n");

async function workspace(sparring: string) {
  const ws = await Workspace.create();
  await ws.writeStage(
    STAGE_ID,
    { status: "working", implementation_session_id: "ef8449bb-b38d-4e1d-95b5-d77566a2c6ec", sparring_session_id: "01a09eb0-9e48-7dc2-aef4-bc8e54a5a050", base_sha: "3c0f65b5".padEnd(40, "0") },
    { "sparring.md": sparring },
  );
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  return { ws, planPath };
}

function artifacts(planPath: string, extra: Partial<OverviewArtifacts> = {}): OverviewArtifacts {
  return {
    handoff: false,
    sparring: true,
    brief: false,
    plan: false,
    associatedPlan: { path: planPath, exists: true, text: PLAN, manualMatch: { label: "3D", title: "Snapshot v2 and attachment/export/import transport" } },
    ...extra,
  };
}

describe("offering adoption from the stage the user is actually looking at", () => {
  it("a standalone stage waiting for a human still offers Continue plan automatically", async () => {
    const { ws, planPath } = await workspace(STRUCTURED);
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts(planPath), NOW);

    assert.equal(model.runKind, "Standalone stage");
    assert.equal(model.actionRequired?.kind, "needs_you");
    assert.equal(model.continueAutomatically?.label, "Continue plan automatically");
    assert.equal(model.continueAutomatically?.detail, "Adopt the existing stages into a managed plan and continue until Agent Sparring needs you. (sparring run-plan --manifest … --adopt over Reported statistics and explicit range semantics: accepted stages are verified and advanced past, this stage keeps its sessions and its recorded review, and the engine takes the sequencing from there.)");
    // It is reachable without knowing a Command Palette entry exists.
    assert.match(renderOverviewHtml(model, "n", "c"), /data-action="continueAutomatically"/);
  });

  it("without a plan there is nothing to adopt", async () => {
    const { ws } = await workspace(STRUCTURED);
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: true, brief: false, plan: false }, NOW);
    assert.equal(model.continueAutomatically, undefined);
  });

  it("manual mode still offers nothing: that mode is the per-stage one", async () => {
    const { ws, planPath } = await workspace(STRUCTURED);
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts(planPath, { continuation: "manual" }), NOW);
    assert.equal(model.continueAutomatically, undefined);
  });
});

describe("what adoption changes, and what it must not", () => {
  /** The same stage, after the engine has written its plan-run state around it. */
  async function adopted(sparring: string) {
    const { ws, planPath } = await workspace(sparring);
    const before = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts(planPath), NOW);
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_ID, source: "manifest" });
    const after = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: true, brief: false, plan: true, planText: PLAN }, NOW);
    return { before, after, ws };
  }

  it("the run stops being a standalone stage and becomes a managed plan run", async () => {
    const { before, after } = await adopted(STRUCTURED);

    assert.equal(before.runKind, "Standalone stage");
    assert.equal(after.runKind, "Plan run");
    assert.equal(after.stageId, STAGE_ID, "the same stage, not a new one");
  });

  it("the structured gate, its checks and the recorded sessions survive adoption unchanged", async () => {
    const { before, after } = await adopted(STRUCTURED);

    for (const model of [before, after]) {
      assert.equal(model.actionRequired?.kind, "needs_you");
      assert.deepEqual(
        [...(model.actionRequired?.recorded ?? []), ...(model.actionRequired?.required ?? [])].map((item) => item.key),
        ["desktop-v2-feed"],
      );
      assert.equal(model.actionRequired?.source, "gate");
      assert.equal(model.stageAgent?.sessionLabel, "ef8449bb…");
      assert.equal(model.sparrer?.sessionLabel, "01a09eb0…");
    }
    // Still the human's move, not the engine's.
    assert.equal(after.actionRequired?.submit.enabled, false, "nothing recorded yet, so nothing to submit");
  });

  it("a verdict recorded before structured gates keeps its prose-derived checks too", async () => {
    const { before, after } = await adopted(LEGACY);

    for (const model of [before, after]) {
      assert.equal(model.actionRequired?.kind, "needs_you");
      assert.equal(model.actionRequired?.source, "derived", "the old fallback, still working");
      assert.ok((model.actionRequired?.required.length ?? 0) > 0);
    }
  });

  it("a managed run at a gate stops offering adoption: it already owns the sequencing", async () => {
    const { after } = await adopted(STRUCTURED);
    assert.equal(after.continueAutomatically, undefined);
  });

  it("the journey note blames the manifest, not the plan document, when the plan has no numeric stages", async () => {
    // The plan's `3C`/`3D` labels are not the engine's `## Stage <n>`
    // convention, and a manifest run does not use that convention at all.
    const { after } = await adopted(STRUCTURED);
    assert.match(after.timelineNote ?? "", /executes an execution manifest/);
    assert.ok(!/Plan document unavailable/.test(after.timelineNote ?? ""));
  });
});
