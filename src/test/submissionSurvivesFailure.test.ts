/**
 * The reported Stage 4 loss, end to end, plus the plan-identity bug that
 * caused it.
 *
 * What happened on the real run: five human checks were performed and
 * recorded as Pass, freeform findings were typed, Submit was pressed, the
 * extension launched
 *
 *   sparring resume-plan --manifest … --evidence '…'
 *
 * and the engine exited 1 with
 *
 *   could not resume plan: the executable content of docs/plans/active/…md has
 *   changed since this run started; refusing to continue against a different
 *   plan.
 *
 * Two independent defects met there.
 *
 * **1. A launch was treated as a submission.** The drafts were cleared as
 * soon as the launcher reported that it had started a command — the one thing
 * about a submission that can never fail — so the refusal left an empty form
 * and the recorded work was gone. Only the exit code of the execution that
 * was launched may clear anything, and nothing but 0 counts.
 *
 * **2. The plan's prose was part of the run's identity.** `source_digest` is
 * a hash of the whole plan document and the engine folds it into the manifest
 * digest that identifies a recorded run. Appending two `## Stage 3D handoff —
 * …` records — sections the manifest builder deliberately excludes from
 * execution, and which the engine's own `plan_digest` docstring says do not
 * count — changed that identity, so a run whose eight executable stages were
 * byte-identical was refused as "a different plan".
 *
 * Both are exercised here against the shape of the real gate.
 */

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { humanChecksFor, humanFeedbackFor, withHumanCheck, withHumanFeedback, type CheckRecord } from "../core/humanChecks";
import { buildManifest, carriedForward, renderManifest, sourceDigest, type ExecutionManifest, type KnownStage } from "../core/manifest";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type ManifestStageView, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import {
  SUBMISSION_PRESERVED,
  submissionFailureReason,
  submissionFor,
  submissionKeyOf,
  submissionState,
  withSubmission,
  withSubmissionFailure,
  withoutSubmission,
  type SubmissionRecord,
  type Submissions,
} from "../core/submission";
import { stageScopeKey } from "../core/stageScope";
import { Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-15T11:13:00.000Z");
const STAGE_4 = "stage-4-editor-and-ui-inspection-and-guarded-editing";
const PLAN_LABEL = "docs/plans/active/2026-09-10-reported-statistics-and-range-semantics.md";
const PLAN_KEY = "2026-09-10-reported-statistics-a-815f5eda";

/** The five check ids of the real Stage 4 gate. */
const CHECKS = [
  { id: "compact-editor-edit-swap-save-restart", instruction: "With both rollout switches left closed, paste a synthetic tagged table into the compact reference editor; edit values, swap length and width, save it, reopen the application and inspect the saved attachment.", pass_criteria: "Pass if the reopened attachment holds the edited values." },
  { id: "reported-statistics-retraction", instruction: "Parse tagged synthetic content, use each per-metric drop action, then Discard all reported statistics.", pass_criteria: "Pass if each action leaves the remaining fields intact." },
  { id: "library-manager-closed-gate", instruction: "With the reader gate closed, open an existing enhanced measurement set in the library manager, edit an ordinary field and save, then reopen it.", pass_criteria: "Pass if the enhanced content survives the round trip." },
  { id: "library-manager-open-gate-roundtrip", instruction: "Set MINIMUM_SUPPORTED_READER_VERSION_GATE_OPEN to true locally, save a synthetic table through the library manager, restart and reopen the row, then restore the switch.", pass_criteria: "Pass if the row reopens with its percentile bounds." },
  { id: "ui-wording-and-layout", instruction: "Inspect both editors in light and dark themes using content long enough to wrap the reported-statistics lines.", pass_criteria: "Pass if no line is clipped and every control is reachable." },
] as const;

/** What the person had entered: a Pass and a note for each check, plus freeform findings. */
const NOTES: Record<string, string> = {
  "compact-editor-edit-swap-save-restart": "Swapped length/width, saved, reopened: attachment held the edited values.",
  "reported-statistics-retraction": "Drop actions leave the other metrics untouched; Discard all clears only the reported block.",
  "library-manager-closed-gate": "Closed gate: ordinary edit saved and reopened with the enhanced content intact.",
  "library-manager-open-gate-roundtrip": "Gate opened locally, round trip kept P5/P95; switch restored to false before committing.",
  "ui-wording-and-layout": "Both themes, Norwegian included; the tag line wraps and keyboard focus is visible throughout.",
};

const FEEDBACK = [
  "Replace the developer-oriented “drop the range interpretation” correction flow with an explicit semantic selector.",
  "For an inner range, present a segmented control such as Typical range | P5–P95 (optionally Unspecified).",
  "Changing it must preserve all numeric values and only change the range semantics.",
].join("\n");

/** The engine's own refusal, verbatim from the reported run. */
const PLAN_CHANGED_ERROR = [
  "could not resume plan: the executable content of docs/plans/active/2026-09-10-reported-statistics-and-range-semantics.md has changed",
  "since this run started; refusing to continue against a different plan. Restore it as it was, or deliberately start over",
].join(" ");

function sparring(): string {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "Verify Stage 4 editor interactions and persistence before committing", checks: CHECKS.map((check) => ({ ...check, source: null })) };
  return ["# Sparring: stage 4", "", "## Routing outcome", "", "- Action: `NEEDS_YOU`", "- Summary: Five interactive checks are the remaining acceptance blockers.", "- Needs-you reason: DEVICE/MANUAL CHECK -- the editors cannot be exercised by the agents.", "", "## NEEDS YOU", "", HUMAN_GATE_MARKER, "", "```json", JSON.stringify(gate, null, 2), "```", ""].join("\n");
}

const PLAN = ["# Reported statistics and explicit range semantics", "", "## Stage 4 — Editor and UI inspection and guarded editing", "", "Owns the review table, the compact editor and the reference workflow.", ""].join("\n");

const MANIFEST: ManifestStageView[] = [
  { stageId: "stage-3d-transport", label: "Stage 3D", title: "Transport", status: "accepted" },
  { stageId: STAGE_4, label: "Stage 4", title: "Editor and UI inspection and guarded editing", status: "working" },
];

/** The five drafted results with their notes, and the freeform draft, in the shape workspace state holds them. */
function enteredByHand(scope: string): { checks: Record<string, CheckRecord>; feedback: string } {
  let drafts = {};
  for (const check of CHECKS) {
    // Recorded the way a person records them: the result, then the note.
    drafts = withHumanCheck(drafts, scope, check.id, { outcome: "pass" });
    drafts = withHumanCheck(drafts, scope, check.id, { note: NOTES[check.id] });
  }
  return { checks: humanChecksFor(drafts, scope), feedback: humanFeedbackFor(withHumanFeedback({}, scope, FEEDBACK), scope) as string };
}

async function stage4() {
  const ws = await Workspace.create();
  const planPath = path.join(ws.root, ...PLAN_LABEL.split("/"));
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  await ws.writePlanRun(PLAN_KEY, { plan: PLAN_LABEL, status: "paused", current_stage_index: 6, current_stage: STAGE_4, expected_branch: "feature/reported-statistics-contract", source: "manifest" });
  await ws.writeStage("stage-3d-transport", { status: "accepted" });
  await ws.writeStage(STAGE_4, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparring() });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const runId = selection.selected!.id;
  const scope = stageScopeKey({ runId, stageId: STAGE_4 });

  /** Exactly what the panel does on every update, from persisted state only. */
  const view = (state: { checks?: Record<string, CheckRecord>; feedback?: string; submissions?: Submissions; notes?: string }): { model: OverviewModel; html: string } => {
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: true,
      brief: false,
      plan: true,
      planText: PLAN,
      git: { branch: "feature/reported-statistics-contract" },
      humanChecks: state.checks ?? {},
      humanFeedback: state.feedback,
      submission: submissionFor(state.submissions, scope),
      notesText: state.notes,
      manifestStages: MANIFEST,
    };
    const model = buildOverviewModel(selection, undefined, artifacts, NOW);
    return { model, html: renderOverviewHtml(model, "n", "c") };
  };
  return { runId, scope, view };
}

describe("a submission the engine refused keeps everything that was entered", () => {
  it("five Pass results with notes and freeform feedback survive exit 1, byte for byte, and rerender after a reload", async () => {
    const { runId, scope, view } = await stage4();
    const entered = enteredByHand(scope);

    // Before submitting: five results, five notes, the feedback, Submit ready.
    const before = view({ checks: entered.checks, feedback: entered.feedback });
    assert.equal(before.model.actionRequired?.progress, "5 / 5 verified");
    assert.equal(before.model.actionRequired?.submit.enabled, true);

    // Submit: the engine is launched and a submission is recorded. Nothing is
    // cleared here — this is the step that used to discard the drafts.
    const record: SubmissionRecord = { runId, channel: "checks", executionId: "1789463594979-1", startedAtMs: NOW, entry: "2026-09-15 — manual verification recorded in VS Code…", results: 5, stageId: STAGE_4 };
    let submissions = withSubmission({}, record);
    const during = view({ checks: entered.checks, feedback: entered.feedback, submissions });
    assert.equal(during.model.actionRequired?.submitting?.label, "Submitting…");
    assert.equal(during.model.actionRequired?.submit.enabled, false, "the same evidence is not offered to the reviewer twice");
    assert.equal(during.model.actionRequired?.feedback.send.enabled, false);
    assert.match(during.html, /<p class="submitting"[^>]*>.*?Submitting…<\/p>/);
    assert.equal(submissionState({ state: "running" }), "pending");

    // The engine exits 1 with the plan-digest refusal.
    assert.equal(submissionState({ state: "ended", exitCode: 1 }), "failed");
    submissions = withSubmissionFailure(submissions, scope, { atMs: NOW + 1815, exitCode: 1, output: PLAN_CHANGED_ERROR, reason: submissionFailureReason(1) });

    const after = view({ checks: entered.checks, feedback: entered.feedback, submissions });
    const panel = after.model.actionRequired!;

    // Every recorded result and note is still exactly what was entered.
    assert.deepEqual(
      panel.required.map((item) => [item.key, item.record?.outcome, item.record?.note]),
      CHECKS.map((check) => [check.id, "pass", NOTES[check.id]]),
      "five Pass results with their notes, unchanged",
    );
    assert.equal(panel.progress, "5 / 5 verified");
    assert.equal(panel.feedback.draft, FEEDBACK, "and the freeform findings, byte for byte");
    assert.equal(panel.submitting, undefined);
    assert.equal(panel.submit.enabled, true, "and it can be submitted again once the refusal is dealt with");

    // The panel says what happened, reassurance first, with the engine's own words.
    assert.equal(panel.submissionFailure?.preserved, SUBMISSION_PRESERVED);
    assert.equal(SUBMISSION_PRESERVED, "Submission failed — your check results and feedback were preserved.");
    assert.equal(panel.submissionFailure?.reason, "The engine exited with code 1 without recording the evidence.");
    assert.equal(panel.submissionFailure?.what, "5 check results and any notes are still drafted below.");
    assert.equal(panel.submissionFailure?.error, PLAN_CHANGED_ERROR);
    assert.match(after.html, /<p class="preserved">.*?Submission failed — your check results and feedback were preserved\.<\/p>/);
    assert.match(after.html, /<pre class="engineerror">could not resume plan: the executable content of/);
    for (const check of CHECKS) {
      assert.match(after.html, new RegExp(`class="choice pass on" data-check="${check.id}" data-outcome="pass" aria-pressed="true"`), `${check.id} still shows Pass`);
      assert.ok(after.html.includes(NOTES[check.id]), `${check.id} still shows its note`);
    }
    assert.ok(after.html.includes("Replace the developer-oriented"), "and the freeform field is not empty");

    // A window reload changes nothing: the same persisted state is all the
    // panel ever reads, so the form comes back populated.
    const reloaded = view({ checks: entered.checks, feedback: entered.feedback, submissions });
    assert.equal(reloaded.html, after.html, "the rebuilt document is identical");
  });

  it("a long plan run that recorded the evidence and failed later is not reported as a lost submission", async () => {
    // resume-plan --evidence records the evidence first, then continues the
    // plan; a stage failing an hour later says nothing about this submission.
    const { runId, scope, view } = await stage4();
    const entered = enteredByHand(scope);
    const entry = "2026-09-15 — manual verification recorded in VS Code:\n\n- Pass — Inspect both editors · check `ui-wording-and-layout`";
    const record: SubmissionRecord = { runId, channel: "checks", executionId: "e9", startedAtMs: NOW, entry, results: 5, stageId: STAGE_4 };
    const submissions = withSubmissionFailure(withSubmission({}, record), scope, { atMs: NOW + 3_600_000, exitCode: 1, output: "could not run stage 5: provider exited 1", reason: submissionFailureReason(1) });

    const landed = view({ checks: entered.checks, feedback: entered.feedback, submissions, notes: `# Notes\n\n## Human evidence\n\n${entry}\n` });
    assert.equal(landed.model.actionRequired?.submissionFailure, undefined, "the evidence is in notes.md, so nothing claims it was lost");
    assert.ok(!landed.html.includes("Submission failed"), "and the panel does not say so");

    const lost = view({ checks: entered.checks, feedback: entered.feedback, submissions });
    assert.equal(lost.model.actionRequired?.submissionFailure?.preserved, SUBMISSION_PRESERVED, "without it in notes.md, the submission really was lost");
  });

  it("every way a submission can fail preserves the drafts; only exit 0 clears them", () => {
    for (const [state, exitCode] of [
      ["ended", 1], // plan digest refusal, branch refusal, provider failure
      ["ended", 2],
      ["ended", 127], // the shell could not run it at all
      ["ended", 130], // Ctrl-C
      ["ended", 143], // terminated
      ["ended", undefined], // no exit code: signal, or the terminal was closed
      ["running", undefined],
      ["unknown", undefined],
    ] as const) {
      assert.notEqual(submissionState({ state, exitCode }), "recorded", `${state}/${exitCode} must never clear a draft`);
    }
    assert.equal(submissionState({ state: "ended", exitCode: 0 }), "recorded", "only a clean exit means the engine recorded it");
    assert.equal(submissionState(undefined), "pending", "an execution that cannot be found decides nothing");

    assert.match(submissionFailureReason(undefined), /^The submission was interrupted before the engine finished/);
    assert.match(submissionFailureReason(130), /^The submission was interrupted \(exit 130\)/);
    assert.match(submissionFailureReason(1), /^The engine exited with code 1 without recording the evidence\.$/);
  });

  it("the host clears a draft in exactly one place, and only for a recorded submission", async () => {
    const controller = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
    const resolve = /async resolveSubmissions\(\)[\s\S]*?\n {2}}\n/.exec(controller)?.[0] ?? "";
    assert.ok(resolve, "resolveSubmissions exists");
    assert.match(resolve, /const state = submissionState\(execution\);/, "the execution's own state decides");
    assert.match(resolve, /if \(state === "pending"\) \{\n\s*continue;/, "nothing happens while it is pending");
    assert.match(resolve, /if \(state === "recorded"\)[\s\S]*?clearHumanChecks\(key\)[\s\S]*?clearHumanFeedback\(key\)/, "and clearing lives inside the recorded branch only");
    // `key` is the stage scope the evidence was entered under, taken from the
    // store's own iteration — never the run's current stage. A Stage 1
    // execution that exits 0 after the run advanced to Stage 2 therefore
    // clears Stage 1's drafts and leaves Stage 2's alone.
    assert.match(resolve, /for \(const key of Object\.keys\(submissions \?\? \{\}\)\)/, "each record is resolved under the scope it was stored at");
    assert.doesNotMatch(resolve, /clearHuman(Checks|Feedback)\(runId\)/, "never against whichever stage happens to be current now");
    assert.match(resolve, /withSubmissionFailure/, "a failure is recorded, not a clearing");
    // The drafts are cleared nowhere else in the host except the run-scoped
    // reset those two functions are, and the tracker's end event is what
    // drives this.
    const clears = [...controller.matchAll(/clearHuman(Checks|Feedback)\(/g)].length;
    assert.equal(clears, 4, "two definitions and the two calls inside the recorded branch");
    assert.match(controller, /change === "ended"[\s\S]{0,160}resolveSubmissions\(\)/, "an execution ending is what resolves a submission");
    assert.match(controller, /reattach\(\)\.then\(\(\) => this\.resolveSubmissions\(\)\)/, "and a reload resolves what was in flight");
  });
});

// ---------------------------------------------------------------- the plan-identity bug

/**
 * The engine's own manifest digest (manifest.py: `manifest_digest` over
 * `digest_planned_stages`, plan_model.py): version, plan label and source
 * digest, then per stage its id, label, title, brief and repositories, each
 * part NUL-separated. Mirrored here because it is the contract the extension's
 * manifest writing has to satisfy — and the contract that a prose edit to the
 * plan document was quietly breaking.
 */
function engineManifestDigest(manifest: ExecutionManifest): string {
  const parts: string[] = [String(manifest.version), manifest.plan_label, manifest.source_digest];
  for (const stage of manifest.stages) {
    parts.push(stage.stage_id, stage.label, stage.title, stage.brief);
    for (const repository of stage.repositories ?? []) {
      parts.push(repository.name, repository.path, repository.branch, repository.candidate_sha ?? "");
    }
  }
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

const TWO_STAGE_PLAN = [
  "# Reported statistics",
  "",
  "## Stage 1 — Contract and compatibility fixtures",
  "",
  "Define the typed contract.",
  "",
  "## Stage 2 — Typed contract and parser specification",
  "",
  "Specify the parser.",
  "",
].join("\n");

/** The plan after a recovery session appended a handoff record and updated a status paragraph: no stage definition touched. */
const WITH_HANDOFF = [
  "# Reported statistics",
  "",
  "## Stage 2 handoff — 2026-09-14 (current stage; **human-gated, uncommitted**)",
  "",
  "Implemented and self-verified; five interactive checks remain with the branch owner.",
  "",
  "## Stage 1 — Contract and compatibility fixtures",
  "",
  "Define the typed contract.",
  "",
  "## Stage 2 — Typed contract and parser specification",
  "",
  "Specify the parser.",
  "",
].join("\n");

const INPUT = { planLabel: PLAN_LABEL, planName: "reported-statistics.md" };

function built(markdown: string, known: KnownStage[] = []): ExecutionManifest {
  const result = buildManifest({ markdown, ...INPUT, known });
  assert.ok(result.ok, "the plan is executable");
  return result.manifest;
}

describe("editing the plan's prose does not end the run", () => {
  it("a handoff record appended to the plan keeps the digest the engine recorded", () => {
    const atRunStart = built(TWO_STAGE_PLAN);
    const rebuilt = built(WITH_HANDOFF);

    // The stages are untouched; only the whole-document hash moved.
    assert.deepEqual(rebuilt.stages, atRunStart.stages, "the same two stages, same ids, labels, titles and briefs");
    assert.notEqual(rebuilt.source_digest, atRunStart.source_digest, "but the plan text is not the same text");
    assert.notEqual(engineManifestDigest(rebuilt), engineManifestDigest(atRunStart), "which is exactly what the engine refused");

    // Carried forward: the manifest that would be written keeps the
    // provenance of the one on disk, so the run's identity is unchanged.
    const written = carriedForward(rebuilt, renderManifest(atRunStart));
    assert.equal(written.source_digest, atRunStart.source_digest);
    assert.equal(engineManifestDigest(written), engineManifestDigest(atRunStart), "the engine accepts it and the run continues");
    assert.deepEqual(written.stages, rebuilt.stages, "nothing about what executes is faked");
  });

  it("a changed stage definition still changes the digest — the protection is intact", () => {
    const original = built(TWO_STAGE_PLAN);
    for (const [what, markdown] of [
      ["a reworded stage section (a different brief)", TWO_STAGE_PLAN.replace("Specify the parser.", "Specify the parser and the range selector.")],
      ["a retitled stage", TWO_STAGE_PLAN.replace("## Stage 2 — Typed contract and parser specification", "## Stage 2 — Typed contract, parser and selector")],
      ["a new stage", `${TWO_STAGE_PLAN}## Stage 3 — Local schema\n\nAdd the schema.\n`],
    ] as const) {
      const changed = built(markdown);
      const written = carriedForward(changed, renderManifest(original));
      assert.notEqual(engineManifestDigest(written), engineManifestDigest(original), `${what} must still be refused`);
      assert.equal(written.source_digest, changed.source_digest, `${what} takes the new provenance`);
    }
  });

  it("a declared sibling repository is part of what executes, so it is not carried over either", () => {
    const original = built(TWO_STAGE_PLAN);
    const withRepo = buildManifest({
      markdown: TWO_STAGE_PLAN,
      ...INPUT,
      repositories: { "2": [{ name: "sporely-app", path: "../sporely-app", branch: "feature/x", candidate_sha: null }] },
    });
    assert.ok(withRepo.ok);
    const written = carriedForward(withRepo.manifest, renderManifest(original));
    assert.notEqual(engineManifestDigest(written), engineManifestDigest(original), "a second repository under review changes the run");
  });

  it("with no manifest on disk, or an unreadable one, the fresh plan hash is used", () => {
    const fresh = built(WITH_HANDOFF);
    for (const existing of [undefined, "", "   ", "not json", '{"version":1}', JSON.stringify({ version: 1, plan_label: "x", stages: [] })]) {
      assert.equal(carriedForward(fresh, existing).source_digest, fresh.source_digest, `nothing is inherited from ${JSON.stringify(existing)}`);
    }
    assert.equal(fresh.source_digest, sourceDigest(WITH_HANDOFF), "and that hash is of the plan text, unchanged in meaning");
  });

  it("the run-start provenance is recoverable from the plan text it was built from", () => {
    // How the real run was reconciled: the manifest on disk had been rebuilt
    // from an edited plan, and the recorded digest was reproduced by putting
    // the run-start plan's hash back into it — which is only sound because
    // every other field was identical.
    const atRunStart = built(TWO_STAGE_PLAN);
    const rebuilt = built(WITH_HANDOFF);
    const reconciled = { ...rebuilt, source_digest: sourceDigest(TWO_STAGE_PLAN) };
    assert.equal(engineManifestDigest(reconciled), engineManifestDigest(atRunStart));
  });
});

describe("a submission that the engine did record", () => {
  it("is the one case that clears, and it leaves no report behind", () => {
    const runId = "run|a";
    const record: SubmissionRecord = { runId, channel: "checks", executionId: "e1", startedAtMs: NOW, entry: "…", results: 5, stageId: "stage-1" };
    const key = submissionKeyOf(record);
    const submissions = withSubmission({}, record);
    assert.equal(submissionFor(submissions, key)?.results, 5);
    assert.equal(submissionState({ state: "ended", exitCode: 0 }), "recorded");
    assert.deepEqual(withoutSubmission(submissions, key), {}, "the record goes with the drafts");
    assert.equal(submissionFor(withoutSubmission(submissions, key), key), undefined);
  });

  it("ignores a stored record that is not one", () => {
    const key = stageScopeKey({ runId: "run|a", stageId: "stage-1" });
    for (const junk of [
      undefined,
      {},
      { [key]: "text" },
      { [key]: { channel: "checks" } },
      { [key]: { entry: "x", channel: "other" } },
      // A record filed under a key that does not describe it: the store was
      // written by something other than withSubmission, and attributing
      // somebody's evidence to the wrong stage is the one thing that must
      // never happen quietly.
      { [key]: { runId: "run|a", channel: "checks", entry: "x", results: 0, executionId: "e", startedAtMs: 0, stageId: "stage-2" } },
      { [key]: { runId: "run|b", channel: "checks", entry: "x", results: 0, executionId: "e", startedAtMs: 0, stageId: "stage-1" } },
      { [key]: { runId: "run|a", channel: "checks", entry: "x", results: 0, executionId: "e", startedAtMs: 0 } },
    ] as unknown as Submissions[]) {
      assert.equal(submissionFor(junk, key), undefined);
    }
  });
});
