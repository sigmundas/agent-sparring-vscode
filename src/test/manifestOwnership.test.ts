/**
 * Whose manifest is this, and whose stage is that?
 *
 * An execution manifest is the only record of which stages a managed plan run
 * executed, so it is the only thing that can say a historical stage belongs to
 * that run. It also lives in the extension's *global storage*, which is
 * per-user and nothing else — not per-worktree, not per-machine-state. So its
 * presence proves nothing on its own, and two things have to hold before any
 * of it is believed:
 *
 *  - the **path** is scoped to the run's own project directory, so two
 *    worktrees of one repository running `docs/plans/…` cannot consume each
 *    other's file;
 *  - the **content** is bound to the run's recorded state — the plan label it
 *    executes and the stage the engine says it is at — so a manifest
 *    regenerated into something else cannot silently redefine which historical
 *    stages belong to which run.
 *
 * Failing either one degrades honestly: no membership, no "Historical stage",
 * no "Back to plan run", and the stage keeps its own screen.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, type PlanRunSnapshot, type StandaloneStageSnapshot } from "../core/discovery";
import { legacyManifestFileName, type ManifestStageIdentity } from "../core/manifest";
import { ManifestStore, Workspace, membershipsOf } from "./fixtures";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const STAGE_3D = "stage-3d-transport";
const STAGE_4 = "stage-4-editor";

const PLAN = ["# Reported statistics", "", "## Stage 3D handoff — 2026-09-14 (accepted)", "", "Accepted.", "", "## Stage 3D — Transport", "", "The transport.", "", "## Stage 4 — Editor", "", "The editor.", ""].join("\n");

const STAGES: ManifestStageIdentity[] = [
  { stageId: STAGE_3D, label: "Stage 3D", title: "Transport" },
  { stageId: STAGE_4, label: "Stage 4", title: "Editor" },
];

/**
 * One worktree with a finished plan run: Stage 3D accepted and rediscovered on
 * its own (the plan document carries a handoff record, so the engine-shaped
 * parser refuses it and the run claims only its current stage), Stage 4 the
 * recorded current stage.
 */
async function worktree(name: string, status: "running" | "complete" = "complete") {
  const ws = await Workspace.create({ name });
  await ws.writePlan(PLAN_LABEL, PLAN);
  await ws.writeStage(STAGE_3D, { status: "accepted", candidate_sha: "c".repeat(40) });
  await ws.writeStage(STAGE_4, { status: "accepted", candidate_sha: "d".repeat(40) });
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status, current_stage: STAGE_4, current_stage_index: 1, source: "manifest" });
  const runs = (await discoverRuns([ws.location])).runs;
  const plan = runs.find((run): run is PlanRunSnapshot => run.kind === "plan");
  const historical = runs.find((run): run is StandaloneStageSnapshot => run.kind === "stage" && run.stage.stageId === STAGE_3D);
  assert.ok(plan && historical, "a plan run, and Stage 3D on its own");
  return { ws, runs, plan, historical };
}

describe("a manifest is bound to the run and the worktree it belongs to", () => {
  it("two worktrees running the same plan path keep separate manifests", async () => {
    const a = await worktree("sporely-py-reported-statistics");
    const b = await worktree("sporely-py-reported-statistics-wt");
    const store = await ManifestStore.create();

    // Same plan key — the key is a hash of the repo-relative plan path — and
    // therefore the same file name before manifests were scoped.
    assert.equal(a.plan.planKey, b.plan.planKey);
    assert.notEqual(store.fileFor(a.plan), store.fileFor(b.plan), "but not the same file");

    // Only worktree A's run has a manifest written for it.
    await store.write(a.plan, STAGES);
    assert.equal((await membershipsOf(a.runs, store)).get(a.historical.id)?.planRunId, a.plan.id, "A's stage is A's run's");
    assert.equal((await membershipsOf(b.runs, store)).get(b.historical.id), undefined, "B consumes nothing of A's");

    // And B's own manifest attributes B's stage to B's run, not to A's.
    await store.write(b.plan, STAGES);
    assert.equal((await membershipsOf(b.runs, store)).get(b.historical.id)?.planRunId, b.plan.id);
  });

  it("a completed run keeps its stage membership", async () => {
    const { runs, plan, historical } = await worktree("beta", "complete");
    const store = await ManifestStore.create();
    await store.write(plan, STAGES);

    const membership = (await membershipsOf(runs, store)).get(historical.id);
    assert.equal(plan.state.status, "complete");
    assert.equal(membership?.planRunId, plan.id, "completion is a status, not a loss of identity");
    assert.equal(membership?.stageLabel, "Stage 3D");
    assert.equal(membership?.position, 1);
    assert.equal(membership?.totalStages, 2);
  });

  it("a regenerated manifest that no longer describes the run redefines nothing", async () => {
    const { runs, plan, historical } = await worktree("beta");
    const store = await ManifestStore.create();
    // The plan was rewritten and rebuilt into different stage ids, while the
    // engine's recorded state still says this run is at stage-4-editor.
    await store.write(plan, [
      { stageId: "stage-9-something-else", label: "Stage 9", title: "Something else" },
      { stageId: STAGE_3D, label: "Stage 3D", title: "Transport" },
    ]);

    assert.equal(
      (await membershipsOf(runs, store)).get(historical.id),
      undefined,
      "the manifest does not contain the run's recorded current stage, so it is not this run's stage list",
    );
  });

  it("a manifest for another plan is refused even at the right path", async () => {
    const { runs, plan, historical } = await worktree("beta");
    const store = await ManifestStore.create();
    await store.write(plan, STAGES, { overrides: { plan_label: "docs/plans/active/something-else.md" } });
    assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined);
  });

  it("a missing manifest degrades to no membership, never to a guess", async () => {
    const { runs, historical } = await worktree("beta");
    const store = await ManifestStore.create();
    // Nothing written at all: another machine, or global storage cleared.
    assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined);
  });

  it("the unscoped file left by an older version is not read as authority", async () => {
    const { runs, plan, historical } = await worktree("beta");
    const store = await ManifestStore.create();
    // Exactly what a previous version wrote, at the name it used.
    await store.writeAt(path.join(store.dir, legacyManifestFileName(plan.planKey)), {
      version: 1,
      plan_label: PLAN_LABEL,
      source_digest: "sha256:legacy",
      stages: STAGES.map((stage) => ({ stage_id: stage.stageId, label: stage.label, title: stage.title, brief: "x" })),
    });
    assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined, "it is read for provenance on the next write, and for nothing else");
  });
});

/**
 * The provenance rule the engine depends on. It folds `source_digest` into the
 * identity of a recorded run and refuses to continue one whose identity
 * changed, so a run that started against the old unscoped file must not take a
 * fresh digest the first time it writes a scoped one — that would end a run in
 * flight, which is exactly how a submission was lost before.
 */
describe("moving a run's manifest to its scoped name", () => {
  it("carries the old file's provenance forward, through the one write helper", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function writeManifestFile\([\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.ok(body, "writeManifestFile exists");
    assert.match(body, /readOptional\(file\)/, "the scoped file is the first source of provenance");
    assert.match(body, /for \(const name of previousManifestFileNames\(owner\.runKey, owner\.location\.projectDir\)\)/, "and every name manifests were written under before is the fallback");
    assert.match(body, /carriedForward\(manifest, previous\)/, "which is then carried forward rather than re-hashed");
    assert.ok(!/fs\.writeFile\(path\.join\(directory, name\)/.test(body), "an old name is never written to again");

    // The migration lives inside the one helper, so there is no caller that
    // can write a manifest without it.
    const calls = source.match(/writeManifestFile\(controller, [^\n]*/g) ?? [];
    assert.equal(calls.length, 2, "run-plan/resume-plan and continue-automatically");
  });
});
