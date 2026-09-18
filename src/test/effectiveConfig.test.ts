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
import { agentConfigView, describeRole, parseEngineConfig, type EffectiveConfig } from "../core/effectiveConfig";
import { discoverRuns, selectRun, type RunSelection } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
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

  it("renders both roles and a Settings button", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW);
    assert.deepEqual(
      model.agentConfig?.lines.map((line) => line.text),
      ["Claude · opus · high", "Codex · gpt-5.6-terra"],
    );
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.match(html, /data-action="openSettings"/);
    assert.match(html, /Claude · opus · high/);
    assert.match(html, /Codex · gpt-5\.6-terra/);
  });

  it("does not print an effort the engine did not report", async () => {
    const model = buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW);
    const html = renderOverviewHtml(model, "nonce", "csp:");
    assert.doesNotMatch(html, /Codex · gpt-5\.6-terra · /);
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
