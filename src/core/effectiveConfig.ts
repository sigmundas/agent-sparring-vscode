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

/**
 * One entry of `setup_problems`, verbatim. Two kinds exist today, and both
 * are repaired by `sparring fix-config`:
 *
 * - `not-ignored`: a workflow-state directory git can see (`ignore_line`,
 *   `gitignore` say which line goes into which file);
 * - `obsolete-agent-setting`: project.toml still sets a model or effort,
 *   which is now the user's own preference and is no longer read from any
 *   project (`role`, `field`, `value`, `config_path` say which key).
 */
export interface EngineSetupProblem {
  kind: string;
  /** What is affected, as the engine names it (`plan intake`, `stage agent model`). */
  what: string;
  /** The engine's full text, for technical details. */
  message: string;
  /** `not-ignored`: the .gitignore line that fixes it (`.sparring/intake/`). */
  ignore_line?: string;
  /** `not-ignored`: the .gitignore fix-config appends to. */
  gitignore?: string;
  /** `obsolete-agent-setting`: the role, field and value of the key fix-config removes. */
  role?: string;
  field?: string;
  value?: string;
  /** `obsolete-agent-setting`: the project configuration file holding it. */
  config_path?: string;
}

export const SETUP_NOT_IGNORED = "not-ignored";
export const SETUP_OBSOLETE_AGENT_SETTING = "obsolete-agent-setting";

/** The whole payload of one `show-config --json` invocation. */
export interface EngineConfigReport {
  config_path: string;
  config_exists: boolean;
  /**
   * The one file, outside every repository, that holds this person's model
   * and effort preferences (per role and provider). The engine owns it and
   * reports where it is; `set-config --model/--effort` writes it.
   */
  user_config_path?: string;
  user_config_exists?: boolean;
  /**
   * Fixable setup problems the engine found (`sparring fix-config` repairs
   * them). Absent from an engine that does not report setup; an empty list
   * means it checked and found none.
   */
  setup_problems?: EngineSetupProblem[];
  /** Why setup could not be checked, when it could not. */
  setup_error?: string;
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
  | {
      kind: "report";
      report: EngineConfigReport;
      /**
       * The engine's `model-choices` answer for the roles on screen, one
       * entry per (role, provider). Suggestions only: the dropdown also keeps
       * the configured model and always offers an exact custom value, and a
       * list for one provider is never offered for another.
       */
      modelChoices?: readonly EngineModelChoices[];
    }
  | { kind: "unavailable"; reason: string };

/** One suggested model, as `sparring model-choices --json` lists it. */
export interface EngineModelChoice {
  model: string;
  display_name?: string;
  effort_levels?: string[];
  default_effort?: string | null;
}

/**
 * One role's suggestions for one provider. `source` is where the engine got
 * them (`provider-catalog`, `engine-known`, `none`); `complete` is false
 * whenever other exact models may exist, which is the ordinary case.
 */
export interface EngineModelChoices {
  role: string;
  provider: string;
  source: string;
  complete: boolean;
  custom_allowed: boolean;
  choices: EngineModelChoice[];
  error: string | null;
}

function isModelChoice(value: unknown): value is EngineModelChoice {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["model"] === "string" && (value as Record<string, string>)["model"].trim() !== "";
}

/**
 * The engine's `model-choices --json`, or `undefined` when it is not that
 * shape. A role entry with a malformed choice keeps its well-formed ones.
 */
export function parseModelChoices(stdout: string): EngineModelChoices[] | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Record<string, unknown>)["roles"])) {
    return undefined;
  }
  const roles: EngineModelChoices[] = [];
  for (const entry of (payload as Record<string, unknown[]>)["roles"]) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["role"] !== "string" || typeof record["provider"] !== "string") {
      continue;
    }
    roles.push({
      role: record["role"],
      provider: record["provider"],
      source: typeof record["source"] === "string" ? record["source"] : "none",
      complete: record["complete"] === true,
      custom_allowed: record["custom_allowed"] !== false,
      choices: Array.isArray(record["choices"]) ? record["choices"].filter(isModelChoice) : [],
      error: typeof record["error"] === "string" && record["error"] ? record["error"] : null,
    });
  }
  return roles;
}

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
function isSetupProblem(value: unknown): value is EngineSetupProblem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const has = (...keys: string[]) => keys.every((key) => typeof record[key] === "string");
  if (!has("kind", "what", "message")) {
    return false;
  }
  // A kind is shown only with the fields that say what to fix; anything
  // else would be a notice that cannot name its own problem.
  if (record["kind"] === SETUP_NOT_IGNORED) {
    return has("ignore_line", "gitignore");
  }
  if (record["kind"] === SETUP_OBSOLETE_AGENT_SETTING) {
    return has("role", "field");
  }
  return true;
}

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
  if (typeof record["user_config_path"] === "string" && record["user_config_path"]) {
    report.user_config_path = record["user_config_path"];
    report.user_config_exists = record["user_config_exists"] === true;
  }
  if (Array.isArray(record["setup_problems"])) {
    report.setup_problems = record["setup_problems"].filter(isSetupProblem);
  }
  if (typeof record["setup_error"] === "string" && record["setup_error"]) {
    report.setup_error = record["setup_error"];
  }
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
  env: "an environment variable",
  user: "your own preference",
  project: "project.toml",
  "engine-default": "the engine default",
  "provider-default": "the provider's own default",
};

function sourcePhrase(source: string | undefined): string {
  return source ? (SOURCE_WORD[source] ?? source) : "an unstated source";
}

/** The short words beside a configured value: `claude-opus-5-5 · Your preference`. */
const SOURCE_LABEL: Record<string, string> = {
  cli: "Command-line override",
  env: "Environment override",
  user: "Your preference",
  "provider-default": "Provider default",
};

export function sourceLabel(source: string | undefined): string {
  return source ? (SOURCE_LABEL[source] ?? source) : "Source not stated";
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
 * What a control shows for "no preference".
 *
 * The label is the words a person reads; the value is a sentinel that exists
 * only inside the webview. It is deliberately the empty string and is never
 * sent to the engine as a value — choosing it posts `null`, which the host
 * turns into `--model-default` / `--effort-default`, clearing the saved
 * preference. Saving the literal text "provider default" would turn "I did
 * not choose" into a stated choice, and would be a model name no provider has.
 */
export const PROVIDER_DEFAULT_LABEL = "Provider default";
export const PROVIDER_DEFAULT_VALUE = "";

/**
 * The model dropdown's last entry, which asks for an exact model id instead
 * of choosing one. The webview recognises it by `custom`, never by its
 * value, so no model name can be mistaken for it; the id typed is sent to
 * the engine as one exact argument.
 */
export const CUSTOM_MODEL_LABEL = "Other exact model\u2026";
export const CUSTOM_MODEL_VALUE = "\u2026other";

/** One `<option>` of a model, effort or provider control. */
export interface ControlOption {
  value: string;
  label: string;
  /** The "Other exact model…" entry: it opens an input, it is not a value. */
  custom?: boolean;
}

/** One editable (or read-only) field of one role. */
export interface AgentFieldControl {
  field: ConfigField;
  label: string;
  /** The engine's current effective value, or `""` for the provider's default. */
  value: string;
  /** Present for a dropdown; absent when the field is read-only text. */
  options?: ControlOption[];
  /** Tooltip: what this value is and where it came from. */
  detail: string;
  /**
   * The effective configured value in words, shown beside the control so it
   * is read and not only selected: `claude-opus-5-5 · Your preference`, or
   * `Provider default` when nothing is configured.
   */
  summary?: string;
  /**
   * Set when the field cannot be edited, and is the text to show instead of
   * a control. Used for the provider when the engine reports exactly one for
   * the role — there is nothing to choose, and a dropdown of one is a
   * control that lies about being a control.
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
  /**
   * The engine's facts for this role, for the card's Technical details:
   * role id, provider id and source, the user preferences file, the
   * configured model and effort with their sources. Label/value pairs.
   */
  technical: { label: string; value: string }[];
}

/** Where the model suggestions came from, in words. */
function choicesPhrase(entry: EngineModelChoices | undefined, provider: string): string {
  if (!entry || entry.source === "none" || entry.choices.length === 0) {
    return entry?.error ? `No model suggestions for ${provider}: ${entry.error}` : `No model suggestions for ${provider}.`;
  }
  const from = entry.source === "provider-catalog" ? `${provider}'s own model list` : entry.source === "engine-known" ? "the models Agent Sparring knows" : entry.source;
  return `Suggestions from ${from}${entry.complete ? "" : "; other exact models may exist"}.`;
}

/**
 * The model field: always a dropdown, because an exact model id can always
 * be entered.
 *
 * The options are, in order: Provider default (clears the preference); the
 * configured model, even when no list names it -- a control must never show
 * a model other than the one a turn would run with; the engine's
 * suggestions for exactly this role and provider; and Other exact model…
 * Suggestions are the engine's `model-choices`, matched on role *and*
 * provider, so a list for one provider is never offered for another. They
 * are never a validation boundary.
 */
function modelControl(role: EngineRoleConfig, provider: string, entry: EngineModelChoices | undefined): AgentFieldControl {
  const current = role.model ?? PROVIDER_DEFAULT_VALUE;
  const summary = role.model ? `${role.model} \u00b7 ${sourceLabel(role.model_source)}` : PROVIDER_DEFAULT_LABEL;
  const detail = role.model ? `Model ${role.model} from ${sourcePhrase(role.model_source)}.` : `No model configured, so ${provider} chooses its own.`;
  const options: ControlOption[] = [{ value: PROVIDER_DEFAULT_VALUE, label: PROVIDER_DEFAULT_LABEL }];
  const listed = new Set<string>();
  const suggestions = (entry?.choices ?? []).filter((choice) => {
    const name = choice.model.trim();
    if (listed.has(name)) {
      return false;
    }
    listed.add(name);
    return true;
  });
  if (role.model && !listed.has(role.model)) {
    options.push({ value: role.model, label: role.model });
  }
  for (const choice of suggestions) {
    const name = choice.model.trim();
    const display = choice.display_name?.trim();
    options.push({ value: name, label: display && display !== name ? `${name} \u00b7 ${display}` : name });
  }
  options.push({ value: CUSTOM_MODEL_VALUE, label: CUSTOM_MODEL_LABEL, custom: true });
  return {
    field: "model",
    label: "Model",
    value: current,
    summary,
    options,
    detail: `${detail} ${choicesPhrase(entry, provider)} ${PREFERENCE_WHERE}`,
  };
}

/**
 * Where a model or effort change goes, said once: the person's own
 * preference, shared by every project, and never the repository.
 */
export const PREFERENCE_WHERE =
  "Saved as your own preference for this role and provider, shared by every project; no repository file changes.";

/**
 * The provider's human name for one role's controls.
 *
 * Taken from whatever the engine put in the control — the fixed text when
 * the role has exactly one provider, the matching option's label when it has
 * several — and falling back to the canonical id. There is no table of
 * vendor names here, and there must not be: a provider the engine gains is
 * named by the engine.
 */
export function providerLabel(controls: AgentRoleControls): string {
  if (controls.provider.fixedText) {
    return controls.provider.fixedText;
  }
  const chosen = controls.provider.options?.find((option) => option.value === controls.provider.value);
  return chosen?.label ?? controls.provider.value;
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
  /** The user preferences file the engine reported, for Technical details. */
  userConfigPath?: string;
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
    controls: roles
      .map((role) =>
        roleControls(
          role,
          config.modelChoices?.find((entry) => entry.role === role.role && entry.provider === role.provider),
          report.user_config_path,
        ),
      )
      .filter((control): control is AgentRoleControls => control !== undefined),
    configPath: report.config_path,
    configExists: report.config_exists,
    userConfigPath: report.user_config_path,
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
function roleControls(role: EngineRoleConfig, modelChoices: EngineModelChoices | undefined, userConfigPath: string | undefined): AgentRoleControls | undefined {
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
    model: modelControl(role, provider, modelChoices),
    technical: [
      { label: "Role", value: role.role },
      { label: "Provider", value: `${role.provider} (from ${sourcePhrase(role.provider_source)})` },
      { label: "Preferences file", value: userConfigPath ?? "not reported by the engine" },
      { label: "Configured model", value: role.model ?? "none (the provider chooses)" },
      { label: "Model source", value: role.model_source ?? "not stated" },
      {
        label: "Effort",
        value:
          role.effort_supported === false
            ? `${provider} has no effort setting`
            : `${role.effort ?? "none (the provider's default)"} (source: ${role.effort_source ?? "not stated"})`,
      },
      {
        label: "Model suggestions",
        value: modelChoices ? `${modelChoices.source}${modelChoices.complete ? ", complete" : ", not complete"}${modelChoices.error ? `; ${modelChoices.error}` : ""}` : "not read",
      },
    ],
  };
  const levels = role.effort_levels ?? [];
  if (role.effort_supported !== false && levels.length > 0) {
    controls.effort = {
      field: "effort",
      label: "Effort",
      value: role.effort ?? PROVIDER_DEFAULT_VALUE,
      summary: role.effort ? `${role.effort} \u00b7 ${sourceLabel(role.effort_source)}` : PROVIDER_DEFAULT_LABEL,
      options: [
        { value: PROVIDER_DEFAULT_VALUE, label: PROVIDER_DEFAULT_LABEL },
        ...levels.map((level) => ({ value: level, label: level })),
      ],
      detail: `${
        role.effort ? `Effort ${role.effort} from ${sourcePhrase(role.effort_source)}. ${PROVIDER_DEFAULT_LABEL} clears your preference.` : `No effort configured, so ${provider} uses its default.`
      } ${PREFERENCE_WHERE}`,
    };
  }
  return controls;
}
