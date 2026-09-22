/**
 * The two plan modes.
 *
 * **Continue automatically** (the default) hands the whole plan to the
 * engine as one managed run and lets it sequence: no Accept stage / Start
 * next stage / Run stage click between healthy stages, and one confirmation
 * before the first. **Pause after each stage** keeps those per-stage
 * checkpoints exactly as they were.
 *
 * What both must never do is sequence in the extension. These tests hold
 * that line at the source: the automatic path only ever builds a manifest
 * and launches one engine command.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs, buildRunPlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { commandLineIsOperation, parseSparringCommand } from "../core/sparringCommand";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, sparringMarkdown } from "./fixtures";

const NOW = Date.parse("2026-09-14T10:00:00.000Z");
const PLAN = ["# Plan", "", "## Stage 3B — Barrier", "", "Local barrier.", "", "## Stage 3C — Cloud schema", "", "Cloud side.", ""].join("\n");

async function commandsSource(): Promise<string> {
  return fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
}

function fn(source: string, name: string): string {
  const found = new RegExp(`(?:async )?function ${name}[\\s\\S]*?\\n}\\n`).exec(source)?.[0] ?? "";
  assert.ok(found, `${name} exists`);
  return found;
}

describe("the engine command the automatic mode issues", () => {
  it("run-plan --manifest, with --adopt only when asked", () => {
    assert.deepEqual(buildRunPlanArgs({ manifest: "/tmp/m.json", repoRoot: "/code/app", expectedBranch: "feature/x" }), ["run-plan", "--manifest", "/tmp/m.json", "--repo-root", "/code/app", "--expected-branch", "feature/x"]);
    assert.deepEqual(buildRunPlanArgs({ manifest: "/tmp/m.json", repoRoot: "/code/app", expectedBranch: "feature/x", adopt: true }), ["run-plan", "--manifest", "/tmp/m.json", "--repo-root", "/code/app", "--expected-branch", "feature/x", "--adopt"]);
    assert.deepEqual(buildResumePlanArgs({ source: "manifest", manifest: "/tmp/m.json", repoRoot: "/code/app", expectedBranch: "feature/x", evidence: "done" }), ["resume-plan", "--manifest", "/tmp/m.json", "--repo-root", "/code/app", "--expected-branch", "feature/x", "--evidence", "done"]);
  });

  it("a plan path and a manifest are alternatives, never both", () => {
    assert.deepEqual(buildRunPlanArgs({ planPath: "docs/plan.md", repoRoot: "/r", expectedBranch: "b" }), ["run-plan", "docs/plan.md", "--repo-root", "/r", "--expected-branch", "b"]);
    assert.throws(() => buildRunPlanArgs({ repoRoot: "/r", expectedBranch: "b" }), /planPath or manifest/);
  });

  it("a manifest run typed in a terminal is recognised and matched by its file", () => {
    const parsed = parseSparringCommand("sparring run-plan --manifest /tmp/foo.manifest.json --repo-root /code/app --expected-branch feature/x --adopt");
    assert.equal(parsed?.subcommand, "run-plan");
    assert.equal(parsed?.manifest, "/tmp/foo.manifest.json");
    assert.equal(parsed?.planPath, undefined);
    // Matched by its full path. A manifest with the same basename in another
    // directory is a different manifest, and used to match on the basename
    // alone — which let one plan's runner resolve another plan's guard.
    assert.ok(commandLineIsOperation("sparring resume-plan --manifest /tmp/foo.manifest.json --repo-root /r --expected-branch b", { kind: "resume-plan", repoRoot: "/r", manifest: "/tmp/foo.manifest.json" }));
    assert.ok(!commandLineIsOperation("sparring resume-plan --manifest /other/dir/foo.manifest.json --repo-root /r --expected-branch b", { kind: "resume-plan", repoRoot: "/r", manifest: "/tmp/foo.manifest.json" }));
    assert.ok(!commandLineIsOperation("sparring resume-plan --manifest /tmp/other.manifest.json --repo-root /r --expected-branch b", { kind: "resume-plan", repoRoot: "/r", manifest: "/tmp/foo.manifest.json" }));
  });
});

describe("the automatic path is one engine call, not a loop", () => {
  it("starting builds a manifest and launches exactly one run-plan", async () => {
    const source = fn(await commandsSource(), "startManagedRun");
    assert.match(source, /buildManifest\(\{/, "the plan is interpreted once, here");
    assert.match(source, /buildRunPlanArgs\(\{ manifest: manifestPath,/, "a fresh managed run is always started from the manifest");
    assert.equal((source.match(/controller\.launch\(/g) ?? []).length, 1, "exactly one launch");
    assert.ok(!/buildRunLoopArgs|buildFreezeCandidateArgs|buildAcceptCandidateArgs|buildNewStageArgs|acceptStage\(/.test(source), "no per-stage command: the engine sequences, freezes and accepts");
    assert.ok(!/for \(|while \(|forEach\(.*launch/.test(source.replace(/for \(const problem of built\.skipped\)[\s\S]*?\n {2}}/, "")), "nothing here iterates over stages to run them");
  });

  it("continuing an existing run launches exactly one resume-plan, and never builds its own input", async () => {
    // The input kind is the run's own recorded one, decided in
    // planInvocationFor and nowhere else. This function may not reach for a
    // manifest (or a plan path) of its own, because doing so is precisely how
    // a Markdown-started run came to be resumed with --manifest.
    const source = fn(await commandsSource(), "continueManagedRun");
    assert.match(source, /await planInvocationFor\(controller, run\)/, "one place decides the input");
    assert.match(source, /buildResumePlanArgs\(\{ \.\.\.input,/, "and it is carried through verbatim");
    assert.ok(!/buildManifest\(\{/.test(source), "no second interpretation of the plan");
    assert.ok(!/buildRunPlanArgs/.test(source), "an existing run is never started again");
    assert.equal((source.match(/launch\(controller, location, args/g) ?? []).length, 1, "exactly one launch");
  });

  it("confirms once, before the first stage, and never in a loop", async () => {
    const source = await commandsSource();
    for (const where of ["startManagedRun", "continueManagedRun"]) {
      const body = fn(source, where);
      assert.match(body, /Run this plan automatically until Agent Sparring needs you\?/, `${where} asks once`);
      assert.equal((body.match(/showInformationMessage\(\s*"Run this plan/g) ?? []).length, 1, `${where} asks exactly once`);
      assert.match(body, /if \(\w*\.?confirm\)/, "the one confirmation is skippable only by the test hook");
    }
    const describePlan = /function describePlan\([\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.match(describePlan, /with no further confirmation/, "the dialog says plainly that nothing else will be asked");
    assert.match(describePlan, /stops when the reviewer needs you, escalates, something fails, or the plan is complete/);
  });

  it("keeps the manifest out of every repository", async () => {
    const controller = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
    const dir = /get manifestDirectoryPath\(\)[\s\S]*?\n {2}}\n/.exec(controller)?.[0] ?? "";
    assert.ok(dir, "manifestDirectoryPath exists");
    assert.match(dir, /globalStorageUri\.fsPath/, "the extension's own storage, not the workspace");
    assert.ok(!/repoRoot|sparringDir|workspaceFolder/.test(dir), "its location is never derived from a repository");
  });

  it("both manifest build sites see the same stage history and the same declarations", async () => {
    // Starting and resuming must produce byte-identical manifests from an
    // unchanged plan: the engine refuses a run whose digest moved. So
    // neither call may know something the other does not.
    const source = await commandsSource();
    for (const where of ["startManagedRun", "planInvocationFor"]) {
      const body = fn(source, where);
      assert.match(body, /known: await knownStageIds\(/, `${where} carries the project's existing stage ids and briefs`);
      assert.match(body, /\.\.\.declarationsFor\(controller, /, `${where} carries the declared sibling repositories and stage modes, from the one place that reads them`);
    }
    // And that one place is keyed by the worktree, not by the plan alone: a
    // plan key is shared by every checkout of the same plan path, so reading
    // declarations without the project directory answers for the wrong one.
    const helper = fn(source, "declarationsFor");
    assert.match(helper, /controller\.stageRepositories\(key, location\.projectDir\)/);
    assert.match(helper, /controller\.stageModes\(key, location\.projectDir\)/);
  });

  it("an already-executed stage is briefed from its own brief.md, not from the plan as it now reads", async () => {
    const source = await commandsSource();
    const known = fn(source, "knownStageIds");
    assert.match(known, /hasExecutionHistory\(candidate\.stage\)/, "only a stage that really ran keeps its brief");
    assert.match(known, /executed && briefText !== undefined \? \{ brief: briefText \}/);
    const history = fn(source, "hasExecutionHistory");
    assert.match(history, /status === "accepted"/);
    assert.match(history, /implementationSessionId !== null/);
    assert.match(history, /sparringSessionId !== null/);
    assert.match(history, /candidateSha !== null/);
  });

  it("the current stage of a managed run is not lost from the manifest just because the plan run claims it", async () => {
    // Discovery stops listing a plan run's stages standalone, so building
    // the known set from standalone runs alone would rebuild the manifest
    // around a different id and brief on the next resume — and the engine
    // would then refuse the digest.
    const stages = fn(await commandsSource(), "stagesOfProject");
    assert.match(stages, /candidate\.kind === "stage" \? \[candidate\.stage\] : \[\.\.\.candidate\.stages, candidate\.currentStage\]/);
    assert.match(stages, /if \(!stage\.exists \|\| seen\.has\(stage\.stageId\)\)/, "each stage counted once, and only if it is on disk");
  });

  it("nothing in the declaration flow asks a human for a commit", async () => {
    // Which commit was reviewed is the freeze boundary's answer. A typed
    // SHA would be exactly the stale pin the verification exists to catch.
    const add = fn(await commandsSource(), "addStageRepository");
    assert.equal((add.match(/showInputBox\(/g) ?? []).length, 2, "exactly two things are asked: the expected branch and the display name");
    assert.ok(!/candidate_?[Ss]ha/.test(add), "no commit is collected");
    assert.match(
      add,
      /controller\.declareStageRepository\(key, location\.projectDir, label, \{ name: name\.trim\(\), path: chosen\.rootPath, branch: branch\.trim\(\) \}\)/,
      "and the declaration is scoped to the worktree it was made in, so another checkout of the same plan is unaffected",
    );
  });

  it("one preflight, and only when something is actually wrong", async () => {
    // A healthy plan must get exactly one dialog: the confirmation. The
    // preflight is a single modal listing everything at once, never a chain,
    // and it is the same one whether the run is being started or continued.
    const source = await commandsSource();
    const refused = fn(source, "refusedByPreflight");
    assert.match(refused, /const blockers = await preflight\(/);
    assert.match(refused, /if \(blockers\.length === 0\)/, "silent when there is nothing to say");
    assert.equal((refused.match(/showWarningMessage\(/g) ?? []).length, 1, "one modal listing everything at once");
    for (const where of ["startManagedRun", "continueManagedRun"]) {
      const body = fn(source, where);
      assert.match(body, /await refusedByPreflight\(/, `${where} preflights`);
      assert.ok(body.indexOf("refusedByPreflight") < body.indexOf("Run this plan automatically"), "before the confirmation, not after");
    }
    const body = fn(source, "preflight");
    for (const check of [/adoptionGaps\(/, /is not a Git repository here/, /declares \$\{repository\.branch\}/, /last handoff was written on/, /uncommitted change/, /no `run-plan --manifest`/]) {
      assert.match(body, check, `preflight covers ${check}`);
    }
  });

  it("a check that cannot be answered says nothing rather than a maybe", async () => {
    // The engine's own refusals are the authority; a hedged warning in front
    // of a working run is worse than silence.
    const body = fn(await commandsSource(), "preflight");
    assert.match(body, /changes !== undefined && changes > 0/, "an unread worktree is not claimed clean or dirty");
    assert.match(body, /=== "missing-manifest"/, "only a definite answer blocks; unknown does not");
    const probe = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "engineProbe.ts"), "utf8");
    assert.match(probe, /resolve\("unknown"\); \/\/ it did not run/);
    assert.match(probe, /planned\.plan\.kind === "shell"/, "a CLI only the user's shell can resolve is not probed");
  });

  it("resumes a manifest-started run with --manifest, because the engine refuses the other input", async () => {
    const source = fn(await commandsSource(), "planInvocationFor");
    assert.match(source, /run\.state\.source !== "manifest"/, "the engine's own record of which input the run executes");
    assert.match(source, /return \{ planPath: run\.planPath, source: "markdown", runKey: run\.runKey \}/, "a markdown run keeps its plan path, and names the run it continues");
    assert.match(source, /buildManifest\(\{/, "a manifest run gets its manifest rebuilt, deterministically");
    assert.match(source, /source: "manifest", runKey: run\.runKey \}/, "and says that too, so the builder can check it");
  });

  it("the recorded source travels with the invocation, and a mismatch cannot be built at all", () => {
    // The rule, at the one place every resume passes through. A run started
    // from a Markdown plan is resumed from that plan; one started from a
    // manifest is resumed with --manifest. Handing the builder the other kind
    // is a thrown error, not a warning, because the engine would refuse the
    // run and no button could then continue the plan.
    assert.deepEqual(buildResumePlanArgs({ source: "markdown", planPath: "docs/plan.md", repoRoot: "/r", expectedBranch: "b" }), ["resume-plan", "docs/plan.md", "--repo-root", "/r", "--expected-branch", "b"]);
    assert.deepEqual(buildResumePlanArgs({ source: "manifest", manifest: "/tmp/m.json", repoRoot: "/r", expectedBranch: "b" }), ["resume-plan", "--manifest", "/tmp/m.json", "--repo-root", "/r", "--expected-branch", "b"]);
    assert.throws(() => buildResumePlanArgs({ source: "markdown", manifest: "/tmp/m.json", repoRoot: "/r", expectedBranch: "b" }), /started from a markdown plan input/);
    assert.throws(() => buildResumePlanArgs({ source: "manifest", planPath: "docs/plan.md", repoRoot: "/r", expectedBranch: "b" }), /started from a manifest plan input/);
  });
});

describe("what the Overview offers in each mode", () => {
  async function standalone(continuation: "automatic" | "manual" | undefined, status: "working" | "accepted" = "working") {
    const ws = await Workspace.create();
    await ws.writeStage("stage-3b-barrier", { status, implementation_session_id: status === "accepted" ? "impl" : null, candidate_sha: status === "accepted" ? "c".repeat(40) : null }, status === "accepted" ? { "sparring.md": sparringMarkdown("READY", "Looks done") } : {});
    const planPath = path.join(ws.root, "docs", "plan.md");
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, PLAN);
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: status === "accepted",
      brief: false,
      plan: false,
      associatedPlan: { path: planPath, exists: true, text: PLAN, manualMatch: { label: "3B", title: "Barrier" } },
      continuation,
    };
    return buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, NOW);
  }

  it("automatic is the default and leads; the per-stage action stays beside it", async () => {
    const model = await standalone(undefined);
    assert.equal(model.continueAutomatically?.label, "Continue plan automatically");
    assert.equal(model.continueAutomatically?.kind, "adopt");
    assert.match(model.continueAutomatically!.detail, /^Adopt the existing stages into a managed plan and continue until Agent Sparring needs you\./);
    assert.match(model.continueAutomatically!.detail, /sparring run-plan --manifest … --adopt/);
    assert.equal(model.stageAction?.label, "Run stage", "the per-stage action is still there");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /class="primary" data-action="continueAutomatically"/);
    assert.match(html, /class="quiet" data-action="runStage"/, "demoted, not removed");
    assert.equal((html.match(/class="primary"/g) ?? []).length, 1, "one obvious next step");
  });

  it("manual mode offers no automatic continuation at all", async () => {
    const model = await standalone("manual");
    assert.equal(model.continueAutomatically, undefined);
    assert.equal(model.stageAction?.label, "Run stage");
    const html = renderOverviewHtml(model, "n", "c");
    assert.ok(!html.includes("continueAutomatically"));
    assert.match(html, /class="primary" data-action="runStage"/, "the per-stage checkpoint is the primary step again");
  });

  it("an accepted stage in automatic mode hands the rest of the plan over; in manual mode it starts one stage", async () => {
    const auto = await standalone(undefined, "accepted");
    assert.equal(auto.whatsNext?.kind, "next-stage");
    const autoHtml = renderOverviewHtml(auto, "n", "c");
    assert.match(autoHtml, /class="primary" data-action="continueAutomatically"/);
    assert.match(autoHtml, /class="quiet" data-action="startNextStage"/);

    const manual = await standalone("manual", "accepted");
    assert.equal(manual.continueAutomatically, undefined);
    assert.match(renderOverviewHtml(manual, "n", "c"), /class="primary" data-action="startNextStage"/);
  });

  it("a managed plan run offers to continue itself, and says it resumes rather than starts", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: false, brief: false, plan: true, planText: "# Foo plan\n" }, NOW);
    // This fixture's run was recorded without a source, which the engine
    // reads as `markdown` — so the offer must not promise --manifest, which
    // the engine would refuse for it.
    assert.match(model.continueAutomatically!.detail, /sparring resume-plan Foo plan:/);
    assert.ok(!model.continueAutomatically!.detail.includes("--manifest"));
  });

  it("a complete plan run offers nothing to continue", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2] });
    await ws.writeStage(FOO_STAGE_IDS[2], { status: "accepted", candidate_sha: "c".repeat(40) });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: false, brief: false, plan: true, planText: "# Foo plan\n" }, NOW);
    assert.equal(model.continueAutomatically, undefined);
  });

  it("a stage waiting for a human offers Submit for review instead: the plan cannot advance until the gate is answered", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-3b-barrier", { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparringMarkdown("NEEDS_YOU", "Check it on a device", "DEVICE/MANUAL CHECK -- verify the barrier on a real device") });
    const planPath = path.join(ws.root, "docs", "plan.md");
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, PLAN);
    const model = buildOverviewModel(
      selectRun((await discoverRuns([ws.location])).runs),
      undefined,
      { handoff: false, sparring: true, brief: false, plan: false, associatedPlan: { path: planPath, exists: true, text: PLAN, manualMatch: { label: "3B", title: "Barrier" } } },
      NOW,
    );
    assert.equal(model.actionRequired?.kind, "needs_you");
    // Adopting is offered even here — it is the only route from a standalone
    // stage into a managed run, and it does not touch the gate: the engine
    // reads the recorded NEEDS_YOU and keeps the pause. But it never leads.
    assert.equal(model.continueAutomatically?.kind, "adopt");
    assert.equal(model.continueAutomatically?.primary, false);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /class="quiet" data-action="continueAutomatically"/);
    assert.equal((html.match(/data-action="continueAutomatically"/g) ?? []).length, 1, "offered once, in the panel the user is already reading");
    assert.ok(html.indexOf('data-action="continueAutomatically"') > html.indexOf('data-action="submitForReview"'), "after Submit for review, which is what moves this stage");
    assert.match(html, /class="primary" data-action="submitForReview"/);
    assert.equal((html.match(/class="primary"/g) ?? []).length, 1, "still one obvious next step");
  });

  it("no plan, no automatic continuation: there is nothing to hand over", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-x", { status: "working" });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: false, brief: false, plan: false }, NOW);
    assert.equal(model.continueAutomatically, undefined);
  });
});
