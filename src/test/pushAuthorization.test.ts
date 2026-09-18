/**
 * Push authorization in the cockpit.
 *
 * The defect these tests exist for: the engine's acceptance gate refused a
 * READY candidate because it was not on the intended remote branch, the
 * reviewer expressed that as a NEEDS_YOU human check ("explicit push
 * authorization is required"), and the Overview rendered it as a manual test
 * with Pass / Fail / Can't test. A person pressed *Pass*. Nothing was pushed
 * and nothing was authorized: the answer went back as reviewer evidence, the
 * reviewer said READY again, and the gate refused the same candidate again.
 *
 * So the rule these hold is about *what kind of thing* the panel is. A typed
 * push request from the engine is a permission question: one sentence, one
 * button, one run-scoped toggle, and no check controls anywhere near it. And
 * the permission is asked for through the engine's own contract — the
 * extension never runs `git push` itself, on any path.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs, buildRunPlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER, PUSH_AUTHORIZATION_REQUIRED, parsePlanRunState } from "../core/engineFormats";
import { isAutoPushMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, sparringMarkdown } from "./fixtures";

const NOW = Date.parse("2026-09-18T10:00:00.000Z");
const CANDIDATE = "f2e455c9a1b2c3d4e5f60718293a4b5c6d7e8f90";
const BRANCH = "feature/add-reference-dialog-redesign";

function awaitingPush(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: PUSH_AUTHORIZATION_REQUIRED,
    stage_id: FOO_STAGE_IDS[0],
    candidate_sha: CANDIDATE,
    branch: BRANCH,
    remote: "origin",
    remote_branch: BRANCH,
    detail: `${CANDIDATE} is not reachable from origin/${BRANCH} (abc1234)`,
    ...overrides,
  };
}

/**
 * A paused managed run whose engine state says it is waiting for permission
 * to push — the reviewer already said READY over that exact commit.
 */
async function pausedForPush(options: { awaiting?: Record<string, unknown> | null | "absent"; pushAuthorization?: Record<string, unknown> | null; artifacts?: Partial<OverviewArtifacts> } = {}) {
  const ws = await Workspace.create();
  await ws.writePlan();
  await ws.writePlanRun(FOO_PLAN_KEY, {
    plan: FOO_PLAN_LABEL,
    status: "paused",
    current_stage_index: 0,
    current_stage: FOO_STAGE_IDS[0],
    expected_branch: BRANCH,
    source: "manifest",
    // "absent" writes no key at all: a run recorded before the engine had one.
    ...(options.awaiting === "absent" ? {} : { awaiting: options.awaiting === undefined ? awaitingPush() : options.awaiting }),
    ...(options.pushAuthorization !== undefined ? { push_authorization: options.pushAuthorization } : {}),
  });
  await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparringMarkdown("READY", "The change is correct and complete.") });
  const artifacts: OverviewArtifacts = {
    handoff: false,
    sparring: true,
    brief: false,
    plan: true,
    planText: "# Foo plan\n",
    git: { branch: BRANCH, head: CANDIDATE },
    ...options.artifacts,
  };
  const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, NOW);
  return { ws, model, html: renderOverviewHtml(model, "n", "c") };
}

// ---------------------------------------------------------------------------
// the engine's typed state
// ---------------------------------------------------------------------------

describe("the engine's push request is read as typed state, never mined from prose", () => {
  it("carries the exact commit, remote and branch", async () => {
    const state = parsePlanRunState(
      JSON.stringify({
        plan: FOO_PLAN_LABEL,
        plan_digest: "0".repeat(64),
        expected_branch: BRANCH,
        current_stage_index: 0,
        current_stage: FOO_STAGE_IDS[0],
        status: "paused",
        source: "manifest",
        awaiting: awaitingPush(),
      }),
    );
    assert.equal(state.awaiting?.kind, PUSH_AUTHORIZATION_REQUIRED);
    assert.equal(state.awaiting?.candidateSha, CANDIDATE);
    assert.equal(state.awaiting?.remote, "origin");
    assert.equal(state.awaiting?.remoteBranch, BRANCH);
    assert.equal(state.awaiting?.stageId, FOO_STAGE_IDS[0]);
  });

  it("a run recorded before push authorization existed has neither field, and that is not an error", () => {
    const state = parsePlanRunState(
      JSON.stringify({ plan: FOO_PLAN_LABEL, plan_digest: "0".repeat(64), expected_branch: BRANCH, current_stage_index: 0, current_stage: FOO_STAGE_IDS[0], status: "paused" }),
    );
    assert.equal(state.awaiting, undefined);
    assert.equal(state.pushAuthorization, undefined);
  });

  it("an unknown pause kind, or one missing what it would be rendered from, is not presented at all", () => {
    const base = { plan: FOO_PLAN_LABEL, plan_digest: "0".repeat(64), expected_branch: BRANCH, current_stage_index: 0, current_stage: FOO_STAGE_IDS[0], status: "paused" };
    for (const awaiting of [
      { kind: "something_newer", stage_id: "s", candidate_sha: CANDIDATE, branch: BRANCH, remote: "origin", remote_branch: BRANCH },
      awaitingPush({ candidate_sha: "" }),
      awaitingPush({ remote_branch: undefined }),
      "not an object",
    ]) {
      assert.equal(parsePlanRunState(JSON.stringify({ ...base, awaiting })).awaiting, undefined, JSON.stringify(awaiting));
    }
  });

  it("a one-candidate permission that names no candidate is not a permission", () => {
    const base = { plan: FOO_PLAN_LABEL, plan_digest: "0".repeat(64), expected_branch: BRANCH, current_stage_index: 0, current_stage: FOO_STAGE_IDS[0], status: "running" };
    const full = { scope: "candidate", repo_root: "/r", branch: BRANCH, remote: "origin", remote_branch: BRANCH, stage_id: "s", candidate_sha: CANDIDATE };
    assert.equal(parsePlanRunState(JSON.stringify({ ...base, push_authorization: full })).pushAuthorization?.scope, "candidate");
    assert.equal(parsePlanRunState(JSON.stringify({ ...base, push_authorization: { ...full, candidate_sha: undefined } })).pushAuthorization, undefined);
    assert.equal(parsePlanRunState(JSON.stringify({ ...base, push_authorization: { ...full, scope: "everything" } })).pushAuthorization, undefined);
  });
});

// ---------------------------------------------------------------------------
// what the panel is, and what it is not
// ---------------------------------------------------------------------------

describe("the push-authorization panel", () => {
  it("names the candidate and where it would go, in plain words", async () => {
    const { model, html } = await pausedForPush();
    const panel = model.pushAuthorization;
    assert.ok(panel, "the panel is built from the engine's typed state");
    assert.equal(panel.headline, "Push authorization required");
    assert.equal(panel.text, `Candidate f2e455c is ready to push to origin/${BRANCH}.`);
    assert.equal(panel.candidateSha, CANDIDATE, "the full commit is carried for the engine contract");
    assert.match(html, /Push authorization required/);
    assert.match(html, new RegExp(`Candidate f2e455c is ready to push to origin/${BRANCH}`));
    assert.match(html, /data-action="allowPush"/);
    assert.match(html, /data-action="doNotAllowPush"/);
    assert.match(html, /data-autopush="run"/);
  });

  it("is not a test: no Pass, no Fail, no Can't test, no submit-for-review", async () => {
    const { model, html } = await pausedForPush();
    assert.equal(model.actionRequired, undefined, "the manual-verification panel is not built for this pause");
    for (const forbidden of ['data-outcome="pass"', 'data-outcome="fail"', 'data-outcome="blocked"', 'data-action="submitForReview"', "Can&#39;t test", "verified"]) {
      assert.ok(!html.includes(forbidden), `the panel must not offer ${forbidden}`);
    }
  });

  it("keeps lifecycle jargon out of the normal layer and in the details", async () => {
    const { model, html } = await pausedForPush();
    const panel = model.pushAuthorization!;
    const normal = [panel.headline, panel.text, panel.allow.label, panel.dismiss.label, panel.autoPush.label].join(" ");
    for (const jargon of ["freeze", "candidate identity", "reachability", "routing", "awaiting"]) {
      assert.ok(!normal.toLowerCase().includes(jargon), `"${jargon}" does not belong in the normal layer`);
    }
    // Demoted, not deleted: the engine's own vocabulary and the exact commit
    // are one disclosure away for whoever needs them.
    const technical = panel.technical.map((row) => `${row.label}: ${row.value}`).join("\n");
    assert.match(technical, new RegExp(`awaiting.kind = ${PUSH_AUTHORIZATION_REQUIRED}`));
    assert.match(technical, new RegExp(CANDIDATE));
    assert.match(html, /Show technical details/);
  });

  it("offers nothing else that would start work, so there is one way forward", async () => {
    const { model } = await pausedForPush();
    assert.equal(model.continueAutomatically, undefined, "resuming would run into the same refusal");
    assert.equal(model.planAction, undefined);
    assert.equal(model.banner, undefined);
  });

  it("the toggle is off by default, and its own message is not an authorization", async () => {
    const { model, html } = await pausedForPush();
    assert.equal(model.pushAuthorization?.autoPush.checked, false);
    assert.ok(!/data-autopush="run" checked/.test(html));
    // The wire: a change to the box says only that the box changed.
    assert.ok(isAutoPushMessage({ type: "autoPush", enabled: true }));
    assert.ok(!isAutoPushMessage({ type: "autoPush" }));
    assert.ok(!isAutoPushMessage({ type: "action", action: "allowPush" }));
  });

  it("shows the toggle as the person left it, so a rerender does not move their choice", async () => {
    const { model, html } = await pausedForPush({ artifacts: { autoPushDraft: true } });
    assert.equal(model.pushAuthorization?.autoPush.checked, true);
    assert.match(html, /data-autopush="run" checked/);
    assert.match(model.pushAuthorization!.allow.detail, /from here on/, "and Allow push says what it will now do");
  });

  it("withholds Allow push on the wrong branch, and says which branch", async () => {
    const { model } = await pausedForPush({ artifacts: { git: { branch: "main", head: CANDIDATE } } });
    assert.ok(model.branchGuard, "the engine would refuse the resume outright");
    assert.equal(model.pushAuthorization?.allow.enabled, false);
    assert.match(model.pushAuthorization!.allow.detail, new RegExp(`Switch to ${BRANCH} first`));
  });

  it("is not built when the run is not waiting for it", async () => {
    // Cleared by the engine when it entered the stage, and absent entirely in
    // a run recorded before any of this existed.
    for (const awaiting of [null, "absent"] as const) {
      const { model } = await pausedForPush({ awaiting });
      assert.equal(model.pushAuthorization, undefined, String(awaiting));
    }
  });

  it("ordinary manual checks are still Pass / Fail / Can't test, untouched", async () => {
    // The same paused run, with a real human gate and no push request: the
    // verification panel is exactly what it was.
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0], expected_branch: BRANCH, source: "manifest" });
    const gate = {
      category: "DEVICE_MANUAL_CHECK",
      title: "One device check blocks this stage",
      checks: [{ id: "android-widget", instruction: "Open the widget on a real device.", pass_criteria: "It renders without a crash.", source: null }],
    };
    const needsYou = [
      "# Sparring: stage 1",
      "",
      "## Routing outcome",
      "",
      "- Action: `NEEDS_YOU`",
      "- Summary: One device check blocks this stage.",
      "- Needs-you reason: DEVICE/MANUAL CHECK -- a real device.",
      "",
      "## NEEDS YOU",
      "",
      HUMAN_GATE_MARKER,
      "",
      "```json",
      JSON.stringify(gate, null, 2),
      "```",
      "",
    ].join("\n");
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": needsYou });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: true, brief: false, plan: true, planText: "# Foo plan\n", git: { branch: BRANCH, head: CANDIDATE } }, NOW);
    assert.equal(model.pushAuthorization, undefined);
    assert.equal(model.actionRequired?.required.length, 1);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /data-outcome="pass"/);
    assert.match(html, /data-action="submitForReview"/);
  });
});

// ---------------------------------------------------------------------------
// the run-scoped choice, after a reload
// ---------------------------------------------------------------------------

describe("auto-push for a run is engine state, not this window's memory", () => {
  it("a reload reflects the permission the engine recorded", async () => {
    const { model, html } = await pausedForPush({
      awaiting: null,
      pushAuthorization: { scope: "run", repo_root: "/r", branch: BRANCH, remote: "origin", remote_branch: BRANCH },
    });
    assert.equal(model.autoPushEnabled?.label, "Auto-push is on for this run");
    assert.match(model.autoPushEnabled!.detail, new RegExp(`pushed to origin/${BRANCH} without asking`));
    assert.match(html, /Auto-push is on for this run/);
  });

  it("a one-candidate permission is not auto-push, and is not presented as it", async () => {
    const { model } = await pausedForPush({
      awaiting: null,
      pushAuthorization: { scope: "candidate", repo_root: "/r", branch: BRANCH, remote: "origin", remote_branch: BRANCH, stage_id: FOO_STAGE_IDS[0], candidate_sha: CANDIDATE },
    });
    assert.equal(model.autoPushEnabled, undefined);
  });

  it("nothing in this window's own state can turn it on", async () => {
    // The draft toggle is an intention. With no permission recorded by the
    // engine, the Overview claims none — however the checkbox is left.
    const { model } = await pausedForPush({ artifacts: { autoPushDraft: true } });
    assert.equal(model.autoPushEnabled, undefined);
  });
});

// ---------------------------------------------------------------------------
// the engine contract, and the line the extension does not cross
// ---------------------------------------------------------------------------

describe("what the extension asks the engine for", () => {
  it("Allow push without the toggle authorizes exactly the candidate on screen", () => {
    assert.deepEqual(
      buildResumePlanArgs({ source: "manifest", manifest: "/tmp/m.json", repoRoot: "/r", expectedBranch: BRANCH, allowPush: { candidateSha: CANDIDATE } }),
      ["resume-plan", "--manifest", "/tmp/m.json", "--repo-root", "/r", "--expected-branch", BRANCH, "--allow-push-candidate", CANDIDATE],
    );
  });

  it("Allow push with the toggle also authorizes the run's later candidates", () => {
    assert.deepEqual(
      buildResumePlanArgs({ source: "manifest", manifest: "/tmp/m.json", repoRoot: "/r", expectedBranch: BRANCH, allowPush: { candidateSha: CANDIDATE, forRun: true } }),
      ["resume-plan", "--manifest", "/tmp/m.json", "--repo-root", "/r", "--expected-branch", BRANCH, "--allow-push-candidate", CANDIDATE, "--allow-push-for-run"],
    );
  });

  it("a new managed run can be started with the run-scoped permission", () => {
    assert.deepEqual(
      buildRunPlanArgs({ manifest: "/tmp/m.json", repoRoot: "/r", expectedBranch: BRANCH, allowPushForRun: true }),
      ["run-plan", "--manifest", "/tmp/m.json", "--repo-root", "/r", "--expected-branch", BRANCH, "--allow-push-for-run"],
    );
    assert.ok(!buildRunPlanArgs({ manifest: "/tmp/m.json", repoRoot: "/r", expectedBranch: BRANCH }).includes("--allow-push-for-run"), "off by default");
  });

  it("the candidate is taken from what was rendered, and the engine is asked to check it", async () => {
    // Both halves of "a stale panel cannot authorize a newer candidate": the
    // extension sends the commit it displayed, and it sends it as
    // --allow-push-candidate, which the engine refuses unless the run is
    // waiting for that exact commit.
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function allowPushCommand[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.ok(body, "allowPushCommand exists");
    assert.match(body, /const model = await overview\.buildModel\(\)/, "the panel that was shown is what is acted on");
    assert.match(body, /allowPush: \{ candidateSha: panel\.candidateSha, forRun \}/, "its own candidate, never a fresh lookup");
    assert.ok(!/run\.state\.awaiting/.test(body), "not re-read when the click arrives");
  });

  it("the extension never runs git push, on any path", async () => {
    // The engine owns the push, because the engine owns acceptance. Nothing
    // in the extension may shell out to git for it -- not here, and not in
    // the one place that is allowed to run git at all (read-only diffs).
    const dir = path.join(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = async (at: string) => {
      for (const entry of await fs.readdir(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".ts") && !full.includes(`${path.sep}test${path.sep}`)) {
          files.push(full);
        }
      }
    };
    await walk(dir);
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      for (const line of text.split("\n")) {
        // A mention in prose is fine and is how the panel explains itself;
        // an invocation is not. Only executable shapes are refused.
        assert.ok(!/(push)\s*\(\s*["'`]?git["'`]?/.test(line), `${file}: ${line}`);
        assert.ok(!/\b(execFile|exec|spawn|spawnSync|execSync|execFileSync)\s*\(\s*["'`]git["'`]\s*,\s*\[\s*["'`]push/.test(line), `${file}: ${line}`);
        assert.ok(!/["'`]git push/.test(line.replace(/\/\/.*/, "").replace(/\*.*/, "")), `${file}: ${line}`);
      }
    }
  });
});
