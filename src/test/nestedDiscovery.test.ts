/**
 * The exact multi-root shape reported from a real window, and the shape VS
 * Code's saved window state actually showed: the project with `.sparring`
 * is a git worktree nested one level inside a workspace folder whose own
 * `.sparring` is a legacy directory without stages or plans.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { diagnoseDiscovery, renderDiagnostic } from "../core/diagnose";
import { discoverRuns, isNestedLocation, locateAll, locateSparringDirs, runIdFor, selectRun } from "../core/discovery";
import { chooseLaunchRepository, launchRepositories } from "../core/launchRepositories";
import { buildRunPickItems } from "../core/runPick";
import { Workspace, everywhereIsAGitRepo } from "./fixtures";

const STAGES = ["stage-reported-statistics-contract", "stage-reported-statistics-local-schema-barrier", "stage-reported-statistics-typed-parser"];

/** `sporely/` (no .sparring) and `sporely-py-reported-statistics/` as sibling workspace folders. */
async function siblingWindow() {
  const sporely = await Workspace.create({ sparring: false, name: "sporely" });
  const reported = await Workspace.create({ name: "sporely-py-reported-statistics", config: "root" });
  await reported.writeStage(STAGES[0], { status: "accepted", base_sha: "a", candidate_sha: "b" });
  await reported.writeStage(STAGES[1], { status: "accepted", base_sha: "b", candidate_sha: "c" }, {
    "brief.md": "# Brief\n",
    "handoff.md": "# Handoff\n",
    "sparring.md": "# Sparring\n",
  });
  await reported.appendActivity(STAGES[1], ['{"v":1,"ts":"2026-09-11T19:00:00.000Z","actor":"stage","event":"stage.created"}\n']);
  await reported.writeStage(STAGES[2], { status: "working" });
  const folders = [
    { index: 0, name: "sporely", scheme: "file", fsPath: sporely.root },
    { index: 1, name: "sporely-py-reported-statistics", scheme: "file", fsPath: reported.root },
  ];
  return { sporely, reported, folders };
}

describe("reported-statistics multi-root shape (sibling workspace folders)", () => {
  it("the second folder produces recorded runs without any plan run or .sparring/project.toml", async () => {
    const { reported, folders } = await siblingWindow();
    const locations = await locateAll(folders.map((folder) => ({ path: folder.fsPath, name: folder.name })));
    assert.equal(locations.length, 1);
    assert.equal(locations[0].workspaceFolder, reported.root);
    assert.equal(locations[0].projectDir, reported.root);
    assert.equal(locations[0].repoRoot, reported.root, "no .sparring/project.toml: repo root defaults to the project dir");
    assert.equal(isNestedLocation(locations[0]), false);

    const discovery = await discoverRuns(locations);
    assert.deepEqual(discovery.problems, []);
    assert.deepEqual(
      discovery.runs.map((run) => run.kind === "stage" && run.stage.stageId).sort(),
      STAGES,
    );
    assert.deepEqual(
      discovery.runs.map((run) => run.kind === "stage" && run.stage.state?.status),
      ["accepted", "accepted", "working"],
    );
    const selection = selectRun(discovery.runs);
    assert.equal(selection.selected?.kind === "stage" && selection.selected.stage.stageId, STAGES[2], "the one open stage is selected");

    const items = buildRunPickItems(discovery.runs, selection.selected?.id);
    assert.deepEqual(
      items.map((item) => item.label),
      ["$(check) Reported statistics typed parser", "Reported statistics local schema barrier", "Reported statistics contract"],
      "Select Repository / Run lists every stage by its readable name, open first, then newest",
    );
    assert.ok(
      items.every((item, at) => item.detail === `sporely-py-reported-statistics · ${[STAGES[2], STAGES[1], STAGES[0]][at]}`),
      "the repository and the raw stage id stay in the detail line, where an identifier belongs",
    );
  });

  it("all stages accepted: still recorded, the newest is selected as the terminal fallback", async () => {
    const { reported, folders } = await siblingWindow();
    await reported.writeStage(STAGES[2], { status: "accepted", candidate_sha: "d" });
    const discovery = await discoverRuns(await locateAll(folders.map((folder) => ({ path: folder.fsPath, name: folder.name }))));
    assert.equal(discovery.runs.length, 3);
    const selection = selectRun(discovery.runs);
    assert.equal(selection.selected?.kind === "stage" && selection.selected.stage.stageId, STAGES[2]);
    assert.equal(buildRunPickItems(discovery.runs).length, 3);
  });

  it("the diagnostic reports both folders and every stage with lifecycle status only", async () => {
    const { reported, folders } = await siblingWindow();
    const report = await diagnoseDiscovery(folders);
    assert.equal(report.folders.length, 2);
    assert.equal(report.folders[0].sparringExists, false);
    assert.deepEqual(report.folders[0].locations, []);
    assert.equal(report.folders[1].probed, path.join(reported.root, ".sparring"));
    assert.equal(report.folders[1].sparringExists, true);
    const location = report.folders[1].locations[0];
    assert.equal(location.configExists, false);
    assert.equal(location.stagesExists, true);
    assert.equal(location.plansExists, false);
    assert.deepEqual(
      location.stages.map((stage) => [stage.name, stage.stateExists, stage.parsed, stage.status]),
      [
        [STAGES[0], true, true, "accepted"],
        [STAGES[1], true, true, "accepted"],
        [STAGES[2], true, true, "working"],
      ],
    );
    assert.equal(location.runIds.length, 3);
    assert.equal(report.runs.length, 3);
    assert.equal(report.pickLabels.length, 3);
    assert.ok(report.selectedId);
    assert.equal(report.noSelectionReason, undefined);

    const text = renderDiagnostic(report).join("\n");
    assert.match(text, /folder 1: sporely-py-reported-statistics/);
    assert.match(text, /stages\/ exists: yes/);
    assert.match(text, new RegExp(`${STAGES[1]}: state.json yes; parsed, status accepted`));
    assert.doesNotMatch(text, /# Brief|# Handoff|# Sparring|stage\.created/, "no file contents");
  });
});

describe("nested project inside a workspace folder (the shape in VS Code's saved window state)", () => {
  /**
   * sporely/                          ← workspace folder
   * ├── .sparring/                    ← legacy: handoffs/prompts, no stages, no plans
   * └── sporely-py-reported-statistics/   ← git worktree, NOT a workspace folder
   *     └── .sparring/stages/<3 stages>/state.json
   */
  async function nestedWindow() {
    const sporely = await Workspace.create({ name: "sporely", config: "none" });
    await fs.mkdir(path.join(sporely.sparringDir, "handoffs"), { recursive: true });
    await fs.mkdir(path.join(sporely.sparringDir, "prompts"), { recursive: true });
    const reported = await Workspace.createNested(sporely.root, "sporely-py-reported-statistics");
    await fs.writeFile(path.join(reported.root, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
    await reported.writeStage(STAGES[0], { status: "accepted", candidate_sha: "a" });
    await reported.writeStage(STAGES[1], { status: "accepted", candidate_sha: "b" });
    await reported.writeStage(STAGES[2], { status: "accepted", candidate_sha: "c" });
    // Noise that must never be entered.
    await fs.mkdir(path.join(sporely.root, "node_modules", "pkg", ".sparring", "stages", "fake"), { recursive: true });
    await fs.writeFile(path.join(sporely.root, "node_modules", "pkg", ".sparring", "stages", "fake", "state.json"), "{}");
    await fs.mkdir(path.join(sporely.root, ".venv", ".sparring", "stages"), { recursive: true });
    return { sporely, reported };
  }

  it("discovers the nested project's stages although the folder's own .sparring has none", async () => {
    const { sporely, reported } = await nestedWindow();
    const locations = await locateSparringDirs(sporely.root, "sporely");
    assert.deepEqual(
      locations.map((location) => [location.folderName, location.projectDir, location.workspaceFolder, isNestedLocation(location)]),
      [
        ["sporely", sporely.root, sporely.root, false],
        ["sporely-py-reported-statistics", reported.root, sporely.root, true],
      ],
    );
    const discovery = await discoverRuns(locations);
    assert.equal(discovery.runs.length, 3);
    assert.ok(discovery.runs.every((run) => run.location.projectDir === reported.root));
    assert.equal(discovery.runs[0].id, runIdFor(locations[1], "stage", STAGES[0]));
    assert.ok(discovery.runs[0].id.startsWith(`${reported.root}|`), "run ids are keyed by the nested project, not the workspace folder");
    const selection = selectRun(discovery.runs);
    assert.equal(selection.selected?.location.folderName, "sporely-py-reported-statistics");
    assert.equal(buildRunPickItems(discovery.runs).length, 3);
  });

  it("before the fix this was exactly the empty result the window showed: depth 0 finds only the legacy directory", async () => {
    const { sporely } = await nestedWindow();
    const locations = await locateSparringDirs(sporely.root, "sporely", { nestedSearchDepth: 0 });
    assert.equal(locations.length, 1);
    assert.equal((await discoverRuns(locations)).runs.length, 0);
    const report = await diagnoseDiscovery([{ index: 0, name: "sporely", scheme: "file", fsPath: sporely.root }], { nestedSearchDepth: 0 });
    assert.match(report.noSelectionReason ?? "", /has neither stages\/ nor plans\//);
  });

  it("the diagnostic names the nested project and explains the legacy directory", async () => {
    const { sporely, reported } = await nestedWindow();
    const report = await diagnoseDiscovery([{ index: 0, name: "sporely", scheme: "file", fsPath: sporely.root }]);
    assert.equal(report.folders[0].locations.length, 2);
    assert.equal(report.folders[0].locations[1].nested, true);
    assert.equal(report.folders[0].locations[1].projectDir, reported.root);
    assert.equal(report.folders[0].locations[1].runIds.length, 3);
    const text = renderDiagnostic(report).join("\n");
    assert.match(text, /locations found \(including nested\): 2/);
    assert.match(text, new RegExp(`nested project: ${reported.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, /Select Repository \/ Run would list 3 item\(s\)/);
  });

  it("never enters hidden or dependency directories and stops at a project root", async () => {
    const { sporely, reported } = await nestedWindow();
    await Workspace.createNested(reported.root, "inner"); // inside a project root: must not be found
    const locations = await locateSparringDirs(sporely.root, "sporely", { nestedSearchDepth: 4 });
    assert.deepEqual(
      locations.map((location) => location.projectDir),
      [sporely.root, reported.root],
    );
  });

  it("honours the depth limit and finds monorepo packages two levels down", async () => {
    const mono = await Workspace.create({ sparring: false, name: "mono" });
    const pkg = await Workspace.createNested(mono.root, "packages/api");
    await pkg.writeStage("hotfix-1", { status: "working" });
    assert.equal((await locateSparringDirs(mono.root, "mono", { nestedSearchDepth: 1 })).length, 0);
    const found = await locateSparringDirs(mono.root, "mono", { nestedSearchDepth: 2 });
    assert.equal(found.length, 1);
    assert.equal(found[0].folderName, "api");
    assert.equal(selectRun((await discoverRuns(found)).runs).selected?.location.projectDir, pkg.root);
  });

  it("Run Plan targets the nested project for a file inside it, and the parent otherwise", async () => {
    const { sporely, reported } = await nestedWindow();
    const locations = await locateSparringDirs(sporely.root, "sporely");
    assert.equal(chooseLaunchRepository(await launchRepositories(locations, [], [], everywhereIsAGitRepo), undefined, path.join(reported.root, "main.py"))?.location.projectDir, reported.root);
    assert.equal(chooseLaunchRepository(await launchRepositories(locations, [], [], everywhereIsAGitRepo), undefined, path.join(sporely.root, "README.md"))?.location.projectDir, sporely.root);
  });

  it("a non-file workspace folder is reported as skipped, not probed", async () => {
    const report = await diagnoseDiscovery([{ index: 0, name: "remote", scheme: "vscode-vfs", fsPath: "/remote" }]);
    assert.match(report.folders[0].skipped ?? "", /not "file"/);
    assert.match(report.noSelectionReason ?? "", /skipped/);
  });
});
