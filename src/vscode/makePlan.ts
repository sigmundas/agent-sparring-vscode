/**
 * Make Plan…: open Claude or Codex in a terminal of its own, in the chosen
 * repository, with the Agent Sparring planning skill and a planning-input
 * file. See core/makePlan.ts for why this is an agent session and not an
 * engine operation.
 *
 * The provider command is the terminal's process (shellPath + shellArgs), so
 * the prompt reaches it as one exact argument with no shell in between.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { searchPath } from "../core/cli";
import type { SparringLocation } from "../core/discovery";
import { looksLikePlanningInput, planningArgs, planningProviders, PLANNING_SKILL_FILE, pluginInstallPath, type PlanningProvider } from "../core/makePlan";
import { readEffectiveConfig } from "./configProbe";
import { configuredExecutable } from "./engineExecutable";
import { hostEnv } from "./shellIntegration";

export interface MakePlanDeps {
  pickLocation(): Promise<SparringLocation | undefined>;
  /** Run Plan with this repository and plan already chosen. */
  runPlan(location: SparringLocation, planPath: string): Promise<void>;
  log(line: string): void;
}

/** Make Plan…, optionally from a file already chosen (the Run Plan refusal's "Make Plan from this…"). */
export async function makePlanCommand(deps: MakePlanDeps, preset?: { location: SparringLocation; source: string }): Promise<void> {
  const location = preset?.location ?? (await deps.pickLocation());
  if (!location) {
    return;
  }
  const source = preset?.source ?? (await pickSource(location));
  if (!source) {
    return;
  }
  const provider = await pickProvider(location);
  if (!provider) {
    return;
  }
  const executable = await searchPath(provider.command, hostEnv(location.repoRoot));
  if (!executable) {
    void vscode.window.showErrorMessage(`Agent Sparring: ${provider.command} was not found on the PATH VS Code was started with, so ${provider.label} cannot be opened for planning.`);
    return;
  }
  const skillFile = provider.skill === "skill-file" ? await planningSkillFile() : undefined;
  const rel = path.relative(location.repoRoot, source);
  const sourceRel = rel.startsWith("..") || path.isAbsolute(rel) ? source : rel;
  const planned = planningArgs(provider, sourceRel, skillFile);
  if (!planned.ok) {
    void vscode.window.showErrorMessage(`Agent Sparring: ${planned.reason}`);
    return;
  }
  deps.log(`Make plan: ${provider.label} in ${location.repoRoot} from ${sourceRel}`);
  const terminal = vscode.window.createTerminal({
    name: `Make Plan · ${provider.label}`,
    cwd: location.repoRoot,
    shellPath: executable,
    shellArgs: planned.args,
    iconPath: new vscode.ThemeIcon("lightbulb"),
  });
  terminal.show(false);
  watchForPlan(deps, location, terminal);
}

/** The current Markdown file, likely planning input in the repository, or Browse…. */
async function pickSource(location: SparringLocation): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { file: string };
  const items: Item[] = [];
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.scheme === "file" && active.fileName.toLowerCase().endsWith(".md")) {
    items.push({ label: `$(file) ${path.basename(active.fileName)}`, description: "current file", detail: active.fileName, file: active.fileName });
  }
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(location.repoRoot, "**/*.md"), "{**/node_modules/**,**/.sparring/**,**/.git/**}", 400);
  const files = found
    .map((uri) => uri.fsPath)
    .filter((file) => file !== active?.fileName)
    .sort((a, b) => Number(looksLikePlanningInput(b)) - Number(looksLikePlanningInput(a)) || a.localeCompare(b));
  for (const file of files.slice(0, 60)) {
    items.push({ label: path.basename(file), description: path.relative(location.repoRoot, path.dirname(file)) || ".", file });
  }
  items.push({ label: "$(folder-opened) Browse…", description: "choose another Markdown file", file: "" });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Which idea, INBOX or notes should become a staged plan? (planning only: nothing is implemented or run)",
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.file) {
    return picked.file;
  }
  const chosen = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(location.repoRoot), canSelectMany: false, filters: { Markdown: ["md"] }, openLabel: "Make Plan from this" });
  return chosen?.[0]?.fsPath;
}

async function pickProvider(location: SparringLocation): Promise<PlanningProvider | undefined> {
  const config = await readEffectiveConfig(configuredExecutable(), location.projectDir, location.sparringDir);
  if (config.kind !== "report") {
    void vscode.window.showErrorMessage(`Agent Sparring: the engine did not report its providers, so there is nothing to plan with${config.kind === "unavailable" ? ` (${config.reason})` : ""}.`);
    return undefined;
  }
  const providers = planningProviders([config.report.stage, config.report.sparring]);
  if (providers.length === 0) {
    void vscode.window.showErrorMessage("Agent Sparring: none of the providers the engine reports can be opened for an interactive planning session.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: provider.label,
      detail: `Opens ${provider.label} in a terminal to audit the repository and write a staged plan under docs/plans/. It does not implement or start anything.`,
      provider,
    })),
    { placeHolder: "Plan with which agent?" },
  );
  return picked?.provider;
}

/** The planning skill inside the installed agent-sparring Claude Code plugin; undefined when it is not installed. */
async function planningSkillFile(): Promise<string | undefined> {
  try {
    const installed = await fs.readFile(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8");
    const root = pluginInstallPath(installed);
    if (!root) {
      return undefined;
    }
    const file = path.join(root, PLANNING_SKILL_FILE);
    await fs.access(file);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * While the planning terminal is open, offer the plan it writes: a new
 * Markdown file under docs/plans/. Only an offer; nothing is opened or run.
 */
function watchForPlan(deps: MakePlanDeps, location: SparringLocation, terminal: vscode.Terminal): void {
  // One watcher per repository: a second planning session there replaces
  // the first's, so a plan is never offered twice.
  const key = path.resolve(location.repoRoot);
  watchers.get(key)?.dispose();
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(location.repoRoot, "docs/plans/*.md"), false, true, true);
  const offered = new Set<string>();
  const created = watcher.onDidCreate(async (uri) => {
    if (offered.has(uri.fsPath)) {
      return;
    }
    offered.add(uri.fsPath);
    const name = path.relative(location.repoRoot, uri.fsPath);
    const choice = await vscode.window.showInformationMessage(`Agent Sparring: a plan was written: ${name}. Review it before running it.`, "Open plan", "Run Plan…");
    if (choice === "Open plan") {
      await vscode.window.showTextDocument(uri, { preview: false });
    } else if (choice === "Run Plan…") {
      await deps.runPlan(location, uri.fsPath);
    }
  });
  const closed = vscode.window.onDidCloseTerminal((gone) => {
    if (gone === terminal) {
      stop.dispose();
    }
  });
  const stop = new vscode.Disposable(() => {
    created.dispose();
    watcher.dispose();
    closed.dispose();
    if (watchers.get(key) === stop) {
      watchers.delete(key);
    }
  });
  watchers.set(key, stop);
}

const watchers = new Map<string, vscode.Disposable>();

/** Stop every plan watcher; for extension deactivation. */
export function disposeMakePlanWatchers(): void {
  for (const stop of [...watchers.values()]) {
    stop.dispose();
  }
}
