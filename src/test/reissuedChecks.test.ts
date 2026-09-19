/**
 * A reviewer can ask the same check again, and be answered.
 *
 * The reported situation, from a real Stage 2 review. The gate asked for a
 * product decision; the person recorded `Pass`; the reviewer read that and
 * said, in the next gate, exactly what was wrong with it:
 *
 *   "Record one choice in text: 'Accept Stage 2 with batch attachment
 *    disabled temporarily'; 'Land the separate attach-result dependency
 *    first'; or 'Authorize a bounded callback-contract change.'
 *    **A Pass alone does not identify the choice.**"
 *
 * Same check id, on purpose — it is the same subject. But the panel keyed
 * recorded evidence on that id alone, found the earlier `Pass`, and reported
 * the gate complete: "Evidence ready for review", "1 / 1 verified", nothing
 * outstanding. And because there was nothing outstanding, there was nothing
 * to submit, so pressing the button answered:
 *
 *   "Agent Sparring: record Pass, Fail or Blocked for the remaining checks
 *    first."
 *
 * — about a check it was simultaneously reporting as done. The question the
 * reviewer had deliberately re-asked could not be answered at all, from
 * either direction.
 *
 * Two things are pinned here, and they are separate:
 *
 *  - evidence answers a *gate instance*, not a check id forever, so a
 *    re-issued check reopens and the earlier answer becomes visible history;
 *  - `ready` and the submittable evidence are one derivation, so the panel
 *    and the submit command can never again disagree about whether there is
 *    anything to send.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER, parseHumanGate } from "../core/engineFormats";
import { appendHumanEvidence, draftKeyFor, renderHumanEvidence, submittableChecks, type CheckRecord } from "../core/humanChecks";
import { isHumanCheckMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-19T15:00:00.000Z");
const STAGE_2 = "stage-2-library-row-anatomy-relevance-grouping-and-multi-select";
const BRANCH = "feature/add-reference-dialog-redesign";
const PLAN_LABEL = "docs/plans/active/add-reference-dialog-redesign.md";
const PLAN_KEY = "add-reference-dialog-019933fd";
const PLAN = ["# Add reference dialog redesign", "", "## Stage 2 — Library row anatomy, relevance grouping and multi-select", "", "Owns the library list and add-to-plot behaviour.", ""].join("\n");

const SCOPE = "batch-attachment-scope";
const OTHER = "library-resize";

/** The first asking: a Pass is enough, as far as this gate says. */
const ASK_1 = "Choose whether to land the separate attach-result dependency, authorize a bounded callback-contract change, or explicitly amend Stage 2 to accept disabled multi-source attachment temporarily.";
/** The second: the reviewer has read the Pass and says why it was not an answer. */
const ASK_2 = "Record one choice in text: “Accept Stage 2 with batch attachment disabled temporarily”; “Land the separate attach-result dependency first”; or “Authorize a bounded callback-contract change.” A Pass alone does not identify the choice.";
/** The third, after an answer that named two of the three. */
const ASK_3 = "Name exactly one of the three options, not two.";

const RESIZE = "Shrink and re-grow the dialog and its Library splitter pane with a source selected.";

interface GateCheck {
  id: string;
  instruction: string;
  pass_criteria: string;
  source: string | null;
}

/** sparring.md as sparring_exchange.py renders it, for one asking of a gate. */
function sparring(instanceId: string | null, checks: GateCheck[]): string {
  const gate = { category: "PRODUCT_PREFERENCE", title: "Choose the batch-attachment acceptance scope", checks, ...(instanceId ? { instance_id: instanceId } : {}) };
  return [
    "# Sparring: stage 2",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: Only the explicit decision about disabled multi-source attachment remains outstanding.",
    "- Needs-you reason: PRODUCT/PREFERENCE -- the recorded batch-scope Pass does not identify which option was chosen.",
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

function scopeCheck(instruction: string): GateCheck {
  return { id: SCOPE, instruction, pass_criteria: "An explicit choice is recorded.", source: null };
}

const RESIZE_CHECK: GateCheck = { id: OTHER, instruction: RESIZE, pass_criteria: "Nothing clips and nothing is lost.", source: null };

/** A paused managed plan run at the gate, rebuilt from whatever state a test wants. */
async function scene(options: { instanceId?: string | null; checks?: GateCheck[] } = {}) {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 1, current_stage: STAGE_2, expected_branch: BRANCH, source: "markdown" });
  const gateOf = (instanceId: string | null, checks: GateCheck[]) => sparring(instanceId, checks);
  await ws.writeStage(STAGE_2, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": gateOf(options.instanceId === undefined ? "gateA" : options.instanceId, options.checks ?? [scopeCheck(ASK_1)]) });
  const selection = selectRun((await discoverRuns([ws.location])).runs);

  /** Rebuild the panel from the current sparring.md plus whatever notes/drafts are given. */
  const view = (state: { notes?: string; drafts?: Record<string, CheckRecord> } = {}) => {
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: true,
      brief: false,
      plan: true,
      planText: PLAN,
      git: { branch: BRANCH, head: "f2e455c9" },
      humanChecks: state.drafts ?? {},
      notesText: state.notes,
    };
    const model = buildOverviewModel(selection, undefined, artifacts, NOW);
    return { model, panel: model.actionRequired!, html: renderOverviewHtml(model, "n", "c") };
  };

  /** The engine records a new verdict: the same stage, a new asking. */
  const reask = async (instanceId: string | null, checks: GateCheck[]) => {
    await fs.writeFile(path.join(ws.root, ".sparring", "stages", STAGE_2, "sparring.md"), gateOf(instanceId, checks));
    const again = selectRun((await discoverRuns([ws.location])).runs);
    return (state: { notes?: string; drafts?: Record<string, CheckRecord> } = {}) => {
      const artifacts: OverviewArtifacts = {
        handoff: false,
        sparring: true,
        brief: false,
        plan: true,
        planText: PLAN,
        git: { branch: BRANCH, head: "f2e455c9" },
        humanChecks: state.drafts ?? {},
        notesText: state.notes,
      };
      const model = buildOverviewModel(again, undefined, artifacts, NOW);
      return { model, panel: model.actionRequired!, html: renderOverviewHtml(model, "n", "c") };
    };
  };

  return { ws, view, reask };
}

/** notes.md after the person answered `instanceId`'s asking of the scope check. */
function answered(instruction: string, instanceId: string | undefined, record: CheckRecord, onto = "# Notes: stage 2\n"): string {
  const entry = renderHumanEvidence([{ text: instruction, origin: "gate", id: SCOPE, gateInstanceId: instanceId, record }], new Date(NOW))!;
  return appendHumanEvidence(onto, entry);
}

describe("a re-issued check is a new evidence obligation", () => {
  it("1. the earlier Pass becomes history, and the re-asked check is answerable again", async () => {
    const { view, reask } = await scene();

    // Gate A, answered.
    const notes = answered(ASK_1, "gateA", { outcome: "pass" });
    const first = view({ notes }).panel;
    assert.equal(first.recorded.length, 1, "answered, for the gate that asked");
    assert.equal(first.required.length, 0);

    // Gate B: same check id, new asking, stricter requirement.
    const atB = await reask("gateB", [scopeCheck(ASK_2)]);
    const panel = atB({ notes }).panel;

    assert.equal(panel.recorded.length, 0, "the old Pass is not this gate's answer");
    assert.equal(panel.required.length, 1, "the check is answerable again");
    assert.equal(panel.required[0].key, SCOPE, "and it is still the same check");
    assert.equal(panel.required[0].text, ASK_2, "asked in the reviewer's new words");

    // The old answer is kept and shown, not deleted and not counted.
    assert.equal(panel.required[0].previous.length, 1);
    assert.equal(panel.required[0].previous[0].outcome, "pass");
    assert.match(panel.required[0].previous[0].excerpt, /Choose whether to land the separate attach-result dependency/);

    assert.equal(panel.ready, false, "nothing has answered this asking");
    assert.equal(panel.submit.enabled, false);
    assert.equal(panel.progress, "0 / 1 verified · 1 remaining");
    assert.notEqual(panel.headline, "Evidence ready for review");
  });

  it("1b. the panel shows the previous answer, and says it is previous", async () => {
    const { reask } = await scene();
    const notes = answered(ASK_1, "gateA", { outcome: "pass" });
    const { html } = (await reask("gateB", [scopeCheck(ASK_2)]))({ notes });

    assert.match(html, /<div class="previous"[^>]*><p class="lead muted small">Your previous answer to this check — the reviewer has asked it again/);
    assert.match(html, /<span class="outcome pass">Pass<\/span>/);
    // And the controls for the current asking are there to be used.
    assert.match(html, new RegExp(`data-check="${draftKeyFor(SCOPE, "gateB")}" data-outcome="pass"`));
  });

  it("2. answering the new asking makes it ready, and sends exactly that answer", async () => {
    const { reask } = await scene();
    const notes = answered(ASK_1, "gateA", { outcome: "pass" });
    const atB = await reask("gateB", [scopeCheck(ASK_2)]);

    const drafts = { [draftKeyFor(SCOPE, "gateB")]: { outcome: "pass" as const, note: "Accept Stage 2 with batch attachment disabled temporarily." } };
    const panel = atB({ notes, drafts }).panel;

    assert.equal(panel.ready, true);
    assert.equal(panel.submit.enabled, true);
    assert.equal(panel.progress, "1 / 1 verified");

    // The submit command reads the same array the panel decided `ready` from.
    const sending = submittableChecks(panel);
    assert.equal(sending.length, 1);
    assert.equal(sending[0].id, SCOPE);
    assert.equal(sending[0].gateInstanceId, "gateB", "attributed to the asking it answers");
    assert.equal(sending[0].record.note, "Accept Stage 2 with batch attachment disabled temporarily.");

    const entry = renderHumanEvidence(sending, new Date(NOW))!;
    assert.match(entry, new RegExp(`· check \`${SCOPE}\` · gate \`gateB\``));
    assert.match(entry, /Accept Stage 2 with batch attachment disabled temporarily\./);
    // The old Pass is not re-sent as though it were the new answer.
    assert.equal((entry.match(/- Pass —/g) ?? []).length, 1, "one result, the one just recorded");
    assert.ok(!entry.includes("gateA"), "the earlier asking's answer is not resubmitted");

    // And that is what reaches the engine.
    const args = buildResumePlanArgs({ source: "markdown", planPath: PLAN_LABEL, repoRoot: "/repo", expectedBranch: BRANCH, evidence: entry });
    const evidence = args[args.indexOf("--evidence") + 1];
    assert.equal(evidence, entry.trim());
    assert.match(evidence, /gate `gateB`/);
  });

  it("3. rendering the same gate again keeps the answer attached to it", async () => {
    const { reask } = await scene();
    const drafts = { [draftKeyFor(SCOPE, "gateB")]: { outcome: "fail" as const, note: "None of the three is acceptable yet." } };

    // A reload, then the same gate re-read from disk: the draft is keyed by
    // run, stage and asking, none of which changed.
    for (let attempt = 0; attempt < 2; attempt++) {
      const panel = (await reask("gateB", [scopeCheck(ASK_2)]))({ drafts }).panel;
      assert.equal(panel.required[0].record?.outcome, "fail");
      assert.equal(panel.required[0].record?.note, "None of the three is acceptable yet.");
      assert.equal(panel.ready, true, "an answer is an answer, whichever of the three it is");
    }
  });

  it("4. a third asking keeps both earlier answers as history and is itself unanswered", async () => {
    const { reask } = await scene();
    let notes = answered(ASK_1, "gateA", { outcome: "pass" });
    notes = answered(ASK_2, "gateB", { outcome: "pass", note: "Land the dependency first, and also authorize the contract change." }, notes);

    const panel = (await reask("gateC", [scopeCheck(ASK_3)]))({ notes }).panel;
    assert.equal(panel.recorded.length, 0);
    assert.equal(panel.required.length, 1);
    assert.deepEqual(
      panel.required[0].previous.map((entry) => entry.outcome),
      ["pass", "pass"],
      "both earlier answers, oldest first",
    );
    assert.equal(panel.ready, false);
    // Nothing was rewritten in notes.md to achieve this.
    assert.equal((notes.match(/- Pass —/g) ?? []).length, 2);
  });

  it("5. a check the reviewer did not re-ask is unaffected by one it did", async () => {
    const { reask } = await scene({ checks: [scopeCheck(ASK_1), RESIZE_CHECK] });
    const notes = appendHumanEvidence(
      "# Notes: stage 2\n",
      renderHumanEvidence(
        [
          { text: ASK_1, origin: "gate", id: SCOPE, gateInstanceId: "gateA", record: { outcome: "pass" } },
          { text: RESIZE, origin: "gate", id: OTHER, gateInstanceId: "gateA", record: { outcome: "pass" } },
        ],
        new Date(NOW),
      )!,
    );

    // Both were answered at A. At B the reviewer re-asks only the scope
    // check — but B is a new asking of *the gate*, so the resize check is
    // asked again too, and its own earlier answer is its history.
    const panel = (await reask("gateB", [scopeCheck(ASK_2), RESIZE_CHECK]))({ notes }).panel;
    const resize = panel.required.find((item) => item.key === OTHER)!;
    assert.equal(resize.previous.length, 1, "its own answer, not the scope check's");
    assert.match(resize.previous[0].excerpt, /Shrink and re-grow the dialog/);
    assert.ok(
      !resize.previous.some((entry) => /attach-result dependency/.test(entry.excerpt)),
      "no evidence crosses from one check id to another",
    );

    // Answering one leaves the other outstanding.
    const drafts = { [draftKeyFor(OTHER, "gateB")]: { outcome: "pass" as const } };
    const partly = (await reask("gateB", [scopeCheck(ASK_2), RESIZE_CHECK]))({ notes, drafts }).panel;
    assert.equal(partly.ready, false, "one of two answered is not ready");
    assert.equal(submittableChecks(partly).length, 1);
  });

  it("6b. with no asking recorded, the panel does not claim the reviewer asked again", async () => {
    // It cannot know that. What it can say is that this gate does not record
    // which round it is — which is the true, narrower statement.
    const { view, reask } = await scene({ instanceId: null });
    const notes = answered(ASK_1, undefined, { outcome: "pass" });
    const legacy = view({ notes }).html;
    assert.match(legacy, /this gate does not record which round it is, so it needs an answer for this one/);
    assert.ok(!legacy.includes("the reviewer has asked it again"), "no claim about the reviewer");

    // Once the engine records an asking, it *is* a re-ask, and it says so.
    const current = (await reask("gateB", [scopeCheck(ASK_2)]))({ notes }).html;
    assert.match(current, /the reviewer has asked it again, so it needs an answer for this round/);
  });

  it("6. a gate recorded before instances existed loads, keeps its evidence, and can be answered", async () => {
    const { view } = await scene({ instanceId: null });
    const notes = answered(ASK_1, undefined, { outcome: "pass" });
    const panel = view({ notes }).panel;

    // Nothing here can tell a first asking from a fourth, so the honest
    // answer is that this is not proven to answer it.
    assert.equal(panel.recorded.length, 0, "not claimed as this gate's answer");
    assert.equal(panel.required.length, 1);
    assert.equal(panel.required[0].previous.length, 1, "and the answer is preserved, as history");
    assert.equal(panel.ready, false);

    // The draft key falls back to the bare check id, so a draft written
    // before any of this existed is still found.
    const legacyDraft = view({ notes, drafts: { [SCOPE]: { outcome: "pass" } } }).panel;
    assert.equal(legacyDraft.required[0].record?.outcome, "pass");
    assert.equal(legacyDraft.ready, true, "and it can be answered and sent");
    assert.equal(submittableChecks(legacyDraft)[0].gateInstanceId, undefined, "with no asking to name");
  });

  it("7. one stage's answers never reach another stage's gate", async () => {
    // The drafts store is keyed by run *and* stage before the asking is even
    // consulted, so a second stage at a gate with the same check id starts
    // empty. This pins that the asking-scoped key did not undo that.
    const { view } = await scene();
    const other = await scene();
    const drafts = { [draftKeyFor(SCOPE, "gateA")]: { outcome: "pass" as const } };

    assert.equal(view({ drafts }).panel.required[0].record?.outcome, "pass");
    // A different workspace is a different run id, so the same draft key is
    // not visible there; the scope key is what separates them.
    assert.equal(other.view({}).panel.required[0].record, undefined);
  });

  it("8. Pass, Fail and Can't test all still answer the current asking", async () => {
    const { reask } = await scene();
    for (const outcome of ["pass", "fail", "blocked"] as const) {
      const panel = (await reask("gateB", [scopeCheck(ASK_2)]))({ drafts: { [draftKeyFor(SCOPE, "gateB")]: { outcome } } }).panel;
      assert.equal(panel.ready, true, `${outcome} is an answer`);
      assert.equal(submittableChecks(panel)[0].record.outcome, outcome);
    }
  });

  it("9. the webview's message for a re-issued check is accepted by the host", async () => {
    // The control carries the composite draft key. A host guard that only
    // knew the bare check-key shape would drop it, and the button would do
    // nothing — silently, which is how this class of bug hides.
    const long = "a".repeat(120);
    assert.equal(isHumanCheckMessage({ type: "humanCheck", key: draftKeyFor(SCOPE, "gateB"), outcome: "pass" }), true);
    assert.equal(isHumanCheckMessage({ type: "humanCheck", key: draftKeyFor(long, "b".repeat(32)), outcome: "pass" }), true, "a long reviewer id still fits a draft key");
    assert.equal(isHumanCheckMessage({ type: "humanCheck", key: "", outcome: "pass" }), false);
  });
});

describe("the panel and the submit command share one definition of readiness", () => {
  it("10. ready is never true while there is nothing to submit", async () => {
    const { view, reask } = await scene();

    // The exact reported state: a non-empty gate, every check of it already
    // recorded, nothing drafted. This is what used to say "Evidence ready
    // for review" and then refuse to submit.
    const notes = answered(ASK_1, "gateA", { outcome: "pass" });
    const settled = view({ notes }).panel;
    assert.ok(settled.recorded.length + settled.required.length > 0, "the gate is not empty");
    assert.deepEqual(submittableChecks(settled), []);
    assert.equal(settled.ready, false, "nothing to send is not readiness");
    assert.equal(settled.submit.enabled, false);
    assert.match(settled.submit.detail, /already has a recorded result/);

    // The invariant, over every state this gate can be in.
    const states = [
      view({}),
      view({ notes }),
      view({ drafts: { [draftKeyFor(SCOPE, "gateA")]: { outcome: "pass" } } }),
      (await reask("gateB", [scopeCheck(ASK_2)]))({ notes }),
      (await reask("gateB", [scopeCheck(ASK_2)]))({ notes, drafts: { [draftKeyFor(SCOPE, "gateB")]: { outcome: "fail" } } }),
      (await reask(null, [scopeCheck(ASK_2)]))({ notes }),
    ];
    // The expected readiness of each state above, worked out by reading it
    // rather than by re-running the implementation's own formula: nothing
    // drafted, nothing drafted, one drafted, nothing drafted, one drafted,
    // nothing drafted.
    assert.deepEqual(
      states.map(({ panel }) => panel.ready),
      [false, false, true, false, true, false],
    );
    for (const { panel } of states) {
      if (panel.ready) {
        assert.ok(submittableChecks(panel).length > 0, "ready always has evidence to send");
        assert.equal(submittableChecks(panel).length, panel.required.length, "and it covers every outstanding check");
        assert.equal(panel.submit.enabled, true);
      }
      if (submittableChecks(panel).length === 0) {
        assert.equal(panel.ready, false, "nothing to send is never ready");
        assert.equal(panel.submit.enabled, false, "and a disabled button whenever there is nothing to send");
      }
    }
  });

  it("11. the gate instance survives a round trip through sparring.md", async () => {
    const gate = parseHumanGate(sparring("5b222f6b6ea7416885adb22d217caa47", [scopeCheck(ASK_2)]))!;
    assert.equal(gate.instanceId, "5b222f6b6ea7416885adb22d217caa47");
    assert.equal(gate.checks[0].id, SCOPE);
    assert.equal(parseHumanGate(sparring(null, [scopeCheck(ASK_2)]))!.instanceId, undefined);
  });
});
