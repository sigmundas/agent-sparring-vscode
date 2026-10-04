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
import { freshSessionConfirmation } from "../core/freshSession";
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
  status?: "paused" | "running";
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
      assert.match(card, new RegExp(`data-action="${action}"[^>]*>Start fresh [^<]* on another provider`));
    });

    it(`has_session false offers only Retry for ${role}`, async () => {
      for (const kind of ["session-unresumable", "provider-unavailable"]) {
        const { model, html } = await screen({ pause: pause(kind, role, false) });
        assert.equal(model.providerPause?.fresh, undefined);
        assert.equal(model.providerPause?.retry, true);
        const card = html.slice(html.indexOf("providerpause"), html.indexOf("</section>", html.indexOf("providerpause")));
        assert.doesNotMatch(card, /data-action="fresh/);
      }
    });
  }

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
