/**
 * Run Plan through `sparring start-plan`: the engine's `--json` status read
 * as the engine wrote it, turned into the Run Plan screen, and the one
 * command rerun with the person's answers or `--confirm <token>`.
 *
 * The ready/refused payloads are the live engine's own output for a two-stage
 * `## Stage <n>` plan (paths shortened); the intake-route ones follow the
 * shape in agent-sparring docs/intake.md.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseExecutionManifest } from "../core/manifest";
import { parseIntakeEnvelope, parseIntakeRecord } from "../core/intake";
import { isStartPlanMessage, renderOverviewHtml } from "../core/overviewHtml";
import { START_PLAN_PROVIDER_TURN_NOTICE, startPlanView, timelineGroups, type StartPlanSession, type TimelineItem } from "../core/overviewModel";
import { buildStartPlanArgs, parseStartPlanStatus, startPlanSupportFrom } from "../core/startPlan";

const EXECUTION = { sparring_dir: "/repo/.sparring", permission_mode: "acceptEdits", claude_executable: "claude", codex_executable: "codex", max_send_back_cycles: 5 };

function payload(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    schema_version: 1,
    status: "refused",
    route: null,
    plan: { path: "/repo/plan.md", label: "plan.md" },
    expected_branch: "feature/x",
    execution: EXECUTION,
    intake: null,
    slice: null,
    later_slices: [],
    decisions: [],
    findings: [],
    confirm_token: null,
    error: null,
    ...overrides,
  });
}

const DIRECT_READY = payload({
  status: "ready",
  route: "direct",
  slice: {
    run_id: null,
    run_key: null,
    manifest_version: null,
    stages: [
      { stage_id: null, label: "Stage 1", title: "Contract", mode: "implementation", plan_stage_label: "1", gates_before: [] },
      { stage_id: null, label: "Stage 2", title: "Wire", mode: "implementation", plan_stage_label: "2", gates_before: [] },
    ],
    completion_gates: [],
  },
  confirm_token: "0efa5b67b729d9d25a04075661364a63b1b9af4d99d5a6d8afc442654009a87c",
});

const GATE = { id: "device-check", title: "Check on a device", kind: "manual", reason: "Only a person can see it." };

const INTAKE = { id: "20261006-plan-abc", directory: "/repo/.sparring/intake/20261006-plan-abc", report: "/repo/.sparring/intake/20261006-plan-abc/report.md", mode: "compile", reused: false, answers: { scope: "narrow" } };

const INTAKE_READY = payload({
  status: "ready",
  route: "intake",
  intake: INTAKE,
  slice: {
    run_id: "web",
    run_key: "plan-1a2b3c4d",
    manifest_version: 2,
    stages: [
      { stage_id: "plan-1a2b3c4d-s1", label: "Stage 1", title: "Schema", mode: "implementation", plan_stage_label: "3", gates_before: [] },
      { stage_id: "plan-1a2b3c4d-s2", label: "Stage 2", title: "Review", mode: "independent_review", plan_stage_label: "3", gates_before: [GATE] },
    ],
    completion_gates: [{ ...GATE, id: "release-check", title: "Release check" }],
  },
  later_slices: [{ run_id: "py", primary_repository: "sporely-py", stages: ["Stage 3"] }],
  findings: [{ code: "W1", severity: "recommendation", disposition: "noted", origin: "compile", message: "Consider splitting.", stages: ["3"] }],
  confirm_token: "f".repeat(64),
});

const NEEDS_DECISION = payload({
  status: "needs_decision",
  route: "intake",
  intake: INTAKE,
  decisions: [
    {
      id: "split",
      question: "Split stage 3?",
      why: "It touches two repositories.",
      options: [
        { id: "yes", label: "Split it", consequence: "Two runs." },
        { id: "no", label: "Keep it", consequence: "One run." },
      ],
      stages: ["3"],
      finding: "D1",
    },
  ],
  findings: [{ code: "D1", severity: "blocking", disposition: "needs_decision", origin: "compile", message: "Ambiguous scope.", stages: ["3"] }],
});

const REFUSED = payload({ error: "--answer: this plan runs directly, and asks no decisions" });

function session(status: string | undefined, overrides: Partial<StartPlanSession> = {}): StartPlanSession {
  return {
    planName: "plan.md",
    planLabel: "plan.md",
    planPath: "/repo/plan.md",
    expectedBranch: "feature/x",
    phase: "shown",
    answers: {},
    ...(status ? { status: parseStartPlanStatus(status) } : {}),
    ...overrides,
  };
}

describe("start-plan --json status", () => {
  it("reads the engine's ready status for a direct route", () => {
    const status = parseStartPlanStatus(DIRECT_READY)!;
    assert.equal(status.status, "ready");
    assert.equal(status.route, "direct");
    assert.equal(status.slice?.runKey, null);
    assert.deepEqual(
      status.slice?.stages.map((stage) => [stage.label, stage.planStageLabel]),
      [
        ["Stage 1", "1"],
        ["Stage 2", "2"],
      ],
    );
    assert.equal(status.confirmToken, "0efa5b67b729d9d25a04075661364a63b1b9af4d99d5a6d8afc442654009a87c");
    assert.equal(status.execution?.["permission_mode"], "acceptEdits");
  });

  it("reads gates, later slices, findings and the intake", () => {
    const status = parseStartPlanStatus(INTAKE_READY)!;
    assert.equal(status.intake?.report, INTAKE.report);
    assert.deepEqual(status.intake?.answers, { scope: "narrow" });
    assert.deepEqual(status.slice?.stages[1].gatesBefore, [GATE]);
    assert.equal(status.slice?.completionGates[0].id, "release-check");
    assert.equal(status.laterSlices[0].primaryRepository, "sporely-py");
    assert.equal(status.findings[0].code, "W1");
  });

  it("never carries a token outside ready, and keeps a refusal verbatim", () => {
    const refused = parseStartPlanStatus(payload({ error: "nope", confirm_token: "a".repeat(64) }))!;
    assert.equal(refused.confirmToken, undefined);
    assert.equal(parseStartPlanStatus(REFUSED)!.error, "--answer: this plan runs directly, and asks no decisions");
    assert.equal(parseStartPlanStatus(NEEDS_DECISION)!.confirmToken, undefined);
  });

  it("reads nothing it does not know as a status", () => {
    assert.equal(parseStartPlanStatus("start-plan refused: boom"), undefined);
    assert.equal(parseStartPlanStatus(payload({ schema_version: 2 })), undefined);
    assert.equal(parseStartPlanStatus(payload({ status: "running" })), undefined);
  });
});

describe("start-plan command", () => {
  const base = { planPath: "/repo/plan.md", repoRoot: "/repo", expectedBranch: "feature/x", sparringDir: "/repo/.sparring" };

  it("evaluates with --json and the person's answers", () => {
    assert.deepEqual(buildStartPlanArgs({ ...base, answers: { b: "2", a: "1" }, json: true }), [
      "start-plan",
      "/repo/plan.md",
      "--repo-root",
      "/repo",
      "--expected-branch",
      "feature/x",
      "--answer",
      "a=1",
      "--answer",
      "b=2",
      "--json",
    ]);
  });

  it("confirms with the same inputs plus --confirm, never --json", () => {
    const args = buildStartPlanArgs({ ...base, sparringDir: "/elsewhere/.sparring", answers: { a: "1" }, confirm: "t0k", allowPushForRun: true });
    assert.deepEqual(args, ["--sparring-dir", "/elsewhere/.sparring", "start-plan", "/repo/plan.md", "--repo-root", "/repo", "--expected-branch", "feature/x", "--answer", "a=1", "--confirm", "t0k", "--allow-push-for-run"]);
    assert.ok(!args.includes("--json"));
  });
});

describe("start-plan capability", () => {
  it("is supported only when the engine's help lists start-plan --confirm", () => {
    assert.equal(startPlanSupportFrom("usage: sparring start-plan [-h] [--json] [--answer DECISION=OPTION] [--confirm TOKEN]", false), "supported");
  });

  it("is missing when the engine rejects the subcommand, so Run Plan keeps the manifest path", () => {
    assert.equal(startPlanSupportFrom("sparring: error: argument command: invalid choice: 'start-plan' (choose from 'run-plan', 'resume-plan')", true), "missing");
  });

  it("is unknown when nothing ran", () => {
    assert.equal(startPlanSupportFrom("", true), "unknown");
    assert.equal(startPlanSupportFrom("Traceback (most recent call last): …", true), "unknown");
  });

  it("Run Plan asks for start-plan before building a manifest", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = source.slice(source.indexOf("async function runPlanCommand("), source.indexOf("// ---------------------------------------------------------------- Run Plan through start-plan"));
    const probe = body.indexOf("startPlanSupport(");
    assert.ok(probe > 0, "Run Plan probes the engine for start-plan");
    assert.ok(probe < body.indexOf("startManagedRun("), "the manifest path is only the fallback");
    assert.match(body, /=== "supported"/, "only a supported engine takes the start-plan route");
  });
});

describe("Run Plan screen (start-plan → view model)", () => {
  it("says a preparation may spend a provider turn, while preparing and after", () => {
    const preparing = startPlanView(session(undefined, { phase: "preparing" }));
    assert.equal(preparing.preparing, true);
    assert.equal(preparing.providerTurnNotice, START_PLAN_PROVIDER_TURN_NOTICE);
    assert.match(preparing.providerTurnNotice, /read-only provider turn/);
    assert.equal(preparing.start, undefined);
    assert.equal(startPlanView(session(INTAKE_READY)).providerTurnNotice, START_PLAN_PROVIDER_TURN_NOTICE);
  });

  it("poses the engine's decisions and options, choosing none of them", () => {
    const view = startPlanView(session(NEEDS_DECISION));
    assert.equal(view.stateLabel, "Needs your decisions");
    assert.equal(view.canAnswer, true);
    assert.deepEqual(view.decisions[0].options.map((option) => option.id), ["yes", "no"]);
    assert.equal(view.decisions[0].question, "Split stage 3?");
    assert.equal(view.start, undefined, "no Start until the engine says ready");
    assert.equal(view.intake?.report, INTAKE.report);
    assert.equal(view.findings[0].code, "D1");
    const html = renderOverviewHtml({ kind: "startPlan", title: "plan.md", startPlan: view }, "n", "vscode-resource:");
    assert.match(html, /type="radio" name="decision-split" value="yes">/);
    assert.ok(!/checked/.test(html.slice(html.indexOf("<fieldset"), html.indexOf("</fieldset>"))), "no option is preselected");
  });

  it("summarizes what will run, with gates, and offers one Start carrying the engine's token", () => {
    const view = startPlanView(session(INTAKE_READY, { models: [{ role: "stage", text: "Claude · claude-opus-5-5 · high" }] }));
    assert.equal(view.stateLabel, "Ready to start");
    assert.ok(view.summary!.lines.includes("stage: Claude · claude-opus-5-5 · high"));
    assert.ok(view.summary!.lines.includes("Permission mode: acceptEdits"));
    assert.ok(view.summary!.lines.some((line) => line.startsWith("Executables: claude claude, codex codex")));
    assert.ok(view.summary!.lines.some((line) => line.startsWith("Push:")));
    assert.deepEqual(view.summary!.stages[1].gatesBefore, ["manual gate device-check: Check on a device — Only a person can see it."]);
    assert.equal(view.summary!.stages[1].mode, "independent_review");
    assert.equal(view.summary!.completionGates.length, 1);
    assert.equal(view.summary!.laterSlices.length, 1);
    assert.equal(view.start?.token, "f".repeat(64));
    const html = renderOverviewHtml({ kind: "startPlan", title: "plan.md", startPlan: view }, "n", "vscode-resource:");
    assert.equal(html.match(/data-startplan="start"/g)?.length, 1);
    assert.match(html, new RegExp(`data-token="${"f".repeat(64)}"`));
    assert.match(html, /Pause for manual gate device-check/);
  });

  it("shows a refusal exactly as the engine reported it, with nothing to start", () => {
    const view = startPlanView(session(REFUSED));
    assert.equal(view.refusal, "--answer: this plan runs directly, and asks no decisions");
    assert.equal(view.start, undefined);
    const html = renderOverviewHtml({ kind: "startPlan", title: "plan.md", startPlan: view }, "n", "vscode-resource:");
    assert.match(html, /--answer: this plan runs directly, and asks no decisions/);
  });

  it("shows output that is not a status verbatim, as no state", () => {
    const view = startPlanView(session(undefined, { failure: "Traceback: boom" }));
    assert.equal(view.failure, "Traceback: boom");
    assert.equal(view.stateLabel, "No answer from the engine");
    assert.equal(view.start, undefined);
  });

  it("never offers a token twice: once started, Start is gone", () => {
    assert.equal(startPlanView(session(DIRECT_READY, { phase: "started" })).start, undefined);
  });

  it("guards the webview's messages", () => {
    assert.ok(isStartPlanMessage({ type: "startPlan", action: "start", token: "abc" }));
    assert.ok(!isStartPlanMessage({ type: "startPlan", action: "start" }));
    assert.ok(isStartPlanMessage({ type: "startPlan", action: "answer", answers: { split: "yes" } }));
    assert.ok(!isStartPlanMessage({ type: "startPlan", action: "answer", answers: { split: 1 } }));
    assert.ok(isStartPlanMessage({ type: "startPlan", action: "dismiss" }));
    assert.ok(!isStartPlanMessage({ type: "startPlan", action: "approve" }));
  });
});

describe("Overview groups nodes by human-plan stage label", () => {
  const item = (number: number, group?: string): TimelineItem => ({ number, title: `T${number}`, state: "future", current: false, ...(group ? { group } : {}) });

  it("groups consecutive nodes of one plan stage, in execution order", () => {
    const groups = timelineGroups([item(1, "3"), item(2, "3"), item(3, "4"), item(4)]);
    assert.deepEqual(
      groups.map((group) => [group.label, group.items.map((entry) => entry.number)]),
      [
        ["3", [1, 2]],
        ["4", [3]],
        [undefined, [4]],
      ],
    );
  });
});

describe("manifest v2 and the intake envelope", () => {
  const STAGE = { stage_id: "s1", label: "Stage 1", title: "Schema", brief: "Do it.\n" };
  const v2 = { version: 2, plan_label: "plan.md", source_digest: "sha256:abc", stages: [{ ...STAGE, gates_before: [GATE] }], completion_gates: [{ ...GATE, id: "done" }] };

  it("reads gates_before and completion_gates", () => {
    const parsed = parseExecutionManifest(JSON.stringify(v2))!;
    assert.equal(parsed.identity.version, 2);
    assert.deepEqual(parsed.identity.gatesBefore, { s1: [GATE] });
    assert.equal(parsed.identity.completionGates?.[0].id, "done");
  });

  it("refuses a v1 manifest carrying gates, and a v2 one declaring none", () => {
    assert.equal(parseExecutionManifest(JSON.stringify({ ...v2, version: 1 })), undefined);
    assert.equal(parseExecutionManifest(JSON.stringify({ ...v2, stages: [STAGE], completion_gates: [] })), undefined);
  });

  it("reads an approved slice's v2 manifest inside the intake envelope", () => {
    const envelope = parseIntakeEnvelope(JSON.stringify({ intake_manifest: 1, intake_id: "i", run_id: "web", run_key: "k", manifest: v2 }));
    assert.deepEqual(
      envelope.stages.map((stage) => stage.stageId),
      ["s1"],
    );
  });

  it("reads each stage's plan_stage_label from intake.json", () => {
    const record = parseIntakeRecord(JSON.stringify({ version: 2, intake_id: "i", plan_label: "plan.md", run_keys: { web: "k" }, stages: { s1: { plan_stage_label: "3", run_id: "web" }, s2: {} } }));
    assert.deepEqual(record.planStageLabels, { s1: "3" });
  });
});
