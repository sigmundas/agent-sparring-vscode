/**
 * Run Plan's entry: the chosen document is classified by the engine
 * (`check-plan --json`) before any branch or workspace question; planning
 * input gets its own screen; a new run's feature-branch field never offers
 * the checked-out branch; Close leaves a neutral view, not an older plan's
 * intake; and an intake names its source plan file.
 *
 * The extension-host flow itself (no prompt, nothing launched, the managed
 * run first) is held in src/integration/worktreeRunsSuite.ts.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildCheckPlanArgs } from "../core/cli";
import { discoverRuns, type SparringLocation } from "../core/discovery";
import { decideExpectedBranch } from "../core/expectedBranch";
import { MANAGED_INTAKE_LIMITATION, PLANNING_INPUT_TITLE, PREPARE_INTAKE } from "../core/gettingStarted";
import { isStartPlanMessage } from "../core/overviewHtml";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, runPlanClosedModel, startPlanView, type StartPlanSession } from "../core/overviewModel";
import { classifyPlanDocument, featureBranchPrompt } from "../core/runPlanEntry";
import { parseStartPlanStatus } from "../core/startPlan";

const VALID = { exitCode: 0, stdout: JSON.stringify({ valid: true, kind: "markdown", label: "plan.md", stages: [], error: null }) };
const NO_STAGES = { exitCode: 1, stdout: JSON.stringify({ valid: false, error: "no '## Stage <n> — <title>' sections" }) };

function classifiedSession(kind: "planning-input" | "invalid", reason: string): StartPlanSession {
  return {
    planName: "2026-10-07-cloud-sync-extraction-and-orchestration.md",
    planLabel: "docs/plans/active/2026-10-07-cloud-sync-extraction-and-orchestration.md",
    planPath: "/repo/docs/plans/active/2026-10-07-cloud-sync-extraction-and-orchestration.md",
    expectedBranch: "",
    phase: "shown",
    answers: {},
    classification: { kind, reason },
    ...(kind === "planning-input" ? { planningInput: true } : {}),
  };
}

describe("Run Plan classifies the document before asking anything", () => {
  it("planning input on main: the engine's no-stages answer is planning input, for Make Plan…", () => {
    assert.deepEqual(classifyPlanDocument(0, NO_STAGES), { kind: "planning-input", reason: "no '## Stage <n> — <title>' sections" });
  });

  it("a plan the engine reads is runnable; a staged plan it refuses is invalid, with its reason", () => {
    assert.deepEqual(classifyPlanDocument(2, VALID), { kind: "runnable" });
    assert.deepEqual(classifyPlanDocument(2, { exitCode: 1, stdout: JSON.stringify({ valid: false, error: "Stage 2 appears twice" }) }), { kind: "invalid", reason: "Stage 2 appears twice" });
  });

  it("an unreadable file is said so; an engine without check-plan falls back to the file's stage headings", () => {
    assert.equal(classifyPlanDocument(undefined, VALID).kind, "unreadable");
    assert.deepEqual(classifyPlanDocument(2, undefined), { kind: "runnable" });
    assert.deepEqual(classifyPlanDocument(2, { exitCode: 2, stdout: "usage: sparring …" }), { kind: "runnable" });
    assert.equal(classifyPlanDocument(0, { exitCode: 2, stdout: "usage: sparring …" }).kind, "planning-input");
  });

  it("check-plan records nothing and needs no branch", () => {
    assert.deepEqual(buildCheckPlanArgs({ planPath: "/repo/ideas.md", repoRoot: "/repo" }), ["check-plan", "/repo/ideas.md", "--repo-root", "/repo", "--json"]);
    assert.deepEqual(buildCheckPlanArgs({ planPath: "/repo/ideas.md", repoRoot: "/repo", sparringDir: "/elsewhere/.sparring" }).slice(0, 3), ["--sparring-dir", "/elsewhere/.sparring", "check-plan"]);
  });

  it("the planning-input screen offers the engine's intake first and Make Plan… as an option, and states the managed limitation", () => {
    const view = startPlanView(classifiedSession("planning-input", "no '## Stage <n> — <title>' sections"));
    assert.equal(view.stateLabel, "Planning input");
    assert.deepEqual(view.planningInput, { reason: "no '## Stage <n> — <title>' sections" });
    assert.equal(view.refusal, undefined, "planning input is not a refusal");
    assert.equal(view.providerTurnNotice, "", "nothing was prepared");
    assert.equal(view.start, undefined);
    const html = renderOverviewHtml({ kind: "startPlan", title: view.planName, startPlan: view }, "n", "vscode-resource:");
    assert.ok(html.includes(PLANNING_INPUT_TITLE));
    assert.ok(html.includes("It will be analyzed into runnable stages before anything executes."));
    const prepare = html.indexOf(`data-startplan="prepareIntake"`);
    const makePlan = html.indexOf(`data-action="makePlanFromThis"`);
    assert.ok(prepare > 0 && makePlan > prepare, "Prepare intake first, then Make Plan…");
    assert.ok(html.includes(PREPARE_INTAKE));
    assert.match(html, /another planning\/audit pass/, "Make Plan… is described as optional");
    assert.ok(!/Use Make Plan|rather than a staged plan|Refused by the engine/.test(html), "Make Plan… is not presented as required");
    assert.ok(html.includes(MANAGED_INTAKE_LIMITATION.replace(/'/g, "&#39;")) || html.includes(MANAGED_INTAKE_LIMITATION), "the limitation is stated");
    assert.ok(!html.includes(`data-startplan="retry"`));
    assert.ok(html.includes(`data-startplan="dismiss"`), "Close");
    assert.ok(html.includes("2026-10-07-cloud-sync-extraction-and-orchestration.md"), "the chosen document is named");
    assert.ok(isStartPlanMessage({ type: "startPlan", action: "prepareIntake" }));
  });

  it("an invalid staged plan shows the engine's refusal, not the planning-input advice", () => {
    const view = startPlanView(classifiedSession("invalid", "Stage 2 appears twice"));
    assert.equal(view.planningInput, undefined);
    const html = renderOverviewHtml({ kind: "startPlan", title: view.planName, startPlan: view }, "n", "vscode-resource:");
    assert.ok(html.includes("Stage 2 appears twice"));
    assert.ok(!html.includes(PLANNING_INPUT_TITLE));
  });
});

describe("a new run's feature branch is never the protected branch checked out", () => {
  it("the checked-out branch is context, never the value to confirm", () => {
    assert.deepEqual(decideExpectedBranch(undefined, "main"), { kind: "ask", current: "main" });
    const prompt = featureBranchPrompt("main");
    assert.equal(prompt.value, "", "Enter does not confirm main");
    assert.match(prompt.prompt, /Checked out now: main\./);
    assert.equal(featureBranchPrompt(undefined).value, "");
  });

  it("a protected branch typed anyway is refused clearly, by the engine, on the Run Plan screen", () => {
    const error = "refusing unattended stage-agent run on protected branch 'main'";
    const status = parseStartPlanStatus(
      JSON.stringify({ schema_version: 1, status: "refused", route: null, plan: { path: "/repo/plan.md", label: "plan.md" }, expected_branch: "main", execution: {}, intake: null, slice: null, later_slices: [], decisions: [], findings: [], confirm_token: null, error }),
    );
    assert.ok(status);
    const view = startPlanView({ planName: "plan.md", planLabel: "plan.md", planPath: "/repo/plan.md", expectedBranch: "main", phase: "shown", answers: {}, status });
    assert.equal(view.refusal, error);
    assert.equal(view.start, undefined, "nothing to start");
    const html = renderOverviewHtml({ kind: "startPlan", title: "plan.md", startPlan: view }, "n", "vscode-resource:");
    assert.ok(html.includes("Refused by the engine. Nothing was approved or run."));
    assert.ok(html.includes("protected branch &#39;main&#39;") || html.includes("protected branch 'main'"), "with the engine's own reason");
  });
});

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");

async function copyTree(from: string, to: string, root: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await copyTree(source, target, root);
    } else {
      await fs.writeFile(target, (await fs.readFile(source, "utf8")).split("__ROOT__").join(root));
    }
  }
}

async function intakeProject(): Promise<SparringLocation> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-runplan-")));
  const root = path.join(base, "app");
  await fs.mkdir(root, { recursive: true });
  await copyTree(path.join(FIXTURES, "approved"), root, base);
  return { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: "app" };
}

describe("an older plan's intake cannot stand in for the plan just chosen", () => {
  it("Close from planning input shows the repository, not the intake automatic selection would pick", async () => {
    const location = await intakeProject();
    const intake = (await discoverRuns([location])).intakes?.[0];
    assert.ok(intake, "the old intake is discovered");
    const scope = { repoRoot: location.repoRoot, name: "app" };
    assert.equal(buildOverviewModel({ ambiguous: [], intake, scope }, undefined).kind, "intake", "automatic selection would show it");
    const closed = runPlanClosedModel({ ambiguous: [], intake, scope });
    assert.equal(closed.kind, "empty");
    assert.equal(closed.intake, undefined);
    assert.match(closed.emptyLines?.join(" ") ?? "", /nothing was started.*History \/ Runs…/);
    const html = renderOverviewHtml(closed, "n", "vscode-resource:");
    assert.ok(html.includes('data-action="runPlan"') || html.includes("Run plan…"), "Run plan… is offered again");
  });

  it("the intake, when shown deliberately, names its source plan file prominently", async () => {
    const location = await intakeProject();
    const intake = (await discoverRuns([location])).intakes?.[0];
    assert.ok(intake?.record.sourcePath, "the fixture records its source plan");
    const model = buildOverviewModel({ ambiguous: [], intake, pinned: true }, undefined);
    const file = path.basename(intake.record.sourcePath);
    assert.equal(model.intake?.sourceFile, file);
    const html = renderOverviewHtml(model, "n", "vscode-resource:");
    assert.ok(html.includes(`Plan intake of <strong class="intake-source">${file}</strong>`), "in the header, beside the state");
  });
});
