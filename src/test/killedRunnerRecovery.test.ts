/**
 * The reported sequence, end to end: a managed manifest plan run reached
 * Stage 4, the implementation turn started, Claude edited files for an
 * hour — and then the extension-owned terminal was closed and the window
 * reloaded before the turn could finish.
 *
 * What the user was left with:
 *
 *   Plan run · Stage 4 · Working?
 *   Run status unknown
 *
 * and no way forward on the screen. No `sparring` process was alive, the
 * plan was recorded at Stage 4, the worktree held that turn's unfinished
 * edits, and the one thing to do — resume the plan — was the one thing the
 * Overview would not offer. It withheld every action because telemetry
 * still held an unmatched `turn.started`, which it could neither confirm
 * nor refute.
 *
 * Refuting it is what the process table is for (runnerProcesses.ts). These
 * tests walk the whole path on real files: the stuck state, the probe that
 * settles it, and the Overview that then offers Resume plan and nothing
 * else — plus the three cases where the probe must *not* conclude anything.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun, type PlanRunSnapshot, type RunSelection } from "../core/discovery";
import { deriveLiveness, type ExecutionRecord } from "../core/liveness";
import { foldEvents, type LiveState } from "../core/liveState";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { renderOverviewHtml } from "../core/overviewHtml";
import { probeRunnerProcesses } from "../core/runnerProcesses";
import { planAction } from "../core/runner";
import type { ProcessInfo } from "../core/processTree";
import { Workspace, normalUi } from "./fixtures";

const PLAN_KEY = "reported-statistics-1cd13d24";
const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const STAGE_4 = "stage-4-editor-and-ui-inspection-and-guarded-editing";
const SESSION = "ac5c9f87-2909-4d83-abf5-46c9d1ce752b";
const ARTIFACTS: OverviewArtifacts = { handoff: true, sparring: true, brief: true, plan: false };

/** Timestamps of the real interruption: the turn began, ran for an hour, and stopped mid-tool. */
const ENTERED = "2026-09-14T19:50:06.450Z";
const LAST_EVENT = "2026-09-14T20:55:19.124Z";
const NOW = Date.parse("2026-09-14T21:10:00.000Z");

/**
 * The worktree as the interruption left it: a managed manifest run recorded
 * at Stage 4, a stage whose implementation session is known (the engine now
 * records it when the provider announces it, so a killed turn keeps it) and
 * activity that starts a turn and never finishes one.
 */
async function interrupted(): Promise<Workspace> {
  const ws = await Workspace.create();
  await ws.writePlanRun(PLAN_KEY, {
    plan: PLAN_LABEL,
    status: "running",
    current_stage_index: 6,
    current_stage: STAGE_4,
    source: "manifest",
  });
  await ws.writeStage(
    STAGE_4,
    { status: "working", base_sha: "12992e61630c325dabd61817ddc2d8ed1fb81e00", implementation_session_id: SESSION },
    { "brief.md": "# Stage brief: stage-4\n\nEditor and UI inspection and guarded editing.\n" },
  );
  await ws.appendActivity(STAGE_4, [
    { v: 1, ts: ENTERED, actor: "plan", event: "plan.stage.entered", summary: "Stage 4 — Editor and UI inspection and guarded editing (7/8)" },
    { v: 1, ts: ENTERED, actor: "loop", event: "loop.started" },
    { v: 1, ts: ENTERED, actor: "stage", event: "turn.started", provider: "claude-cli" },
    { v: 1, ts: ENTERED, actor: "stage", event: "session.observed", session_id: SESSION, provider: "claude-cli" },
    { v: 1, ts: "2026-09-14T19:58:57.329Z", actor: "stage", event: "file.changed", path: "ui/measurement_content_view.py", provider: "claude-cli" },
    { v: 1, ts: LAST_EVENT, actor: "stage", event: "command.finished", tool: "Bash", provider: "claude-cli" },
  ]);
  return ws;
}

async function selection(ws: Workspace): Promise<RunSelection> {
  return selectRun((await discoverRuns([ws.location])).runs);
}

/** The activity fold as the tailer produces it from that file. */
function live(): LiveState {
  return foldEvents([
    { v: 1, ts: ENTERED, actor: "plan", event: "plan.stage.entered" },
    { v: 1, ts: ENTERED, actor: "loop", event: "loop.started" },
    { v: 1, ts: ENTERED, actor: "stage", event: "turn.started", provider: "claude-cli" },
    { v: 1, ts: "2026-09-14T19:58:57.329Z", actor: "stage", event: "file.changed", path: "ui/measurement_content_view.py" },
    { v: 1, ts: LAST_EVENT, actor: "stage", event: "command.finished", tool: "Bash" },
  ]);
}

/** A process snapshot with ordinary noise and no sparring runner in it. */
const NO_RUNNER: ProcessInfo[] = [
  { pid: 1, ppid: 0, command: "/sbin/launchd" },
  { pid: 501, ppid: 1, command: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" },
  // A long-lived provider process of an unrelated extension: never a sparring runner.
  { pid: 620, ppid: 501, command: "claude --output-format stream-json -p hello" },
];

/** The engine actually running, as `ps -axo command=` reports a venv console script. */
function runnerFor(ws: Workspace): ProcessInfo {
  return {
    pid: 810,
    ppid: 700,
    command: `/opt/homebrew/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /venv/bin/sparring resume-plan --manifest /store/manifests/${PLAN_KEY}.manifest.json --repo-root ${ws.location.repoRoot} --expected-branch feature/reported-statistics-contract`,
  };
}

const record = (runId: string, over: Partial<ExecutionRecord>): ExecutionRecord => ({
  id: "probe-1",
  runId,
  kind: "resume-plan",
  source: "probed",
  state: "running",
  startedAtMs: NOW - 1000,
  ...over,
});

/** What ExecutionTracker.probeProject records when no runner is found. */
const gone = (runId: string) =>
  record(runId, { state: "ended", endedAtMs: NOW - 1000, detail: "The plan runner is no longer running: no sparring process for this project exists." });

/** What it records when one is. */
const alive = (runId: string) => record(runId, {});

describe("a plan runner killed mid-turn", () => {
  it("1. without a process observation the run is stuck at unknown, and no action is offered", async () => {
    const ws = await interrupted();
    const picked = await selection(ws);
    const run = picked.selected as PlanRunSnapshot;
    const liveness = deriveLiveness(live(), undefined, NOW);

    assert.equal(run.kind, "plan");
    assert.equal(run.state.status, "running");
    assert.equal(run.currentStage.stageId, STAGE_4);
    assert.equal(liveness.state, "unknown", "telemetry alone is never promoted to running");
    assert.equal(liveness.turnActive, true, "the unmatched turn.started still claims a turn");
    assert.equal(planAction(run, liveness), undefined, "the dead end: nothing to press");

    const model = buildOverviewModel(picked, live(), ARTIFACTS, NOW);
    assert.equal(model.kind, "run");
    assert.equal(model.busyState?.label, "Run status unknown");
    assert.equal(model.planAction, undefined);
  });

  it("2. the process table refutes the stale turn: no sparring runner for this project", async () => {
    const ws = await interrupted();
    assert.deepEqual(probeRunnerProcesses(NO_RUNNER, ws.location), { kind: "none" });
  });

  it("3. probed as gone → Stopped, interrupted, and Resume plan is the primary action", async () => {
    const ws = await interrupted();
    const picked = await selection(ws);
    const run = picked.selected as PlanRunSnapshot;
    const liveness = deriveLiveness(live(), gone(run.id), NOW);

    assert.equal(liveness.state, "stopped");
    assert.equal(liveness.source, "execution");
    assert.equal(liveness.interrupted, true, "the runner died while a turn was open");
    assert.equal(liveness.turnActive, false);
    assert.equal(liveness.live?.stage.busy, false, "a turn the dead runner cannot be executing is cleared");
    assert.match(liveness.detail, /no longer running/);

    const action = planAction(run, liveness);
    assert.equal(action?.kind, "resume");
    assert.equal(action?.label, "Resume plan");
    assert.equal(action?.primary, true);

    const model = buildOverviewModel(picked, live(), ARTIFACTS, NOW, gone(run.id));
    assert.equal(model.kind, "run");
    assert.equal(model.busyState, undefined, "unknown does not survive the probe");
    assert.equal(model.planAction?.label, "Resume plan");
    assert.equal(model.stageAction, undefined, "a managed plan run offers no standalone stage action");
    assert.equal(model.activity?.kind, "stopped");
  });

  it("4. the managed plan stays the selected run, and the screen offers no standalone stage", async () => {
    const ws = await interrupted();
    const picked = await selection(ws);
    const run = picked.selected as PlanRunSnapshot;
    const model = buildOverviewModel(picked, live(), ARTIFACTS, NOW, gone(run.id));
    const html = normalUi(renderOverviewHtml(model, "nonce", "vscode-resource:"));

    assert.equal(model.kind, "run");
    assert.equal(model.runKind, "Plan run");
    assert.match(html, /Resume plan/);
    assert.doesNotMatch(html, /Start next stage/);
    assert.doesNotMatch(html, /Start stage/);
    assert.doesNotMatch(html, /Run status unknown/);
  });

  it("5. a runner that IS alive is found, and no second one is offered", async () => {
    const ws = await interrupted();
    const picked = await selection(ws);
    const run = picked.selected as PlanRunSnapshot;
    assert.equal(probeRunnerProcesses([...NO_RUNNER, runnerFor(ws)], ws.location).kind, "alive");

    const liveness = deriveLiveness(live(), alive(run.id), NOW);
    assert.equal(liveness.state, "running");
    assert.equal(planAction(run, liveness), undefined, "never a second runner over a live one");
  });

  it("6. a runner for another project does not make this one look alive", async () => {
    const ws = await interrupted();
    const mine = runnerFor(ws);
    const elsewhere: ProcessInfo = { ...mine, command: mine.command.replace(ws.location.repoRoot, "/some/other/repo") };
    assert.deepEqual(probeRunnerProcesses([...NO_RUNNER, elsewhere], ws.location), { kind: "none" });
  });

  it("7. a runner that names no project concludes nothing: unknown is still the honest answer", async () => {
    const ws = await interrupted();
    const anonymous: ProcessInfo = { pid: 900, ppid: 1, command: "sparring run-plan docs/plans/active/reported-statistics.md" };
    assert.equal(
      probeRunnerProcesses([...NO_RUNNER, anonymous], ws.location).kind,
      "unattributable",
      "a relative path cannot be resolved without a cwd, and ps gives none",
    );
  });

  it("8. a probe's answer never outlives the moment it described: a later turn is unknown again", async () => {
    const ws = await interrupted();
    const picked = await selection(ws);
    const run = picked.selected as PlanRunSnapshot;

    // Someone starts a runner outside VS Code after the probe said "gone".
    const later = foldEvents([
      { v: 1, ts: "2026-09-14T21:30:00.000Z", actor: "loop", event: "loop.started" },
      { v: 1, ts: "2026-09-14T21:30:01.000Z", actor: "stage", event: "turn.started", provider: "claude-cli" },
    ]);
    const liveness = deriveLiveness(later, gone(run.id), Date.parse("2026-09-14T21:31:00.000Z"));

    assert.equal(liveness.state, "unknown", "the stale probe must not present a live runner as stopped");
    assert.equal(liveness.turnActive, true, "which is what makes the extension read the process table again");
    assert.equal(planAction(run, liveness), undefined, "and Resume plan is withheld until it does");
  });

  it("9. the stage keeps the implementation session the killed turn opened", async () => {
    const ws = await interrupted();
    const run = (await selection(ws)).selected as PlanRunSnapshot;
    assert.equal(run.currentStage.state?.implementationSessionId, SESSION, "Resume plan continues this session, not a new one");
    assert.equal(run.currentStage.state?.status, "working");
    assert.equal(run.currentStage.state?.candidateSha, null, "nothing was frozen: the work is still uncommitted");
  });
});
