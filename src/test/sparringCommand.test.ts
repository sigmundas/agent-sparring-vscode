/**
 * Recognising sparring commands typed in a terminal and tying them to the
 * right repository and run id, including nested / multi-root workspaces.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRunLoopArgs, buildRunPlanArgs } from "../core/cli";
import { discoverRuns, locateSparringDirs, runIdFor, selectRun, type PlanRunSnapshot } from "../core/discovery";
import { commandLineIsOperation, targetIsAttributable, matchSparringCommand, parseSparringCommand, planKey, planLabel, planRunId, tokenizeCommandLine } from "../core/sparringCommand";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, Workspace } from "./fixtures";

describe("command line tokenizer", () => {
  it("splits on whitespace and honours quotes and backslashes", () => {
    assert.deepEqual(tokenizeCommandLine(`sparring run-loop stage-x --repo-root "/code/my repo" --expected-branch 'feat/a b'`), [
      "sparring",
      "run-loop",
      "stage-x",
      "--repo-root",
      "/code/my repo",
      "--expected-branch",
      "feat/a b",
    ]);
    assert.deepEqual(tokenizeCommandLine(`sparring run-loop my\\ stage`), ["sparring", "run-loop", "my stage"]);
    assert.deepEqual(tokenizeCommandLine(`  sparring   run-loop s ; echo done`), ["sparring", "run-loop", "s"], "only the first simple command counts");
    assert.deepEqual(tokenizeCommandLine(""), []);
  });
});

describe("parseSparringCommand", () => {
  it("recognises run-loop with the engine's flag surface, with or without a leading path or wrapper", () => {
    for (const line of [
      "sparring run-loop stage-reported-statistics-typed-parser --repo-root /code/app --expected-branch feature/x",
      "/Users/me/.venv/bin/sparring run-loop stage-reported-statistics-typed-parser --repo-root=/code/app --expected-branch=feature/x --stage-model opus",
      "uv run sparring run-loop stage-reported-statistics-typed-parser --expected-branch feature/x --repo-root /code/app",
      "AGENT_SPARRING_DEBUG=1 python -m agent_sparring.cli run-loop stage-reported-statistics-typed-parser --repo-root /code/app --expected-branch feature/x",
      "sparring.exe run-loop stage-reported-statistics-typed-parser --repo-root /code/app --expected-branch feature/x",
    ]) {
      const parsed = parseSparringCommand(line);
      assert.ok(parsed, line);
      assert.equal(parsed.subcommand, "run-loop");
      assert.equal(parsed.stageId, "stage-reported-statistics-typed-parser");
      assert.equal(parsed.repoRoot, "/code/app");
      assert.equal(parsed.expectedBranch, "feature/x");
    }
  });

  it("recognises run-plan / resume-plan and the global --sparring-dir", () => {
    const run = parseSparringCommand("sparring --sparring-dir /meta/.sparring run-plan docs/plans/foo.md --repo-root /code/app --expected-branch main");
    assert.deepEqual(run, { subcommand: "run-plan", sparringDir: "/meta/.sparring", planPath: "docs/plans/foo.md", repoRoot: "/code/app", expectedBranch: "main" });
    const resume = parseSparringCommand("sparring resume-plan docs/plans/foo.md --repo-root . --expected-branch main --evidence 'checked on device'");
    assert.equal(resume?.subcommand, "resume-plan");
    assert.equal(resume?.planPath, "docs/plans/foo.md");
  });

  it("ignores everything that is not a loop command", () => {
    for (const line of ["ls -la", "sparring new-stage s", "sparring check-config", "git status", "sparring", "sparring run-loop", "sparring --unknown-flag run-loop s --expected-branch m", "echo sparring run-loop s"]) {
      assert.equal(parseSparringCommand(line), undefined, line);
    }
  });

  it("parses exactly what buildRunLoopArgs / buildRunPlanArgs would have produced", () => {
    const args = buildRunLoopArgs({ stageId: "s", repoRoot: "/code/app", expectedBranch: "main", sparringDir: "/code/meta/.sparring" });
    const parsed = parseSparringCommand(["sparring", ...args].join(" "));
    assert.deepEqual(parsed, { subcommand: "run-loop", sparringDir: "/code/meta/.sparring", stageId: "s", repoRoot: "/code/app", expectedBranch: "main" });
    const plan = parseSparringCommand(["sparring", ...buildRunPlanArgs({ planPath: "/code/app/docs/p.md", repoRoot: "/code/app", expectedBranch: "main" })].join(" "));
    assert.equal(plan?.planPath, "/code/app/docs/p.md");
  });
});

describe("plan identity (plan.py: plan_label + plan_key)", () => {
  it("reproduces the engine's keys", () => {
    // Values printed by agent_sparring.plan.plan_key for these labels.
    assert.equal(planKey(FOO_PLAN_LABEL), FOO_PLAN_KEY);
    assert.equal(planKey("/abs/path/My Plan v2.md"), "my-plan-v2-c71f0490");
    assert.equal(planKey("plan.md"), "plan-0bbe5bc4");
    assert.equal(planKey("docs/plan.md"), "plan-61bf2008");
    assert.equal(planKey("docs-plan.md"), "docs-plan-5d00f5c1");
  });

  it("labels a plan repo-relative inside the repository and absolute outside it", () => {
    assert.equal(planLabel("/code/app/docs/plans/foo.md", "/code/app"), "docs/plans/foo.md");
    assert.equal(planLabel("/code/app/../app/docs/plans/foo.md", "/code/app"), "docs/plans/foo.md");
    assert.equal(planLabel("/elsewhere/plan.md", "/code/app"), "/elsewhere/plan.md");
  });
});

describe("matching a typed command to a discovered run", () => {
  it("13. nested / multi-root: the nested project's own root wins, by --repo-root or by cwd", async () => {
    const parent = await Workspace.create({ sparring: false, name: "sporely" });
    const nested = await Workspace.createNested(parent.root, "sporely-py-reported-statistics");
    await nested.writeStage("stage-x", { status: "working" });
    const sibling = await Workspace.createNested(parent.root, "other");
    await sibling.writeStage("stage-x", { status: "working" });
    const locations = await locateSparringDirs(parent.root, "sporely");
    assert.equal(locations.length, 2);

    const parsed = parseSparringCommand("sparring run-loop stage-x --repo-root . --expected-branch main")!;
    const byCwd = matchSparringCommand(parsed, nested.root, locations);
    assert.equal(byCwd?.location.repoRoot, nested.root);
    assert.equal(byCwd?.runId, runIdFor(byCwd!.location, "stage", "stage-x"));
    const explicit = parseSparringCommand(`sparring run-loop stage-x --repo-root ${sibling.root} --expected-branch main`)!;
    assert.equal(matchSparringCommand(explicit, parent.root, locations)?.location.repoRoot, sibling.root, "an absolute --repo-root picks the sibling even from the parent cwd");
    const fromParent = parseSparringCommand("sparring run-loop stage-x --expected-branch main")!;
    assert.equal(matchSparringCommand(fromParent, parent.root, locations), undefined, "the parent has no .sparring: nothing is guessed");
    const subdir = matchSparringCommand(fromParent, path.join(nested.root, "src", "pkg"), locations);
    assert.equal(subdir?.location.repoRoot, nested.root, "a cwd inside the project resolves to it");

    const runs = (await discoverRuns(locations)).runs;
    assert.ok(runs.some((run) => run.id === byCwd!.runId), "the matched id is a discovered run id");
  });

  it("run-plan matches the run id the engine will write, whether the plan path is relative or absolute", async () => {
    const ws = await Workspace.create({ withSpaces: true });
    const planFile = await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: "foo-1cd13d24-stage-1-contract" });
    const run = selectRun((await discoverRuns([ws.location])).runs).selected as PlanRunSnapshot;
    assert.equal(run.kind, "plan");
    const relative = matchSparringCommand(parseSparringCommand("sparring run-plan docs/plans/foo.md --expected-branch main")!, ws.root, [ws.location]);
    assert.equal(relative?.runId, run.id);
    const absolute = matchSparringCommand(parseSparringCommand(`sparring resume-plan "${planFile}" --repo-root "${ws.root}" --expected-branch main`)!, "/somewhere/else", [ws.location]);
    assert.equal(absolute?.runId, run.id);
    assert.equal(absolute?.kind, "resume-plan");
    assert.equal(planRunId(ws.location, planFile), run.id, "extension launches compute the same id");
  });

  it("--sparring-dir selects the project when the repository root lives elsewhere", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s");
    const parsed = parseSparringCommand(`sparring --sparring-dir ${ws.sparringDir} run-loop s --expected-branch main`)!;
    assert.equal(matchSparringCommand(parsed, "/unrelated", [ws.location])?.location.sparringDir, ws.sparringDir);
    assert.equal(matchSparringCommand(parsed, undefined, [ws.location])?.location.sparringDir, ws.sparringDir, "absolute paths need no cwd");
    assert.equal(matchSparringCommand(parseSparringCommand("sparring run-loop s --expected-branch main")!, undefined, [ws.location]), undefined, "relative defaults without a cwd cannot be resolved");
  });
});

describe("commandLineIsOperation (the predicate that may remove duplicate protection)", () => {
  const loop = "/Users/me/.venv/bin/python /Users/me/.venv/bin/sparring run-loop stage-x --repo-root /code/app --expected-branch main";

  it("matches the operation's own command line and nothing else", () => {
    assert.equal(commandLineIsOperation(loop, { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), true);
    assert.equal(commandLineIsOperation(loop, { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-y" }), false);
    assert.equal(commandLineIsOperation(loop, { kind: "run-plan", repoRoot: "/code/app", planPath: "/code/app/docs/p.md" }), false, "another subcommand is another operation");
    assert.equal(commandLineIsOperation("claude -p --output-format stream-json", { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), false, "the provider child is not the runner");
    assert.equal(
      commandLineIsOperation("/venv/bin/python /venv/bin/sparring run-plan /code/app/docs/p.md --repo-root /code/app --expected-branch m", { kind: "run-plan", repoRoot: "/code/app", planPath: "/code/app/docs/p.md" }),
      true,
    );
  });

  it("the same stage id in another repository is a different operation", () => {
    // The reviewer's reproduction: `stage-4` exists in both repositories, and
    // matching on the stage id alone let repository B's runner resolve
    // repository A's guard.
    assert.equal(commandLineIsOperation(loop, { kind: "run-loop", repoRoot: "/code/other", stageId: "stage-x" }), false);
    const elsewhere = loop.replace("/code/app", "/code/other");
    assert.equal(commandLineIsOperation(elsewhere, { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), false);
    assert.equal(commandLineIsOperation(elsewhere, { kind: "run-loop", repoRoot: "/code/other", stageId: "stage-x" }), true, "in its own repository it does match");
  });

  it("the same plan or manifest basename at another full path is a different operation", () => {
    // The other reproduction: plan and manifest paths were compared by
    // basename, so /repo/other/plan.md resolved /repo/one/plan.md.
    const other = "sparring run-plan /repo/other/plan.md --repo-root /repo/one --expected-branch b";
    assert.equal(commandLineIsOperation(other, { kind: "run-plan", repoRoot: "/repo/one", planPath: "/repo/one/plan.md" }), false);
    assert.equal(
      commandLineIsOperation("sparring resume-plan --manifest /other/dir/foo.manifest.json --repo-root /r --expected-branch b", { kind: "resume-plan", repoRoot: "/r", manifest: "/tmp/foo.manifest.json" }),
      false,
      "a manifest of the same name in another directory is another manifest",
    );
    assert.equal(
      commandLineIsOperation("sparring resume-plan --manifest /tmp/foo.manifest.json --repo-root /r --expected-branch b", { kind: "resume-plan", repoRoot: "/r", manifest: "/tmp/foo.manifest.json" }),
      true,
    );
  });

  it("a command line that names no project, or names one relatively, proves nothing", () => {
    assert.equal(commandLineIsOperation("sparring run-loop stage-x --expected-branch main", { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), false, "ps gives no cwd, so nothing can be resolved");
    assert.equal(commandLineIsOperation("sparring run-loop stage-x --repo-root ../app --expected-branch main", { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), false);
    assert.equal(commandLineIsOperation("sparring run-plan docs/p.md --repo-root /code/app", { kind: "run-plan", repoRoot: "/code/app", planPath: "/code/app/docs/p.md" }), false, "a relative plan path cannot be compared either");
  });

  it("--sparring-dir identifies the project, exactly as the engine treats it", () => {
    const withDir = "sparring --sparring-dir /code/app/.sparring run-loop stage-x --expected-branch main";
    assert.equal(commandLineIsOperation(withDir, { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), true, "the engine's default location under the repository root");
    assert.equal(commandLineIsOperation(withDir, { kind: "run-loop", repoRoot: "/code/app", sparringDir: "/elsewhere/.sparring", stageId: "stage-x" }), false);
    assert.equal(commandLineIsOperation("sparring --sparring-dir /other/.sparring run-loop stage-x", { kind: "run-loop", repoRoot: "/code/app", stageId: "stage-x" }), false);
  });

  it("an operation that cannot be recognised at all is never matched", () => {
    assert.equal(targetIsAttributable({ kind: "run-loop", stageId: "stage-x" }), false, "no project");
    assert.equal(targetIsAttributable({ kind: "run-loop", repoRoot: "/code/app" }), false, "no stage");
    assert.equal(targetIsAttributable({ kind: "run-plan", repoRoot: "/code/app", planPath: "docs/p.md" }), false, "a relative plan path");
    assert.equal(targetIsAttributable({ kind: "run-plan", repoRoot: "/code/app", planPath: "/code/app/docs/p.md" }), true);
    assert.equal(commandLineIsOperation(loop, { kind: "run-loop", stageId: "stage-x" }), false, "and an unattributable target matches nothing");
  });
});
