/**
 * What the two roles would actually run with — as the engine reports it.
 *
 * This module reads `sparring show-config --json` and nothing else. It does
 * not parse TOML, does not know which providers exist, does not know what
 * "no model configured" means for a given provider, and does not decide
 * precedence. All of that is the engine's (`agent_sparring/agent_config.py`),
 * and duplicating any of it here would give the cockpit a second opinion
 * about what is about to run — which is worse than no opinion at all.
 *
 * What this module does own is presentation: turning the engine's answer
 * into a compact line a person can read, without inventing a value the
 * engine did not state. An unset model is reported as "provider default",
 * never as a guessed model name; an effort that is unset, or that the
 * provider has no concept of, simply does not appear on the line.
 */

/** One role, exactly as `show-config --json` reports it. */
export interface EngineRoleConfig {
  role: string;
  provider: string;
  /** The engine's human-readable name for the provider (`Claude`); the id stays canonical. */
  provider_display_name?: string;
  provider_source?: string;
  /** `null` means the provider's own default: the engine passes no model flag. */
  model: string | null;
  model_source?: string;
  /** `null` means the provider's own default, or that the provider has no effort setting. */
  effort: string | null;
  effort_source?: string;
  /** False when the provider exposes no effort/reasoning setting at all. */
  effort_supported?: boolean;
  effort_levels?: string[];
}

/** The whole payload of one `show-config --json` invocation. */
export interface EngineConfigReport {
  config_path: string;
  config_exists: boolean;
  project: string | null;
  /** Set when the engine refused to resolve the configuration; then no role is reported. */
  error: string | null;
  stage?: EngineRoleConfig;
  sparring?: EngineRoleConfig;
}

/**
 * What the cockpit has about the effective configuration.
 *
 * `unavailable` is a first-class answer, not a failure to report: an engine
 * too old to have `show-config`, or one that could not be resolved from this
 * VS Code environment, is an ordinary state, and the Overview says nothing
 * about models rather than guessing.
 */
export type EffectiveConfig =
  | { kind: "report"; report: EngineConfigReport }
  | { kind: "unavailable"; reason: string };

const ROLE_LABEL: Record<string, string> = { stage: "Stage agent", sparring: "Sparrer" };

function isRole(value: unknown): value is EngineRoleConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["role"] === "string" &&
    typeof record["provider"] === "string" &&
    (record["model"] === null || typeof record["model"] === "string") &&
    (record["effort"] === null || typeof record["effort"] === "string")
  );
}

/**
 * The engine's JSON, or `undefined` when the output is not the shape this
 * version of the engine promises. Nothing is reconstructed from a partial
 * payload: a half-understood answer about what will run is not useful.
 */
export function parseEngineConfig(stdout: string): EngineConfigReport | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record["config_path"] !== "string") {
    return undefined;
  }
  const error = typeof record["error"] === "string" ? record["error"] : null;
  const report: EngineConfigReport = {
    config_path: record["config_path"],
    config_exists: record["config_exists"] === true,
    project: typeof record["project"] === "string" ? record["project"] : null,
    error,
  };
  if (isRole(record["stage"])) {
    report.stage = record["stage"];
  }
  if (isRole(record["sparring"])) {
    report.sparring = record["sparring"];
  }
  // An answer with neither a role nor an error explains nothing.
  if (!report.stage && !report.sparring && !report.error) {
    return undefined;
  }
  return report;
}

/** One rendered role line: `Stage agent` / `Claude · opus · high`. */
export interface AgentConfigLine {
  role: string;
  text: string;
  /** Tooltip: where each value came from, in the engine's own vocabulary. */
  detail: string;
}

const SOURCE_WORD: Record<string, string> = {
  cli: "a command-line override",
  project: "project.toml",
  "engine-default": "the engine default",
  "provider-default": "the provider's own default",
};

function sourcePhrase(source: string | undefined): string {
  return source ? (SOURCE_WORD[source] ?? source) : "an unstated source";
}

/**
 * The compact line for one role.
 *
 * The provider's display name comes from the engine, so the cockpit is not
 * maintaining its own table of vendor names for configured providers. An
 * unset model reads "provider default" in plain words; an unset or
 * unsupported effort is left off entirely rather than rendered as "none",
 * which would look like a setting.
 */
export function describeRole(role: EngineRoleConfig): AgentConfigLine {
  const provider = role.provider_display_name?.trim() || role.provider;
  const parts = [provider, role.model ?? "provider default"];
  if (role.effort) {
    parts.push(role.effort);
  }
  const details = [
    `Provider ${role.provider} from ${sourcePhrase(role.provider_source)}.`,
    role.model
      ? `Model ${role.model} from ${sourcePhrase(role.model_source)}.`
      : "No model configured, so the provider chooses its own.",
  ];
  if (role.effort) {
    details.push(`Effort ${role.effort} from ${sourcePhrase(role.effort_source)}.`);
  } else if (role.effort_supported === false) {
    details.push(`${provider} has no effort setting.`);
  } else {
    details.push("No effort configured, so the provider uses its default.");
  }
  return { role: ROLE_LABEL[role.role] ?? role.role, text: parts.join(" · "), detail: details.join(" ") };
}

/** What the Overview shows for the effective configuration, if anything. */
export interface AgentConfigView {
  lines: AgentConfigLine[];
  /** Path of the project.toml the engine read, and whether it is there. */
  configPath?: string;
  configExists?: boolean;
  /**
   * A calm one-line explanation shown instead of, or beside, the lines:
   * an engine configuration error, or the reason nothing could be read.
   * It never replaces the rest of the Overview.
   */
  note?: string;
}

/**
 * The view for whatever the probe came back with.
 *
 * A configuration error is surfaced as a note with the engine's own
 * sentence, and the role lines are withheld — an invalid configuration has
 * no effective values, and showing stale or invented ones next to an error
 * is how a person ends up trusting the wrong thing. Returns `undefined`
 * only when there is genuinely nothing to say.
 */
export function agentConfigView(config: EffectiveConfig | undefined): AgentConfigView | undefined {
  if (!config) {
    return undefined;
  }
  if (config.kind === "unavailable") {
    return { note: config.reason, lines: [] };
  }
  const { report } = config;
  if (report.error) {
    return {
      lines: [],
      configPath: report.config_path,
      configExists: report.config_exists,
      note: `Engine could not resolve the agent configuration: ${report.error}`,
    };
  }
  const lines = [report.stage, report.sparring].filter((role): role is EngineRoleConfig => role !== undefined).map(describeRole);
  return {
    lines,
    configPath: report.config_path,
    configExists: report.config_exists,
    note: report.config_exists ? undefined : "No project.toml yet; these are the engine's defaults.",
  };
}
