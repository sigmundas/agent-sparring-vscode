import assert from "node:assert/strict";
import { before, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { buildOverviewModel, type OverviewModel } from "../core/overviewModel";
import { renderHumanEvidence, submittableChecks } from "../core/humanChecks";
import { buildResumePlanArgs } from "../core/cli";
import { Workspace, FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS } from "./fixtures";
import { FakeTerminal, install, reset, until } from "./vscodeStub";

const stub = install();
let Registry: typeof import("../vscode/operationRegistry").OperationRegistry;
let Tracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let Controller: typeof import("../vscode/controller").SparringController;
let Panel: typeof import("../vscode/overview/overviewPanel").OverviewPanelManager;
let renderKey: typeof import("../vscode/overview/overviewPanel").overviewRenderKey;
before(async () => {
  Registry = (await import("../vscode/operationRegistry")).OperationRegistry;
  Tracker = (await import("../vscode/executionTracker")).ExecutionTracker;
  Controller = (await import("../vscode/controller")).SparringController;
  const overview = await import("../vscode/overview/overviewPanel");
  Panel = overview.OverviewPanelManager;
  renderKey = overview.overviewRenderKey;
});

it("a paused plan preserves four Passes through an ambiguous handoff, exact override, reload and explicit retry", async () => {
  reset();
  const ws = await Workspace.create();
  const planPath = await ws.writePlan();
  const stageId = FOO_STAGE_IDS[0];
  const checks = Array.from({ length: 4 }, (_, i) => ({ id: `check-${i}`, instruction: `Compare view ${i}`, pass_criteria: "Readable", source: null }));
  await ws.writeStage(stageId, { status: "working" }, { "sparring.md": `## Routing outcome\n\n- Action: \`NEEDS_YOU\`\n- Summary: Manual checks required\n\n${HUMAN_GATE_MARKER}\n\n\`\`\`json\n${JSON.stringify({ category: "DEVICE_MANUAL_CHECK", title: "Compare", checks })}\n\`\`\`\n` });
  await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "paused", current_stage_index: 0, current_stage: stageId });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const runId = selection.selected!.id;
  const values = new Map<string, unknown>();
  const workspaceState = { get: <T>(key: string, fallback?: T): T => (values.get(key) ?? fallback) as T, update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] };
  const context = { workspaceState } as never;
  let registry = new Registry(context, () => {}, () => true, async () => []);
  const terminals: FakeTerminal[] = [];
  const pool = { acquire: () => {
    const terminal = new FakeTerminal(`test ${terminals.length}`, 876000 + terminals.length);
    terminals.push(terminal);
    terminal.integrate();
    return { terminal, idle: () => true, release: () => {}, discard: () => {}, retire: () => {} };
  } };
  let tracker = new Tracker(context, () => {}, () => [], pool as never, registry, () => false, async () => []);
  const drafts = Object.fromEntries(checks.map(check => [check.id, { outcome: "pass" as const }]));
  const model = () => {
    const guard = registry.inFlightFor(`run:${runId}`);
    return buildOverviewModel(selection, undefined, { handoff: false, sparring: true, brief: false, plan: true, humanChecks: drafts, guardedOperationId: guard?.id, guardOutstanding: !!guard }, Date.now(), tracker.executionFor(runId));
  };
  const confirmation = (id: string, targetRun = runId) => Controller.prototype.confirmRunnerInactive.call({ context, tracker, submissions: registry, log: () => {}, render: () => {} } as never, targetRun, undefined, id);
  const entry = renderHumanEvidence(submittableChecks(model().actionRequired!), new Date("2026-09-20"), "Comparison")!;
  // The ambiguity this test is about belongs to the *shell* transport, so the
  // command that becomes ambiguous is a shell-bound one: Continue plan, which
  // carries no free text and is handed to the user's own shell exactly as
  // before. The evidence submission no longer takes that route at all
  // (core/cli.ts, `transportSafety`), but it shares this run's admission
  // guard, so a Continue plan nobody can account for still has to leave four
  // Passes untouched and recoverable — which is the whole point.
  const args = buildResumePlanArgs({ source: "markdown", planPath, repoRoot: ws.root, expectedBranch: "feature/x" });
  const options = { configured: process.execPath, args, cwd: ws.root, name: "resume-plan", runId, kind: "resume-plan" as const, planPath, reveal: false };
  try {
    assert.equal(model().actionRequired?.submit.enabled, true);
    const ready = model();
    const typing = structuredClone(ready);
    typing.actionRequired!.required[0].record!.note = "Still typing";
    typing.actionRequired!.feedback.draft = "Still typing";
    assert.equal(renderKey(ready), renderKey(typing), "text alone does not replace the focused textarea");
    typing.actionRequired!.submit.enabled = false;
    assert.notEqual(renderKey(ready), renderKey(typing), "action changes must render even while typing");
    const result = await tracker.launch(options);
    assert.equal(result.ok, false);
    const first = registry.inFlightFor(`run:${runId}`)!;
    assert.equal(first.state, "submitted-shell");
    await registry.probeAll();
    assert.equal(registry.inFlightFor(first.key)?.id, first.id);
    assert.equal(model().actionRequired?.submit.enabled, false, "paused engine state must not hide the operation guard");
    assert.equal((await tracker.launch(options)).ok, false);
    assert.equal(terminals.length, 1);

    // A reload loses shell identity, never the admission guard or the drafts.
    tracker.dispose(); registry.dispose();
    registry = new Registry(context, () => {}, () => true, async () => []);
    registry.restore();
    tracker = new Tracker(context, () => {}, () => [], pool as never, registry, () => false, async () => []);
    assert.equal(model().actionRequired?.submit.enabled, false);
    assert.equal((await confirmation(first.id, "different-run")).confirmed, false);
    assert.equal(registry.inFlightFor(first.key)?.id, first.id);
    assert.equal((await confirmation(first.id)).overrode, true);
    assert.equal(registry.inFlightFor(first.key), undefined);
    assert.equal(terminals.length, 1, "confirmation executes nothing");
    assert.equal(model().actionRequired?.submit.enabled, true);
    assert.deepEqual(submittableChecks(model().actionRequired!).map(check => check.record.outcome), ["pass", "pass", "pass", "pass"]);
    assert.equal(renderHumanEvidence(submittableChecks(model().actionRequired!), new Date("2026-09-20"), "Comparison"), entry);

    const retry = tracker.launch(options);
    const second = await until(() => { const op = registry.inFlightFor(first.key); return op?.state === "submitted-shell" ? op : undefined; }, "explicit retry handoff");
    assert.notEqual(second.id, first.id);
    assert.equal((await confirmation(first.id)).overrode, false);
    assert.equal(registry.inFlightFor(first.key)?.id, second.id);
    assert.equal((await tracker.launch(options)).ok, false);
    assert.equal(terminals.length, 2, "one fresh handoff, no double execution");
    const terminal = terminals[1];
    stub.window.startEmitter.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution: terminal.executions[0] });
    assert.equal((await retry).ok, true);
    stub.window.endEmitter.fire({ terminal, shellIntegration: terminal.shellIntegration!, execution: terminal.executions[0], exitCode: 0 });

    // And the submission those four Passes were waiting for, once the run is
    // free again: the same drafts, now carried to the engine as exact argv in
    // a process of its own. It leases no terminal from the pool, because a
    // command no shell may be shown never asks for one.
    const before = terminals.length;
    const evidenceArgs = buildResumePlanArgs({ source: "markdown", planPath, repoRoot: ws.root, expectedBranch: "feature/x", evidence: entry });
    const submitted = await tracker.launch({ ...options, args: evidenceArgs });
    assert.equal(submitted.ok, true, "the evidence submission starts");
    assert.equal(submitted.via, "terminal", "as its own process, not as a line in anybody's shell");
    assert.equal(terminals.length, before, "and without leasing a shell terminal it would never write to");
    assert.deepEqual(stub.window.created.at(-1)?.shellArgs, evidenceArgs, "the argument array reaches the pty host untouched");
  } finally { tracker.dispose(); registry.dispose(); }
});

it("saving a draft cannot swallow the guard-release render", async () => {
  let current = { kind: "run", title: "test", unknownRunner: { label: "Confirm", operationId: "old", detail: "unknown" } } as OverviewModel;
  let html = "guarded page";
  const fake = {
    panel: { webview: { get html() { return html; }, set html(value: string) { html = value; }, cspSource: "test" } },
    lastHtmlKey: JSON.stringify(current),
    controller: { currentSelection: { selected: { id: "run", kind: "stage", stage: { stageId: "stage" } } }, setHumanFeedback: async () => { current = { kind: "run", title: "test" } as OverviewModel; } },
    buildModel: async () => current,
  };
  await (Panel.prototype as unknown as { recordHumanFeedback(this: unknown, message: unknown): Promise<void> }).recordHumanFeedback.call(fake, { text: "I checked" });
  await Panel.prototype.update.call(fake as never);
  assert.notEqual(html, "guarded page", "the render key must describe the page actually rendered, not a model read by a draft save");
});
