import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRunSparringArgs } from "../core/cli";
import { discoverRuns, locateSparringDirs, selectRun } from "../core/discovery";
import { parseHandoffBranch } from "../core/engineFormats";
import { appendHumanEvidence, checkKey, insertHandoffEvidence, parseHumanEvidence, renderHumanEvidence, submittableChecks } from "../core/humanChecks";
import type { ExecutionRecord } from "../core/liveness";
import { foldEvents } from "../core/liveState";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { parseSparringCommand } from "../core/sparringCommand";
import { Workspace, event, normalUi } from "./fixtures";

const NOW = Date.parse("2026-09-14T10:00:00.000Z");
const STAGE_ID = "stage-3c-cloud-schema-rpc-and-sync-transport";
const BRANCH = "feature/reported-statistics-contract";

const PLAN = ["# Reported statistics", "", "## Stage 3C — Cloud schema/RPC and sync transport", "", "### Verification expectations", "", "- Human-gated under AGENTS.md: live cloud/CAS/cross-client behaviour. Do not claim it without the branch owner's evidence.", "", "## Stage 3D — Next", ""].join("\n");

function sparring(deferred: string, action = "NEEDS_YOU"): string {
  return ["# Sparring: x", "", "## Routing outcome", "", `- Action: \`${action}\``, "- Summary: Deployment and live compatibility checks remain required.", "- Needs-you reason: EXTERNAL CONDITION -- deploy the cloud migration", "", "## Deferred", "", deferred, ""].join("\n");
}

const DEFERRED = "Human-gated checks remain: apply/deploy migration 20260913120000; exercise live enhanced push, pull and CAS retry.";
const DEPLOY = "Apply/deploy migration 20260913120000";
const LIVE = "Exercise live enhanced push, pull and CAS retry";

const HANDOFF = ["# Handoff: x", "", "## Claims", "", "Implemented.", "", "## Git context", "", `- Branch: \`${BRANCH}\``, "- Base commit: `dddddddd`", "- Candidate commit: `cccccccc`", "", "## Test / build evidence", "", "(not recorded)", "", "## Human evidence", "", "2026-09-13 (branch owner): migration list reviewed.", "", "## Previous unresolved sparring findings", "", "(none)", ""].join("\n");

/** A standalone NEEDS_YOU stage with the plan, the handoff and optional notes/drafts/branch. */
async function stage(options: { drafts?: OverviewArtifacts["humanChecks"]; notes?: string; deferred?: string; action?: string; branch?: string | null; handoff?: string | false; execution?: ExecutionRecord; live?: Parameters<typeof buildOverviewModel>[1] } = {}) {
  const ws = await Workspace.create();
  await ws.writeStage(STAGE_ID, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar", base_sha: "d".repeat(40) }, { "sparring.md": sparring(options.deferred ?? DEFERRED, options.action) });
  const planPath = path.join(ws.root, "docs", "plan.md");
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, PLAN);
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const handoffText = options.handoff === false ? undefined : (options.handoff ?? HANDOFF);
  const artifacts: OverviewArtifacts = {
    handoff: handoffText !== undefined,
    handoffText,
    sparring: true,
    brief: false,
    plan: false,
    git: options.branch === null ? {} : { branch: options.branch ?? BRANCH, head: "cccccccc" },
    associatedPlan: { path: planPath, exists: true, text: PLAN },
    humanChecks: options.drafts ?? {},
    notesText: options.notes,
  };
  return { ws, model: buildOverviewModel(selection, options.live, artifacts, NOW, options.execution) };
}

const BOTH_DRAFTED = { [checkKey(DEPLOY)]: { outcome: "pass" as const, note: "Applied and listed." }, [checkKey(LIVE)]: { outcome: "pass" as const } };

describe("run-sparring is the review invocation", () => {
  it("mirrors cli.py: run-sparring <stage_id> --repo-root ROOT --expected-branch BRANCH, unquoted", async () => {
    const parent = await Workspace.create({ sparring: false, name: "sporely" });
    const nested = await Workspace.createNested(parent.root, "sporely-py-reported-statistics");
    await nested.writeStage(STAGE_ID, { status: "working" });
    const locations = await locateSparringDirs(parent.root, "sporely");
    const run = selectRun((await discoverRuns(locations)).runs).selected!;
    const args = buildRunSparringArgs({ stageId: STAGE_ID, repoRoot: run.location.repoRoot, expectedBranch: BRANCH, sparringDir: run.location.sparringDir });
    assert.deepEqual(args, ["run-sparring", STAGE_ID, "--repo-root", nested.root, "--expected-branch", BRANCH]);
    assert.equal(args[args.indexOf("--repo-root") + 1], nested.root, "the nested project, not the workspace folder");
    assert.deepEqual(buildRunSparringArgs({ stageId: "s", repoRoot: "/code/app", expectedBranch: "main", sparringDir: "/code/meta/.sparring" }), ["--sparring-dir", "/code/meta/.sparring", "run-sparring", "s", "--repo-root", "/code/app", "--expected-branch", "main"]);
  });

  it("a run-sparring typed in a terminal is recognised and attached to the stage", () => {
    const parsed = parseSparringCommand(`sparring run-sparring ${STAGE_ID} --repo-root /code/app --expected-branch ${BRANCH}`);
    assert.deepEqual(parsed, { subcommand: "run-sparring", stageId: STAGE_ID, sparringDir: undefined, repoRoot: "/code/app", expectedBranch: BRANCH });
  });

  it("the submit path runs the reviewer, never the stage agent, with the configured executable and the run's own repository", async () => {
    const commands = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const submit = /async function submitForReviewCommand[\s\S]*?\n}\n/.exec(commands)?.[0] ?? "";
    assert.ok(submit, "submitForReviewCommand exists");
    assert.match(submit, /buildRunSparringArgs\(\{ stageId: run\.stage\.stageId, repoRoot: run\.location\.repoRoot, expectedBranch, sparringDir: run\.location\.sparringDir \}\)/);
    assert.ok(!/buildRunLoopArgs|launchStageLoop/.test(submit), "submitting evidence never starts the stage agent");
    assert.match(submit, /configured: configuredExecutable\(\)/, "the shared agentSparring.executable setting");
    assert.match(submit, /cwd: run\.location\.repoRoot/);
    assert.match(submit, /kind: "run-sparring"/, "the execution is tracked as a review, so a failure is reported as one");
    assert.match(submit, /const expectedBranch = await currentBranch\(run\.location\.repoRoot\)/, "the branch comes from the run's own repository");
    assert.match(submit, /if \(model\.branchGuard\)/, "the wrong branch refuses before anything is written");
    assert.match(submit, /buildResumePlanArgs\(\{[^}]*evidence: entry/, "a managed plan run keeps the engine's own resume-plan --evidence");
    assert.ok(!/acceptStage|freeze/.test(submit), "submitting evidence never freezes or accepts");
  });
});

describe("NEEDS_YOU → evidence ready transition", () => {
  it("incomplete evidence keeps Needs you and offers no enabled Submit for review", async () => {
    const { model } = await stage({ drafts: { [checkKey(DEPLOY)]: { outcome: "pass" } } });
    const panel = model.actionRequired!;
    assert.equal(panel.ready, false);
    assert.equal(panel.headline, "Action required");
    assert.equal(panel.subtitle, undefined);
    assert.equal(model.status?.label, "Needs you");
    assert.equal(panel.submit.enabled, false);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /data-action="submitForReview" title="[^"]*" disabled>Submit for review</);
    assert.ok(!html.includes("Evidence ready"), "nothing claims the evidence is complete");
    assert.equal((normalUi(html).match(/Needs you/g) ?? []).length, 1);
  });

  it("every requested check answered → Evidence ready for review, one primary Submit for review", async () => {
    const { model } = await stage({ drafts: BOTH_DRAFTED });
    const panel = model.actionRequired!;
    assert.equal(panel.ready, true);
    assert.equal(panel.headline, "Evidence ready for review");
    assert.equal(panel.subtitle, "All requested checks have evidence. Send it back to the independent reviewer.");
    assert.equal(panel.progress, "2 / 2 verified");
    assert.equal(model.status?.label, "Evidence ready", "the header badge stops saying Needs you");
    assert.equal(panel.submit.enabled, true);
    assert.match(panel.submit.detail, new RegExp(`sparring run-sparring ${STAGE_ID}: the recorded sparring session reads the evidence and rules again\\. The stage agent is not started\\.`));
    assert.match(panel.submit.detail, /nothing is marked ready or accepted here/);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<section class="card action needs_you ready">/);
    assert.match(html, /<h2><svg class="icon ready"[^>]*>.*?<\/svg>Evidence ready for review<\/h2><p class="summary">All requested checks have evidence\. Send it back to the independent reviewer\.<\/p>/);
    assert.match(html, /<button type="button" class="primary" data-action="submitForReview" title="[^"]*">Submit for review<\/button>/);
    assert.equal((html.match(/class="primary"/g) ?? []).length, 1, "one obvious primary button");
    assert.match(html, /class="quiet" data-action="runStage"[^>]*>Resume stage \(implementation\)</, "resuming implementation stays separate and quiet");
    assert.ok(!normalUi(html).includes("Needs you"));
  });

  it("evidence recorded in notes.md counts the same as a draft", async () => {
    const entry = renderHumanEvidence(
      [
        { text: DEPLOY, origin: "reviewer", record: { outcome: "pass" } },
        { text: LIVE, origin: "reviewer", record: { outcome: "blocked", note: "No second client available." } },
      ],
      new Date(NOW),
    )!;
    const { model } = await stage({ notes: appendHumanEvidence("# Notes: x\n", entry) });
    const panel = model.actionRequired!;
    assert.equal(panel.required.length, 0);
    assert.equal(panel.ready, true, "nothing is outstanding, so the evidence is ready to go back");
    assert.equal(panel.headline, "Evidence ready for review");
    assert.deepEqual(submittableChecks(panel), [], "already-recorded results are not written a second time");
  });

  it("a reviewer that asks for something new after the last submission goes back to Needs you", async () => {
    const entry = renderHumanEvidence([{ text: DEPLOY, origin: "reviewer", record: { outcome: "pass" } }], new Date(NOW))!;
    const { model } = await stage({
      notes: appendHumanEvidence("# Notes: x\n", entry),
      deferred: `${DEPLOY}. Also confirm PostgREST JSONB reads render the details object.`,
    });
    const panel = model.actionRequired!;
    assert.deepEqual(
      panel.recorded.map((item) => item.text),
      [DEPLOY],
    );
    assert.deepEqual(
      panel.required.map((item) => item.text),
      ["Confirm PostgREST JSONB reads render the details object"],
    );
    assert.equal(panel.ready, false);
    assert.equal(model.status?.label, "Needs you");
  });
});

describe("what the reviewer answers next", () => {
  it("READY → Review complete with Accept stage, and no action-required panel", async () => {
    const { model } = await stage({ action: "READY", drafts: BOTH_DRAFTED });
    assert.equal(model.actionRequired, undefined);
    assert.equal(model.stageStatus, "Review complete");
    assert.deepEqual(model.stageAction, { kind: "accept", label: "Accept stage", primary: true });
    assert.match(renderOverviewHtml(model, "n", "c"), /data-action="acceptStage"/);
  });

  it("SEND_BACK → back to the implementation loop: no panel, Resume stage is the primary action", async () => {
    const { model } = await stage({ action: "SEND_BACK" });
    assert.equal(model.actionRequired, undefined);
    assert.equal(model.stageStatus, "Changes requested");
    assert.deepEqual(model.stageAction, { kind: "resume", label: "Resume stage", primary: true });
  });

  it("ESCALATE → the panel presents the escalation, never an evidence-ready headline", async () => {
    const { model } = await stage({ action: "ESCALATE", drafts: BOTH_DRAFTED });
    assert.equal(model.actionRequired?.kind, "escalate");
    assert.equal(model.actionRequired?.headline, "Action required");
    assert.equal(model.status?.label, "Escalated");
  });

  it("a review run that fails is reported as a failed review, not as an interrupted stage", async () => {
    const execution: ExecutionRecord = { id: "e1", runId: "unused", kind: "run-sparring", source: "launched", state: "ended", startedAtMs: NOW - 60_000, endedAtMs: NOW - 1_000, exitCode: 1 };
    const live = foldEvents([event("sparrer", "sparring.started", { provider: "codex-cli" })]);
    const { ws } = await stage();
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const model = buildOverviewModel(selection, live, { handoff: true, handoffText: HANDOFF, sparring: true, brief: false, plan: false, git: { branch: BRANCH }, humanChecks: {} }, NOW, { ...execution, runId: selection.selected!.id });
    assert.match(model.actionRequired?.reviewFailure ?? "", /^The last review run exited with code 1\. The stage and its candidate are unchanged/);
    assert.equal(model.stageLine, "The independent review did not finish. The stage and its candidate are unchanged.");
    assert.equal(model.activity?.text, "Stopped · independent review did not finish");
    assert.ok(!/last run was interrupted/.test(JSON.stringify(model)), "nothing says the stage agent was interrupted");
    assert.match(renderOverviewHtml(model, "n", "c"), /<p class="failure">.*?The last review run exited with code 1/);
  });
});

describe("the evidence the reviewer actually reads", () => {
  it("goes into handoff.md's own ## Human evidence section, not after the sections that follow it", () => {
    const entry = renderHumanEvidence([{ text: LIVE, origin: "reviewer", record: { outcome: "pass", note: "Both clients agree." } }], new Date(NOW))!;
    const updated = insertHandoffEvidence(HANDOFF, entry);
    const lines = updated.split("\n");
    const evidenceAt = lines.indexOf("## Human evidence");
    const nextSectionAt = lines.indexOf("## Previous unresolved sparring findings");
    const entryAt = lines.findIndex((line) => line.startsWith(`- Pass — ${LIVE}`));
    assert.ok(evidenceAt < entryAt && entryAt < nextSectionAt, "the entry sits inside the section the reviewer reads");
    assert.ok(updated.includes("2026-09-13 (branch owner): migration list reviewed."), "the earlier evidence is kept");
    assert.equal(updated.split("## Human evidence").length, 2, "the heading is not duplicated");
    assert.equal(parseHandoffBranch(updated), BRANCH, "the git context is untouched");
    assert.deepEqual(HANDOFF, HANDOFF);
  });

  it("creates the section when the handoff has none, and reads back as recorded evidence", () => {
    const entry = renderHumanEvidence([{ text: LIVE, origin: "reviewer", record: { outcome: "pass" } }], new Date(NOW))!;
    const updated = insertHandoffEvidence("# Handoff: x\n\n## Claims\n\nDone.\n", entry);
    assert.equal(updated, `# Handoff: x\n\n## Claims\n\nDone.\n\n## Human evidence\n\n${entry.trim()}\n`);
    assert.equal(parseHumanEvidence(updated)[1].checkText, LIVE);
  });
});

describe("wrong branch", () => {
  it("a standalone stage: the handoff's recorded branch against the checked-out one", async () => {
    const { model } = await stage({ branch: "main", drafts: BOTH_DRAFTED });
    assert.deepEqual(
      { expected: model.branchGuard?.expected, actual: model.branchGuard?.actual, source: model.branchGuard?.source },
      { expected: BRANCH, actual: "main", source: "handoff" },
    );
    assert.equal(model.stageAction, undefined, "nothing that runs the engine is offered");
    assert.equal(model.secondaryAction, undefined);
    assert.equal(model.actionRequired?.resume, undefined);
    assert.equal(model.actionRequired?.submit.enabled, false);
    assert.equal(model.actionRequired?.submit.detail, `Switch to ${BRANCH} first; the engine refuses to review a candidate from another branch.`);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, new RegExp(`<section class="card branchguard">\\s*<h2><svg[^>]*>.*?</svg>Wrong branch</h2>\\s*<p>This stage belongs to <span class="branch">${BRANCH.replace("/", "\\/")}</span>\\. The repository is on <span class="branch">main</span>\\.</p>`));
    assert.match(html, /<p class="muted small">Switch branches before resuming\. This stage&#39;s last recorded handoff was generated on that branch/);
    assert.match(html, /<span class="hpill bad"[^>]*>.*?Wrong branch<\/span>/);
    assert.ok(html.indexOf('class="card branchguard"') < html.indexOf('class="card action'), "the warning comes first");
    assert.ok(!/data-action="runStage"(?![^>]*disabled)/.test(html.replace(/class="quiet" data-action="runStage"[^>]*>/g, "")), "no enabled run action");
    assert.match(html, /data-action="submitForReview" title="[^"]*" disabled/);
  });

  it("an accepted stage gets no branch warning: nothing runs, and its branch may have been merged away", async () => {
    const ws = await Workspace.create();
    await ws.writeStage(STAGE_ID, { status: "accepted", candidate_sha: "c".repeat(40) }, { "sparring.md": sparring(DEFERRED, "READY") });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: true, handoffText: HANDOFF, sparring: true, brief: false, plan: false, git: { branch: "main" } }, NOW);
    assert.equal(model.branchGuard, undefined);
    assert.equal(model.stageStatus, "Accepted");
  });

  it("a detached HEAD says so rather than naming a branch", async () => {
    const { model } = await stage({ branch: null });
    assert.equal(model.branchGuard?.actual, undefined);
    assert.match(renderOverviewHtml(model, "n", "c"), /No branch is checked out \(detached HEAD\)\./);
  });

  it("no warning when the branches agree, when the handoff records none, or when the repository was not read", async () => {
    assert.equal((await stage()).model.branchGuard, undefined);
    assert.equal((await stage({ handoff: "# Handoff: x\n\n## Claims\n\nDone.\n", branch: "main" })).model.branchGuard, undefined, "nothing recorded, so nothing claimed");
    assert.equal((await stage({ handoff: false, branch: "main" })).model.branchGuard, undefined);
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" }, { "sparring.md": sparring(DEFERRED) });
    const noGit = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: true, handoffText: HANDOFF, sparring: true, brief: false, plan: false }, NOW);
    assert.equal(noGit.branchGuard, undefined, "no git context was read: no claim either way");
  });

  it("a managed plan run uses the engine's own expected_branch", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    const { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS } = await import("./fixtures");
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0], expected_branch: "feature/x" });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" }, { "sparring.md": sparring(DEFERRED) });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const model = buildOverviewModel(selection, undefined, { handoff: false, sparring: true, brief: false, plan: true, git: { branch: "main" } }, NOW);
    assert.deepEqual(
      { expected: model.branchGuard?.expected, actual: model.branchGuard?.actual, source: model.branchGuard?.source },
      { expected: "feature/x", actual: "main", source: "plan-run" },
    );
    assert.equal(model.planAction, undefined, "Resume plan is not offered from the wrong branch");
    assert.match(model.branchGuard?.detail ?? "", /the engine refuses any other/);
  });
});
