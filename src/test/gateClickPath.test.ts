/**
 * The whole wire behind one Pass click, for a structured gate.
 *
 * The regression: a gate check is keyed by the reviewer's own stable id
 * (`pre-activation-desktop-v2-feed`), but the host tested an arriving
 * message's key against `/^[0-9a-f]{1,16}$/` — the shape of a *derived*
 * check's hash. Every message a gate's Pass / Fail / Can't test button sent
 * was therefore dropped before it reached the draft state: no selection, no
 * `1 / 1 verified`, no enabled Submit, no re-render. Nothing about it was
 * visible in a rendered snapshot, and no test caught it, because every test
 * drove the reducer directly and every derived check's key was a hash.
 *
 * So this file exercises the wire instead: the markup the renderer actually
 * emits, the webview script that is actually shipped in the document (run
 * against a small DOM shim), the message that script posts, the host's own
 * parser for it, the draft mutation the host performs, and the model and
 * HTML rebuilt from the result.
 *
 * The one thing it cannot do is run a real browser: `closest` and event
 * dispatch are emulated below, and there is no extension host, so the
 * webview↔host boundary is crossed by calling the exported parser rather
 * than by VS Code's own `postMessage`. Everything either side of that call
 * is the shipped code.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { deriveVerification, isCheckKey, withHumanCheck, type CheckOutcome, type HumanCheckDrafts } from "../core/humanChecks";
import { isActionMessage, isHumanCheckMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type ManifestStageView, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { Workspace } from "./fixtures";
import { elementFrom, FakeElement, FakeTextArea, runWebviewScript } from "./webviewShim";

const NOW = Date.parse("2026-09-14T20:00:00.000Z");
const STAGE_3D = "stage-3d-snapshot-v2-and-attachment-export-import-transport";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_KEY = "reported-statistics-1cd13d24";
const RUN_ID_SUFFIX = `plan:${PLAN_KEY}`;
/** The real Stage 3D gate: a slug, not a hash. That is the whole point of a stable id. */
const CHECK_ID = "pre-activation-desktop-v2-feed";
const INSTRUCTION = "Run the oldest supported desktop build against a feed containing one snapshot_version 2 row. Inspect the synchronized use.";
const PASS_CRITERIA = "Pass if the feed loads and the v2 row keeps its measurement details. Fail if the feed is rejected.";

const PLAN = ["# Reported statistics and explicit range semantics", "", "## Stage 3D — Snapshot v2 and attachment/export/import transport", "", "Owns the frozen-evidence representation.", ""].join("\n");

const MANIFEST: ManifestStageView[] = [
  { stageId: "stage-1-contract", label: "Stage 1", title: "Contract", status: "accepted" },
  { stageId: STAGE_3D, label: "Stage 3D", title: "Snapshot v2 and attachment/export/import transport", status: "working" },
];

/** A second check, for the cases where what matters is one check's draft not disturbing another's. */
const SECOND_ID = "attachment-export-import-round-trip";
const SECOND_INSTRUCTION = "Export a snapshot with two attachments and import it into a second profile.";
const SECOND_PASS_CRITERIA = "Pass if both attachments open after the import.";

function sparringWithGate(checks = 1): string {
  const all = [
    { id: CHECK_ID, instruction: INSTRUCTION, pass_criteria: PASS_CRITERIA, source: null },
    { id: SECOND_ID, instruction: SECOND_INSTRUCTION, pass_criteria: SECOND_PASS_CRITERIA, source: null },
  ].slice(0, checks);
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "Confirm the supported pre-activation desktop reads snapshot-v2 feeds safely", checks: all };
  return ["# Sparring: stage 3d", "", "## Routing outcome", "", "- Action: `NEEDS_YOU`", "- Summary: One compatibility check is the sole acceptance blocker.", "- Needs-you reason: DEVICE/MANUAL CHECK -- a pre-activation desktop against a v2 feed.", "", "## NEEDS YOU", "", HUMAN_GATE_MARKER, "", "```json", JSON.stringify(gate, null, 2), "```", ""].join("\n");
}

// ---------------------------------------------------------------- a DOM the shipped script can run against

/** The Pass / Fail / Can't test button for a check, built from the markup the renderer emitted. */
function outcomeButton(html: string, key: string, outcome: CheckOutcome): FakeElement {
  const button = elementFrom(html, "button", new RegExp(`<button[^>]*data-check="${key}" data-outcome="${outcome}"[^>]*>`), `a ${outcome} control for ${key}`);
  assert.ok(button.hasAttribute("data-check") && button.hasAttribute("data-outcome"), "the attributes the listener selects on");
  return button;
}

// ---------------------------------------------------------------- the run

async function managedGate(checks = 1) {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_3D, expected_branch: "feature/x", source: "manifest" });
  await ws.writeStage("stage-1-contract", { status: "accepted" });
  await ws.writeStage(STAGE_3D, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparringWithGate(checks) });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const runId = selection.selected!.id;
  assert.ok(runId.endsWith(RUN_ID_SUFFIX));

  /** What the panel does on every update: build the model from the stored drafts, render it. */
  const view = (drafts: HumanCheckDrafts): { model: OverviewModel; html: string } => {
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: true,
      brief: false,
      plan: true,
      planText: PLAN,
      git: { branch: "feature/x" },
      humanChecks: drafts[runId] ?? {},
      manifestStages: MANIFEST,
    };
    const model = buildOverviewModel(selection, undefined, artifacts, NOW);
    return { model, html: renderOverviewHtml(model, "n", "c") };
  };
  return { runId, view };
}

describe("clicking Pass on a structured gate", () => {
  it("travels the whole path: markup → shipped listener → message → host parser → draft → rebuilt view", async () => {
    const { runId, view } = await managedGate();
    let drafts: HumanCheckDrafts = {};

    const before = view(drafts);
    assert.equal(before.model.actionRequired?.required[0].key, CHECK_ID, "the reviewer's stable id is the draft key");
    assert.equal(before.model.actionRequired?.progress, "0 / 1 verified · 1 remaining");
    assert.equal(before.model.actionRequired?.submit.enabled, false);

    // 1. the button the renderer emitted, clicked through the shipped script
    const { document, posted } = runWebviewScript(before.html);
    document.dispatch("click", outcomeButton(before.html, CHECK_ID, "pass"));

    // 2. what it posted
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], { type: "humanCheck", key: CHECK_ID, outcome: "pass" });

    // 3. the host's own parser — the link that was broken
    const message = posted[0];
    assert.ok(isHumanCheckMessage(message), "the host accepts a key that is a gate id, not only a hash");
    assert.ok(!isActionMessage(message), "and does not mistake it for an action");

    // 4. the draft mutation the host performs, and 5. the view rebuilt from it
    drafts = withHumanCheck(drafts, runId, message.key, { outcome: message.outcome, note: message.note });
    const after = view(drafts);
    assert.equal(after.model.actionRequired?.required[0].record?.outcome, "pass");
    assert.equal(after.model.actionRequired?.progress, "1 / 1 verified");
    assert.equal(after.model.actionRequired?.submit.enabled, true);
    assert.equal(after.model.actionRequired?.ready, true);
    assert.equal(after.model.actionRequired?.headline, "Evidence ready for review");
    assert.match(after.html, new RegExp(`<button type="button" class="choice pass on" data-check="${CHECK_ID}" data-outcome="pass" aria-pressed="true"`), "Pass is visibly selected");
    assert.match(after.html, /class="primary" data-action="submitForReview" title="[^"]*">Submit result and continue</, "and enabled: no disabled attribute");
    assert.match(after.html, /1 \/ 1 verified|Evidence ready for review/);
  });

  it("a second outcome replaces the first, through the same path", async () => {
    const { runId, view } = await managedGate();
    let drafts: HumanCheckDrafts = {};
    for (const outcome of ["pass", "fail"] as const) {
      const rendered = view(drafts);
      const { document, posted } = runWebviewScript(rendered.html);
      document.dispatch("click", outcomeButton(rendered.html, CHECK_ID, outcome));
      assert.ok(isHumanCheckMessage(posted[0]));
      drafts = withHumanCheck(drafts, runId, posted[0].key as string, { outcome: posted[0].outcome as CheckOutcome });
    }
    const after = view(drafts);
    assert.deepEqual(drafts[runId], { [CHECK_ID]: { outcome: "fail", note: undefined } }, "one outcome per check, replaced in place");
    assert.equal(after.model.actionRequired?.required[0].record?.outcome, "fail");
    assert.equal(after.model.actionRequired?.progress, "0 / 1 verified · 1 failed");
    assert.equal(after.model.actionRequired?.submit.enabled, true, "a failure is evidence too; the reviewer rules on it");
    assert.match(after.html, new RegExp(`class="choice fail on" data-check="${CHECK_ID}" data-outcome="fail"`));
    assert.ok(!new RegExp(`class="choice pass on" data-check="${CHECK_ID}"`).test(after.html), "Pass is no longer selected");
  });

  it("Can't test posts the engine's own value, and a note rides the same wire", async () => {
    const { runId, view } = await managedGate();
    const rendered = view({});
    const { document, posted } = runWebviewScript(rendered.html);
    document.dispatch("click", outcomeButton(rendered.html, CHECK_ID, "blocked"));
    assert.deepEqual(posted[0], { type: "humanCheck", key: CHECK_ID, outcome: "blocked" }, "the button says Can't test; the recorded value is unchanged");
    assert.match(rendered.html, new RegExp(`data-check="${CHECK_ID}" data-outcome="blocked"[^>]*>Can't test</`));

    const area = new FakeTextArea("textarea", { class: "note", "data-check": CHECK_ID });
    area.value = "Ran it on the 2026.4 build.";
    document.dispatch("focusout", area);
    const note = posted[1];
    assert.deepEqual(note, { type: "humanCheck", key: CHECK_ID, note: "Ran it on the 2026.4 build." });
    assert.ok(isHumanCheckMessage(note), "a note for a gate check is accepted too");
    const drafts = withHumanCheck(withHumanCheck({}, runId, CHECK_ID, { outcome: "blocked" }), runId, CHECK_ID, { note: note.note as string });
    const after = view(drafts);
    assert.equal(after.model.actionRequired?.required[0].record?.note, "Ran it on the 2026.4 build.");
    assert.match(after.html, />Ran it on the 2026.4 build.<\/textarea>/, "the note is preserved and still editable");
  });

  it("nothing on this path runs the engine", async () => {
    const { view } = await managedGate();
    const rendered = view({});
    const { document, posted } = runWebviewScript(rendered.html);
    document.dispatch("click", outcomeButton(rendered.html, CHECK_ID, "pass"));
    assert.ok(
      posted.every((message) => message.type === "humanCheck"),
      "a result click posts nothing that could start a command",
    );
    // And the host's handler for it writes a draft and re-renders; the only
    // thing that runs the engine from this panel is Submit.
    const panel = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8");
    const handler = /private async recordHumanCheck[\s\S]*?\n {2}}\n/.exec(panel)?.[0] ?? "";
    assert.ok(handler, "recordHumanCheck exists");
    assert.match(handler, /this\.controller\.setHumanCheck\(stageScopeOf\(run\), message\.key/);
    assert.ok(!/launch|buildRun|Terminal|submitForReview/.test(handler), "no engine invocation on a draft");
  });
});

/**
 * The reported defect, on the path it actually happened on.
 *
 * Recording *Can't test* on one check, typing a note under it, then clicking
 * *Pass* on another check reset the first check to no outcome at all — and
 * only when it had a note. Nothing about it was visible when it happened,
 * because a note is stored without re-rendering: the page kept showing Can't
 * test selected until the next click rebuilt the document from state that no
 * longer said so.
 *
 * The cause was the merge, not the wire. A note message carries no outcome,
 * and the host filled the missing field in as `outcome: undefined` before
 * merging, so spreading the change over the stored record overwrote the
 * outcome with nothing. The mirror image lost the note: an outcome click
 * carries no note, and the same fill-in blanked it.
 *
 * So `undefined` in a change now means "this field was not part of this
 * message" everywhere, and the two controls of one check can no longer erase
 * each other's work.
 */
describe("a note and an outcome are recorded independently", () => {
  it("typing a note keeps the outcome that was already recorded — the reported bug", async () => {
    const { runId, view } = await managedGate(2);
    let drafts: HumanCheckDrafts = {};

    // Can't test on check 1, through the shipped script.
    const first = view(drafts);
    const blocked = runWebviewScript(first.html);
    blocked.document.dispatch("click", outcomeButton(first.html, CHECK_ID, "blocked"));
    assert.ok(isHumanCheckMessage(blocked.posted[0]));
    drafts = withHumanCheck(drafts, runId, CHECK_ID, { outcome: blocked.posted[0].outcome as CheckOutcome, note: blocked.posted[0].note as string | undefined });

    // A note under it, from the same real textarea. The message carries a
    // note and no outcome, exactly as the shipped listener sends it.
    const withOutcome = view(drafts);
    const typing = runWebviewScript(withOutcome.html);
    const area = elementFrom(withOutcome.html, "textarea", new RegExp(`<textarea class="note" data-check="${CHECK_ID}"[^>]*>`), "the note field of check 1");
    area.value = "No pre-activation device available this week.";
    typing.document.dispatch("focusout", area);
    const note = typing.posted[0];
    assert.deepEqual({ ...note }, { type: "humanCheck", key: CHECK_ID, note: "No pre-activation device available this week." });
    // The host fills in the field the message did not carry, which is what
    // made this a data-loss bug rather than a missing feature.
    drafts = withHumanCheck(drafts, runId, note.key as string, { outcome: note.outcome as CheckOutcome | undefined, note: note.note as string });

    assert.deepEqual(drafts[runId][CHECK_ID], { outcome: "blocked", note: "No pre-activation device available this week." }, "the note is added; the outcome stays");

    // Pass on check 2 — the click that rebuilt the page and revealed the loss.
    const second = view(drafts);
    const passing = runWebviewScript(second.html);
    passing.document.dispatch("click", outcomeButton(second.html, SECOND_ID, "pass"));
    const pass = passing.posted[0];
    drafts = withHumanCheck(drafts, runId, pass.key as string, { outcome: pass.outcome as CheckOutcome, note: pass.note as string | undefined });

    const after = view(drafts);
    const panel = after.model.actionRequired!;
    assert.deepEqual(
      panel.required.map((item) => [item.key, item.record?.outcome, item.record?.note]),
      [
        [CHECK_ID, "blocked", "No pre-activation device available this week."],
        [SECOND_ID, "pass", undefined],
      ],
      "check 1 still says Can't test, with its note; check 2 says Pass",
    );
    assert.equal(panel.progress, "1 / 2 verified · 1 couldn't test");
    assert.equal(panel.submit.enabled, true, "both checks have a result, so the evidence can go back");
    assert.match(after.html, new RegExp(`class="choice blocked on" data-check="${CHECK_ID}" data-outcome="blocked" aria-pressed="true"`), "and the selection is still visible");
    assert.match(after.html, />No pre-activation device available this week\.<\/textarea>/);
  });

  it("clicking an outcome keeps the note that was already typed — the same bug, mirrored", async () => {
    const { runId, view } = await managedGate(2);
    let drafts: HumanCheckDrafts = {};

    const start = view(drafts);
    const typing = runWebviewScript(start.html);
    const area = elementFrom(start.html, "textarea", new RegExp(`<textarea class="note" data-check="${CHECK_ID}"[^>]*>`), "the note field of check 1");
    area.value = "Ran it on the 2026.4 build; the placeholder does not flash.";
    typing.document.dispatch("focusout", area);
    drafts = withHumanCheck(drafts, runId, CHECK_ID, { outcome: undefined, note: typing.posted[0].note as string });

    const noted = view(drafts);
    const clicking = runWebviewScript(noted.html);
    clicking.document.dispatch("click", outcomeButton(noted.html, CHECK_ID, "pass"));
    drafts = withHumanCheck(drafts, runId, CHECK_ID, { outcome: clicking.posted[0].outcome as CheckOutcome, note: clicking.posted[0].note as string | undefined });

    assert.deepEqual(drafts[runId][CHECK_ID], { outcome: "pass", note: "Ran it on the 2026.4 build; the placeholder does not flash." }, "the evidence someone typed survives recording the result it belongs to");
    const after = view(drafts);
    assert.equal(after.model.actionRequired?.required[0].record?.note, "Ran it on the 2026.4 build; the placeholder does not flash.");
    assert.match(after.html, />Ran it on the 2026.4 build; the placeholder does not flash\.<\/textarea>/);
  });

  it("changing the outcome three times never touches the note, and emptying the field clears only the note", async () => {
    const runId = "run|a";
    let drafts = withHumanCheck(undefined, runId, CHECK_ID, { note: "Two clients agree." });
    for (const outcome of ["pass", "fail", "blocked"] as const) {
      drafts = withHumanCheck(drafts, runId, CHECK_ID, { outcome, note: undefined });
      assert.equal(drafts[runId][CHECK_ID].note, "Two clients agree.", `still there after ${outcome}`);
      assert.equal(drafts[runId][CHECK_ID].outcome, outcome);
    }
    // Emptying the textarea is a note of "", not an absent note: that is how a
    // person withdraws what they wrote, and it must not withdraw the result.
    drafts = withHumanCheck(drafts, runId, CHECK_ID, { outcome: undefined, note: "" });
    assert.deepEqual(drafts[runId][CHECK_ID], { outcome: "blocked" });
    assert.deepEqual(withHumanCheck(drafts, runId, CHECK_ID, { note: "   " })[runId][CHECK_ID], { outcome: "blocked" }, "whitespace is no note either");
  });
});

describe("what counts as a draft key", () => {
  it("both shapes the extension writes: a derived check's hash and a gate check's stable id", () => {
    assert.ok(isCheckKey("1a2b3c4d"), "the djb2 hash of a derived check");
    assert.ok(isCheckKey(CHECK_ID), "the reviewer's stable gate id — this is the one that was refused");
    assert.ok(isCheckKey("desktop.v2:feed_check-1"), "ids are the reviewer's to choose; the engine only bounds their length");
  });

  it("refuses what it cannot round-trip, and nothing else", () => {
    assert.ok(!isCheckKey(""), "no key at all");
    assert.ok(!isCheckKey("a".repeat(129)), "longer than the engine's own limit");
    assert.ok(!isCheckKey("has`backtick"), "the backtick delimits the id inside a ## Human evidence line");
    assert.ok(!isCheckKey("has\nnewline"));
    assert.ok(!isCheckKey(undefined));
    assert.ok(!isCheckKey(42));
  });

  it("a check whose id cannot be a key still gets a working control", () => {
    // Better a result matched by its wording than a button that does nothing.
    const gate = { category: "OTHER", title: "t", checks: [{ id: "bad`id", instruction: "Do the thing.", passCriteria: "It worked." }] };
    const view = deriveVerification({ explicit: [], parents: [] }, { action: "NEEDS_YOU", summary: "s", humanGate: gate }, [], {});
    const key = view.required[0].key;
    assert.ok(isCheckKey(key), "the fallback key is one the host will accept");
    assert.notEqual(key, "bad`id");
  });
});
