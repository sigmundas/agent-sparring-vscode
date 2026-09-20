/**
 * What a person sees when a reviewer owes a check instead of stopping for it.
 *
 * Two screens, and the difference between them is the whole feature:
 *
 *  - a stage accepted with a deferral is **not** waiting for anybody. The
 *    journey continues, and the panel says "Review passed — 1 manual check
 *    deferred until plan completion" beside the run's other standing facts;
 *  - the plan's verification checkpoint **is** waiting, and says so — but as
 *    the plan's own checkpoint, with every check still naming the stage that
 *    raised it and the reviewer's reason for leaving it until now.
 *
 * The controls are the existing Pass / Fail / Can't test, deliberately: a
 * second evidence surface would mean a second set of rules about which
 * recorded answer counts, which is exactly what the gate instance settles.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildResumePlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { DEFERRED_GATE_MARKER, DEFERRED_VERIFICATION_REQUIRED, obligationFailed, obligationResolved, parseDeferredHumanGate, parsePlanRunState, parseSparringOutcome } from "../core/engineFormats";
import { draftKeyFor } from "../core/humanChecks";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_PLAN_MARKDOWN, FOO_STAGE_IDS, Workspace, normalUi } from "./fixtures";

const NOW = Date.parse("2026-09-20T10:00:00.000Z");
const [STAGE_1, STAGE_2, STAGE_3] = FOO_STAGE_IDS;
const INSTANCE_1 = "aa11bb22";
const INSTANCE_2 = "cc33dd44";
const RATIONALE_1 = "Later stages consume the comparison model, not its pixel layout, so a failed readability check would need only a local UI adjustment.";
const RATIONALE_2 = "No later stage reads this surface, and a failure here is a bounded local fix.";

function gate(instanceId: string, checkId: string, title: string) {
  return {
    category: "UI_VISUAL_CHECK",
    title,
    checks: [
      {
        id: checkId,
        instruction: "Open the summary dialog and resize it from 1400px down to 700px.",
        pass_criteria: "Labels stay legible and nothing clips. Fail if text overlaps.",
        source: null,
      },
    ],
    instance_id: instanceId,
  };
}

function obligation(stageId: string, instanceId: string, checkId: string, title: string, rationale: string, results: unknown[] = []) {
  return {
    stage_id: stageId,
    gate: gate(instanceId, checkId, title),
    rationale,
    checkpoint: "before_plan_completion",
    promoted: false,
    results,
  };
}

/** A READY verdict that deferred a check, exactly as sparring_exchange.py renders it. */
function sparringWithDeferral(): string {
  return [
    "# Sparring: stage 1",
    "",
    "## Routing outcome",
    "",
    "- Action: `READY`",
    "- Summary: The comparison model is correct and covered.",
    "",
    "## READY",
    "",
    "The comparison model is correct and covered.",
    "",
    `**Human verification deferred, not waived** — UI_VISUAL_CHECK — Check comparison readability`,
    "",
    `Reviewer's rationale for deferring: ${RATIONALE_1}`,
    "",
    DEFERRED_GATE_MARKER,
    "",
    "```json",
    JSON.stringify({ ...gate(INSTANCE_1, "resize-readability", "Check comparison readability"), rationale: RATIONALE_1, checkpoint: "before_plan_completion" }, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * A run mid-plan: stage 1 accepted with a deferral, stage 2 the current
 * stage, nothing waiting for anybody.
 */
async function midPlan() {
  const ws = await Workspace.create();
  await ws.writePlan(FOO_PLAN_LABEL, FOO_PLAN_MARKDOWN);
  await ws.writePlanRun(FOO_PLAN_KEY, {
    plan: FOO_PLAN_LABEL,
    status: "running",
    current_stage_index: 1,
    current_stage: STAGE_2,
    deferred_human_checks: [obligation(STAGE_1, INSTANCE_1, "resize-readability", "Check comparison readability", RATIONALE_1)],
  });
  await ws.writeStage(STAGE_1, { status: "accepted", candidate_sha: "a".repeat(40) }, { "sparring.md": sparringWithDeferral() });
  await ws.writeStage(STAGE_2, { status: "working", implementation_session_id: "impl-2" });
  return render(ws);
}

/** The same run, with results already in the engine's ledger for stage 1's obligation. */
async function midPlanWith(results: unknown[]) {
  const ws = await Workspace.create();
  await ws.writePlan(FOO_PLAN_LABEL, FOO_PLAN_MARKDOWN);
  await ws.writePlanRun(FOO_PLAN_KEY, {
    plan: FOO_PLAN_LABEL,
    status: "running",
    current_stage_index: 1,
    current_stage: STAGE_2,
    deferred_human_checks: [obligation(STAGE_1, INSTANCE_1, "resize-readability", "Check comparison readability", RATIONALE_1, results)],
  });
  await ws.writeStage(STAGE_1, { status: "accepted", candidate_sha: "a".repeat(40) }, { "sparring.md": sparringWithDeferral() });
  await ws.writeStage(STAGE_2, { status: "working", implementation_session_id: "impl-2" });
  return render(ws);
}

/** The plan's verification checkpoint: every stage accepted, two obligations owed. */
async function atCheckpoint(options: { results?: unknown[]; reason?: "plan_completion" | "promoted"; drafts?: OverviewArtifacts["humanChecks"] } = {}) {
  const ws = await Workspace.create();
  await ws.writePlan(FOO_PLAN_LABEL, FOO_PLAN_MARKDOWN);
  await ws.writePlanRun(FOO_PLAN_KEY, {
    plan: FOO_PLAN_LABEL,
    status: "paused",
    current_stage_index: 2,
    current_stage: STAGE_3,
    awaiting: { kind: DEFERRED_VERIFICATION_REQUIRED, reason: options.reason ?? "plan_completion", instance_ids: [INSTANCE_1, INSTANCE_2] },
    deferred_human_checks: [
      obligation(STAGE_1, INSTANCE_1, "resize-readability", "Check comparison readability", RATIONALE_1, options.results ?? []),
      obligation(STAGE_2, INSTANCE_2, "android-smoke", "Open it once on a real device", RATIONALE_2),
    ],
  });
  for (const stageId of [STAGE_1, STAGE_2, STAGE_3]) {
    await ws.writeStage(stageId, { status: "accepted", candidate_sha: "a".repeat(40) });
  }
  return render(ws, options.drafts);
}

async function render(ws: Workspace, drafts?: OverviewArtifacts["humanChecks"]) {
  const artifacts: OverviewArtifacts = {
    handoff: false,
    sparring: true,
    brief: false,
    plan: true,
    planText: FOO_PLAN_MARKDOWN,
    git: { branch: "feature/x", head: "9b99189a" },
    humanChecks: drafts ?? {},
  };
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const model = buildOverviewModel(selection, undefined, artifacts, NOW);
  return { ws, model, html: renderOverviewHtml(model, "n", "c") };
}

describe("reading the engine's record of a deferral", () => {
  it("a READY verdict's deferred gate carries its rationale and its asking", () => {
    const outcome = parseSparringOutcome(sparringWithDeferral());
    assert.equal(outcome?.action, "READY");
    const deferred = outcome?.deferredHumanGate;
    assert.equal(deferred?.rationale, RATIONALE_1);
    assert.equal(deferred?.checkpoint, "before_plan_completion");
    assert.equal(deferred?.gate.instanceId, INSTANCE_1);
    assert.equal(deferred?.gate.checks[0].id, "resize-readability");
    // The immediate gate and the deferred one are different markers, so one
    // is never read as the other.
    assert.equal(outcome?.humanGate, undefined);
  });

  it("a deferred block without a rationale is not read as a reviewer's decision", () => {
    const text = [DEFERRED_GATE_MARKER, "", "```json", JSON.stringify(gate(INSTANCE_1, "c", "t")), "```"].join("\n");
    assert.equal(parseDeferredHumanGate(text), undefined);
  });

  it("the ledger loads from the plan-run state, and an entry with no asking is dropped", () => {
    const state = parsePlanRunState(
      JSON.stringify({
        plan: FOO_PLAN_LABEL,
        plan_digest: "0".repeat(64),
        expected_branch: "feature/x",
        current_stage_index: 1,
        current_stage: STAGE_2,
        status: "running",
        deferred_human_checks: [
          obligation(STAGE_1, INSTANCE_1, "resize-readability", "t", RATIONALE_1),
          { ...obligation(STAGE_2, INSTANCE_2, "x", "t", RATIONALE_2), gate: { ...gate(INSTANCE_2, "x", "t"), instance_id: undefined } },
        ],
      }),
    );
    assert.equal(state.deferredHumanChecks.length, 1);
    assert.equal(state.deferredHumanChecks[0].stageId, STAGE_1);
    assert.equal(obligationResolved(state.deferredHumanChecks[0]), false);
  });

  it("an obligation is resolved only when every check passes; a Fail is visible as one", () => {
    const passed = parsePlanRunState(
      JSON.stringify({
        plan: FOO_PLAN_LABEL,
        plan_digest: "0".repeat(64),
        expected_branch: "feature/x",
        current_stage_index: 0,
        current_stage: STAGE_1,
        status: "paused",
        deferred_human_checks: [obligation(STAGE_1, INSTANCE_1, "c", "t", RATIONALE_1, [{ check_id: "c", outcome: "pass" }])],
      }),
    ).deferredHumanChecks[0];
    assert.equal(obligationResolved(passed), true);

    const blocked = { ...passed, results: [{ checkId: "c", outcome: "blocked" as const }] };
    assert.equal(obligationResolved(blocked), false, "could not be tested is not a result");

    const failed = { ...passed, results: [{ checkId: "c", outcome: "fail" as const }] };
    assert.equal(obligationResolved(failed), false);
    assert.equal(obligationFailed(failed), true);
  });

  it("a plan-run state with no ledger at all loads as owing nothing", () => {
    const state = parsePlanRunState(
      JSON.stringify({ plan: FOO_PLAN_LABEL, plan_digest: "0".repeat(64), expected_branch: "feature/x", current_stage_index: 0, current_stage: STAGE_1, status: "running" }),
    );
    assert.deepEqual(state.deferredHumanChecks, []);
    assert.equal(state.awaiting, undefined);
  });
});

describe("a stage accepted with a deferral", () => {
  it("does not say the stage is waiting, and does not open the checkpoint panel", async () => {
    const { model, html } = await midPlan();
    assert.equal(model.actionRequired, undefined);
    const ui = normalUi(html);
    assert.ok(!ui.includes("Waiting for you"), "nothing is waiting: the plan is on the next stage");
    assert.ok(!ui.includes("Manual verification required"));
  });

  it("counts only the checks still owed, and says nothing once they are all answered", async () => {
    const answered = await midPlanWith([{ check_id: "resize-readability", outcome: "pass" }]);
    assert.equal(answered.model.deferredNote, undefined, "nothing is owed, so there is nothing to note");

    const failed = await midPlanWith([{ check_id: "resize-readability", outcome: "fail" }]);
    assert.equal(failed.model.deferredNote?.label, "Review passed — 1 manual check deferred until plan completion");
  });

  it("says the review passed and the check is still owed, with the reviewer's reason", async () => {
    const { model, html } = await midPlan();
    assert.equal(model.deferredNote?.label, "Review passed — 1 manual check deferred until plan completion");
    assert.equal(model.deferredNote?.entries.length, 1);
    assert.equal(model.deferredNote?.entries[0].stageId, STAGE_1);
    assert.match(html, /Review passed — 1 manual check deferred until plan completion/);
    assert.ok(html.includes(RATIONALE_1), "the reviewer's reason is shown, not hidden");
  });
});

describe("the plan's verification checkpoint", () => {
  it("is the plan waiting, not a stage, and says how much came from where", async () => {
    const { model } = await atCheckpoint();
    const panel = model.actionRequired!;
    assert.equal(panel.kind, "deferred_verification");
    assert.equal(panel.headline, "Manual verification required — 2 deferred checks");
    assert.match(panel.subtitle ?? "", /2 deferred checks from 2 earlier stages/);
    assert.equal(model.stageLine, "Every stage is accepted. The plan finishes once the deferred manual checks are answered.");
    assert.ok(!normalUi(renderOverviewHtml(model, "n", "c")).includes("Waiting for you"));
  });

  it("groups the checks by the obligation that raised them, with each reviewer's reason", async () => {
    const { model, html } = await atCheckpoint();
    const groups = model.actionRequired!.deferredGroups!;
    assert.deepEqual(
      groups.map((group) => [group.stageId, group.instanceId]),
      [
        [STAGE_1, INSTANCE_1],
        [STAGE_2, INSTANCE_2],
      ],
    );
    assert.ok(html.includes(RATIONALE_1) && html.includes(RATIONALE_2));
    assert.ok(html.includes(`raised by ${STAGE_1}`) && html.includes(`raised by ${STAGE_2}`));
    assert.equal((html.match(/data-outcome="pass"/g) ?? []).length, 2, "one set of controls per check");
  });

  it("the drafts of each check belong to its own asking", async () => {
    const { model } = await atCheckpoint();
    const keys = model.actionRequired!.required.map((item) => item.draftKey);
    assert.deepEqual(keys, [draftKeyFor("resize-readability", INSTANCE_1), draftKeyFor("android-smoke", INSTANCE_2)]);
  });

  it("a result already in the engine's ledger is shown as recorded and is not asked again", async () => {
    const { model } = await atCheckpoint({ results: [{ check_id: "resize-readability", outcome: "pass", note: "legible at 700px" }] });
    const panel = model.actionRequired!;
    assert.equal(panel.recorded.length, 1);
    assert.equal(panel.recorded[0].evidence?.outcome, "pass");
    assert.deepEqual(panel.required.map((item) => item.key), ["android-smoke"]);
  });

  it("a recorded Fail is stated as one, and the panel does not call the plan finished", async () => {
    const { model } = await atCheckpoint({ results: [{ check_id: "resize-readability", outcome: "fail", note: "labels overlap under 800px" }] });
    const panel = model.actionRequired!;
    assert.match(panel.summary, /recorded as failed/);
    assert.match(panel.summary, /will not complete/);
    assert.equal(panel.ready, false);
  });

  it("a Fail or a Can't test stays answerable: only a Pass settles a check", async () => {
    // The engine keeps the run stopped on a failed or untested obligation, so
    // a panel that moved the check into "already recorded" left a plan that
    // could never finish: nothing to submit, and a summary saying the check
    // had to be answered again.
    for (const outcome of ["fail", "blocked"] as const) {
      const { model } = await atCheckpoint({ results: [{ check_id: "resize-readability", outcome, note: "what I saw" }] });
      const panel = model.actionRequired!;
      assert.deepEqual(panel.required.map((item) => item.key), ["resize-readability", "android-smoke"], outcome);
      assert.equal(panel.recorded.length, 0, outcome);
      // What was reported last time is still shown, as history.
      assert.deepEqual(panel.required[0].previous.map((entry) => entry.outcome), [outcome], outcome);
      assert.match(panel.submit.detail, /Record a result for/, outcome);
      assert.ok(!panel.submit.detail.includes("nothing further to send"), outcome);
    }
  });

  it("explains a still-owed check as the person's own result, not as the reviewer asking again", async () => {
    const { model, html } = await atCheckpoint({ results: [{ check_id: "resize-readability", outcome: "fail", note: "labels overlap" }] });
    assert.equal(model.actionRequired!.required[0].owedUntilPassed, true);
    assert.match(html, /a Pass is what settles a deferred check, so it is still owed/);
    assert.ok(!html.includes("the reviewer has asked it again"), "the reviewer asked once and is still waiting");
  });

  it("counts what is still owed, not what was ever deferred", async () => {
    const { model } = await atCheckpoint({ results: [{ check_id: "resize-readability", outcome: "pass" }] });
    assert.equal(model.actionRequired!.headline, "Manual verification required");
    // One asking is settled, so the quiet note is about the one that is not.
    assert.match(model.actionRequired!.subtitle ?? "", /1 deferred check from 1 earlier stage/);
  });

  it("submitting is offered only once every outstanding check has a drafted result", async () => {
    const none = await atCheckpoint();
    assert.equal(none.model.actionRequired!.submit.enabled, false);
    assert.match(none.model.actionRequired!.submit.detail, /Record a result for the remaining checks \(resize-readability and android-smoke\) first/);

    const half = await atCheckpoint({ drafts: { [draftKeyFor("resize-readability", INSTANCE_1)]: { outcome: "pass" } } });
    assert.equal(half.model.actionRequired!.submit.enabled, false);
    assert.equal(half.model.actionRequired!.submittable.length, 1);

    const both = await atCheckpoint({
      drafts: {
        [draftKeyFor("resize-readability", INSTANCE_1)]: { outcome: "pass", note: "legible at 700px" },
        [draftKeyFor("android-smoke", INSTANCE_2)]: { outcome: "fail" },
      },
    });
    const panel = both.model.actionRequired!;
    assert.equal(panel.submit.enabled, true);
    // Each drafted result still carries the asking it answers, which is what
    // the engine is addressed with.
    assert.deepEqual(
      panel.submittable.map((check) => [check.gateInstanceId, check.id, check.record.outcome]),
      [
        [INSTANCE_1, "resize-readability", "pass"],
        [INSTANCE_2, "android-smoke", "fail"],
      ],
    );
  });

  it("a promoted obligation says why the run stopped early", async () => {
    const { model } = await atCheckpoint({ reason: "promoted" });
    assert.match(model.actionRequired!.subtitle ?? "", /can wait no longer/);
    assert.match(model.stageLine ?? "", /can wait no longer/);
  });

  it("offers no freeform feedback channel: there is no candidate under review to send it about", async () => {
    const { model, html } = await atCheckpoint();
    assert.equal(model.actionRequired!.feedback.send.enabled, false);
    assert.ok(!html.includes("Additional findings or instructions"));
  });

  it("the plan's own Resume action is withdrawn; submitting is what continues the run", async () => {
    const { model } = await atCheckpoint();
    assert.equal(model.planAction, undefined);
    assert.equal(model.continueAutomatically, undefined);
  });
});

describe("addressing an answer back to the engine", () => {
  it("every result is qualified by its asking, so an ambiguous check id cannot happen", () => {
    const args = buildResumePlanArgs({
      planPath: "docs/plans/foo.md",
      repoRoot: "/repo",
      sparringDir: "/repo/.sparring",
      expectedBranch: "feature/x",
      source: "markdown",
      deferredResults: [
        { gateInstanceId: INSTANCE_1, checkId: "resize-readability", outcome: "pass", note: "legible at 700px" },
        { gateInstanceId: INSTANCE_2, checkId: "resize-readability", outcome: "fail" },
      ],
    });
    assert.ok(args.includes(`${INSTANCE_1}:resize-readability=pass=legible at 700px`));
    assert.ok(args.includes(`${INSTANCE_2}:resize-readability=fail`));
    assert.equal(args.filter((arg) => arg === "--deferred-result").length, 2);
    assert.ok(!args.includes("--evidence"));
  });

  it("a note is flattened to one argument, and a run with nothing deferred sends no flag", () => {
    const args = buildResumePlanArgs({
      planPath: "docs/plans/foo.md",
      repoRoot: "/repo",
      sparringDir: "/repo/.sparring",
      expectedBranch: "feature/x",
      source: "markdown",
      deferredResults: [{ gateInstanceId: INSTANCE_1, checkId: "c", outcome: "blocked", note: "no device\nhere" }],
    });
    assert.ok(args.includes(`${INSTANCE_1}:c=blocked=no device here`));
    const plain = buildResumePlanArgs({ planPath: "docs/plans/foo.md", repoRoot: "/repo", sparringDir: "/repo/.sparring", expectedBranch: "feature/x", source: "markdown" });
    assert.ok(!plain.includes("--deferred-result"));
  });
});
