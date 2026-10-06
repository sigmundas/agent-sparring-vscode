/**
 * Plan intake, as the engine writes it on feature/plan-intake.
 *
 * The fixtures under `fixtures/plan-intake/` were written by the engine's own
 * prepare-plan -> approve-plan -> run-plan path (see its `generate.py`), for a
 * plan labelled Stage 0 / 1A / 1B in two run slices:
 *
 *  - `approved/`: slice `app` approved, nothing run;
 *  - `ran/`: slice `app` run to completion (`source: "intake-manifest"`),
 *    slice `web` not approved.
 *
 * What is held here: the recorded source kind is read exactly and never
 * coerced; an intake run's stages come from its approved manifest, never from
 * the strict 1..N Markdown parser; a resume uses the approved manifest; and a
 * pre-run intake replaces older finished work on screen only when it is
 * provably newer.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs } from "../core/cli";
import { discoverRuns, selectRun, type Discovery, type PlanRunSnapshot, type SparringLocation } from "../core/discovery";
import { EngineFormatError, parsePlanRunState } from "../core/engineFormats";
import { parseEngineTimestamp, resolveIntakeRun } from "../core/intake";
import { buildOverviewModel } from "../core/overviewModel";
import { deriveStatus } from "../core/status";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");
const INTAKE_ID = "plan-61bf2008-20260927T204930Z-faithful-fb55";
const RUN_KEY = "app-run-0001";
/** `created_at` of the fixture intake. */
const CREATED_AT_MS = Date.parse("2026-09-27T20:49:30.293Z");

async function copyTree(from: string, to: string, root: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await copyTree(source, target, root);
    } else {
      await fs.writeFile(target, (await fs.readFile(source, "utf8")).split("__ROOT__").join(root));
    }
  }
}

/** A project holding one fixture snapshot, at `<tmp>/app` as the engine wrote it. */
async function project(snapshot: "approved" | "ran"): Promise<{ root: string; location: SparringLocation }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-intake-")));
  const root = path.join(base, "app");
  await fs.mkdir(root, { recursive: true });
  await copyTree(path.join(FIXTURES, snapshot), root, base);
  return { root, location: { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: "app" } };
}

async function writeJson(file: string, payload: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(payload, null, 2) + "\n");
}

/** An older, finished Markdown run of another plan in the same project, written at `mtimeMs`. */
async function finishedRun(root: string, mtimeMs: number, status: "complete" | "running" = "complete"): Promise<string> {
  await fs.mkdir(path.join(root, "docs", "plans"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "plans", "v2.md"), "# Taxonomy v2\n\n## Stage 1 — Only\nWork.\n");
  const file = path.join(root, ".sparring", "plans", "v2-run.json");
  await writeJson(file, { current_stage: "v2-run-stage-1-only", current_stage_index: 0, expected_branch: "main", plan: "docs/plans/v2.md", plan_digest: "0".repeat(64), run: "v2-run", source: "markdown", status });
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function planRun(discovery: Discovery, runKey: string): PlanRunSnapshot {
  const run = discovery.runs.find((candidate): candidate is PlanRunSnapshot => candidate.kind === "plan" && candidate.runKey === runKey);
  assert.ok(run, `plan run ${runKey} discovered; problems: ${JSON.stringify(discovery.problems)}`);
  return run;
}

describe("the recorded plan input kind is read exactly", () => {
  const base = { current_stage: "s", current_stage_index: 0, expected_branch: "b", plan: "p.md", plan_digest: "0".repeat(64), status: "running" };

  it("intake-manifest is a kind of its own", () => {
    assert.equal(parsePlanRunState(JSON.stringify({ ...base, source: "intake-manifest" })).source, "intake-manifest");
    assert.equal(parsePlanRunState(JSON.stringify({ ...base, source: "manifest" })).source, "manifest");
  });

  it("absent is the engine's own legacy default, markdown", () => {
    assert.equal(parsePlanRunState(JSON.stringify(base)).source, "markdown");
  });

  it("an unknown kind is refused, never coerced to markdown", () => {
    assert.throws(() => parsePlanRunState(JSON.stringify({ ...base, source: "future-kind" })), (error: unknown) => error instanceof EngineFormatError && /unsupported plan input kind "future-kind"/.test(String(error)));
    assert.throws(() => parsePlanRunState(JSON.stringify({ ...base, source: 3 })), EngineFormatError);
  });

  it("the fixture run the engine wrote parses as intake-manifest", async () => {
    const text = await fs.readFile(path.join(FIXTURES, "ran", ".sparring", "plans", `${RUN_KEY}.json`), "utf8");
    const state = parsePlanRunState(text);
    assert.equal(state.source, "intake-manifest");
    assert.equal(state.run, RUN_KEY);
    assert.equal(state.currentStage, "app-run-0001-stage-1a-app-change");
  });

  it("an unknown kind makes the run a discovery problem rather than a Markdown run", async () => {
    const { root, location } = await project("approved");
    await writeJson(path.join(root, ".sparring", "plans", "odd.json"), { ...base, run: "odd", source: "future-kind" });
    const discovery = await discoverRuns([location]);
    assert.equal(discovery.runs.filter((run) => run.kind === "plan").length, 0);
    assert.ok(discovery.problems.some((problem) => /unsupported plan input kind/.test(problem.error)));
  });
});

describe("an intake run resumes from its approved manifest", () => {
  it("the builder passes it as --manifest with the run key", () => {
    assert.deepEqual(buildResumePlanArgs({ source: "intake-manifest", intakeManifest: "/i/runs/app/manifest.json", runKey: RUN_KEY, repoRoot: "/r", expectedBranch: "feature/widgets" }).slice(0, 3), [
      "resume-plan",
      "--manifest",
      "/i/runs/app/manifest.json",
    ]);
  });

  it("and refuses any other input for an intake run, or an intake manifest for another kind", () => {
    assert.throws(() => buildResumePlanArgs({ source: "intake-manifest", planPath: "docs/plan.md", repoRoot: "/r", expectedBranch: "b" }), /intake-manifest plan input; refusing to build a resume from a markdown one/);
    assert.throws(() => buildResumePlanArgs({ source: "intake-manifest", manifest: "/tmp/x.manifest.json", repoRoot: "/r", expectedBranch: "b" }), /refusing to build a resume from a manifest one/);
    assert.throws(() => buildResumePlanArgs({ source: "manifest", intakeManifest: "/i/runs/app/manifest.json", repoRoot: "/r", expectedBranch: "b" }), /refusing to build a resume from a intake-manifest one/);
  });

  it("planInvocationFor answers intake-manifest from discovery, without building or writing a manifest", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function planInvocationFor[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    const branch = /if \(source === "intake-manifest"\) \{[\s\S]*?\n {2}\}\n/.exec(body)?.[0] ?? "";
    assert.ok(branch, "an explicit intake-manifest branch");
    assert.match(branch, /intakeManifest: run\.intake\.manifestPath, source: "intake-manifest"/);
    assert.ok(!/buildManifest|writeManifestFile|planPath/.test(branch), "never rebuilt, never written, never the Markdown");
  });
});

describe("an intake run is displayed from its approved manifest", () => {
  it("resolves the sealed manifest through the registry and the approval", async () => {
    const { root, location } = await project("ran");
    const binding = await resolveIntakeRun(location.sparringDir, RUN_KEY);
    assert.equal(binding.manifestPath, path.join(root, ".sparring", "intake", INTAKE_ID, "runs", "app", "manifest.json"));
    assert.equal(binding.runId, "app");
    assert.equal(binding.sourcePath, path.join(root, "docs", "plan.md"));
    assert.deepEqual(binding.stages.map((stage) => stage.label), ["Stage 0", "Stage 1A"]);
  });

  it("stage ids, labels, titles, count and current stage come from the manifest", async () => {
    const { root, location } = await project("ran");
    const run = planRun(await discoverRuns([location]), RUN_KEY);
    assert.equal(run.state.source, "intake-manifest");
    assert.equal(run.planError, undefined);
    assert.deepEqual(
      run.planStages?.map((stage) => [stage.number, stage.label, stage.title, stage.stageId]),
      [
        [1, "Stage 0", "Audit", "app-run-0001-stage-0-audit"],
        [2, "Stage 1A", "App change", "app-run-0001-stage-1a-app-change"],
      ],
    );
    assert.equal(run.currentStage.stageId, "app-run-0001-stage-1a-app-change");
    assert.equal(run.currentStage.title, "App change");
    // The source Markdown is the readable plan, not the run's input.
    assert.equal(run.planPath, path.join(root, "docs", "plan.md"));
    assert.equal(run.intake?.manifestPath, path.join(root, ".sparring", "intake", INTAKE_ID, "runs", "app", "manifest.json"));
  });

  it("a Stage 0 / 1A / 1B source plan is never read with the 1..N parser for such a run", async () => {
    const { root, location } = await project("ran");
    // Make the Markdown unreadable as a 1..N plan in a way that would change
    // the stage list if it were consulted.
    await fs.writeFile(path.join(root, "docs", "plan.md"), "# Widget overhaul\n\n## Stage 1 — Something else\n");
    const run = planRun(await discoverRuns([location]), RUN_KEY);
    assert.deepEqual(run.planStages?.map((stage) => stage.stageId), ["app-run-0001-stage-0-audit", "app-run-0001-stage-1a-app-change"]);
  });

  it("without its approved manifest the run keeps its recorded stage and says why", async () => {
    const { root, location } = await project("ran");
    await fs.rm(path.join(root, ".sparring", "intake", "registry"), { recursive: true });
    const run = planRun(await discoverRuns([location]), RUN_KEY);
    assert.equal(run.planStages, undefined);
    assert.equal(run.intake, undefined);
    assert.match(run.planError ?? "", /intake registry entry/);
    assert.equal(run.currentStage.stageId, "app-run-0001-stage-1a-app-change");
  });

  it("the Overview names the stage and draws the journey by the manifest's labels", async () => {
    const { location } = await project("ran");
    const run = planRun(await discoverRuns([location]), RUN_KEY);
    const manifestStages = (run.intake?.stages ?? []).map((stage) => ({ ...stage, status: undefined }));
    const model = buildOverviewModel({ selected: run, ambiguous: [] }, undefined, { handoff: false, sparring: false, brief: false, plan: false, manifestStages });
    assert.equal(model.stageHeading, "Stage 1A — App change");
    assert.equal(model.position, "Stage 2 of 2");
    assert.deepEqual(model.timeline?.map((item) => item.label), ["0", "1A"]);
  });

  it("an envelope for another run is not adopted", async () => {
    const { root, location } = await project("ran");
    const manifest = path.join(root, ".sparring", "intake", INTAKE_ID, "runs", "app", "manifest.json");
    const payload = JSON.parse(await fs.readFile(manifest, "utf8"));
    await writeJson(manifest, { ...payload, run_key: "someone-else" });
    await assert.rejects(resolveIntakeRun(location.sparringDir, RUN_KEY), /not this run/);
  });
});

describe("pre-run intake state", () => {
  it("approved: slice app has a sealed approval and no run", async () => {
    const { location } = await project("approved");
    const discovery = await discoverRuns([location]);
    assert.equal(discovery.runs.length, 0);
    const [intake] = discovery.intakes ?? [];
    assert.equal(intake.state, "approved");
    assert.deepEqual(intake.slices.map((slice) => [slice.runId, slice.state]), [["app", "approved"], ["web", "prepared"]]);
    assert.deepEqual(intake.slices[0].stages.map((stage) => stage.label), ["Stage 0", "Stage 1A"]);
    assert.deepEqual(intake.slices[1].stages.map((stage) => stage.label), ["Stage 1B"]);
    assert.equal(intake.record.createdAtMs, CREATED_AT_MS);
  });

  it("prepared: an approval the engine would refuse is not an approval", async () => {
    const { root, location } = await project("approved");
    const approval = path.join(root, ".sparring", "intake", INTAKE_ID, "runs", "app", "approval.json");
    await writeJson(approval, { ...JSON.parse(await fs.readFile(approval, "utf8")), version: 1 });
    const [intake] = (await discoverRuns([location])).intakes ?? [];
    assert.equal(intake.state, "prepared");
  });

  it("once a slice has a run, the run is the authority: complete slice, next slice prepared", async () => {
    const { location } = await project("ran");
    const [intake] = (await discoverRuns([location])).intakes ?? [];
    assert.deepEqual(intake.slices.map((slice) => [slice.runId, slice.state]), [["app", "complete"], ["web", "prepared"]]);
    assert.equal(intake.state, "prepared");
  });

  it("running while the slice's run is open, complete when every slice's run is", async () => {
    const { root, location } = await project("ran");
    const state = path.join(root, ".sparring", "plans", `${RUN_KEY}.json`);
    const payload = JSON.parse(await fs.readFile(state, "utf8"));
    await writeJson(state, { ...payload, status: "paused" });
    assert.equal((await discoverRuns([location])).intakes?.[0].state, "running");
    await writeJson(state, { ...payload, status: "complete" });
    await writeJson(path.join(root, ".sparring", "plans", "web-run-0002.json"), { ...payload, run: "web-run-0002", current_stage: "web-run-0002-stage-1b-web-repair", current_stage_index: 0, status: "complete" });
    assert.equal((await discoverRuns([location])).intakes?.[0].state, "complete");
  });

  it("a slice run from another project, which this window has not opened, is not shown as approved", async () => {
    const { root, location } = await project("approved");
    const other = path.join(path.dirname(root), "web", ".sparring");
    const approvalFile = path.join(root, ".sparring", "intake", INTAKE_ID, "runs", "app", "approval.json");
    await writeJson(approvalFile, { ...JSON.parse(await fs.readFile(approvalFile, "utf8")), sparring_dir: other });
    await writeJson(path.join(other, "plans", `${RUN_KEY}.json`), { current_stage: "app-run-0001-stage-0-audit", current_stage_index: 0, expected_branch: "feature/widgets", plan: "docs/plan.md", plan_digest: "0".repeat(64), run: RUN_KEY, source: "intake-manifest", status: "complete" });
    const discovery = await discoverRuns([location]);
    const [intake] = discovery.intakes ?? [];
    assert.deepEqual(intake.slices.map((slice) => [slice.runId, slice.state]), [["app", "complete"], ["web", "prepared"]]);
  });

  it("a run state file that cannot be read still counts as a run of its slice", async () => {
    const { root, location } = await project("approved");
    await writeJson(path.join(root, ".sparring", "plans", `${RUN_KEY}.json`), { run: RUN_KEY, source: "future-kind", status: "running", current_stage: "x", current_stage_index: 0, expected_branch: "b", plan: "p", plan_digest: "0" });
    const discovery = await discoverRuns([location]);
    assert.ok(discovery.problems.length > 0);
    const [intake] = discovery.intakes ?? [];
    assert.equal(intake.slices[0].state, "running");
    assert.equal(intake.state, "running");
    assert.equal(selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes).intake, undefined);
  });

  it("engine timestamps are read only with an explicit offset", () => {
    assert.equal(parseEngineTimestamp("2026-09-27T20:49:30.293065+00:00"), CREATED_AT_MS);
    assert.equal(parseEngineTimestamp("2026-09-27T20:49:30"), undefined, "no offset: local time would be a guess");
    assert.equal(parseEngineTimestamp("yesterday"), undefined);
    assert.equal(parseEngineTimestamp(undefined), undefined);
  });

  it("a legacy intake (no completion_marker key) is usable, exactly as before", async () => {
    const { location } = await project("approved");
    const [intake] = (await discoverRuns([location])).intakes ?? [];
    assert.equal(intake.record.completionMarker, undefined);
    assert.equal(intake.usable, true);
  });

  it("a completion_marker naming a file that does not exist yet makes the intake unusable", async () => {
    const { root, location } = await project("approved");
    const recordPath = path.join(root, ".sparring", "intake", INTAKE_ID, "intake.json");
    await writeJson(recordPath, { ...JSON.parse(await fs.readFile(recordPath, "utf8")), completion_marker: "prepared.json" });
    const [intake] = (await discoverRuns([location])).intakes ?? [];
    assert.equal(intake.record.completionMarker, "prepared.json");
    assert.equal(intake.usable, false, "prepare-plan has not written prepared.json as its last write yet");
  });

  it("once that marker file exists, the same intake is usable", async () => {
    const { root, location } = await project("approved");
    const intakeDir = path.join(root, ".sparring", "intake", INTAKE_ID);
    const recordPath = path.join(intakeDir, "intake.json");
    await writeJson(recordPath, { ...JSON.parse(await fs.readFile(recordPath, "utf8")), completion_marker: "prepared.json" });
    await writeJson(path.join(intakeDir, "prepared.json"), { intake_id: INTAKE_ID, prepared_at: "2026-09-27T20:49:30.293065+00:00", verdict: "executable_with_recommendations" });
    const [intake] = (await discoverRuns([location])).intakes ?? [];
    assert.equal(intake.usable, true);
  });
});

describe("selection: a newer pre-run intake replaces older finished work", () => {
  const scope = (root: string) => ({ repoRoot: root });

  it("an intake newer than the last finished run is shown instead of it", async () => {
    const { root, location } = await project("approved");
    await finishedRun(root, CREATED_AT_MS - 60_000);
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, scope(root), undefined, [location], discovery.intakes);
    assert.equal(selection.selected, undefined);
    assert.equal(selection.intake?.record.intakeId, INTAKE_ID);
  });

  it("the remembered finished run does not hold the screen against a newer intake", async () => {
    const { root, location } = await project("approved");
    await finishedRun(root, CREATED_AT_MS - 60_000);
    const discovery = await discoverRuns([location]);
    const sticky = discovery.runs[0].id;
    const selection = selectRun(discovery.runs, undefined, sticky, scope(root), undefined, [location], discovery.intakes);
    assert.equal(selection.intake?.record.intakeId, INTAKE_ID);
  });

  it("an intake older than the last finished run is not promoted, and stays discoverable", async () => {
    const { root, location } = await project("approved");
    await finishedRun(root, CREATED_AT_MS + 60_000);
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, scope(root), undefined, [location], discovery.intakes);
    assert.equal(selection.intake, undefined);
    assert.equal(selection.selected?.kind, "plan");
    assert.equal(discovery.intakes?.length, 1);
  });

  it("an intake whose created_at is missing or invalid is never assumed newer", async () => {
    for (const createdAt of [undefined, "not a time", "2026-09-27T20:49:30"]) {
      const { root, location } = await project("approved");
      const record = path.join(root, ".sparring", "intake", INTAKE_ID, "intake.json");
      const payload = JSON.parse(await fs.readFile(record, "utf8"));
      if (createdAt === undefined) {
        delete payload.created_at;
      } else {
        payload.created_at = createdAt;
      }
      await writeJson(record, payload);
      await finishedRun(root, 0);
      const discovery = await discoverRuns([location]);
      const selection = selectRun(discovery.runs, undefined, undefined, scope(root), undefined, [location], discovery.intakes);
      assert.equal(selection.intake, undefined, `created_at ${String(createdAt)}`);
      assert.equal(selection.selected?.kind, "plan");
      assert.equal(discovery.intakes?.length, 1, "still discovered");
    }
  });

  it("of two intakes of one plan, only the newer is considered; an unreadable age makes the plan's intakes unorderable", async () => {
    const { root, location } = await project("approved");
    const intakeRoot = path.join(root, ".sparring", "intake");
    const record = JSON.parse(await fs.readFile(path.join(intakeRoot, INTAKE_ID, "intake.json"), "utf8"));
    // A later prepare of the same plan whose one slice already ran to completion.
    const newer = "plan-61bf2008-20260928T080000Z-faithful-abcd";
    await writeJson(path.join(intakeRoot, newer, "intake.json"), { ...record, intake_id: newer, created_at: "2026-09-28T08:00:00+00:00", run_keys: { app: "app-run-0009" } });
    await writeJson(path.join(root, ".sparring", "plans", "app-run-0009.json"), { current_stage: "s", current_stage_index: 0, expected_branch: "feature/widgets", plan: "docs/plan.md", plan_digest: "0".repeat(64), run: "app-run-0009", source: "markdown", status: "complete" });
    await fs.utimes(path.join(root, ".sparring", "plans", "app-run-0009.json"), new Date(CREATED_AT_MS - 1), new Date(CREATED_AT_MS - 1));
    let discovery = await discoverRuns([location]);
    assert.equal(selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes).intake, undefined, "the older approved intake was replaced");

    await writeJson(path.join(intakeRoot, newer, "intake.json"), { ...record, intake_id: newer, created_at: "no time", run_keys: { app: "app-run-0009" } });
    discovery = await discoverRuns([location]);
    assert.equal(selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes).intake, undefined, "which intake is newest cannot be known");
  });

  it("a slice approved after an earlier slice finished is newer than that run", async () => {
    const { root, location } = await project("ran");
    const runState = path.join(root, ".sparring", "plans", `${RUN_KEY}.json`);
    await fs.utimes(runState, new Date(CREATED_AT_MS + 60_000), new Date(CREATED_AT_MS + 60_000));
    const intakeDir = path.join(root, ".sparring", "intake", INTAKE_ID);
    let discovery = await discoverRuns([location]);
    assert.equal(selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes).intake, undefined, "prepared before the run finished: not promoted");
    const appApproval = JSON.parse(await fs.readFile(path.join(intakeDir, "runs", "app", "approval.json"), "utf8"));
    await writeJson(path.join(intakeDir, "runs", "web", "approval.json"), { ...appApproval, run_id: "web", run_key: "web-run-0002", approved_at: new Date(CREATED_AT_MS + 120_000).toISOString().replace("Z", "+00:00") });
    discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes);
    assert.equal(selection.intake?.state, "approved");
  });

  it("with nothing finished at all, a pre-run intake is shown", async () => {
    const { root, location } = await project("approved");
    const discovery = await discoverRuns([location]);
    assert.equal(selectRun(discovery.runs, undefined, undefined, scope(root), undefined, [location], discovery.intakes).intake?.record.intakeId, INTAKE_ID);
  });

  it("an explicit pin on a finished run wins", async () => {
    const { root, location } = await project("approved");
    await finishedRun(root, CREATED_AT_MS - 60_000);
    const discovery = await discoverRuns([location]);
    const pinned = discovery.runs[0];
    const selection = selectRun(discovery.runs, { id: pinned.id, intent: "inspect" }, undefined, scope(root), undefined, [location], discovery.intakes);
    assert.equal(selection.selected?.id, pinned.id);
    assert.equal(selection.pinned, true);
    assert.equal(selection.intake, undefined);
  });

  it("an open managed run wins", async () => {
    const { root, location } = await project("approved");
    await finishedRun(root, CREATED_AT_MS - 60_000, "running");
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, scope(root), undefined, [location], discovery.intakes);
    assert.equal(selection.selected?.kind, "plan");
    assert.equal(selection.intake, undefined);
  });

  it("an intake with a running slice is not shown; its run is", async () => {
    const { root, location } = await project("ran");
    const state = path.join(root, ".sparring", "plans", `${RUN_KEY}.json`);
    await writeJson(state, { ...JSON.parse(await fs.readFile(state, "utf8")), status: "paused" });
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, scope(root), undefined, [location], discovery.intakes);
    assert.equal(selection.intake, undefined);
    assert.equal((selection.selected as PlanRunSnapshot | undefined)?.runKey, RUN_KEY);
  });

  it("an intake in another repository is not promoted into this one", async () => {
    const { location } = await project("approved");
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-other-")));
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, { repoRoot: other, knownRoots: [location.repoRoot] }, undefined, [location], discovery.intakes);
    assert.equal(selection.intake, undefined);
  });
});

describe("the intake screen and status bar", () => {
  it("names the plan, the state and the stages, and offers Start for the exact approved slice", async () => {
    const { root, location } = await project("approved");
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes);
    const planText = await fs.readFile(path.join(root, "docs", "plan.md"), "utf8");
    const model = buildOverviewModel(selection, undefined, { handoff: false, sparring: false, brief: false, plan: true, planText });
    assert.equal(model.kind, "intake");
    assert.equal(model.intake?.planName, "Widget overhaul");
    assert.equal(model.intake?.stateLabel, "Approved — ready to start");
    assert.deepEqual(model.intake?.slices.map((slice) => [slice.runId, slice.heading, slice.current, slice.stages]), [
      ["app", "Execution group — Stages 0 + 1A", true, ["Stage 0 — Audit", "Stage 1A — App change"]],
      ["web", "Stage 1B — Web repair", false, []],
    ]);
    assert.deepEqual(model.intake?.slices[1].technical && { ...model.intake.slices[1].technical }, { runId: "web", runKey: "web-run-0002", repository: "web" }, "the engine's identifiers stay available");
    assert.deepEqual(model.intake?.action && { kind: model.intake.action.kind, label: model.intake.action.label, runId: model.intake.action.runId, intakeDir: model.intake.action.intakeDir }, {
      kind: "start",
      label: "Start Stages 0 + 1A",
      runId: "app",
      intakeDir: path.join(root, ".sparring", "intake", INTAKE_ID),
    });

    const status = deriveStatus(selection, undefined, Date.now());
    assert.match(status.text, /plan\.md · approved, ready to start/);
  });

  it("a partly run intake offers Approve for the next slice and never says nothing has run", async () => {
    const { location } = await project("ran");
    const discovery = await discoverRuns([location]);
    const intake = discovery.intakes?.[0];
    assert.ok(intake);
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined);
    assert.equal(model.intake?.stateLabel, "Prepared — 0 blocking findings, 0 recommendations");
    assert.equal(model.intake?.action?.kind, "approve");
    assert.equal(model.intake?.action?.runId, "web");
    const text = model.intake?.lines.join("\n") ?? "";
    assert.match(text, /Stage 1B is next and has not been approved/);
    assert.match(text, /Stages 0 \+ 1A are complete/);
    assert.ok(!/no stage of it has run|Nothing has run/i.test(text), text);
    assert.ok(!/run slice/i.test(text), "the engine's noun is not the Overview's");
    assert.deepEqual(model.intake?.slices.map((slice) => slice.stateLabel), ["Complete", "Ready for approval"]);
    assert.equal(model.intake?.action?.label, "Approve Stage 1B");
    assert.ok(!/ready to run|will run/i.test(text), text);
  });

  it("an untouched intake says no slice has run and promises no approval", async () => {
    const { root, location } = await project("approved");
    await fs.rm(path.join(root, ".sparring", "intake", INTAKE_ID, "runs"), { recursive: true });
    const intake = (await discoverRuns([location])).intakes?.[0];
    assert.ok(intake);
    const text = buildOverviewModel({ ambiguous: [], intake }, undefined).intake?.lines.join("\n") ?? "";
    assert.match(text, /no stage of it has run/);
    assert.ok(!/then approve/.test(text), "whether it can be approved is the engine's decision");
  });

  it("Continue automatically does not need the source Markdown of an intake run", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    assert.match(source, /const markdown = \(await readOptional\(planPath\)\) \?\? \(intakeRun \? "" : undefined\);/);
  });

  it("the controller watches the intake files, and nothing else under intake/", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
    for (const glob of ["**/.sparring/intake/*/intake.json", "**/.sparring/intake/*/runs/*/approval.json", "**/.sparring/intake/registry/*.json"]) {
      assert.ok(source.includes(`"${glob}"`), glob);
    }
    assert.ok(source.includes("this.allLocations(), selectableIntakes);"), "and hands the intakes to selection");
  });
});
