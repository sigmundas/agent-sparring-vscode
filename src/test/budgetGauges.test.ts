/**
 * The budget dials beside Model and Effort: context used, and the two
 * rate-limit windows.
 *
 * Every number in them is a quotation from a provider's own output
 * (`provider.usage`, activity.py). The property these tests exist to hold is
 * the negative one: **a value the provider never stated must render as
 * unknown, never as zero.**
 *
 * That is not fussiness. The two providers differ — Codex states the
 * account's rate limits and the Claude CLI does not state them at all — so a
 * design that filled the gaps would be filling them for the Stage agent on
 * every single run. A rate dial showing an arc at 0% says "you have used
 * none of your quota", which is a claim about an account nobody measured.
 *
 * The second property, and the one that got the first version's number
 * wrong: **the ring is how full the window is, never what the session has
 * spent.** Both CLIs re-send the conversation on every request, so
 * cumulative tokens pass the window several times over in an ordinary
 * session. The two are separate fields here (`contextUsed`, `totalTokens`)
 * and only the first is ever a numerator.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { parseEngineConfig, type EffectiveConfig } from "../core/effectiveConfig";
import { foldEvents, type ActorBudget } from "../core/liveState";
import { renderOverviewHtml } from "../core/overviewHtml";
import { budgetGauges, buildOverviewModel } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, event } from "./fixtures";

/**
 * Exactly what a real Codex session reports, taken through the fold rather
 * than hand-built, so these tests exercise the wire field names too: a
 * rename on either side of `provider.usage` shows up here.
 */
const CODEX_FULL = foldEvents([
  event("sparrer", "provider.usage", {
    total_tokens: 653353,
    context_used_tokens: 220354,
    input_tokens: 135812,
    output_tokens: 665,
    context_window: 258400,
    rate_limit_percent: 8,
    rate_limit_window_minutes: 300,
    rate_limit_secondary_percent: 39,
    rate_limit_secondary_window_minutes: 10080,
  }),
]).sparrer.budget;

function gauge(budget: ActorBudget | undefined, id: "context" | "rate" | "rateWeek") {
  const found = budgetGauges(budget).find((entry) => entry.id === id);
  assert.ok(found, `${id} is always present`);
  return found;
}

describe("what the dials show when a provider reports everything", () => {
  it("reads the context ring as a share of the window the provider stated", () => {
    const context = gauge(CODEX_FULL, "context");

    assert.equal(context.known, true);
    assert.equal(context.percent, 85); // 220354 / 258400
    // No `value`: the ring shows its percentage, and a second number in the
    // same 36px would be two readings of one thing.
    assert.equal(context.value, undefined);
    assert.match(context.detail, /220k of 258k tokens \(85%\)/);
    assert.match(context.detail, /as this provider reported it/);
  });

  it("never draws the cumulative total as the share", () => {
    // The session has spent 653k against a 258k window. Read as a share
    // that is 253%, clamped to a full ring, and the dial would sit at 100%
    // from mid-morning onwards while the window was in fact 85% full.
    const context = gauge(CODEX_FULL, "context");

    assert.equal(context.percent, 85);
    assert.ok(!context.detail.includes("653k of"), "the spend is not a numerator");
    assert.match(context.detail, /653k tokens spent on this session in total/, "but it is still worth reading");
  });

  it("names each rate window by its own length, not by a hardcoded label", () => {
    // 300 and 10080 minutes are the provider's numbers; "5h" and "7d" are
    // derived from them, so a provider that changes its windows relabels
    // the dials rather than mislabelling them.
    assert.equal(gauge(CODEX_FULL, "rate").label, "5h");
    assert.equal(gauge(CODEX_FULL, "rateWeek").label, "7d");
    assert.equal(gauge(CODEX_FULL, "rate").percent, 8);
    assert.equal(gauge(CODEX_FULL, "rateWeek").percent, 39);
    assert.match(gauge(CODEX_FULL, "rateWeek").detail, /39% of a 7-day window used/);
  });

  it("clamps a context reading at 100 rather than drawing past the ring", () => {
    assert.equal(gauge({ contextUsed: 500, contextWindow: 100 }, "context").percent, 100);
  });
});

describe("what the dials show when a provider reports nothing", () => {
  it("gives three unknown dials, so the row is the shape it will keep", () => {
    const gauges = budgetGauges(undefined);

    assert.deepEqual(
      gauges.map((entry) => entry.id),
      ["context", "rate", "rateWeek"],
    );
    assert.deepEqual(
      gauges.map((entry) => entry.known),
      [false, false, false],
    );
    for (const entry of gauges) {
      assert.equal(entry.percent, undefined, `${entry.id} has no percentage to draw`);
    }
  });

  it("says unknown rather than zero, in words a person will read", () => {
    for (const id of ["rate", "rateWeek"] as const) {
      assert.match(gauge(undefined, id).detail, /unknown rather than zero/);
    }
    assert.match(gauge(undefined, "context").detail, /has not reported token usage/);
  });
});

describe("the Claude CLI's case: a full ring, and no quota to show", () => {
  // What the Stage agent's card reads on an ordinary run. The CLI states
  // occupancy on every assistant line and the window on the final result
  // line, so the ring is drawn from two quotations; it states no rate
  // limits at all, so both of those stay unknown for good.
  const claude: ActorBudget = { inputTokens: 2, outputTokens: 16, contextUsed: 181_218, contextWindow: 200_000 };

  it("draws the ring from the occupancy and the window it stated", () => {
    const context = gauge(claude, "context");

    assert.equal(context.known, true);
    assert.equal(context.percent, 91); // 181218 / 200000
    assert.match(context.detail, /181k of 200k tokens \(91%\)/);
  });

  it("leaves both rate dials unknown", () => {
    assert.equal(gauge(claude, "rate").known, false);
    assert.equal(gauge(claude, "rateWeek").known, false);
  });

  it("shows the occupancy as a count before the window has been stated", () => {
    // The window arrives on the turn's final line, so the first messages
    // of a turn have a numerator and no denominator. That reads as a
    // count, not as a guessed share.
    const context = gauge({ contextUsed: 181_218 }, "context");

    assert.equal(context.known, false, "a guessed denominator is not a measurement");
    assert.equal(context.percent, undefined);
    assert.equal(context.value, "181k");
    assert.match(context.detail, /181k tokens in the window/);
    assert.match(context.detail, /does not report the model's context size/);
  });

  it("says which number it is showing when only the spend is known", () => {
    // "180k in the window" and "180k spent all session" are different
    // facts, and a dial reading `180k` must not be ambiguous between them.
    const context = gauge({ totalTokens: 181_218, contextWindow: 200_000 }, "context");

    assert.equal(context.known, false, "a spend is not a share of the window");
    assert.equal(context.value, "181k");
    assert.match(context.detail, /spent on this session in total/);
    assert.match(context.detail, /has not reported how full the window is/);
  });

  it("refuses a zero window as a denominator", () => {
    // Defensive: a provider reporting `0` would otherwise divide by zero
    // and render Infinity.
    assert.equal(gauge({ contextUsed: 10, contextWindow: 0 }, "context").known, false);
  });
});

describe("folding provider.usage out of the activity stream", () => {
  it("merges field by field, so tokens do not erase a stated window", () => {
    // Codex reports these on separate events in some versions. A later
    // token-only event must not drop the context window or the limits.
    const live = foldEvents([
      event("sparrer", "session.observed", { session_id: "t1" }),
      event("sparrer", "provider.usage", { context_window: 258400, rate_limit_percent: 8, rate_limit_window_minutes: 300 }),
      event("sparrer", "provider.usage", { total_tokens: 44085, context_used_tokens: 43000 }),
    ]);

    assert.deepEqual(
      { ...live.sparrer.budget, ts: undefined },
      { contextWindow: 258400, primaryPercent: 8, primaryWindowMinutes: 300, totalTokens: 44085, contextUsed: 43000, ts: undefined },
    );
    assert.equal(gauge(live.sparrer.budget, "context").percent, 17);
  });

  it("attributes usage to the actor that reported it", () => {
    const live = foldEvents([
      event("stage", "provider.usage", { input_tokens: 10, output_tokens: 5 }),
      event("sparrer", "provider.usage", { total_tokens: 99, context_window: 100 }),
    ]);

    assert.equal(live.stage.budget?.inputTokens, 10);
    assert.equal(live.stage.budget?.contextWindow, undefined, "one actor's window is not the other's");
    assert.equal(live.sparrer.budget?.totalTokens, 99);
  });

  it("starts a fresh budget when the session changes", () => {
    // These totals are cumulative per session. Carrying a finished
    // session's context into the next one would overstate it, and on a
    // SEND_BACK cycle that is a live case rather than a hypothetical.
    const live = foldEvents([
      event("stage", "session.observed", { session_id: "first" }),
      event("stage", "provider.usage", { total_tokens: 90, context_window: 100 }),
      event("stage", "session.observed", { session_id: "second" }),
    ]);

    assert.equal(live.stage.budget, undefined);
    assert.equal(gauge(live.stage.budget, "context").known, false);
  });

  it("keeps the budget when the same session is observed again", () => {
    const live = foldEvents([
      event("stage", "session.observed", { session_id: "same" }),
      event("stage", "provider.usage", { total_tokens: 90, context_window: 100 }),
      event("stage", "session.observed", { session_id: "same" }),
    ]);

    assert.equal(live.stage.budget?.totalTokens, 90);
  });

  it("ignores usage from an actor the model has no card for", () => {
    const live = foldEvents([event("loop", "provider.usage", { total_tokens: 5 })]);

    assert.equal(live.stage.budget, undefined);
    assert.equal(live.sparrer.budget, undefined);
  });
});

describe("the markup a person actually sees", () => {
  /** The engine's own `show-config --json`, so Model and Effort are drawn too. */
  function config(): EffectiveConfig {
    const report = parseEngineConfig(
      JSON.stringify({
        config_path: "/repo/.sparring/project.toml",
        config_exists: true,
        project: "demo",
        error: null,
        stage: { role: "stage", provider: "claude-cli", provider_display_name: "Claude", provider_source: "project", model: "opus", model_source: "project", effort: "medium", effort_source: "project", effort_supported: true, effort_levels: ["low", "medium", "high"] },
        sparring: { role: "sparring", provider: "codex-cli", provider_display_name: "Codex", provider_source: "project", model: "gpt-6-astra", model_source: "project", effort: "medium", effort_source: "project", effort_supported: true, effort_levels: ["low", "medium", "high"] },
      }),
    );
    assert.ok(report, "the fixture must parse");
    return { kind: "report", report };
  }

  /** One running stage, with whatever usage the given events reported. */
  async function page(events: Parameters<typeof foldEvents>[0]): Promise<string> {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", implementation_session_id: "impl-1", sparring_session_id: "spar-1" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    return renderOverviewHtml(
      buildOverviewModel(selection, foldEvents(events), { handoff: false, sparring: false, brief: false, plan: false, agentConfig: config() }, Date.now()),
      "n",
      "c",
    );
  }

  /** One actor's card, so every claim below is about that actor's dials. */
  function actorCard(html: string, role: "stage" | "sparrer"): string {
    const found = new RegExp(`<div class="card actor [^"]*" data-role="${role}">[\\s\\S]*?(?=<div class="card actor |</section>)`).exec(html)?.[0];
    assert.ok(found, `the ${role} card is in the page`);
    return found;
  }

  /**
   * The markup of one dial on one card. Scoped to the card on purpose: both
   * actors draw all three dials, so an unscoped search finds the Stage
   * agent's and silently answers a question about the Sparrer's.
   */
  function dial(html: string, role: "stage" | "sparrer", id: string): string {
    const found = new RegExp(`<div class="gauge[^"]*" data-gauge="${id}"[\\s\\S]*?</span>\\s*</div>`).exec(actorCard(html, role))?.[0];
    assert.ok(found, `the ${role} card has a ${id} dial`);
    return found;
  }

  it("draws an arc only for a reported number, and marks the rest unknown", async () => {
    const html = await page([
      event("sparrer", "provider.usage", { total_tokens: 653353, context_used_tokens: 220354, context_window: 258400, rate_limit_percent: 8, rate_limit_window_minutes: 300 }),
    ]);

    const context = dial(html, "sparrer", "context");
    assert.ok(!context.includes("unknown"), "a stated share is drawn");
    assert.match(context, /class="arc"/);
    assert.match(context, /stroke-dasharray/);
    assert.match(context, />85</);

    // The same page's weekly dial was never reported, and says so.
    const week = dial(html, "sparrer", "rateWeek");
    assert.match(week, /class="gauge unknown"/);
    assert.ok(!week.includes('class="arc"'), "nothing is drawn for an unreported limit");
    assert.match(week, /–/, "an en dash, not a 0");
    assert.match(week, /unknown rather than zero/);
  });

  it("never renders an unreported dial the way it renders zero", async () => {
    // The distinction this whole feature turns on, held on the markup: a
    // real 0% draws a dial that is *not* marked unknown, and an absent
    // reading draws one that is.
    const reportedZero = dial(await page([event("sparrer", "provider.usage", { rate_limit_percent: 0, rate_limit_window_minutes: 300 })]), "sparrer", "rate");
    const neverReported = dial(await page([event("sparrer", "provider.usage", { total_tokens: 1 })]), "sparrer", "rate");

    assert.ok(!reportedZero.includes("gauge unknown"), "0% measured is a measurement");
    assert.match(reportedZero, />0</);
    assert.match(neverReported, /class="gauge unknown"/);
    assert.notEqual(reportedZero, neverReported);
  });

  it("greys both of the Stage agent's rate dials on an ordinary Claude run", async () => {
    // Not a contrived case: this is every run. The Claude CLI states no
    // rate limits at all, so those two dials are unknown for the whole
    // session while the context ring is drawn from its own numbers.
    const events = [event("stage", "provider.usage", { input_tokens: 2, output_tokens: 16, context_used_tokens: 181_218, context_window: 200_000 })];
    const stageCard = actorCard(await page(events), "stage");

    assert.equal((stageCard.match(/class="gauge unknown"/g) ?? []).length, 2, "no quota was measured");
    assert.match(dial(await page(events), "stage", "context"), />91</, "but how full the window is, is measured");
  });

  it("shows the Stage agent a count until its window has been stated", async () => {
    // The first messages of a turn carry occupancy; the window comes on
    // the turn's final line. Until then the dial reads as a count.
    const stageCard = actorCard(await page([event("stage", "provider.usage", { input_tokens: 2, output_tokens: 16, context_used_tokens: 181_218 })]), "stage");

    assert.equal((stageCard.match(/class="gauge unknown"/g) ?? []).length, 3);
    assert.ok(!stageCard.includes('class="arc"'), "no arc without a denominator");
    assert.match(stageCard, />181k</, "the tokens it did report are still read");
  });

  it("puts the dials beside the fields rather than under them", async () => {
    const html = await page([]);
    assert.match(html, /<div class="agentconfig-block"><div class="agentconfig-fields">[\s\S]*?<\/div><div class="gauges">/);
  });
});
