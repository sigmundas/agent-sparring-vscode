/**
 * Make Plan…: turn planning input (an idea, an INBOX, rough notes) into a
 * staged plan, by opening Claude or Codex interactively in the repository
 * with the Agent Sparring planning skill and the chosen file.
 *
 * This is an agent conversation, not an engine operation: nothing is
 * recorded under .sparring, no run exists, and the person watches and steers
 * the session in a terminal of its own. The planning skill writes the plan
 * under docs/plans/ and stops; Run Plan stays the only way to start it.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import { PLANNING_SKILL } from "./gettingStarted";
import type { EngineRoleConfig } from "./effectiveConfig";

/** The planning skill's file inside the agent-sparring Claude Code plugin. */
export const PLANNING_SKILL_FILE = path.join("skills", "sparring-plan", "SKILL.md");

/**
 * How each provider the engine knows is opened for an interactive session.
 * Which providers exist is the engine's to say; this only knows how to open
 * one for a person, so a provider the engine lists without an entry here is
 * simply not offered for planning.
 */
const INTERACTIVE: Record<string, { command: string; skill: "slash-command" | "skill-file" }> = {
  "claude-cli": { command: "claude", skill: "slash-command" },
  "codex-cli": { command: "codex", skill: "skill-file" },
};

export interface PlanningProvider {
  /** The engine's provider id (`claude-cli`). */
  provider: string;
  /** The engine's name for it (`Claude`). */
  label: string;
  /** The interactive command word, resolved along PATH by the caller. */
  command: string;
  skill: "slash-command" | "skill-file";
}

/**
 * The providers to offer: every provider the engine reports for any role,
 * once, in the engine's order, that can be opened interactively.
 */
export function planningProviders(roles: readonly (EngineRoleConfig | undefined)[]): PlanningProvider[] {
  const out: PlanningProvider[] = [];
  const seen = new Set<string>();
  const add = (provider: string, label: string | undefined) => {
    const known = INTERACTIVE[provider];
    if (!known || seen.has(provider)) {
      return;
    }
    seen.add(provider);
    out.push({ provider, label: label?.trim() || provider, ...known });
  };
  for (const role of roles) {
    if (!role) {
      continue;
    }
    add(role.provider, role.provider_display_name);
    for (const choice of role.provider_choices ?? []) {
      add(choice.provider, choice.display_name);
    }
  }
  return out;
}

/**
 * The agent-sparring plugin's install directory, from Claude Code's
 * `~/.claude/plugins/installed_plugins.json`; undefined when it is not
 * installed or the file is not what was expected.
 */
export function pluginInstallPath(installedPluginsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(installedPluginsJson) as { plugins?: Record<string, { installPath?: unknown }[]> };
    for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
      if (!key.startsWith("agent-sparring@") || !Array.isArray(installs)) {
        continue;
      }
      const found = installs.find((install) => typeof install?.installPath === "string");
      if (found) {
        return found.installPath as string;
      }
    }
  } catch {
    // not JSON: treated as not installed
  }
  return undefined;
}

/** What the planning session is asked to do, beyond what the skill itself says. */
export function planningInstruction(sourceRel: string): string {
  return [
    `Planning input: ${sourceRel}.`,
    `Read it first; it is an idea, inbox or notes, and you must not edit or overwrite it.`,
    "Audit the repository code it concerns before deciding anything, and ask me about open questions that change what to build.",
    "Then write a new staged plan under docs/plans/ and check it with the engine.",
    "This is planning only: do not implement anything, create branches, commit, or start a run. Stop when the plan is written so I can review it.",
  ].join(" ");
}

/**
 * The interactive command's arguments: the session's first prompt, as one
 * exact argument (never through a shell). Claude invokes the skill by its
 * slash command; Codex is pointed at the same skill's file.
 */
export function planningArgs(provider: PlanningProvider, sourceRel: string, skillFile: string | undefined): { ok: true; args: string[] } | { ok: false; reason: string } {
  const instruction = planningInstruction(sourceRel);
  if (provider.skill === "slash-command") {
    return { ok: true, args: [`${PLANNING_SKILL} ${instruction}`] };
  }
  if (!skillFile) {
    return {
      ok: false,
      reason: `${provider.label} reads the planning skill from the agent-sparring Claude Code plugin, which is not installed. Install it with /plugin install agent-sparring@agent-sparring in Claude Code, or plan with Claude.`,
    };
  }
  return { ok: true, args: [`Follow the planning instructions in ${skillFile} (they are the Agent Sparring planning skill; treat my request below as its arguments). ${instruction}`] };
}

/** True for a Markdown file that reads as planning input by name: INBOX.md, notes, ideas. */
export function looksLikePlanningInput(file: string): boolean {
  return /^(inbox|notes?|ideas?|todo|backlog)\b/i.test(path.basename(file));
}
