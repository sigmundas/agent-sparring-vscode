/**
 * A managed run's plan input kind never changes.
 *
 * The reported failure: a plan run was recorded as `source = markdown`, the
 * extension later invoked `resume-plan --manifest …`, and the engine refused
 * it — correctly, because the two inputs describe different execution
 * content for the same plan:
 *
 *     plan run … was started from a markdown plan input, not a manifest one;
 *     refusing to resume the same run from a different kind of input
 *
 * The engine's behaviour is right, so the fix is that the request is never
 * generated. These tests hold the rule at the places it can be broken: the
 * one function that decides the input, the command builder that checks the
 * decision, every command path that reaches `resume-plan`, and the Overview
 * text that tells a person which command will run.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { buildOverviewModel } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-18T10:00:00.000Z");

async function commandsSource(): Promise<string> {
  return fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
}

function fn(source: string, name: string): string {
  const found = new RegExp(`(?:async )?function ${name}[\\s\\S]*?\\n}\\n`).exec(source)?.[0] ?? "";
  assert.ok(found, `${name} exists`);
  return found;
}

describe("the recorded source decides the input, and the builder enforces it", () => {
  it("a markdown run resumes with its plan path; a manifest run with --manifest", () => {
    assert.deepEqual(buildResumePlanArgs({ source: "markdown", planPath: "docs/plans/foo.md", repoRoot: "/r", expectedBranch: "feature/x" }), [
      "resume-plan",
      "docs/plans/foo.md",
      "--repo-root",
      "/r",
      "--expected-branch",
      "feature/x",
    ]);
    assert.deepEqual(buildResumePlanArgs({ source: "manifest", manifest: "/tmp/foo.manifest.json", repoRoot: "/r", expectedBranch: "feature/x" }), [
      "resume-plan",
      "--manifest",
      "/tmp/foo.manifest.json",
      "--repo-root",
      "/r",
      "--expected-branch",
      "feature/x",
    ]);
  });

  it("the exact request the engine refused cannot be built", () => {
    assert.throws(
      () => buildResumePlanArgs({ source: "markdown", manifest: "/tmp/foo.manifest.json", repoRoot: "/r", expectedBranch: "feature/x" }),
      /was started from a markdown plan input; refusing to build a resume from a manifest one/,
    );
  });

  it("and neither can its mirror image", () => {
    assert.throws(
      () => buildResumePlanArgs({ source: "manifest", planPath: "docs/plans/foo.md", repoRoot: "/r", expectedBranch: "feature/x" }),
      /was started from a manifest plan input; refusing to build a resume from a markdown one/,
    );
  });

  it("evidence and push authorization ride along without touching the input", () => {
    assert.deepEqual(buildResumePlanArgs({ source: "markdown", planPath: "docs/plans/foo.md", repoRoot: "/r", expectedBranch: "feature/x", evidence: "I checked it on a device." }), [
      "resume-plan",
      "docs/plans/foo.md",
      "--repo-root",
      "/r",
      "--expected-branch",
      "feature/x",
      "--evidence",
      "I checked it on a device.",
    ]);
    const withPush = buildResumePlanArgs({ source: "markdown", planPath: "docs/plans/foo.md", repoRoot: "/r", expectedBranch: "feature/x", allowPush: { candidateSha: "a".repeat(40) } });
    assert.equal(withPush[1], "docs/plans/foo.md", "still the plan path");
    assert.ok(!withPush.includes("--manifest"));
  });
});

describe("every path that resumes a managed run goes through the one decision", () => {
  it("nothing builds a resume without the recorded source", async () => {
    // Structural, and deliberately so: the guarantee is that no command
    // handler decides this for itself. Every call spreads the result of
    // planInvocationFor, which carries the source the engine recorded.
    const source = await commandsSource();
    const calls = [...source.matchAll(/buildResumePlanArgs\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);
    assert.ok(calls.length >= 3, `expected the resume paths to be present, found ${calls.length}`);
    for (const call of calls) {
      assert.match(call, /\.\.\.input/, `a resume is built from the decided input, not from arguments assembled here: ${call}`);
    }
  });

  it("each of them takes it from planInvocationFor", async () => {
    const source = await commandsSource();
    for (const where of ["askReviewerAgain", "resumePlanCommand", "continueManagedRun", "allowPushCommand"]) {
      const body = fn(source, where);
      assert.match(body, /await planInvocationFor\(controller, run\)/, `${where} asks the one decision`);
    }
  });

  it("continuing automatically cannot start a second run over an existing one", async () => {
    // The route that produced the wrong command: it used to build a manifest
    // regardless and resume with it. It now hands an existing run to
    // continueManagedRun, which cannot build one.
    const perform = fn(await commandsSource(), "performContinueAutomatically");
    assert.match(perform, /if \(managed\) \{/);
    assert.match(perform, /return continueManagedRun\(/, "an existing run is continued");
    assert.match(perform, /return startManagedRun\(/, "only a fresh one is started");
    assert.ok(!/buildManifest\(\{/.test(perform), "and this function interprets nothing itself");
  });

  it("Run plan starts a new plan the way the continuation mode says, and continues an existing one", async () => {
    // There is no second user-facing route that starts the same plan on
    // different terms. In automatic mode Run plan starts the same managed,
    // manifest-driven run Continue automatically starts.
    const body = fn(await commandsSource(), "runPlanCommand");
    assert.match(body, /if \(existing\?\.kind === "plan"\) \{/, "an existing run is continued, not restarted");
    assert.match(body, /await resumePlanCommand\(controller, existing\)/);
    assert.match(body, /if \(planContinuationMode\(\) === "automatic"\)/);
    assert.match(body, /await startManagedRun\(/, "the same managed start as Continue automatically");
    assert.match(body, /buildRunPlanArgs\(\{ planPath,/, "and the Markdown route is what manual mode is for");
  });
});

describe("what the Overview says will run", () => {
  async function managedRun(source?: "markdown" | "manifest") {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0], ...(source ? { source } : {}) });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" });
    return buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: false, brief: false, plan: true, planText: "# Foo plan\n" }, NOW);
  }

  it("a manifest run is offered the manifest command", async () => {
    const model = await managedRun("manifest");
    assert.match(model.continueAutomatically!.detail, /sparring resume-plan --manifest …/);
  });

  it("a markdown run is never offered a command the engine would refuse for it", async () => {
    for (const source of ["markdown", undefined] as const) {
      const model = await managedRun(source);
      assert.ok(!model.continueAutomatically!.detail.includes("--manifest"), `source=${source}`);
      assert.match(model.continueAutomatically!.detail, /sparring resume-plan /);
    }
  });
});
