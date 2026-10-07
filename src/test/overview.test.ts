import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRepositoryContext } from "../core/activeRepository";
import { discoverRuns, selectRun, type RunSelection } from "../core/discovery";
import { foldEvents } from "../core/liveState";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, shortenId, type OverviewArtifacts } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, event, normalUi, sparringMarkdown } from "./fixtures";

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
    assert.equal(model.stageStatus, "Working");
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
      { label: "Feature branch", value: "feature/x" },
    ]);
  });

  it("a cross-repository stage's siblings sit quietly in the metadata, each said only as far as the data goes", async () => {
    const ws = await planWorkspace("running", 1, {
      stageState: {
        repositories: [
          { name: "sporely-web", path: "../sporely-web-worktree", branch: "feature/cloud", candidate_sha: "d".repeat(40) },
          { name: "sporely-docs", path: "../docs", branch: "main", candidate_sha: null },
        ],
      },
    });
    const model = buildOverviewModel(await selection(ws), undefined, { ...ALL, siblingRepositories: [{ name: "sporely-mobile", path: "/Code/sporely-mobile", branch: "feature/cloud" }] }, NOW);

    assert.deepEqual(
      model.facts?.filter((fact) => fact.label === "Also reviews").map((fact) => fact.value),
      [
        // Recorded by the engine, no commit pinned yet.
        "sporely-docs on main (recorded for this stage)",
        // Declared in this window; the engine has not seen it yet.
        "sporely-mobile on feature/cloud (declared in VS Code)",
        // Pinned at the freeze boundary; acceptance re-verifies this commit.
        `sporely-web on feature/cloud @ ${shortenId("d".repeat(40))} (pinned by the engine)`,
      ],
    );
  });

  it("an ordinary single-repository stage says nothing about siblings", async () => {
    const model = buildOverviewModel(await selection(await planWorkspace("running", 1)), undefined, ALL, NOW);
    assert.deepEqual(
      model.facts?.filter((fact) => fact.label === "Also reviews"),
      [],
    );
  });

  it("SEND_BACK outcome on a running stage reads as correcting", async () => {
    const ws = await planWorkspace("running", 2, { sparring: sparringMarkdown("SEND_BACK", "Empty vs missing statistics state conflated."), stageState: { base_sha: "a".repeat(40) } });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.stageLine, "The independent reviewer found something to fix. Work will continue automatically.");
    assert.deepEqual(model.lastSparring, {
      action: "SEND_BACK",
      badge: "Changes requested",
      summary: "Empty vs missing statistics state conflated.",
      reason: undefined,
      report: "Long findings that must never reach the status bar.",
    });
    assert.equal(model.actions?.diff?.label, "Diff");
    assert.equal(model.actions?.diff?.detail, "base aaaaaaaa… … current HEAD");
    assert.equal(model.actions?.diff?.targetSha, undefined);
    assert.equal(model.stageStatus, "Changes requested");
    assert.equal(model.stageRaw, "working · SEND_BACK");
    assert.equal(model.sparrer?.activity, "Waiting");
  });

  it("sparring in progress overrides the stale SEND_BACK line", async () => {
    const ws = await planWorkspace("running", 0, { sparring: sparringMarkdown("SEND_BACK", "x") });
    const live = foldEvents([event("sparrer", "sparring.started", { provider: "codex-cli" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.equal(model.stageLine, "Under independent review.");
    assert.equal(model.sparrer?.activity, "Sparring");
  });

  it("paused NEEDS_YOU makes the stop obvious and idles both actors despite busy telemetry", async () => {
    const ws = await planWorkspace("paused", 1, { sparring: sparringMarkdown("NEEDS_YOU", "Check on a Pixel 7", "device_manual_check") });
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.equal(model.banner, undefined, "the Action required panel replaces the banner");
    assert.equal(model.actionRequired?.kind, "needs_you");
    assert.equal(model.actionRequired?.summary, "Check on a Pixel 7");
    assert.equal(model.actionRequired?.reviewerNote, "device_manual_check");
    assert.deepEqual(model.actionRequired?.resume, { action: "resumePlan", label: "Resume plan", detail: model.planAction?.detail });
    assert.equal(model.actionRequired?.submit.enabled, false, "nothing recorded yet");
    assert.equal(model.status?.label, "Needs you");
    assert.equal(model.planAction?.label, "Resume plan");
    assert.equal(model.planAction?.primary, false, "the human request is primary, not the button");
    assert.equal(model.timeline?.[1].state, "paused");
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.lastSparring?.reason, "device_manual_check");
    assert.match(model.stageLine ?? "", /Waiting for you/);
  });

  it("NEEDS_YOU with no turn in progress is the Action required hand-back, badged 'Needs you' underneath it", async () => {
    const ws = await planWorkspace("paused", 1, { sparring: sparringMarkdown("NEEDS_YOU", "Return to the stage agent and tell it the account is provisioned.", "device_manual_check") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.actionRequired?.kind, "needs_you", "the hand-back panel is up: no turn is in progress");
    assert.equal(model.lastSparring?.badge, "Needs you");
    assert.equal(model.lastSparring?.action, "NEEDS_YOU");
  });

  it("a resumed turn after NEEDS_YOU reads as 'Your input was accepted', never the reviewer's stage-agent-addressed prose", async () => {
    const ws = await planWorkspace("running", 1, {
      sparring: sparringMarkdown("NEEDS_YOU", "Return to the stage agent and tell it the account is provisioned.", "device_manual_check"),
    });
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli", resumed: true })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.equal(model.actionRequired, undefined, "the hand-back panel is gone: a turn is in progress again");
    assert.equal(model.stageStatus, "Working");
    assert.equal(model.lastSparring?.action, "NEEDS_YOU", "sparring.md itself still literally says NEEDS_YOU");
    assert.equal(model.lastSparring?.badge, "Your input was accepted");
    assert.ok(
      !model.lastSparring?.summary?.includes("Return to the stage agent"),
      "the reviewer's prose, addressed to the stage agent, is never the primary summary",
    );
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<span class="verdict needs_you"[^>]*>Your input was accepted<\/span>/);
    assert.ok(!html.includes("Return to the stage agent"));
  });

  it("Read feedback expands the reviewer's full report inline, and it can still be opened in the editor", async () => {
    const ws = await planWorkspace("running", 0, {
      sparring: sparringMarkdown("SEND_BACK", "Fix the boundary check."),
    });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.lastSparring?.report, "Long findings that must never reach the status bar.");
    const html = renderOverviewHtml(model, "n", "c");
    // The verdict is on the Sparrer card, not in the stage card.
    const stageCard = html.slice(html.indexOf('<section class="card stage">'), html.indexOf('<section class="actors">'));
    assert.ok(!stageCard.includes("Latest sparring result") && !stageCard.includes("sparverdict"), "the stage card no longer carries the result");
    const sparrerCard = /<div class="card actor [^"]*" data-role="sparrer">[\s\S]*?<div class="cardfoot">[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? "";
    assert.match(sparrerCard, /<div class="sparresult"><p class="sparverdict"><span class="verdict send_back"[^>]*>Changes requested<\/span>/);
    // The verdict sits under the settings, so the two cards' controls line up.
    assert.ok(sparrerCard.includes("agentconfig-block") && sparrerCard.indexOf("agentconfig-block") < sparrerCard.indexOf("sparresult"), "the verdict follows the model and effort controls");
    // Read feedback is a tab on the Sparrer card's footer line; the report opens below both cards.
    assert.match(sparrerCard, /<button type="button" class="showinstr" data-instr="feedback" aria-controls="feedback-sparrer" aria-expanded="false" data-show="Read feedback" data-hide="Hide feedback">Read feedback<\/button>/);
    assert.match(html, /<div class="instrpanel [^"]*" id="feedback-sparrer" data-instrpanel="feedback"[^>]* hidden>[\s\S]*?<div class="reportbody"><p>Long findings that must never reach the status bar\.<\/p><\/div>/);
    assert.match(html, /<button type="button" data-action="openSparring" title="Open sparring.md">Open full report<\/button>/);
  });

  it("no report to read: Read feedback is not offered, only the verdict and summary", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("hotfix-1", { status: "working" }, { "sparring.md": ["# Sparring: x", "", "## Routing outcome", "", "- Action: `READY`", "- Summary: fine", ""].join("\n") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.lastSparring?.report, undefined);
    const html = renderOverviewHtml(model, "n", "c");
    assert.ok(!html.includes("Read feedback"));
  });

  it("ESCALATE", async () => {
    const ws = await planWorkspace("paused", 0, { sparring: sparringMarkdown("ESCALATE", "Needs a stronger sparrer") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.banner, undefined);
    assert.equal(model.actionRequired?.kind, "escalate");
    assert.equal(model.actionRequired?.word, "Escalated");
    assert.equal(model.actionRequired?.summary, "Needs a stronger sparrer");
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
    const html = renderOverviewHtml(model, "n", "c");
    const header = html.slice(html.indexOf('<header class="top">'), html.indexOf("</header>"));
    assert.ok(model.status, "the model still knows the status");
    assert.doesNotMatch(header, /class="hpill/, "the banner states the state; the header does not repeat it");
    assert.match(html, /<div class="banner done">Plan complete — 3 stages accepted<\/div>/);
    assert.deepEqual(
      model.timeline?.map((item) => item.state),
      ["accepted", "accepted", "accepted"],
    );
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.actions?.diff?.label, "Diff");
    assert.equal(model.actions?.diff?.detail, "base bbbbbbbb… … candidate cccccccc…");
    assert.equal(model.actions?.diff?.targetSha, "c".repeat(40));
  });

  it("frozen current stage is distinguished from accepted and never named frozen", async () => {
    const ws = await planWorkspace("running", 1, { stageState: { status: "frozen", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40) } });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.timeline?.[1].state, "finalizing");
    assert.equal(model.stageStatus, "Finalizing stage…");
    assert.equal(model.stageLine, "Finalizing did not complete. Use Accept stage to finish it.");
    const html = renderOverviewHtml(model, "n", "c");
    assert.ok(!/frozen|FROZEN|Freeze candidate/.test(normalUi(html)), "no normal UI text says frozen");
    assert.match(html, /Engine state: FROZEN/, "the engine word survives only in a tooltip");
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
    assert.equal(model.actionRequired?.kind, "needs_you");
    assert.match(model.actionRequired?.noChecks ?? "", /No plan is linked/);
    assert.equal(model.stageAgent?.sessionLabel, "ssssssss…");
    assert.equal(model.actions?.plan, false);
  });

  it("accepted standalone stage presents as complete and keeps its actions", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-local-schema-barrier", { status: "accepted", base_sha: "b".repeat(40), candidate_sha: "c".repeat(40), implementation_session_id: "82ab" }, { "sparring.md": sparringMarkdown("READY", "Done") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.kind, "run");
    assert.equal(model.title, "Local schema barrier");
    assert.equal(model.stageStatus, "Accepted");
    assert.equal(model.stageLine, "Stage complete.");
    assert.equal(model.banner, undefined, "no banner: the pill says Accepted and the line says complete");
    assert.equal(model.whatsNext?.kind, "choose");
    assert.equal(model.stageAction, undefined, "no Run / Resume / Accept for an accepted stage");
    assert.equal(model.secondaryAction, undefined);
    assert.equal(model.stageAgent?.activity, "Idle");
    assert.equal(model.actions?.diff?.label, "Diff");
    assert.equal(model.actions?.handoff, true);
    assert.equal(model.actions?.sparring, true);
    assert.equal(model.actions?.brief, true);
    assert.ok(!model.facts?.some((fact) => fact.label === "Last activity"), "the Ns-ago row is gone");
    assert.deepEqual(model.facts?.slice(1, 4), [
      { label: "Engine state", value: "ACCEPTED" },
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
    assert.equal(model.title, "Multiple open runs found — choose one to follow");
    // Running first, status leading; nothing chosen on the person's behalf.
    assert.deepEqual(
      model.runChoices?.map((row) => [row.status, row.stage, row.runKey, row.likely]),
      [
        ["Running", "Stage 1 of 3", FOO_PLAN_KEY, true],
        ["Paused", "Stage 1 of 1", "bar-00000000", false],
      ],
    );
  });

  it("READY on a working stage presents as Review complete", async () => {
    const ws = await planWorkspace("running", 1, { sparring: sparringMarkdown("READY", "Looks complete") });
    const model = buildOverviewModel(await selection(ws), undefined, ALL, NOW);
    assert.equal(model.stageStatus, "Review complete");
    assert.equal(model.stageStatusKind, "ready");
    assert.equal(model.stageLine, "Independent review passed. No unresolved findings remain.");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<span class="status ready" title="Engine state: working · READY">Review complete<\/span>/);
    assert.match(html, /<span class="verdict ready" title="Routing action: READY">Approved<\/span>/);
    assert.ok(!/<span class="status[^>]*>working</.test(html));
    assert.ok(!/awaiting acceptance/.test(html));
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
    // Sparring report is no longer a top-row button: opening sparring.md
    // lives inside Latest sparring result (Read feedback / Open full
    // report), tested separately where an outcome actually exists.
    assert.ok(!withAll.includes(">Sparring report</button>"));
    assert.match(withAll, />Log<\/button>/);
    assert.match(withAll, /data-action="openPlan"/);

    const withNone = renderOverviewHtml(buildOverviewModel(await selection(ws), undefined, NONE, NOW), "n", "c");
    assert.match(withNone, /<button type="button" data-action="openHandoff" title="Open handoff.md" disabled>Handoff<\/button>/);
    assert.ok(!withNone.includes('data-action="openSparring"'), "no top-row Sparring report button, disabled or not");
    assert.ok(!withNone.includes('data-action="openPlan"'));

    const ws2 = await planWorkspace("running", 0);
    const noDiff = renderOverviewHtml(buildOverviewModel(await selection(ws2), undefined, ALL, NOW), "n", "c");
    assert.ok(!noDiff.includes('data-action="openDiff"'));
  });

  it("Technical details holds the run key, session/thread ids and provider/model, collapsed by default and nowhere else on the page", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", implementation_session_id: "82ab1234deadbeef", sparring_session_id: "019d1234deadbeef" }, { "sparring.md": sparringMarkdown("READY", "fine") });
    const live = foldEvents([event("stage", "session.observed", { provider: "claude-cli", session_id: "82ab1234deadbeef", model: "claude-opus-5-5" })]);
    const model = buildOverviewModel(await selection(ws), live, ALL, NOW);
    assert.ok(model.facts?.some((fact) => fact.label === "Run key" && fact.value === FOO_PLAN_KEY));
    assert.ok(model.facts?.some((fact) => fact.label === "Stage session"));
    assert.ok(model.facts?.some((fact) => fact.label === "Sparring thread"));
    assert.ok(model.facts?.some((fact) => fact.label === "Stage provider" && fact.value.includes("claude-opus-5-5")));

    const html = renderOverviewHtml(model, "n", "c");
    const details = /<details class="tech facts"[^>]*><summary>Technical details<\/summary>([\s\S]*?)<\/details>/.exec(html);
    assert.ok(details, "a collapsed Technical details section exists");
    assert.ok(!/<details class="tech facts"[^>]* open[^>]*>/.test(html), "collapsed by default");
    assert.match(details![1], /claude-opus-5-5/);
    assert.match(details![1], /82ab1234/);
    // The same raw facts never leak into the primary card above it (the
    // run key does still appear in the stage heading's tooltip, one of the
    // established advanced surfaces alongside Technical details itself).
    // The one exception is the model name the provider reported, read as a
    // plain name under the stage agent's dials.
    const beforeTechnical = html
      .slice(0, html.indexOf('<details class="tech facts"'))
      .replace(/<div class="runtimemodel[^>]*>[^<]*<\/div>/g, "")
      .replace(/data-runtime-model="[^"]*"/g, "")
      .replace(/<details class="setup-technical agentconfig-technical"[\s\S]*?<\/details>/g, "");
    assert.match(html, /<div class="runtimemodel muted" data-runtime-model="claude-opus-5-5"/);
    assert.ok(!beforeTechnical.includes("claude-opus-5-5"));
    assert.ok(!beforeTechnical.includes("82ab1234"));
  });

  it("renders the compact journey, the primary stage block and the small actor cards", async () => {
    const ws = await planWorkspace("paused", 1, { sparring: sparringMarkdown("NEEDS_YOU", "Check") });
    const html = renderOverviewHtml(buildOverviewModel(await selection(ws), undefined, ALL, NOW), "n", "c");
    assert.match(html, /<ol class="journey"><li class="step accepted" title="Stage 1 — Contract \(Accepted\) · 1 of 3"><span class="node"><svg class="icon " [^>]*>.*?<\/svg><\/span><span class="num">1<\/span><span class="name">Contract<\/span><span class="state"><svg[^>]*>.*?<\/svg>Accepted<\/span><\/li>/);
    assert.match(html, /<li class="step paused current" [^>]*>.*?<span class="name">Schema &amp; API<\/span><span class="state">Paused<\/span><\/li>/);
    assert.match(html, /<li class="step future" [^>]*><span class="node">3<\/span>.*?<span class="state">Pending<\/span><\/li>/);
    // The breadcrumb names the plan and the stage; the header adds only the status, as text.
    assert.match(html, /<div class="pills"><span class="hpill warn"><svg[^>]*>.*?<\/svg>Needs you<\/span><\/div>/);
    assert.ok(!html.includes(">Plan run<"), "a plan run is the ordinary case and is not labelled");
    assert.match(html, /<h2 [^>]*><svg class="icon accent needs_you"[^>]*>.*?<\/svg>Stage 2 — Schema &amp; API<\/h2>/);
    assert.ok(!/<span class="status needs_you"/.test(html), "the card does not repeat the header pill's Needs you");
    assert.equal((html.match(/<div class="card actor [a-z]+" data-role="/g) ?? []).length, 2);
    assert.ok(html.indexOf('<section class="card action needs_you">') < html.indexOf('<section class="card stage">'), "action required before the stage card");
    assert.ok(html.indexOf('<section class="card stage">') < html.indexOf('<section class="actors">'), "stage before actors");
    assert.ok(html.indexOf('<section class="actors">') < html.indexOf('<dl class="facts">'), "metadata last");
    assert.ok(!html.includes('class="banner'), "no banner repeats the panel");
    assert.equal((normalUi(html).match(/Needs you/g) ?? []).length, 1, "one primary status badge; the panel is titled Action required");
    assert.match(html, /<h2><svg class="icon needs_you"[^>]*>.*?<\/svg>Action required<\/h2><p class="summary">Check<\/p>/);
    // In a managed plan the button says what the person is doing; the tooltip says who reads it.
    assert.match(html, /<button type="button" class="primary" data-action="submitForReview" title="[^"]*" disabled>Submit result and continue<\/button>/);
    assert.match(html, /data-action="openSparring"[^>]*>Open detailed review</);
    assert.match(html, /<details class="more"[^>]*><summary[^>]*>…<\/summary><div class="actions"><button type="button" class="quiet" data-action="resumePlan"[^>]*>Resume plan \(implementation\)</);
    assert.ok(!html.includes("Latest sparring result"), "the panel is the latest sparring result");
    assert.match(html, /<div class="run muted" title="[^"]*"><span class="plan">docs\/plans\/foo.md<\/span><span class="sep">›<\/span><span title="Stage 2 of 3">Stage 2 — Schema &amp; API<\/span><\/div>/, "the header names the plan (its label when the document is not read), then the stage");
  });

  it("ambiguous model lists the choices, names the repository and offers selection", () => {
    // Every model buildOverviewModel produces carries a repository context,
    // and it is what puts Agent Sparring's own chooser on the screen.
    const html = renderOverviewHtml(
      {
        kind: "ambiguous",
        title: "Multiple open runs found — choose one to follow",
        runChoices: [
          { runId: "p|plan:a", status: "Running", stage: "Stage 1", runKey: "fix2", plan: "a.md", folderName: "beta", likely: true },
          { runId: "p|plan:<b>", status: "Paused", stage: "Stage 3", runKey: "s1", plan: "<b>.md", folderName: "beta", likely: false },
        ],
        repositoryContext: describeRepositoryContext({ ambiguous: [], scope: { repoRoot: "/code/beta", name: "beta" } }),
      },
      "n",
      "c",
    );
    assert.match(html, /<h2>Multiple open runs found — choose one to follow<\/h2>/);
    assert.match(html, /data-choose-run="p\|plan:a"[^>]*><strong class="status">Running · Stage 1<\/strong> <span class="plan">a.md<\/span> <code class="runkey">fix2<\/code>/);
    assert.match(html, /data-choose-run="p\|plan:&lt;b&gt;"[^>]*><strong class="status">Paused · Stage 3<\/strong>/);
    assert.match(html, /data-action="showLog"/);
    assert.match(html, /data-action="selectRun"/);
    assert.ok(html.includes('Following repository:</span><button type="button" class="name chooser" data-action="chooseRepository" title="Choose repository to follow" aria-haspopup="listbox">beta'));
  });
});
