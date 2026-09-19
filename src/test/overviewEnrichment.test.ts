import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMeaningfulActivity } from "../core/activityFilter";
import { parseBriefGoal } from "../core/brief";
import { discoverRuns, selectRun, type PlanRunSnapshot } from "../core/discovery";
import { RECENT_MEANINGFUL_MAX, activeDurationMs, applyEvent, emptyLiveState, foldEvents, formatDuration } from "../core/liveState";
import type { ExecutionRecord } from "../core/liveness";
import { LogRenderer } from "../core/logFormat";
import { HISTORY_MAX, activityLine, buildOverviewModel, history, timelineState, type OverviewArtifacts } from "../core/overviewModel";
import { renderOverviewHtml } from "../core/overviewHtml";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, event, sparringMarkdown } from "./fixtures";

const ALL: OverviewArtifacts = { handoff: true, sparring: true, brief: true, plan: true };
const T0 = Date.parse("2026-09-12T19:00:00.000Z");
const at = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

describe("goal extraction from brief.md", () => {
  it("takes the first non-empty paragraph beneath ## Goal", () => {
    const brief = ["# Brief: x", "", "## Goal", "", "Ship the typed parser for reported", "statistics without touching the schema.", "", "Second paragraph is not shown.", "", "## Constraints", "- none"].join("\n");
    assert.equal(parseBriefGoal(brief), "Ship the typed parser for reported statistics without touching the schema.");
  });

  it("is case-insensitive about the heading level and word, and strips a leading bullet", () => {
    assert.equal(parseBriefGoal("### GOAL\n- Do the thing\n"), "Do the thing");
    assert.equal(parseBriefGoal("# goal\nDo it\n"), "Do it");
  });

  it("clamps long goals with an ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const goal = parseBriefGoal(`## Goal\n${long}\n`, 40);
    assert.ok(goal!.length <= 40);
    assert.ok(goal!.endsWith("…"));
  });

  it("returns undefined for missing, empty, heading-only, fenced or non-text input", () => {
    assert.equal(parseBriefGoal(undefined), undefined);
    assert.equal(parseBriefGoal(""), undefined);
    assert.equal(parseBriefGoal("# Brief\n\n## Constraints\nnone\n"), undefined);
    assert.equal(parseBriefGoal("## Goal\n\n## Constraints\nnone\n"), undefined, "heading immediately followed by another heading");
    assert.equal(parseBriefGoal("## Goal\n```\ncode\n```\n"), undefined, "a code block is not a goal");
    assert.equal(parseBriefGoal("```\n## Goal\nfenced heading\n```\n"), undefined, "a heading inside a fence does not count");
    assert.equal(parseBriefGoal("\u0000\u0001 not markdown \u0002"), undefined);
  });

  it("is display-only: the model carries it, nothing else changes", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const withGoal = buildOverviewModel(selection, undefined, { ...ALL, briefText: "## Goal\nFix it.\n" }, T0);
    // No `## Goal`: the brief's own opening description stands in for it,
    // rather than a Markdown complaint aimed at whoever wrote the brief.
    const opening = buildOverviewModel(selection, undefined, { ...ALL, briefText: "# Stage brief: hotfix-1\n\nStop the crash on open.\n" }, T0);
    const nothing = buildOverviewModel(selection, undefined, { ...ALL, briefText: "# Stage brief: hotfix-1\n" }, T0);
    assert.equal(withGoal.goal, "Fix it.");
    assert.equal(opening.goal, "Stop the crash on open.");
    assert.equal(nothing.goal, undefined);
    assert.deepEqual({ ...withGoal, goal: undefined }, { ...nothing, goal: undefined });
    assert.equal(buildOverviewModel(selection, undefined, { ...ALL, brief: false, briefText: "## Goal\nstale\n" }, T0).goal, undefined, "no brief → no goal");
    assert.match(renderOverviewHtml(withGoal, "n", "c"), /Goal<\/h3><p class="goal">Fix it.<\/p>/);
    assert.ok(!/Goal<\/h3>/.test(renderOverviewHtml(nothing, "n", "c")), "nothing to say about the goal: no section, and no complaint");
    assert.ok(!/has no ## Goal/.test(renderOverviewHtml(nothing, "n", "c")));
  });
});

describe("meaningful-event selection", () => {
  const noise = [
    event("stage", "tool.call", { tool: "Bash" }),
    event("stage", "command.started"),
    event("stage", "command.finished", { exit_code: 0 }),
    event("stage", "provider.result"),
    event("stage", "file.changed", { path: ".sparring/stages/x/notes.md", kind: "modify" }),
  ];

  it("agrees with the Output renderer about what earns a line", () => {
    const renderer = new LogRenderer();
    const visible = [
      event("loop", "loop.started"),
      event("stage", "turn.started", { provider: "claude-cli" }),
      event("stage", "file.changed", { path: "src/a.py", kind: "modify" }),
      event("stage", "command.finished", { exit_code: 2 }),
      event("sparrer", "verdict", { action: "READY", summary: "ok" }),
    ];
    for (const e of visible) {
      assert.equal(isMeaningfulActivity(e), true, e.event);
      assert.ok(renderer.render(e), e.event);
    }
    for (const e of noise) {
      assert.equal(isMeaningfulActivity(e), false, e.event);
      assert.equal(renderer.render(e), undefined, e.event);
    }
  });

  it("the fold keeps the last meaningful event and ignores suppressed noise after it", () => {
    const finished = event("stage", "turn.finished", { summary: "3 files" });
    const live = foldEvents([event("stage", "turn.started"), finished, ...noise]);
    assert.equal(live.lastMeaningful?.event, "turn.finished");
    assert.equal(live.lastMeaningful?.ts, finished.ts);
    assert.equal(live.lastMeaningful?.description, "turn finished (3 files)");
    assert.notEqual(live.lastEventTs, finished.ts, "raw lastEventTs still advances on noise; the overview no longer shows it");
  });

  it("the overview activity line names the actor and the last visible event, never the noise", () => {
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" }), event("stage", "turn.finished"), ...noise]);
    const line = activityLine(live, false, Date.parse(live.lastEventTs!) + 5000);
    assert.equal(line.kind, "last");
    assert.equal(line.text, "Claude · turn finished", "a past fact, never 'Claude is editing'");
    assert.match(line.time ?? "", /^\d\d:\d\d:\d\d$/);
    assert.equal(activityLine(undefined, false, T0).kind, "none");
    assert.equal(activityLine(emptyLiveState(), false, T0).kind, "none");
  });
});

describe("recent events résumé", () => {
  it("keeps only the last few meaningful events, oldest first, and never the noise", () => {
    const events = [
      event("loop", "loop.started"),
      event("stage", "turn.started", { provider: "claude-cli" }),
      event("stage", "tool.call", { tool: "Read" }),
      event("stage", "file.changed", { path: "src/a.py", kind: "modify" }),
      event("stage", "command.finished", { exit_code: 0 }),
      event("stage", "file.changed", { path: "src/b.py", kind: "add" }),
      event("stage", "turn.finished"),
      event("sparrer", "sparring.started", { provider: "codex-cli" }),
      event("sparrer", "verdict", { action: "SEND_BACK", summary: "range handling" }),
    ];
    const live = foldEvents(events);
    assert.equal(live.recentMeaningful.length, 7, "loop, turn, a.py, b.py, finished, sparring, verdict");
    const entries = history(live)!;
    assert.deepEqual(
      entries.map((entry) => [entry.who, entry.description]),
      [
        ["Claude", "added src/b.py"],
        ["Claude", "turn finished"],
        ["Codex", "started"],
        ["Codex", "Changes requested — range handling"],
      ],
    );
    assert.ok(entries.every((entry) => /^\d\d:\d\d:\d\d$/.test(entry.time)));
    assert.equal(history(undefined), undefined);
    assert.equal(history(emptyLiveState()), undefined);
  });

  it("collapses a burst of edits to the same file into one entry with the latest time, like the Output Channel", () => {
    const first = event("stage", "file.changed", { path: "src/a.py", kind: "modify" });
    const second = event("stage", "file.changed", { path: "src/a.py", kind: "modify" });
    const live = foldEvents([first, event("stage", "tool.call"), second]);
    assert.equal(live.recentMeaningful.length, 1);
    assert.equal(live.recentMeaningful[0].ts, second.ts);
    live.recentMeaningful.length = 0;
    for (let i = 0; i < 12; i++) {
      applyEvent(live, event("stage", "file.changed", { path: `src/${i}.py`, kind: "add" }));
    }
    assert.equal(live.recentMeaningful.length, RECENT_MEANINGFUL_MAX, "bounded");
    assert.equal(history(live)!.length, HISTORY_MAX);
    assert.equal(history(live)![HISTORY_MAX - 1].description, "added src/11.py");
  });

  it("renders as a short list after the actors and is omitted without telemetry", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" }), event("stage", "file.changed", { path: "src/a.py", kind: "modify" })]);
    const html = renderOverviewHtml(buildOverviewModel(selection, live, ALL, Date.parse(live.lastEventTs!) + 1000), "n", "c");
    assert.match(html, /<section class="history"><h3><svg[^>]*>.*?<\/svg>Recent events<\/h3><ol><li><span class="time">\d\d:\d\d:\d\d<\/span><span class="who claude">Claude<\/span><span>turn started<\/span><\/li><li>.*changed src\/a.py<\/span><\/li><\/ol><\/section>/);
    assert.match(html, /Last meaningful event<\/h3><p><span class="time">\d\d:\d\d:\d\d<\/span><span class="sep">·<\/span><span class="who claude">Claude<\/span> changed src\/a.py<\/p>/);
    assert.ok(html.indexOf('<section class="actors">') < html.indexOf('<section class="history">'));
    const quiet = renderOverviewHtml(buildOverviewModel(selection, undefined, ALL, T0), "n", "c");
    assert.ok(!quiet.includes('class="history"'));
    // The rendered page, not the stylesheet or the event-handling script:
    // those mention the agent controls by name whether or not this run has
    // any, and the claim under test is about what a person is shown.
    const shown = quiet.slice(quiet.indexOf("<main>"), quiet.indexOf("</main>"));
    assert.ok(!/model|effort|Elapsed|Pause between|Tests passed|Pushed/i.test(shown), "no claims the telemetry cannot back");
  });
});

describe("active duration", () => {
  it("counts from the latest turn start or resume and clears when the turn ends", () => {
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "stage", event: "turn.started", provider: "claude-cli" });
    assert.equal(activeDurationMs(live.stage, T0 + 95_000), 95_000);
    applyEvent(live, { v: 1, ts: at(60), actor: "stage", event: "turn.started", resumed: true });
    assert.equal(activeDurationMs(live.stage, T0 + 95_000), 35_000, "a resume restarts the clock");
    applyEvent(live, { v: 1, ts: at(90), actor: "stage", event: "turn.finished" });
    assert.equal(live.stage.busySince, undefined);
    assert.equal(activeDurationMs(live.stage, T0 + 95_000), undefined);
  });

  it("formats as s / m s / h m", () => {
    assert.equal(formatDuration(5_000), "5s");
    assert.equal(formatDuration(192_000), "3m 12s");
    assert.equal(formatDuration(3_725_000), "1h 02m");
    assert.equal(formatDuration(-5), "0s");
  });

  it("Working for / Sparring for reaches the activity line and the actor cards; sparring wins when both are busy", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "stage", event: "turn.started", provider: "claude-cli" });
    // Certain "Working for" wording needs an observed-alive runner; telemetry alone reads as inferred.
    const running: ExecutionRecord = { id: "e", runId: selection.selected!.id, kind: "run-loop", source: "launched", state: "running", startedAtMs: T0 - 1000 };
    let model = buildOverviewModel(selection, live, ALL, T0 + 192_000, running);
    assert.deepEqual(model.activity, { kind: "active", text: "Working for 3m 12s · Claude" });
    assert.equal(model.stageAgent?.duration, "3m 12s");
    assert.equal(model.sparrer?.duration, undefined);

    applyEvent(live, { v: 1, ts: at(180), actor: "sparrer", event: "sparring.started", provider: "codex-cli" });
    model = buildOverviewModel(selection, live, ALL, T0 + 192_000, running);
    assert.deepEqual(model.activity, { kind: "active", text: "Sparring for 12s · Codex" });
    assert.equal(model.sparrer?.duration, "12s");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /Current activity<\/h3><p class="now"><span class="who codex">Codex<\/span> sparring for <span class="dur">12s<\/span><\/p>/);
    assert.match(html, /<div class="activity sparring"><svg[^>]*>.*?<\/svg>Sparring for 12s<\/div>/);
    assert.match(html, /<span class="avatar codex">C<\/span>/);
    assert.match(html, /<span class="hpill good"><svg[^>]*>.*?<\/svg>Working<\/span>/, "standalone working stage status pill");
  });

  it("a halted run shows no active duration even if telemetry claims busy", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "accepted", candidate_sha: "c" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const model = buildOverviewModel(selection, live, ALL, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(model.activity?.kind, "last");
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.stageAgent?.duration, undefined);
    assert.equal(model.cycle, undefined);
  });
});

describe("loop cycle", () => {
  it("is taken from the latest loop event that carries one and shown while running", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], {}, { "sparring.md": sparringMarkdown("SEND_BACK", "fix x") });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = foldEvents([event("loop", "loop.started"), event("sparrer", "verdict", { action: "SEND_BACK" }), event("loop", "loop.send_back", { cycle: 2 }), event("stage", "turn.started", { resumed: true })]);
    const model = buildOverviewModel(selection, live, ALL, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(model.cycle, 2);
    assert.equal(model.stageStatus, "Working", "a live correction turn is plainly Working");
    assert.equal(model.lastSparring?.word, "Changes requested", "the finding stays visible as the latest sparring result");
    assert.match(renderOverviewHtml(model, "n", "c"), /<span class="muted" title="loop cycle from telemetry">cycle 2<\/span>/);
    assert.equal(buildOverviewModel(selection, foldEvents([event("loop", "loop.started")]), ALL, T0).cycle, undefined, "no cycle reported yet");
  });
});

describe("plan journey states", () => {
  async function plan(status: "running" | "paused" | "complete", index: number, states: ("accepted" | "frozen" | "working" | undefined)[]) {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status, current_stage_index: index, current_stage: FOO_STAGE_IDS[index] });
    for (let i = 0; i < states.length; i++) {
      if (states[i]) {
        await ws.writeStage(FOO_STAGE_IDS[i], { status: states[i] });
      }
    }
    return selectRun((await discoverRuns([ws.location])).runs).selected as PlanRunSnapshot;
  }

  it("accepted, current, future", async () => {
    const run = await plan("running", 1, ["accepted", "working", undefined]);
    assert.deepEqual(
      run.stages.map((stage, i) => timelineState(stage, i, 1, run)),
      ["accepted", "active", "future"],
    );
    const model = buildOverviewModel({ selected: run, ambiguous: [] }, undefined, ALL, T0);
    assert.equal(model.position, "Stage 2 of 3");
    assert.deepEqual(model.timeline?.map((item) => item.current), [false, true, false]);
  });

  it("paused current stage and frozen current stage", async () => {
    const paused = await plan("paused", 1, ["accepted", "working", undefined]);
    assert.equal(timelineState(paused.stages[1], 1, 1, paused), "paused");
    const frozen = await plan("running", 2, ["accepted", "accepted", "frozen"]);
    assert.deepEqual(
      frozen.stages.map((stage, i) => timelineState(stage, i, 2, frozen)),
      ["accepted", "accepted", "finalizing"],
    );
  });

  it("a skipped-over earlier stage that is not accepted reads as working, not future", async () => {
    const run = await plan("running", 2, ["accepted", "working", "working"]);
    assert.equal(timelineState(run.stages[1], 1, 2, run), "working");
  });

  it("complete plan: every stage accepted, position still known", async () => {
    const run = await plan("complete", 2, ["accepted", "accepted", "accepted"]);
    const model = buildOverviewModel({ selected: run, ambiguous: [] }, undefined, ALL, T0);
    assert.deepEqual(model.timeline?.map((item) => item.state), ["accepted", "accepted", "accepted"]);
    assert.equal(model.position, "Stage 3 of 3");
  });

  it("without a readable plan document there is no journey and the position has no total", async () => {
    const ws = await Workspace.create();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 1, current_stage: FOO_STAGE_IDS[1] });
    await ws.writeStage(FOO_STAGE_IDS[1]);
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, ALL, T0);
    assert.equal(model.timeline, undefined);
    assert.match(model.timelineNote ?? "", /Plan document unavailable/);
    assert.equal(model.position, "Stage 2");
  });
});

describe("standalone-stage degradation", () => {
  it("invents no previous/next order, no position and no journey", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-reported-statistics-typed-parser", { status: "working", implementation_session_id: "abc", sparring_session_id: "def" }, { "sparring.md": sparringMarkdown("READY", "Looks done") });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, briefText: "## Goal\nParse it.\n" }, T0);
    assert.equal(model.timeline, undefined);
    assert.equal(model.timelineNote, undefined);
    assert.equal(model.position, undefined);
    assert.equal(model.stageHeading, "Reported statistics typed parser");
    assert.equal(model.goal, "Parse it.");
    assert.deepEqual(model.lastSparring, { action: "READY", word: "Review passed", summary: "Looks done", reason: undefined });
    assert.deepEqual(
      model.facts?.map((fact) => fact.label),
      ["Repository", "Engine state", "Stage session", "Sparring thread"],
    );
    const withGit = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, git: { branch: "feature/reported-statistics-contract", head: "82ab1234deadbeef" } }, T0);
    assert.deepEqual(withGit.facts?.[1], { label: "Checked out", value: "feature/reported-statistics-contract @ 82ab1234" });
    const detached = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { ...ALL, git: { head: "82ab1234deadbeef" } }, T0);
    assert.deepEqual(detached.facts?.[1], { label: "Checked out", value: "(detached) @ 82ab1234" });
    const html = renderOverviewHtml(model, "n", "c");
    assert.ok(!html.includes('class="journey"'));
    assert.ok(!/Stage \d+ (of|\/) \d+/.test(html), "no position pill without a plan");
    assert.match(html, /<span class="hpill" [^>]*>Standalone stage<\/span>/);
    assert.match(html, /<span class="verdict ready" title="Routing action: READY">Review passed<\/span>/);
    assert.equal(model.status?.label, "Review complete");
  });
});
