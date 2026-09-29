/**
 * Ask the installed engine what the two roles would run with.
 *
 * This is the only place the extension learns a model or an effort level,
 * and it learns it by running `sparring show-config --json` rather than by
 * reading `.sparring/project.toml` itself. The engine owns precedence,
 * provider capabilities and the meaning of an omitted value; the cockpit
 * owns showing the answer.
 *
 * Like engineProbe.ts this is a *probe*: an engine that is too old to have
 * `show-config`, or one that cannot be resolved from this VS Code
 * environment, produces "unavailable" with a sentence — never a guess.
 *
 * The answer is cached per (executable, project) and invalidated by the
 * project.toml's own mtime/size, so editing the file shows up on the next
 * refresh while an unchanged file does not put a process spawn behind every
 * re-render of the Overview.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { parseEngineConfig, parseModelChoices, type ConfigField, type ConfigRole, type EffectiveConfig, type EngineModelChoices } from "../core/effectiveConfig";
import { PROJECT_CONFIG_FILENAME } from "../core/settingsTarget";
import * as path from "node:path";
import { planExecutable } from "../core/cli";
import { hostEnv } from "./shellIntegration";

const cache = new Map<string, { stamp: string; value: EffectiveConfig }>();

/**
 * The effective configuration for the project under `projectDir`.
 *
 * `sparringDir` is passed explicitly because the engine's `--sparring-dir`
 * is global and the cockpit already knows where the project's one is; it
 * must not depend on the process's working directory matching.
 */
export async function readEffectiveConfig(configured: string | undefined, projectDir: string, sparringDir: string): Promise<EffectiveConfig> {
  const planned = await planExecutable(configured, hostEnv(projectDir), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    // Nothing here can run it; the engine's own refusals remain the
    // authority and the Overview simply says so in one line.
    return { kind: "unavailable", reason: "The sparring CLI could not be resolved from this window, so the agent configuration is not shown." };
  }
  const file = planned.plan.path;
  const key = `${file}\u0000${sparringDir}`;
  const known = cache.get(key);
  // The user preferences file the engine reported is part of the answer too:
  // a preference changed from a terminal, or from another window, must not
  // be answered from before it.
  const userPath = known?.value.kind === "report" ? known.value.report.user_config_path : undefined;
  // So is setup, which the repository's .gitignore decides: fixing it by
  // hand must clear the notice without waiting for project.toml to change.
  const stamp = `${file}\u0000${sparringDir}\u0000${await configStamp(sparringDir)}\u0000${userPath ? await fileStamp(userPath) : ""}\u0000${await fileStamp(path.join(projectDir, ".gitignore"))}`;
  if (known && known.stamp === stamp) {
    return known.value;
  }
  const value = await probe(file, projectDir, sparringDir);
  cache.set(key, { stamp, value });
  return value;
}

/** A cheap fingerprint of the project.toml, so an edit re-probes and nothing else does. */
async function configStamp(sparringDir: string): Promise<string> {
  return fileStamp(path.join(sparringDir, PROJECT_CONFIG_FILENAME));
}

async function fileStamp(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}

function probe(file: string, cwd: string, sparringDir: string): Promise<EffectiveConfig> {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--sparring-dir", sparringDir, "show-config", "--json"],
      { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // show-config exits non-zero for an invalid configuration and still
        // prints the JSON explaining why, so the payload is tried first and
        // the exit code only decides what to say when there is no payload.
        const report = parseEngineConfig(stdout ?? "");
        if (report) {
          resolve({ kind: "report", report });
          return;
        }
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve({
          kind: "unavailable",
          reason: /invalid choice|unrecognized arguments|show-config/i.test(output) && error
            ? "This engine has no `show-config` command, so the agent configuration is not shown."
            : "The engine did not report an agent configuration.",
        });
      },
    );
  });
}

/** Testing seam: forget what was probed. */
export function resetEffectiveConfigCache(): void {
  cache.clear();
}

/** What one attempted configuration change did. */
export type ConfigWriteResult =
  | { ok: true }
  /** The engine refused, and this is its own diagnostic, for the person to read. */
  | { ok: false; error: string };

/**
 * Change one field of one role, through the engine.
 *
 * The extension writes no configuration file. It runs
 * `sparring set-config`, which owns the schema, the validation and the
 * atomic write, and which refuses anything it could not resolve — so a
 * value the engine will not accept is never saved, and this function
 * reports the engine's own sentence rather than a translation of it.
 *
 * Model and effort are the person's own preferences: the engine writes them
 * to its user preferences file, keyed by role and by `forProvider` (the
 * provider the control was drawn for), never to a repository. The provider
 * is a project setting and goes to project.toml. Every value is one exact
 * argument; nothing passes through a shell.
 *
 * `value` is `null` to clear the preference and use the provider's own
 * default. The caller re-reads the effective configuration afterwards; the
 * cache is dropped here so that re-read cannot be answered from before the
 * write.
 */
export async function writeAgentConfig(
  configured: string | undefined,
  projectDir: string,
  sparringDir: string,
  role: ConfigRole,
  field: ConfigField,
  value: string | null,
  forProvider?: string,
): Promise<ConfigWriteResult> {
  const planned = await planExecutable(configured, hostEnv(projectDir), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return { ok: false, error: "The sparring CLI could not be resolved from this window." };
  }
  const file = planned.plan.path;
  const flag = value === null ? `--${field}-default` : `--${field}`;
  const args = ["--sparring-dir", sparringDir, "set-config", role, flag];
  if (value !== null) {
    args.push(value);
  }
  if (field !== "provider" && forProvider) {
    args.push("--for-provider", forProvider);
  }
  args.push("--json");
  // Every repository's cached answer may carry the preference just changed.
  cache.clear();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: projectDir, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const reported = jsonError(stdout);
        if (!error && !reported) {
          resolve({ ok: true });
          return;
        }
        const output = `${stderr ?? ""}${stdout ?? ""}`.trim();
        resolve({ ok: false, error: reported ?? (output || error?.message || "set-config reported nothing.") });
      },
    );
  });
}

/** The `error` of an engine JSON answer, when there is one. */
function jsonError(stdout: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout ?? "");
    const error = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["error"] : undefined;
    return typeof error === "string" && error ? error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Model suggestions, per (executable, role, provider), for this session.
 *
 * `sparring model-choices` may ask a provider CLI for its catalog, which is
 * too slow to run on every refresh, so each pair is read once and kept
 * until an explicit Refresh ({@link resetModelChoicesCache}). A failed read
 * is kept too, as an entry with its error, so a broken provider is not
 * re-spawned behind every render.
 */
const choicesCache = new Map<string, EngineModelChoices>();
const choicesInFlight = new Map<string, Promise<void>>();

function choicesKey(file: string, role: string, provider: string): string {
  return `${file}\u0000${role}\u0000${provider}`;
}

/**
 * The suggestions for each wanted (role, provider), from the cache or from
 * one `model-choices --json` call. Waits at most `waitMs` for a read in
 * flight; `onLate` is called when a read finishes after that, so the caller
 * can re-render with it.
 */
export async function readModelChoices(
  configured: string | undefined,
  projectDir: string,
  sparringDir: string,
  wanted: readonly { role: string; provider: string }[],
  waitMs = 3_000,
  onLate?: () => void,
): Promise<EngineModelChoices[]> {
  const planned = await planExecutable(configured, hostEnv(projectDir), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return [];
  }
  const file = planned.plan.path;
  const known = () => wanted.map((pair) => choicesCache.get(choicesKey(file, pair.role, pair.provider))).filter((entry): entry is EngineModelChoices => entry !== undefined);
  const missing = wanted.filter((pair) => !choicesCache.has(choicesKey(file, pair.role, pair.provider)));
  if (missing.length === 0) {
    return known();
  }
  const flightKey = `${file}\u0000${sparringDir}\u0000${missing.map((pair) => `${pair.role}=${pair.provider}`).join(",")}`;
  let flight = choicesInFlight.get(flightKey);
  if (!flight) {
    flight = probeModelChoices(file, projectDir, sparringDir, missing).finally(() => choicesInFlight.delete(flightKey));
    choicesInFlight.set(flightKey, flight);
  }
  let late = false;
  const settled = await Promise.race([
    flight.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs)),
  ]);
  if (!settled) {
    late = true;
    void flight.then(() => {
      if (late) {
        onLate?.();
      }
    });
  }
  return known();
}

function probeModelChoices(file: string, cwd: string, sparringDir: string, missing: readonly { role: string; provider: string }[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--sparring-dir", sparringDir, "model-choices", "--json"],
      { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const roles = parseModelChoices(stdout ?? "") ?? [];
        for (const entry of roles) {
          choicesCache.set(choicesKey(file, entry.role, entry.provider), entry);
        }
        // A pair the engine did not answer for is remembered as "none", with
        // why, so it is not asked again until an explicit refresh.
        const reason = roles.length === 0 ? jsonError(stdout) ?? (`${stderr ?? ""}`.trim() || error?.message || "the engine listed no model suggestions") : null;
        for (const pair of missing) {
          const key = choicesKey(file, pair.role, pair.provider);
          if (!choicesCache.has(key)) {
            choicesCache.set(key, { role: pair.role, provider: pair.provider, source: "none", complete: false, custom_allowed: true, choices: [], error: reason });
          }
        }
        resolve();
      },
    );
  });
}

/** Forget every model suggestion, so the next read asks the engine again. */
export function resetModelChoicesCache(): void {
  choicesCache.clear();
}

/** One obsolete project model/effort key fix-config removed. */
export interface RemovedSetting {
  role: string;
  field: string;
  value: string;
}

export type SetupFixResult =
  | { ok: true; added: string[]; gitignore?: string; removed: RemovedSetting[]; configPath?: string }
  | { ok: false; error: string };

/**
 * Repair the setup problems the engine reported, through the engine:
 * `sparring fix-config --json` appends exactly the missing .gitignore lines
 * and removes obsolete model/effort keys from project.toml. It chooses no
 * preference in their place. The extension never edits either file itself. The cache is dropped so the
 * next read shows the engine's answer after the fix.
 */
export async function fixSetup(configured: string | undefined, projectDir: string, sparringDir: string): Promise<SetupFixResult> {
  const planned = await planExecutable(configured, hostEnv(projectDir), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return { ok: false, error: "The sparring CLI could not be resolved from this window." };
  }
  const file = planned.plan.path;
  cache.delete(`${file}\u0000${sparringDir}`);
  return new Promise((resolve) => {
    execFile(
      file,
      ["--sparring-dir", sparringDir, "fix-config", "--json"],
      { cwd: projectDir, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        let payload: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(stdout ?? "");
          payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
        } catch {
          payload = undefined;
        }
        if (!error && payload && payload["fixed"] === true) {
          const added = Array.isArray(payload["added"]) ? payload["added"].filter((line): line is string => typeof line === "string") : [];
          const removed = Array.isArray(payload["removed"])
            ? payload["removed"].filter(
                (entry): entry is RemovedSetting =>
                  typeof entry === "object" && entry !== null && ["role", "field", "value"].every((key) => typeof (entry as Record<string, unknown>)[key] === "string"),
              )
            : [];
          resolve({
            ok: true,
            added,
            removed,
            ...(typeof payload["gitignore"] === "string" ? { gitignore: payload["gitignore"] } : {}),
            ...(typeof payload["config_path"] === "string" ? { configPath: payload["config_path"] } : {}),
          });
          return;
        }
        const reason = typeof payload?.["error"] === "string" ? payload["error"] : `${stderr ?? ""}${stdout ?? ""}`.trim() || error?.message || "fix-config reported nothing.";
        resolve({ ok: false, error: reason });
      },
    );
  });
}
