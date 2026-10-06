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
import {
  CUSTOM_MODEL_LABEL,
  CUSTOM_MODEL_VALUE,
  INCOMPLETE_CHOICES,
  exactModelProblem,
  withStagePin,
  PROVIDER_DEFAULT_LABEL,
  PROVIDER_DEFAULT_VALUE,
  agentConfigView,
  describeRole,
  parseEngineConfig,
  parseModelChoices,
  type ConfigRole,
  type EffectiveConfig,
  type EngineModelChoices,
  runtimeRepeatsSelection,
  sameModelName,
} from "../core/effectiveConfig";
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
    user_config_path: "/home/me/.config/agent-sparring/preferences.toml",
    user_config_exists: true,
    stage: {
      role: "stage",
      provider: "claude-cli",
      provider_display_name: "Claude",
      provider_source: "project",
      model: "claude-opus-5-5",
      model_source: "user",
      effort: "high",
      effort_source: "user",
      effort_supported: true,
      effort_levels: ["low", "medium", "high", "xhigh", "max"],
    },
    sparring: {
      role: "sparring",
      provider: "codex-cli",
      provider_display_name: "Codex",
      provider_source: "project",
      model: "gpt-5.6-terra",
      model_source: "user",
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
        ["Stage agent", "Claude · claude-opus-5-5 · high"],
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
    const mine = describeRole({ role: "stage", provider: "claude-cli", model: "claude-opus-5-5", model_source: "user", effort: "high", effort_source: "env" });
    assert.match(mine.detail, /Model claude-opus-5-5 from your own preference/);
    assert.match(mine.detail, /Effort high from an environment variable/);
  });

  it("reads where the user preferences file is, and no per-worktree location", () => {
    const value = parsed({ local_config_path: "/repo/.git/agent-sparring/.sparring.toml", local_config_exists: true });
    assert.equal(value.kind === "report" ? value.report.user_config_path : undefined, "/home/me/.config/agent-sparring/preferences.toml");
    assert.equal(value.kind === "report" ? value.report.user_config_exists : undefined, true);
    assert.equal(value.kind === "report" ? "local_config_path" in value.report : true, false, "a per-worktree override is no longer read");
    assert.equal(agentConfigView(value)?.userConfigPath, "/home/me/.config/agent-sparring/preferences.toml");
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
      ["Claude · claude-opus-5-5 · high", "Codex · gpt-5.6-terra"],
    );
  });

  it("renders editable controls and a Settings button", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW);
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /data-action="openSettings"/);
    assert.doesNotMatch(html, /agentconfig-effective/, "the dropdown shows the choice; no static line repeats it");
    assert.match(html, /Configured model: claude-opus-5-5\nModel source: user\n/, "where it came from stays under Technical details");
    assert.match(html, /<select data-role="stage"[^>]*data-field="model"/, "and a dropdown to change it");
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

  it("shows the configured exact model and where it came from, in a dropdown that keeps it", () => {
    assert.equal(role("stage").model.value, "claude-opus-5-5");
    assert.equal(role("sparring").model.value, "gpt-5.6-terra");
    assert.equal(role("stage").model.summary, "claude-opus-5-5 · Your preference");
    assert.equal(role("stage").model.fixedText, undefined, "an exact id can always be entered, so the model is always a control");
    assert.deepEqual(
      role("stage").model.options?.map((option) => option.value),
      [PROVIDER_DEFAULT_VALUE, "claude-opus-5-5", CUSTOM_MODEL_VALUE],
      "with no suggestions read: the default, the configured model, and Other exact model…",
    );
    assert.doesNotMatch(role("stage").model.detail, /project\.toml/, "model is no longer a project setting");
    assert.match(role("stage").model.detail, /your own preference[^.]*shared by every project/);
  });

  it("offers no Project setting option anywhere: clearing means the provider default", () => {
    for (const which of ["stage", "sparring"] as const) {
      const control = role(which);
      const labels = [...(control.model.options ?? []), ...(control.effort?.options ?? [])].map((option) => option.label);
      assert.ok(!labels.includes("Project setting"), `${which}: ${labels.join(", ")}`);
      assert.equal(control.model.options?.[0]?.label, PROVIDER_DEFAULT_LABEL);
      assert.equal(control.effort?.options?.[0]?.label, PROVIDER_DEFAULT_LABEL);
    }
  });

  it("says the words for no preference rather than naming a model nobody chose", () => {
    const none = role("stage", { stage: { ...JSON.parse(report()).stage, model: null, model_source: "provider-default" } });
    assert.equal(none.model.summary, PROVIDER_DEFAULT_LABEL);
    assert.equal(none.model.value, "", "and the sentinel is still the empty string, never those words");
    assert.deepEqual(none.model.options?.map((option) => option.value), [PROVIDER_DEFAULT_VALUE, CUSTOM_MODEL_VALUE]);
  });

  it("gives the card's Technical details the engine's facts for the role", () => {
    const facts = Object.fromEntries(role("stage").technical.map((entry) => [entry.label, entry.value]));
    assert.equal(facts["Role"], "stage");
    assert.match(facts["Provider"], /^claude-cli \(from project\.toml\)$/);
    assert.equal(facts["Preferences file"], "/home/me/.config/agent-sparring/preferences.toml");
    assert.equal(facts["Configured model"], "claude-opus-5-5");
    assert.equal(facts["Model source"], "user");
    assert.equal(facts["Effort"], "high (source: user)");
    const none = Object.fromEntries(role("sparring", { sparring: { ...JSON.parse(report()).sparring, model: null, model_source: "provider-default" } }).technical.map((entry) => [entry.label, entry.value]));
    assert.match(none["Configured model"], /^none/, "absent, not a guessed name");
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

  it("accepts null as clear this preference", () => {
    assert.equal(isAgentConfigMessage({ ...good, value: null }), true);
    assert.equal(isAgentConfigMessage({ ...good, field: "effort", value: null }), true);
  });

  it("carries the provider the control was drawn for", () => {
    assert.equal(isAgentConfigMessage({ ...good, provider: "claude-cli" }), true);
    assert.equal(isAgentConfigMessage({ ...good, provider: "" }), false);
    assert.equal(isAgentConfigMessage({ ...good, provider: 7 }), false);
  });

  it("accepts Other exact model… only as a model request with no value, and never its own sentinel as a model", () => {
    assert.equal(isAgentConfigMessage({ ...good, value: null, custom: true }), true);
    assert.equal(isAgentConfigMessage({ ...good, value: "x", custom: true }), false, "the host asks for the value");
    assert.equal(isAgentConfigMessage({ ...good, field: "effort", value: null, custom: true }), false);
    assert.equal(isAgentConfigMessage({ ...good, value: null, custom: "yes" }), false);
    assert.equal(isAgentConfigMessage({ ...good, value: CUSTOM_MODEL_VALUE }), false);
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
  it("every control carries its role, field, provider and the scope it was drawn from", () => {
    const model = buildOverviewModel(
      { ambiguous: [], scope: { repoRoot: "/work/fresh", name: "fresh" } },
      undefined,
      { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed() },
      NOW,
    );
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /data-scope="\/repo\/\.sparring\/project\.toml"/);
    for (const role of ["stage", "sparring"]) {
      assert.match(html, new RegExp(`data-role="${role}"[^>]*data-field="effort"`));
    }
    assert.match(html, /data-role="stage" data-scope="[^"]*" data-provider="claude-cli" data-field="model"/);
    assert.match(html, /data-role="sparring" data-scope="[^"]*" data-provider="codex-cli" data-field="model"/);
    assert.match(html, /data-field="effort"[^>]*data-sent="-"/, "cleared is its own mark, not a value that could spell it");
    assert.match(html, /<option value="[^"]*" data-custom="1">Other exact model…<\/option>/, "the custom entry is marked, never selected");
    assert.doesNotMatch(html, /data-custom="1" selected/);
  });

  it("says Applies from the next stage only while the selected stage is in progress", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const artifacts = { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed() };

    const quiet = buildOverviewModel(selection, undefined, artifacts, NOW);
    assert.equal(quiet.agentConfig?.activeRunNote, undefined, "a stage that has not started will pin what is current, so nothing is said");
    assert.doesNotMatch(renderOverviewHtml(quiet, "nonce", "csp:"), /Applies from the next stage/);

    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const busy = buildOverviewModel(selection, live, artifacts, Date.parse(live.lastEventTs!) + 1000);
    assert.equal(busy.agentConfig?.activeRunNote, APPLIES_NEXT_TURN);
    // A statement about when it lands, exactly these words.
    assert.equal(APPLIES_NEXT_TURN, "Applies from the next stage.");
    assert.match(renderOverviewHtml(busy, "nonce", "csp:"), /<p class="muted note">Applies from the next stage\.<\/p>/);

    // Paused between turns: no runner, but the stage has pinned its agents
    // (or run a session), so it is still in progress and the note stays.
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", implementation_session_id: "impl-1" });
    const paused = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, NOW);
    assert.equal(paused.agentConfig?.activeRunNote, APPLIES_NEXT_TURN, "a paused stage keeps its configuration too");
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", agents: { stage: { provider: "claude-cli", model: null, model_source: "provider-default", effort: null, effort_source: "provider-default" } } });
    const pinned = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, NOW);
    assert.equal(pinned.agentConfig?.activeRunNote, APPLIES_NEXT_TURN);
    await ws.writeStage(FOO_STAGE_IDS[0], { status: "accepted", implementation_session_id: "impl-1" });
    const done = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, NOW);
    assert.equal(done.agentConfig?.activeRunNote, undefined, "an accepted stage is not in progress");
    // And it is a note, not a lock: the controls are still there.
    assert.match(renderOverviewHtml(busy, "nonce", "csp:"), /data-field="effort"/);
  });
});

describe("choosing the model from the engine's suggestions", () => {
  const CHOICES = parseModelChoices(
    JSON.stringify({
      roles: [
        {
          role: "stage",
          provider: "claude-cli",
          source: "engine-known",
          complete: false,
          custom_allowed: true,
          choices: [
            { model: "claude-opus-5-5", display_name: "Claude Opus 5.5", effort_levels: [], default_effort: null },
            { model: "claude-fable-5-1", display_name: "Claude Fable 5.1", effort_levels: [], default_effort: null },
            { model: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", effort_levels: [], default_effort: null },
          ],
          error: null,
        },
        {
          role: "sparring",
          provider: "codex-cli",
          source: "provider-catalog",
          complete: false,
          custom_allowed: true,
          choices: [
            { model: "gpt-6-astra", display_name: "GPT-6-Astra", effort_levels: ["low", "high"], default_effort: "low" },
            { model: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", effort_levels: ["low"], default_effort: "low" },
            { bogus: true },
          ],
          error: null,
        },
      ],
      error: null,
    }),
  )!;
  const withChoices = (overrides: Record<string, unknown> = {}, modelChoices: readonly EngineModelChoices[] = CHOICES): EffectiveConfig => {
    const base = parsed(overrides);
    return base.kind === "report" ? { ...base, modelChoices } : base;
  };
  const controls = (config: EffectiveConfig, which: ConfigRole) => agentConfigView(config)?.controls.find((control) => control.role === which);

  it("parses model-choices, keeping well-formed choices and their provenance", () => {
    assert.equal(CHOICES.length, 2);
    assert.equal(CHOICES[1].source, "provider-catalog");
    assert.deepEqual(CHOICES[1].choices.map((choice) => choice.model), ["gpt-6-astra", "gpt-5.6-terra"], "a malformed choice is dropped");
    assert.equal(parseModelChoices("not json"), undefined);
    assert.equal(parseModelChoices('{"error": "x"}'), undefined);
  });

  it("offers the default, the suggestions for this role and provider, and Other exact model…", () => {
    const stage = controls(withChoices(), "stage")!;
    assert.equal(stage.model.value, "claude-opus-5-5");
    assert.deepEqual(stage.model.options?.map((option) => option.value), [PROVIDER_DEFAULT_VALUE, "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", CUSTOM_MODEL_VALUE], "the configured model is listed once");
    assert.equal(stage.model.options?.[1]?.label, "claude-opus-5-5 · Claude Opus 5.5", "the exact id first, then the provider's name for it");
    assert.equal(stage.model.options?.at(-1)?.label, CUSTOM_MODEL_LABEL);
    assert.equal(stage.model.options?.at(-1)?.custom, true);
    assert.match(stage.model.detail, /Suggestions from the models Agent Sparring knows; not a complete list\. Any exact model id can be entered\./, "an incomplete list is marked as such and is not validation");
    const sparring = controls(withChoices(), "sparring")!;
    assert.match(sparring.model.detail, /Suggestions from Codex's own model list/);
  });

  it("keeps a configured model no suggestion names, verbatim", () => {
    const exotic = controls(withChoices({ stage: { ...JSON.parse(report()).stage, model: "claude-opus-5-5-20260901" } }), "stage")!;
    assert.deepEqual(exotic.model.options?.slice(0, 3).map((option) => option.value), [PROVIDER_DEFAULT_VALUE, "claude-opus-5-5-20260901", "claude-opus-5-5"]);
    assert.equal(exotic.model.summary, "claude-opus-5-5-20260901 · Your preference");
  });

  it("never offers one provider's suggestions for another", () => {
    // The stage role now runs a different provider: the Claude list must not follow it.
    const moved = controls(withChoices({ stage: { ...JSON.parse(report()).stage, provider: "codex-cli", provider_display_name: "Codex", model: null, model_source: "provider-default" } }), "stage")!;
    assert.deepEqual(moved.model.options?.map((option) => option.value), [PROVIDER_DEFAULT_VALUE, CUSTOM_MODEL_VALUE], "no stage suggestions exist for codex-cli");
    // Nor does the sparrer's Codex list stand in for the stage role's.
    assert.ok(!moved.model.options?.some((option) => option.value === "gpt-6-astra"));
  });

  it("renders the model as a dropdown that posts the same agentConfig message as effort", () => {
    const html = renderOverviewHtml(buildOverviewModel({ ambiguous: [] }, undefined, { handoff: false, sparring: false, brief: false, plan: false, agentConfig: withChoices() } as OverviewArtifacts, NOW), "n", "c");
    assert.match(html, /<select [^>]*data-field="model"[^>]*>[\s\S]*?<option value="claude-fable-5-1">claude-fable-5-1 · Claude Fable 5\.1<\/option>/);
  });

  it("the write is set-config for the provider on screen, with no per-worktree flag", async () => {
    const probe = stripComments(await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "configProbe.ts"), "utf8"));
    assert.match(probe, /args\.push\("--for-provider", forProvider\)/);
    assert.match(probe, /args\.push\("--json"\)/);
    assert.doesNotMatch(probe, /"--local"/);
    const panel = stripComments(await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8"));
    assert.doesNotMatch(panel, /local_config_path|modelChoices"\)|--local/);
  });

  it("no extension source carries a list of model names, or the old modelChoices setting", async () => {
    const offenders: string[] = [];
    for (const file of await sources(path.join(__dirname, "..", "..", "src"))) {
      if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}integration${path.sep}`)) {
        continue;
      }
      const code = stripComments(await fs.readFile(file, "utf8"));
      if (/claude-(opus|sonnet|haiku|fable)-\d|gpt-\d|agentSparring\.modelChoices/.test(code)) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    assert.deepEqual(offenders, []);
    const manifest = JSON.parse(await fs.readFile(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    assert.equal(manifest.contributes.configuration.properties["agentSparring.modelChoices"], undefined);
  });
});

describe("the Other exact model… input", () => {
  it("refuses an empty id and one beginning with a dash before the engine is asked", () => {
    assert.match(exactModelProblem("") ?? "", /Enter an exact model id/);
    assert.match(exactModelProblem("   ") ?? "", /Enter an exact model id/);
    assert.match(exactModelProblem("-m") ?? "", /cannot begin with "-"/);
    assert.match(exactModelProblem("  --model") ?? "", /cannot begin with "-"/, "checked on the trimmed id");
    assert.equal(exactModelProblem("claude-opus-5-5-20260901"), undefined);
    assert.equal(exactModelProblem("a-b"), undefined, "a dash inside an id is fine");
  });

  it("is the input box's validateInput, and is checked again before the write", async () => {
    const panel = stripComments(await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "overview", "overviewPanel.ts"), "utf8"));
    assert.match(panel, /validateInput: exactModelProblem/);
    assert.match(panel, /if \(!exact \|\| exactModelProblem\(exact\)\)/);
  });
});

describe("the incomplete suggestion list", () => {
  it("is marked visibly wherever the engine says it is not complete, and never when it is", () => {
    const choices = (complete: boolean): EngineModelChoices[] => [{ role: "stage", provider: "claude-cli", source: "engine-known", complete, custom_allowed: true, choices: [{ model: "m-1" }], error: null }];
    const view = (complete: boolean) => {
      const base = parsed();
      return agentConfigView(base.kind === "report" ? { ...base, modelChoices: choices(complete) } : base)!.controls[0];
    };
    assert.ok(view(false).model.detail.includes(INCOMPLETE_CHOICES));
    assert.ok(!view(true).model.detail.includes(INCOMPLETE_CHOICES));
    assert.ok(view(false).technical.some((entry) => entry.label === "Model suggestions" && entry.value === "engine-known, not complete"));
    assert.equal(view(false).model.options?.at(-1)?.custom, true, "an exact custom id is always offered");
  });
});

describe("the stage's pinned configuration", () => {
  const stage = () => agentConfigView(parsed())!.controls[0];
  const pin = (overrides: Partial<{ provider: string; model: string | null; effort: string | null }> = {}) => ({
    provider: "claude-cli",
    model: "claude-opus-5-5",
    modelSource: "user",
    effort: "high",
    effortSource: "user",
    ...overrides,
  });

  it("says nothing extra when the stage runs with the current preference", () => {
    const same = withStagePin(stage(), pin());
    assert.equal(same.stagePin, undefined);
    assert.ok(same.technical.some((entry) => entry.label === "This stage runs with" && /claude-opus-5-5 \(source: user\)/.test(entry.value)), "but the pin is in Technical details");
    const controls = stage();
    assert.equal(withStagePin(controls, undefined), controls, "no pin, no change");
  });

  it("shows what this stage runs with when it differs from the preference", () => {
    assert.equal(withStagePin(stage(), pin({ model: "claude-fable-5-1" })).stagePin, "This stage: claude-fable-5-1 · high");
    assert.equal(withStagePin(stage(), pin({ effort: "low" })).stagePin, "This stage: claude-opus-5-5 · low");
    assert.equal(withStagePin(stage(), pin({ model: null, effort: null })).stagePin, "This stage: Provider default");
    assert.equal(withStagePin(stage(), pin({ provider: "acme-cli" })).stagePin, "This stage: acme-cli · claude-opus-5-5 · high");
  });

  it("is read tolerantly from state.json and shown on the card", async () => {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
    await ws.writeStage(FOO_STAGE_IDS[0], {
      status: "working",
      agents: {
        stage: { provider: "claude-cli", model: "claude-fable-5-1", model_source: "user", effort: "high", effort_source: "user" },
        sparring: { provider: "codex-cli", model: "gpt-5.6-terra", model_source: "user", effort: null, effort_source: "provider-default" },
        reviewer: "not an object",
      },
    });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const model = buildOverviewModel(selection, undefined, { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed() }, NOW);
    assert.equal(model.agentConfig?.controls[0].stagePin, "This stage: claude-fable-5-1 · high");
    assert.equal(model.agentConfig?.controls[1].stagePin, undefined, "the sparrer's pin matches its preference");
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /<div class="agentconfig-pin" data-stage-pin="stage">This stage: claude-fable-5-1 · high<\/div>/);
    assert.equal((html.match(/data-stage-pin=/g) ?? []).length, 1);

    for (const junk of [null, "x", [1], { stage: { model: "no provider" } }]) {
      await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", agents: junk });
      const again = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: false, brief: false, plan: false, agentConfig: parsed() }, NOW);
      assert.equal(again.agentConfig?.controls[0].stagePin, undefined, `no pin from ${JSON.stringify(junk)}`);
    }
  });
});

describe("a runtime model that only repeats the selected one is not shown twice", () => {
  const model = (value: string, label = value) => ({ field: "model" as const, label: "Model", value, detail: "", options: [{ value, label }] });
  it("treats case, punctuation and a bracketed suffix as spelling", () => {
    assert.ok(sameModelName("claude-opus-5-5", "Claude Opus 5.5"));
    assert.ok(sameModelName("claude-opus-5-5[1m]", "claude-opus-5-5"));
    assert.ok(!sameModelName("claude-opus-5-5", "claude-sonnet-5-5"));
    assert.ok(!sameModelName("", "claude-opus-5-5"));
  });
  it("compares against the selected value and its option label; Provider default is never repeated", () => {
    assert.ok(runtimeRepeatsSelection("Claude Opus 5.5", model("claude-opus-5-5")));
    assert.ok(runtimeRepeatsSelection("claude-opus-5-5", model("opus", "Claude Opus 5.5")));
    assert.ok(!runtimeRepeatsSelection("claude-sonnet-5-5", model("claude-opus-5-5")));
    assert.ok(!runtimeRepeatsSelection("claude-opus-5-5", model("")), "under Provider default the runtime model is news");
  });
});
