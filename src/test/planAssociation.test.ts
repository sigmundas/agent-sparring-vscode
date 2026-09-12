import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, locateSparringDirs, runIdFor, selectRun } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { associatedPlanFor, locateStage, parsePlanHeadings, planTitle, withAssociation } from "../core/planAssociation";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, sparringMarkdown } from "./fixtures";

const T0 = Date.parse("2026-09-12T19:00:00.000Z");
const ALL: OverviewArtifacts = { handoff: true, sparring: true, brief: true, plan: true };

const REPORTED_PLAN = [
  "# Reported statistics",
  "",
  "Intro.",
  "",
  "## Stage 3A — Reported statistics contract",
  "text",
  "## Stage 3B — Reported statistics local schema barrier",
  "text",
  "```md",
  "## Stage 9 — inside a fence",
  "```",
  "## Stage 3C — Cloud schema and synchronization",
  "text",
  "",
].join("\n");

describe("lenient plan headings", () => {
  it("accepts stage labels the engine would refuse (3A, 3B, 3C), skipping fences, with line numbers", () => {
    const headings = parsePlanHeadings(REPORTED_PLAN);
    assert.deepEqual(
      headings.map((heading) => [heading.label, heading.title, heading.line]),
      [
        ["3A", "Reported statistics contract", 5],
        ["3B", "Reported statistics local schema barrier", 7],
        ["3C", "Cloud schema and synchronization", 12],
      ],
    );
    assert.equal(headings[2].display, "Stage 3C — Cloud schema and synchronization");
    assert.equal(planTitle(REPORTED_PLAN), "Reported statistics");
  });

  it("falls back to plain ## headings when a document has no stage headings", () => {
    const headings = parsePlanHeadings("# Plan\n\n## Background\n\n## Rollout\n");
    assert.deepEqual(headings.map((heading) => heading.display), ["Background", "Rollout"]);
    assert.deepEqual(parsePlanHeadings("just prose"), []);
    assert.equal(planTitle("no title here"), undefined);
  });

  it("locates a stage only on an unambiguous slug match", () => {
    const headings = parsePlanHeadings(REPORTED_PLAN);
    const position = locateStage(headings, "stage-reported-statistics-local-schema-barrier");
    assert.equal(position?.current.display, "Stage 3B — Reported statistics local schema barrier");
    assert.equal(position?.next?.display, "Stage 3C — Cloud schema and synchronization");
    assert.equal(position?.previous?.display, "Stage 3A — Reported statistics contract");
    assert.equal(locateStage(headings, "stage-2-reported-statistics-contract")?.current.label, "3A", "a numbered id still matches by slug");
    assert.equal(locateStage(headings, "stage-something-else"), undefined);
    assert.equal(locateStage(parsePlanHeadings("## Stage 1 — Same\n## Stage 2 — Same\n"), "stage-same"), undefined, "two candidates: no guess");
  });
});

describe("plan association storage (workspace state, per repository + stage id)", () => {
  it("is keyed by run id, so the same stage id in two repositories does not share an association", async () => {
    const a = await Workspace.create({ name: "repo-a" });
    const b = await Workspace.create({ name: "repo-b" });
    const idA = runIdFor(a.location, "stage", "stage-x");
    const idB = runIdFor(b.location, "stage", "stage-x");
    assert.notEqual(idA, idB);
    let associations = withAssociation(undefined, idA, "/plans/a.md");
    assert.equal(associatedPlanFor(associations, idA), "/plans/a.md");
    assert.equal(associatedPlanFor(associations, idB), undefined);
    associations = withAssociation(associations, idB, "/plans/b.md");
    associations = withAssociation(associations, idA, "/plans/a2.md");
    assert.equal(associatedPlanFor(associations, idA), "/plans/a2.md", "changeable");
    associations = withAssociation(associations, idA, undefined);
    assert.equal(associatedPlanFor(associations, idA), undefined, "removable");
    assert.equal(associatedPlanFor(associations, idB), "/plans/b.md");
    assert.equal(associatedPlanFor(undefined, idA), undefined);
  });

  it("never lands in engine state: the stage directory is untouched by an association", async () => {
    const ws = await Workspace.create();
    const dir = await ws.writeStage("stage-x", { status: "working" });
    const before = (await fs.readdir(dir)).sort();
    withAssociation(undefined, runIdFor(ws.location, "stage", "stage-x"), path.join(ws.root, "docs", "anything.md"));
    assert.deepEqual((await fs.readdir(dir)).sort(), before);
  });
});

describe("Overview plan actions", () => {
  it("standalone stage without an association offers Choose plan…, no Plan button and no journey", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-reported-statistics-local-schema-barrier", { status: "working" });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(model.actions?.plan, false, "artifacts.plan is ignored for a standalone stage; only an association counts");
    assert.equal(model.actions?.choosePlan, true);
    assert.equal(model.actions?.changePlan, false);
    assert.equal(model.plan, undefined);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<button type="button" data-action="associatePlan" [^>]*>Choose plan…<\/button>/);
    assert.ok(!html.includes('data-action="openPlan"'));
  });

  it("an associated plan yields Plan / Change plan…, this stage's position and an informational Up next once accepted; the run stays standalone", async () => {
    const ws = await Workspace.create();
    const planFile = path.join(ws.root, "anywhere", "reported.md");
    await fs.mkdir(path.dirname(planFile), { recursive: true });
    await fs.writeFile(planFile, REPORTED_PLAN);
    await ws.writeStage("stage-reported-statistics-local-schema-barrier", { status: "working", implementation_session_id: "x" }, { "sparring.md": sparringMarkdown("READY", "ok") });
    const associated = { path: planFile, exists: true, text: REPORTED_PLAN };
    const working = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, plan: false, associatedPlan: associated }, T0);
    assert.equal(working.runKind, "Standalone stage", "an associated file never turns a stage into a managed plan run");
    assert.equal(working.timeline, undefined);
    assert.equal(working.position, undefined);
    assert.equal(working.planAction, undefined, "no Continue plan: the engine has no such operation for a standalone stage");
    assert.equal(working.actions?.plan, true);
    assert.equal(working.actions?.choosePlan, false);
    assert.equal(working.actions?.changePlan, true);
    assert.equal(working.plan?.source, "associated");
    assert.equal(working.plan?.name, "Reported statistics");
    assert.equal(working.plan?.current, "Stage 3B — Reported statistics local schema barrier");
    assert.deepEqual(working.plan?.next, { display: "Stage 3C — Cloud schema and synchronization", line: 12 });
    assert.deepEqual(working.facts?.[1], { label: "Plan", value: "reported.md (associated in VS Code)" });
    let html = renderOverviewHtml(working, "n", "c");
    assert.match(html, /<button type="button" data-action="openPlan" [^>]*>Plan<\/button>/);
    assert.match(html, /data-action="associatePlan" [^>]*>Change plan…<\/button>/);
    assert.ok(!html.includes("Up next"), "Up next is for the accepted screen");
    assert.ok(!html.includes(ws.root), "no filesystem paths in the document");

    await ws.writeStage("stage-reported-statistics-local-schema-barrier", { status: "accepted", candidate_sha: "c".repeat(40) });
    const accepted = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, plan: false, associatedPlan: associated }, T0);
    html = renderOverviewHtml(accepted, "n", "c");
    assert.match(html, /Up next<\/h3><p><span class="next">Stage 3C — Cloud schema and synchronization<\/span> <button type="button" class="quiet" data-action="openNextStage"[^>]*>Open in plan<\/button><\/p>/);
    assert.match(html, /the engine has no next-stage operation for a standalone stage/);
    assert.ok(!/Continue plan|Next stage/.test(html));
  });

  it("an associated file that is missing or unmatched degrades honestly", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-other", { status: "accepted", candidate_sha: "c".repeat(40) });
    const missing = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, associatedPlan: { path: "/gone/plan.md", exists: false } }, T0);
    assert.equal(missing.actions?.plan, false);
    assert.equal(missing.actions?.changePlan, true);
    assert.match(missing.plan?.note ?? "", /currently missing/);
    const unmatched = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, associatedPlan: { path: "/p/plan.md", exists: true, text: REPORTED_PLAN } }, T0);
    assert.equal(unmatched.plan?.current, undefined);
    assert.equal(unmatched.plan?.next, undefined);
    assert.match(renderOverviewHtml(unmatched, "n", "c"), /this stage was not matched to a heading in it/);
  });

  it("a managed plan run keeps its authoritative Plan action and journey; an accepted current stage offers Continue plan", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 1, current_stage: FOO_STAGE_IDS[1] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted", candidate_sha: "c".repeat(40) });
    await ws.writeStage(FOO_STAGE_IDS[1], { status: "accepted", candidate_sha: "d".repeat(40) });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(model.runKind, "Plan run");
    assert.equal(model.actions?.plan, true);
    assert.equal(model.actions?.choosePlan, false);
    assert.equal(model.actions?.changePlan, false);
    assert.equal(model.plan?.source, "managed");
    assert.equal(model.plan?.next?.display, "Stage 3 — Device/UI check!");
    assert.deepEqual(model.planAction, { kind: "continue", label: "Continue plan", primary: true, detail: "sparring resume-plan: the accepted stage is advanced past and the next stage starts." });
    assert.equal(model.stageLine, "Stage complete. Continue plan starts the next stage.");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<button type="button" class="primary" data-action="resumePlan" [^>]*>Continue plan<\/button>/);
    assert.match(html, /Up next<\/h3><p><span class="next">Stage 3 — Device\/UI check!<\/span><\/p>/);
    assert.ok(!html.includes('data-action="associatePlan"'));
    assert.ok(html.includes('class="journey"'));
  });

  it("a managed plan run that is still working offers no continuation; paused offers Resume plan; complete offers nothing", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" });
    // Recorded as running, nothing observed: the runner may be alive elsewhere → honest Resume plan for a stopped run only.
    const working = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(working.planAction?.label, "Resume plan");
    assert.match(working.planAction?.detail ?? "", /no runner is alive/);
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    const paused = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.deepEqual(paused.planAction && [paused.planAction.kind, paused.planAction.label, paused.planAction.primary], ["resume", "Resume plan", true]);
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    await ws.writeStage(FOO_STAGE_IDS[2], { status: "accepted" });
    const complete = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(complete.planAction, undefined);
  });

  it("nested repositories keep their own association key", async () => {
    const parent = await Workspace.create({ sparring: false, name: "sporely" });
    const nested = await Workspace.createNested(parent.root, "sporely-py-reported-statistics");
    await nested.writeStage("stage-x", { status: "working" });
    const locations = await locateSparringDirs(parent.root, "sporely");
    const run = selectRun((await discoverRuns(locations)).runs).selected!;
    assert.ok(run.id.startsWith(`${nested.root}|`));
    assert.notEqual(run.id, runIdFor({ ...run.location, projectDir: parent.root }, "stage", "stage-x"));
  });

  it("nothing in the extension hard-codes a docs/plans/active convention", async () => {
    const src = path.resolve(__dirname, "..", "..", "src");
    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(full);
        }
      }
    }
    await walk(src);
    assert.ok(files.length > 10);
    for (const file of files) {
      assert.ok(!(await fs.readFile(file, "utf8")).includes("docs/plans/active"), `${path.relative(src, file)} must not assume a plan directory`);
    }
  });
});
