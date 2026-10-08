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
import { classifyPlanDocument, countStageHeadings, featureBranchPrompt, runPlanClosedHolds, type CheckPlanQuery } from "../core/runPlanEntry";
import { parseStartPlanStatus } from "../core/startPlan";

const VALID = { ok: true as const, exitCode: 0, stdout: JSON.stringify({ valid: true, kind: "markdown", label: "plan.md", stages: [], error: null }) };
const NO_STAGES = { ok: true as const, exitCode: 1, stdout: JSON.stringify({ valid: false, error: "no '## Stage <n> — <title>' sections" }) };

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
    assert.deepEqual(classifyPlanDocument(2, { ok: true, exitCode: 1, stdout: JSON.stringify({ valid: false, error: "Stage 2 appears twice" }) }), { kind: "invalid", reason: "Stage 2 appears twice" });
  });

  it("an unreadable file is said so; an engine that cannot classify stops Run Plan, with its reason", () => {
    assert.equal(classifyPlanDocument(undefined, VALID).kind, "unreadable");
    const unclassified = (headings: number, query: CheckPlanQuery | undefined, why: RegExp) => {
      const result = classifyPlanDocument(headings, query);
      assert.equal(result.kind, "unclassified", JSON.stringify(query));
      assert.match((result as { reason: string }).reason, why);
    };
    unclassified(2, undefined, /not asked/);
    unclassified(2, { ok: false, reason: "the sparring executable is resolved only by the shell" }, /could not be run: the sparring executable is resolved only by the shell/);
    unclassified(2, { ok: true, exitCode: 2, stdout: "usage: sparring {run-plan,…}" }, /does not accept check-plan.*usage: sparring/);
    unclassified(0, { ok: true, exitCode: 2, stdout: "usage: sparring …" }, /usage error/);
    // A JSON refusal outside the 0/1 contract is not a refusal: Prepare intake must not follow.
    const refusal = JSON.stringify({ valid: false, error: "usage: sparring check-plan …" });
    unclassified(0, { ok: true, exitCode: 2, stdout: refusal }, /usage error, exit 2.*usage: sparring check-plan/);
    unclassified(2, { ok: true, exitCode: 3, stdout: refusal }, /exited 3, which is neither/);
    const markdownRefused = { ok: true as const, exitCode: 1, stdout: JSON.stringify({ valid: false, error: "Stage 1A" }) };
    for (const exitCode of [2, 3, 127]) {
      const result = classifyPlanDocument(2, markdownRefused, { ok: true, exitCode, stdout: refusal });
      assert.equal(result.kind, "unclassified", `manifest check exit ${exitCode}`);
    }
    unclassified(2, { ok: true, exitCode: 0, stdout: "not json" }, /exited 0 without a JSON answer: not json/);
    unclassified(2, { ok: true, exitCode: 0, stdout: JSON.stringify({ stages: [] }) }, /without a JSON answer/);
    unclassified(2, { ok: true, exitCode: 1, stdout: VALID.stdout }, /contradict/);
    unclassified(0, { ok: true, exitCode: 0, stdout: NO_STAGES.stdout }, /contradict/);
  });

  it("a staged plan whose Markdown the engine refuses still runs when the manifest built from it is accepted", () => {
    const refused = { ok: true as const, exitCode: 1, stdout: JSON.stringify({ valid: false, error: "Stage 1A: lettered stages are not read as Markdown" }) };
    const manifestValid = { ok: true as const, exitCode: 0, stdout: JSON.stringify({ valid: true, kind: "manifest", label: "plan.md", stages: [], error: null }) };
    assert.deepEqual(classifyPlanDocument(2, refused, manifestValid), { kind: "runnable" });
    assert.deepEqual(classifyPlanDocument(2, refused, { ok: true, exitCode: 1, stdout: JSON.stringify({ valid: false, error: "manifest says no" }) }), { kind: "invalid", reason: "Stage 1A: lettered stages are not read as Markdown" });
    assert.equal(classifyPlanDocument(2, refused, { ok: false, reason: "spawn failed" }).kind, "unclassified", "a manifest check that could not run is not a verdict");
    assert.equal(classifyPlanDocument(0, NO_STAGES, manifestValid).kind, "planning-input", "planning input is never rescued by a manifest");
  });

  it("the heading probe ignores stage headings inside fenced examples", () => {
    const notes = "# Notes\n\nAn example plan:\n\n```markdown\n## Stage 1 — Example\nbody\n```\n\n~~~\n## Stage 2 — Also an example\n~~~\n";
    assert.equal(countStageHeadings(notes), 0);
    assert.deepEqual(classifyPlanDocument(countStageHeadings(notes), NO_STAGES), { kind: "planning-input", reason: "no '## Stage <n> — <title>' sections" });
    assert.equal(countStageHeadings("## Stage 1 — Real\n````\n## Stage 9 — x\n```\nstill fenced\n````\n## Stage 2 — Real\n"), 2);
    assert.equal(countStageHeadings("```\n## Stage 1 — never closed\n"), 0);
  });

  it("check-plan records nothing and needs no branch", () => {
    assert.deepEqual(buildCheckPlanArgs({ planPath: "/repo/ideas.md", repoRoot: "/repo" }), ["check-plan", "/repo/ideas.md", "--repo-root", "/repo", "--json"]);
    assert.deepEqual(buildCheckPlanArgs({ planPath: "/tmp/m.json", repoRoot: "/repo", manifest: true }), ["check-plan", "/tmp/m.json", "--manifest", "--repo-root", "/repo", "--json"]);
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

  it("a staged-looking document check-plan cannot run directly (e.g. '## Stage S1') still offers the engine's intake, calmly, with check-plan's reason under Technical details", () => {
    // start-plan routes any document that is not a direct plan to its intake,
    // so a check-plan refusal is not a dead end (sporely-py's 2026-10-07 plan).
    const reason = "line 143 looks like a stage heading but does not follow the convention '## Stage <n> — <title>': '## Stage S1 — Orchestration completion design'";
    const view = startPlanView(classifiedSession("invalid", reason));
    assert.deepEqual(view.planningInput, { reason, staged: true });
    assert.equal(view.refusal, undefined, "not shown as a refusal");
    assert.equal(view.stateLabel, "Not a direct staged plan");
    const html = renderOverviewHtml({ kind: "startPlan", title: view.planName, startPlan: view }, "n", "vscode-resource:");
    assert.ok(html.includes(PLANNING_INPUT_TITLE));
    assert.ok(html.includes(`data-startplan="prepareIntake"`), "Prepare intake is offered");
    assert.ok(html.includes(`data-action="makePlanFromThis"`), "Make Plan… stays optional");
    const technical = html.indexOf("<summary>Technical details</summary>");
    assert.ok(html.indexOf("Stage S1 — Orchestration completion design") > technical, "check-plan's words are kept under Technical details");
    const card = html.slice(html.indexOf('<section class="card planning-input">'), technical);
    assert.ok(card.includes("read through intake rather than run directly"), "the lead says what happens, in plain words");
    assert.ok(!card.includes('class="icon'), "no warning icons: nothing here is wrong");
    assert.ok(card.includes(`data-startplan="dismiss"`), "Close sits with the other choices");
    assert.equal((html.match(/data-startplan="dismiss"/g) ?? []).length, 1, "and only once");
    assert.ok(!html.includes("Engine command"), "no second command block");
    assert.ok(!html.includes("Refused by the engine"));
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

  it("Close of a document from another repository names that repository and holds until navigation moves", async () => {
    const followed = await intakeProject();
    const intake = (await discoverRuns([followed])).intakes?.[0];
    assert.ok(intake);
    const selection = { ambiguous: [], intake, scope: { repoRoot: followed.repoRoot, name: "app" } };
    // The document was in repository B; the window still follows A at Close.
    const closed = { repoRoot: "/elsewhere/b", followedAtClose: followed.repoRoot, selectionEpoch: "e1" };
    const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
    assert.ok(runPlanClosedHolds(closed, { followed: followed.repoRoot, selectionEpoch: "e1" }, same), "it does not end the moment it starts");
    const model = runPlanClosedModel(selection, undefined, { repoRoot: "/elsewhere/b", name: "b" });
    assert.equal(model.kind, "empty");
    assert.equal(model.intake, undefined, "A's old intake does not come back");
    assert.ok(!runPlanClosedHolds(closed, { followed: "/other/c", selectionEpoch: "e1" }, same), "a change of followed repository ends it");
    assert.ok(!runPlanClosedHolds(closed, { followed: followed.repoRoot, selectionEpoch: "e2" }, same), "so does a new selection");
    assert.ok(runPlanClosedHolds({ ...closed, followedAtClose: undefined }, { followed: undefined, selectionEpoch: "e1" }, same));
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

describe("the Run Plan picker lists plan-like documents, newest first", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const hour = 60 * 60 * 1000;
  const doc = (relative: string, text: string, mtimeMs: number) => ({ file: `/r/${relative}`, relative, text, mtimeMs });

  it("offers '## Stage S1' plans and planning input under plans/, newest first, Browse… last, and skips unrelated Markdown", async () => {
    const { planPickerItems } = await import("../core/runPlanEntry");
    const items = planPickerItems(
      [
        doc("docs/plans/active/2026-08-23-cloud-sync-extraction.md", "# Old\n\n## Stage 1 — A\n", now - 40 * 24 * hour),
        doc("docs/plans/active/2026-10-07-cloud-sync.md", "# New\n\n## Stage S1 — Design\n\n## Stage S2 — Baseline\n", now - 3 * hour),
        doc("docs/plans/ideas.md", "# Ideas\n\nprose\n", now - 2 * 24 * hour),
        doc("notes/staged.md", "## Stage 1 — X\n", now - 30 * 24 * hour),
        doc("README.md", "# Readme\n\n```md\n## Stage 1 — Example\n```\n", now - 1000),
        doc("CHANGELOG.md", "# Changelog\n\n## 1.0\n", now - 1000),
      ],
      now,
    );
    assert.deepEqual(
      items.map((item) => item.description),
      ["docs/plans/active/2026-10-07-cloud-sync.md", "docs/plans/ideas.md", "notes/staged.md", "docs/plans/active/2026-08-23-cloud-sync-extraction.md", "choose another Markdown file"],
    );
    assert.equal(items[0].detail, "2 stage sections · modified 3 hours ago");
    assert.equal(items[1].detail, "no stage sections (planning input) · modified 2 days ago");
    assert.equal(items.at(-1)?.file, "", "Browse… is last");
    assert.match(items.at(-1)?.label ?? "", /Browse…/);
  });

  it("prefers docs/plans/active over other plans/ folders and elsewhere when modified within hours, not days", async () => {
    const { planPickerItems } = await import("../core/runPlanEntry");
    const close = planPickerItems([doc("x/stage.md", "## Stage 1 — a\n", now - hour), doc("plans/p.md", "", now - 2 * hour), doc("docs/plans/active/a.md", "", now - 5 * hour)], now);
    assert.deepEqual(close.slice(0, -1).map((item) => item.description), ["docs/plans/active/a.md", "plans/p.md", "x/stage.md"]);
    const far = planPickerItems([doc("x/stage.md", "## Stage 1 — a\n", now - hour), doc("docs/plans/active/a.md", "", now - 3 * 24 * hour)], now);
    assert.deepEqual(far.slice(0, -1).map((item) => item.description), ["x/stage.md", "docs/plans/active/a.md"]);
  });

  it("bounds the entries shown and the files read", async () => {
    const { planPickerItems, planCandidatesToRead } = await import("../core/runPlanEntry");
    const many = Array.from({ length: 80 }, (_, i) => doc(`plans/p${i}.md`, "", now - i * hour));
    const items = planPickerItems(many, now, 50);
    assert.equal(items.length, 51);
    assert.equal(items[49].description, "plans/p49.md");
    assert.equal(items[50].file, "");
    const read = planCandidatesToRead([...many, doc("README.md", "", now - 30 * hour), doc("docs/plans/active/old.md", "", 0), doc("docs/plans/active/new.md", "", now - 3 * hour)], 3);
    assert.deepEqual(read.map((entry) => entry.relative), ["docs/plans/active/new.md", "plans/p0.md", "plans/p1.md"], "same order as shown: location counts only within hours");
  });

  it("a recent staged document outside plans/ is read and shown ahead of 200 much older plans", async () => {
    const { planPickerItems, planCandidatesToRead, PLAN_PICKER_LIMITS } = await import("../core/runPlanEntry");
    const old = Array.from({ length: 200 }, (_, i) => doc(`docs/plans/active/p${i}.md`, "## Stage 1 — a\n", now - 100 * 24 * hour - i));
    const current = doc("design/current.md", "## Stage S1 — Design\n", now);
    const read = planCandidatesToRead([...old, current], PLAN_PICKER_LIMITS.read);
    assert.equal(read.length, 200);
    assert.equal(read[0].relative, "design/current.md");
    assert.equal(planPickerItems(read, now)[0].description, "design/current.md");
  });

  it("says when a file was modified in human terms, against an injected clock", async () => {
    const { modifiedAgo } = await import("../core/runPlanEntry");
    assert.equal(modifiedAgo(now - 10_000, now), "just now");
    assert.equal(modifiedAgo(now - 60_000, now), "1 minute ago");
    assert.equal(modifiedAgo(now - 25 * 60_000, now), "25 minutes ago");
    assert.equal(modifiedAgo(now - hour, now), "1 hour ago");
    assert.equal(modifiedAgo(now - 30 * hour, now), "yesterday");
    assert.equal(modifiedAgo(now - 6 * 24 * hour, now), "6 days ago");
    const old = new Date(2026, 0, 5, 12).getTime();
    assert.equal(modifiedAgo(old, now), "on 2026-01-05");
  });
});
