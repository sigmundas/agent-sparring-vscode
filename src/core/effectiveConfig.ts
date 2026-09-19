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

/** One provider the engine says a role could use, with its own capabilities. */
export interface EngineProviderChoice {
  provider: string;
  display_name?: string;
  supports_model?: boolean;
  effort_supported?: boolean;
  effort_levels?: string[];
}

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
  /**
   * Every provider implemented for this role, as the engine enumerates them.
   * The extension keeps no list of its own, so a provider gained or lost by
   * the engine changes what the cockpit offers without an extension release.
   */
  provider_choices?: EngineProviderChoice[];
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

/**
 * The roles a control can name, and the fields it can change.
 *
 * Closed sets, because they are what crosses the webview boundary and end up
 * as arguments to an engine command. They are the engine's own vocabulary
 * (`sparring set-config <role> --provider/--model/--effort`), not a
 * translation. `provider` is here because the engine's command accepts it
 * and validates it; whether a control for it appears is a separate question,
 * answered by how many providers the engine reports for the role.
 */
export const CONFIG_ROLES = ["stage", "sparring"] as const;
export type ConfigRole = (typeof CONFIG_ROLES)[number];
export const CONFIG_FIELDS = ["provider", "model", "effort"] as const;
export type ConfigField = (typeof CONFIG_FIELDS)[number];

/**
 * What a control shows for "no project override".
 *
 * The label is the words a person reads; the value is a sentinel that exists
 * only inside the webview. It is deliberately the empty string and is never
 * sent to the engine as a value — choosing it posts `null`, which the host
 * turns into `--model-default` / `--effort-default`. Writing the literal text
 * "provider default" into project.toml would turn "I did not choose" into a
 * stated choice, and would be a model name no provider has.
 */
export const PROVIDER_DEFAULT_LABEL = "Provider default";
export const PROVIDER_DEFAULT_VALUE = "";

/** One `<option>` of an effort or provider control. */
export interface ControlOption {
  value: string;
  label: string;
}

/** One editable (or read-only) field of one role. */
export interface AgentFieldControl {
  field: ConfigField;
  label: string;
  /** The engine's current effective value, or `""` for the provider's default. */
  value: string;
  /** Present for a dropdown; absent for a free-form text control. */
  options?: ControlOption[];
  /** Shown when the field is empty, for a free-form control. */
  placeholder?: string;
  /** Tooltip: what this value is and where it came from. */
  detail: string;
  /**
   * Set when the field cannot be edited, and is the text to show instead of
   * a control. Used for the provider when the engine reports exactly one for
   * the role: there is nothing to choose, and a dropdown of one is a control
   * that lies about being a control.
   */
  fixedText?: string;
}

/** One role's block of controls in the Agents section. */
export interface AgentRoleControls {
  role: ConfigRole;
  label: string;
  /**
   * The provider. It gets `options` only when the engine reports more than
   * one provider for this role, and `fixedText` otherwise — the engine
   * currently implements exactly one provider per role, so today it is shown
   * rather than chosen, and it becomes a real control the moment that
   * changes, without an extension release.
   */
  provider: AgentFieldControl;
  model: AgentFieldControl;
  /**
   * Absent when the resolved provider has no effort/reasoning setting at all.
   * A disabled-looking dropdown would suggest the setting exists and is
   * merely unavailable, which is a different and untrue thing.
   */
  effort?: AgentFieldControl;
}

/** What the Overview shows for the effective configuration, if anything. */
export interface AgentConfigView {
  lines: AgentConfigLine[];
  /**
   * The editable controls, one block per role. Empty when the engine could
   * not resolve the configuration: there is then no effective value to put
   * in a control, and a control prefilled with a guess is worse than none.
   */
  controls: AgentRoleControls[];
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
    return { note: config.reason, lines: [], controls: [] };
  }
  const { report } = config;
  if (report.error) {
    return {
      lines: [],
      controls: [],
      configPath: report.config_path,
      configExists: report.config_exists,
      note: `Engine could not resolve the agent configuration: ${report.error}`,
    };
  }
  const roles = [report.stage, report.sparring].filter((role): role is EngineRoleConfig => role !== undefined);
  return {
    lines: roles.map(describeRole),
    controls: roles.map(roleControls).filter((control): control is AgentRoleControls => control !== undefined),
    configPath: report.config_path,
    configExists: report.config_exists,
    note: report.config_exists ? undefined : "No project.toml yet; these are the engine's defaults.",
  };
}

function isConfigRole(role: string): role is ConfigRole {
  return (CONFIG_ROLES as readonly string[]).includes(role);
}

/**
 * The controls for one role, built from what the engine reported and nothing
 * else.
 *
 * The effort options are the engine's `effort_levels` verbatim — this file
 * contains no list of levels, so a provider that gains or loses one is
 * reflected without an extension change. The model is free-form because both
 * installed CLIs take free-form names; validating it against anything here
 * would reject a model that exists.
 *
 * A role the extension does not have a control vocabulary for (a third role
 * a future engine adds) is skipped rather than rendered with a guessed
 * label: the read-only line above still describes it honestly.
 */
function roleControls(role: EngineRoleConfig): AgentRoleControls | undefined {
  if (!isConfigRole(role.role)) {
    return undefined;
  }
  const provider = role.provider_display_name?.trim() || role.provider;
  const choices = role.provider_choices ?? [];
  const controls: AgentRoleControls = {
    role: role.role,
    label: ROLE_LABEL[role.role] ?? role.role,
    provider: {
      field: "provider",
      label: "Provider",
      // The canonical id, because that is what a mutation would send; the
      // person reads the display name from the option label or fixedText.
      value: role.provider,
      detail: `Provider ${role.provider} from ${sourcePhrase(role.provider_source)}.`,
      ...(choices.length > 1
        ? {
            options: choices.map((choice) => ({
              value: choice.provider,
              label: choice.display_name?.trim() || choice.provider,
            })),
          }
        : { fixedText: provider }),
    },
    model: {
      field: "model",
      label: "Model",
      value: role.model ?? PROVIDER_DEFAULT_VALUE,
      placeholder: PROVIDER_DEFAULT_LABEL,
      detail: role.model
        ? `Model ${role.model} from ${sourcePhrase(role.model_source)}. Clear the field to use ${provider}'s own default.`
        : `No model configured, so ${provider} chooses its own. Type a model name to pin one.`,
    },
  };
  const levels = role.effort_levels ?? [];
  if (role.effort_supported !== false && levels.length > 0) {
    controls.effort = {
      field: "effort",
      label: "Effort",
      value: role.effort ?? PROVIDER_DEFAULT_VALUE,
      options: [
        { value: PROVIDER_DEFAULT_VALUE, label: PROVIDER_DEFAULT_LABEL },
        ...levels.map((level) => ({ value: level, label: level })),
      ],
      detail: role.effort
        ? `Effort ${role.effort} from ${sourcePhrase(role.effort_source)}. ${PROVIDER_DEFAULT_LABEL} removes the override.`
        : `No effort configured, so ${provider} uses its default.`,
    };
  }
  return controls;
}
