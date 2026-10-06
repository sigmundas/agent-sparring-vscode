import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { EngineRoleConfig } from "../core/effectiveConfig";
import { PLANNING_SKILL } from "../core/gettingStarted";
import { looksLikePlanningInput, planningArgs, planningProviders, pluginInstallPath } from "../core/makePlan";

const role = (over: Partial<EngineRoleConfig>): EngineRoleConfig => ({ role: "stage", provider: "claude-cli", ...over }) as EngineRoleConfig;

describe("Make Plan…", () => {
  it("offers each provider the engine reports once, and only those it can open interactively", () => {
    const providers = planningProviders([
      role({ provider: "claude-cli", provider_display_name: "Claude", provider_choices: [{ provider: "claude-cli", display_name: "Claude" }, { provider: "mystery-cli", display_name: "Mystery" }] } as Partial<EngineRoleConfig>),
      role({ role: "sparring", provider: "codex-cli", provider_display_name: "Codex" }),
      undefined,
    ]);
    assert.deepEqual(providers.map((p) => [p.provider, p.label, p.command]), [["claude-cli", "Claude", "claude"], ["codex-cli", "Codex", "codex"]]);
  });

  it("Claude invokes the planning skill by its slash command, with the source and a planning-only instruction, as one argument", () => {
    const [claude] = planningProviders([role({ provider_display_name: "Claude" })]);
    const planned = planningArgs(claude, "plans/INBOX.md", undefined);
    assert.ok(planned.ok);
    assert.equal(planned.args.length, 1, "one exact argument; no shell assembles it");
    assert.ok(planned.args[0].startsWith(`${PLANNING_SKILL} `));
    assert.match(planned.args[0], /plans\/INBOX\.md/);
    assert.match(planned.args[0], /must not edit or overwrite it/);
    assert.match(planned.args[0], /do not implement anything, create branches, commit, or start a run/);
  });

  it("Codex is pointed at the same skill's file, and is refused with a reason when the plugin is not installed", () => {
    const [codex] = planningProviders([role({ role: "sparring", provider: "codex-cli", provider_display_name: "Codex" })]);
    const missing = planningArgs(codex, "INBOX.md", undefined);
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.reason : "", /plugin install agent-sparring@agent-sparring/);
    const planned = planningArgs(codex, "INBOX.md", "/p/skills/sparring-plan/SKILL.md");
    assert.ok(planned.ok);
    assert.match(planned.args[0], /^Follow the planning instructions in \/p\/skills\/sparring-plan\/SKILL\.md/);
  });

  it("finds the agent-sparring plugin in Claude Code's installed plugins, whatever its marketplace", () => {
    assert.equal(pluginInstallPath(JSON.stringify({ plugins: { "other@x": [{ installPath: "/o" }], "agent-sparring@agent-sparring": [{ installPath: "/a" }] } })), "/a");
    assert.equal(pluginInstallPath(JSON.stringify({ plugins: {} })), undefined);
    assert.equal(pluginInstallPath("not json"), undefined);
  });

  it("names INBOX, notes and ideas files as likely planning input", () => {
    assert.ok(looksLikePlanningInput("/r/plans/INBOX.md"));
    assert.ok(looksLikePlanningInput("notes.md"));
    assert.ok(!looksLikePlanningInput("docs/plans/cloud-sync.md"));
  });

  it("starts the provider as the terminal's own process, never by typing into a shell", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "makePlan.ts"), "utf8");
    assert.match(source, /shellPath: executable,\s*shellArgs: planned\.args/);
    assert.doesNotMatch(source, /sendText|executeCommand/);
  });
});
