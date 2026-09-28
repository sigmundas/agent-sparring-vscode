/**
 * A slice that needs a feature branch is said so, with the engine's branch
 * action, instead of "Approved — ready to start" or an Approve the engine
 * would refuse. Whether a branch is needed is the engine's answer
 * (`slice-branch --json`); nothing here knows which branches are protected.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { selectRun, type DiscoveredIntake } from "../core/discovery";
import { intakeState } from "../core/intake";
import { isActionMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { branchNotice, parseSliceBranch, sliceBranchTargetOf, type SliceBranchReport } from "../core/sliceBranch";
import { crossRepositoryIntake } from "./fixtures";

const PROBLEM_APPROVED =
  "Stage 1B was approved on protected branch 'main', where no stage agent runs unattended, so run-plan refuses it before any provider turn. Moving the approval to a feature branch at the approved commit fixes it (sparring slice-branch --create <branch>)";
const PROBLEM_UNAPPROVED =
  "Stage 1B needs a feature branch: it runs an implementation agent, and no stage agent runs unattended on protected branch 'main'. Check out a feature branch at this commit in /repo/web (sparring slice-branch --create <branch> does it) and approve again";

function engineOutput(status: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, status: { run_id: "web", stages: "Stage 1B", repository: "web", repo_root: "/repo/web", runs_agent: true, current_branch: "main", approved_branch: null, moved_from: null, needs_branch: true, action: "create-branch", suggested_branch: "feature/widgets-stage-1b", problem: PROBLEM_UNAPPROVED, blocked: null, ...status }, created: null, moved: null, error: null });
}

const unapproved = parseSliceBranch(engineOutput({}))!;
const approvedOnMain = parseSliceBranch(engineOutput({ approved_branch: "main", problem: PROBLEM_APPROVED }))!;

const artifacts = (sliceBranch?: SliceBranchReport): OverviewArtifacts => ({ handoff: false, sparring: false, brief: false, plan: false, ...(sliceBranch ? { sliceBranch } : {}) });

/** The fixture's intake with slice web sealed on main and not yet run. */
function withWebApproved(intake: DiscoveredIntake): DiscoveredIntake {
  const slices = intake.slices.map((slice) =>
    slice.runId === "web"
      ? { ...slice, state: "approved" as const, manifestPath: path.join(intake.dir, "runs", "web", "manifest.json"), approval: { runId: "web", runKey: slice.runKey, stageIds: [], sourcePath: "/repo/app/docs/plan.md", expectedBranch: "main", repoRoot: slice.primaryPath ?? "/repo/web" } }
      : slice,
  );
  return { ...intake, slices, state: intakeState(slices) };
}

describe("the engine's slice-branch answer", () => {
  it("is parsed as reported, and anything else is no answer", () => {
    assert.equal(approvedOnMain.approvedBranch, "main");
    assert.equal(approvedOnMain.action, "create-branch");
    assert.equal(approvedOnMain.suggestedBranch, "feature/widgets-stage-1b");
    assert.equal(parseSliceBranch("not json"), undefined);
    assert.equal(parseSliceBranch(JSON.stringify({ ok: false, status: null, error: "no such run slice" })), undefined, "a refusal is not a report");
    assert.equal(parseSliceBranch(JSON.stringify({ status: { run_id: "web" } })), undefined, "a malformed one is not guessed at");
  });

  it("becomes a plain notice with one action and the engine's text for details", () => {
    const notice = branchNotice(approvedOnMain);
    assert.equal(notice?.headline, "Stage 1B needs a feature branch");
    assert.match(notice?.lines[0] ?? "", /^Stage 1B was approved on main, where implementation agents never run, so it cannot start there\.$/);
    assert.deepEqual(notice?.action && [notice.action.kind, notice.action.label, notice.action.branch], ["create-branch", "Create branch feature/widgets-stage-1b", "feature/widgets-stage-1b"]);
    assert.equal(notice?.technical, PROBLEM_APPROVED);
    assert.doesNotMatch(notice?.lines.join(" ") ?? "", /slice-branch|provider turn|protected branch '/, "engine machinery stays in the details");
  });

  it("offers Move for a branch checked out by hand, and no button when the engine cannot move it", () => {
    const move = branchNotice(parseSliceBranch(engineOutput({ approved_branch: "main", current_branch: "feature/mine", action: "move-approval", suggested_branch: null, problem: PROBLEM_APPROVED })));
    assert.deepEqual(move?.action && [move.action.kind, move.action.label], ["move-approval", "Move Stage 1B to feature/mine"]);
    const blocked = branchNotice(parseSliceBranch(engineOutput({ approved_branch: "main", action: null, suggested_branch: null, problem: PROBLEM_APPROVED, blocked: "stage x has already run (an implementation session recorded)" })));
    assert.equal(blocked?.action, undefined);
    assert.match(blocked?.technical ?? "", /The engine cannot move it: stage x has already run/);
  });

  it("is no notice when the engine says nothing is needed", () => {
    assert.equal(branchNotice(parseSliceBranch(engineOutput({ needs_branch: false, action: null, problem: null, current_branch: "feature/x" }))), undefined);
    assert.equal(branchNotice(undefined), undefined, "an older engine: no notice, never a guess");
  });
});

describe("the intake screen", () => {
  it("an approved slice that needs a branch is not 'Approved — ready to start', and offers the branch action instead of Start", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const intake = withWebApproved(discovery.intakes![0] as DiscoveredIntake);
    const selection = { ambiguous: [], intake };
    const model = buildOverviewModel(selection, undefined, artifacts(approvedOnMain));
    const web = model.intake?.slices.find((slice) => slice.runId === "web");
    assert.equal(web?.stateLabel, "Approved — needs a feature branch");
    assert.equal(model.intake?.stateLabel, "Approved — needs a feature branch");
    assert.equal(model.intake?.action, undefined, "no Start the engine would refuse");
    const html = renderOverviewHtml(model, "n", "c");
    assert.doesNotMatch(html, /ready to start/i);
    assert.doesNotMatch(html, /Start Stage 1B/);
    assert.match(html, /<section class="setupnotice branchnotice" role="alert">[\s\S]*<strong>Stage 1B needs a feature branch<\/strong>/);
    assert.match(html, /data-action="sliceBranch"[^>]*>Create branch feature\/widgets-stage-1b<\/button>/);
    const details = /<details class="setup-technical"><summary>Technical details<\/summary><pre class="engineerror">([\s\S]*?)<\/pre>/.exec(html.slice(html.indexOf("branchnotice")));
    assert.ok(details && /run-plan refuses it before any provider turn/.test(details[1]), "the engine's words are one click away");
    assert.ok(isActionMessage({ type: "action", action: "sliceBranch" }), "the host accepts the click");

    // Without the engine's answer (an older engine) the screen is as it was.
    const plain = buildOverviewModel(selection, undefined, artifacts());
    assert.equal(plain.intake?.action?.label, "Start Stage 1B");
  });

  it("a slice waiting for approval on a protected branch offers the branch, not Approve", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const selection = selectRun(discovery.runs, undefined, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    const model = buildOverviewModel(selection, undefined, artifacts(unapproved));
    assert.equal(model.intake?.action, undefined);
    assert.equal(model.intake?.slices.find((slice) => slice.runId === "web")?.stateLabel, "Needs a feature branch");
    assert.equal(model.branch?.action?.label, "Create branch feature/widgets-stage-1b");
    assert.match(model.branch?.lines[0] ?? "", /needs a feature branch at the current commit before it can be approved/);

    // A report about another slice is not applied to this one.
    const other = buildOverviewModel(selection, undefined, artifacts({ ...unapproved, runId: "app" }));
    assert.equal(other.intake?.action?.label, "Approve Stage 1B");
  });

  it("asks the engine about the next slice, in the repository it runs in", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const selection = selectRun(discovery.runs, undefined, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.deepEqual(sliceBranchTargetOf(selection, [world.app, world.web]), { intakeDir: world.intakeDir, runId: "web", repoRoot: world.web.repoRoot, sparringDir: world.web.sparringDir });
    const stage = discovery.runs.find((run) => run.id === world.stageId)!;
    assert.equal(sliceBranchTargetOf({ ambiguous: [], selected: stage }, [world.app, world.web]), undefined, "a standalone stage has no slice");
  });
});

describe("a sealed run of the slice", () => {
  it("shows the branch notice above the run, so a refused start reads as a branch to create, not a failure", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const run = discovery.runs.find((candidate) => candidate.id === world.appRunId)!;
    assert.ok(run.kind === "plan" && run.intake, "the fixture's app run executes a sealed slice");
    assert.deepEqual(sliceBranchTargetOf({ ambiguous: [], selected: run }, [world.app, world.web]), { intakeDir: run.intake.intakeDir, runId: "app", repoRoot: world.app.repoRoot, sparringDir: world.app.sparringDir });
    const html = renderOverviewHtml(buildOverviewModel({ ambiguous: [], selected: run }, undefined, artifacts({ ...approvedOnMain, runId: "app" })), "n", "c");
    assert.match(html, /class="setupnotice branchnotice"/);
    assert.match(html, /data-action="sliceBranch"/);
  });
});

describe("the extension does not carry the protected-branch policy", () => {
  it("names no protected branch and never runs git itself for this", async () => {
    const root = path.join(__dirname, "..", "..", "src");
    for (const file of ["core/sliceBranch.ts", "vscode/sliceBranchProbe.ts"]) {
      const source = await fs.readFile(path.join(root, file), "utf8");
      assert.doesNotMatch(source, /["'`](main|master)["'`]/, `${file} names no branch`);
      assert.doesNotMatch(source, /execFile\(\s*["']git["']/, `${file} leaves git to the engine`);
    }
    const probe = await fs.readFile(path.join(root, "vscode", "sliceBranchProbe.ts"), "utf8");
    assert.match(probe, /"slice-branch", target\.intakeDir, "--run", target\.runId/);
  });
});
