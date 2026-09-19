/**
 * "Can't test" is its own answer, and the panel says so.
 *
 * The reported case: a Stage 2 gate with five checks, all five marked
 * `Can't test` because the person could not perform any of them. The Overview
 * reported `0 / 5 verified · 5 blocked`, which reads as five things standing
 * in the way of the stage. What actually happened is that no verification
 * result could be obtained for any of them — not a failure, not a pass, and
 * not the engine's workflow word.
 *
 * So there are four states a check can be in, and none of them shares a
 * bucket with another: verified, failed, couldn't test, and not answered yet.
 * The value written to notes.md is untouched (`Blocked` is the engine's own
 * vocabulary and the reviewer parses it); what changes is what this window
 * claims about it, and how it looks.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER, parseSparringOutcome } from "../core/engineFormats";
import { OUTCOME_WORDS, PROGRESS_UNTESTED_WORD, deriveVerification, parseHumanEvidence, renderHumanEvidence, submittableChecks, type CheckOutcome, type CheckRecord } from "../core/humanChecks";
import { OUTCOME_LABELS, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { Workspace, normalUi } from "./fixtures";

const NOW = Date.parse("2026-09-19T09:00:00.000Z");
const STAGE_ID = "plan-stage-2-schema-and-api";
const BRANCH = "feature/reported-statistics";

/** The five checks of the reported Stage 2 gate, in the reviewer's own shape. */
const CHECKS = [
  { id: "live-push-pull", instruction: "Push from desktop A and pull on desktop B; the row is byte-identical." },
  { id: "cas-retry", instruction: "Force a concurrent edit and confirm the CAS retry keeps the extension group intact." },
  { id: "cross-client", instruction: "Reconcile two signed-in clients and confirm no field is lost." },
  { id: "jsonb-read", instruction: "Read the row back through PostgREST and confirm the JSONB rendering." },
  { id: "pre-migration-reject", instruction: "Confirm a deployed pre-migration server rejects the enhanced write." },
];

function sparring(): string {
  const gate = {
    category: "DEVICE_MANUAL_CHECK",
    title: "Live cloud behaviour has to be seen by a person",
    checks: CHECKS.map((check) => ({ id: check.id, instruction: check.instruction, pass_criteria: "It behaves as the plan describes." })),
  };
  return [
    "# Sparring: x",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: Five manual checks are required before this stage is READY.",
    "- Needs-you reason: DEVICE/MANUAL CHECK -- live cloud behaviour",
    "",
    "## NEEDS YOU",
    "",
    "Five manual checks are required before this stage is READY.",
    "",
    HUMAN_GATE_MARKER,
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
  ].join("\n");
}

async function gate() {
  const ws = await Workspace.create();
  await ws.writeStage(STAGE_ID, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparring() });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  return (drafts: Record<string, CheckRecord>, notes?: string): { model: OverviewModel; html: string } => {
    const artifacts: OverviewArtifacts = { handoff: false, sparring: true, brief: false, plan: false, git: { branch: BRANCH }, humanChecks: drafts, notesText: notes };
    const model = buildOverviewModel(selection, undefined, artifacts, NOW);
    return { model, html: renderOverviewHtml(model, "n", "c") };
  };
}

/** Mark the first `count` checks with `outcome`, leaving the rest unanswered. */
function marked(outcome: CheckOutcome, count = CHECKS.length, from = 0): Record<string, CheckRecord> {
  const drafts: Record<string, CheckRecord> = {};
  for (const check of CHECKS.slice(from, from + count)) {
    drafts[check.id] = { outcome };
  }
  return drafts;
}

describe("the summary counts what the person actually said", () => {
  it("1–2. five Pass, and five Fail", async () => {
    const view = await gate();
    assert.equal(view(marked("pass")).model.actionRequired?.progress, "5 / 5 verified");
    assert.equal(view(marked("fail")).model.actionRequired?.progress, "0 / 5 verified · 5 failed");
  });

  it("3. five Can't test is neither five blocked nor five failed", async () => {
    const view = await gate();
    const { model, html } = view(marked("blocked"));
    const progress = model.actionRequired!.progress!;

    assert.equal(progress, "0 / 5 verified · 5 couldn't test");
    assert.doesNotMatch(progress, /blocked/i, "the reported wording, which said five things were in the way of the stage");
    assert.doesNotMatch(progress, /failed/i, "nobody observed a failure");
    assert.equal(PROGRESS_UNTESTED_WORD, "couldn't test");

    // And on the page, in the normal UI a person reads.
    assert.match(normalUi(html), /0 \/ 5 verified · 5 couldn&#39;t test/);
    assert.ok(!/\b5 blocked\b/.test(normalUi(html)), "the word does not appear as a count anywhere on the page");
  });

  it("4–5. mixed results, with and without unanswered checks, keep four separate buckets", async () => {
    const view = await gate();
    const mixed = { ...marked("pass", 3), ...marked("fail", 1, 3), ...marked("blocked", 1, 4) };
    assert.equal(view(mixed).model.actionRequired?.progress, "3 / 5 verified · 1 failed · 1 couldn't test");

    const partial = { ...marked("pass", 2), ...marked("fail", 1, 2), ...marked("blocked", 1, 3) };
    assert.equal(view(partial).model.actionRequired?.progress, "2 / 5 verified · 1 failed · 1 couldn't test · 1 remaining", "an unanswered check is not a check somebody could not test");
    assert.equal(view({}).model.actionRequired?.progress, "0 / 5 verified · 5 remaining");
  });

  it("evidence is still incomplete while any check is unanswered, and complete once every one has an answer", async () => {
    const view = await gate();
    const partial = view({ ...marked("pass", 4) });
    assert.equal(partial.model.actionRequired?.ready, false);
    assert.equal(partial.model.actionRequired?.submit.enabled, false);

    // "Can't test" is an answer: it completes the evidence, and what the
    // reviewer does with unavailable evidence is the reviewer's decision.
    const answered = view({ ...marked("pass", 4), ...marked("blocked", 1, 4) });
    assert.equal(answered.model.actionRequired?.ready, true);
    assert.equal(answered.model.actionRequired?.submit.enabled, true);
  });
});

describe("Can't test does not look like a failure", () => {
  it("6. the recorded check, the chosen button and the word all read as absence, not as a problem", async () => {
    const view = await gate();
    const html = view({ [CHECKS[0].id]: { outcome: "blocked" }, [CHECKS[1].id]: { outcome: "fail" } }).html;

    // The chosen buttons carry the outcome as a class, and the stylesheet
    // gives each a different treatment: red for a failure, the editor's own
    // muted foreground for a check nobody could run.
    assert.match(html, /class="choice blocked on"[^>]*aria-pressed="true"/);
    assert.match(html, /class="choice fail on"[^>]*aria-pressed="true"/);
    assert.match(html, /button\.choice\.on\.fail \{ background: var\(--bad\)/);
    assert.match(html, /button\.choice\.on\.blocked \{ background: var\(--vscode-descriptionForeground\)/);
    assert.match(html, /\.check\.fail \.mark \{ color: var\(--bad\); \}/);
    assert.match(html, /\.check\.blocked \.mark \{ color: var\(--vscode-descriptionForeground\); \}/);
    assert.match(html, /\.outcome\.blocked \{ color: var\(--vscode-descriptionForeground\); \}/);
    assert.ok(!/\.(check|outcome)\.blocked[^\n]*var\(--bad\)/.test(html), "never the failure colour");
    assert.ok(!/button\.choice\.on\.blocked[^\n]*var\(--(bad|warn)\)/.test(html), "and no longer the warning colour either");

    // A recorded result is marked the same way: ✗ for a failure, ⊘ for one
    // that could not be performed, ✓ only for a pass.
    const notes = `# Notes\n\n## Human evidence\n\n${renderHumanEvidence(
      [
        { text: CHECKS[0].instruction, origin: "gate", id: CHECKS[0].id, record: { outcome: "blocked" } },
        { text: CHECKS[1].instruction, origin: "gate", id: CHECKS[1].id, record: { outcome: "fail" } },
      ],
      new Date(NOW),
    )}\n`;
    const recorded = view({}, notes).html;
    assert.match(recorded, /<li class="check done blocked">[\s\S]*?<span class="mark">⊘<\/span>/);
    assert.match(recorded, /<li class="check done fail">[\s\S]*?<span class="mark">✗<\/span>/);
    assert.match(recorded, /<span class="outcome blocked">Can't test<\/span>/);
    assert.equal(OUTCOME_LABELS.blocked, "Can't test");
    assert.notEqual(OUTCOME_LABELS.blocked, OUTCOME_LABELS.fail);
  });

  it("8. the three controls are unchanged, and Pass and Fail behave exactly as before", async () => {
    const view = await gate();
    const html = view({}).html;
    for (const [outcome, label] of Object.entries(OUTCOME_LABELS)) {
      assert.equal((html.match(new RegExp(`data-outcome="${outcome}"`, "g")) ?? []).length, CHECKS.length, `one ${label} control per check`);
    }
    const passed = view(marked("pass")).model.actionRequired!;
    assert.equal(passed.ready, true);
    assert.equal(passed.submit.enabled, true);
    assert.deepEqual(
      passed.required.map((item) => item.record?.outcome),
      CHECKS.map(() => "pass"),
    );
  });
});

describe("what the reviewer is told is exactly what the person said", () => {
  it("7. Can't test is recorded as the engine's own Blocked, and reads back as Can't test", async () => {
    const view = await gate();
    const panel = view(marked("blocked")).model.actionRequired!;

    // The wire format is the engine's (stage.py / human_gate.py parse it);
    // nothing here translates a missing result into a pass or a failure.
    const entry = renderHumanEvidence(submittableChecks(panel), new Date(NOW))!;
    assert.equal((entry.match(/^- Blocked — /gm) ?? []).length, 5, "five Blocked lines, one per check, with its stable id");
    assert.ok(!/^- (Pass|Fail) — /m.test(entry), "not one of them was turned into a result somebody obtained");
    assert.equal(OUTCOME_WORDS.blocked, "Blocked");
    for (const check of CHECKS) {
      assert.ok(entry.includes(`· check \`${check.id}\``), `${check.id} is named by its id, so the reviewer matches it exactly`);
    }

    // And read back from notes.md it is still the same answer — not a pass,
    // which is what an unrecognised outcome word would have defaulted to.
    const recorded = parseHumanEvidence(`# Notes\n\n## Human evidence\n\n${entry}\n`);
    const outcome = parseSparringOutcome(sparring())!;
    const derived = deriveVerification({ explicit: [], parents: [] }, outcome, recorded, {});
    assert.deepEqual(
      derived.recorded.map((item) => item.evidence?.outcome),
      CHECKS.map(() => "blocked"),
    );
    assert.equal(derived.progress, "0 / 5 verified · 5 couldn't test");
  });
});
