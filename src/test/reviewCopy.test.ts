/**
 * Copying a NEEDS_YOU review out of the extension, so it can be asked about
 * somewhere else.
 *
 * The screen these tests describe answers "what do I do"; it does not answer
 * "what does a pre-activation desktop even mean here", and it never will —
 * that question belongs to whoever the person asks next. What the extension
 * owes them is a paste-able message that stands on its own: which stage, which
 * plan, which gate, which check, in the reviewer's own words, with the
 * concrete names the reviewer used.
 *
 * Two boundaries are checked here as hard as the content is. **Everything in
 * the copy is recorded data** — no sentence is composed out of the workflow's
 * internals, and where a fact was never recorded the section is simply absent.
 * **Nothing that is not the review gets in** — the self-contained handoff's
 * embedded diff, the test/build transcript and the activity log are the bulk
 * of the bytes on disk and none of them belong in a chat message.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER, parseHandoffClaims, parseSparringOutcome } from "../core/engineFormats";
import { checkName, checkNameList } from "../core/humanTask";
import { isActionMessage, isCopyMessage, isHumanCheckMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type ManifestStageView, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { checkCopyText, namedValues, reviewCopyText, type ReviewCopySource } from "../core/reviewCopy";
import { Workspace } from "./fixtures";
import { FakeElement, runWebviewScript, type Posted } from "./webviewShim";

const NOW = Date.parse("2026-09-15T09:00:00.000Z");
const STAGE_3D = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_TITLE = "Reported statistics and explicit range semantics";
const BRANCH = "feature/reported-statistics-contract";

/**
 * Two checks, because one check is the case where a collective phrase is never
 * tempting. "Both rollout switches" is what a person writes when two things
 * have names and the names are not in front of them.
 */
const READER = {
  id: "snapshot-v2-reader-gate",
  instruction:
    "Run the oldest supported pre-activation desktop build against a feed containing one schema_version 2 snapshot. Inspect the synchronized use and the ordinary rows beside it.",
  pass_criteria: "Pass if the feed loads and the v2 row keeps its measurement_details. Fail if the whole feed is rejected as unsupported.",
  source: "docs/reference-data/measurement-content-contract.md — 7. Snapshot version 2 (blocker 3)",
};
const WRITER = {
  id: "snapshot-v2-writer-gate",
  instruction: "With enhanced attachment emission still disabled, confirm that a deployed pre-Stage-3D server rejects an enhanced write.",
  pass_criteria: "Pass if the write is refused with invalid_payload.",
  source: null,
};
const GATE_CATEGORY = "DEVICE_MANUAL_CHECK";
const GATE_TITLE = "Confirm the supported pre-activation desktop reads snapshot-v2 feeds safely";
const SUMMARY = "Both repository candidates satisfy the Stage 3D implementation scope; the live compatibility checks are the sole acceptance blockers.";
const REVIEWER_NOTE = "DEVICE/MANUAL CHECK -- the reader gate and the writer gate both need a real desktop.";
const FINDINGS = "The parser rejects a malformed snapshot before it reaches persistence, and the fallback path is covered.\n\nNothing bounded remains in the diff.";

const SPARRING = [
  "# Sparring: stage 3d",
  "",
  "## Finding / discussion",
  "",
  FINDINGS,
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
  JSON.stringify({ category: GATE_CATEGORY, title: GATE_TITLE, checks: [READER, WRITER] }, null, 2),
  "```",
  "",
].join("\n");

const CLAIMS = "Added the schema_version 2 branch to the snapshot parser and the export writer; the reader keeps unknown extension fields verbatim.";
/** The parts of a self-contained handoff that must never leave the extension in a chat message. */
const TRANSCRIPT = "$ pytest -q tests/test_snapshot.py\n412 passed in 8.21s";
const DIFF_MARKER = "NEVER-IN-A-CHAT-MESSAGE-DIFF";

const HANDOFF = [
  `# Handoff: ${STAGE_3D}`,
  "",
  "## Stage goal",
  "",
  "Own the frozen-evidence representation.",
  "",
  "## Claims",
  "",
  CLAIMS,
  "",
  "## Git context",
  "",
  `- Branch: \`${BRANCH}\``,
  "- Base commit: `3c0f65b5`",
  "",
  "## Test / build evidence",
  "",
  TRANSCRIPT,
  "",
  "## Open / deferred checks",
  "",
  "(none recorded)",
  "",
  "## Diff (self-contained)",
  "",
  "```diff",
  `+ ${DIFF_MARKER}`,
  "```",
  "",
].join("\n");

const PLAN = [
  `# ${PLAN_TITLE}`,
  "",
  "## Stage 3C — Cloud schema",
  "",
  "Done.",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "Owns the frozen-evidence representation of enhanced content and the gates that protect old readers.",
  "",
  "### Verification expectations",
  "",
  "- Human-gated: a real pre-activation desktop against a v2 feed.",
  "",
  "## Stage 4 — Editor and plotting",
  "",
  "Later work.",
  "",
].join("\n");

const BRIEF = ["# Stage brief", "", "## Goal", "", "Carry snapshot v2 through export, import and sync without breaking old readers.", ""].join("\n");

const MANIFEST: ManifestStageView[] = [
  { stageId: "stage-3c-cloud-schema", label: "Stage 3C", title: "Cloud schema", status: "accepted" },
  { stageId: STAGE_3D, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport", status: "working" },
];

/** The managed run paused at Stage 3D's two-check gate, with the artifacts the panel would have read. */
async function gatedRun(options: { sparring?: string; handoff?: string; notes?: string } = {}): Promise<{ source: ReviewCopySource; model: OverviewModel; html: string }> {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_3D, expected_branch: BRANCH, source: "manifest" });
  await ws.writeStage("stage-3c-cloud-schema", { status: "accepted" });
  const sparringText = options.sparring ?? SPARRING;
  const handoffText = options.handoff ?? HANDOFF;
  await ws.writeStage(
    STAGE_3D,
    { status: "working", implementation_session_id: "ef8449bb-b38f", sparring_session_id: "01a09eb0-9e4c" },
    { "sparring.md": sparringText, "handoff.md": handoffText, "brief.md": BRIEF, ...(options.notes === undefined ? {} : { "notes.md": options.notes }) },
  );
  const artifacts: OverviewArtifacts = {
    handoff: true,
    handoffText,
    sparring: true,
    brief: true,
    briefText: BRIEF,
    plan: true,
    planText: PLAN,
    git: { branch: BRANCH, head: "9b99189a" },
    humanChecks: {},
    notesText: options.notes,
    manifestStages: MANIFEST,
  };
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const model = buildOverviewModel(selection, undefined, artifacts, NOW);
  return { source: { model, artifacts, sparringText, repository: ws.location.folderName }, model, html: renderOverviewHtml(model, "n", "c") };
}

describe("the whole review, copied for a chat", () => {
  it("stands on its own: where this is, what is being asked, and the reviewer's own words", async () => {
    const { source } = await gatedRun();
    const text = reviewCopyText(source)!;
    assert.ok(text, "a stage waiting on a human has a review to copy");

    // Where this is. Every line is a fact the engine recorded.
    assert.match(text, new RegExp(`- Repository: ${source.repository}`));
    assert.match(text, new RegExp(`- Plan: ${PLAN_TITLE}`));
    assert.match(text, /- Stage: Stage 3D — Snapshot v2 and attachment\/export\/import transport/);
    assert.match(text, new RegExp(`- Stage id: \`${STAGE_3D}\``));
    assert.match(text, new RegExp(`- Branch: \`${BRANCH}\``));
    assert.match(text, /- Routing state: NEEDS_YOU \(Needs you\)/);
    assert.match(text, /- Evidence recorded so far: 0 \/ 2 verified/);

    // What this stage is for, and what the reviewer said about it.
    assert.match(text, /## Stage goal\n\nCarry snapshot v2 through export, import and sync/);
    assert.ok(text.includes(`> ${SUMMARY}`), "the reviewer's summary, verbatim and quoted");
    assert.ok(text.includes(`> ${REVIEWER_NOTE}`), "the reviewer's note, verbatim");
    assert.match(text, new RegExp(`## What must be true before this stage can continue\\n\\n${GATE_CATEGORY} — ${GATE_TITLE}`));

    // The checks themselves.
    assert.match(text, /## Checks \(2\)/);
    assert.match(text, new RegExp(`### 1\\. \`${READER.id}\``));
    assert.match(text, new RegExp(`### 2\\. \`${WRITER.id}\``));
    for (const check of [READER, WRITER]) {
      for (const sentence of check.instruction.split(". ")) {
        assert.ok(text.includes(sentence.replace(/\.$/, "")), `the instruction of ${check.id} survives whole`);
      }
      assert.ok(text.includes(`> ${check.pass_criteria}`), `the pass criteria of ${check.id}, verbatim`);
    }
    assert.ok(text.includes(READER.source), "where the reviewer said the full test is defined");
    assert.match(text, /- No result recorded for it yet/);

    // The context around the gate.
    assert.ok(text.includes(`> ${CLAIMS}`), "what the implementing agent said it did");
    assert.ok(text.includes("> The parser rejects a malformed snapshot"), "the reviewer's findings, verbatim");
    assert.match(text, new RegExp(`From ${PLAN_TITLE}, line 7`));
    assert.ok(text.includes("> ## Stage 3D — Snapshot v2"), "the stage's own plan section");
    assert.ok(text.includes("> - Human-gated: a real pre-activation desktop"), "including its verification expectations");
    assert.ok(!text.includes("## Stage 4 — Editor"), "and not the section after it");
  });

  it("is Markdown that pastes cleanly, and says where it came from", async () => {
    const { source } = await gatedRun();
    const text = reviewCopyText(source)!;
    assert.ok(text.startsWith("# "), "one top-level heading");
    assert.equal((text.match(/^# /gm) ?? []).length, 1);
    assert.ok(text.endsWith("\n"));
    assert.ok(!text.includes("<"), "no HTML leaks out of the renderer's world");
    assert.ok(!/\r/.test(text));
    assert.match(text, /Copied from the Agent Sparring VS Code extension\./);
    assert.match(text, /no provider prompts, no model reasoning, no command output and no activity log/);
  });

  it("carries none of the workflow's internals", async () => {
    const { source } = await gatedRun();
    const text = reviewCopyText(source)!;
    assert.ok(!text.includes(DIFF_MARKER), "the self-contained handoff's embedded diff stays on disk");
    assert.ok(!text.includes("```diff"), "and so does its fence");
    assert.ok(!text.includes(TRANSCRIPT), "a command transcript is not review context");
    assert.ok(!text.includes("pytest"));
    assert.ok(!/session_id|ef8449bb|01a09eb0/.test(text), "provider session ids are not part of the question");
    assert.ok(!/activity\.jsonl|tool_use_id/.test(text));
  });

  it("says nothing where nothing was recorded", async () => {
    // No handoff, and a sparring.md whose findings section is the engine's own
    // placeholder: the sections are absent rather than filled with a guess.
    const bare = SPARRING.replace(FINDINGS, "(none recorded)");
    const { source } = await gatedRun({ sparring: bare, handoff: "# Handoff\n\n## Claims\n\n(not recorded)\n" });
    const text = reviewCopyText(source)!;
    assert.ok(!text.includes("## Reviewer's findings"), "no findings heading without findings");
    assert.ok(!text.includes("## Latest handoff claims"), "no claims heading without claims");
    assert.ok(!text.includes("(none recorded)") && !text.includes("(not recorded)"), "the engine's placeholders are absence, not content");
    assert.match(text, /## Checks \(2\)/, "what is recorded is still there");
  });

  it("is not offered for a stage nobody is waiting on", async () => {
    const { source } = await gatedRun();
    const notWaiting: ReviewCopySource = { ...source, model: { ...source.model, actionRequired: undefined } };
    assert.equal(reviewCopyText(notWaiting), undefined);
    assert.equal(checkCopyText(notWaiting, READER.id), undefined);
  });
});

describe("one check, copied on its own", () => {
  it("carries the stage around it, so the check still means something outside the extension", async () => {
    const { source } = await gatedRun();
    const text = checkCopyText(source, WRITER.id)!;
    assert.ok(text, "a check of this review can be copied by its id");
    assert.match(text, new RegExp(`^# Manual check: \`${WRITER.id}\``));
    assert.match(text, new RegExp(`- Plan: ${PLAN_TITLE}`));
    assert.match(text, /- Stage: Stage 3D — /);
    assert.match(text, /- Stage goal: Carry snapshot v2 through/);
    assert.match(text, new RegExp(`- Gate: ${GATE_CATEGORY} — ${GATE_TITLE}`));
    assert.match(text, /- This is check 2 of 2 in that gate\./);
    assert.ok(text.includes(WRITER.instruction), "its instruction, verbatim");
    assert.ok(text.includes(`> ${WRITER.pass_criteria}`), "its pass criteria, verbatim");
    assert.ok(text.includes("> ## Stage 3D — Snapshot v2"), "and the plan section it belongs to");
  });

  it("is that check and not the other one", async () => {
    const { source } = await gatedRun();
    const text = checkCopyText(source, READER.id)!;
    assert.ok(text.includes(READER.instruction.split(". ")[0]));
    assert.ok(!text.includes(WRITER.instruction), "the other check is not along for the ride");
    assert.ok(!text.includes(WRITER.id));
    assert.equal(checkCopyText(source, "no-such-check"), undefined, "a key this review does not have copies nothing");
  });
});

describe("the concrete names a review refers to", () => {
  it("are the reviewer's own ids, category and sources — never anything mined out of prose", async () => {
    const { model } = await gatedRun();
    const panel = model.actionRequired!;
    const values = namedValues(panel);
    assert.deepEqual(
      values.map((value) => value.name),
      [GATE_CATEGORY, READER.id, READER.source, WRITER.id],
      "the category, each check's stable id, and the one source the reviewer named",
    );
    assert.match(values[0].description, /the reviewer's own category for this gate \(device manual check\)/);
    assert.equal(values[1].description, `the reviewer's stable id for check 1: ${READER.instruction.split(". ")[0]}.`, "the name never appears bare: its first sentence goes with it");
    assert.match(values[2].description, /where the full test for check 1 is defined/);
  });

  it("the ids in the copy are the ones the gate declared, and the ones a recorded result is matched by", async () => {
    const { source, model } = await gatedRun();
    const panel = model.actionRequired!;
    assert.deepEqual(
      panel.required.map((check) => check.key),
      [READER.id, WRITER.id],
      "the draft key of a gate check is the reviewer's id",
    );
    assert.deepEqual(
      panel.required.map((check) => check.gateId),
      [READER.id, WRITER.id],
    );
    const text = reviewCopyText(source)!;
    for (const check of [READER, WRITER]) {
      assert.ok(text.includes(`\`${check.id}\``), `${check.id} is named in the copy`);
    }
  });

  it("a gate id the panel cannot round-trip is never presented as the reviewer's id", async () => {
    // The key falls back to a hash so the controls still work; a hash is not a
    // name the reviewer chose, so nothing calls it one.
    const gate = { category: "OTHER", title: "t", checks: [{ id: "has`backtick", instruction: "Do the thing.", pass_criteria: "It worked." }] };
    const sparring = SPARRING.replace(JSON.stringify({ category: GATE_CATEGORY, title: GATE_TITLE, checks: [READER, WRITER] }, null, 2), JSON.stringify(gate, null, 2));
    const { source, model } = await gatedRun({ sparring });
    const check = model.actionRequired!.required[0];
    assert.equal(check.gateId, undefined);
    assert.notEqual(check.key, "has`backtick");
    assert.deepEqual(checkName(check, 1), { name: "Check 1", named: false, description: "Do the thing." });
    assert.deepEqual(namedValues(model.actionRequired!), [{ name: "OTHER", description: "the reviewer's own category for this gate (other)" }]);
    const text = reviewCopyText(source)!;
    assert.match(text, /### Check 1|# Manual check: Check 1|## Checks \(1\)/);
    assert.ok(!text.includes("has`backtick"), "the id the panel could not use is not quoted as if it were in use");
    assert.ok(!text.includes(check.key), "and the hash standing in for it is not presented as a name");
  });

  it("a sentence that would say 'both of them' names them instead", async () => {
    const { model } = await gatedRun();
    const panel = model.actionRequired!;
    assert.equal(checkNameList(panel.required), `${READER.id} and ${WRITER.id}`);
    assert.match(panel.submit.detail, new RegExp(`Record a result for the remaining checks \\(${READER.id} and ${WRITER.id}\\) first\\.`));
    assert.equal(panel.submit.enabled, false);
    // Derived checks have no names to give, so the count stays the honest form.
    assert.equal(checkNameList([{ text: "Deploy the migration." }, { text: "Verify the write." }]), undefined);
  });
});

describe("the parsers the copy rests on", () => {
  it("reads the reviewer's findings and the stage agent's claims, and nothing around them", () => {
    assert.equal(parseSparringOutcome(SPARRING)?.findings, FINDINGS);
    assert.equal(parseHandoffClaims(HANDOFF), CLAIMS);
    assert.equal(parseHandoffClaims("# Handoff\n\n## Claims\n\n(not recorded)\n"), undefined, "the engine's placeholder is not a claim");
    assert.equal(parseHandoffClaims("# Handoff\n\n## Git context\n\n- Branch: `x`\n"), undefined);
  });
});

describe("the copy controls, on the wire the webview actually uses", () => {
  it("the rendered buttons post a copy message the host accepts", async () => {
    const { html } = await gatedRun();
    // The whole review, beside Open detailed review.
    assert.match(html, /data-action="openSparring"[^>]*>Open detailed review<\/button><button type="button" data-copy="review"[^>]*>Copy context for chat<\/button>/);
    // One per outstanding check, keyed by the reviewer's own id.
    for (const check of [READER, WRITER]) {
      assert.match(html, new RegExp(`<button type="button" class="quiet small" data-copy="check" data-check="${check.id}" title="Copy check ${check.id}[^"]*">Copy this check</button>`));
    }
    // The name is shown beside it, because with two checks the alternative is a collective phrase.
    assert.match(html, new RegExp(`<span class="checkid muted small"[^>]*>${READER.id}</span>`));

    // In document order: each check's own control sits with the check, the
    // whole-review one with the panel's actions at the bottom.
    const posted = clickEvery(html);
    assert.deepEqual(posted, [
      { type: "copy", scope: "check", key: READER.id },
      { type: "copy", scope: "check", key: WRITER.id },
      { type: "copy", scope: "review" },
    ]);
    for (const message of posted) {
      assert.ok(isCopyMessage(message), "the host's own parser accepts what the shipped script posts");
      assert.ok(!isActionMessage(message) && !isHumanCheckMessage(message), "and no other handler claims it");
    }
  });

  it("refuses a copy message it cannot act on", () => {
    assert.ok(isCopyMessage({ type: "copy", scope: "review" }));
    assert.ok(!isCopyMessage({ type: "copy", scope: "review", key: "x" }), "the whole review is not keyed");
    assert.ok(!isCopyMessage({ type: "copy", scope: "check" }), "a check-scoped copy without a check");
    assert.ok(!isCopyMessage({ type: "copy", scope: "check", key: "has`backtick" }), "a key no control could have emitted");
    assert.ok(!isCopyMessage({ type: "copy", scope: "everything", key: "a" }));
    assert.ok(!isCopyMessage({ type: "action", action: "openSparring" }));
  });

  it("a copy click runs nothing: it is a read of what is already recorded", async () => {
    const { html } = await gatedRun();
    assert.ok(
      clickEvery(html).every((message) => message.type === "copy"),
      "no copy control posts anything that could start a command",
    );
    const panel = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8");
    const handler = /private async copyForChat[\s\S]*?\n {2}}\n/.exec(panel)?.[0] ?? "";
    assert.ok(handler, "copyForChat exists");
    assert.match(handler, /vscode\.env\.clipboard\.writeText\(text\)/);
    assert.ok(!/launch|Terminal|setHumanCheck|submitForReview/.test(handler), "a copy neither runs the engine nor records evidence");
  });
});

// ---------------------------------------------------------------- the shipped script, against a DOM shim

/**
 * Click every copy control the document rendered, through the script the
 * document ships.
 *
 * The shim is the shared one (webviewShim.ts): this file used to keep a
 * second copy, which then had to be taught about every host global the
 * script came to use, and fell behind the first time one was added.
 */
function clickEvery(html: string): Posted[] {
  const { document, posted } = runWebviewScript(html);
  for (const markup of html.match(/<button[^>]*data-copy="[^"]*"[^>]*>/g) ?? []) {
    const attributes: Record<string, string> = {};
    for (const [, name, value] of markup.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes[name] = value;
    }
    document.dispatch("click", new FakeElement("button", attributes));
  }
  return posted;
}
