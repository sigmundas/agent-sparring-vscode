/**
 * Pass / Fail / Blocked comes from the reviewer's structured `human_gate`,
 * and from nothing else.
 *
 * The regression this file is built around is the real Stage 3D review: one
 * pre-activation desktop test that genuinely blocks the stage, stated in the
 * same breath as production deployment (the release owner's, after
 * acceptance) and the rollout gates (a later release decision). Mined from
 * prose that reads as three checks and asks a human to "pass" two things
 * acceptance does not depend on. Structured, it is one check.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER, parseHumanGate, parseSparringOutcome } from "../core/engineFormats";
import { checkKey, deriveVerification, parseHumanEvidence, renderHumanEvidence, submittableChecks, type CheckRecord } from "../core/humanChecks";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { Workspace, normalUi } from "./fixtures";

const NOW = Date.parse("2026-09-14T10:00:00.000Z");
const STAGE_ID = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const BRANCH = "feature/reported-statistics-contract";
const CHECK_ID = "pre-activation-desktop-v2-feed";

const INSTRUCTION =
  "Run a desktop build with the enhanced-content feature switched off, sync it against an account whose feed already contains a snapshot v2 reference, and open the reference library.";
const PASS_CRITERIA = "The library loads, the v2 reference appears with its legacy values, and no error or data loss is reported in the sync log.";
const SOURCE = "docs/plans/active/reported-statistics.md > Stage 3D — Snapshot v2 and attachment/export/import transport";

/** What sparring_exchange.py renders for the Stage 3D verdict. */
function sparringWithGate(checks = [{ id: CHECK_ID, instruction: INSTRUCTION, pass_criteria: PASS_CRITERIA, source: SOURCE }]): string {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "A pre-activation desktop must survive a feed containing snapshot v2", checks };
  return [
    "# Sparring: x",
    "",
    "## Finding / discussion",
    "",
    "Snapshot v2 emission and preserve-or-reject all check out against the diff.",
    "Separately, and after acceptance: applying the migration in production remains the",
    "release owner's action, and the two rollout gates stay closed until a later release",
    "decision. Neither of those blocks this stage.",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: One pre-activation compatibility test is required before this stage is READY.",
    "- Needs-you reason: DEVICE/MANUAL CHECK -- a pre-activation desktop build against a v2 feed",
    "",
    "## SEND BACK TO STAGE",
    "",
    "(not applicable)",
    "",
    "## NEEDS YOU",
    "",
    "One pre-activation compatibility test is required before this stage is READY.",
    "",
    "Reason category: DEVICE/MANUAL CHECK -- a pre-activation desktop build against a v2 feed",
    "",
    `**Required before this stage can be READY** — ${gate.category} — ${gate.title}`,
    "",
    ...checks.flatMap((check, at) => [`${at + 1}. ${check.instruction}`, `   - Pass when: ${check.pass_criteria}`, ...(check.source ? [`   - Defined in: ${check.source}`] : []), `   - Check id: \`${check.id}\``]),
    "",
    HUMAN_GATE_MARKER,
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
    "## ESCALATE",
    "",
    "(not applicable)",
    "",
    "## READY",
    "",
    "(not applicable)",
    "",
    "## Deferred",
    "",
    "Production deployment of the migration, and the rollout/activation decision, both",
    "belong to the release owner after this stage is accepted.",
    "",
  ].join("\n");
}

/** The plan the stage belongs to; deliberately full of human-worded prose the old path would have mined. */
const PLAN = [
  "# Reported statistics",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "### Verification expectations",
  "",
  "- Human-gated under AGENTS.md: live cloud/CAS/cross-client behaviour.",
  "- Manual: deploy the migration and observe the rollout gates.",
  "",
  "## Stage 4 — Next",
  "",
].join("\n");

async function stage(options: { sparring?: string; notes?: string; drafts?: Record<string, CheckRecord> } = {}) {
  const ws = await Workspace.create();
  await ws.writeStage(STAGE_ID, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar", base_sha: "d".repeat(40) }, { "sparring.md": options.sparring ?? sparringWithGate() });
  const planPath = path.join(ws.root, "docs", "plan.md");
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const artifacts: OverviewArtifacts = {
    handoff: false,
    sparring: true,
    brief: false,
    plan: false,
    git: { branch: BRANCH, head: "cccccccc" },
    associatedPlan: { path: planPath, exists: true, text: PLAN, manualMatch: { label: "3D", title: "Snapshot v2 and attachment/export/import transport" } },
    humanChecks: options.drafts ?? {},
    notesText: options.notes,
  };
  return { ws, model: buildOverviewModel(selection, undefined, artifacts, NOW) };
}

describe("reading the structured gate out of sparring.md", () => {
  it("parses the JSON behind the marker, not the prose above it", () => {
    const outcome = parseSparringOutcome(sparringWithGate())!;
    assert.equal(outcome.action, "NEEDS_YOU");
    assert.deepEqual(outcome.humanGate, {
      category: "DEVICE_MANUAL_CHECK",
      title: "A pre-activation desktop must survive a feed containing snapshot v2",
      checks: [{ id: CHECK_ID, instruction: INSTRUCTION, passCriteria: PASS_CRITERIA, source: SOURCE }],
    });
  });

  it("a result recorded before gates existed simply has none", () => {
    const outcome = parseSparringOutcome(sparringWithGate().split(HUMAN_GATE_MARKER)[0])!;
    assert.equal(outcome.humanGate, undefined);
    assert.equal(outcome.action, "NEEDS_YOU");
  });

  it("a malformed or truncated block yields nothing rather than a half-read gate", () => {
    assert.equal(parseHumanGate(`${HUMAN_GATE_MARKER}\n\n\`\`\`json\n{ not json\n\`\`\`\n`), undefined);
    assert.equal(parseHumanGate(`${HUMAN_GATE_MARKER}\n\n\`\`\`json\n{"category":"OTHER","title":"t","checks":[]}\n\`\`\`\n`), undefined);
    assert.equal(parseHumanGate(`${HUMAN_GATE_MARKER}\n\n\`\`\`json\n{"category":"OTHER","title":"t","checks":[{"id":"a"}]}\n\`\`\`\n`), undefined);
    assert.equal(parseHumanGate("no marker here"), undefined);
  });
});

describe("the Stage 3D pattern: exactly one control", () => {
  it("renders one check — the desktop test — and nothing the reviewer said about after acceptance", async () => {
    const { model } = await stage();
    const panel = model.actionRequired!;
    assert.equal(panel.source, "gate");
    assert.equal(panel.gate?.category, "DEVICE_MANUAL_CHECK");
    assert.equal(panel.required.length, 1);
    assert.equal(panel.recorded.length, 0);
    const check = panel.required[0];
    assert.equal(check.key, CHECK_ID, "the reviewer's stable id is the draft key");
    assert.equal(check.origin, "gate");
    assert.equal(check.text, INSTRUCTION);
    assert.equal(check.passCriteria, PASS_CRITERIA);
    assert.equal(check.source, SOURCE);
    assert.equal(panel.progress, "0 / 1 verified · 1 remaining");

    const html = renderOverviewHtml(model, "n", "c");
    assert.equal((html.match(/data-outcome="pass"/g) ?? []).length, 1, "one Pass control, for one check");
    assert.match(html, /<p class="passif"><span class="lead">Pass if:<\/span> The library loads/);
    // Where the test is defined is provenance: kept, one disclosure away.
    assert.match(html, /<dt>Check defined in<\/dt><dd>docs\/plans\/active\/reported-statistics\.md/);
    const visible = normalUi(html);
    assert.ok(!/Apply\/deploy|deploy the migration/i.test(visible), "deployment is not offered as a check to pass");
    assert.ok(!/rollout gate/i.test(visible), "nor is a rollout decision");
  });

  it("ignores the plan's own human-worded prose entirely: the reviewer already said what blocks the stage", async () => {
    const { model } = await stage();
    const panel = model.actionRequired!;
    assert.equal(panel.explicitCount, 0);
    assert.equal(panel.reviewerCount, 0);
    assert.deepEqual(panel.parents, []);
    assert.ok(
      !panel.required.some((item) => item.text.includes("AGENTS.md")),
      "the plan's 'Human-gated under AGENTS.md' bullet is not a check here",
    );
    assert.match(renderOverviewHtml(model, "n", "c"), /<p class="gatetitle">A pre-activation desktop must survive a feed containing snapshot v2<\/p>/);
  });

  it("recording it makes the evidence complete and enables Submit for review", async () => {
    const { model } = await stage({ drafts: { [CHECK_ID]: { outcome: "pass", note: "Ran it on a 2026.8 build." } } });
    const panel = model.actionRequired!;
    assert.equal(panel.ready, true);
    assert.equal(panel.headline, "Evidence ready for review");
    assert.equal(panel.submit.enabled, true);
    assert.equal(panel.progress, "1 / 1 verified");
    const entry = renderHumanEvidence(submittableChecks(panel), new Date(NOW))!;
    assert.match(entry, new RegExp(`- Pass — ${INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · check \`${CHECK_ID}\``));
    assert.match(entry, /\n {2}Ran it on a 2026\.8 build\./);
  });

  it("a recorded result is found again by its id even after the reviewer rewords the check", async () => {
    const entry = renderHumanEvidence([{ text: INSTRUCTION, origin: "gate", id: CHECK_ID, record: { outcome: "pass" } }], new Date(NOW))!;
    const reworded = sparringWithGate([{ id: CHECK_ID, instruction: "Test a pre-activation desktop against a v2 feed.", pass_criteria: "No error.", source: null as unknown as string }]);
    const { model } = await stage({ sparring: reworded, notes: `# Notes\n\n## Human evidence\n\n${entry}\n` });
    const panel = model.actionRequired!;
    assert.equal(panel.required.length, 0, "nothing outstanding: the id says this was already done");
    assert.equal(panel.recorded.length, 1);
    assert.equal(panel.recorded[0].evidence?.how, "id");
    assert.equal(panel.recorded[0].evidence?.outcome, "pass");
  });

  it("evidence recorded before gates existed still counts, by its wording", async () => {
    const legacy = ["# Notes", "", "## Human evidence", "", `- Pass — ${INSTRUCTION}`, ""].join("\n");
    const { model } = await stage({ notes: legacy });
    const panel = model.actionRequired!;
    assert.equal(panel.recorded.length, 1);
    assert.equal(panel.recorded[0].evidence?.how, "exact");
  });

  it("two checks yield two controls, in the reviewer's order", async () => {
    const { model } = await stage({
      sparring: sparringWithGate([
        { id: "a-first", instruction: "Do the first thing.", pass_criteria: "It worked.", source: null as unknown as string },
        { id: "b-second", instruction: "Do the second thing.", pass_criteria: "It also worked.", source: null as unknown as string },
      ]),
    });
    assert.deepEqual(
      model.actionRequired!.required.map((item) => item.key),
      ["a-first", "b-second"],
    );
  });
});

describe("without a structured gate the legacy derivation still applies", () => {
  it("a result recorded before gates existed falls back to plan and reviewer prose", () => {
    const outcome = parseSparringOutcome(sparringWithGate().split(HUMAN_GATE_MARKER)[0])!;
    const view = deriveVerification({ explicit: [], parents: [{ key: checkKey("Human-gated under AGENTS.md: live cloud behaviour."), text: "Human-gated under AGENTS.md: live cloud behaviour.", line: 7 }] }, outcome, parseHumanEvidence(undefined), {});
    assert.equal(view.source, "derived");
    assert.equal(view.gate, undefined);
    assert.ok(view.required.length > 0, "the old path still produces something to record");
    assert.ok(view.required.every((item) => item.origin !== "gate"));
  });
});
