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

function sparringWithGate(): string {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "Confirm the supported pre-activation desktop reads snapshot-v2 feeds safely", checks: [{ id: CHECK_ID, instruction: INSTRUCTION, pass_criteria: PASS_CRITERIA, source: null }] };
  return ["# Sparring: stage 3d", "", "## Routing outcome", "", "- Action: `NEEDS_YOU`", "- Summary: One compatibility check is the sole acceptance blocker.", "- Needs-you reason: DEVICE/MANUAL CHECK -- a pre-activation desktop against a v2 feed.", "", "## NEEDS YOU", "", HUMAN_GATE_MARKER, "", "```json", JSON.stringify(gate, null, 2), "```", ""].join("\n");
}

// ---------------------------------------------------------------- a DOM the shipped script can run against

interface Posted {
  type: string;
  [field: string]: unknown;
}

/** Just enough of an element for the shipped listener: attributes, `closest`, `disabled`, and a value. */
class FakeElement {
  readonly attributes: Record<string, string>;
  disabled = false;
  value = "";
  constructor(
    readonly tag: string,
    attributes: Record<string, string>,
    readonly parent?: FakeElement,
  ) {
    this.attributes = attributes;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
  /** `button[data-check][data-outcome]` and friends: a tag plus required attributes, walked up the parents. */
  closest(selector: string): FakeElement | null {
    const [, tag, rest] = /^([a-z]+)((?:\[[^\]]+\])*)$/.exec(selector) ?? [];
    const wanted = [...(rest ?? "").matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    const matches = (node: FakeElement): boolean => node.tag === tag && wanted.every((attribute) => node.hasAttribute(attribute));
    if (matches(this)) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
}

class FakeTextArea extends FakeElement {}

/** The document as the shipped script uses it: three delegated listeners on one root. */
class FakeDocument {
  private readonly listeners = new Map<string, ((event: { target: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { target: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, target: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target });
    }
  }
}

/**
 * Run the script the document actually ships, and return the DOM it bound
 * itself to plus everything it posts. Nothing here is a re-implementation:
 * the listener under test is the string inside the rendered `<script>`.
 */
function runWebviewScript(html: string): { document: FakeDocument; posted: Posted[] } {
  const script = /<script nonce="n">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the document ships a script");
  const document = new FakeDocument();
  const posted: Posted[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const run = new Function("document", "acquireVsCodeApi", "Element", "HTMLTextAreaElement", "setTimeout", "clearTimeout", script);
  run(
    document,
    () => ({ postMessage: (message: Posted) => posted.push(message) }),
    FakeElement,
    FakeTextArea,
    (fn: () => void) => {
      const timer = setTimeout(fn, 0);
      timers.push(timer);
      return timer;
    },
    (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  );
  return { document, posted };
}

/** The Pass / Fail / Can't test button for a check, built from the markup the renderer emitted. */
function outcomeButton(html: string, key: string, outcome: CheckOutcome): FakeElement {
  const markup = new RegExp(`<button[^>]*data-check="${key}" data-outcome="${outcome}"[^>]*>`).exec(html)?.[0];
  assert.ok(markup, `the document has a ${outcome} control for ${key}`);
  const attributes: Record<string, string> = {};
  for (const [, name, value] of markup.matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attributes[name] = value;
  }
  assert.ok("data-check" in attributes && "data-outcome" in attributes, "the attributes the listener selects on");
  return new FakeElement("button", attributes);
}

// ---------------------------------------------------------------- the run

async function managedGate() {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_3D, expected_branch: "feature/x", source: "manifest" });
  await ws.writeStage("stage-1-contract", { status: "accepted" });
  await ws.writeStage(STAGE_3D, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparringWithGate() });
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
    assert.equal(before.model.actionRequired?.progress, "0 / 1 verified");
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
    assert.match(handler, /this\.controller\.setHumanCheck\(run\.id, message\.key/);
    assert.ok(!/launch|buildRun|Terminal|submitForReview/.test(handler), "no engine invocation on a draft");
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
