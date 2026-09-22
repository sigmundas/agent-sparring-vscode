/**
 * A plan run that finished before manifests said which worktree wrote them.
 *
 * Binding is strict, and stays strict. But a manifest is only ever *written*
 * when a run is started or resumed, and a **completed** run is never resumed
 * again — so the strict rule, applied to a run that had already finished, took
 * away its stage list, its journey and the membership of every stage it
 * executed, permanently, with nothing a person could do about it. The engine
 * has nothing left to run for such a plan, so "run it again" is not a repair.
 *
 * The recovery derives the missing statement instead of writing one, and these
 * tests hold both halves of that: that a genuinely provable legacy manifest is
 * recovered **without the engine being invoked and without any file being
 * written**, and that every way of failing to prove it still fails.
 *
 * The shape used here is the real one from this machine, reduced: a `complete`
 * run with `source: "manifest"`, whose manifest is at the oldest unscoped file
 * name, with no sidecar, and whose recorded `plan_digest` is the digest of
 * that file's executable content.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, type PlanRunSnapshot } from "../core/discovery";
import { bindingPathFor, legacyManifestFileName, manifestPathFor, parseExecutionManifest, renderManifest, sourceDigest } from "../core/manifest";
import { planMembershipFor } from "../core/planMembership";
import { ManifestReader } from "../vscode/manifestReader";
import { ManifestStore, Workspace, recordPlanDigest } from "./fixtures";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/reported-statistics.md";
const STAGE_1 = "stage-1-contract";
const STAGE_5 = "stage-5-independent-final-review";

const PLAN = [
  "# Reported statistics",
  "",
  "## Stage 5 handoff — 2026-09-14 (accepted)",
  "",
  "Status: accepted.",
  "",
  "## Canonical stage sequence",
  "",
  "## Stage 5 — Independent final review",
  "",
  "A fresh reviewer verifies every gate.",
  "",
].join("\n");

/** The manifest text such a run executed, and the digest the engine recorded for it. */
function manifestText(planLabel = PLAN_LABEL): string {
  return renderManifest({
    version: 1,
    plan_label: planLabel,
    source_digest: sourceDigest(PLAN),
    stages: [
      { stage_id: STAGE_1, label: "Stage 1", title: "Contract", brief: "# Contract\n" },
      { stage_id: STAGE_5, label: "Stage 5", title: "Independent final review", brief: "# Review\n", mode: "independent_review" },
    ],
  });
}

/**
 * A finished plan run whose manifest is at a legacy name with no sidecar —
 * i.e. exactly what an upgrade leaves behind.
 */
async function completedLegacyRun(options: { name?: "unscoped" | "short-scoped"; planLabel?: string } = {}) {
  const ws = await Workspace.create();
  await ws.writePlan(PLAN_LABEL, PLAN);
  await ws.writeStage(STAGE_1, { status: "accepted" });
  await ws.writeStage(STAGE_5, { status: "accepted" });
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "complete", current_stage_index: 1, current_stage: STAGE_5, source: "manifest" });

  const store = await ManifestStore.create();
  const text = manifestText(options.planLabel);
  const name = options.name === "short-scoped" ? path.basename(manifestPathFor(store.dir, { runKey: PLAN_KEY, planKey: PLAN_KEY, location: { projectDir: ws.root } })) : legacyManifestFileName(PLAN_KEY);
  // The legacy file, written at the legacy name. No sidecar: that is the
  // whole point — the run finished before sidecars existed.
  await fs.writeFile(path.join(store.dir, name), text);

  const runs = (await discoverRuns([ws.location])).runs;
  const run = runs.find((candidate): candidate is PlanRunSnapshot => candidate.kind === "plan")!;
  // What the engine recorded when it ran this manifest.
  await recordPlanDigest(run, parseExecutionManifest(text)!.digest);
  return { ws, store, runs: (await discoverRuns([ws.location])).runs, run: (await discoverRuns([ws.location])).runs.find((c): c is PlanRunSnapshot => c.kind === "plan")!, text };
}

describe("a completed run whose manifest predates binding records", () => {
  it("regains its stage list on being read, with no engine invocation and nothing written", async () => {
    const { store, run } = await completedLegacyRun();
    const before = (await fs.readdir(store.dir)).sort();

    const bound = await new ManifestReader().readBound(store.dir, run);
    assert.equal(bound.binding.ok, true, "the run's own recorded plan_digest proves the file is its manifest");
    assert.ok(bound.binding.ok);
    assert.deepEqual(
      bound.binding.identity.stages.map((stage) => stage.stageId),
      [STAGE_1, STAGE_5],
      "the whole executed sequence, not just the current stage",
    );
    assert.equal(bound.derived, true, "and the acceptance is reported as derived, never passed off as a sidecar");
    assert.equal(bound.file, legacyManifestFileName(PLAN_KEY));

    assert.deepEqual((await fs.readdir(store.dir)).sort(), before, "reading wrote nothing: no sidecar, no rewritten manifest");
  });

  it("gives the finished run's stages their membership and their place in the timeline", async () => {
    const { store, runs, run } = await completedLegacyRun();
    const reader = new ManifestReader();
    const stages = (await reader.readBound(store.dir, run)).binding;
    assert.ok(stages.ok);

    const stage1 = runs.find((candidate) => candidate.kind === "stage" && candidate.stage.stageId === STAGE_1);
    assert.ok(stage1 && stage1.kind === "stage", "Stage 1 comes back standalone, because the plan document carries a handoff record");
    const membership = planMembershipFor(stage1, [{ run, manifestStages: stages.identity.stages }]);
    assert.equal(membership?.planRunId, run.id, "it is history of the completed plan run");
    assert.equal(membership?.planStatus, "complete");
    assert.equal(membership?.stageLabel, "Stage 1");
    assert.equal(membership?.position, 1);
    assert.equal(membership?.totalStages, 2, "the timeline knows how long the run was");
  });

  it("is recovered at the project-scoped name a later build used, too", async () => {
    const { store, run } = await completedLegacyRun({ name: "short-scoped" });
    const bound = await new ManifestReader().readBound(store.dir, run);
    assert.equal(bound.binding.ok, true, "a manifest written after names were scoped but before sidecars existed");
    assert.equal(bound.derived, true);
  });

  it("is idempotent: reading twice gives the same answer and still writes nothing", async () => {
    const { store, run } = await completedLegacyRun();
    const reader = new ManifestReader();
    const first = await reader.readBound(store.dir, run);
    const before = (await fs.readdir(store.dir)).sort();
    const second = await reader.readBound(store.dir, run);
    assert.deepEqual(second.binding, first.binding);
    assert.deepEqual((await fs.readdir(store.dir)).sort(), before);
  });
});

describe("what the derivation still refuses", () => {
  it("a manifest whose executable content is not what the run recorded", async () => {
    const { store, run } = await completedLegacyRun();
    // The plan was rewritten and the manifest regenerated, but this run's
    // recorded identity is the old one. The engine would refuse to resume it,
    // and so does this.
    await fs.writeFile(path.join(store.dir, legacyManifestFileName(PLAN_KEY)), manifestText().replace("Independent final review", "Something else"));
    const bound = await new ManifestReader().readBound(store.dir, run);
    assert.equal(bound.binding.ok, false);
    assert.ok(!bound.binding.ok && bound.binding.reason === "plan-digest");
  });

  it("a manifest for another plan", async () => {
    const { store, run } = await completedLegacyRun();
    await fs.writeFile(path.join(store.dir, legacyManifestFileName(PLAN_KEY)), manifestText("docs/plans/something-else.md"));
    const bound = await new ManifestReader().readBound(store.dir, run);
    assert.ok(!bound.binding.ok);
    assert.notEqual(bound.binding.reason, "unbound-worktree");
  });

  it("a manifest that does not contain the stage the run records itself at", async () => {
    const { ws, store } = await completedLegacyRun();
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "complete", current_stage_index: 9, current_stage: "stage-9-never-ran", source: "manifest" });
    const run = (await discoverRuns([ws.location])).runs.find((c): c is PlanRunSnapshot => c.kind === "plan")!;
    await recordPlanDigest(run, parseExecutionManifest(manifestText())!.digest);
    const bound = await new ManifestReader().readBound(store.dir, run);
    assert.ok(!bound.binding.ok);
    assert.equal(bound.binding.reason, "current-stage");
  });

  it("a legacy manifest two worktrees could equally claim", async () => {
    // The exact reason the sidecar exists. Two worktrees of one repository
    // ran the same plan: their manifests are byte-identical, their recorded
    // state is identical, and one shared legacy file name holds the result.
    // Nothing can say whose it is, so it is nobody's.
    const a = await completedLegacyRun();
    const twin = await Workspace.create();
    await twin.writePlan(PLAN_LABEL, PLAN);
    await twin.writeStage(STAGE_1, { status: "accepted" });
    await twin.writeStage(STAGE_5, { status: "accepted" });
    await twin.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "complete", current_stage_index: 1, current_stage: STAGE_5, source: "manifest" });
    const twinRun = (await discoverRuns([twin.location])).runs.find((c): c is PlanRunSnapshot => c.kind === "plan")!;
    await recordPlanDigest(twinRun, parseExecutionManifest(a.text)!.digest);

    const reader = new ManifestReader();
    const bound = await reader.readBound(a.store.dir, a.run, [a.run, twinRun]);
    assert.ok(!bound.binding.ok, "attributing it to either would be a guess");
    assert.equal(bound.binding.reason, "ambiguous-legacy");
    // …and with only one of them discovered, it is provable again.
    assert.equal((await new ManifestReader().readBound(a.store.dir, a.run, [a.run])).binding.ok, true);
  });

  it("a sidecar that exists and disagrees — the strict path is not weakened", async () => {
    const { store, run } = await completedLegacyRun();
    // A binding record is present but names another worktree. The legacy
    // derivation must not be reachable as a way around it.
    await fs.writeFile(path.join(store.dir, legacyManifestFileName(PLAN_KEY)), manifestText());
    await fs.writeFile(path.join(store.dir, path.basename(manifestPathFor(store.dir, run))), manifestText());
    await fs.writeFile(
      bindingPathFor(store.dir, run),
      JSON.stringify({ version: 1, manifest_file: path.basename(manifestPathFor(store.dir, run)), manifest_digest: parseExecutionManifest(manifestText())!.digest, plan_key: PLAN_KEY, plan_label: PLAN_LABEL, project_dir: "/somewhere/else" }, null, 2),
    );
    const bound = await new ManifestReader().readBound(store.dir, run);
    assert.ok(!bound.binding.ok);
    assert.equal(bound.binding.reason, "unbound-worktree");
    assert.equal(bound.derived, false);
  });
});
