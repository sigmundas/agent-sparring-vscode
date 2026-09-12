/**
 * Command implementations: run/resume a plan in a VS Code terminal (the
 * executable is spawned directly with an argument array, no shell), select
 * a run, and open the Run Overview panel and its actions.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildResumePlanArgs, buildRunPlanArgs, readGitBranch, resolveExecutable } from "../core/cli";
import {
  BRIEF_FILENAME,
  HANDOFF_FILENAME,
  SPARRING_FILENAME,
  currentStageOf,
  isOpenRun,
  runLabel,
  totalStagesOf,
  type PlanRunSnapshot,
  type RunSnapshot,
  type SparringLocation,
} from "../core/discovery";
import { parsePlanStages } from "../core/engineFormats";
import type { OverviewAction } from "../core/overviewHtml";
import type { SparringController } from "./controller";
import { openCandidateDiff } from "./overview/gitDiff";
import { OverviewPanelManager } from "./overview/overviewPanel";

export function registerCommands(context: vscode.ExtensionContext, controller: SparringController): void {
  const overview: OverviewPanelManager = new OverviewPanelManager(controller, (action) => handleOverviewAction(controller, overview, action));
  context.subscriptions.push(
    overview,
    vscode.commands.registerCommand("agentSparring.showLog", () => controller.showLog()),
    vscode.commands.registerCommand("agentSparring.refresh", () => controller.refresh()),
    vscode.commands.registerCommand("agentSparring.selectRun", () => selectRunCommand(controller)),
    vscode.commands.registerCommand("agentSparring.openOverview", () => openOverviewCommand(controller, overview)),
    vscode.commands.registerCommand("agentSparring.runPlan", () => runPlanCommand(controller)),
    vscode.commands.registerCommand("agentSparring.resumePlan", () => resumePlanCommand(controller)),
  );
}

// ---------------------------------------------------------------- select run

interface RunItem extends vscode.QuickPickItem {
  run?: RunSnapshot;
}

function describeRun(run: RunSnapshot): string {
  if (run.kind === "plan") {
    const total = totalStagesOf(run);
    return `${run.state.status} · stage ${run.state.currentStageIndex + 1}/${total ?? "?"} · ${run.state.expectedBranch}`;
  }
  return `standalone stage · ${run.stage.state?.status ?? "working"}`;
}

async function selectRunCommand(controller: SparringController): Promise<void> {
  const runs = controller.currentDiscovery.runs;
  if (runs.length === 0) {
    void vscode.window.showInformationMessage("Agent Sparring: no recorded plan runs or stages in this workspace.");
    return;
  }
  const selectedId = controller.currentSelection.selected?.id;
  const items: RunItem[] = runs
    .slice()
    .sort((a, b) => Number(isOpenRun(b)) - Number(isOpenRun(a)) || b.stateMtimeMs - a.stateMtimeMs)
    .map((run) => ({
      label: `${run.id === selectedId ? "$(check) " : ""}${runLabel(run)}`,
      description: describeRun(run),
      detail: currentStageOf(run).stageId,
      run,
    }));
  items.push({ label: "$(sync) Automatic selection", description: "clear the explicit choice", run: undefined });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Which run should Agent Sparring follow?" });
  if (!picked) {
    return;
  }
  await controller.chooseRun(picked.run);
}

// ---------------------------------------------------------------- overview

async function openOverviewCommand(controller: SparringController, overview: OverviewPanelManager): Promise<void> {
  let selection = controller.currentSelection;
  if (!selection.selected && selection.ambiguous.length > 0 && !overview.isOpen) {
    // Ambiguity is resolved through the existing selection UX first.
    await selectRunCommand(controller);
    selection = controller.currentSelection;
    if (!selection.selected) {
      return;
    }
  }
  await overview.show();
}

async function openStageFile(controller: SparringController, filename: string): Promise<void> {
  const run = controller.currentSelection.selected;
  if (!run) {
    return;
  }
  await openDocument(path.join(currentStageOf(run).dir, filename), `${filename} does not exist yet for this stage.`);
}

async function openDocument(file: string, missingMessage: string): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    void vscode.window.showWarningMessage(`Agent Sparring: ${missingMessage}`);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

async function handleOverviewAction(controller: SparringController, overview: OverviewPanelManager, action: OverviewAction): Promise<void> {
  const run = controller.currentSelection.selected;
  switch (action) {
    case "openHandoff":
      return openStageFile(controller, HANDOFF_FILENAME);
    case "openSparring":
      return openStageFile(controller, SPARRING_FILENAME);
    case "openBrief":
      return openStageFile(controller, BRIEF_FILENAME);
    case "openPlan":
      if (run?.kind === "plan") {
        await openDocument(run.planPath, `the plan document ${run.state.plan} is missing.`);
      }
      return;
    case "openDiff": {
      if (!run) {
        return;
      }
      const stage = currentStageOf(run);
      const base = stage.state?.baseSha;
      if (!base) {
        void vscode.window.showInformationMessage("Agent Sparring: this stage has no recorded base_sha yet.");
        return;
      }
      await openCandidateDiff(run.location.repoRoot, base, stage.state?.candidateSha ?? undefined, stage.title ?? stage.stageId);
      return;
    }
    case "showLog":
      controller.showLog();
      return;
    case "selectRun":
      await selectRunCommand(controller);
      await overview.update();
      return;
    case "runPlan":
      return runPlanCommand(controller);
  }
}

// ---------------------------------------------------------------- launching

async function pickLocation(controller: SparringController): Promise<SparringLocation | undefined> {
  const locations = controller.sparringLocations;
  if (locations.length === 0) {
    void vscode.window.showErrorMessage("Agent Sparring: no `.sparring` directory in any workspace folder.");
    return undefined;
  }
  if (locations.length === 1) {
    return locations[0];
  }
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const containing = active ? locations.find((location) => isInside(active, location.repoRoot)) : undefined;
  if (containing) {
    return containing;
  }
  const picked = await vscode.window.showQuickPick(
    locations.map((location) => ({ label: path.basename(location.repoRoot), description: location.repoRoot, location })),
    { placeHolder: "Which repository?" },
  );
  return picked?.location;
}

function isInside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pickPlanDocument(location: SparringLocation): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.languageId === "markdown" && active.uri.scheme === "file" && isInside(active.uri.fsPath, location.repoRoot)) {
    if (await looksLikePlan(active.uri.fsPath)) {
      return active.uri.fsPath;
    }
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(location.repoRoot));
  const pattern = folder ? new vscode.RelativePattern(folder, "**/*.md") : "**/*.md";
  const candidates = await vscode.workspace.findFiles(pattern, "**/{node_modules,.git,.sparring,dist,out,.venv}/**", 400);
  const plans: { label: string; description: string; detail?: string; file: string }[] = [];
  for (const uri of candidates) {
    const stages = await planStageCount(uri.fsPath);
    if (stages && stages > 0) {
      plans.push({
        label: path.basename(uri.fsPath),
        description: path.relative(location.repoRoot, uri.fsPath),
        detail: `${stages} stage(s)`,
        file: uri.fsPath,
      });
    }
  }
  plans.sort((a, b) => a.description.localeCompare(b.description));
  const picked = await vscode.window.showQuickPick(
    [...plans, { label: "$(folder-opened) Browse…", description: "choose another Markdown file", file: "" }],
    { placeHolder: "Which reviewed plan should run? (plans are Markdown files with '## Stage <n> — <title>' headings)" },
  );
  if (!picked) {
    return undefined;
  }
  if (picked.file) {
    return picked.file;
  }
  const chosen = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.Uri.file(location.repoRoot),
    filters: { Markdown: ["md"] },
    openLabel: "Run plan",
  });
  return chosen?.[0]?.fsPath;
}

async function planStageCount(file: string): Promise<number | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!/^##\s+stage\b/im.test(text)) {
      return 0;
    }
    return parsePlanStages(text).length;
  } catch {
    return undefined; // malformed for the engine too; not offered
  }
}

async function looksLikePlan(file: string): Promise<boolean> {
  return ((await planStageCount(file)) ?? 0) > 0;
}

async function askBranch(location: SparringLocation, recorded?: string): Promise<string | undefined> {
  const detected = recorded ?? (await readGitBranch(location.repoRoot));
  const value = await vscode.window.showInputBox({
    title: "Agent Sparring: expected branch",
    prompt: recorded
      ? "The branch this plan run was started for (the engine refuses any other)."
      : "The feature branch every stage of this plan must modify (passed as --expected-branch).",
    value: detected ?? "",
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? undefined : "A branch name is required."),
  });
  return value?.trim() || undefined;
}

async function resolveOrExplain(location: SparringLocation): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration("agentSparring").get<string>("executable", "");
  const resolved = await resolveExecutable(configured, {
    platform: process.platform,
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    cwd: location.repoRoot,
  });
  if (resolved.ok) {
    return resolved.path;
  }
  const choice = await vscode.window.showErrorMessage(`Agent Sparring: ${resolved.error}`, "Open Settings");
  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "agentSparring.executable");
  }
  return undefined;
}

function launch(controller: SparringController, location: SparringLocation, executable: string, args: string[], name: string): void {
  // A terminal owns the process, so the run survives an extension-host
  // reload and the user sees the engine's own output. shellPath/shellArgs
  // execute the binary directly: no shell, no quoting, argument array only.
  const terminal = vscode.window.createTerminal({
    name: `Agent Sparring: ${name}`,
    shellPath: executable,
    shellArgs: args,
    cwd: location.repoRoot,
    iconPath: new vscode.ThemeIcon("debug-alt"),
  });
  terminal.show(true);
  controller.output.appendLine(`${timeNow()}  ${"Extension".padEnd(15)} launched ${name} in terminal (${args.length} args, cwd ${location.repoRoot})`);
  // The engine writes its run state before the first provider turn; pick it up promptly.
  setTimeout(() => void controller.refresh(), 1500);
  setTimeout(() => void controller.refresh(), 6000);
}

async function runPlanCommand(controller: SparringController): Promise<void> {
  const location = await pickLocation(controller);
  if (!location) {
    return;
  }
  const planPath = await pickPlanDocument(location);
  if (!planPath) {
    return;
  }
  const expectedBranch = await askBranch(location);
  if (!expectedBranch) {
    return;
  }
  const executable = await resolveOrExplain(location);
  if (!executable) {
    return;
  }
  const args = buildRunPlanArgs({ planPath, repoRoot: location.repoRoot, expectedBranch, sparringDir: location.sparringDir });
  launch(controller, location, executable, args, "run-plan");
}

async function resumePlanCommand(controller: SparringController): Promise<void> {
  const plans = controller.currentDiscovery.runs.filter((run): run is PlanRunSnapshot => run.kind === "plan" && run.state.status !== "complete");
  if (plans.length === 0) {
    void vscode.window.showInformationMessage("Agent Sparring: no paused or running plan run to resume.");
    return;
  }
  let run: PlanRunSnapshot | undefined = plans[0];
  const selected = controller.currentSelection.selected;
  if (plans.length > 1) {
    const picked = await vscode.window.showQuickPick(
      plans
        .slice()
        .sort((a, b) => Number(b.state.status === "paused") - Number(a.state.status === "paused"))
        .map((candidate) => ({
          label: `${candidate.id === selected?.id ? "$(check) " : ""}${candidate.state.plan}`,
          description: describeRun(candidate),
          candidate,
        })),
      { placeHolder: "Which plan run should resume?" },
    );
    run = picked?.candidate;
  }
  if (!run) {
    return;
  }
  if (run.state.status === "running") {
    const proceed = await vscode.window.showWarningMessage(
      `Agent Sparring: ${run.state.plan} is recorded as running. Resume only if that process is no longer alive.`,
      { modal: true },
      "Resume anyway",
    );
    if (proceed !== "Resume anyway") {
      return;
    }
  }
  const expectedBranch = await askBranch(run.location, run.state.expectedBranch);
  if (!expectedBranch) {
    return;
  }
  const evidence = await vscode.window.showInputBox({
    title: "Agent Sparring: human evidence (optional)",
    prompt: "Answer, check result or decision to record under '## Human evidence' before the same stage resumes. Leave empty to resume without evidence.",
    ignoreFocusOut: true,
  });
  if (evidence === undefined) {
    return;
  }
  const executable = await resolveOrExplain(run.location);
  if (!executable) {
    return;
  }
  const args = buildResumePlanArgs({
    planPath: run.planPath,
    repoRoot: run.location.repoRoot,
    expectedBranch,
    sparringDir: run.location.sparringDir,
    evidence,
  });
  launch(controller, run.location, executable, args, "resume-plan");
}

function timeNow(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
