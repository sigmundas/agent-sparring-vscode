import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseBriefStageMarkers } from "../core/brief";
import { discoverRuns, locateSparringDirs, runIdFor, selectRun } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import {
  associatedPlanFor,
  briefMentionedStages,
  buildStageIndex,
  compareStageLabels,
  locateStage,
  nextStageAfter,
  parsePlanHeadings,
  planAssociationFor,
  planTitle,
  sectionSummary,
  withAssociation,
  withManualMatch,
  type PlanAssociations,
} from "../core/planAssociation";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_PLAN_MARKDOWN, FOO_STAGE_IDS, Workspace, normalUi, sparringMarkdown } from "./fixtures";

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

/** The field shape: headings whose titles do not repeat the stage id, so the id alone cannot place the stage. */
const RANGE_PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Stage 3A — Contract",
  "",
  "Defines the reported-statistics contract.",
  "",
  "## Stage 3B — Local schema barrier",
  "",
  "The local schema gets a barrier so nothing leaks.",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "**Cloud** schema, RPC surface and the transport that carries",
  "reported statistics upward.",
  "",
  "- a list, not the summary",
  "",
  "## Stage 3D — Snapshot transport",
  "",
  "- starts with a list: no summary",
  "",
  "## Stage 4 — UI",
  "",
].join("\n");

const BARRIER_BRIEF = [
  "# Stage 3B — Local schema barrier",
  "",
  "## Goal",
  "",
  "Put a barrier in front of the local schema.",
  "",
  "## Deferred",
  "",
  "- Stage 3C — cloud schema/RPC and sync transport",
  "- Stage 3D — snapshot transport",
  "- Stage 4 — UI",
  "",
].join("\n");

const BARRIER_ID = "stage-reported-statistics-local-schema-barrier";

/**
 * The structure of the real reported-statistics plan: the current stage's
 * handoff near the top, older handoffs right after it in reverse order,
 * architecture in between, and the prospective stage definitions further
 * down. Document order is the opposite of workflow order.
 */
const FIELD_PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Current stage / reviewer handoff — 2026-09-12 (Stage 3B)",
  "",
  "Accepted at c0ffee. Claims and evidence below.",
  "",
  "## Stage 3A handoff — 2026-09-11",
  "",
  "Older handoff.",
  "",
  "## Stage 2 handoff — 2026-09-10",
  "",
  "## Stage 1 handoff — 2026-09-09",
  "",
  "## Architecture",
  "",
  "Prose about layers.",
  "",
  "## Stage 1 — Contract",
  "",
  "The contract.",
  "",
  "## Stage 2 — Typed parser",
  "",
  "## Stage 3A — Local schema",
  "",
  "## Stage 3B — Local reported-statistics persistence",
  "",
  "Persist locally.",
  "",
  "## Stage 3C — Cloud schema and synchronization",
  "",
  "Cloud schema, RPC surface and sync transport.",
  "",
  "## Stage 3D — Snapshot transport",
  "",
  "## Stage 4 — UI",
  "",
  "## Status history",
  "",
  "- Stage 3C candidate pending",
  "",
].join("\n");

const PERSISTENCE_ID = "stage-reported-statistics-local-persistence";

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

  it("reads a `(Stage 3B)` marker inside a heading as a mention of that stage, and flags handoff/date headings as historical", () => {
    const headings = parsePlanHeadings(FIELD_PLAN);
    const handoff = headings[0];
    assert.deepEqual([handoff.label, handoff.form, handoff.historical, handoff.title], ["3B", "mention", true, "Current stage / reviewer handoff — 2026-09-12"]);
    assert.equal(handoff.display, "Current stage / reviewer handoff — 2026-09-12 (Stage 3B)");
    assert.deepEqual(headings.filter((heading) => heading.form === "definition" && !heading.historical).map((heading) => heading.label), ["1", "2", "3A", "3B", "3C", "3D", "4"]);
    assert.deepEqual(headings.filter((heading) => heading.historical).map((heading) => heading.display), [
      "Current stage / reviewer handoff — 2026-09-12 (Stage 3B)",
      "Stage 3A handoff — 2026-09-11",
      "Stage 2 handoff — 2026-09-10",
      "Stage 1 handoff — 2026-09-09",
    ]);
    assert.ok(!headings.some((heading) => heading.display === "Architecture"), "unlabelled headings are dropped once the plan has stage labels");
    assert.equal(parsePlanHeadings("## Stage 3C — Review pipeline\n")[0].historical, false, "words like review do not make a definition historical");
  });

  it("reads stage headings at levels ## to ####, and falls back to plain ## headings when a document has none", () => {
    assert.deepEqual(
      parsePlanHeadings("# Plan\n\n## Phase 3\n\n### Stage 3A — Contract\n\n#### Stage 3B — Barrier\n").map((heading) => heading.display),
      ["Stage 3A — Contract", "Stage 3B — Barrier"],
    );
    const headings = parsePlanHeadings("# Plan\n\n## Background\n\n## Rollout\n");
    assert.deepEqual(headings.map((heading) => heading.display), ["Background", "Rollout"]);
    assert.deepEqual(parsePlanHeadings("just prose"), []);
    assert.equal(planTitle("no title here"), undefined);
  });

  it("summarises a section by its opening paragraph only", () => {
    const headings = parsePlanHeadings(RANGE_PLAN);
    assert.equal(sectionSummary(RANGE_PLAN, headings[2].line), "Cloud schema, RPC surface and the transport that carries reported statistics upward.");
    assert.equal(sectionSummary(RANGE_PLAN, headings[3].line), undefined, "a list is not a summary");
    assert.equal(sectionSummary(RANGE_PLAN, headings[4].line), undefined, "an empty section has none");
    assert.equal(sectionSummary(RANGE_PLAN, headings[1].line, 20), "The local schema ge…");
  });
});

describe("stage matching", () => {
  it("locates a stage by id slug only on an unambiguous match", () => {
    const headings = parsePlanHeadings(REPORTED_PLAN);
    const position = locateStage(headings, BARRIER_ID);
    assert.equal(position?.source, "id");
    assert.equal(position?.current.display, "Stage 3B — Reported statistics local schema barrier");
    assert.equal(position?.display, "Stage 3B — Reported statistics local schema barrier");
    assert.deepEqual(position?.next.state === "found" ? position.next.stage.display : position?.next.state, "Stage 3C — Cloud schema and synchronization");
    assert.equal(locateStage(headings, "stage-2-reported-statistics-contract")?.current.label, "3A", "a numbered id still matches by slug");
    assert.equal(locateStage(headings, "stage-something-else"), undefined);
    assert.equal(locateStage(parsePlanHeadings("## Stage 1 — Same\n## Stage 2 — Same\n"), "stage-same"), undefined, "two candidates: no guess");
  });

  it("does not choose a heading on a weak resemblance", () => {
    const headings = parsePlanHeadings(RANGE_PLAN);
    // "Local schema barrier" is only a suffix of the id; the plan has several plausible sections.
    assert.equal(locateStage(headings, BARRIER_ID), undefined);
    assert.equal(locateStage(headings, { stageId: BARRIER_ID, title: "Reported statistics local schema barrier" }), undefined, "a display title that matches no heading exactly is not enough");
    assert.equal(locateStage(headings, { stageId: BARRIER_ID, briefText: "# Brief\n\nNo markers here.\n" }), undefined);
    // A label defined twice still names one logical stage (the brief says this *is* Stage 3B); no title is claimed for it.
    const duplicated = locateStage(parsePlanHeadings("## Stage 3B — One\n## Stage 3B — Two\n"), { stageId: BARRIER_ID, briefText: BARRIER_BRIEF });
    assert.deepEqual([duplicated?.source, duplicated?.stage?.ambiguous, duplicated?.display], ["brief", true, "Stage 3B"]);
  });

  it("uses a stage label carried by the id or by the brief's own title, and the display title, before giving up", () => {
    const headings = parsePlanHeadings(RANGE_PLAN);
    const byIdLabel = locateStage(headings, "stage-3b-local-schema-barrier-work");
    assert.deepEqual([byIdLabel?.source, byIdLabel?.current.display], ["label", "Stage 3B — Local schema barrier"]);
    const byBrief = locateStage(headings, { stageId: BARRIER_ID, briefText: BARRIER_BRIEF });
    assert.deepEqual([byBrief?.source, byBrief?.current.display, byBrief?.next.state === "found" && byBrief.next.stage.display], ["brief", "Stage 3B — Local schema barrier", "Stage 3C — Cloud schema/RPC and sync transport"]);
    const byTitle = locateStage(headings, { stageId: "stage-x", title: "Local schema barrier" });
    assert.deepEqual([byTitle?.source, byTitle?.current.label], ["title", "3B"]);
    // Deferred stages mentioned later in the brief never name the current stage.
    assert.equal(locateStage(headings, { stageId: "stage-x", briefText: "# Brief\n\n## Deferred\n\n- Stage 3C — later\n" }), undefined);
  });

  it("the user's manual match wins, survives renumbering by title, and is ignored once its heading is gone", () => {
    const headings = parsePlanHeadings(RANGE_PLAN);
    const manual = locateStage(headings, { stageId: BARRIER_ID, briefText: BARRIER_BRIEF, manual: { label: "3C", title: "Cloud schema/RPC and sync transport" } });
    assert.deepEqual([manual?.source, manual?.current.label, manual?.next.state === "found" && manual.next.stage.label], ["manual", "3C", "3D"]);
    const renumbered = locateStage(headings, { stageId: "stage-x", manual: { label: "7", title: "Snapshot transport" } });
    assert.deepEqual([renumbered?.source, renumbered?.current.label], ["manual", "3D"]);
    const gone = locateStage(headings, { stageId: BARRIER_ID, briefText: BARRIER_BRIEF, manual: { label: "9", title: "Removed section" } });
    assert.equal(gone?.source, "brief", "falls through to automatic matching");
    assert.equal(locateStage(headings, { stageId: "stage-x", manual: { label: "9", title: "Removed section" } }), undefined);
  });

  it("reads Stage markers from a brief: the title names this stage, the rest are mentions", () => {
    assert.deepEqual(parseBriefStageMarkers(BARRIER_BRIEF), { current: "3B", mentioned: ["3C", "3D", "4"] });
    assert.deepEqual(parseBriefStageMarkers("Stage 3B — local schema barrier\n\nLater: Stage 4.\n"), { current: "3B", mentioned: ["4"] });
    assert.deepEqual(parseBriefStageMarkers("Brief for stage 3b.\n\nLater: Stage 4.\n"), { mentioned: ["3B", "4"] }, "prose that mentions a stage does not name the current one");
    assert.deepEqual(parseBriefStageMarkers("# Brief\n\nMentions later Stage 3C and Stage 4 only.\n"), { mentioned: ["3C", "4"] });
    assert.deepEqual(parseBriefStageMarkers("# Brief\n\n```\nStage 1\n```\n\n## Notes\n\nStage 2 follows.\n"), { mentioned: ["2"] });
    assert.deepEqual(parseBriefStageMarkers(undefined), { mentioned: [] });
    const index = buildStageIndex(parsePlanHeadings(RANGE_PLAN));
    assert.deepEqual(
      briefMentionedStages(index, BARRIER_BRIEF).map((entry) => entry.display),
      ["Stage 3C — Cloud schema/RPC and sync transport", "Stage 3D — Snapshot transport", "Stage 4 — UI"],
    );
    assert.deepEqual(briefMentionedStages(index, undefined), []);
  });
});

describe("stage index: workflow order from labels, never from document order", () => {
  it("orders labels numerically with letter suffixes: 1 < 2 < 3 < 3A < 3B < 3C < 4 < 10", () => {
    const labels = ["10", "3C", "4", "3", "1", "3A", "2", "3B", "X"];
    assert.deepEqual(labels.sort(compareStageLabels), ["1", "2", "3", "3A", "3B", "3C", "4", "10", "X"]);
    assert.equal(compareStageLabels("3b", "3B"), 0, "case-insensitive suffix");
  });

  it("collapses every heading that carries a label into one logical stage and prefers the prospective definition over handoffs and history", () => {
    const index = buildStageIndex(parsePlanHeadings(FIELD_PLAN));
    assert.deepEqual(index.map((entry) => entry.label), ["1", "2", "3A", "3B", "3C", "3D", "4"]);
    const b = index.find((entry) => entry.label === "3B")!;
    assert.equal(b.occurrences.length, 2, "the handoff mention and the definition are the same stage");
    assert.equal(b.canonical?.display, "Stage 3B — Local reported-statistics persistence");
    assert.equal(b.display, "Stage 3B — Local reported-statistics persistence");
    assert.equal(b.ambiguous, false);
    const c = index.find((entry) => entry.label === "3C")!;
    assert.equal(c.occurrences.length, 1, "the status-history bullet is not a heading");
    assert.equal(c.canonical?.line, 31);
    const one = index.find((entry) => entry.label === "1")!;
    assert.equal(one.canonical?.display, "Stage 1 — Contract", "the dated handoff heading is not the definition");
  });

  it("regression: after the current Stage 3B handoff the file continues with the old Stage 3A handoff, yet the next stage is 3C", () => {
    const headings = parsePlanHeadings(FIELD_PLAN);
    assert.equal(headings[1].display, "Stage 3A handoff — 2026-09-11", "document adjacency: 3A follows 3B in the file");
    // The user picked the handoff heading at the top as this stage.
    const position = locateStage(headings, { stageId: PERSISTENCE_ID, manual: { label: "3B", title: "Current stage / reviewer handoff — 2026-09-12" } });
    assert.equal(position?.source, "manual");
    assert.equal(position?.stage?.label, "3B");
    assert.equal(position?.display, "Stage 3B — Local reported-statistics persistence", "the clean canonical title, not the raw handoff heading");
    assert.equal(position?.next.state, "found");
    assert.equal(position?.next.state === "found" && position.next.stage.display, "Stage 3C — Cloud schema and synchronization");
    assert.ok(!(position?.next.state === "found" && /3A|handoff/.test(position.next.stage.display)), "the adjacent historical heading is never up next");
  });

  it("walks the chain by label: 3B → 3C → 3D → 4 → nothing later", () => {
    const index = buildStageIndex(parsePlanHeadings(FIELD_PLAN));
    const after = (label: string) => {
      const result = nextStageAfter(index, label);
      return result.state === "found" ? result.next.label : result.state;
    };
    assert.equal(after("3B"), "3C");
    assert.equal(after("3C"), "3D");
    assert.equal(after("3D"), "4");
    assert.equal(after("4"), "last");
    assert.equal(after("3"), "unknown", "a label the plan does not have");
    assert.equal(after("1"), "2");
  });

  it("a stage defined twice is ambiguous and gets no canonical section; a stage only mentioned historically has none either", () => {
    const twice = buildStageIndex(parsePlanHeadings("## Stage 3C — Cloud schema\n\n## Stage 3C — Cloud schema, revised\n\n## Stage 3D — Snapshot\n"));
    const c = twice.find((entry) => entry.label === "3C")!;
    assert.equal(c.ambiguous, true);
    assert.equal(c.canonical, undefined);
    assert.equal(c.display, "Stage 3C");
    const historicalOnly = buildStageIndex(parsePlanHeadings("## Stage 3B — Barrier\n\n## Stage 4 handoff — 2026-01-01\n"));
    const four = historicalOnly.find((entry) => entry.label === "4")!;
    assert.equal(four.canonical, undefined);
    assert.equal(four.ambiguous, false);
    assert.equal(nextStageAfter(historicalOnly, "3B").state, "found", "the label is later, but What's next must say the plan does not define it");
    // A definition plus a historical mention is not ambiguous.
    const mixed = buildStageIndex(parsePlanHeadings("## Stage 3C — Cloud schema\n\n## Stage 3C handoff — 2026-01-01\n"));
    assert.equal(mixed[0].canonical?.display, "Stage 3C — Cloud schema");
  });
});

describe("plan association storage (workspace state, per repository + stage id)", () => {
  it("is keyed by run id, so the same stage id in two repositories does not share an association or a match", async () => {
    const a = await Workspace.create({ name: "repo-a" });
    const b = await Workspace.create({ name: "repo-b" });
    const idA = runIdFor(a.location, "stage", "stage-x");
    const idB = runIdFor(b.location, "stage", "stage-x");
    assert.notEqual(idA, idB);
    let associations = withAssociation(undefined, idA, "/plans/a.md");
    assert.equal(associatedPlanFor(associations, idA), "/plans/a.md");
    assert.equal(associatedPlanFor(associations, idB), undefined);
    associations = withAssociation(associations, idB, "/plans/b.md");
    associations = withManualMatch(associations, idA, { label: "3B", title: "Barrier" });
    assert.deepEqual(planAssociationFor(associations, idA), { path: "/plans/a.md", match: { label: "3B", title: "Barrier" } });
    assert.deepEqual(planAssociationFor(associations, idB), { path: "/plans/b.md" }, "the match belongs to one repository's stage only");
    associations = withAssociation(associations, idA, "/plans/a2.md");
    assert.deepEqual(planAssociationFor(associations, idA), { path: "/plans/a2.md" }, "changing the file drops a match that named a heading of the old file");
    associations = withAssociation(associations, idA, undefined);
    assert.equal(associatedPlanFor(associations, idA), undefined, "removable");
    assert.equal(associatedPlanFor(associations, idB), "/plans/b.md");
    assert.equal(associatedPlanFor(undefined, idA), undefined);
    assert.deepEqual(withManualMatch(undefined, idA, { title: "x" }), {}, "no match without an association");
  });

  it("a manual match can be changed and removed, and reads back after a JSON round trip (reload)", () => {
    let associations: PlanAssociations = withAssociation(undefined, "r|stage:x", "/p.md");
    associations = withManualMatch(associations, "r|stage:x", { label: "3B", title: "Barrier" });
    associations = withManualMatch(associations, "r|stage:x", { title: "Plain heading" });
    const reloaded = JSON.parse(JSON.stringify(associations)) as PlanAssociations;
    assert.deepEqual(planAssociationFor(reloaded, "r|stage:x"), { path: "/p.md", match: { label: undefined, title: "Plain heading" } });
    associations = withManualMatch(reloaded, "r|stage:x", undefined);
    assert.deepEqual(planAssociationFor(associations, "r|stage:x"), { path: "/p.md" });
    assert.equal(associatedPlanFor(associations, "r|stage:x"), "/p.md", "removing the match keeps the association");
  });

  it("still reads the older bare-path shape and ignores malformed entries", () => {
    const legacy = { "r|stage:x": "/old.md", "r|stage:y": { path: "  " }, "r|stage:z": { path: "/z.md", match: { title: "" } }, "r|stage:w": 5 } as unknown as PlanAssociations;
    assert.deepEqual(planAssociationFor(legacy, "r|stage:x"), { path: "/old.md" });
    assert.equal(planAssociationFor(legacy, "r|stage:y"), undefined);
    assert.deepEqual(planAssociationFor(legacy, "r|stage:z"), { path: "/z.md" }, "an empty match title is not a match");
    assert.equal(planAssociationFor(legacy, "r|stage:w"), undefined);
    assert.deepEqual(withAssociation(legacy, "r|stage:x", "/old.md"), { ...legacy, "r|stage:x": { path: "/old.md" } });
  });

  it("never lands in engine state: the stage directory is untouched by an association", async () => {
    const ws = await Workspace.create();
    const dir = await ws.writeStage("stage-x", { status: "working" });
    const before = (await fs.readdir(dir)).sort();
    const runId = runIdFor(ws.location, "stage", "stage-x");
    withManualMatch(withAssociation(undefined, runId, path.join(ws.root, "docs", "anything.md")), runId, { title: "x" });
    assert.deepEqual((await fs.readdir(dir)).sort(), before);
  });
});

describe("Overview plan actions", () => {
  it("standalone stage without an association offers Choose plan…, no Plan button and no journey", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(BARRIER_ID, { status: "working" });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(model.actions?.plan, false, "artifacts.plan is ignored for a standalone stage; only an association counts");
    assert.equal(model.actions?.choosePlan, true);
    assert.equal(model.actions?.changePlan, false);
    assert.equal(model.actions?.matchStage, false);
    assert.equal(model.plan, undefined);
    assert.equal(model.whatsNext, undefined, "What's next is for the accepted screen");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<button type="button" data-action="associatePlan" [^>]*>Choose plan…<\/button>/);
    assert.ok(!html.includes('data-action="openPlan"'));
  });

  it("an associated plan yields Plan / Change plan…, this stage's position and, once accepted, What's next with the following heading; the run stays standalone", async () => {
    const ws = await Workspace.create();
    const planFile = path.join(ws.root, "anywhere", "reported.md");
    await fs.mkdir(path.dirname(planFile), { recursive: true });
    await fs.writeFile(planFile, REPORTED_PLAN);
    await ws.writeStage(BARRIER_ID, { status: "working", implementation_session_id: "x" }, { "sparring.md": sparringMarkdown("READY", "ok") });
    const associated = { path: planFile, exists: true, text: REPORTED_PLAN };
    const working = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, plan: false, associatedPlan: associated }, T0);
    assert.equal(working.runKind, "Standalone stage", "an associated file never turns a stage into a managed plan run");
    assert.equal(working.timeline, undefined);
    assert.equal(working.position, undefined);
    assert.equal(working.planAction, undefined, "no Continue plan: the engine has no such operation for a standalone stage");
    assert.equal(working.actions?.plan, true);
    assert.equal(working.actions?.choosePlan, false);
    assert.equal(working.actions?.changePlan, true);
    assert.equal(working.actions?.matchStage, true);
    assert.equal(working.plan?.source, "associated");
    assert.equal(working.plan?.name, "Reported statistics");
    assert.equal(working.plan?.current, "Stage 3B — Reported statistics local schema barrier");
    assert.equal(working.plan?.matched, "id");
    assert.deepEqual(working.plan?.next, { display: "Stage 3C — Cloud schema and synchronization", label: "3C", line: 12, summary: "text", defined: true, ambiguous: false });
    assert.equal(working.plan?.currentLabel, "3B");
    assert.deepEqual(working.facts?.[1], { label: "Plan", value: "reported.md (associated in VS Code)" });
    let html = renderOverviewHtml(working, "n", "c");
    assert.match(html, /<button type="button" data-action="openPlan" [^>]*>Plan<\/button>/);
    assert.match(html, /data-action="associatePlan" [^>]*>Change plan…<\/button>/);
    // The stage is called what the plan calls it, in the card's own heading;
    // the block below carries how that was decided, not the name again.
    assert.equal(working.stageHeading, "Stage 3B — Reported statistics local schema barrier");
    assert.equal(working.stageLabel, "Stage 3B");
    assert.match(html, /Current plan stage<\/h3><p class="muted matched">Matched automatically <button type="button" class="quiet" data-action="matchStage"[^>]*>Change match…<\/button><button type="button" class="quiet" data-action="reviewStageMatches"[^>]*>All stage matches…<\/button><\/p>/);
    assert.equal((html.match(/Stage 3B — Reported statistics local schema barrier/g) ?? []).length, 2, "the crumb and the card heading; not a third time under Current plan stage");
    assert.ok(!html.includes("Remove match"), "nothing to remove for an automatic match");
    assert.ok(!html.includes("What's next"), "What's next is for the accepted screen");
    assert.ok(!html.includes(ws.root), "no filesystem paths in the document");

    await ws.writeStage(BARRIER_ID, { status: "accepted", candidate_sha: "c".repeat(40) });
    const accepted = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, plan: false, associatedPlan: associated }, T0);
    assert.deepEqual(accepted.whatsNext, {
      kind: "next-stage",
      heading: "Stage 3C — Cloud schema and synchronization",
      summary: "text",
      text: "Start next stage creates it with the engine, using this plan section as its brief. Run stage then begins implementation.",
      start: { stageId: "stage-3c-cloud-schema-and-synchronization", label: "3C", title: "Cloud schema and synchronization", display: "Stage 3C — Cloud schema and synchronization", line: 12 },
    });
    html = renderOverviewHtml(accepted, "n", "c");
    assert.match(html, /What's next<\/h3><p class="nextstage">Stage 3C — Cloud schema and synchronization<\/p><p class="muted summary">text<\/p>/);
    // Automatic continuation (the default) leads; Start next stage stays as
    // the per-stage alternative right after it.
    assert.match(html, /<button type="button" class="primary" data-action="continueAutomatically"[^>]*>Continue plan automatically<\/button><button type="button" class="quiet" data-action="startNextStage" title="sparring new-stage stage-3c-cloud-schema-and-synchronization[^"]*">Start next stage<\/button><button type="button" data-action="openNextStage"[^>]*>Open in plan<\/button><button type="button" class="quiet" data-action="matchStage"[^>]*>Change match…<\/button>/);
    assert.match(html, /Current plan stage<\/h3><p class="nextstage">Stage 3B — Reported statistics local schema barrier<\/p><p class="muted matched">Matched automatically<button type="button" class="quiet" data-action="associatePlan"[^>]*>Remove plan association<\/button>/);
    // No managed-run action: the engine has no operation that continues a
    // standalone stage from a plan. (Continue plan *automatically* is a
    // different thing — it creates the managed run — and is offered.)
    assert.ok(!/data-action="resumePlan"|Open next in plan/.test(html));
    assert.ok(!html.includes("Current activity"), "the accepted screen answers what to do next instead of watching activity");
  });

  it("an accepted stage whose plan cannot place it asks the user to match it, with the brief's later work as a hint", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(BARRIER_ID, { status: "accepted", candidate_sha: "c".repeat(40) });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const associated = { path: "/p/range.md", exists: true, text: RANGE_PLAN };
    const unmatched = buildOverviewModel(selection, undefined, { ...ALL, plan: false, briefText: "# Brief\n\nMentions later Stage 3C and Stage 4 only.\n", associatedPlan: associated }, T0);
    assert.equal(unmatched.plan?.current, undefined);
    assert.equal(unmatched.plan?.next, undefined);
    assert.equal(unmatched.actions?.matchStage, true);
    assert.deepEqual(unmatched.whatsNext, {
      kind: "match",
      text: "The plan is linked, but Agent Sparring doesn't yet know where this stage belongs in it.",
      hints: ["Stage 3C — Cloud schema/RPC and sync transport", "Stage 4 — UI"],
    });
    const html = renderOverviewHtml(unmatched, "n", "c");
    assert.match(html, /<button type="button" class="primary" data-action="matchStage"[^>]*>Match this stage…<\/button><button type="button" data-action="openPlan"[^>]*>Open plan<\/button><button type="button" class="quiet" data-action="associatePlan"[^>]*>Change plan…<\/button>/);
    assert.match(html, /The brief lists later work that is in this plan: <span class="next">Stage 3C — Cloud schema\/RPC and sync transport<\/span>, <span class="next">Stage 4 — UI<\/span>\./);
    assert.ok(!html.includes("was not matched to a heading"));

    // The same brief, once it names its own stage, lets the plan place the stage without the user.
    const viaBrief = buildOverviewModel(selection, undefined, { ...ALL, plan: false, briefText: BARRIER_BRIEF, associatedPlan: associated }, T0);
    assert.equal(viaBrief.plan?.matched, "brief");
    assert.equal(viaBrief.whatsNext?.kind, "next-stage");
    assert.equal(viaBrief.whatsNext?.heading, "Stage 3C — Cloud schema/RPC and sync transport");
    assert.equal(viaBrief.whatsNext?.summary, "Cloud schema, RPC surface and the transport that carries reported statistics upward.");
    assert.equal(viaBrief.whatsNext?.start?.stageId, "stage-3c-cloud-schema-rpc-and-sync-transport");

    // And the user's own match overrides everything, is labelled as theirs, and can point at the last stage.
    const manual = buildOverviewModel(selection, undefined, { ...ALL, plan: false, briefText: BARRIER_BRIEF, associatedPlan: { ...associated, manualMatch: { label: "4", title: "UI" } } }, T0);
    assert.equal(manual.plan?.matched, "manual");
    assert.deepEqual(manual.whatsNext, { kind: "last-stage", text: "No later stage is defined in Reported statistics and explicit range semantics." });
    const manualHtml = renderOverviewHtml(manual, "n", "c");
    assert.match(manualHtml, /Current plan stage<\/h3><p class="nextstage">Stage 4 — UI<\/p><p class="muted matched">Matched manually <button type="button" class="quiet" data-action="clearMatch"[^>]*>Remove match<\/button><button type="button" class="quiet" data-action="associatePlan"[^>]*>Remove plan association<\/button>/);
    assert.match(manualHtml, /data-action="matchStage"[^>]*>Change match…<\/button>/, "Change match… stays available after matching");
    assert.ok(!manualHtml.includes("Start next stage"));

    const noHeadings = buildOverviewModel(selection, undefined, { ...ALL, plan: false, associatedPlan: { path: "/p/notes.md", exists: true, text: "just prose" } }, T0);
    assert.equal(noHeadings.actions?.matchStage, false);
    assert.equal(noHeadings.whatsNext?.kind, "match");
    assert.match(noHeadings.whatsNext?.text ?? "", /no section headings/);
    assert.ok(!renderOverviewHtml(noHeadings, "n", "c").includes("Match this stage…"), "nothing to pick from: no picker offered");
  });

  it("field reproduction: manual Stage 3B match on the handoff heading shows Stage 3B by its canonical title and offers Start next stage for 3C, never the adjacent 3A handoff", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(PERSISTENCE_ID, { status: "accepted", candidate_sha: "c".repeat(40) });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const associated = { path: "/p/reported.md", exists: true, text: FIELD_PLAN };
    const unmatched = buildOverviewModel(selection, undefined, { ...ALL, plan: false, associatedPlan: associated }, T0);
    assert.equal(unmatched.whatsNext?.kind, "match", "the id alone cannot place it: the user is asked");
    const matched = buildOverviewModel(selection, undefined, { ...ALL, plan: false, associatedPlan: { ...associated, manualMatch: { label: "3B", title: "Current stage / reviewer handoff — 2026-09-12" } } }, T0);
    assert.equal(matched.plan?.current, "Stage 3B — Local reported-statistics persistence");
    assert.equal(matched.plan?.matched, "manual");
    assert.equal(matched.plan?.currentLabel, "3B");
    assert.equal(matched.whatsNext?.kind, "next-stage");
    assert.equal(matched.whatsNext?.heading, "Stage 3C — Cloud schema and synchronization");
    assert.equal(matched.whatsNext?.summary, "Cloud schema, RPC surface and sync transport.");
    assert.equal(matched.whatsNext?.start?.stageId, "stage-3c-cloud-schema-and-synchronization");
    const html = renderOverviewHtml(matched, "n", "c");
    assert.match(html, /Current plan stage<\/h3><p class="nextstage">Stage 3B — Local reported-statistics persistence<\/p><p class="muted matched">Matched manually/);
    assert.ok(!normalUi(html).includes("reviewer handoff"), "the raw handoff heading is not the primary label");
    assert.ok(!/Stage 3A/.test(normalUi(html)), "document-adjacent Stage 3A is not up next");
    assert.match(html, /data-action="startNextStage"[^>]*>Start next stage<\/button>/);
    assert.match(html, /data-action="matchStage"[^>]*>Change match…<\/button>/);

    // 3C → 3D → 4 → nothing later, each by label.
    const at = (label: string, title: string) => buildOverviewModel(selection, undefined, { ...ALL, plan: false, associatedPlan: { ...associated, manualMatch: { label, title } } }, T0).whatsNext;
    assert.equal(at("3C", "x")?.heading, "Stage 3D — Snapshot transport");
    assert.equal(at("3D", "x")?.heading, "Stage 4 — UI");
    assert.deepEqual(at("4", "x"), { kind: "last-stage", text: "No later stage is defined in Reported statistics and explicit range semantics." });

    // A later stage defined twice is not started silently.
    const twice = `${FIELD_PLAN}\n## Stage 3C — Cloud schema and synchronization (revised)\n`;
    const unclear = buildOverviewModel(selection, undefined, { ...ALL, plan: false, associatedPlan: { path: "/p/r.md", exists: true, text: twice, manualMatch: { label: "3B", title: "x" } } }, T0);
    assert.equal(unclear.whatsNext?.kind, "next-unclear");
    assert.match(unclear.whatsNext?.text ?? "", /defines Stage 3C in more than one section/);
    assert.equal(unclear.whatsNext?.start, undefined);
    assert.ok(!renderOverviewHtml(unclear, "n", "c").includes("Start next stage"));

    // A plan without stage labels cannot order anything.
    const plain = buildOverviewModel(selection, undefined, { ...ALL, plan: false, associatedPlan: { path: "/p/n.md", exists: true, text: "# Notes\n\n## Background\n\n## Rollout\n", manualMatch: { title: "Background" } } }, T0);
    assert.equal(plain.whatsNext?.kind, "no-labels");
    assert.equal(plain.plan?.current, "Background");
  });

  it("accepted stage without a plan: Stage complete plus Choose plan… guidance, and no duplicate acceptance messaging", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(BARRIER_ID, { status: "accepted", candidate_sha: "c".repeat(40) }, { "sparring.md": sparringMarkdown("READY", "Done") });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.deepEqual(model.whatsNext, { kind: "choose", text: "This stage has been accepted. Choose a plan to see what comes next." });
    assert.equal(model.banner, undefined);
    const html = renderOverviewHtml(model, "n", "c");
    const visible = normalUi(html);
    assert.match(html, /<span class="hpill good"><svg[^>]*>.*?<\/svg>Accepted<\/span>/, "the compact status badge");
    assert.equal((visible.match(/>Accepted</g) ?? []).length, 1, "Accepted appears once: in the badge");
    assert.equal((visible.match(/Stage complete/g) ?? []).length, 1, "one Stage complete confirmation");
    assert.ok(!visible.includes("Accepted · Stage complete"), "no repeated pairing under the heading");
    assert.match(html, /<div class="substatus"><span class="complete">Stage complete\.<\/span><\/div>/);
    assert.match(html, /What's next<\/h3><p class="">This stage has been accepted\. Choose a plan to see what comes next\.<\/p><div class="actions"><button type="button" class="primary" data-action="associatePlan"[^>]*>Choose plan…<\/button><\/div>/);
    assert.equal((html.match(/>Choose plan…</g) ?? []).length, 1, "the button lives in What's next, not also in the toolbar");
    assert.ok(!/frozen|FROZEN|candidate lifecycle|plan-state/i.test(visible.replace(/Candidate<\/dt>/, "")), "no engine internals in the normal UI");
  });

  it("an associated file that is missing degrades honestly", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-other", { status: "accepted", candidate_sha: "c".repeat(40) });
    const missing = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, associatedPlan: { path: "/gone/plan.md", exists: false } }, T0);
    assert.equal(missing.actions?.plan, false);
    assert.equal(missing.actions?.changePlan, true);
    assert.equal(missing.actions?.matchStage, false);
    assert.match(missing.plan?.note ?? "", /currently missing/);
    assert.deepEqual(missing.whatsNext, { kind: "missing-plan", text: "The linked plan file (plan.md) is missing. Choose another plan to see what comes next." });
    const html = renderOverviewHtml(missing, "n", "c");
    assert.match(html, /<button type="button" class="primary" data-action="associatePlan"[^>]*>Choose plan…<\/button>/);
    assert.ok(!html.includes("/gone/plan.md"), "no filesystem paths");
  });

  it("a managed plan run keeps its authoritative journey; an accepted current stage gets What's next with Continue plan and the engine's next stage", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 1, current_stage: FOO_STAGE_IDS[1] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted", candidate_sha: "c".repeat(40) });
    await ws.writeStage(FOO_STAGE_IDS[1], { status: "accepted", candidate_sha: "d".repeat(40) });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, planText: FOO_PLAN_MARKDOWN }, T0);
    assert.equal(model.runKind, "Plan run");
    assert.equal(model.actions?.plan, true);
    assert.equal(model.actions?.choosePlan, false);
    assert.equal(model.actions?.changePlan, false);
    assert.equal(model.actions?.matchStage, false, "the engine records the position; nothing to match by hand");
    assert.equal(model.plan?.source, "managed");
    assert.deepEqual(model.plan?.next, { display: "Stage 3 — Device/UI check!", label: "3", line: 15, summary: "Manual check.", defined: true });
    assert.deepEqual(model.planAction, { kind: "continue", label: "Continue plan", primary: true, detail: "sparring resume-plan: the accepted stage is advanced past and the next stage starts." });
    assert.equal(model.stageLine, "Stage complete. Continue plan starts the next stage.");
    assert.deepEqual(model.whatsNext, { kind: "continue", heading: "Stage 3 — Device/UI check!", summary: "Manual check.", text: "Continue plan starts it." });
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /What's next<\/h3><p class="nextstage">Stage 3 — Device\/UI check!<\/p><p class="muted summary">Manual check\.<\/p><p class="muted">Continue plan starts it\.<\/p><div class="actions"><button type="button" class="primary" data-action="continueAutomatically"[^>]*>Continue automatically<\/button><button type="button" data-action="resumePlan" [^>]*>Continue plan<\/button><button type="button" data-action="openNextStage"[^>]*>Open in plan<\/button><\/div>/);
    assert.equal((html.match(/>Continue plan</g) ?? []).length, 1, "one Continue plan button, in What's next");
    assert.ok(!html.includes('data-action="associatePlan"'));
    assert.ok(!html.includes('data-action="matchStage"'));
    assert.ok(html.includes('class="journey"'));

    // Without the document text the engine's heading is still shown; only the summary and line are unavailable.
    const noText = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.deepEqual(noText.plan?.next, { display: "Stage 3 — Device/UI check!", label: "3", line: 0, summary: undefined, defined: true });
    assert.match(renderOverviewHtml(noText, "n", "c"), /<button type="button" data-action="openPlan"[^>]*>Open in plan<\/button>/);
  });

  it("a managed run whose last stage is accepted but not yet complete says so; a complete run has no What's next", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    await ws.writeStage(FOO_STAGE_IDS[2], { status: "accepted", candidate_sha: "c".repeat(40) });
    const last = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.deepEqual(last.whatsNext, { kind: "last-managed", text: "No stage follows this one in the plan. Continue plan hands the finished run back to the engine." });
    assert.match(renderOverviewHtml(last, "n", "c"), /<button type="button" data-action="resumePlan" [^>]*>Continue plan<\/button>/);
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    const complete = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(complete.whatsNext, undefined);
    assert.equal(complete.planAction, undefined);
    assert.equal(complete.banner?.kind, "done");
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
    assert.equal(working.whatsNext, undefined);
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    const paused = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.deepEqual(paused.planAction && [paused.planAction.kind, paused.planAction.label, paused.planAction.primary], ["resume", "Resume plan", true]);
    assert.match(renderOverviewHtml(paused, "n", "c"), /<div class="actions"><button type="button" class="primary" data-action="continueAutomatically"[^>]*><\/button>|<div class="actions"><button type="button" class="primary" data-action="continueAutomatically"[^>]*>Continue automatically<\/button><button type="button" data-action="resumePlan"/, "not accepted: the plan action stays in the toolbar, behind Continue automatically");
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
