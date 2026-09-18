/**
 * The authority boundary around an execution manifest.
 *
 * A manifest in the extension's global storage is **candidate evidence**. The
 * authority is the run's own recorded state — the plan label, the executable
 * digest the engine wrote as `plan_digest` — together with the worktree the
 * manifest states it was written for. If any of that is missing or uncertain,
 * the extension degrades to ordinary standalone presentation and claims no
 * historical ownership at all.
 *
 * Three reproductions are pinned here:
 *
 *  1. a regenerated manifest that keeps the plan label and the current stage
 *     but executes something else must supply no membership (see also the
 *     digest suite in manifest.test.ts);
 *  2. a cached manifest must be re-bound against the run's *current* state, in
 *     both directions, without the file being rewritten;
 *  3. one worktree's manifest must never establish membership for another,
 *     including when they are forced to share a file name.
 *
 * These run against the real reader (`ManifestReader`) and real files, not a
 * stand-in, because what is being tested is precisely the composition of the
 * cache with the binding.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, type PlanRunSnapshot, type StandaloneStageSnapshot } from "../core/discovery";
import { manifestFileName, parseExecutionManifest, type ManifestStageIdentity } from "../core/manifest";
import { ManifestReader } from "../vscode/manifestReader";
import { ManifestStore, Workspace, membershipsOf, recordPlanDigest } from "./fixtures";

const PLAN_KEY = "same-plan-7ea7171f";
const PLAN_LABEL = "docs/plans/active/same-plan.md";
const STAGE_3D = "stage-3d-transport";
const STAGE_4 = "stage-4-editor";

const PLAN = ["# Same plan", "", "## Stage 3D handoff — 2026-09-14 (accepted)", "", "Accepted.", "", "## Stage 3D — Transport", "", "The transport.", "", "## Stage 4 — Editor", "", "The editor.", ""].join("\n");

const STAGES: ManifestStageIdentity[] = [
  { stageId: STAGE_3D, label: "Stage 3D", title: "Transport" },
  { stageId: STAGE_4, label: "Stage 4", title: "Editor" },
];

/** A worktree with a finished plan run: Stage 3D rediscovered on its own, Stage 4 the recorded current stage. */
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

/**
 * The reviewer's first reproduction, end to end: a completed run records the
 * digest of the manifest it executed, and a later manifest that keeps
 * everything the old validation looked at supplies nothing.
 */
describe("a regenerated manifest cannot redefine a completed run's history", () => {
  it("refuses M2: same plan label, same current stage, one stage that never ran", async () => {
    const { runs, plan, historical } = await worktree("alpha");
    const store = await ManifestStore.create();

    // M1 is what the run executed; the engine recorded its digest as D.
    await store.write(plan, STAGES);
    const D = plan.state.planDigest;
    assert.match(D, /^[0-9a-f]{64}$/);
    assert.equal((await membershipsOf(runs, store)).get(historical.id)?.planRunId, plan.id, "M1 binds");

    // M2 overwrites it behind the run's back: the plan label is untouched, the
    // recorded current stage is still there, and one never-executed stage has
    // been appended.
    await store.write(plan, [...STAGES, { stageId: "stage-5-never-ran", label: "Stage 5", title: "Never ran" }], { bind: false });
    assert.equal(plan.state.planDigest, D, "the run still records the digest of what it actually executed");

    assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined, "M2 must not supply membership");
  });

  it("refuses a manifest whose historical stage was retitled or rebriefed under it", async () => {
    for (const changed of [
      [{ stageId: STAGE_3D, label: "Stage 3D", title: "Transport, revised" }, STAGES[1]],
      [{ stageId: STAGE_3D, label: "Stage 3E", title: "Transport" }, STAGES[1]],
    ] as ManifestStageIdentity[][]) {
      const { runs, plan, historical } = await worktree("alpha");
      const store = await ManifestStore.create();
      await store.write(plan, STAGES);
      await store.write(plan, changed, { bind: false });
      assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined, `refused: ${changed[0].title} / ${changed[0].label}`);
    }
  });
});

/**
 * The reviewer's second reproduction. The cache used to key on the manifest
 * file's path and modification time alone, so the *conclusion* that a manifest
 * belonged to a run outlived the run state that justified it. Both directions
 * are asserted, and neither touches the manifest file.
 */
describe("the cache holds parsed bytes, never the conclusion that they are this run's", () => {
  /** The manifest file as it was, so a test can prove it was not rewritten. */
  async function identityOf(file: string) {
    const stat = await fs.stat(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size, text: await fs.readFile(file, "utf8") };
  }

  it("a manifest accepted once is refused as soon as the run's recorded state moves away from it", async () => {
    const { plan } = await worktree("alpha", "running");
    const store = await ManifestStore.create();
    const file = await store.write(plan, STAGES);
    const reader = new ManifestReader();

    assert.ok((await reader.read(store.dir, plan)).ok, "bound, and now cached");
    const before = await identityOf(file);

    // The engine restarted this run against a different manifest and recorded
    // a different identity for it. Nothing on disk in global storage changed.
    await recordPlanDigest(plan, "f".repeat(64));

    const bound = await reader.read(store.dir, plan);
    assert.equal(bound.ok, false, "the cached parse is re-bound, and no longer binds");
    assert.equal(bound.ok === false && bound.reason, "plan-digest");
    assert.deepEqual(await identityOf(file), before, "and the file was neither rewritten nor touched");
  });

  it("a manifest refused once is accepted as soon as the run's recorded state makes it this run's", async () => {
    const { plan } = await worktree("alpha", "running");
    const store = await ManifestStore.create();
    // Written, but the run records some other identity — the ordinary shape of
    // a manifest rebuilt before the engine has recorded anything for it.
    const file = await store.write(plan, STAGES, { bind: false });
    const reader = new ManifestReader();

    const first = await reader.read(store.dir, plan);
    assert.equal(first.ok, false, "refused, and now cached as refused parse would once have been");
    const before = await identityOf(file);

    const digest = parseExecutionManifest(before.text)?.digest;
    assert.ok(digest);
    await recordPlanDigest(plan, digest);

    assert.ok((await reader.read(store.dir, plan)).ok, "the very same bytes bind now");
    assert.deepEqual(await identityOf(file), before, "without the file being touched to say so");
  });

  it("re-reads a manifest whose bytes changed under an unchanged run", async () => {
    const { plan } = await worktree("alpha", "running");
    const store = await ManifestStore.create();
    await store.write(plan, STAGES);
    const reader = new ManifestReader();
    assert.ok((await reader.read(store.dir, plan)).ok);

    // Same length is the case a size check alone would miss; the modification
    // time moves, which is what the cache keys on.
    await store.write(plan, [STAGES[1], STAGES[0]], { bind: false });
    assert.equal((await reader.read(store.dir, plan)).ok, false, "the reordered file is a different execution");
  });
});

/**
 * The reviewer's third reproduction. Two worktrees of one repository running
 * the same plan path record identical state and build byte-identical
 * manifests. Neither the recorded state nor the executable digest can tell
 * them apart, and a file name never could — so ownership is proven by the
 * sidecar binding record, and the collision is forced here rather than merely
 * assumed away by a longer hash.
 */
describe("one worktree's manifest never becomes another's", () => {
  it("keeps two worktrees of the same plan separate", async () => {
    const a = await worktree("sparring-worktree-33503");
    const b = await worktree("sparring-worktree-75970");
    const store = await ManifestStore.create();

    assert.equal(a.plan.planKey, b.plan.planKey, "the plan key is a hash of the repo-relative path, so it is shared");
    assert.notEqual(store.fileFor(a.plan), store.fileFor(b.plan), "but the files are not");

    await store.write(a.plan, STAGES);
    assert.equal((await membershipsOf(a.runs, store)).get(a.historical.id)?.planRunId, a.plan.id);
    assert.equal((await membershipsOf(b.runs, store)).get(b.historical.id), undefined, "B consumes nothing of A's");
  });

  it("refuses B's manifest at A's own path: a forced file-name collision", async () => {
    const a = await worktree("sparring-worktree-33503");
    const b = await worktree("sparring-worktree-75970");
    const store = await ManifestStore.create();

    // A is fully bound: its manifest is on disk and the engine recorded its
    // digest.
    await store.write(a.plan, STAGES);
    assert.equal((await membershipsOf(a.runs, store)).get(a.historical.id)?.planRunId, a.plan.id);
    const written = await fs.readFile(store.fileFor(a.plan), "utf8");

    // Now B writes *its* manifest and binding record at exactly the paths A
    // reads — the collision the 8-hex project scope produced for real. The
    // content is byte-identical (same plan, same stages), so A's plan label,
    // A's recorded digest and A's current stage all still match. The only
    // difference left is which worktree the record names.
    await store.write(b.plan, STAGES, { at: a.plan, bind: false });
    assert.equal(await fs.readFile(store.fileFor(a.plan), "utf8"), written, "the manifests really are indistinguishable");
    const bound = await new ManifestReader().read(store.dir, a.plan);
    assert.equal(bound.ok, false, "B's manifest must never establish membership for A");
    assert.equal(bound.ok === false && bound.reason, "unbound-worktree");
    assert.equal((await membershipsOf(a.runs, store)).get(a.historical.id), undefined, "and A degrades to no membership, not to a guess");
  });

  it("refuses a manifest that vouches for a worktree it was not written for", async () => {
    const { runs, plan, historical } = await worktree("alpha");
    const store = await ManifestStore.create();
    await store.write(plan, STAGES, { projectDir: path.join(os.tmpdir(), "somewhere-else") });
    assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined);
  });

  it("refuses a manifest with no binding record at all", async () => {
    const { runs, plan, historical } = await worktree("alpha");
    const store = await ManifestStore.create();
    await store.write(plan, STAGES);
    assert.equal((await membershipsOf(runs, store)).get(historical.id)?.planRunId, plan.id, "bound while the record is there");

    await fs.rm(store.bindingFor(plan));
    assert.equal((await membershipsOf(runs, store)).get(historical.id), undefined, "and unbound the moment nothing says whose it is");
  });

  it("does not let a file name carry the argument: the 8-hex scope that collided is gone", async () => {
    // Both directories hashed to `same-plan-7ea7171f` under the old scope.
    assert.notEqual(manifestFileName(PLAN_KEY, "/tmp/sparring-worktree-33503"), manifestFileName(PLAN_KEY, "/tmp/sparring-worktree-75970"));
  });
});
