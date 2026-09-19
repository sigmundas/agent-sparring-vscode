/**
 * A previous stage's submission must not describe the stage a person is
 * actually on.
 *
 * The reported workflow: Stage 1 of a managed plan run had a submission that
 * failed; the run went on to Stage 2; and the Overview kept the red
 * "Submission failed — your check results and feedback were preserved."
 * banner at the top of the Stage 2 panel. Nothing about Stage 2 was wrong,
 * and the screen said otherwise.
 *
 * The cause was identity, not rendering. A managed plan run keeps one run id
 * from its first stage to its last (`discovery.runIdFor`), and every piece of
 * per-person state this window holds — drafted results, notes, freeform
 * feedback, the submission record — was filed under that id alone. The fix is
 * one stage scope (`core/stageScope.ts`): run id *and* the stage id the
 * engine records, used as the storage key and checked again when the model is
 * built.
 *
 * These tests drive the same objects the extension does — the store helpers,
 * `buildOverviewModel`, `renderOverviewHtml` — for both stages of one plan
 * run, so an answer that is right only because a panel was recreated cannot
 * pass.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentStageOf, discoverRuns, selectRun, type RunSnapshot } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { humanChecksFor, humanFeedbackFor, withHumanCheck, withHumanFeedback, type CheckRecord, type HumanCheckDrafts, type HumanFeedbackDrafts } from "../core/humanChecks";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { migrateToStageScope, parseStageScopeKey, sameStageScope, stageScopeKey, stageScopeOf } from "../core/stageScope";
import {
  SUBMISSION_PRESERVED,
  submissionByExecution,
  submissionFailureReason,
  submissionFor,
  submissionKeyOf,
  withSubmission,
  withSubmissionFailure,
  withoutSubmission,
  type SubmissionRecord,
  type Submissions,
} from "../core/submission";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-19T09:00:00.000Z");
const [STAGE_1, STAGE_2] = FOO_STAGE_IDS;
const BRANCH = "feature/foo";

/** A NEEDS_YOU verdict with one structured gate check, in the engine's own shape. */
function sparring(checkId: string, instruction: string): string {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "One thing a person has to look at", checks: [{ id: checkId, instruction, pass_criteria: "It does what the plan says." }] };
  return [
    "# Sparring: x",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: One manual check is required before this stage is READY.",
    "- Needs-you reason: DEVICE/MANUAL CHECK -- a person has to look",
    "",
    "## NEEDS YOU",
    "",
    "One manual check is required before this stage is READY.",
    "",
    HUMAN_GATE_MARKER,
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
  ].join("\n");
}

const CHECK_1 = "stage-1-contract-check";
const CHECK_2 = "stage-2-schema-check";

/**
 * One managed plan run, readable at whichever stage it is currently on.
 *
 * `at(stageId)` rewrites the plan-run state exactly as the engine does when a
 * stage is accepted and the next one opens, and rediscovers — so "the run
 * advanced" is the same event here as in a real window, not a panel being
 * thrown away and rebuilt.
 */
async function planRun() {
  const ws = await Workspace.create();
  await ws.writePlan();
  await ws.writeStage(STAGE_1, { status: "working", sparring_session_id: "s1" }, { "sparring.md": sparring(CHECK_1, "Check the contract by hand.") });

  const at = async (stageId: string, index: number): Promise<RunSnapshot> => {
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: index, current_stage: stageId, expected_branch: BRANCH, source: "markdown" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    return selection.selected!;
  };

  /** Exactly what the panel does on every update: read the stores under the run's current scope, build, render. */
  const view = (run: RunSnapshot, stored: { checks?: HumanCheckDrafts; feedback?: HumanFeedbackDrafts; submissions?: Submissions; notes?: string }): { model: OverviewModel; html: string } => {
    const scope = stageScopeKey(stageScopeOf(run));
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: true,
      brief: false,
      plan: true,
      git: { branch: BRANCH },
      humanChecks: humanChecksFor(stored.checks, scope),
      humanFeedback: humanFeedbackFor(stored.feedback, scope),
      submission: submissionFor(stored.submissions, scope),
      notesText: stored.notes,
    };
    const selection = { selected: run, runs: [run], scope: undefined } as unknown as Parameters<typeof buildOverviewModel>[0];
    const model = buildOverviewModel(selection, undefined, artifacts, NOW);
    return { model, html: renderOverviewHtml(model, "n", "c") };
  };

  const openStage2 = async (): Promise<RunSnapshot> => {
    await ws.writeStage(STAGE_1, { status: "accepted", sparring_session_id: "s1" }, { "sparring.md": sparring(CHECK_1, "Check the contract by hand.") });
    await ws.writeStage(STAGE_2, { status: "working", sparring_session_id: "s2" }, { "sparring.md": sparring(CHECK_2, "Check the schema by hand.") });
    return at(STAGE_2, 1);
  };

  return { ws, stage1: await at(STAGE_1, 0), openStage2, view };
}

/** The record the host writes when evidence has been handed to the engine for the stage `run` is on. */
function submissionOf(run: RunSnapshot, executionId: string, results = 1): SubmissionRecord {
  return { runId: run.id, channel: "checks", executionId, startedAtMs: NOW, entry: `evidence for ${currentStageOf(run).stageId}`, results, stageId: currentStageOf(run).stageId };
}

describe("a submission belongs to the stage it was made for", () => {
  it("1–3. a Stage 1 failure is shown on Stage 1 and is gone the moment the run is on Stage 2", async () => {
    const { stage1, openStage2, view } = await planRun();

    // 1–2. Stage 1 submits and the engine refuses it. The run is still on
    // Stage 1, so the banner is exactly where it belongs.
    const record = submissionOf(stage1, "exec-1");
    const submissions = withSubmissionFailure(withSubmission({}, record), submissionKeyOf(record), { atMs: NOW + 900, exitCode: 1, output: "plan digest changed", reason: submissionFailureReason(1) });
    const onStage1 = view(stage1, { submissions });
    assert.equal(onStage1.model.actionRequired?.submissionFailure?.preserved, SUBMISSION_PRESERVED);
    assert.ok(onStage1.html.includes("Submission failed"), "the person who lost a submission is told so, where they were working");

    // 3. The run advances. Nothing about the stored record changed — it is
    // the same workspace state, read by the same code — and Stage 2 is clean.
    const stage2 = await openStage2();
    assert.equal(stage2.id, stage1.id, "the run id is the same one: this is the identity that used to be the whole key");
    const onStage2 = view(stage2, { submissions });
    assert.equal(onStage2.model.actionRequired?.submissionFailure, undefined, "Stage 1's failure says nothing about Stage 2");
    assert.equal(onStage2.model.actionRequired?.submissionUnresolved, undefined);
    assert.ok(!onStage2.html.includes("Submission failed"), "and the Stage 2 panel does not carry Stage 1's banner");

    // 8. Nor is Stage 2 made to look busy by a submission that is not its own.
    assert.equal(onStage2.model.actionRequired?.submitting, undefined, "Stage 2 is not 'Submitting…' because Stage 1 once was");
    assert.equal(onStage2.model.actionRequired?.submit.enabled, false, "its own check has no result yet, which is the only reason it cannot submit");
    assert.match(onStage2.model.actionRequired!.submit.detail, /Record a result for/);

    // 5. Stage 2's own failure is reported normally.
    const own = submissionOf(stage2, "exec-2");
    const both = withSubmissionFailure(withSubmission(submissions, own), submissionKeyOf(own), { atMs: NOW + 1800, exitCode: 2, output: "the engine said this", reason: submissionFailureReason(2) });
    const failedOnStage2 = view(stage2, { submissions: both });
    assert.equal(failedOnStage2.model.actionRequired?.submissionFailure?.preserved, SUBMISSION_PRESERVED);
    assert.match(failedOnStage2.html, /the engine said this/, "with the engine's own words, as before");

    // 7. And Stage 1's record is still there, unharmed: nothing was deleted
    // to make the current panel clean.
    assert.equal(submissionFor(both, stageScopeKey({ runId: stage1.id, stageId: STAGE_1 }))?.failure?.exitCode, 1, "the historical record survives");
  });

  it("4. a Stage 1 submission that only fails after the run has advanced still lands on Stage 1", async () => {
    const { stage1, openStage2, view } = await planRun();
    const record = submissionOf(stage1, "exec-late");
    let submissions = withSubmission({}, record);

    // The run advances while the Stage 1 execution is still alive. Stage 2
    // must not inherit the in-flight state either.
    const stage2 = await openStage2();
    assert.equal(view(stage2, { submissions }).model.actionRequired?.submitting, undefined, "an in-flight Stage 1 submission does not make Stage 2 look like it is submitting");

    // The execution ends, late and badly. The host resolves it under the key
    // it was *stored* at — which is how core/controller.resolveSubmissions
    // iterates — so the failure attaches to Stage 1 and nothing else moves.
    const key = submissionKeyOf(record);
    submissions = withSubmissionFailure(submissions, key, { atMs: NOW + 600_000, exitCode: 1, output: "late", reason: submissionFailureReason(1) });
    assert.deepEqual(parseStageScopeKey(key), { runId: stage1.id, stageId: STAGE_1 }, "the key names the stage the evidence was entered for, not the current one");

    const after = view(stage2, { submissions });
    assert.equal(after.model.actionRequired?.submissionFailure, undefined, "the late result cannot reach the newer stage");
    assert.ok(!after.html.includes("Submission failed"));
    assert.equal(view(stage1, { submissions }).model.actionRequired?.submissionFailure?.preserved, SUBMISSION_PRESERVED, "it is reported against the stage it was about");
  });

  it("6. state cannot cross runs or repositories, because the run id is half of every key", async () => {
    const a = await planRun();
    const b = await planRun();
    assert.notEqual(a.stage1.id, b.stage1.id, "two repositories, two run ids");

    const record = submissionOf(a.stage1, "exec-a");
    const submissions = withSubmissionFailure(withSubmission({}, record), submissionKeyOf(record), { atMs: NOW, exitCode: 1, reason: submissionFailureReason(1) });
    assert.equal(b.view(b.stage1, { submissions }).model.actionRequired?.submissionFailure, undefined, "repository B's Stage 1 knows nothing of repository A's");

    // Same stage id, different run: the shape a monorepo of similar plans
    // produces. Position and naming are never what attributes a record.
    assert.equal(submissionFor(submissions, stageScopeKey({ runId: b.stage1.id, stageId: STAGE_1 })), undefined);
    assert.ok(!sameStageScope(stageScopeOf(a.stage1), stageScopeOf(b.stage1)));
  });

  it("9. drafts, notes and freeform feedback are the current stage's own, and the previous stage's survive", async () => {
    const { stage1, openStage2, view } = await planRun();
    const scope1 = stageScopeKey(stageScopeOf(stage1));

    let checks: HumanCheckDrafts = withHumanCheck({}, scope1, CHECK_1, { outcome: "pass" });
    checks = withHumanCheck(checks, scope1, CHECK_1, { note: "Ran it against the fixture; contract holds." });
    const feedback: HumanFeedbackDrafts = withHumanFeedback({}, scope1, "The wording of the error is still wrong.");

    const onStage1 = view(stage1, { checks, feedback });
    assert.deepEqual(
      onStage1.model.actionRequired?.required.map((item) => [item.key, item.record?.outcome, item.record?.note]),
      [[CHECK_1, "pass", "Ran it against the fixture; contract holds."]],
    );
    assert.equal(onStage1.model.actionRequired?.feedback.draft, "The wording of the error is still wrong.");

    // Same stage, rendered again: nothing a person typed is lost by a plain
    // rerender, which is the behaviour this change must not break.
    assert.equal(view(stage1, { checks, feedback }).html, onStage1.html, "an ordinary refresh of the same stage is byte-identical");

    const stage2 = await openStage2();
    const onStage2 = view(stage2, { checks, feedback });
    assert.deepEqual(
      onStage2.model.actionRequired?.required.map((item) => [item.key, item.record?.outcome, item.record?.note]),
      [[CHECK_2, undefined, undefined]],
      "Stage 2 starts with its own, empty draft state",
    );
    assert.equal(onStage2.model.actionRequired?.feedback.draft, undefined, "and none of Stage 1's freeform findings");
    assert.equal(onStage2.model.actionRequired?.progress, "0 / 1 verified · 1 remaining");

    // Nothing was destroyed to achieve that: Stage 1's work is still stored.
    assert.equal(humanChecksFor(checks, scope1)[CHECK_1]?.note, "Ran it against the fixture; contract holds.");
    assert.equal(humanFeedbackFor(feedback, scope1), "The wording of the error is still wrong.");

    // A check whose key happens to be the same in both stages is still two
    // different answers, because the key is not what attributes a draft.
    const shared = withHumanCheck({}, scope1, CHECK_2, { outcome: "fail" });
    assert.equal(view(stage2, { checks: shared }).model.actionRequired?.required[0].record?.outcome, undefined, "a matching check key does not carry a previous stage's answer forward");
  });
});

describe("a confirmation acts on the execution it was rendered from", () => {
  it("finds the submission by its execution id, so a stale panel cannot settle another stage's evidence", async () => {
    const { stage1, openStage2 } = await planRun();
    const first = submissionOf(stage1, "exec-1");
    const stage2 = await openStage2();
    const second = submissionOf(stage2, "exec-2");
    const submissions = withSubmission(withSubmission({}, first), second);

    assert.equal(submissionByExecution(submissions, "exec-1", stage1.id)?.record.stageId, STAGE_1);
    assert.equal(submissionByExecution(submissions, "exec-1", stage1.id)?.key, submissionKeyOf(first));
    assert.equal(submissionByExecution(submissions, "exec-2", stage2.id)?.record.stageId, STAGE_2);
    assert.equal(submissionByExecution(submissions, "exec-gone", stage1.id), undefined, "an execution nobody recorded settles nothing");
    assert.equal(submissionByExecution(submissions, "exec-1", "another|plan:run"), undefined, "and a confirmation about another run's runner reaches nothing here");

    // Dismissing a report is likewise about one scope only.
    assert.equal(submissionFor(withoutSubmission(submissions, submissionKeyOf(second)), submissionKeyOf(first))?.executionId, "exec-1");
  });
});

describe("state written before stages were told apart is moved, not dropped", () => {
  it("a submission goes to the stage it names; a draft goes to the stage its run is on; an unknown run is left alone", async () => {
    const { stage1, openStage2 } = await planRun();
    const stage2 = await openStage2();
    const currentStageFor = (runId: string): string | undefined => (runId === stage2.id ? STAGE_2 : undefined);

    // A draft carries no stage of its own, so it moves to where the person
    // who typed it was: the stage the run is current at.
    const drafts: HumanCheckDrafts = { [stage2.id]: { [CHECK_2]: { outcome: "pass" } }, "other|plan:elsewhere": { k: { outcome: "fail" } } };
    const movedDrafts = migrateToStageScope<Record<string, CheckRecord>>(drafts, currentStageFor);
    assert.deepEqual(movedDrafts?.moved, [{ runId: stage2.id, stageId: STAGE_2 }]);
    assert.deepEqual(movedDrafts?.next[stageScopeKey({ runId: stage2.id, stageId: STAGE_2 })], { [CHECK_2]: { outcome: "pass" } });
    assert.equal(movedDrafts?.next[stage2.id], undefined, "the run-keyed entry is gone");
    assert.ok("other|plan:elsewhere" in movedDrafts!.next, "a run this window cannot see is somebody's work, and is left exactly where it is");

    // A submission record says which stage it was for, and that answer wins
    // over the run's current stage — which is the whole point: the Stage 1
    // failure must not be adopted by Stage 2 on the way past.
    const legacy = { ...submissionOf(stage1, "exec-1"), stageId: STAGE_1 };
    const movedSubmissions = migrateToStageScope<SubmissionRecord>({ [stage1.id]: legacy }, currentStageFor, (record) => record.stageId);
    assert.deepEqual(movedSubmissions?.moved, [{ runId: stage1.id, stageId: STAGE_1 }]);
    assert.equal(submissionFor(movedSubmissions?.next, stageScopeKey({ runId: stage1.id, stageId: STAGE_1 }))?.executionId, "exec-1");
    assert.equal(submissionFor(movedSubmissions?.next, stageScopeKey({ runId: stage1.id, stageId: STAGE_2 })), undefined);

    // Already-scoped state is not touched, and a second pass does nothing.
    assert.equal(migrateToStageScope(movedSubmissions!.next, currentStageFor, (record) => record.stageId), undefined);
  });
});
