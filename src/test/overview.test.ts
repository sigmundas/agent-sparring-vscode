import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun, type RunSelection } from "../core/discovery";
import { foldEvents } from "../core/liveState";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, shortenId, type OverviewArtifacts } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, event, sparringMarkdown } from "./fixtures";

const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const ALL: OverviewArtifacts = { handoff: true, sparring: true, brief: true, plan: true };
const NONE: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };

async function planWorkspace(status: "running" | "paused" | "complete", index: number, options: { sparring?: string; stageState?: Record<string, unknown>; plan?: boolean } = {}) {
  const ws = await Workspace.create();
  if (options.plan !== false) {
    await ws.writePlan();
  }
  await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status, current_stage_index: index, current_stage: FOO_STAGE_IDS[index] });
  for (let i = 0; i < index; i++) {
    await ws.writeStage(FOO_STAGE_IDS[i], { status: "accepted", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) });
  }
  const state = { status: status === "complete" ? "accepted" : "working", ...(options.stageState ?? {}) } as Parameters<Workspace["writeStage"]>[1];
  await ws.writeStage(FOO_STAGE_IDS[index], state, options.sparring ? { "sparring.md": options.sparring } : {});
  return ws;
}

async function selection(ws: Workspace): Promise<RunSelection> {
  return selectRun((await discoverRuns([ws.location])).runs);
}

describe("overview view model", () => {
  it("active multi-stage plan: accepted, active and future stages; live actors", async () => {
    const ws = await planWorkspace("running", 1, { stageState: { implementation_session_id: "82ab1234deadbeef", sparring_session_id: "019d" } });
    const live = foldEvents([event("loop", "loop.started"), event("stage", "turn.started", { provider: "claude-cli", session_id: "82ab1234deadbeef" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, Date.parse(live.lastEventTs!) + 1000);

    assert.equal(model.kind, "run");
    assert.deepEqual(
      model.timeline?.map((item) => [item.number, item.state, item.current]),
      [
        [1, "accepted", false],
        [2, "active", true],
        [3, "future", false],
      ],
    );
    assert.equal(model.timeline?.[1].title, "Schema & API");
    assert.equal(model.stageHeading, "Stage 2 — Schema & API");
    assert.equal(model.stageStatus, "working");
    assert.equal(model.stageLine, "Implementing.");
    assert.equal(model.stageAgent?.provider, "Claude");
    assert.equal(model.stageAgent?.activity, "Working");
    assert.equal(model.stageAgent?.sessionLabel, "82ab1234…");
    assert.equal(model.sparrer?.provider, "Codex");
    assert.equal(model.sparrer?.activity, "Waiting");
    assert.equal(model.sparrer?.sessionLabel, "019d");
    assert.equal(model.actions?.handoff, true);
    assert.equal(model.actions?.diff, undefined, "no base_sha recorded → no diff action");
    assert.deepEqual(model.facts?.slice(0, 3), [
      { label: "Repository", value: "repo" },
      { label: "Plan", value: "running" },
      { label: "Expected branch", value: "feature/x" },
    ]);
  });

  it("SEND_BACK outcome on a running stage reads as correcting", async () => {
    const ws = await planWorkspace("running", 2, { sparring: sparringMarkdown("SEND_BACK", "Empty vs missing statistics state conflated."), stageState: { base_sha: "a".repeat(40) } });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.stageLine, "Correcting SEND_BACK finding");
    assert.deepEqual(model.lastSparring, { action: "SEND_BACK", summary: "Empty vs missing statistics state conflated.", reason: undefined });
    assert.equal(model.actions?.diff?.label, "Diff");
    assert.equal(model.actions?.diff?.detail, "base aaaaaaaa… … current HEAD");
    assert.equal(model.actions?.diff?.targetSha, undefined);
    assert.equal(model.stageStatus, "SEND_BACK · correcting");
    assert.equal(model.sparrer?.activity, "Waiting");
  });

  it("sparring in progress overrides the stale SEND_BACK line", async () => {
    const ws = await planWorkspace("running", 0, { sparring: sparringMarkdown("SEND_BACK", "x") });
    const live = foldEvents([event("sparrer", "sparring.started", { provider: "codex-cli" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.equal(model.stageLine, "Under sparring.");
    assert.equal(model.sparrer?.activity, "Sparring");
  });

  it("paused NEEDS_YOU makes the stop obvious and idles both actors despite busy telemetry", async () => {
    const ws = await planWorkspace("paused", 1, { sparring: sparringMarkdown("NEEDS_YOU", "Check on a Pixel 7", "device_manual_check") });
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.deepEqual(model.banner, { kind: "stop", text: "NEEDS_YOU — Check on a Pixel 7" });
    assert.equal(model.timeline?.[1].state, "paused");
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.lastSparring?.reason, "device_manual_check");
    assert.match(model.stageLine ?? "", /Waiting for you/);
  });

  it("ESCALATE", async () => {
    const ws = await planWorkspace("paused", 0, { sparring: sparringMarkdown("ESCALATE", "Needs a stronger sparrer") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.banner?.kind, "stop");
    assert.match(model.banner?.text ?? "", /^ESCALATE — Needs a stronger sparrer/);
  });

  it("failure pause without a stop verdict shows Paused with the recorded reason", async () => {
    const ws = await planWorkspace("paused", 0, { sparring: sparringMarkdown("READY", "fine") });
    const live = foldEvents([event("plan", "plan.failed", { summary: "acceptance gate refused" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.deepEqual(model.banner, { kind: "warn", text: "Paused — acceptance gate refused" });
  });

  it("completed plan", async () => {
    const ws = await planWorkspace("complete", 2, { stageState: { base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) } });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.deepEqual(model.banner, { kind: "done", text: "Plan complete — 3 stages accepted" });
    assert.deepEqual(
      model.timeline?.map((item) => item.state),
      ["accepted", "accepted", "accepted"],
    );
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.actions?.diff?.label, "Diff");
    assert.equal(model.actions?.diff?.detail, "base bbbbbbbb… … candidate cccccccc…");
    assert.equal(model.actions?.diff?.targetSha, "c".repeat(40));
  });

  it("frozen current stage is distinguished from accepted", async () => {
    const ws = await planWorkspace("running", 1, { stageState: { status: "frozen", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) } });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.timeline?.[1].state, "frozen");
    assert.equal(model.stageLine, "Candidate frozen; awaiting acceptance.");
  });

  it("missing plan document degrades to a note without inventing stages", async () => {
    const ws = await planWorkspace("running", 0, { plan: false });
    const model = buildOverviewModel(await selection(ws), undefined, { ...ALL, plan: false }, NOW);
    assert.equal(model.timeline, undefined);
    assert.match(model.timelineNote ?? "", /Plan document unavailable/);
    assert.equal(model.stageHeading, "Stage 1 — Contract", "humanized from the id, never the raw id");
    assert.equal(model.stageId, FOO_STAGE_IDS[0]);
    assert.equal(model.actions?.plan, false);
  });

  it("missing handoff/sparring files disable their buttons", async () => {
    const ws = await planWorkspace("running", 0);
    const model = buildOverviewModel(await selection(ws), undefined, NONE, NOW);
    assert.equal(model.actions?.handoff, false);
    assert.equal(model.actions?.sparring, false);
    assert.equal(model.lastSparring, undefined);
  });

  it("standalone stage omits the timeline", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working", implementation_session_id: "s".repeat(20) }, { "sparring.md": sparringMarkdown("NEEDS_YOU", "Pick a colour") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.timeline, undefined);
    assert.equal(model.timelineNote, undefined);
    assert.equal(model.stageHeading, "Hotfix 1");
    assert.equal(model.title, "Hotfix 1");
    assert.equal(model.stageId, "hotfix-1");
    assert.equal(model.banner?.kind, "stop");
    assert.equal(model.stageAgent?.sessionLabel, "ssssssss…");
    assert.equal(model.actions?.plan, false);
  });

  it("accepted standalone stage presents as complete and keeps its actions", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-local-schema-barrier", { status: "accepted", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40), implementation_session_id: "82ab" }, { "sparring.md": sparringMarkdown("READY", "Done") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.kind, "run");
    assert.equal(model.title, "Local schema barrier");
    assert.equal(model.stageStatus, "ACCEPTED · stage complete");
    assert.deepEqual(model.banner, { kind: "done", text: "Stage complete — candidate accepted" });
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.actions?.diff?.label, "Diff");
    assert.equal(model.actions?.handoff, true);
    assert.equal(model.actions?.sparring, true);
    assert.equal(model.actions?.brief, true);
    assert.ok(!model.facts?.some((fact) => fact.label === "Last activity"), "the Ns-ago row is gone");
    assert.deepEqual(model.facts?.slice(1, 3), [
      { label: "Base", value: "bbbbbbbb…" },
      { label: "Candidate", value: "cccccccc…" },
    ]);
    assert.deepEqual(model.activity, { kind: "none", text: "No activity telemetry for this stage." });
  });

  it("empty and ambiguous selections", async () => {
    assert.equal(buildOverviewModel({ ambiguous: [] }, undefined, NONE, NOW).kind, "empty");
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlan("docs/plans/bar.md", "## Stage 1 — Only\nbody\n");
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writePlanRun("bar-00000000", { plan: "docs/plans/bar.md", status: "paused", current_stage_index: 0, current_stage: "bar-00000000-stage-1-only" });
    const model = buildOverviewModel(await selection(ws), undefined, NONE, NOW);
    assert.equal(model.kind, "ambiguous");
    assert.deepEqual(model.choices, ["repo: docs/plans/bar.md", "repo: docs/plans/foo.md"]);
  });

  it("READY on a working stage presents as awaiting acceptance", async () => {
    const ws = await planWorkspace("running", 1, { sparring: sparringMarkdown("READY", "Looks complete") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.stageStatus, "READY · awaiting acceptance");
    assert.equal(model.stageStatusKind, "ready");
    assert.equal(model.stageLine, "Sparrer said READY; acceptance pending.");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<span class="status ready">READY · awaiting acceptance<\/span>/);
    assert.match(html, /<span class="verdict ready">READY<\/span>/);
    assert.ok(!/<span class="status[^>]*>working</.test(html));
  });

  it("shortens ids", () => {
    assert.equal(shortenId("82ab1234deadbeef"), "82ab1234…");
    assert.equal(shortenId("short"), "short");
    assert.equal(shortenId(null), undefined);
    assert.equal(shortenId("   "), undefined);
  });
});

describe("overview HTML", () => {
  const HOSTILE = "<script>alert(1)</script> & \"quotes\" 'apos'";

  it("escapes hostile titles, summaries and provider text", async () => {
    const ws = await Workspace.create();
    const stageId = "bar-00000000-stage-1-script-alert-1-script";
    await ws.writePlan("docs/plans/bar.md", `## Stage 1 — ${HOSTILE}\nbody\n`);
    await ws.writePlanRun("bar-00000000", { plan: "docs/plans/bar.md", status: "running", current_stage_index: 0, current_stage: stageId, expected_branch: HOSTILE });
    await ws.writeStage(stageId, {}, { "sparring.md": sparringMarkdown("SEND_BACK", HOSTILE) });
    const live = foldEvents([event("stage", "turn.started", { provider: HOSTILE })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    const html = renderOverviewHtml(model, "NONCE", "vscode-webview://x");
    assert.ok(!html.includes("<script>alert"), "raw script tag must not survive");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;apos&#39;"));
    assert.ok(!html.includes(ws.root), "no filesystem paths in the document");
  });

  it("carries a strict CSP with the nonce and no remote sources", () => {
    const html = renderOverviewHtml({ kind: "empty", title: "No active run" }, "abc123", "vscode-webview://x");
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-abc123'/);
    assert.match(html, /style-src 'nonce-abc123'/);
    assert.ok(!/https?:\/\//.test(html));
    assert.match(html, /<script nonce="abc123">/);
  });

  it("shows, disables and hides buttons according to the model", async () => {
    const ws = await planWorkspace("running", 0, { stageState: { base_sha: "b".repeat(40) } });
    const withAll = renderOverviewHtml(buildOverviewModel(await selection(ws), undefined, ALL, NOW), "n", "c");
    assert.match(withAll, /<button type="button" data-action="openDiff" title="base bbbbbbbb… … current HEAD">Diff<\/button>/);
    assert.match(withAll, /<button type="button" data-action="openHandoff" title="Open handoff.md">Handoff<\/button>/);
    assert.match(withAll, />Sparring report<\/button>/);
    assert.match(withAll, />Log<\/button>/);
    assert.match(withAll, /data-action="openPlan"/);

    const withNone = renderOverviewHtml(buildOverviewModel(await selection(ws), undefined, NONE, NOW), "n", "c");
    assert.match(withNone, /<button type="button" data-action="openHandoff" title="Open handoff.md" disabled>Handoff<\/button>/);
    assert.match(withNone, /data-action="openSparring" title="Open sparring.md" disabled/);
    assert.ok(!withNone.includes('data-action="openPlan"'));

    const ws2 = await planWorkspace("running", 0);
    const noDiff = renderOverviewHtml(buildOverviewModel(await selection(ws2), undefined, ALL, NOW), "n", "c");
    assert.ok(!noDiff.includes('data-action="openDiff"'));
  });

  it("renders the compact journey, the primary stage block and the small actor cards", async () => {
    const ws = await planWorkspace("paused", 1, { sparring: sparringMarkdown("NEEDS_YOU", "Check") });
    const html = renderOverviewHtml(buildOverviewModel(await selection(ws), undefined, ALL, NOW), "n", "c");
    assert.match(html, /<ol class="journey"><li class="step accepted" title="Stage 1 — Contract \(Accepted\)"><span class="node"><svg class="icon " [^>]*>.*?<\/svg><\/span><span class="num">1<\/span><span class="name">Contract<\/span><span class="state"><svg[^>]*>.*?<\/svg>Accepted<\/span><\/li>/);
    assert.match(html, /<li class="step paused current" [^>]*>.*?<span class="name">Schema &amp; API<\/span><span class="state">Paused<\/span><\/li>/);
    assert.match(html, /<li class="step future" [^>]*><span class="node">3<\/span>.*?<span class="state">Pending<\/span><\/li>/);
    assert.match(html, /<span class="hpill" title="docs\/plans\/foo.md">Plan run<\/span><span class="hpill">Stage 2 \/ 3<\/span><span class="hpill warn"><svg[^>]*>.*?<\/svg>NEEDS_YOU<\/span>/);
    assert.match(html, /<h2 [^>]*><svg class="icon accent needs_you"[^>]*>.*?<\/svg>Stage 2 — Schema &amp; API<\/h2>/);
    assert.match(html, /<span class="status needs_you">NEEDS_YOU<\/span>/);
    assert.equal((html.match(/<div class="card actor">/g) ?? []).length, 2);
    assert.ok(html.indexOf('<section class="card stage">') < html.indexOf('<section class="actors">'), "stage before actors");
    assert.ok(html.indexOf('<section class="actors">') < html.indexOf('<dl class="facts">'), "metadata last");
    assert.match(html, /<div class="banner stop">NEEDS_YOU — Check<\/div>/);
    assert.ok(!html.includes("Last activity"));
  });

  it("ambiguous model lists the choices and offers selection", () => {
    const html = renderOverviewHtml({ kind: "ambiguous", title: "Several runs look active", choices: ["a.md", "<b>.md"] }, "n", "c");
    assert.match(html, /<li>&lt;b&gt;.md<\/li>/);
    assert.match(html, /data-action="selectRun"/);
  });
});
