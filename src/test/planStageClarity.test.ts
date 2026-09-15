/**
 * Plan run, historical stage, plan document: three things that must never be
 * mistaken for each other.
 *
 * The reported sequence. The managed run of "Reported statistics and explicit
 * range semantics" had completed every stage, and the Overview was showing
 * *historical Stage 3D* instead — a screen close enough to the plan-run screen
 * that the timeline looked as if it had vanished. It read "Standalone stage",
 * offered "Continue plan automatically" (which would have started a second
 * managed run over finished work) and offered "Open in plan", which opened the
 * Markdown document rather than the run the label sounded like. Getting the
 * 1 → 2 → 3A → … → 5 timeline back meant opening Select Repository / Run — a
 * single dense list mixing the one managed run with every stage it had ever
 * run — and picking the first row. (The fixture below condenses that plan to
 * three stages; nothing here depends on how many there are.)
 *
 * The cause is mechanical and is documented in planMembership.ts: the
 * engine-shaped plan parser refuses a document carrying `## Stage 3D handoff —
 * …` records, so the plan run claims only its *current* stage and every other
 * stage of the same plan is rediscovered as standalone. The association that
 * fixes it is the execution manifest the extension wrote for that run.
 *
 * Nothing here changes the engine or what it executes; every assertion is
 * about what the extension shows and what selecting a row does.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { diagnoseDiscovery } from "../core/diagnose";
import { discoverRuns, selectRun, type PlanRunSnapshot, type RunSnapshot, type StandaloneStageSnapshot } from "../core/discovery";
import type { ManifestStageIdentity } from "../core/manifest";
import { isActionMessage, renderOverviewHtml } from "../core/overviewHtml";
import { RUN_KIND, buildOverviewModel, type ManagedPlanRun, type ManifestStageView, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { planMemberships, planRunDisplayName, type PlanRunMembers } from "../core/planMembership";
import { PLAN_RUNS_GROUP, STANDALONE_STAGES_GROUP, buildRunPickGroups } from "../core/runPick";
import { Workspace } from "./fixtures";
import { elementFrom, runWebviewScript } from "./webviewShim";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_TITLE = "Reported statistics and explicit range semantics";
const STAGE_3D = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const STAGE_4 = "stage-4-editor-and-ui-inspection-and-guarded-editing";
const STAGE_5 = "stage-5-independent-final-review";

/** The plan as the real one is written: handoff records above the stage definitions. */
const PLAN = [
  `# ${PLAN_TITLE}`,
  "",
  "The executable stage definitions are the `## Stage <label> — …` sections below.",
  "",
  "## Stage 3D handoff — 2026-09-14 (accepted)",
  "",
  "Status: Stage 3D implemented, reviewed and accepted.",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "The transport.",
  "",
  "## Stage 4 — Editor and UI inspection and guarded editing",
  "",
  "The editor.",
  "",
  "## Stage 5 — Independent final review of the whole range surface",
  "",
  "The review.",
  "",
].join("\n");

/** The manifest the extension wrote for this run, as it reads it back. */
const MANIFEST: ManifestStageIdentity[] = [
  { stageId: STAGE_3D, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport" },
  { stageId: STAGE_4, label: "Stage 4", title: "Editor and UI inspection and guarded editing" },
  { stageId: STAGE_5, label: "Stage 5", title: "Independent final review of the whole range surface" },
];

const MANIFEST_VIEW: ManifestStageView[] = MANIFEST.map((stage) => ({ ...stage, status: "accepted" }));

interface Project {
  runs: RunSnapshot[];
  plan: PlanRunSnapshot;
  members: PlanRunMembers[];
  /** Stage 3D, rediscovered on its own because the plan run names no stage list. */
  historical: StandaloneStageSnapshot;
}

/**
 * The project after the managed run finished. `status` is the recorded status
 * of the plan run; `manifest` false is the case where the manifest cannot be
 * read (another machine, cleared global storage).
 */
async function project(status: "running" | "complete" = "complete", manifest = true): Promise<Project> {
  const ws = await Workspace.create();
  await ws.writePlan(PLAN_LABEL, PLAN);
  await ws.writeStage(STAGE_3D, { status: "accepted", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) });
  await ws.writeStage(STAGE_4, { status: "accepted", base_sha: "c".repeat(40), candidate_sha: "d".repeat(40) });
  await ws.writeStage(STAGE_5, { status: "accepted", base_sha: "d".repeat(40), candidate_sha: "e".repeat(40) });
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status, current_stage: STAGE_5, current_stage_index: 2, source: "manifest" });
  const runs = (await discoverRuns([ws.location])).runs;
  const plan = runs.find((run): run is PlanRunSnapshot => run.kind === "plan");
  const historical = runs.find((run): run is StandaloneStageSnapshot => run.kind === "stage" && run.stage.stageId === STAGE_3D);
  assert.ok(plan && historical, "the plan run, and Stage 3D rediscovered on its own");
  return { runs, plan, historical, members: [{ run: plan, manifestStages: manifest ? MANIFEST : undefined }] };
}

/** The Overview for one run, with the managed-run association the panel would have resolved. */
function overview(runs: RunSnapshot[], run: RunSnapshot, members: PlanRunMembers[], extra: Partial<OverviewArtifacts> = {}): { model: OverviewModel; html: string } {
  const membership = planMemberships(runs, members).get(run.id);
  const owner = members.find((candidate) => candidate.run.id === membership?.planRunId);
  const managedPlanRun: ManagedPlanRun | undefined =
    membership && owner
      ? {
          runId: membership.planRunId,
          planName: membership.planName,
          stageId: membership.currentStageId,
          stageLabel: membership.currentStageLabel,
          status: membership.planStatus,
          memberLabel: membership.stageLabel,
          memberTitle: membership.stageTitle,
        }
      : undefined;
  const model = buildOverviewModel({ selected: run, ambiguous: [] }, undefined, {
    handoff: false,
    sparring: false,
    brief: false,
    plan: run.kind === "plan",
    planText: run.kind === "plan" ? PLAN : undefined,
    manifestStages: run.kind === "plan" ? MANIFEST_VIEW : undefined,
    // The reported screen had the plan document linked to the stage, which is
    // what gave it a plan context — and therefore the offer to adopt.
    associatedPlan: run.kind === "stage" ? { path: PLAN_LABEL, exists: true, text: PLAN } : undefined,
    managedPlanRun,
    existingStageIds: [STAGE_3D, STAGE_4, STAGE_5],
    ...extra,
  });
  return { model, html: renderOverviewHtml(model, "n", "c") };
}

// ---------------------------------------------------------------- the run picker

describe("Select Repository / Run separates the job from its history", () => {
  it("puts plan runs in their own group, first, and standalone stages in a second one", async () => {
    const { runs, plan, members } = await project();
    const memberships = planMemberships(runs, members);
    const groups = buildRunPickGroups(runs, { selectedId: plan.id, memberships });

    assert.deepEqual(
      groups.map((group) => group.title),
      [PLAN_RUNS_GROUP, STANDALONE_STAGES_GROUP],
      "two groups, the whole job first",
    );
    assert.deepEqual(
      groups[0].items.map((item) => item.run.kind),
      ["plan"],
      "the managed run is the only row of the first group",
    );
    assert.ok(
      groups[1].items.every((item) => item.run.kind === "stage"),
      "and no plan run leaks into the second",
    );
    assert.equal(groups[1].items.length, 2, "Stage 3D and Stage 4; Stage 5 is the run's own current stage and is claimed by it");
  });

  it("labels rows by what a person calls them, and keeps the raw ids in the detail line", async () => {
    const { runs, plan, members } = await project();
    const memberships = planMemberships(runs, members);
    const groups = buildRunPickGroups(runs, { memberships });

    assert.equal(groups[0].items[0].label, PLAN_TITLE, "the plan document's own title, not docs/plans/active/reported-statistics.md");
    assert.match(groups[0].items[0].description, /^Complete · 3\/3 · feature\/x$/, "status, position and branch, as recorded; the total comes from the run's own manifest");
    assert.equal(groups[0].items[0].detail, `${plan.location.folderName} · ${STAGE_5}`, "repository and stage id stay in the quiet third line");

    assert.deepEqual(
      groups[1].items.map((item) => item.label),
      ["Stage 4 — Editor and UI inspection and guarded editing", "Stage 3D — Snapshot v2 and attachment/export/import transport"],
      "each stage by the name its own plan run gives it, never the slug",
    );
    for (const item of groups[1].items) {
      assert.match(item.description, new RegExp(`^Accepted · stage of ${PLAN_TITLE} \\(\\d of 3\\)$`), "and it says whose stage it is");
      assert.ok(!item.label.includes("stage-"), `no raw id in the label: ${item.label}`);
      assert.match(item.detail, /^[^·]+ · stage-/, "the id is in the detail");
    }
  });

  it("names a stage nothing claims by its humanized id, and says it stands alone", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-reported-statistics-typed-parser", { status: "working" });
    const runs = (await discoverRuns([ws.location])).runs;
    const groups = buildRunPickGroups(runs, { memberships: planMemberships(runs, []) });

    assert.deepEqual(
      groups.map((group) => group.title),
      [STANDALONE_STAGES_GROUP],
      "an empty group is not shown",
    );
    assert.equal(groups[0].items[0].label, "Reported statistics typed parser");
    assert.equal(groups[0].items[0].description, "Working · stage on its own");
  });

  it("is what Diagnose Discovery reports too, group and membership included", async () => {
    const ws = await Workspace.create();
    await ws.writePlan(PLAN_LABEL, PLAN);
    await ws.writeStage(STAGE_3D, { status: "accepted" });
    await ws.writeStage(STAGE_5, { status: "accepted" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "complete", current_stage: STAGE_5, current_stage_index: 2, source: "manifest" });
    const folders = [{ index: 0, name: ws.location.folderName, scheme: "file", fsPath: ws.root }];

    const report = await diagnoseDiscovery(folders, { manifestStages: async () => MANIFEST });
    assert.ok(
      report.pickLabels.some((label) => label === `${PLAN_RUNS_GROUP} | $(check) ${PLAN_TITLE} — Complete · 3/3 · feature/x — ${ws.location.folderName} · ${STAGE_5}`),
      `the plan run row, ticked because it is the selected run; got ${report.pickLabels.join(" / ")}`,
    );
    assert.ok(
      report.pickLabels.some((label) => label.startsWith(`${STANDALONE_STAGES_GROUP} | Stage 3D — Snapshot v2`) && label.includes(`Accepted · stage of ${PLAN_TITLE} (1 of 3)`)),
      "and Stage 3D named, grouped and attributed to its run",
    );

    // Without a manifest reader the rows are still grouped; only the
    // attribution is missing, and nothing is invented in its place.
    const plain = await diagnoseDiscovery(folders);
    assert.ok(plain.pickLabels.every((label) => !label.includes("stage of ")));
    assert.ok(plain.pickLabels.some((label) => label.startsWith(`${STANDALONE_STAGES_GROUP} | `)));
  });

  it("keeps the repository in the label when several are open, so identity is never lost", async () => {
    const first = await Workspace.create({ name: "reported" });
    await first.writeStage(STAGE_3D, { status: "accepted" });
    const second = await Workspace.create({ name: "nested-repo" });
    await second.writeStage("stage-nested-only", { status: "working" });
    const runs = (await discoverRuns([first.location, second.location])).runs;
    const groups = buildRunPickGroups(runs, { memberships: planMemberships(runs, []) });

    assert.deepEqual(
      groups[0].items.map((item) => item.label).sort(),
      ["nested-repo: Nested only", "reported: 3d snapshot v2 and attachment export import transport"],
    );
  });
});

// ---------------------------------------------------------------- membership

describe("which managed plan run a standalone stage belongs to", () => {
  it("is read off the manifest that run executes, and holds after the run is complete", async () => {
    const { runs, plan, historical, members } = await project();
    const membership = planMemberships(runs, members).get(historical.id);
    assert.ok(membership, "Stage 3D is a stage of the completed run");
    assert.equal(membership.planRunId, plan.id);
    assert.equal(membership.planStatus, "complete");
    assert.equal(membership.planName, PLAN_TITLE);
    assert.equal(membership.stageLabel, "Stage 3D");
    assert.equal(membership.stageTitle, "Snapshot v2 and attachment/export/import transport");
    assert.deepEqual([membership.position, membership.totalStages], [1, 3]);
    assert.equal(membership.currentStageId, STAGE_5);
    assert.equal(membership.currentStageLabel, "Stage 5");
  });

  it("is nothing at all when no discovered run claims the stage", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-a-one-off-experiment", { status: "accepted" });
    const runs = (await discoverRuns([ws.location])).runs;
    assert.equal(planMemberships(runs, []).size, 0, "no plan run, no membership");

    // A plan run in the same project whose manifest does not list the stage
    // claims nothing either: identity is read, never guessed from the title.
    const { plan } = await project();
    assert.equal(planMemberships(runs, [{ run: plan, manifestStages: MANIFEST }]).size, 0, "and a run of another project never claims it");
  });

  it("names a plan by its document title, falling back to the file name", async () => {
    const { plan } = await project();
    assert.equal(planRunDisplayName(plan), PLAN_TITLE);

    const ws = await Workspace.create();
    await ws.writePlan(PLAN_LABEL, "Prose with no heading at all.\n");
    await ws.writeStage(STAGE_5, { status: "working" });
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "running", current_stage: STAGE_5, current_stage_index: 0, source: "manifest" });
    const untitled = (await discoverRuns([ws.location])).runs.find((run): run is PlanRunSnapshot => run.kind === "plan");
    assert.ok(untitled);
    assert.equal(untitled.planDocumentTitle, undefined);
    assert.equal(planRunDisplayName(untitled), "reported-statistics.md", "the file name, not the whole path");
  });
});

// ---------------------------------------------------------------- the Overview

describe("a historical stage of a managed plan run", () => {
  it("says what it is, is named as the run names it, and offers the way back", async () => {
    const { runs, plan, historical, members } = await project();
    const { model, html } = overview(runs, historical, members);

    assert.equal(model.runKind, RUN_KIND.historicalStage, "not 'Standalone stage', which read like separate work");
    assert.equal(model.stageHeading, "Stage 3D — Snapshot v2 and attachment/export/import transport");
    assert.equal(model.stageLabel, "Stage 3D");
    assert.equal(model.status?.label, "Accepted");
    assert.equal(model.timeline, undefined, "one stage has no journey: that is the plan run's screen");

    assert.equal(model.followPlan?.label, "Back to plan run");
    assert.equal(model.followPlan?.runId, plan.id);
    assert.match(model.followPlan?.text ?? "", new RegExp(`^${PLAN_TITLE} is the managed plan run this stage belongs to, and the engine has completed it`));
    assert.match(model.followPlan?.detail ?? "", /does not open the plan document/);

    // The pill is toned down, and the button is the primary action.
    assert.match(html, /<span class="hpill history" title="One finished stage[^"]*">Historical stage<\/span>/);
    assert.ok(!html.includes("standalone"), "the label does not explain why the harness keeps a separate record for this stage");
    assert.match(html, /<button type="button" class="primary" data-action="openPlanRun"[^>]*>Back to plan run<\/button>/);
  });

  it("does not offer to continue the plan automatically, whether that run is complete or still going", async () => {
    for (const status of ["complete", "running"] as const) {
      const { runs, historical, members } = await project(status);
      const { model, html } = overview(runs, historical, members);
      assert.equal(model.continueAutomatically, undefined, `${status}: adopting stages a managed run already owns could only be refused or duplicate work`);
      assert.ok(!html.includes("Continue plan automatically"), `${status}: and the button is not in the document either`);
      assert.equal(model.whatsNext?.kind, "next-created", "nor creating a stage that exists");
    }
  });

  it("explains a complete run differently from a live one, because they are different situations", async () => {
    const live = await project("running");
    const running = overview(live.runs, live.historical, live.members).model;
    assert.match(running.followPlan?.text ?? "", /now at Stage 5 \(stage-5-/, "a live run is named with where it is");
    assert.match(running.whatsNext?.text ?? "", /the managed plan run is sequencing it/);

    const done = await project("complete");
    const complete = overview(done.runs, done.historical, done.members).model;
    assert.match(complete.followPlan?.text ?? "", /the engine has completed it/);
    assert.match(complete.whatsNext?.text ?? "", /the managed plan run that created it is complete/);
  });

  it("keeps everything that makes a historical stage worth opening", async () => {
    const { runs, historical, members } = await project();
    const { model, html } = overview(runs, historical, members, { handoff: true, sparring: true, brief: true });
    assert.deepEqual(
      [model.actions?.brief, model.actions?.handoff, model.actions?.sparring, Boolean(model.actions?.diff)],
      [true, true, true, true],
      "Brief, Handoff, Sparring report and Diff stay available",
    );
    for (const label of ["Brief", "Handoff", "Sparring report", "Diff", "Log"]) {
      assert.ok(html.includes(`>${label}</button>`), `${label} is still offered`);
    }
  });
});

describe("a standalone stage no managed run claims", () => {
  it("reads as standalone, gets no back button, and may still be adopted", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(STAGE_3D, { status: "accepted", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) });
    const runs = (await discoverRuns([ws.location])).runs;
    const { model, html } = overview(runs, runs[0], [], { existingStageIds: [STAGE_3D] });

    assert.equal(model.runKind, RUN_KIND.standaloneStage);
    assert.equal(model.followPlan, undefined, "no discoverable managed run means no button, not a dead one");
    assert.ok(!html.includes("Back to plan run"));
    assert.equal(model.continueAutomatically?.kind, "adopt", "this is the one place a stage can become a managed run");
  });

  it("gets no back button when the plan run's manifest cannot be read, whether that run is finished or live", async () => {
    // Without the manifest nothing is claimed — which is honest: the extension
    // does not know that this stage was part of that run. There is no fallback
    // to "some plan run in this project is open", because that is not a record
    // of anything.
    for (const status of ["complete", "running"] as const) {
      const { runs, historical, members } = await project(status, false);
      assert.equal(planMemberships(runs, members).size, 0, `${status}: nothing claims the stage`);
      const { model } = overview(runs, historical, members);
      assert.equal(model.followPlan, undefined, `${status}: no dead button`);
      assert.equal(model.runKind, RUN_KIND.standaloneStage, `${status}: and it reads as its own work`);
    }
  });

  /**
   * The blocking finding: historical-stage membership must come from recorded
   * execution membership, and the fallbacks that could turn an unrelated stage
   * into "Historical stage" are gone. The panel is where the last one lived.
   */
  it("the panel resolves the owning run from membership alone, with no fallback", async () => {
    const panel = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8");
    const body = /private async managedPlanRun[\s\S]*?\n {2}}\n/.exec(panel)?.[0] ?? "";
    assert.ok(body, "managedPlanRun exists");
    assert.match(body, /planMemberships\(\)\)\.get\(run\.id\)/, "membership is the source");
    assert.match(body, /if \(!membership\) \{\s*return undefined;/, "and no membership means no owning run");
    assert.ok(!/supersedingPlanRun/.test(panel), "'some open plan run has advanced' is not membership and is no longer consulted here");
  });

  it("membership itself consults only recorded execution, never a stage-id prefix", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "core", "planMembership.ts"), "utf8");
    const claims = /function claims\([\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.ok(claims, "claims exists");
    assert.match(claims, /manifestStages\?\.some/, "the validated manifest");
    assert.match(claims, /currentStage\.stageId === stageId/, "the run's own recorded current stage");
    assert.match(claims, /state\.source === "markdown" && candidate\.run\.stages\.some/, "and, for a markdown run only, the stage list the engine parses");
    assert.ok(!/startsWith/.test(claims), "a stage id that merely looks like this plan's is not a record of anything");
  });
});

// ---------------------------------------------------------------- the completed plan run itself

describe("a completed managed plan run", () => {
  it("is selectable and keeps its full timeline", async () => {
    const { runs, plan, historical } = await project();

    assert.equal(selectRun(runs, { id: plan.id, atMs: Date.now() }).selected?.id, plan.id, "an explicit choice of a complete run stands");
    assert.equal(selectRun(runs).selected?.id, plan.id, "and with nothing open it is the most recently written run anyway");

    const { model, html } = overview(runs, plan, [{ run: plan, manifestStages: MANIFEST }]);
    assert.equal(model.runKind, RUN_KIND.plan);
    assert.equal(model.status?.label, "Complete");
    assert.deepEqual(
      model.timeline?.map((item) => [item.label, item.state]),
      [
        ["3D", "accepted"],
        ["4", "accepted"],
        ["5", "accepted"],
      ],
      "every stage of the run, in its order, with its recorded status",
    );
    assert.equal(model.position, "Stage 3 of 3");
    assert.match(html, /<ol class="journey">/);
    assert.equal(model.followPlan, undefined, "a plan run is not a stage of anything");

    // And the stage it is showing is still reachable as one stage on its own.
    assert.ok(runs.includes(historical));
  });
});

// ---------------------------------------------------------------- document actions vs selection

describe("opening the plan document is never mistaken for opening the plan run", () => {
  it("labels the document actions as document and section, and posts document actions", async () => {
    const { runs, historical, members } = await project();
    const { html } = overview(runs, historical, members, { handoff: true, sparring: true, brief: true });

    assert.ok(!html.includes("Open in plan<"), "the old label that sounded like switching to the run is gone");
    assert.match(html, /data-action="openPlan"[^>]*>Plan document<\/button>/, "the plan-document button says document");

    const { document, posted } = runWebviewScript(html);
    document.dispatch("click", elementFrom(html, "button", /<button[^>]*data-action="openPlan"[^>]*>/, "the plan document button"));
    document.dispatch("click", elementFrom(html, "button", /<button[^>]*data-action="openPlanRun"[^>]*>/, "the back-to-plan-run button"));
    assert.deepEqual(posted, [{ type: "action", action: "openPlan" }, { type: "action", action: "openPlanRun" }], "two different actions, from two differently named buttons");
    assert.ok(posted.every((message) => isActionMessage(message)), "and the host accepts both");
  });

  it("offers Open plan section, not Open in plan, once a next stage is located", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(STAGE_3D, { status: "accepted", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) });
    const runs = (await discoverRuns([ws.location])).runs;
    const { model, html } = overview(runs, runs[0], [], { existingStageIds: [STAGE_3D] });

    assert.equal(model.whatsNext?.kind, "next-stage", "Stage 4 is the next stage of the linked plan");
    assert.match(html, /data-action="openNextStage" title="Open the document [^"]*at Stage 4[^"]*">Open plan section<\/button>/);
    assert.ok(!html.includes("Open in plan"));
  });

  it("resolves Back to plan run to the recorded plan run, which is what the host then selects", async () => {
    const { runs, plan, historical, members } = await project();
    const { model } = overview(runs, historical, members);
    // The same resolution the openPlanRun handler performs: the run id the
    // rendered model named, looked up in discovery. It must be the plan run
    // snapshot itself — not the plan document, and not another stage.
    const target = runs.find((candidate) => candidate.id === model.followPlan?.runId);
    assert.equal(target, plan);
    assert.equal(target?.kind, "plan");
    assert.equal(overview(runs, target as RunSnapshot, members).model.timeline?.length, 3, "and selecting it is what brings the timeline back");
  });
});
