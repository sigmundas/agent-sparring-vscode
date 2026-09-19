/**
 * The effective agent configuration, as the cockpit shows it.
 *
 * The load-bearing property under test is negative: the extension must not
 * know anything about providers, models, effort levels, TOML or precedence.
 * Everything it displays has to be traceable to a field the engine reported,
 * which is why several of these tests feed deliberately unfamiliar values
 * through and expect them to come out unchanged.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PROVIDER_DEFAULT_LABEL, PROVIDER_DEFAULT_VALUE, agentConfigView, describeRole, parseEngineConfig, type ConfigRole, type EffectiveConfig } from "../core/effectiveConfig";
import { discoverRuns, selectRun, type RunSelection } from "../core/discovery";
import { MODEL_MAX_LENGTH, isActionMessage, isAgentConfigMessage, renderOverviewHtml } from "../core/overviewHtml";
import { APPLIES_NEXT_TURN, buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { foldEvents } from "../core/liveState";
import { event } from "./fixtures";
import { settingsTarget } from "../core/settingsTarget";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace } from "./fixtures";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

/** Every .ts file under a directory, recursively. */
async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sources(full)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Source with comment lines removed, so prose about a thing is not the thing. */
function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
}

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    config_path: "/repo/.sparring/project.toml",
    config_exists: true,
    project: "demo",
    error: null,
    stage: {
      role: "stage",
      provider: "claude-cli",
      provider_display_name: "Claude",
      provider_source: "project",
      model: "opus",
      model_source: "project",
      effort: "high",
      effort_source: "project",
      effort_supported: true,
      effort_levels: ["low", "medium", "high", "xhigh", "max"],
    },
    sparring: {
      role: "sparring",
      provider: "codex-cli",
      provider_display_name: "Codex",
      provider_source: "project",
      model: "gpt-5.6-terra",
      model_source: "project",
      effort: null,
      effort_source: "provider-default",
      effort_supported: true,
      effort_levels: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    },
    ...overrides,
  });
}

function parsed(overrides: Record<string, unknown> = {}): EffectiveConfig {
  const value = parseEngineConfig(report(overrides));
  assert.ok(value, "the fixture must parse");
  return { kind: "report", report: value };
}

describe("reading the engine's effective configuration", () => {
  it("keeps the engine's values, including the provider display name", () => {
    const view = agentConfigView(parsed());
    assert.deepEqual(
      view?.lines.map((line) => [line.role, line.text]),
      [
        ["Stage agent", "Claude · opus · high"],
        ["Sparrer", "Codex · gpt-5.6-terra"],
      ],
    );
  });

  it("renders an omitted model as a provider default rather than a name", () => {
    const view = agentConfigView(
      parsed({
        stage: { role: "stage", provider: "claude-cli", provider_display_name: "Claude", provider_source: "project", model: null, model_source: "provider-default", effort: null, effort_source: "provider-default", effort_supported: true },
      }),
    );
    assert.equal(view?.lines[0]?.text, "Claude · provider default");
    assert.match(view?.lines[0]?.detail ?? "", /No model configured, so the provider chooses its own/);
  });

  it("says nothing about effort when the provider has none, and says why in the tooltip", () => {
    const line = describeRole({ role: "sparring", provider: "some-cli", provider_display_name: "Some CLI", model: "m-1", effort: null, effort_supported: false });
    assert.equal(line.text, "Some CLI · m-1");
    assert.doesNotMatch(line.text, /effort|none|null/i);
    assert.match(line.detail, /Some CLI has no effort setting/);
  });

  it("reports an unfamiliar provider by whatever the engine called it", () => {
    // A provider the extension has never heard of must still render: the
    // engine is the authority on the vocabulary, not this table-free module.
    const line = describeRole({ role: "stage", provider: "future-cli", model: "m", effort: "ludicrous" });
    assert.equal(line.text, "future-cli · m · ludicrous");
  });

  it("states where each value came from", () => {
    const line = describeRole({ role: "stage", provider: "claude-cli", provider_display_name: "Claude", provider_source: "project", model: "sonnet", model_source: "cli", effort: "max", effort_source: "cli" });
    assert.match(line.detail, /Model sonnet from a command-line override/);
    assert.match(line.detail, /Effort max from a command-line override/);
  });

  it("surfaces an engine configuration error and withholds invented role lines", () => {
    const view = agentConfigView(parsed({ error: "[agents.stage] effort 'ultra' is not supported by provider 'claude-cli'", stage: undefined, sparring: undefined }));
    assert.deepEqual(view?.lines, []);
    assert.match(view?.note ?? "", /not supported by provider 'claude-cli'/);
  });

  it("says nothing at all when the engine could not be asked", () => {
    const view = agentConfigView({ kind: "unavailable", reason: "This engine has no `show-config` command." });
    assert.deepEqual(view?.lines, []);
    assert.match(view?.note ?? "", /no `show-config` command/);
    assert.equal(agentConfigView(undefined), undefined);
  });

  it("refuses output that is not the shape the engine promises", () => {
    assert.equal(parseEngineConfig("not json"), undefined);
    assert.equal(parseEngineConfig("null"), undefined);
    assert.equal(parseEngineConfig('{"config_path": "/x", "config_exists": true}'), undefined, "neither roles nor an error explains nothing");
  });

  it("notes that a project has no project.toml yet without calling it an error", () => {
    const view = agentConfigView(parsed({ config_exists: false, project: null }));
    assert.match(view?.note ?? "", /No project.toml yet/);
    assert.equal(view?.configExists, false);
    assert.ok((view?.lines.length ?? 0) > 0, "the engine defaults are still real values");
  });
});

describe("no configuration logic is duplicated in the extension", () => {
  it("the core config module mentions no provider, model, effort level or TOML parsing", async () => {
    // A guard, not a style rule: the moment this module can answer "what
    // does an omitted model mean for Claude" on its own, the cockpit has a
    // second opinion about what is going to run.
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "core", "effectiveConfig.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join("\n")
      .toLowerCase()
      // Naming the file is fine; parsing it is not.
      .split("project.toml")
      .join("<the config file>");
    for (const forbidden of ["claude-cli", "codex-cli", "xhigh", "ultra", "opus", "gpt-", "toml"]) {
      assert.doesNotMatch(code, new RegExp(forbidden), `effectiveConfig.ts must not know about ${forbidden}`);
    }
  });

  it("no extension source carries a list of any provider's effort levels", async () => {
    // (7) and (8). The dropdown is built from `effort_levels` in the
    // engine's JSON, so a level the extension spells out anywhere in its
    // code is a second, silently diverging copy of a provider's capability.
    const offenders: string[] = [];
    for (const file of await sources(path.join(__dirname, "..", "..", "src"))) {
      if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}integration${path.sep}`)) {
        continue;
      }
      const code = stripComments(await fs.readFile(file, "utf8"));
      // "minimal", "low", "medium" and "high" are ordinary English and
      // appear in unrelated code; "xhigh" and "ultra" are levels and
      // nothing else, so they are the ones worth guarding.
      if (/\bxhigh\b/i.test(code) || /\bultra\b/i.test(code)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    assert.deepEqual(offenders, [], "effort levels must come from the engine, never from extension source");
  });

  it("nothing in the extension writes the config file", async () => {
    // (10). Mutation goes through `sparring set-config`. A write here would
    // be the cockpit owning a schema the engine validates.
    const offenders: string[] = [];
    for (const file of await sources(path.join(__dirname, "..", "..", "src"))) {
      if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}integration${path.sep}`)) {
        continue;
      }
      // A write whose target is the config file. Other writes are none of
      // this test's business, so the two have to meet in one statement.
      const writes = stripComments(await fs.readFile(file, "utf8"))
        .split(";")
        .filter((statement) => /writeFile|appendFile|createWriteStream|WorkspaceEdit|\.write\(/.test(statement));
      if (writes.some((statement) => /configPath|project\.toml|PROJECT_CONFIG_FILENAME/.test(statement))) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the only engine command that changes configuration is set-config", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "configProbe.ts"), "utf8");
    assert.match(source, /"set-config"/, "the mutation is the engine's own command");
    assert.match(source, /`--\${field}-default`/, "clearing is the engine's own flag, not an empty value");
    assert.doesNotMatch(stripComments(source), /writeFile|tomlkit|\[agents\./);
  });

  it("no extension source carries a project.toml template", async () => {
    // Creation goes through the engine's own `init-config`. A template here
    // would be a second copy of the schema, free to drift from the one the
    // engine validates against.
    const root = path.join(__dirname, "..", "..", "src");
    const offenders: string[] = [];
    for (const file of await sources(root)) {
      if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}integration${path.sep}`)) {
        continue;
      }
      if (/\[agents\.(stage|sparring)\]/.test(await fs.readFile(file, "utf8"))) {
        offenders.push(path.relative(root, file));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the settings target module only locates the file, it does not read it", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "core", "settingsTarget.ts"), "utf8");
    assert.doesNotMatch(source, /readFile|parse|TOML\.|JSON\.parse/);
  });
});

describe("which project the Settings action opens", () => {
  it("follows the selected run's repository", async () => {
    const ws = await Workspace.create();
    await ws.writeStage("stage-1", { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const target = settingsTarget(selection);
    assert.equal(target?.configPath, path.join(ws.sparringDir, "project.toml"));
  });

  it("follows the active repository when no run is selected", () => {
    const selection: RunSelection = { ambiguous: [], scope: { repoRoot: "/work/other-repo", name: "other-repo" } };
    const target = settingsTarget(selection);
    assert.equal(target?.configPath, path.join("/work/other-repo", ".sparring", "project.toml"));
    assert.equal(target?.repository, "other-repo");
  });

  it("changing the repository changes the target", () => {
    const a = settingsTarget({ ambiguous: [], scope: { repoRoot: "/work/a", name: "a" } });
    const b = settingsTarget({ ambiguous: [], scope: { repoRoot: "/work/b", name: "b" } });
    assert.notEqual(a?.configPath, b?.configPath);
  });

  it("offers nothing when no repository could be resolved", () => {
    assert.equal(settingsTarget({ ambiguous: [] }), undefined);
  });
});

describe("the Overview shows the configuration and offers Settings", () => {
  async function planSelection(): Promise<RunSelection> {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" });
    return selectRun((await discoverRuns([ws.location])).runs);
  }

  function artifacts(agentConfig: EffectiveConfig | undefined): OverviewArtifacts {
    return { handoff: false, sparring: false, brief: false, plan: false, agentConfig };
  }

  it("describes both roles in one line each, for the tooltip and for a reader", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW);
    assert.deepEqual(
      model.agentConfig?.lines.map((line) => line.text),
      ["Claude · opus · high", "Codex · gpt-5.6-terra"],
    );
  });

  it("renders editable controls and a Settings button", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW);
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /data-action="openSettings"/);
    assert.match(html, /<input type="text" data-role="stage"[^>]*data-field="model"[^>]*value="opus"/);
    assert.match(html, /<select data-role="stage"[^>]*data-field="effort"/);
    assert.match(html, /<select data-role="sparring"[^>]*data-field="effort"/);
  });

  it("does not print an effort the engine did not report", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW);
    const line = model.agentConfig?.lines.find((entry) => entry.role === "Sparrer");
    assert.equal(line?.text, "Codex · gpt-5.6-terra");
    const sparring = model.agentConfig?.controls.find((entry) => entry.role === "sparring");
    assert.equal(sparring?.effort?.value, "", "an unset effort is the default option, not a level");
  });

  it("surfaces an engine config error without losing the rest of the Overview", async () => {
    const broken = parsed({ error: "project.toml [agents.stage] has unknown field(s) 'efort'", stage: undefined, sparring: undefined });
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(broken), NOW);
    assert.equal(model.kind, "run", "the run is still rendered");
    assert.match(model.agentConfig?.note ?? "", /unknown field/);
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /unknown field\(s\) &#39;efort&#39;/, "escaped, and still offered with Settings");
    assert.match(html, /data-action="openSettings"/);
  });

  it("shows nothing about agents when the engine was never asked", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(undefined), NOW);
    assert.equal(model.agentConfig, undefined);
    assert.doesNotMatch(renderOverviewHtml(model, "nonce", "csp:"), /data-action="openSettings"/);
  });

  it("offers Settings in a repository that has no run yet", () => {
    const model = buildOverviewModel({ ambiguous: [], scope: { repoRoot: "/work/fresh", name: "fresh" } }, undefined, artifacts(parsed({ config_exists: false })), NOW);
    assert.equal(model.kind, "empty");
    assert.match(model.agentConfig?.note ?? "", /No project.toml yet/);
    assert.match(renderOverviewHtml(model, "nonce", "csp:"), /data-action="openSettings"/);
  });
});

/**
 * The inline selector.
 *
 * The same negative property as above, applied to controls rather than to
 * text: every option a person can pick has to have come from the engine's
 * JSON. These tests therefore feed provider names, levels and model names
 * the extension has never heard of and expect them to be offered verbatim.
 */
describe("the inline agent config selector", () => {
  function controls(overrides: Record<string, unknown> = {}) {
    const view = agentConfigView(parsed(overrides));
    assert.ok(view, "a view");
    return view.controls;
  }

  function role(name: ConfigRole, overrides: Record<string, unknown> = {}) {
    const found = controls(overrides).find((control) => control.role === name);
    assert.ok(found, `controls for ${name}`);
    return found;
  }

  it("offers a free-form model control carrying the engine's current value", () => {
    assert.equal(role("stage").model.value, "opus");
    assert.equal(role("sparring").model.value, "gpt-5.6-terra");
    // No options: a closed list would reject a model the provider has and
    // the extension has not heard of.
    assert.equal(role("stage").model.options, undefined);
    assert.equal(role("stage").model.placeholder, PROVIDER_DEFAULT_LABEL);
  });

  it("accepts a model identifier the extension has never seen", () => {
    const exotic = role("stage", {
      stage: { ...JSON.parse(report()).stage, model: "some-model-2031-preview" },
    });
    assert.equal(exotic.model.value, "some-model-2031-preview");
  });

  it("shows an unset model as the provider default, and writes no such model name", () => {
    const unset = role("stage", { stage: { ...JSON.parse(report()).stage, model: null, model_source: "provider-default" } });
    assert.equal(unset.model.value, PROVIDER_DEFAULT_VALUE);
    assert.equal(PROVIDER_DEFAULT_VALUE, "", "the sentinel is empty, so nothing is ever written as a model name");
    assert.match(unset.model.detail, /chooses its own/);
  });

  it("builds the effort dropdown from the engine's levels, default first", () => {
    assert.deepEqual(
      role("stage").effort?.options?.map((option) => option.value),
      ["", "low", "medium", "high", "xhigh", "max"],
    );
    assert.equal(role("stage").effort?.options?.[0].label, PROVIDER_DEFAULT_LABEL);
    assert.deepEqual(
      role("sparring").effort?.options?.map((option) => option.value),
      ["", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    );
  });

  it("renders whatever levels the engine reports, including ones that do not exist today", () => {
    const invented = role("stage", {
      stage: { ...JSON.parse(report()).stage, effort: "glacial", effort_levels: ["brisk", "glacial"] },
    });
    assert.deepEqual(invented.effort?.options?.map((option) => option.value), ["", "brisk", "glacial"]);
    assert.equal(invented.effort?.value, "glacial");
  });

  it("selects the default option when no effort is configured", () => {
    assert.equal(role("sparring").effort?.value, PROVIDER_DEFAULT_VALUE);
  });

  it("renders no effort control at all when the provider has no such setting", () => {
    const none = role("stage", {
      stage: { ...JSON.parse(report()).stage, effort: null, effort_supported: false, effort_levels: [] },
    });
    assert.equal(none.effort, undefined, "a dropdown would suggest a setting this provider does not have");
    const html = renderOverviewHtml(
      buildOverviewModel(
        { ambiguous: [], scope: { repoRoot: "/work/fresh", name: "fresh" } },
        undefined,
        { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed({ stage: { ...JSON.parse(report()).stage, effort: null, effort_supported: false, effort_levels: [] } }) },
        NOW,
      ),
      "nonce",
      "csp:",
    );
    assert.doesNotMatch(html, /data-role="stage"[^>]*data-field="effort"/);
  });

  it("shows the provider read-only while the engine reports one provider for the role", () => {
    assert.equal(role("stage").provider.options, undefined);
    assert.equal(role("stage").provider.fixedText, "Claude");
    assert.equal(role("stage").provider.value, "claude-cli", "the canonical id is what a mutation would send");
  });

  it("makes the provider a real dropdown as soon as the engine reports a second one", () => {
    const many = role("stage", {
      stage: {
        ...JSON.parse(report()).stage,
        provider_choices: [
          { provider: "claude-cli", display_name: "Claude", effort_supported: true, effort_levels: ["low"] },
          { provider: "acme-cli", display_name: "Acme", effort_supported: true, effort_levels: ["brisk"] },
        ],
      },
    });
    assert.deepEqual(many.provider.options?.map((option) => option.value), ["claude-cli", "acme-cli"]);
    assert.equal(many.provider.fixedText, undefined);
  });

  it("offers no controls when the engine could not resolve the configuration", () => {
    const view = agentConfigView(parsed({ error: "bad file", stage: undefined, sparring: undefined }));
    assert.deepEqual(view?.controls, []);
    assert.match(view?.note ?? "", /bad file/);
  });

  it("still offers controls in a repository that has no project.toml yet", () => {
    const view = agentConfigView(parsed({ config_exists: false }));
    assert.equal(view?.controls.length, 2, "this is exactly where someone sets it up");
  });

  it("offers the controls on the no-run screen too, where setup actually happens", () => {
    const model = buildOverviewModel(
      { ambiguous: [], scope: { repoRoot: "/work/fresh", name: "fresh" } },
      undefined,
      { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed({ config_exists: false }) },
      NOW,
    );
    assert.equal(model.kind, "empty");
    assert.equal(model.agentConfig?.controls.length, 2);
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /data-role="stage"[^>]*data-field="model"/);
    assert.match(html, /data-role="sparring"[^>]*data-field="effort"/);
    assert.match(html, /data-action="openSettings"/, "and the file is still one click away");
  });
});

describe("what the selector puts on the wire", () => {
  const scope = "/repo/.sparring/project.toml";
  const good = { type: "agentConfig", role: "stage", field: "model", value: "opus", scope };

  it("accepts a well-formed change", () => {
    assert.equal(isAgentConfigMessage(good), true);
    assert.equal(isAgentConfigMessage({ ...good, field: "effort", value: "high" }), true);
    assert.equal(isAgentConfigMessage({ ...good, role: "sparring" }), true);
  });

  it("accepts null as clear this override", () => {
    assert.equal(isAgentConfigMessage({ ...good, value: null }), true);
    assert.equal(isAgentConfigMessage({ ...good, field: "effort", value: null }), true);
  });

  it("refuses a role or field outside the engine's own vocabulary", () => {
    assert.equal(isAgentConfigMessage({ ...good, role: "reviewer" }), false);
    assert.equal(isAgentConfigMessage({ ...good, field: "sandbox" }), false);
    assert.equal(isAgentConfigMessage({ ...good, field: "repo.root" }), false);
  });

  it("refuses a provider change with no provider, since a role always has one", () => {
    assert.equal(isAgentConfigMessage({ ...good, field: "provider", value: "acme-cli" }), true);
    assert.equal(isAgentConfigMessage({ ...good, field: "provider", value: null }), false);
  });

  it("refuses a message with no scope, because scope is what stops a stale write", () => {
    assert.equal(isAgentConfigMessage({ ...good, scope: "" }), false);
    assert.equal(isAgentConfigMessage({ type: "agentConfig", role: "stage", field: "model", value: "opus" }), false);
  });

  it("refuses an empty string and anything unreasonably long", () => {
    assert.equal(isAgentConfigMessage({ ...good, value: "" }), false, "a clear is null, not an empty value");
    assert.equal(isAgentConfigMessage({ ...good, value: "x".repeat(MODEL_MAX_LENGTH) }), true);
    assert.equal(isAgentConfigMessage({ ...good, value: "x".repeat(MODEL_MAX_LENGTH + 1) }), false);
  });

  it("is not reachable through the action channel", () => {
    assert.equal(isActionMessage({ type: "action", action: "agentConfig" }), false);
  });
});

describe("the rendered controls are self-describing", () => {
  it("every control carries its role, field and the scope it was drawn from", () => {
    const model = buildOverviewModel(
      { ambiguous: [], scope: { repoRoot: "/work/fresh", name: "fresh" } },
      undefined,
      { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed() },
      NOW,
    );
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /data-scope="\/repo\/\.sparring\/project\.toml"/);
    for (const role of ["stage", "sparring"]) {
      assert.match(html, new RegExp(`data-role="${role}"[^>]*data-field="model"`));
      assert.match(html, new RegExp(`data-role="${role}"[^>]*data-field="effort"`));
    }
    // The value each control was rendered with, so simply tabbing through a
    // field posts nothing.
    assert.match(html, /data-field="model"[^>]*data-sent="opus"/);
    assert.match(html, /data-field="effort"[^>]*data-sent="null"/);
  });

  it("says a change lands on the next turn only while a run is actually active", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const artifacts = { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed() };

    const quiet = buildOverviewModel(selection, undefined, artifacts, NOW);
    assert.equal(quiet.agentConfig?.activeRunNote, undefined, "nothing is running, so nothing is said");

    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const busy = buildOverviewModel(selection, live, artifacts, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(busy.agentConfig?.activeRunNote, APPLIES_NEXT_TURN);
    // A statement about when it lands, never a claim that the running agent
    // changed model part-way through its own call.
    assert.match(APPLIES_NEXT_TURN, /next agent turn/);
    assert.doesNotMatch(APPLIES_NEXT_TURN, /cannot|blocked|not allowed/i);
    assert.match(renderOverviewHtml(busy, "nonce", "csp:"), /next agent turn/);
    // And it is a note, not a lock: the controls are still there.
    assert.match(renderOverviewHtml(busy, "nonce", "csp:"), /data-field="effort"/);
  });
});
