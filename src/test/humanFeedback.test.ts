/**
 * Freeform human feedback at a NEEDS_YOU gate.
 *
 * The reported situation, from a real Stage 4 verification: the reviewer asked
 * for five manual checks, and on the way to the first one the application
 * crashed reproducibly while navigating to the feature. That observation is
 * not a Pass, a Fail or a Can't test of any of the five — it is a defect the
 * reviewer has to see *before* those checks are worth performing — and the
 * structured controls had nowhere to put it. So did the two design problems
 * the same session found: a table still labelled "Typical min/max" although
 * the parser knows the values are P5/P95, and a range interpretation the human
 * wanted replaced with an explicit selector.
 *
 * What is checked here is that the second channel exists, that it stays
 * separate from the first in every direction, and that using it claims
 * nothing:
 *
 *  - its own field, its own action, enabled on its own terms;
 *  - `Submit result and continue` still governed only by its own completeness
 *    rule, so freeform text can never stand in for a missing check result;
 *  - no outstanding check silently becoming Can't test, Fail or Pass, and
 *    `N / M verified` unmoved — including after the feedback is recorded in
 *    notes.md, where the older prose matcher would have read it as evidence;
 *  - the reviewer, not this extension, deciding what the feedback means;
 *  - the exact text — newlines, arrows, apostrophes — reaching the engine
 *    invocation, and surviving a launch that failed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import {
  appendHumanEvidence,
  deriveVerification,
  HUMAN_FEEDBACK_HEADING,
  humanFeedbackFor,
  parseHumanEvidence,
  draftKeyFor,
  parseHumanFeedback,
  renderHumanEvidence,
  renderHumanFeedback,
  submittableChecks,
  withHumanFeedback,
  withoutHumanFeedback,
  type CheckRecord,
  type HumanFeedbackDrafts,
} from "../core/humanChecks";
import { escapeHtml, FEEDBACK_HELPER, isHumanCheckMessage, isHumanFeedbackMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type ManifestStageView, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { reviewCopyText, checkCopyText, type ReviewCopySource } from "../core/reviewCopy";
import { Workspace } from "./fixtures";
import { elementFrom, runWebviewScript } from "./webviewShim";

const NOW = Date.parse("2026-09-15T09:00:00.000Z");
const STAGE_4 = "stage-4-editor-and-ui-inspection-and-guarded-editing";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN = ["# Reported statistics and explicit range semantics", "", "## Stage 4 — Editor and UI inspection and guarded editing", "", "Owns the review table and the reference workflow.", ""].join("\n");

const MANIFEST: ManifestStageView[] = [
  { stageId: "stage-3d-transport", label: "Stage 3D", title: "Transport", status: "accepted" },
  { stageId: STAGE_4, label: "Stage 4", title: "Editor and UI inspection and guarded editing", status: "working" },
];

/** The five checks of the reported gate, in the reviewer's own order. */
const CHECKS = [
  { id: "stage-4-review-table-render", instruction: "Open the review table for a document with three reported statistics and inspect every column.", pass_criteria: "Pass if each row shows its parsed statistic. Fail if a column is empty." },
  { id: "stage-4-guarded-edit", instruction: "Edit one reported value and confirm the guard asks before overwriting the parsed value.", pass_criteria: "Pass if the guard appears once and the edit is applied after confirming." },
  { id: "stage-4-reference-workflow", instruction: "Add a reference to a statistic from the observation view and confirm it is listed.", pass_criteria: "Pass if the reference appears against the statistic." },
  { id: "stage-4-range-labels", instruction: "Inspect the range labels shown for a P5/P95 statistic in the editor.", pass_criteria: "Pass if the labels match what the parser recorded." },
  { id: "stage-4-keyboard-only", instruction: "Walk the editor with the keyboard alone, from the table to the guarded field.", pass_criteria: "Pass if every control is reachable and focus is visible." },
] as const;

const OUTSTANDING = CHECKS.length;

/** Which asking of the gate this fixture records (human_gate.py: `instance_id`). */
const GATE_INSTANCE = "gate1";

function sparring(action = "NEEDS_YOU"): string {
  const gate = { category: "UI_MANUAL_CHECK", title: "Confirm the editor renders and guards reported statistics correctly", checks: CHECKS.map((check) => ({ ...check, source: null })), instance_id: GATE_INSTANCE };
  return [
    "# Sparring: stage 4",
    "",
    "## Routing outcome",
    "",
    `- Action: \`${action}\``,
    "- Summary: The editor is implemented; five UI checks are the remaining acceptance blockers.",
    "- Needs-you reason: UI/MANUAL CHECK -- the editor cannot be exercised by the agents.",
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

/** The crash the reported session found, written the way a person writes it. */
const CRASH = [
  "App crashes while entering the reference workflow:",
  "Observation → Add reference → pick a statistic → Cancel → crash.",
  "",
  "It doesn't reach the editor at all, so I can't perform the requested checks until this is fixed.",
].join("\n");

const DESIGN = "The review table still says Typical min/max although the parser knows these are P5/P95. Replace 'drop the range interpretation' with an explicit Typical range / P5–P95 selector.";

interface Scene {
  runId: string;
  ws: Workspace;
  view: (options?: { feedback?: string; drafts?: Record<string, CheckRecord>; notes?: string; action?: string }) => { model: OverviewModel; html: string; source: ReviewCopySource };
}

/** A paused managed plan run at the five-check gate, rebuilt from whatever state the test wants. */
async function stage4Gate(): Promise<Scene> {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_4, expected_branch: "feature/reported-statistics", source: "manifest" });
  await ws.writeStage("stage-3d-transport", { status: "accepted" });
  await ws.writeStage(STAGE_4, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparring() });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const runId = selection.selected!.id;
  const view = (options: { feedback?: string; drafts?: Record<string, CheckRecord>; notes?: string; action?: string } = {}) => {
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: true,
      brief: false,
      plan: true,
      planText: PLAN,
      git: { branch: "feature/reported-statistics" },
      humanChecks: options.drafts ?? {},
      humanFeedback: options.feedback,
      notesText: options.notes,
      manifestStages: MANIFEST,
    };
    const model = buildOverviewModel(selection, undefined, artifacts, NOW);
    return { model, html: renderOverviewHtml(model, "n", "c"), source: { model, artifacts, sparringText: sparring(options.action), repository: ws.location.folderName } };
  };
  return { runId, ws, view };
}

describe("a second channel, beside the reviewer's checks", () => {
  it("five outstanding checks and freeform text only: Send feedback is enabled, Submit is not", async () => {
    const { view } = await stage4Gate();
    const { model, html } = view({ feedback: CRASH });
    const panel = model.actionRequired!;

    assert.equal(panel.required.length, OUTSTANDING, "the reviewer's five checks, untouched");
    assert.equal(panel.feedback.send.enabled, true, "the crash can go back without answering any of them");
    assert.match(panel.feedback.send.detail, /It records no check result: the 5 outstanding checks stay outstanding\./);
    assert.match(panel.feedback.send.detail, /The reviewer decides what follows/);

    // The structured path is untouched by the presence of feedback.
    assert.equal(panel.submit.enabled, false, "freeform text is not a substitute for a requested result");
    assert.match(panel.submit.detail, /^Record a result for all 5 remaining checks first\./);
    assert.equal(panel.ready, false);
    assert.equal(panel.headline, "5 manual checks required");
    assert.equal(panel.progress, "0 / 5 verified · 5 remaining");

    assert.match(html, /<button type="button" data-action="sendFeedbackForReview" title="[^"]*">Send feedback for review<\/button>/, "enabled: no disabled attribute");
    assert.match(html, /data-action="submitForReview" title="[^"]*" disabled>Submit result and continue</);
  });

  it("the field says what it is for, and is not a control of any check", async () => {
    const { view } = await stage4Gate();
    const { html } = view();
    assert.match(html, /<div class="feedback">\s*<h4>Additional findings or instructions<\/h4>/);
    assert.ok(html.includes(`<p class="muted small helper">${escapeHtml(FEEDBACK_HELPER)}</p>`), "the helper sentence, escaped as everything on the page is");
    assert.match(FEEDBACK_HELPER, /independent of Pass \/ Fail \/ Can't test/);
    const field = /<textarea class="freeform"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(field, /data-feedback="review"/);
    assert.ok(!field.includes("data-check"), "it belongs to no check, so it carries no check key");
    assert.ok(!/data-outcome/.test(/<div class="feedback">[\s\S]*?<\/div>/.exec(html)?.[0] ?? ""), "and no Pass / Fail / Can't test beside it");
  });

  it("without text there is nothing to send, and the button says why", async () => {
    const { view } = await stage4Gate();
    for (const feedback of [undefined, "   \n  "]) {
      const panel = view({ feedback }).model.actionRequired!;
      assert.equal(panel.feedback.send.enabled, false);
      assert.equal(panel.feedback.draft, undefined, "whitespace is not a finding");
      assert.equal(panel.feedback.send.detail, "Describe what you found in the field above first. It goes to the reviewer as it is written, against the unchanged candidate.");
    }
    assert.match(view({ feedback: CRASH }).html, /data-action="sendFeedbackForReview" title="[^"]*">Send/, "and with text it is offered");
  });

  it("feedback is offered even where there is no check at all, and refused from the wrong branch", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(STAGE_4, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparring("ESCALATE") });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const escalated = buildOverviewModel(selection, undefined, { handoff: false, sparring: true, brief: false, plan: false, git: { branch: "feature/x" }, humanFeedback: DESIGN }, NOW);
    assert.equal(escalated.actionRequired?.kind, "escalate");
    assert.equal(escalated.actionRequired?.feedback.send.enabled, true, "an escalation is exactly when a human has something to say");

    const { view } = await stage4Gate();
    const wrongBranch = buildOverviewModel(
      selectRun((await discoverRuns([(await stage4Gate()).ws.location])).runs),
      undefined,
      { handoff: false, sparring: true, brief: false, plan: true, planText: PLAN, git: { branch: "main" }, humanFeedback: CRASH, manifestStages: MANIFEST },
      NOW,
    );
    assert.equal(wrongBranch.actionRequired?.feedback.send.enabled, false);
    assert.match(wrongBranch.actionRequired?.feedback.send.detail ?? "", /^Switch to feature\/reported-statistics first;/);
    assert.equal(view({ feedback: CRASH }).model.actionRequired?.feedback.send.enabled, true, "on the right branch it is offered");
  });
});

describe("sending feedback claims nothing about the checks", () => {
  it("the recorded entry is feedback, not a result: no outcome, no progress, nothing marked", async () => {
    const { view } = await stage4Gate();
    const entry = renderHumanFeedback(CRASH, new Date(NOW))!;
    const notes = appendHumanEvidence("# Notes: stage 4\n", entry);
    const { model, html } = view({ notes });
    const panel = model.actionRequired!;

    assert.equal(panel.required.length, OUTSTANDING, "all five checks are still outstanding");
    assert.equal(panel.recorded.length, 0, "and none of them counts as recorded");
    assert.equal(panel.progress, "0 / 5 verified · 5 remaining");
    assert.equal(panel.ready, false);
    assert.equal(panel.submit.enabled, false);
    assert.deepEqual(submittableChecks(panel), [], "nothing would be written as a result");
    assert.ok(
      panel.required.every((item) => item.record === undefined && item.evidence === undefined),
      "no check acquired an outcome",
    );
    assert.ok(!/Can&#39;t test<\/span>|class="outcome/.test(html), "and nothing on the page reads as a recorded outcome");
  });

  it("even feedback that quotes a check's own words is not evidence for it", async () => {
    // The pre-existing prose matcher counts any ## Human evidence paragraph
    // that shares three significant words with a check. Design feedback about
    // a screen names the same things the check about that screen names, so
    // without the sub-heading this sentence would have marked check 4 as
    // verified — from a person who was reporting a wording defect.
    const quoting = "While reading the review table I noticed the range labels shown for a P5/P95 statistic in the editor still use the Typical min/max wording.";
    const { view } = await stage4Gate();
    const notes = appendHumanEvidence("# Notes: stage 4\n", renderHumanFeedback(quoting, new Date(NOW))!);
    const panel = view({ notes }).model.actionRequired!;
    assert.equal(panel.recorded.length, 0);
    assert.equal(panel.required.length, OUTSTANDING);
    assert.equal(panel.progress, "0 / 5 verified · 5 remaining");

    // The same words as an ordinary ## Human evidence paragraph — no feedback
    // sub-heading — are still matched, so this is the sub-heading doing the
    // work and not a weakened matcher.
    const asProse = appendHumanEvidence("# Notes: stage 4\n", quoting);
    const entries = parseHumanEvidence(asProse);
    assert.deepEqual(
      entries.map((entry) => entry.feedback),
      [false],
    );
    // It still matches by overlap — the sub-heading is what excludes
    // feedback, not a weakened matcher. It lands as *previous* evidence
    // rather than as this gate's answer, because a paragraph names no
    // asking and so can never be shown to answer the one in front of you.
    const matched = view({ notes: asProse }).model.actionRequired!;
    assert.equal(matched.recorded.length, 0, "a paragraph answers no particular asking");
    assert.equal(
      matched.required.filter((item) => item.previous.some((entry) => entry.how === "prose")).length,
      1,
      "a plain paragraph still matches by overlap, and is kept as history",
    );
  });

  it("structured results already recorded keep their own place when feedback is added beside them", async () => {
    const { view } = await stage4Gate();
    const result = renderHumanEvidence([{ text: CHECKS[0].instruction, origin: "gate", id: CHECKS[0].id, gateInstanceId: GATE_INSTANCE, record: { outcome: "pass", note: "Three rows, all columns filled." } }], new Date(NOW))!;
    const notes = appendHumanEvidence(appendHumanEvidence("# Notes: stage 4\n", result), renderHumanFeedback(CRASH, new Date(NOW))!);
    const panel = view({ notes }).model.actionRequired!;
    assert.deepEqual(
      panel.recorded.map((item) => [item.key, item.evidence?.outcome, item.evidence?.how]),
      [[CHECKS[0].id, "pass", "id"]],
      "the check result is still matched by its stable id",
    );
    assert.equal(panel.required.length, OUTSTANDING - 1);
    assert.equal(panel.progress, "1 / 5 verified · 4 remaining", "the feedback does not add to or subtract from the count");
    assert.deepEqual(parseHumanFeedback(notes), [renderHumanFeedback(CRASH, new Date(NOW))!.split("\n").slice(1).join("\n").trim()]);
  });

  it("multiple submissions append distinct entries instead of overwriting", async () => {
    let notes = "# Notes: stage 4\n";
    notes = appendHumanEvidence(notes, renderHumanFeedback(CRASH, new Date(NOW))!);
    notes = appendHumanEvidence(notes, renderHumanFeedback(DESIGN, new Date(NOW + 86_400_000))!);
    const blocks = parseHumanFeedback(notes);
    assert.equal(blocks.length, 2, "two observations, not one edited");
    assert.match(blocks[0], /2026-09-15 — reported in VS Code/);
    assert.ok(blocks[0].includes("Observation → Add reference → pick a statistic → Cancel → crash."));
    assert.match(blocks[1], /2026-09-16 — reported in VS Code/);
    assert.ok(blocks[1].includes("Typical range / P5–P95 selector"));
    assert.equal(notes.split("## Human evidence").length, 2, "one section heading, as the engine keeps it");
    assert.equal(notes.split(HUMAN_FEEDBACK_HEADING).length, 3, "each submission marks itself as feedback");

    const { view } = await stage4Gate();
    const panel = view({ notes }).model.actionRequired!;
    assert.deepEqual(panel.feedback.submitted, blocks, "and the panel shows what was already sent");
    assert.match(view({ notes }).html, /<details class="prev"[^>]*><summary>Feedback already sent \(2\)<\/summary>/);
  });

  it("the entry is the person's text verbatim, under a heading that is not a check", () => {
    const entry = renderHumanFeedback(CRASH, new Date(NOW))!;
    assert.match(entry, /^### Additional human feedback\n\n2026-09-15 — reported in VS Code by the human this stage is waiting on, alongside the requested checks:\n\n/);
    assert.ok(entry.endsWith(CRASH), "not summarised, not reflowed, not classified");
    assert.ok(!/Pass|Fail|Blocked|Can't test/.test(entry.replace(CRASH, "")), "no outcome word is introduced");
    assert.equal(renderHumanFeedback("   \n\t", new Date(NOW)), undefined, "and whitespace records nothing");
  });
});

describe("the exact text, all the way to the engine", () => {
  it("webview → host parser → draft → model → resume-plan --evidence, newlines and all", async () => {
    const { runId, view } = await stage4Gate();
    let drafts: HumanFeedbackDrafts = {};

    // 1. the field the renderer emitted, typed into through the shipped script
    const before = view();
    const { document, posted } = runWebviewScript(before.html);
    const field = elementFrom(before.html, "textarea", /<textarea class="freeform"[^>]*>/, "the freeform findings field");
    field.value = CRASH;
    document.dispatch("focusout", field);

    // 2. what it posted: no key, its own type
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], { type: "humanFeedback", text: CRASH });

    // 3. the host's parsers: this is feedback, and it is not a check note
    const message = posted[0];
    assert.ok(isHumanFeedbackMessage(message), "the host accepts it");
    assert.ok(!isHumanCheckMessage(message), "and can never file it as a check result");

    // 4. the draft the host stores, and the view rebuilt from it
    drafts = withHumanFeedback(drafts, runId, message.text as string);
    assert.equal(humanFeedbackFor(drafts, runId), CRASH, "stored exactly as typed");
    const after = view({ feedback: humanFeedbackFor(drafts, runId) });
    assert.equal(after.model.actionRequired?.feedback.draft, CRASH);
    assert.match(after.html, /Observation → Add reference → pick a statistic → Cancel → crash\./, "and shown back in the field, still editable");

    // 5. the evidence entry, and the argument array the engine is handed
    const entry = renderHumanFeedback(after.model.actionRequired!.feedback.draft!, new Date(NOW))!;
    const args = buildResumePlanArgs({ source: "manifest", manifest: "/tmp/m.json", repoRoot: "/repo", expectedBranch: "feature/reported-statistics", evidence: entry });
    const evidence = args[args.indexOf("--evidence") + 1];
    assert.ok(evidence.includes(CRASH), "every line of what the person typed is in the one argument");
    assert.equal(evidence.split(/\r?\n/).length, entry.split(/\r?\n/).length, "nothing was joined or dropped");
    assert.ok(evidence.startsWith(HUMAN_FEEDBACK_HEADING), "and it is labelled as feedback, not as a result");
  });

  it("typing keeps the page still, and clearing the field clears the draft", async () => {
    const { runId, view } = await stage4Gate();
    const rendered = view({ feedback: CRASH });
    const { document, posted } = runWebviewScript(rendered.html);
    const field = elementFrom(rendered.html, "textarea", /<textarea class="freeform"[^>]*>/, "the freeform findings field");

    field.value = "";
    document.dispatch("focusout", field);
    assert.deepEqual(posted[0], { type: "humanFeedback", text: "" });
    assert.ok(isHumanFeedbackMessage(posted[0]), "an empty field is a valid message: it is how a draft is withdrawn");
    assert.deepEqual(withHumanFeedback({ [runId]: CRASH }, runId, ""), {}, "and the draft goes");

    // The host stores a keystroke without re-rendering; the panel's handler is
    // what guarantees the textarea is not replaced under the cursor.
    const panel = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8");
    const handler = /private async recordHumanFeedback[\s\S]*?\n {2}}\n/.exec(panel)?.[0] ?? "";
    assert.ok(handler, "recordHumanFeedback exists");
    assert.match(handler, /setHumanFeedback\(stageScopeOf\(run\), message\.text\)/, "stored against the run and the stage it is current at, so it cannot resurface under the next stage");
    assert.doesNotMatch(handler, /lastHtmlKey|buildModel/, "a draft save must not cache an unrendered model; the behavioral render-key checks live in evidenceHandoffRecovery.test.ts");
    assert.ok(!/launch|buildRun|Terminal|sendFeedback/.test(handler), "and nothing on this path runs the engine");
  });

  it("a note for a check and freeform feedback cannot be mistaken for one another", () => {
    assert.ok(!isHumanFeedbackMessage({ type: "humanCheck", key: CHECKS[0].id, note: "n" }));
    assert.ok(!isHumanCheckMessage({ type: "humanFeedback", text: CRASH }));
    assert.ok(!isHumanFeedbackMessage({ type: "humanFeedback" }), "text is required");
    assert.ok(!isHumanFeedbackMessage({ type: "humanFeedback", text: 42 }));
    assert.ok(!isHumanFeedbackMessage({ type: "humanFeedback", text: "x".repeat(20_001) }), "bounded, so a message cannot be a payload");
    assert.ok(isHumanFeedbackMessage({ type: "humanFeedback", text: "x".repeat(20_000) }));
  });

  it("no command clears a draft: only the engine's own exit code does", async () => {
    const commands = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const send = /async function sendFeedbackForReviewCommand[\s\S]*?\n}\n/.exec(commands)?.[0] ?? "";
    assert.ok(send, "sendFeedbackForReviewCommand exists");
    assert.match(send, /renderHumanFeedback\(panel\.feedback\.draft \?\? ""/, "the text is recorded as feedback, verbatim");
    assert.match(send, /if \(model\.branchGuard\)/, "the wrong branch refuses before anything is written");
    assert.match(send, /beginSubmission\(\{[\s\S]*?channel: "feedback"[\s\S]*?executionId: sent\.executionId/, "a launch begins a submission rather than finishing one");
    // The command discards nothing at all. Every way a submission can fail
    // after the process starts — a refused branch, a refused plan digest, a
    // provider failure, Ctrl-C — is downstream of here.
    for (const [name, source] of [
      ["sendFeedbackForReviewCommand", send],
      ["submitForReviewCommand", /async function submitForReviewCommand[\s\S]*?\n}\n/.exec(commands)?.[0] ?? ""],
    ] as const) {
      assert.ok(!/clearHumanFeedback|clearHumanChecks/.test(source), `${name} never clears a draft`);
    }

    // The shared path names the execution whose exit code decides it.
    const ask = /async function askReviewerAgain[\s\S]*?\n}\n/.exec(commands)?.[0] ?? "";
    assert.match(ask, /Promise<Handover>/);
    assert.match(ask, /result\.ok \? \{ launched: true, executionId: result\.record\.id \} : \{ launched: false \}/, "the launcher's own execution id travels with the submission");
    assert.ok(!/buildRunLoopArgs|launchStageLoop/.test(ask), "freeform prose never starts the implementing agent");

    const reducer = withHumanFeedback({}, "run-1", CRASH);
    assert.equal(humanFeedbackFor(reducer, "run-1"), CRASH, "the draft outlives a rerender");
    assert.deepEqual(withoutHumanFeedback(reducer, "run-1"), {}, "and a recorded submission is what removes it");
  });
});

describe("what the reviewer does with it", () => {
  it("SEND_BACK from feedback alone: the gate is gone, implementation resumes, no check was ever answered", async () => {
    const ws = await Workspace.create();
    const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, PLAN);
    await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_4, expected_branch: "feature/reported-statistics", source: "manifest" });
    await ws.writeStage(STAGE_4, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparring("SEND_BACK") });
    const notes = appendHumanEvidence("# Notes: stage 4\n", renderHumanFeedback(CRASH, new Date(NOW))!);
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const model = buildOverviewModel(selection, undefined, { handoff: false, sparring: true, brief: false, plan: true, planText: PLAN, git: { branch: "feature/reported-statistics" }, notesText: notes, manifestStages: MANIFEST }, NOW);

    assert.equal(model.actionRequired, undefined, "the human is no longer the one being waited on");
    assert.equal(model.stageStatus, "Changes requested");
    assert.equal(model.planAction?.label, "Resume plan", "the managed run carries on from here");
    assert.deepEqual(parseHumanFeedback(notes).length, 1, "the feedback that caused it is still on record");
    assert.ok(!/verified/.test(JSON.stringify(model)), "and no check was claimed on the way");
  });

  it("NEEDS_YOU again with revised checks: a result follows its check's id, never its position", async () => {
    // The reviewer decides the crash invalidates check 3 and replaces it, and
    // renumbers nothing else. Position 3 must not inherit the Pass that was
    // drafted for the check that used to sit there.
    const drafts = { [CHECKS[2].id]: { outcome: "pass" as const, note: "Reference listed." } };
    const revised = CHECKS.map((check, index) =>
      index === 2 ? { id: "stage-4-reference-workflow-v2", instruction: "Add a reference only after the cancel crash is fixed, then confirm it is listed.", passCriteria: "Pass if no crash occurs and the reference appears.", source: undefined } : { id: check.id, instruction: check.instruction, passCriteria: check.pass_criteria, source: undefined },
    );
    const view = deriveVerification({ explicit: [], parents: [] }, { action: "NEEDS_YOU", summary: "s", humanGate: { category: "UI_MANUAL_CHECK", title: "t", checks: revised } }, [], drafts);
    assert.equal(view.required[2].key, "stage-4-reference-workflow-v2");
    assert.equal(view.required[2].record, undefined, "a materially changed check starts without a result");
    assert.equal(view.progress, "0 / 5 verified · 5 remaining");

    // The checks the reviewer kept do keep their drafts, which is what the
    // stable id is for.
    const kept = deriveVerification({ explicit: [], parents: [] }, { action: "NEEDS_YOU", summary: "s", humanGate: { category: "UI_MANUAL_CHECK", title: "t", checks: revised } }, [], { [CHECKS[0].id]: { outcome: "pass" } });
    assert.equal(kept.required[0].record?.outcome, "pass");
  });
});

describe("copy for chat tells submitted from draft", () => {
  it("sent feedback and unsent feedback are different sections, and say which is which", async () => {
    const { view } = await stage4Gate();
    const notes = appendHumanEvidence("# Notes: stage 4\n", renderHumanFeedback(CRASH, new Date(NOW))!);
    const text = reviewCopyText(view({ notes, feedback: DESIGN }).source)!;

    assert.match(text, /## Additional human feedback\n\nWhat the human reported outside the requested checks and sent to the reviewer \(notes\.md, `### Additional human feedback`, verbatim\):/);
    assert.match(text, /> Observation → Add reference → pick a statistic → Cancel → crash\./);
    assert.match(text, /## Draft human feedback — not yet submitted\n\nTyped in the Overview and not sent: the reviewer has not seen this and has not ruled on it\./);
    assert.match(text, /> The review table still says Typical min\/max/);
    assert.ok(text.indexOf("## Additional human feedback") < text.indexOf("## Draft human feedback"), "what the reviewer has seen comes first");
    assert.ok(!/## Additional human feedback[\s\S]*Typical min\/max[\s\S]*## Draft human feedback/.test(text), "the draft is never quoted as if it had been sent");
  });

  it("neither section appears when there is nothing in it", async () => {
    const { view } = await stage4Gate();
    const bare = reviewCopyText(view().source)!;
    assert.ok(!bare.includes("Additional human feedback"));
    assert.ok(!bare.includes("Draft human feedback"));
    assert.match(bare, /## Checks \(5\)/, "the rest of the copy is unchanged");
  });

  it("a single check's copy stays about that check", async () => {
    const { view } = await stage4Gate();
    const notes = appendHumanEvidence("# Notes: stage 4\n", renderHumanFeedback(CRASH, new Date(NOW))!);
    const scene = view({ notes, feedback: DESIGN });
    const one = checkCopyText(scene.source, CHECKS[3].id)!;
    assert.match(one, /^# Manual check: `stage-4-range-labels`/);
    assert.ok(!one.includes("Add reference"), "an unrelated crash report is not part of what this check means");
    assert.ok(!one.includes("Typical min/max"));
  });
});

describe("the structured gate is unchanged by any of this", () => {
  it("answering all five checks still reaches Evidence ready, with feedback in the box or not", async () => {
    const { view } = await stage4Gate();
    const drafts = Object.fromEntries(CHECKS.map((check) => [draftKeyFor(check.id, GATE_INSTANCE), { outcome: "pass" as const }]));
    for (const feedback of [undefined, CRASH]) {
      const { model, html } = view({ drafts, feedback });
      const panel = model.actionRequired!;
      assert.equal(panel.ready, true);
      assert.equal(panel.progress, "5 / 5 verified");
      assert.equal(panel.headline, "Evidence ready for review");
      assert.equal(panel.submit.enabled, true);
      assert.equal(model.status?.label, "Evidence ready");
      assert.equal(submittableChecks(panel).length, OUTSTANDING);
      assert.equal((html.match(/class="primary"/g) ?? []).length, 1, "Submit is still the one primary button");
      assert.match(html, /data-action="submitForReview" title="[^"]*">Submit result and continue</);
    }
  });

  it("a failing check is still a failing check, and the panel's own layers are where they were", async () => {
    const { view } = await stage4Gate();
    const { model, html } = view({ drafts: { [draftKeyFor(CHECKS[0].id, GATE_INSTANCE)]: { outcome: "fail", note: "The third column is empty." } }, feedback: CRASH });
    const panel = model.actionRequired!;
    assert.equal(panel.progress, "0 / 5 verified · 1 failed · 4 remaining");
    assert.equal(panel.gateTitle, "Confirm the editor renders and guards reported statistics correctly");
    // The control carries the *draft* key: this asking, and this check.
    assert.match(html, new RegExp(`class="choice fail on" data-check="${draftKeyFor(CHECKS[0].id, GATE_INSTANCE)}"`));
    assert.match(html, /<details class="tech"[^>]*><summary>Show technical details<\/summary>/);
    assert.ok(html.indexOf('class="checklist gate"') < html.indexOf('class="feedback"'), "the freeform field sits below the checks");
    assert.ok(html.indexOf('class="feedback"') < html.indexOf('details class="tech"'), "and above the demoted technical layer");
  });
});
