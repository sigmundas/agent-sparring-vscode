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
import { parseEngineConfig, type ConfigField, type ConfigRole, type EffectiveConfig } from "../core/effectiveConfig";
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
  // A local override the engine reported is part of the answer too: a change
  // made to it from a terminal must not be answered from before it.
  const localPath = known?.value.kind === "report" ? known.value.report.local_config_path : undefined;
  // So is setup, which the repository's .gitignore decides: fixing it by
  // hand must clear the notice without waiting for project.toml to change.
  const stamp = `${file}\u0000${sparringDir}\u0000${await configStamp(sparringDir)}\u0000${localPath ? await fileStamp(localPath) : ""}\u0000${await fileStamp(path.join(projectDir, ".gitignore"))}`;
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
 * The extension does not write `project.toml`. It runs
 * `sparring set-config`, which owns the schema, the validation and the
 * atomic write, and which refuses anything it could not resolve — so a
 * value the engine will not accept never reaches the file, and this function
 * reports the engine's own sentence rather than a translation of it.
 *
 * `value` is `null` to clear the override and use the provider's own
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
  /**
   * Write this worktree's local override (`set-config --local`) instead of
   * project.toml, so the change dirties nothing and a running loop keeps
   * going. Only for model and effort, and only when the engine reported a
   * local override location.
   */
  local = false,
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
  if (local) {
    args.push("--local");
  }
  cache.delete(`${file}\u0000${sparringDir}`);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: projectDir, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true });
          return;
        }
        const output = `${stderr ?? ""}${stdout ?? ""}`.trim();
        resolve({ ok: false, error: output || error.message });
      },
    );
  });
}

export type SetupFixResult = { ok: true; added: string[]; gitignore?: string } | { ok: false; error: string };

/**
 * Repair the setup problems the engine reported, through the engine:
 * `sparring fix-config --json` appends exactly the missing .gitignore lines.
 * The extension never edits .gitignore itself. The cache is dropped so the
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
          resolve({ ok: true, added, ...(typeof payload["gitignore"] === "string" ? { gitignore: payload["gitignore"] } : {}) });
          return;
        }
        const reason = typeof payload?.["error"] === "string" ? payload["error"] : `${stderr ?? ""}${stdout ?? ""}`.trim() || error?.message || "fix-config reported nothing.";
        resolve({ ok: false, error: reason });
      },
    );
  });
}
