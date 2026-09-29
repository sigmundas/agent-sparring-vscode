/**
 * The setup notice: a fixable configuration problem the engine reported in
 * `show-config --json` `setup_problems`, said plainly with one button that
 * runs the engine's `fix-config`, and the engine's own text under Technical
 * details. Nothing here decides what is wrong; the engine's report does.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseEngineConfig, type EffectiveConfig } from "../core/effectiveConfig";
import { isActionMessage, renderOverviewHtml } from "../core/overviewHtml";
import {
  FIX_CONFIGURATION_LABEL,
  OBSOLETE_SETTINGS_HEADLINE,
  OBSOLETE_SETTINGS_LINE,
  REMOVE_OBSOLETE_LABEL,
  SETUP_HEADLINE,
  buildOverviewModel,
  setupNotice,
  type OverviewArtifacts,
} from "../core/overviewModel";
import { crossRepositoryIntake } from "./fixtures";

const MESSAGE =
  "plan intake artifacts under .sparring/intake/ are not ignored by git. They are engine-generated runtime state, and leaving them visible would make freeze-candidate refuse the worktree as dirty.\nFix: add a line '.sparring/intake/' to /repo/.gitignore, next to '.sparring/stages/' and '.sparring/plans/'.\nCheck it with: sparring check-config";

function config(extra: Record<string, unknown>): EffectiveConfig {
  const report = parseEngineConfig(JSON.stringify({ config_path: "/repo/.sparring/project.toml", config_exists: true, project: "demo", error: null, stage: { role: "stage", provider: "claude-cli", model: null, effort: null }, ...extra }));
  assert.ok(report);
  return { kind: "report", report };
}

const PROBLEM = { kind: "not-ignored", what: "plan intake", ignore_line: ".sparring/intake/", gitignore: "/repo/.gitignore", message: MESSAGE };
const artifacts = (agentConfig: EffectiveConfig): OverviewArtifacts => ({ handoff: false, sparring: false, brief: false, plan: false, agentConfig });

describe("the setup notice", () => {
  it("says what needs doing in one plain sentence per problem", () => {
    const notice = setupNotice(config({ setup_problems: [PROBLEM] }));
    assert.deepEqual(notice && { headline: notice.headline, lines: notice.lines }, { headline: SETUP_HEADLINE, lines: [".sparring/intake/ must be ignored by Git."] });
    assert.equal(notice?.technical, MESSAGE, "the engine's own words are kept for the details");
  });

  it("is absent when the engine found nothing, or does not report setup at all", () => {
    assert.equal(setupNotice(config({ setup_problems: [] })), undefined);
    assert.equal(setupNotice(config({})), undefined, "an older engine: no notice, never a guess");
    assert.equal(setupNotice(config({ setup_problems: [{ kind: "not-ignored" }] })), undefined, "a malformed entry is not shown");
  });

  it("renders the headline, the line, Fix configuration, and the raw text under Technical details", () => {
    const html = renderOverviewHtml(buildOverviewModel({ ambiguous: [] }, undefined, artifacts(config({ setup_problems: [PROBLEM] }))), "n", "c");
    assert.match(html, /<section class="setupnotice" role="alert">/);
    assert.match(html, new RegExp(`<strong>${SETUP_HEADLINE}</strong>`));
    assert.match(html, /<li>\.sparring\/intake\/ must be ignored by Git\.<\/li>/);
    assert.match(html, new RegExp(`data-action="fixConfiguration"[^>]*>${FIX_CONFIGURATION_LABEL}</button>`));
    const details = /<details class="setup-technical"><summary>Technical details<\/summary><pre class="engineerror">([\s\S]*?)<\/pre><\/details>/.exec(html);
    assert.ok(details, "the engine's output is folded away");
    assert.match(details[1], /Fix: add a line &#39;\.sparring\/intake\/&#39; to \/repo\/\.gitignore|Fix: add a line '\.sparring\/intake\/' to \/repo\/\.gitignore/);
    assert.ok(isActionMessage({ type: "action", action: "fixConfiguration" }), "the host accepts the click");
  });

  it("appears on the intake screen too, where the refusal would otherwise first be met", async () => {
    const world = await crossRepositoryIntake();
    const discovery = await world.discover();
    const [intake] = discovery.intakes ?? [];
    const html = renderOverviewHtml(buildOverviewModel({ ambiguous: [], intake }, undefined, artifacts(config({ setup_problems: [PROBLEM] }))), "n", "c");
    assert.match(html, /class="setupnotice"/);
    assert.ok(html.indexOf('class="setupnotice"') < html.indexOf('class="top"'), "above the screen's own content");
  });

  it("the button asks the engine to fix it; the extension never writes .gitignore itself", async () => {
    const root = path.join(__dirname, "..", "..", "src");
    const probe = await fs.readFile(path.join(root, "vscode", "configProbe.ts"), "utf8");
    assert.match(probe, /\["--sparring-dir", sparringDir, "fix-config", "--json"\]/);
    for (const file of ["vscode/configProbe.ts", "vscode/commands.ts", "core/overviewModel.ts", "core/overviewHtml.ts"]) {
      const source = await fs.readFile(path.join(root, file), "utf8");
      assert.doesNotMatch(source, /writeFile\([^)]*gitignore/i, `${file} does not edit .gitignore`);
    }
  });
});

const OBSOLETE_MESSAGE =
  ".sparring/project.toml sets [agents.stage] model = 'claude-opus-5-5', which no longer takes effect: model and effort are now your own preferences, shared by every project, and are not read from project.toml. 'sparring fix-config' removes the obsolete key; choose your preference with 'sparring set-config stage --model <value>'";
const OBSOLETE = { kind: "obsolete-agent-setting", what: "stage agent model", role: "stage", field: "model", value: "claude-opus-5-5", config_path: ".sparring/project.toml", message: OBSOLETE_MESSAGE };

describe("the obsolete project model/effort notice", () => {
  it("says it plainly, with one button that removes the old settings", () => {
    const notice = setupNotice(config({ setup_problems: [OBSOLETE, { ...OBSOLETE, what: "stage agent effort", field: "effort", value: "high" }] }));
    assert.ok(notice);
    assert.equal(notice.headline, OBSOLETE_SETTINGS_HEADLINE);
    assert.deepEqual(notice.lines, [OBSOLETE_SETTINGS_LINE], "one plain sentence, however many keys");
    assert.match(OBSOLETE_SETTINGS_LINE, /Model and effort are now your own preferences, shared by every project\. This project still has old model\/effort settings\./);
    assert.equal(notice.action.label, REMOVE_OBSOLETE_LABEL);
    assert.match(notice.action.detail, /fix-config/);
    assert.match(notice.action.detail, /preferences are not changed/, "the fix does not choose a preference");
  });

  it("keeps role, field, value, config path and the engine's words for Technical details only", () => {
    const notice = setupNotice(config({ setup_problems: [OBSOLETE] }))!;
    assert.match(notice.technical, /role: stage\nfield: model\nvalue: claude-opus-5-5\nconfig: \.sparring\/project\.toml\n/);
    assert.ok(notice.technical.includes(OBSOLETE_MESSAGE));
    assert.ok(!notice.lines.join(" ").includes("[agents.stage]"), "engine nouns stay out of the plain text");
    const html = renderOverviewHtml(buildOverviewModel({ ambiguous: [] }, undefined, artifacts(config({ setup_problems: [OBSOLETE] }))), "n", "c");
    assert.match(html, new RegExp(`<strong>${OBSOLETE_SETTINGS_HEADLINE}</strong>`));
    assert.match(html, new RegExp(`data-action="fixConfiguration"[^>]*>${REMOVE_OBSOLETE_LABEL}</button>`), "the same engine fix, named for what it does");
    const details = /<details class="setup-technical"><summary>Technical details<\/summary><pre class="engineerror">([\s\S]*?)<\/pre><\/details>/.exec(html);
    assert.ok(details);
    assert.match(details[1], /field: model/);
  });

  it("shares one notice and the general Fix configuration with a .gitignore problem", () => {
    const notice = setupNotice(config({ setup_problems: [OBSOLETE, PROBLEM] }))!;
    assert.equal(notice.headline, SETUP_HEADLINE);
    assert.deepEqual(notice.lines, [OBSOLETE_SETTINGS_LINE, ".sparring/intake/ must be ignored by Git."]);
    assert.equal(notice.action.label, FIX_CONFIGURATION_LABEL);
    assert.equal(notice.gitignore, "/repo/.gitignore");
  });

  it("drops an obsolete-setting entry that does not name its key", () => {
    assert.equal(setupNotice(config({ setup_problems: [{ kind: "obsolete-agent-setting", what: "x", message: "m" }] })), undefined);
  });

  it("the fix is the engine's fix-config, and reads what it removed without choosing a preference", async () => {
    const root = path.join(__dirname, "..", "..", "src");
    const probe = await fs.readFile(path.join(root, "vscode", "configProbe.ts"), "utf8");
    assert.match(probe, /payload\["removed"\]/);
    const commands = await fs.readFile(path.join(root, "vscode", "commands.ts"), "utf8");
    const fix = commands.slice(commands.indexOf("async function fixConfigurationCommand"), commands.indexOf("async function sliceBranchCommand"));
    assert.doesNotMatch(fix, /writeAgentConfig|set-config/, "removing an old key never picks a new preference");
  });
});
