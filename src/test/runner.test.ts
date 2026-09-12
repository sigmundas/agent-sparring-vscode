import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRunLoopArgs } from "../core/cli";
import { discoverRuns, locateSparringDirs, selectRun, type StandaloneStageSnapshot } from "../core/discovery";
import { applyEvent, emptyLiveState, foldEvents } from "../core/liveState";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { renderOverviewHtml } from "../core/overviewHtml";
import { STALE_ACTIVE_MS, deriveLiveness, type ExecutionRecord } from "../core/liveness";
import { pickBranch, stageRunAction } from "../core/runner";
import { deriveStatus } from "../core/status";
import { Workspace, event, sparringMarkdown } from "./fixtures";

const ALL: OverviewArtifacts = { handoff: true, sparring: true, brief: true, plan: true };
const T0 = Date.parse("2026-09-12T19:00:00.000Z");
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

async function standalone(ws: Workspace): Promise<StandaloneStageSnapshot> {
  return selectRun((await discoverRuns([ws.location])).runs).selected as StandaloneStageSnapshot;
}

describe("run-loop command construction", () => {
  it("mirrors cli.py: run-loop <stage_id> --repo-root ROOT --expected-branch BRANCH, unquoted", async () => {
    const ws = await Workspace.create({ withSpaces: true });
    await ws.writeStage("stage-reported-statistics-local-persistence", { status: "working" });
    const run = await standalone(ws);
    const args = buildRunLoopArgs({ stageId: run.stage.stageId, repoRoot: run.location.repoRoot, expectedBranch: "feature/reported-statistics-contract", sparringDir: run.location.sparringDir });
    assert.deepEqual(args, ["run-loop", "stage-reported-statistics-local-persistence", "--repo-root", ws.root, "--expected-branch", "feature/reported-statistics-contract"]);
    assert.ok(ws.root.includes(" "), "paths with spaces are passed as single argv entries");
  });

  it("uses the nested project's directory as --repo-root, not the workspace folder", async () => {
    const parent = await Workspace.create({ sparring: false, name: "sporely" });
    const nested = await Workspace.createNested(parent.root, "sporely-py-reported-statistics");
    await nested.writeStage("stage-x", { status: "working" });
    const locations = await locateSparringDirs(parent.root, "sporely");
    const run = selectRun((await discoverRuns(locations)).runs).selected as StandaloneStageSnapshot;
    const args = buildRunLoopArgs({ stageId: run.stage.stageId, repoRoot: run.location.repoRoot, expectedBranch: "main", sparringDir: run.location.sparringDir });
    assert.equal(args[args.indexOf("--repo-root") + 1], nested.root);
    assert.ok(!args.includes("--sparring-dir"), "the implicit <repo>/.sparring needs no global flag");
  });

  it("passes --sparring-dir only when project.toml points the repo root elsewhere", () => {
    const args = buildRunLoopArgs({ stageId: "s", repoRoot: "/code/app", expectedBranch: "main", sparringDir: "/code/meta/.sparring" });
    assert.deepEqual(args, ["--sparring-dir", "/code/meta/.sparring", "run-loop", "s", "--repo-root", "/code/app", "--expected-branch", "main"]);
  });
});

describe("branch from the owning Git repository", () => {
  const repos = [
    { rootPath: "/code/sporely", branch: "main" },
    { rootPath: "/code/sporely/sporely-py-reported-statistics", branch: "feature/reported-statistics-contract" },
    { rootPath: "/code/other", branch: undefined },
  ];

  it("picks the deepest repository containing the project directory", () => {
    assert.equal(pickBranch("/code/sporely/sporely-py-reported-statistics", repos), "feature/reported-statistics-contract");
    assert.equal(pickBranch("/code/sporely/sporely-py-reported-statistics/sub/dir", repos), "feature/reported-statistics-contract");
    assert.equal(pickBranch("/code/sporely/sporely-web", repos), "main");
    assert.equal(pickBranch(path.join("/code", "sporely"), repos), "main");
  });

  it("refuses cleanly: no owning repository or detached HEAD yields undefined, never a guess", () => {
    assert.equal(pickBranch("/elsewhere/repo", repos), undefined);
    assert.equal(pickBranch("/code/other", repos), undefined);
    assert.equal(pickBranch("/code/other", [{ rootPath: "/code/other", branch: "   " }]), undefined);
    assert.equal(pickBranch("/code/sporely-py", repos), undefined, "a sibling with a shared prefix is not inside");
  });
});

describe("stage run action", () => {
  it("fresh stage → Run stage; persisted sessions → Resume stage", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("fresh", { status: "working" });
    assert.deepEqual(stageRunAction(await standalone(ws)), { kind: "run", label: "Run stage", primary: true });
    await ws.writeStage("fresh", { status: "working", implementation_session_id: "82ab", sparring_session_id: "019d" });
    assert.deepEqual(stageRunAction(await standalone(ws)), { kind: "resume", label: "Resume stage", primary: true });
    await ws.writeStage("fresh", { status: "working", sparring_session_id: "019d" });
    assert.equal(stageRunAction(await standalone(ws))?.kind, "resume", "either session counts");
  });

  it("NEEDS_YOU and SEND_BACK offer Resume stage", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working", implementation_session_id: "x" }, { "sparring.md": sparringMarkdown("NEEDS_YOU", "Pick a colour") });
    assert.equal(stageRunAction(await standalone(ws))?.label, "Resume stage");
    await ws.writeStage("s", { status: "working", implementation_session_id: "x" }, { "sparring.md": sparringMarkdown("SEND_BACK", "fix") });
    assert.equal(stageRunAction(await standalone(ws))?.label, "Resume stage");
  });

  it("accepted and frozen stages have no run action; plan runs have none either", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("done", { status: "accepted", candidate_sha: "c" });
    assert.equal(stageRunAction(await standalone(ws)), undefined);
    await ws.writeStage("done", { status: "frozen", base_sha: "b", candidate_sha: "c", implementation_session_id: "x" });
    assert.equal(stageRunAction(await standalone(ws)), undefined);
    assert.equal(stageRunAction(undefined), undefined);
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(model.stageAction, undefined);
    assert.ok(!renderOverviewHtml(model, "n", "c").includes('data-action="runStage"'));
  });

  it("READY only offers a non-primary, explicitly labelled rerun", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working", implementation_session_id: "x" }, { "sparring.md": sparringMarkdown("READY", "Looks done") });
    assert.deepEqual(stageRunAction(await standalone(ws)), { kind: "rerun", label: "Run loop again", primary: false });
    const html = renderOverviewHtml(buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0), "n", "c");
    assert.match(html, /<button type="button" data-action="runStage" [^>]*>Run loop again<\/button>/);
    assert.ok(!/class="primary" data-action="runStage"/.test(html));
  });

  it("the primary button sits in the stage card's action row", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("fresh", { status: "working" });
    const html = renderOverviewHtml(buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0), "n", "c");
    assert.match(html, /<div class="actions"><button type="button" class="primary" data-action="runStage" [^>]*>Run stage<\/button><button type="button" data-action="openBrief"/);
  });
});

describe("runner lifecycle presentation", () => {
  function busyLive() {
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "loop", event: "loop.started" });
    applyEvent(live, { v: 1, ts: at(1), actor: "stage", event: "turn.started", provider: "claude-cli", session_id: "82ab" });
    applyEvent(live, { v: 1, ts: at(5), actor: "stage", event: "file.changed", path: "src/a.py", kind: "modify" });
    return live;
  }
  const running = (runId: string, startedAtMs: number): ExecutionRecord => ({ id: "e1", runId, kind: "run-loop", source: "launched", state: "running", startedAtMs });
  const ended = (runId: string, startedAtMs: number, endedAtMs: number, exitCode?: number): ExecutionRecord => ({ id: "e1", runId, kind: "run-loop", source: "launched", state: "ended", startedAtMs, endedAtMs, exitCode });

  it("an observed-alive runner: Working for Xs, exact Running, Stop instead of Run", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const model = buildOverviewModel(selection, busyLive(), ALL, T0 + 60_000, running(selection.selected!.id, T0 - 1000));
    assert.equal(model.stageAgent?.activity, "Working");
    assert.equal(model.stageAgent?.uncertain, false);
    assert.equal(model.activity?.kind, "active");
    assert.equal(model.activity?.text, "Working for 59s · Claude");
    assert.equal(model.stageAction, undefined);
    assert.deepEqual(model.runner, { alive: true, label: "Stop (Ctrl-C)" });
    assert.equal(model.busyState?.label, "Running");
    assert.equal(model.busyState?.state, "running");
    assert.match(model.busyState?.detail ?? "", /exact/);
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /class="danger" data-action="stopRunner"/);
    assert.match(html, /<span class="busy" title="[^"]*"><svg[^>]*>.*?<\/svg>Running<\/span>/);
    assert.ok(!html.includes('data-action="runStage"'));
    assert.match(html, /Claude<\/span> working for <span class="dur">59s<\/span>/);
  });

  it("runner ended mid-turn (Ctrl-C, crash, reload): Stopped · last turn interrupted, duration frozen, Resume stage", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working", implementation_session_id: "82ab" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    const execution = ended(selection.selected!.id, T0 - 1000, T0 + 30_000);
    const model = buildOverviewModel(selection, live, ALL, T0 + 60_000, execution);
    assert.equal(model.stageAgent?.activity, "Waiting", "no more 'Claude working'");
    assert.equal(model.stageAgent?.duration, undefined);
    assert.equal(model.sparrer?.activity, "Waiting");
    assert.deepEqual(model.activity, { kind: "stopped", text: "Stopped · last turn interrupted" });
    assert.deepEqual(model.runner, { alive: false, label: "Runner stopped" });
    assert.equal(model.busyState, undefined);
    assert.equal(model.stageAction?.label, "Resume stage", "the loop can be resumed right away");
    assert.equal(model.stageLine, "Working.", "no 'Implementing.' claim either");
    assert.equal(live.stage.busy, true, "the fold itself is not mutated; this is presentation only");
    assert.match(model.liveness?.detail ?? "", /runner has exited/);

    // Much later the card must not have grown: the same model, no duration.
    const later = buildOverviewModel(selection, live, ALL, T0 + 3 * 60 * 60_000, execution);
    assert.equal(later.stageAgent?.duration, undefined);
    assert.equal(later.activity?.kind, "stopped");

    const liveness = deriveLiveness(live, execution, T0 + 60_000);
    const status = deriveStatus(selection, liveness.live, T0 + 60_000, liveness);
    assert.equal(status.text, "$(circle-filled) Agent Sparring: S · stopped");
    assert.match(status.tooltip, /Last run interrupted/);
    assert.ok(!status.tooltip.includes("Claude working"));
    assert.match(renderOverviewHtml(model, "n", "c"), /Stopped · last turn interrupted/);
  });

  it("a clean exit after turn.finished is not an interruption", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    applyEvent(live, { v: 1, ts: at(20), actor: "stage", event: "turn.finished" });
    const model = buildOverviewModel(selection, live, ALL, T0 + 60_000, ended(selection.selected!.id, T0, T0 + 25_000, 0));
    assert.equal(model.activity?.kind, "last");
    assert.equal(model.runner, undefined);
    assert.equal(model.liveness?.state, "stopped");
    assert.equal(model.stageAction?.kind, "resume", "a turn was observed, so the next launch is a resume");
  });

  it("telemetry alone never becomes Running: Run status unknown, inferred activity, no Run button", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    const model = buildOverviewModel(selection, live, ALL, T0 + 60_000);
    assert.equal(model.stageAction, undefined, "never a second run-loop from the button for a stage telemetry says is busy");
    assert.equal(model.busyState?.label, "Run status unknown");
    assert.equal(model.busyState?.state, "unknown");
    assert.match(model.busyState?.detail ?? "", /cannot prove the process is alive/);
    assert.equal(model.liveness?.state, "unknown");
    assert.equal(model.liveness?.source, "telemetry");
    assert.equal(model.activity?.kind, "inferred");
    assert.equal(model.activity?.text, "Turn started 59s ago · Claude · runner status unknown");
    assert.equal(model.stageAgent?.activity, "Working");
    assert.equal(model.stageAgent?.uncertain, true);
    assert.equal(model.runner, undefined, "no Stop: there is no terminal to signal");
    const html = renderOverviewHtml(model, "n", "c");
    assert.ok(!html.includes('data-action="runStage"'));
    assert.ok(!html.includes('data-action="stopRunner"'));
    assert.match(html, /<span class="busy unknown" title="[^"]*"><svg[^>]*>.*?<\/svg>Run status unknown<\/span>/);
    assert.ok(!/>Running</.test(html), "the word Running never appears for telemetry-only liveness");
    assert.match(html, /Working\? <span class="muted">\(turn observed 59s ago\)<\/span> <span class="muted">· runner status unknown<\/span>/);

    const liveness = deriveLiveness(live, undefined, T0 + 60_000);
    const status = deriveStatus(selection, liveness.live, T0 + 60_000, liveness);
    assert.equal(status.text, "$(circle-filled) Agent Sparring: S · Claude working (unconfirmed)");
    assert.match(status.tooltip, /Runner status unknown/);

    // The turn ends (finished or interrupted), the stage stays non-terminal: Resume stage.
    applyEvent(live, { v: 1, ts: at(90), actor: "stage", event: "turn.finished" });
    const after = buildOverviewModel(selection, live, ALL, T0 + 120_000);
    assert.equal(after.busyState, undefined);
    assert.deepEqual(after.stageAction, { kind: "resume", label: "Resume stage", primary: true });
  });

  it("a stage never run at all still gets Run stage; frozen/accepted get nothing even when busy telemetry lingers", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("fresh", { status: "working" });
    assert.equal(stageRunAction(await standalone(ws), deriveLiveness(foldEvents([event("loop", "loop.started")]), undefined, T0))?.kind, "run");
    await ws.writeStage("fresh", { status: "frozen", base_sha: "b", candidate_sha: "c" });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), busyLive(), ALL, T0 + 60_000);
    assert.equal(model.stageAction, undefined);
    assert.equal(model.busyState, undefined, "frozen is halted for the loop; no Running claim");
  });

  it("an execution for a different run never affects the selected one", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const model = buildOverviewModel(selection, busyLive(), ALL, T0 + 60_000, ended("someone-else", T0, T0 + 1000));
    assert.equal(model.stageAgent?.activity, "Working");
    assert.equal(model.stageAgent?.uncertain, true);
    assert.equal(model.runner, undefined);
  });

  it("telemetry-only busy claims go stale after a long silence, and stay blocked", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    const soon = buildOverviewModel(selection, live, ALL, T0 + 5 * 60_000);
    assert.equal(soon.activity?.kind, "inferred");
    const later = buildOverviewModel(selection, live, ALL, T0 + STALE_ACTIVE_MS + 60_000);
    assert.equal(later.activity?.kind, "stale");
    assert.equal(later.activity?.text, "Turn started 30m 59s ago · Claude · runner status unknown · no meaningful activity for 30m", "no hang implied");
    assert.equal(later.busyState?.label, "Run status unknown");
    assert.ok(later.stageAgent?.quietFor);
    assert.equal(later.stageAction, undefined, "a stale busy claim is still a busy claim: no second loop from the button");
  });
});
