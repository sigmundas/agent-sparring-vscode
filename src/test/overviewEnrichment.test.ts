import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMeaningfulActivity } from "../core/activityFilter";
import { parseBriefGoal, parseBriefOpening } from "../core/brief";
import { discoverRuns, selectRun, type PlanRunSnapshot } from "../core/discovery";
import { RECENT_MEANINGFUL_MAX, activeDurationMs, applyEvent, emptyLiveState, foldEvents, formatDuration } from "../core/liveState";
import type { ExecutionRecord } from "../core/liveness";
import { LogRenderer } from "../core/logFormat";
import { HISTORY_MAX, activityLine, buildOverviewModel, history, timelineState, type OverviewArtifacts } from "../core/overviewModel";
import { renderOverviewHtml } from "../core/overviewHtml";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_PLAN_MARKDOWN, FOO_STAGE_IDS, Workspace, event, sparringMarkdown } from "./fixtures";

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

  const INTAKE_STYLE_BRIEF_PREFIX = [
    "# Stage brief: foo-1cd13d24-stage-1-contract",
    "",
    "Stage 1 (1 of 2 in run slice `app`) from plan `docs/plans/foo.md`, prepared by plan intake. Implement only this stage; the other stages are separate.",
    "",
    "# Plan context",
    "",
    "Plan-wide text this stage is bound by, quoted verbatim from the source plan.",
    "",
    "## Principles",
    "",
    "Widget identity never changes.",
    "",
  ];

  it("parseBriefOpening never picks intake's own Plan context / Intake scoping boilerplate", () => {
    const brief = [...INTAKE_STYLE_BRIEF_PREFIX, "# Stage source", "", "## Stage 1 — Contract", "", "This is the brief's own quoted excerpt.", ""].join("\n");
    const opening = parseBriefOpening(brief);
    assert.equal(opening, "This is the brief's own quoted excerpt.");
    assert.ok(!opening?.includes("Plan-wide text"), "never the Plan context preamble");

    const scoped = [...INTAKE_STYLE_BRIEF_PREFIX, "# Stage source", "", "## Stage 1 — Contract", "", "Quoted stage text.", "", "# Intake scoping", "", "This block was written by plan intake; it is not text from the source plan.", "", "Implementation only; the production run is a separate gated action."].join("\n");
    assert.equal(parseBriefOpening(scoped), "Quoted stage text.", "an Intake scoping note is never a stage description either");
  });

  it("an old brief without ## Goal falls back to the plan's own structured summary, never the brief's Plan context boilerplate", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], {});
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    // An old, pre-`## Goal` intake brief: its own opening paragraph (under
    // "# Stage source") reads differently from what the live plan document
    // now says, so which one wins is observable.
    const briefText = [...INTAKE_STYLE_BRIEF_PREFIX, "# Stage source", "", "## Stage 1 — Contract", "", "The brief's own stale excerpt, not the live plan text.", ""].join("\n");
    const model = buildOverviewModel(selection, undefined, { ...ALL, briefText, planText: FOO_PLAN_MARKDOWN }, T0);
    assert.equal(model.goal, "Define the contract.", "the plan document's own structured summary, not the brief's prose");
    assert.ok(!/Plan-wide text|stale excerpt/.test(model.goal ?? ""));
  });
});

describe("meaningful-event selection", () => {
  const noise = [
    event("stage", "tool.call", { tool: "Bash" }),
    event("stage", "command.started"),
    event("stage", "command.finished", { exit_code: 0 }),
    event("stage", "provider.result"),
    // Several a minute while a turn runs, and never a fact about the work:
    // the numbers belong on the dials, not in the log.
    event("stage", "provider.usage", { input_tokens: 2, output_tokens: 16 }),
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

  it("a session announcement is never shown as Last activity or in Recent events", () => {
    const live = foldEvents([
      event("stage", "turn.started", { provider: "claude-cli" }),
      event("stage", "file.changed", { path: "src/a.py", kind: "modify" }),
      event("stage", "turn.finished"),
      event("stage", "session.observed", { provider: "claude-cli", session_id: "fc43f253aaaa", model: "claude-opus-5-5" }),
    ]);
    const line = activityLine(live, false, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(line.kind, "last");
    assert.equal(line.text, "Claude · turn finished", "never 'session fc43f253… (claude-opus-5-5)'");
    assert.deepEqual(
      history(live)!.map((entry) => entry.description),
      ["started work", "changed src/a.py", "turn finished"],
    );
  });

  it("a resumed turn becomes 'resumed work', not the engine's own 'turn resumed'", () => {
    // Halted (a plan not currently running) so this reads as the last past
    // fact rather than a currently-active turn, which is what makes "the
    // most recent meaningful thing" here the resume itself.
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli", resumed: true })]);
    const line = activityLine(live, true, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(line.text, "Claude · resumed work");
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
    assert.match(html, /<section class="history"><h3><svg[^>]*>.*?<\/svg>Recent events<\/h3><ol><li><span class="time">\d\d:\d\d:\d\d<\/span><span class="who claude">Claude<\/span><span>started work<\/span><\/li><li>.*changed src\/a.py<\/span><\/li><\/ol><\/section>/);
    assert.match(html, /Last activity<\/h3><p><span class="time">\d\d:\d\d:\d\d<\/span><span class="sep">·<\/span><span class="who claude">Claude<\/span> changed src\/a.py<\/p>/);
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
    assert.deepEqual(model.activity, { kind: "active", text: "Working for 3m 12s · Claude", description: "Working on the implementation", elapsed: "Working for 3m 12s" });
    assert.equal(model.stageAgent?.duration, "3m 12s");
    assert.equal(model.sparrer?.duration, undefined);

    applyEvent(live, { v: 1, ts: at(180), actor: "sparrer", event: "sparring.started", provider: "codex-cli" });
    model = buildOverviewModel(selection, live, ALL, T0 + 192_000, running);
    assert.deepEqual(model.activity, { kind: "active", text: "Sparring for 12s · Codex", description: "Reviewing the latest changes", elapsed: "Sparring for 12s" });
    assert.equal(model.sparrer?.duration, "12s");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /Current activity<\/h3><p class="now"><span class="who codex">Codex<\/span> Reviewing the latest changes<\/p><p class="elapsed muted">Sparring for 12s<\/p>/);
    // A confirmed turn: the pill carries the state and how long it has been
    // true, in the card's corner.
    assert.match(html, /<span class="statepill sparring"><svg[^>]*>.*?<\/svg><span>Sparring for 12s<\/span><\/span>/);
    assert.match(html, /<span class="avatar codex"><svg class="glyph"[^>]*>.*?<\/svg><\/span>/);
    assert.match(html, /<span class="hpill good"><svg[^>]*>.*?<\/svg>Working<\/span>/, "standalone working stage status pill");
  });

  it("a shell command in flight counts as current activity and is never presented as 'no meaningful activity'", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "stage", event: "turn.started", provider: "claude-cli" });
    applyEvent(live, { v: 1, ts: at(1), actor: "stage", event: "command.started", tool: "Bash" });
    assert.equal(live.stage.commandBusy, true, "the command has not reported finishing");

    const running: ExecutionRecord = { id: "e", runId: selection.selected!.id, kind: "run-loop", source: "launched", state: "running", startedAtMs: T0 - 1000 };
    const model = buildOverviewModel(selection, live, ALL, T0 + 192_000, running);
    assert.equal(model.activity?.kind, "active");
    assert.equal(model.activity?.description, "Running a command");
    assert.equal(model.stageAgent?.quietFor, undefined, "an in-flight command is demonstrable activity, not silence");

    // The same fact must stop the "no meaningful activity for Xm" wording
    // that a long, otherwise-silent command would otherwise earn: telemetry
    // only (no observed runner process), 40 minutes on from the one
    // command.started event and nothing since.
    const stale = buildOverviewModel(selection, live, ALL, T0 + 40 * 60_000);
    assert.notEqual(stale.activity?.kind, "stale");
    applyEvent(live, { v: 1, ts: at(2), actor: "stage", event: "command.finished", tool: "Bash", exit_code: 0 });
    assert.equal(live.stage.commandBusy, false);
  });

  it("tracks parallel commands by id: the first to finish does not end the second", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "stage", event: "turn.started", provider: "claude-cli" });
    applyEvent(live, { v: 1, ts: at(1), actor: "stage", event: "command.started", tool: "Bash", tool_use_id: "toolu_a" });
    applyEvent(live, { v: 1, ts: at(2), actor: "stage", event: "command.started", tool: "Bash", tool_use_id: "toolu_b" });
    applyEvent(live, { v: 1, ts: at(3), actor: "stage", event: "command.finished", tool: "Bash", tool_use_id: "toolu_a" });
    assert.equal(live.stage.commandBusy, true, "toolu_b has not reported finishing");
    assert.equal(live.stage.commandSince, at(2), "measured from the command still running");

    const stale = buildOverviewModel(selection, live, ALL, T0 + 40 * 60_000);
    assert.notEqual(stale.activity?.kind, "stale");
    assert.equal(stale.stageAgent?.quietFor, undefined);

    // A finish for an id never seen starting changes nothing.
    applyEvent(live, { v: 1, ts: at(4), actor: "stage", event: "command.finished", tool: "Bash", tool_use_id: "toolu_zzz" });
    assert.equal(live.stage.commandBusy, true);
    applyEvent(live, { v: 1, ts: at(5), actor: "stage", event: "command.finished", tool: "Bash", tool_use_id: "toolu_b" });
    assert.equal(live.stage.commandBusy, false);
    assert.equal(live.stage.commandSince, undefined);
  });

  it("counts commands that carry no id (Codex), one finish per start", () => {
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "sparrer", event: "sparring.started", provider: "codex-cli" });
    applyEvent(live, { v: 1, ts: at(1), actor: "sparrer", event: "command.started", tool: "shell" });
    applyEvent(live, { v: 1, ts: at(2), actor: "sparrer", event: "command.started", tool: "shell" });
    applyEvent(live, { v: 1, ts: at(3), actor: "sparrer", event: "command.finished", tool: "shell", exit_code: 0 });
    assert.equal(live.sparrer.commandBusy, true);
    applyEvent(live, { v: 1, ts: at(4), actor: "sparrer", event: "command.finished", tool: "shell", exit_code: 0 });
    assert.equal(live.sparrer.commandBusy, false);
    applyEvent(live, { v: 1, ts: at(5), actor: "sparrer", event: "command.finished", tool: "shell", exit_code: 0 });
    assert.equal(live.sparrer.commandBusy, false, "an unmatched finish never goes negative");
  });

  it("a subagent's tool calls count as activity, though they earn no Output line", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const live = emptyLiveState();
    applyEvent(live, { v: 1, ts: at(0), actor: "stage", event: "turn.started", provider: "claude-cli" });
    applyEvent(live, { v: 1, ts: at(1), actor: "stage", event: "subagent.started", tool: "Task", tool_use_id: "toolu_task" });
    applyEvent(live, { v: 1, ts: at(20 * 60), actor: "stage", event: "tool.call", tool: "Read", parent_id: "toolu_task" });
    const running: ExecutionRecord = { id: "e", runId: selection.selected!.id, kind: "run-loop", source: "launched", state: "running", startedAtMs: T0 - 1000 };
    const model = buildOverviewModel(selection, live, ALL, T0 + 21 * 60_000, running);
    assert.equal(model.stageAgent?.quietFor, undefined, "a tool call a minute ago is not silence");
    // Long after the last tool call, the turn is quiet again.
    const later = buildOverviewModel(selection, live, ALL, T0 + 40 * 60_000, running);
    assert.ok(later.stageAgent?.quietFor);
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
    assert.equal(model.lastSparring?.badge, "Changes requested", "the finding stays visible as the latest sparring result");
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
    assert.deepEqual(model.lastSparring, {
      action: "READY",
      badge: "Approved",
      summary: "Looks done",
      reason: undefined,
      report: "Long findings that must never reach the status bar.",
    });
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
    assert.match(html, /<span class="verdict ready" title="Routing action: READY">Approved<\/span>/);
    assert.equal(model.status?.label, "Review complete");
  });
});
