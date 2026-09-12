import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildRunLoopArgs } from "../core/cli";
import { discoverRuns, locateSparringDirs, selectRun, type StandaloneStageSnapshot } from "../core/discovery";
import { applyEvent, emptyLiveState, foldEvents } from "../core/liveState";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { renderOverviewHtml } from "../core/overviewHtml";
import { STALE_ACTIVE_MS, applyRunner, pickBranch, stageRunAction, type RunnerStatus } from "../core/runner";
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

  it("an alive runner leaves telemetry untouched and offers Stop instead of Run", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const runner: RunnerStatus = { runId: selection.selected!.id, alive: true, startedAtMs: T0 - 1000 };
    const model = buildOverviewModel(selection, busyLive(), ALL, T0 + 60_000, runner);
    assert.equal(model.stageAgent?.activity, "Working");
    assert.equal(model.activity?.kind, "active");
    assert.equal(model.stageAction, undefined);
    assert.deepEqual(model.runner, { alive: true, label: "Stop (Ctrl-C)" });
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /class="danger" data-action="stopRunner"/);
    assert.ok(!html.includes('data-action="runStage"'));
  });

  it("runner exit clears the stale busy presentation without a turn.finished / verdict", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working", implementation_session_id: "82ab" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    const runner: RunnerStatus = { runId: selection.selected!.id, alive: false, startedAtMs: T0 - 1000, endedAtMs: T0 + 30_000, exitCode: undefined };
    const model = buildOverviewModel(selection, live, ALL, T0 + 60_000, runner);
    assert.equal(model.stageAgent?.activity, "Waiting", "no more 'Claude working'");
    assert.equal(model.stageAgent?.duration, undefined);
    assert.equal(model.sparrer?.activity, "Waiting");
    assert.deepEqual(model.activity, { kind: "stopped", text: "Runner stopped · last run interrupted" });
    assert.deepEqual(model.runner, { alive: false, label: "Runner stopped" });
    assert.equal(model.stageAction?.label, "Resume stage", "the loop can be resumed right away");
    assert.equal(model.stageLine, "Working.", "no 'Implementing.' claim either");
    assert.equal(live.stage.busy, true, "the fold itself is not mutated; this is presentation only");

    const status = deriveStatus(selection, applyRunner(live, runner, T0 + 60_000).live, T0 + 60_000);
    assert.equal(status.text, "$(circle-filled) Agent Sparring: S · working", "authoritative state.json word only, no 'Claude working'");
    assert.ok(!status.tooltip.includes("Claude working"));
    assert.match(renderOverviewHtml(model, "n", "c"), /Runner stopped · last run interrupted/);
  });

  it("a clean exit after turn.finished is not an interruption", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    applyEvent(live, { v: 1, ts: at(20), actor: "stage", event: "turn.finished" });
    const runner: RunnerStatus = { runId: selection.selected!.id, alive: false, startedAtMs: T0, endedAtMs: T0 + 25_000, exitCode: 0 };
    const model = buildOverviewModel(selection, live, ALL, T0 + 60_000, runner);
    assert.equal(model.activity?.kind, "last");
    assert.equal(model.runner, undefined);
    assert.equal(model.stageAction?.kind, "run");
  });

  it("a turn that started after the runner ended (another launcher) is still trusted", () => {
    const live = busyLive();
    const runner: RunnerStatus = { runId: "r", alive: false, startedAtMs: T0 - 60_000, endedAtMs: T0 - 30_000 };
    const effective = applyRunner(live, runner, T0 + 10_000);
    assert.equal(effective.interrupted, false);
    assert.equal(effective.live?.stage.busy, true);
  });

  it("a runner for a different run never affects the selected one", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const other: RunnerStatus = { runId: "someone-else", alive: false, startedAtMs: T0, endedAtMs: T0 + 1000 };
    const model = buildOverviewModel(selection, busyLive(), ALL, T0 + 60_000, other);
    assert.equal(model.stageAgent?.activity, "Working");
    assert.equal(model.runner, undefined);
  });

  it("externally launched telemetry keeps working and goes stale only after a long silence", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("s", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = busyLive();
    const soon = buildOverviewModel(selection, live, ALL, T0 + 5 * 60_000);
    assert.equal(soon.activity?.kind, "active");
    assert.equal(soon.stageAgent?.activity, "Working");
    const later = buildOverviewModel(selection, live, ALL, T0 + STALE_ACTIVE_MS + 60_000);
    assert.equal(later.activity?.kind, "stale");
    assert.equal(later.activity?.text, "Working for 30m 59s · Claude · no telemetry for 30m; the runner may have stopped");
    assert.equal(later.stageAgent?.activity, "Working", "the claim is kept, only qualified");
    assert.ok(later.stageAgent?.quietFor);
    assert.equal(later.stageAction?.label, "Run stage", "resuming is still offered");
    assert.equal(applyRunner(undefined, undefined, T0).live, undefined);
    assert.equal(applyRunner(foldEvents([event("stage", "turn.finished")]), undefined, T0 + STALE_ACTIVE_MS * 2).stale, false, "idle claims never go stale");
  });
});
