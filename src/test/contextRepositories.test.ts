/**
 * Read-only context repositories for start-plan: the missing one is named
 * plainly, found by the engine's own identity, passed as
 * --context-repository, and kept across a retry. A plan with one repository
 * is unchanged.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { contextRepositoryArgs, missingContextRepositories, projectNameFromToml, repositoriesNamed, repositoryIdentity } from "../core/contextRepositories";
import { isStartPlanMessage, renderOverviewHtml } from "../core/overviewHtml";
import { startPlanView, type StartPlanSession } from "../core/overviewModel";
import { checkRepositoryMapping } from "../core/repositoryMapping";
import { buildStartPlanArgs, parseStartPlanStatus, type StartPlanFinding } from "../core/startPlan";

const siblingNotSupplied: StartPlanFinding = {
  code: "sibling_not_supplied",
  severity: "error",
  disposition: "refuse",
  origin: "engine",
  message: "the plan names repository 'sporely-py' (stages 2), but intake did not inspect it; run prepare-plan again with --context-repository sporely-py=<path>",
  stages: ["2"],
};
const crossRepository: StartPlanFinding = { code: "cross_repository_without_candidate_strategy", severity: "error", disposition: "refuse", origin: "engine", message: "stage 2 spans repositories", stages: ["2"] };
const unrelated: StartPlanFinding = { code: "gate_unenforced", severity: "warning", disposition: "plan_note", origin: "engine", message: "lines 3-4: a gate", stages: [] };

function refusedSession(findings: StartPlanFinding[], contextRepositories?: Record<string, string>): StartPlanSession {
  const status = parseStartPlanStatus(
    JSON.stringify({
      schema_version: 1,
      status: "refused",
      route: "intake",
      plan: { path: "/web/docs/plans/active/p.md", label: "p.md" },
      expected_branch: "feature/photo-provenance",
      execution: {},
      intake: null,
      slice: null,
      later_slices: [],
      decisions: [],
      findings,
      confirm_token: null,
      error: "intake refused: sibling_not_supplied",
    }),
  );
  assert.ok(status);
  return { planName: "p.md", planLabel: "p", planPath: "/web/docs/plans/active/p.md", expectedBranch: "feature/photo-provenance", phase: "shown", answers: {}, status, ...(contextRepositories ? { contextRepositories } : {}) };
}

describe("a repository the plan names but Run Plan did not supply", () => {
  it("is named from the engine's finding, once, and not when already supplied", () => {
    assert.deepEqual(missingContextRepositories([siblingNotSupplied, crossRepository, siblingNotSupplied, unrelated]), ["sporely-py"]);
    assert.deepEqual(missingContextRepositories([siblingNotSupplied], { "sporely-py": "/py" }), [], "a confirmed repository is not asked for again");
    assert.deepEqual(missingContextRepositories([{ ...siblingNotSupplied, message: "something else" }]), [], "an unreadable finding is left to the findings list");
  });

  it("is shown as one missing input with Select repository and retry; the findings and the refusal stay under details; no Check again", () => {
    const view = startPlanView(refusedSession([siblingNotSupplied, crossRepository, unrelated]));
    assert.deepEqual(view.missingRepositories, { names: ["sporely-py"], relatedFindings: 2 });
    assert.equal(view.findings.length, 3, "every engine finding is kept");
    const html = renderOverviewHtml({ kind: "startPlan", title: view.planName, startPlan: view }, "n", "vscode-resource:");
    assert.ok(html.includes(`data-startplan="selectRepository"`));
    assert.ok(html.includes("Repository needed: sporely-py"));
    assert.ok(html.includes("does not need editing"));
    assert.ok(!html.includes(`data-startplan="retry"`), "the refused command is not offered unchanged");
    assert.ok(html.includes("Findings (3, 2 from the missing repository)"));
    assert.ok(!/<details class="start-findings" open>/.test(html), "findings are details, not the headline");
    assert.match(html, /<details class="tech"><summary>Technical details<\/summary><pre class="engineerror">intake refused: sibling_not_supplied/);
    assert.ok(isStartPlanMessage({ type: "startPlan", action: "selectRepository" }));
  });

  it("is no longer missing once confirmed: the screen names the context and offers nothing to select", () => {
    const view = startPlanView(refusedSession([siblingNotSupplied], { "sporely-py": "/py" }));
    assert.equal(view.missingRepositories, undefined);
    assert.deepEqual(view.contextLines, ["sporely-py: /py (read-only)"]);
  });

  it("relabels Prepare intake on the planning-input screen when this plan is known to need a repository", () => {
    const session: StartPlanSession = { planName: "p.md", planLabel: "p", planPath: "/p.md", expectedBranch: "", phase: "shown", answers: {}, classification: { kind: "planning-input", reason: "no stages" }, planningInput: true, missingRepositories: ["sporely-py"] };
    const html = renderOverviewHtml({ kind: "startPlan", title: "p.md", startPlan: startPlanView(session) }, "n", "vscode-resource:");
    assert.ok(html.includes("Select sporely-py and prepare intake"));
    assert.ok(!html.includes("Prepare intake (recommended)"));
  });
});

describe("a plan with one repository is unchanged", () => {
  it("has no context arguments, no missing-repository card, and keeps Check again and Prepare intake (recommended)", () => {
    const base = { planPath: "/r/p.md", repoRoot: "/r", expectedBranch: "feature/x", json: true as const };
    assert.deepEqual(buildStartPlanArgs({ ...base, contextRepositories: {} }), buildStartPlanArgs(base));
    assert.ok(!buildStartPlanArgs(base).includes("--context-repository"));
    const view = startPlanView(refusedSession([unrelated]));
    assert.equal(view.missingRepositories, undefined);
    const html = renderOverviewHtml({ kind: "startPlan", title: view.planName, startPlan: view }, "n", "vscode-resource:");
    assert.ok(html.includes(`data-startplan="retry"`));
    assert.ok(html.includes("Refused by the engine. Nothing was approved or run."), "a refusal of the plan itself is shown as before");
    const planning: StartPlanSession = { planName: "p.md", planLabel: "p", planPath: "/p.md", expectedBranch: "", phase: "shown", answers: {}, classification: { kind: "planning-input", reason: "no stages" }, planningInput: true };
    assert.ok(renderOverviewHtml({ kind: "startPlan", title: "p.md", startPlan: startPlanView(planning) }, "n", "vscode-resource:").includes("Prepare intake (recommended)"));
  });
});

describe("the confirmed repository is passed to start-plan", () => {
  it("as --context-repository NAME=PATH, in both the evaluation and the confirmation, so the token matches", () => {
    const base = { planPath: "/web/p.md", repoRoot: "/web", expectedBranch: "feature/photo-provenance", contextRepositories: { "sporely-py": "/code/sporely-py" } };
    const json = buildStartPlanArgs({ ...base, json: true });
    const confirm = buildStartPlanArgs({ ...base, confirm: "t0k" });
    for (const args of [json, confirm]) {
      const at = args.indexOf("--context-repository");
      assert.equal(args[at + 1], "sporely-py=/code/sporely-py");
    }
    assert.deepEqual(json.slice(0, json.indexOf("--json")), confirm.slice(0, confirm.indexOf("--confirm")), "identical apart from --json/--confirm");
    assert.deepEqual(contextRepositoryArgs({ b: "/b", a: "/a" }), ["--context-repository", "a=/a", "--context-repository", "b=/b"]);
  });
});

describe("a repository is found by the identity the engine gives it", () => {
  it("reads project.toml's top-level project, else the folder name", async () => {
    assert.equal(projectNameFromToml(`project = "sporely-py"\n\n[repo]\nroot = "."\n`), "sporely-py");
    assert.equal(projectNameFromToml(`[repo]\nproject = "nested"\n`), undefined, "only the top level");
    const files: Record<string, string> = { "/code/sporely-py-ui-cleanup/.sparring/project.toml": `project = "sporely-py"\n` };
    const read = async (file: string) => files[file];
    assert.deepEqual(await repositoryIdentity("/code/sporely-py-ui-cleanup", read), { path: "/code/sporely-py-ui-cleanup", name: "sporely-py", source: "project.toml" });
    assert.deepEqual(await repositoryIdentity("/code/sporely-py", read), { path: "/code/sporely-py", name: "sporely-py", source: "folder name" });
    assert.deepEqual(await repositoryIdentity("/code/sporely-pyx", read), { path: "/code/sporely-pyx", name: "sporely-pyx", source: "folder name" });
  });

  it("matches exactly: one, several (ambiguous, for the person to choose), or none (select a folder)", () => {
    const ids = [
      { path: "/code/sporely-py", name: "sporely-py", source: "folder name" as const },
      { path: "/code/sporely-pyx", name: "sporely-pyx", source: "folder name" as const },
      { path: "/code/py-worktree", name: "sporely-py", source: "project.toml" as const },
      { path: "/code/sporely-py/", name: "sporely-py", source: "folder name" as const },
    ];
    assert.deepEqual(repositoriesNamed("sporely-py", ids.slice(0, 2)).map((id) => id.path), ["/code/sporely-py"], "never a lookalike name");
    assert.deepEqual(repositoriesNamed("sporely-py", ids).map((id) => id.path), ["/code/sporely-py", "/code/py-worktree"], "several, once per path");
    assert.deepEqual(repositoriesNamed("sporely-landing", ids), []);
  });

  it("a selected folder must be a git repository root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparring-ctx-"));
    try {
      const repo = path.join(dir, "sporely-py");
      fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
      assert.equal((await checkRepositoryMapping("sporely-py", repo, undefined)).valid, false, "not a repository");
      execFileSync("git", ["-C", repo, "init", "-q"]);
      assert.equal((await checkRepositoryMapping("sporely-py", repo, undefined)).valid, true);
      assert.equal((await checkRepositoryMapping("sporely-py", path.join(repo, "sub"), undefined)).valid, false, "not the root");
      assert.equal((await checkRepositoryMapping("sporely-py", path.join(dir, "missing"), undefined)).valid, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
