/**
 * What a person sees when Agent Sparring stops and asks them for something.
 *
 * The screen these tests describe used to carry, for one manual check:
 * "Action required", a reviewer headline, a reviewer note, "Manual
 * verification", "WHAT THE REVIEWER REQUIRES", a category-and-count
 * sentence, "EVIDENCE ALREADY RECORDED" saying there was none, "STILL
 * REQUIRED", the instruction, its pass criteria, and the plan path — nine
 * levels of hierarchy for one task. The four questions a person actually
 * arrives with are: why did it stop, what do I do, what counts as a pass,
 * how do I continue.
 *
 * Nothing was deleted to answer them: the reviewer's verbatim wording, the
 * gate's category and check id, the plan source and the engine's own routing
 * word all moved one disclosure down, into "Show technical details".
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { humanTask, sentences, splitPassCriteria } from "../core/humanTask";
import { parseExecutionManifest } from "../core/manifest";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type ManifestStageView, type OverviewArtifacts } from "../core/overviewModel";
import { Workspace, normalUi } from "./fixtures";

const NOW = Date.parse("2026-09-14T18:00:00.000Z");
const STAGE_3D = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_KEY = "reported-statistics-1cd13d24";
const BRANCH = "feature/reported-statistics-contract";
const CHECK_ID = "pre-activation-desktop-v2-feed";

/** The real Stage 3D check: long, precise, and written as one paragraph. */
const INSTRUCTION = [
  "Run the oldest desktop build that will remain supported when the reader gate opens, with enhanced attachment emission still disabled.",
  "Using only a synthetic test account, provide a complete cloud observation-use feed containing ordinary rows and at least one valid schema_version 2 snapshot whose measurement_details is top-level and whose q_core_min/q_core_max are inside measurements.",
  "Run the normal cloud pull, then inspect the synchronized use and the other feed rows.",
].join(" ");
const PASS_CRITERIA =
  "Pass if the complete pull succeeds, ordinary rows reconcile normally, and the v2 snapshot is retained without losing or relocating its extension fields. Fail if the whole feed is rejected as unsupported, the v2 use is omitted, or measurement_details/q_core values are stripped or altered.";
const GATE_TITLE = "Confirm the supported pre-activation desktop reads snapshot-v2 feeds safely";
const SOURCE = "docs/reference-data/measurement-content-contract.md — 7. Snapshot version 2 (blocker 3), rollout step 1";
const SUMMARY = "Both repository candidates satisfy the Stage 3D implementation scope; the required real-desktop v2 feed compatibility check is the sole acceptance blocker.";
const REVIEWER_NOTE = "DEVICE/MANUAL CHECK -- verify the oldest supported pre-activation desktop accepts a complete observation-use feed containing snapshot v2.";

function sparringWithGate(): string {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: GATE_TITLE, checks: [{ id: CHECK_ID, instruction: INSTRUCTION, pass_criteria: PASS_CRITERIA, source: SOURCE }] };
  return [
    "# Sparring: stage 3d",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    `- Summary: ${SUMMARY}`,
    `- Needs-you reason: ${REVIEWER_NOTE}`,
    "",
    "## NEEDS YOU",
    "",
    HUMAN_GATE_MARKER,
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
  ].join("\n");
}

/** The plan as a human wrote it: `3A`/`3D` labels, which the engine's own `## Stage <n>` parser cannot read. */
const PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "Owns the frozen-evidence representation of enhanced content and the gates that protect old readers.",
  "",
  "## Stage 4 — Editor and plotting",
  "",
  "Later work.",
  "",
].join("\n");

const MANIFEST_STAGES: ManifestStageView[] = [
  { stageId: "stage-reported-statistics-contract", label: "Stage 1", title: "Contract and compatibility fixtures", status: "accepted" },
  { stageId: "stage-reported-statistics-typed-parser", label: "Stage 2", title: "Typed contract and parser specification", status: "accepted" },
  { stageId: "stage-3a-local-schema-barrier", label: "Stage 3A", title: "Local schema barrier", status: "accepted" },
  { stageId: "stage-3b-local-persistence", label: "Stage 3B", title: "Local persistence", status: "accepted" },
  { stageId: "stage-3c-cloud-schema-rpc-and-sync-transport", label: "Stage 3C", title: "Cloud schema/RPC and sync transport", status: "accepted" },
  { stageId: STAGE_3D, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport", status: "working" },
  { stageId: "stage-4-editor-and-plotting", label: "Stage 4", title: "Editor and plotting" },
  { stageId: "stage-5-matching", label: "Stage 5", title: "Matching" },
];

/** The managed run as it stands after adoption: a manifest plan run, paused at Stage 3D's gate. */
async function managedStage3d(options: { brief?: string; notes?: string; drafts?: OverviewArtifacts["humanChecks"]; manifest?: ManifestStageView[] | undefined } = {}) {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 5, current_stage: STAGE_3D, expected_branch: BRANCH, source: "manifest" });
  await ws.writeStage(
    STAGE_3D,
    { status: "working", implementation_session_id: "ef8449bb-b38f", sparring_session_id: "01a09eb0-9e4c", base_sha: "3c0f65b5".padEnd(40, "0") },
    { "sparring.md": sparringWithGate(), ...(options.brief === undefined ? {} : { "brief.md": options.brief }) },
  );
  const artifacts: OverviewArtifacts = {
    handoff: false,
    sparring: true,
    brief: options.brief !== undefined,
    briefText: options.brief,
    plan: true,
    planText: PLAN,
    git: { branch: BRANCH, head: "9b99189a" },
    humanChecks: options.drafts ?? {},
    notesText: options.notes,
    manifestStages: "manifest" in options ? options.manifest : MANIFEST_STAGES,
  };
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const model = buildOverviewModel(selection, undefined, artifacts, NOW);
  return { ws, model, html: renderOverviewHtml(model, "n", "c") };
}

describe("laying one structured check out as a task", () => {
  it("splits the instruction into its own sentences and drops nothing", () => {
    const task = humanTask({ text: INSTRUCTION, passCriteria: PASS_CRITERIA });
    assert.equal(task.steps.length, 3);
    assert.match(task.steps[0], /^Run the oldest desktop build/);
    assert.match(task.steps[2], /^Run the normal cloud pull/);
    assert.equal(task.steps.join(" "), INSTRUCTION, "every word survives the layout");
  });

  it("says what a pass is without the reviewer's lead-in, and keeps the failure wording separately", () => {
    const { passIf, failIf } = splitPassCriteria(PASS_CRITERIA);
    assert.equal(passIf, "The complete pull succeeds, ordinary rows reconcile normally, and the v2 snapshot is retained without losing or relocating its extension fields.");
    assert.match(failIf ?? "", /^Fail if the whole feed is rejected/);
    assert.equal(`Pass if ${passIf?.charAt(0).toLowerCase()}${passIf?.slice(1)} ${failIf}`, PASS_CRITERIA, "the split is a split, not a rewrite");
  });

  it("criteria with no lead-in and no failure sentence are the pass line unchanged", () => {
    assert.deepEqual(splitPassCriteria("The library loads and the reference appears."), { passIf: "The library loads and the reference appears.", failIf: undefined });
    assert.deepEqual(splitPassCriteria(undefined), {});
    assert.deepEqual(splitPassCriteria("   "), {});
    assert.deepEqual(sentences("One. Two."), ["One.", "Two."]);
    assert.deepEqual(sentences("A file like x.sql does not end a sentence."), ["A file like x.sql does not end a sentence."]);
  });
});

describe("the NEEDS_YOU panel a person reads", () => {
  it("one gate check is one task: the requirement once, the steps, one pass line, three results", async () => {
    const { model, html } = await managedStage3d();
    const panel = model.actionRequired!;
    assert.equal(panel.headline, "Manual check required");
    assert.equal(panel.gateTitle, GATE_TITLE);
    assert.equal(panel.required.length, 1);
    assert.match(html, /<h2><svg class="icon needs_you"[^>]*>.*?<\/svg>Manual check required<\/h2>/);
    assert.match(html, new RegExp(`<p class="gatetitle">${GATE_TITLE}</p>`));
    assert.match(html, /<ol class="steps"><li>Run the oldest desktop build[^<]*<\/li><li>Using only a synthetic test account/);
    assert.match(html, /<p class="passif"><span class="lead">Pass if:<\/span> The complete pull succeeds/);
    assert.equal((html.match(/data-outcome="pass"/g) ?? []).length, 1, "one set of controls, for one check");
    assert.match(html, /data-outcome="blocked"[^>]*>Can't test<\/button>/, "Blocked is the engine's word; what it means to a person is that they could not test it");
  });

  it("why it stopped is one sentence, and the reviewer's own note is not repeated under it", async () => {
    const { html } = await managedStage3d();
    const ui = normalUi(html);
    assert.match(html, new RegExp(`<p class="summary">${SUMMARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
    assert.ok(!ui.includes("DEVICE/MANUAL CHECK"), "the reviewer's category prose restates the gate title; it is in the details");
    assert.equal((ui.match(/Manual check required/g) ?? []).length, 1);
  });

  it("no leftover hierarchy: no second Manual verification heading, no Still required, no counts", async () => {
    const ui = normalUi((await managedStage3d()).html);
    for (const gone of ["Manual verification", "What the reviewer requires", "Still required", "Evidence already recorded", "exactly as the reviewer listed them", "Device manual check"]) {
      assert.ok(!ui.includes(gone), `${gone} is not part of one human task`);
    }
    assert.ok(!/0 \/ 1 verified/.test(ui), "a single check has no progress worth reporting");
  });

  it("with no recorded evidence there is no evidence section at all", async () => {
    const { html } = await managedStage3d();
    assert.ok(!html.includes("Previous evidence"));
    assert.ok(!html.includes("Nothing under ## Human evidence"), "an empty section is not a section");
  });

  it("recorded evidence is one compact, expandable line", async () => {
    const notes = ["# Notes", "", "## Human evidence", "", `- Pass — ${INSTRUCTION} · check \`${CHECK_ID}\``, "  Ran it on the 2026.4 build.", ""].join("\n");
    const { model, html } = await managedStage3d({ notes });
    assert.equal(model.actionRequired!.recorded.length, 1);
    assert.match(html, /<details class="prev"><summary>Previous evidence \(1\)<\/summary><ol class="checklist recorded">/);
    assert.match(html, /Every check the reviewer asked for has a recorded result\./);
  });

  it("the reviewer's exact words, the gate id, the category and the plan source are all still there, one disclosure down", async () => {
    const { html } = await managedStage3d();
    const tech = /<details class="tech"><summary>Show technical details<\/summary>([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    assert.ok(tech, "the technical layer exists");
    for (const kept of ["NEEDS_YOU", "DEVICE_MANUAL_CHECK", CHECK_ID, GATE_TITLE, REVIEWER_NOTE, SOURCE, "Fail if the whole feed is rejected as unsupported"]) {
      assert.ok(tech.includes(kept.replace(/&/g, "&amp;")), `${kept} is kept in the technical details`);
    }
    assert.match(tech, /<dt>Check instruction, verbatim<\/dt><dd>Run the oldest desktop build/, "the instruction verbatim, not only as steps");
    assert.match(tech, /<dt>Plan<\/dt><dd>Reported statistics and explicit range semantics, line 3<\/dd>/);
  });

  it("in a managed plan the button says what the person is doing, and implementation resume is not beside it", async () => {
    const { model, html } = await managedStage3d();
    assert.equal(model.actionRequired!.submit.label, "Submit result and continue");
    assert.match(html, /class="primary" data-action="submitForReview"[^>]*>Submit result and continue</);
    const answered = await managedStage3d({ drafts: { [CHECK_ID]: { outcome: "pass", note: "Ran it on the 2026.4 build." } } });
    assert.equal(answered.model.actionRequired!.submit.enabled, true);
    assert.match(answered.html, /title="[^"]*resume-plan --evidence[^"]*"[^>]*>Submit result and continue</, "the tooltip still says who reads the evidence");
    assert.ok(html.indexOf('data-action="submitForReview"') < html.indexOf('<details class="more">'), "the primary action comes first");
    assert.match(html, /<details class="more"><summary[^>]*>…<\/summary><div class="actions"><button type="button" class="quiet" data-action="resumePlan"/);
  });
});

describe("a stage is called what the plan calls it", () => {
  it("Stage 3D, with its position as secondary metadata", async () => {
    const { model, html } = await managedStage3d();
    assert.equal(model.stageLabel, "Stage 3D");
    assert.equal(model.stageHeading, "Stage 3D — Snapshot v2 and attachment/export/import transport");
    assert.equal(model.positionNote, "6 of 8");
    assert.equal(model.position, "Stage 6 of 8", "the ordinal is still recorded, for the tooltip");
    assert.match(html, /<span class="hpill" title="Stage 6 of 8">Stage 3D<\/span>/);
    assert.match(html, /<h2 [^>]*>.*?<\/svg>Stage 3D — Snapshot v2 and attachment\/export\/import transport<\/h2>/);
    assert.match(html, /<div class="substatus"><span class="muted" title="Stage 6 of 8">6 of 8<\/span>/);
    assert.ok(!/Stage 6 — /.test(normalUi(html)), "the manifest ordinal never wears the stage's name");
  });

  it("the journey is the manifest's stages, each with the status the engine recorded", async () => {
    const { model, html } = await managedStage3d();
    assert.deepEqual(
      model.timeline?.map((item) => [item.label, item.state, item.current]),
      [
        ["1", "accepted", false],
        ["2", "accepted", false],
        ["3A", "accepted", false],
        ["3B", "accepted", false],
        ["3C", "accepted", false],
        ["3D", "paused", true],
        ["4", "future", false],
        ["5", "future", false],
      ],
    );
    assert.equal(model.timelineNote, undefined, "no explanation of why there is no journey: there is one");
    assert.match(html, /<li class="step paused current" title="Stage 3D — Snapshot v2 and attachment\/export\/import transport \(Paused\) · 6 of 8">/);
    assert.match(html, /<span class="num">3D<\/span>/);
  });

  it("without the manifest nothing is invented: the recorded stage, and a plain note", async () => {
    const { model, html } = await managedStage3d({ manifest: undefined });
    assert.equal(model.timeline, undefined);
    assert.equal(model.stageLabel, undefined);
    assert.match(model.timelineNote ?? "", /^This run executes an execution manifest; its own list of stages could not be read here/);
    assert.ok(!/does not follow|looks like a stage heading/.test(html), "the Markdown parser's complaint is not the user's problem");
  });

  it("a manifest that no longer contains the recorded stage is ignored rather than half-believed", async () => {
    const { model } = await managedStage3d({ manifest: MANIFEST_STAGES.filter((stage) => stage.stageId !== STAGE_3D) });
    assert.equal(model.timeline, undefined);
    assert.equal(model.stageLabel, undefined);
  });

  it("reading a manifest back is strict about what it will believe", () => {
    const good = JSON.stringify({ version: 1, plan_label: "p.md", source_digest: "sha256:x", stages: [{ stage_id: "s1", label: "Stage 1", title: "One", brief: "…" }] });
    assert.deepEqual(parseExecutionManifest(good)?.identity.stages, [{ stageId: "s1", label: "Stage 1", title: "One" }]);
    assert.equal(parseExecutionManifest(undefined), undefined);
    assert.equal(parseExecutionManifest("{ not json"), undefined);
    assert.equal(parseExecutionManifest(JSON.stringify({ version: 2, plan_label: "p.md", source_digest: "x", stages: [{ stage_id: "s", label: "l", title: "t", brief: "b" }] })), undefined, "a later shape is not guessed at");
    assert.equal(parseExecutionManifest(JSON.stringify({ version: 1, plan_label: "p.md", source_digest: "x", stages: [] })), undefined);
    assert.equal(parseExecutionManifest(JSON.stringify({ version: 1, plan_label: "p.md", source_digest: "x", stages: [{ stage_id: "s", title: "t", brief: "b" }] })), undefined, "a stage without a label is a half-read journey");
    assert.equal(parseExecutionManifest(JSON.stringify({ version: 1, stages: [{ stage_id: "s", label: "l", title: "t", brief: "b" }] })), undefined, "and one without the fields that say whose it is");
  });

  it("the Overview panel reads that file for the run it is showing, through the one cached reader", async () => {
    const panel = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8");
    const body = /private async manifestStages[\s\S]*?\n {2}}\n/.exec(panel)?.[0] ?? "";
    assert.ok(body, "manifestStages exists");
    assert.match(body, /this\.controller\.manifestStagesFor\(run\)/, "the identities come from the controller's cached read");
    assert.match(body, /recordedStatus\(path\.join\(run\.location\.sparringDir, STAGES_DIRNAME, stage\.stageId, STATE_FILENAME\)\)/, "each status is the stage's own state.json");

    // The controller owns that read because the run picker needs it too (plan
    // membership), and a manifest is the largest file either surface touches.
    const controller = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
    const reader = /async manifestStagesFor[\s\S]*?\n {2}}\n/.exec(controller)?.[0] ?? "";
    assert.ok(reader, "manifestStagesFor exists");
    assert.match(reader, /run\.state\.source !== "manifest"/, "only a manifest run has one");
    assert.match(reader, /this\.manifests\.readBound\(this\.manifestDirectoryPath, run, peers\)/, "through the one reader that binds a manifest to the run asking for it");

    // The reader caches the bytes and re-derives the binding every call, so a
    // cache can never become an authority of its own.
    const manifestReader = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "manifestReader.ts"), "utf8");
    assert.match(manifestReader, /manifestPathFor\(directory, run\)/, "the file is the one scoped to this run's own project");
    assert.match(manifestReader, /readCached\(this\.manifests, current, \(text\) => parseExecutionManifest\(text\)\)/, "the parse is cached, because a manifest is the largest file either surface reads");
    assert.match(
      manifestReader,
      /const expect = manifestExpectationFor\(run\);/,
      "and what the manifest must match is derived from this run, on this call, before any of it is believed",
    );
    assert.ok(!/CachedFile<Manifest(Binding|Stage)/.test(manifestReader.replace(/ManifestBindingRecord/g, "")), "nothing bound is ever what is cached");
    // A sidecar that exists is still the only thing that can satisfy the
    // strict path: the legacy derivation is opened by its *absence*, never by
    // its disagreeing.
    assert.match(manifestReader, /if \(binding\) \{\n\s*return \{ binding: bindParsedManifest\(parsed, binding, expect\)/, "a present sidecar goes through the unchanged strict binding");
  });
});

describe("the Goal never complains about Markdown", () => {
  it("a brief with no ## Goal falls back to its own opening description", async () => {
    const brief = ["# Stage brief: stage-3d-snapshot-v2-and-attachment-export-import-transport", "", "Stage 3D from plan `reported-statistics.md`. Implement only this section; the other stages are separate.", "", "## Stage 3D — Snapshot v2 and attachment/export/import transport", "", "Owns the frozen-evidence representation of enhanced content and the gates that protect old readers.", "", "- A bullet is not a description.", ""].join("\n");
    const { model, html } = await managedStage3d({ brief });
    assert.equal(model.goal, "Owns the frozen-evidence representation of enhanced content and the gates that protect old readers.", "the embedded plan section, not the provenance line");
    assert.match(html, /Goal<\/h3><p class="goal">Owns the frozen-evidence/);
    assert.ok(!html.includes("## Goal"));
  });

  it("a brief with nothing to say leaves the Goal out entirely", async () => {
    const { model, html } = await managedStage3d({ brief: "# Stage brief: x\n" });
    assert.equal(model.goal, "Owns the frozen-evidence representation of enhanced content and the gates that protect old readers.", "the plan section for this stage is the last resort");
    assert.ok(!/has no ## Goal/.test(html));
  });
});

describe("warning colours come from the theme, not from a chart palette", () => {
  it("the warn tokens are semantic VS Code variables, and the pill pairs a tinted ground with ordinary text", () => {
    const html = renderOverviewHtml({ kind: "run", title: "x" }, "n", "c");
    const style = /<style nonce="n">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    assert.match(style, /--warn: var\(--vscode-notificationsWarningIcon-foreground, var\(--vscode-editorWarning-foreground, var\(--vscode-charts-orange\)\)\);/);
    assert.match(style, /--warn-surface: var\(--vscode-inputValidation-warningBackground, transparent\);/);
    assert.match(style, /--warn-border: var\(--vscode-inputValidation-warningBorder, var\(--warn\)\);/);
    assert.match(style, /\.hpill\.warn \{ color: var\(--vscode-foreground\); border-color: var\(--warn-border\); background: var\(--warn-surface\);/);
    assert.match(style, /\.hpill\.warn \.icon \{ color: var\(--warn\); \}/);
    // Nothing in the sheet is a fixed colour: every value resolves through the theme.
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(style), "no hard-coded hex colour");
  });
});

describe("reviewing stage matches ends when there is nothing left to place", () => {
  it("says so, offers Done, and closes instead of reopening the list", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function reviewStageMatchesCommand[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.ok(body, "reviewStageMatchesCommand exists");
    assert.match(body, /placeHolder: problems === 0 \? "All stages are matched\. Select one only if you want to change it\."/);
    assert.match(body, /label: "\$\(check-all\) Done"/);
    assert.match(body, /if \(!picked \|\| picked\.done \|\| !picked\.row\) \{\s*return;/);
    assert.match(body, /if \(fixing && problems === 0\) \{[\s\S]*?every stage is now matched[\s\S]*?return;/, "fixing the last one returns to the Overview");
  });
});
