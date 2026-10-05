/**
 * Start a fresh reviewer / implementation agent from the Overview.
 *
 * The engine owns the contract: `resume-plan --fresh-sparrer |
 * --fresh-stage-agent`, its `sessions` history and its `provider_pause`.
 * These hold that the cockpit emits exactly the flags asked for, offers the
 * actions only where the engine can take them, and states only what the
 * engine recorded.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildResumePlanArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { parsePlanRunState, parseStageState } from "../core/engineFormats";
import { askFreshSession, freshSessionConfirmation, otherAgentLabel, providerPauseCard, type FreshChoice, type FreshSessionUi, type ResolvedAgent } from "../core/freshSession";
import type { ExecutionRecord } from "../core/liveness";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, sparringMarkdown } from "./fixtures";

const NOW = Date.parse("2026-10-04T10:00:00.000Z");
const BRANCH = "feature/fresh";

const SESSIONS = {
  stage: [{ generation: 1, session_id: "impl", agent: { provider: "claude-cli", model: "opus", effort: "high" }, started_at: "2026-10-04T09:00:00Z", start_reason: "initial" }],
  sparring: [
    { generation: 1, session_id: "spar-1", agent: { provider: "codex-cli" }, started_at: "2026-10-04T09:00:00Z", start_reason: "initial", ended_at: "2026-10-04T09:30:00Z", end_reason: "fresh" },
    { generation: 2, session_id: "spar-2", agent: { provider: "codex-cli" }, started_at: "2026-10-04T09:31:00Z", start_reason: "context exhausted" },
  ],
};

interface Setup {
  status?: "paused" | "running" | "complete";
  stageStatus?: "working" | "accepted";
  sessions?: unknown;
  pause?: Record<string, unknown>;
  execution?: "running";
}

async function screen(options: Setup = {}) {
  const ws = await Workspace.create();
  await ws.writePlan();
  await ws.writePlanRun(FOO_PLAN_KEY, {
    plan: FOO_PLAN_LABEL,
    status: options.status ?? "paused",
    current_stage_index: 0,
    current_stage: FOO_STAGE_IDS[0],
    expected_branch: BRANCH,
    ...(options.pause ? { provider_pause: options.pause } : {}),
  });
  const state: Record<string, unknown> = { status: options.stageStatus ?? "working", implementation_session_id: "impl", sparring_session_id: "spar-2" };
  if (options.sessions !== null) {
    state["sessions"] = options.sessions ?? SESSIONS;
    state["next_turn"] = "sparring";
  }
  await ws.writeStage(FOO_STAGE_IDS[0], state, { "sparring.md": sparringMarkdown("SEND_BACK", "Fix the tests.") });
  const artifacts: OverviewArtifacts = { handoff: false, sparring: true, brief: false, plan: true, planText: "# Foo plan\n", git: { branch: BRANCH, head: "abc" } };
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const execution: ExecutionRecord | undefined =
    options.execution === "running" ? { id: "e", runId: selection.selected!.id, kind: "resume-plan", source: "launched", state: "running", startedAtMs: NOW - 1000 } : undefined;
  const model = buildOverviewModel(selection, undefined, artifacts, NOW, execution);
  return { ws, model, html: renderOverviewHtml(model, "n", "c") };
}

const BASE = { source: "markdown" as const, planPath: "/r/docs/plans/foo.md", repoRoot: "/r", expectedBranch: BRANCH };

describe("resume-plan fresh flags", () => {
  it("emits nothing when no fresh session is asked for", () => {
    const args = buildResumePlanArgs(BASE);
    assert.ok(!args.some((arg) => arg.startsWith("--fresh") || /^--(stage|sparring)-(provider|model|effort)$/.test(arg)), args.join(" "));
  });

  it("emits --fresh-sparrer alone when only the role is given", () => {
    const args = buildResumePlanArgs({ ...BASE, fresh: { role: "sparring" } });
    assert.deepEqual(args.slice(args.indexOf("--fresh-sparrer")), ["--fresh-sparrer"]);
    assert.ok(!args.includes("--fresh-stage-agent"));
  });

  it("emits --fresh-stage-agent with exactly the reason and role-scoped overrides given", () => {
    const args = buildResumePlanArgs({ ...BASE, fresh: { role: "stage", reason: "context  full", provider: "codex-cli", model: "gpt-5", effort: "high" } });
    assert.deepEqual(args.slice(args.indexOf("--fresh-stage-agent")), [
      "--fresh-stage-agent", "--fresh-reason", "context full", "--stage-provider", "codex-cli", "--stage-model", "gpt-5", "--stage-effort", "high",
    ]);
  });

  it("scopes overrides to the sparring role and omits unset ones", () => {
    const args = buildResumePlanArgs({ ...BASE, fresh: { role: "sparring", model: "o5" } });
    assert.deepEqual(args.slice(args.indexOf("--fresh-sparrer")), ["--fresh-sparrer", "--sparring-model", "o5"]);
    assert.ok(!args.includes("--next-turn"));
  });
});

describe("engine formats", () => {
  it("reads sessions, next_turn and provider_pause, and tolerates their absence", () => {
    const stage = parseStageState(JSON.stringify({ status: "working", sessions: SESSIONS, next_turn: "stage" }));
    assert.equal(stage.sessions?.["sparring"]?.[1]?.generation, 2);
    assert.equal(stage.sessions?.["stage"]?.[0]?.model, "opus");
    assert.equal(stage.nextTurn, "stage");
    const old = parseStageState(JSON.stringify({ status: "working" }));
    assert.equal(old.sessions, null);
    assert.equal(old.nextTurn, null);
    const run = { plan: "p", plan_digest: "d", expected_branch: "b", current_stage: "s", current_stage_index: 0, status: "paused" };
    assert.equal(parsePlanRunState(JSON.stringify(run)).providerPause, undefined);
    assert.equal(parsePlanRunState(JSON.stringify({ ...run, provider_pause: { kind: "mystery", role: "stage", stage_id: "s" } })).providerPause, undefined);
    assert.deepEqual(parsePlanRunState(JSON.stringify({ ...run, provider_pause: { kind: "provider-unavailable", role: "sparring", stage_id: "s", has_session: true, recorded_at: "t" } })).providerPause, {
      kind: "provider-unavailable", role: "sparring", stageId: "s", hasSession: true, recordedAt: "t",
    });
  });
});

describe("fresh-session actions on the Overview", () => {
  it("are offered for a paused active run", async () => {
    const { model, html } = await screen();
    assert.deepEqual(model.freshSession?.map((offer) => offer.label), ["Start fresh reviewer…", "Start fresh implementation agent…"]);
    assert.match(html, /data-action="freshSparrer"/);
    assert.match(html, /data-action="freshStageAgent"/);
  });

  it("are absent while a process is running", async () => {
    const { model, html } = await screen({ status: "running", execution: "running" });
    assert.equal(model.freshSession, undefined);
    assert.doesNotMatch(html, /data-action="fresh/);
  });

  it("are absent for an accepted stage", async () => {
    const { model } = await screen({ stageStatus: "accepted" });
    assert.equal(model.freshSession, undefined);
  });

  it("are absent on an older engine that records no sessions", async () => {
    const { model, html } = await screen({ sessions: null });
    assert.equal(model.freshSession, undefined);
    assert.doesNotMatch(html, /data-action="fresh/);
  });
});

describe("confirmation", () => {
  it("states the same stage and candidate, a new conversation, preserved history, model and effort", () => {
    const { message, detail } = freshSessionConfirmation("sparring", { provider: "Codex", model: "gpt-5", effort: "high" });
    assert.match(message, /fresh reviewer/);
    for (const line of ["Same stage and candidate", "New reviewer conversation", "Previous review history preserved", "Provider: Codex", "Model: gpt-5", "Effort: high"]) {
      assert.ok(detail.includes(line), `${line} in ${detail}`);
    }
    assert.match(freshSessionConfirmation("stage", { provider: "Claude", model: null, effort: null }).detail, /New implementation agent conversation[\s\S]*Model: provider default/);
  });
});

describe("provider pause card", () => {
  const pause = (kind: string, role: string, hasSession = true) => ({ kind, role, stage_id: FOO_STAGE_IDS[0], has_session: hasSession, recorded_at: "2026-10-04T09:59:00Z" });

  for (const [role, noun, action] of [["sparring", "Reviewer", "freshSparrer"], ["stage", "Implementation-agent", "freshStageAgent"]] as const) {
    it(`session-unresumable for ${role}`, async () => {
      const { model, html } = await screen({ pause: pause("session-unresumable", role) });
      assert.equal(model.providerPause?.title, `${noun} session cannot be resumed`);
      assert.equal(model.providerPause?.detail, "The candidate is safe and unchanged.");
      const card = html.slice(html.indexOf("providerpause"), html.indexOf("</section>", html.indexOf("providerpause")));
      assert.match(card, new RegExp(`data-action="${action}"`));
      assert.match(card, /data-action="showLog"[^>]*>Details/);
      assert.doesNotMatch(card, /data-action="resumePlan"/);
    });

    it(`provider-unavailable for ${role}`, async () => {
      const { model, html } = await screen({ pause: pause("provider-unavailable", role) });
      assert.equal(model.providerPause?.title, "Provider unavailable (quota / rate limit)");
      const card = html.slice(html.indexOf("providerpause"), html.indexOf("</section>", html.indexOf("providerpause")));
      assert.match(card, /data-action="resumePlan"[^>]*>Retry/);
      assert.match(card, new RegExp(`data-action="${action}OtherProvider"[^>]*>Start fresh [^<]* with another model/provider`));
      assert.doesNotMatch(card, new RegExp(`data-action="${action}"`));
    });

    it(`has_session false offers only Retry for ${role}`, async () => {
      for (const kind of ["session-unresumable", "provider-unavailable"]) {
        const { model, html } = await screen({ pause: pause(kind, role, false) });
        assert.equal(model.providerPause?.fresh, undefined);
        assert.equal(model.providerPause?.retry, true);
        // The whole screen, not only the card: no fresh action anywhere.
        assert.equal(model.freshSession, undefined, kind);
        assert.doesNotMatch(html, /data-action="fresh/, kind);
        assert.match(html, /data-action="resumePlan"[^>]*>Retry/, kind);
      }
    });
  }

  it("is shown only while the run is paused: not for a complete or failed run", async () => {
    const { model, html } = await screen({ status: "complete", pause: pause("provider-unavailable", "stage") });
    assert.equal(model.providerPause, undefined);
    assert.doesNotMatch(html, /providerpause/);
    const known = { kind: "provider-unavailable" as const, role: "stage" as const, stageId: FOO_STAGE_IDS[0], hasSession: true, recordedAt: null };
    for (const status of ["complete", "failed", "running"]) {
      assert.equal(providerPauseCard(known, status, FOO_STAGE_IDS[0], true), undefined, status);
    }
    assert.ok(providerPauseCard(known, "paused", FOO_STAGE_IDS[0], true));
  });

  it("labels the provider-unavailable recovery for both roles", async () => {
    for (const [role, noun] of [["sparring", "reviewer"], ["stage", "implementation agent"]] as const) {
      const { model } = await screen({ pause: pause("provider-unavailable", role) });
      assert.deepEqual(model.providerPause?.fresh, { role, label: `Start fresh ${noun} with another model/provider`, otherProvider: true });
    }
  });

  it("drops a malformed provider_pause: unknown kind or role, empty stage_id", async () => {
    for (const bad of [
      { ...pause("quota-exceeded", "stage") },
      { ...pause("provider-unavailable", "planner") },
      { ...pause("provider-unavailable", "stage"), stage_id: "" },
    ]) {
      const { model, html } = await screen({ pause: bad });
      assert.equal(model.providerPause, undefined, JSON.stringify(bad));
      assert.doesNotMatch(html, /providerpause/);
      // The ordinary fresh actions are still the engine's to offer.
      assert.equal(model.freshSession?.length, 2);
    }
  });

  it("is not shown for a pause recorded for another stage", async () => {
    const { model } = await screen({ pause: { ...pause("provider-unavailable", "stage"), stage_id: "other-stage" } });
    assert.equal(model.providerPause, undefined);
  });
});

describe("actor cards", () => {
  it("label the session generation when it is past the first", async () => {
    const { model, html } = await screen();
    assert.equal(model.sparrer?.generation, "generation 2 · fresh: context exhausted");
    assert.equal(model.stageAgent?.generation, undefined);
    assert.match(html, /generation 2 · fresh: context exhausted/);
  });
});

describe("no .sparring writes", () => {
  it("the new code paths contain no file-writing call", async () => {
    const root = path.resolve(__dirname, "..", "..", "src");
    for (const file of ["core/freshSession.ts"]) {
      const text = await fs.readFile(path.join(root, file), "utf8");
      assert.doesNotMatch(text, /writeFile|appendFile|mkdir|rename|unlink|from "node:fs/);
    }
    const commands = await fs.readFile(path.join(root, "vscode/commands.ts"), "utf8");
    const start = commands.indexOf("async function startFreshSessionCommand");
    const end = commands.indexOf("function describeEntry", start);
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(commands.slice(start, end), /writeFile|appendFile|mkdir|rename\(|unlink|writeAgentConfig/);
  });
});

describe("fresh-session flow", () => {
  const CURRENT: ResolvedAgent = { provider: "Claude", model: "opus", effort: "high" };

  /** A scripted UI: each answer is consumed in order; the log records what was asked. */
  const TWO = [{ provider: "claude-cli", label: "Claude" }, { provider: "codex-cli", label: "Codex" }];
  function ui(answers: { keep?: boolean; choose?: FreshChoice; confirm?: boolean; options?: { provider: string; label: string }[] }, log: string[] = []): FreshSessionUi {
    return {
      async resolve(choice) {
        log.push(`resolve ${JSON.stringify(choice)}`);
        return choice.provider ? { provider: choice.provider, model: choice.model ?? null, effort: choice.effort ?? null } : CURRENT;
      },
      async pickCurrentOrOther() {
        log.push("pick");
        return answers.keep;
      },
      async providers() {
        return { current: "claude-cli", options: answers.options ?? TWO };
      },
      async chooseAgent(providers, requireProvider) {
        log.push(`choose ${providers.map((option) => option.provider).join(",")} ${requireProvider}`);
        return answers.choose;
      },
      async confirm(_message, detail) {
        log.push(`confirm ${detail.split("\n").join(" | ")}`);
        return answers.confirm ?? false;
      },
      notify(text) {
        log.push(`notify ${text}`);
      },
    };
  }

  it("on another provider: no current-preference offer, current provider not listed, override emitted", async () => {
    const log: string[] = [];
    const choice = await askFreshSession("stage", true, ui({ choose: { provider: "codex-cli", model: "gpt-5" }, confirm: true }, log));
    assert.ok(!log.includes("pick"), log.join("\n"));
    assert.ok(log.includes("choose codex-cli true"), log.join("\n"));
    assert.ok(log.some((line) => line.startsWith("confirm") && line.includes("Provider: codex-cli") && line.includes("Model: gpt-5")), log.join("\n"));
    assert.deepEqual(choice, { provider: "codex-cli", model: "gpt-5" });
    const args = buildResumePlanArgs({ ...BASE, fresh: { role: "stage", ...choice } });
    assert.deepEqual(args.slice(args.indexOf("--fresh-stage-agent")), ["--fresh-stage-agent", "--stage-provider", "codex-cli", "--stage-model", "gpt-5"]);
  });

  it("on another provider: a choice of the current provider, or no provider, launches nothing", async () => {
    assert.equal(await askFreshSession("sparring", true, ui({ choose: { provider: "claude-cli" }, confirm: true })), undefined);
    assert.equal(await askFreshSession("sparring", true, ui({ choose: { model: "x" }, confirm: true })), undefined);
  });

  it("on another provider with only the role's own provider: a different model on it, never another provider", async () => {
    const own = [{ provider: "claude-cli", label: "Claude" }];
    const log: string[] = [];
    const choice = await askFreshSession("stage", true, ui({ options: own, choose: { provider: "claude-cli", model: "sonnet" }, confirm: true }, log));
    assert.ok(!log.includes("pick"), log.join("\n"));
    assert.ok(log.includes("choose claude-cli false"), log.join("\n"));
    assert.deepEqual(choice, { model: "sonnet", effort: undefined });
    const args = buildResumePlanArgs({ ...BASE, fresh: { role: "stage", ...choice } });
    assert.deepEqual(args.slice(args.indexOf("--fresh-stage-agent")), ["--fresh-stage-agent", "--stage-model", "sonnet"]);
    // The same model, or the provider's preference, is not a recovery.
    for (const same of [{ model: "opus" }, {}]) {
      const notes: string[] = [];
      assert.equal(await askFreshSession("stage", true, ui({ options: own, choose: same, confirm: true }, notes)), undefined);
      assert.ok(notes.some((line) => line.startsWith("notify")), notes.join("\n"));
    }
  });

  it("labels the other-configuration choice by how many providers the engine lists", () => {
    assert.equal(otherAgentLabel(1), "Choose another model\u2026");
    assert.equal(otherAgentLabel(2), "Choose another model/provider\u2026");
  });

  it("cancelling at any step launches nothing", async () => {
    assert.equal(await askFreshSession("sparring", false, ui({ keep: undefined, confirm: true })), undefined);
    assert.equal(await askFreshSession("sparring", false, ui({ keep: false, choose: undefined, confirm: true })), undefined);
    assert.equal(await askFreshSession("sparring", false, ui({ keep: true, confirm: false })), undefined);
    assert.equal(await askFreshSession("sparring", true, ui({ choose: undefined, confirm: true })), undefined);
    assert.equal(await askFreshSession("sparring", true, ui({ choose: { provider: "codex-cli" }, confirm: false })), undefined);
  });

  it("current preference passes no override", async () => {
    const choice = await askFreshSession("sparring", false, ui({ keep: true, confirm: true }));
    assert.deepEqual(choice, {});
    const args = buildResumePlanArgs({ ...BASE, fresh: { role: "sparring", ...choice } });
    assert.deepEqual(args.slice(args.indexOf("--fresh-sparrer")), ["--fresh-sparrer"]);
  });
});
