/**
 * Ask the installed engine whether an intake slice needs a feature branch
 * (`sparring slice-branch --json`), and have it create or move one.
 *
 * Like configProbe.ts this is a probe: the engine owns the protected-branch
 * policy and every check behind a move, and an engine too old to have the
 * command produces no answer, never a guess. Answers are cached per slice
 * and invalidated by what can change them — the repository's HEAD and index,
 * the slice's approval files — and by a short time bucket, so re-rendering
 * the Overview does not spawn a process each time.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { planExecutable } from "../core/cli";
import { parseSliceBranch, type SliceBranchReport, type SliceBranchTarget } from "../core/sliceBranch";
import { hostEnv } from "./shellIntegration";

const cache = new Map<string, { stamp: string; value: SliceBranchReport | undefined }>();
const BUCKET_MS = 30_000;

async function fileStamp(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "absent";
  }
}

async function gitDir(repoRoot: string): Promise<string> {
  const dotGit = path.join(repoRoot, ".git");
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) {
      return dotGit;
    }
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
    return pointer ? path.resolve(repoRoot, pointer[1].trim()) : dotGit;
  } catch {
    return dotGit;
  }
}

async function stampOf(target: SliceBranchTarget): Promise<string> {
  const git = await gitDir(target.repoRoot);
  let head = "";
  try {
    head = await readFile(path.join(git, "HEAD"), "utf8");
  } catch {
    head = "absent";
  }
  const runs = path.join(target.intakeDir, "runs");
  let slices: string[] = [];
  try {
    slices = (await readdir(runs)).sort();
  } catch {
    slices = [];
  }
  const approvals = await Promise.all(
    slices.flatMap((name) => ["approval.json", "branch-move.json"].map((file) => fileStamp(path.join(runs, name, file)))),
  );
  return [head, await fileStamp(path.join(git, "index")), ...approvals, Math.floor(Date.now() / BUCKET_MS)].join("\u0000");
}

function keyOf(file: string, target: SliceBranchTarget): string {
  return [file, target.intakeDir, target.runId, target.repoRoot].join("\u0000");
}

function run(file: string, target: SliceBranchTarget, extra: string[]): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--sparring-dir", target.sparringDir, "slice-branch", target.intakeDir, "--run", target.runId, "--repo-root", target.repoRoot, ...extra, "--json"],
      { cwd: target.repoRoot, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: Boolean(error) }),
    );
  });
}

/** The engine's answer for this slice, or undefined when it gave none. `fresh` skips the cache. */
export async function readSliceBranch(configured: string | undefined, target: SliceBranchTarget, fresh = false): Promise<SliceBranchReport | undefined> {
  const planned = await planExecutable(configured, hostEnv(target.repoRoot), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return undefined;
  }
  const file = planned.plan.path;
  const key = keyOf(file, target);
  const stamp = await stampOf(target);
  const known = cache.get(key);
  if (!fresh && known && known.stamp === stamp) {
    return known.value;
  }
  const { stdout } = await run(file, target, []);
  const value = parseSliceBranch(stdout);
  cache.set(key, { stamp, value });
  return value;
}

export type SliceBranchChange = { create: string } | { move: true };

export type SliceBranchChangeResult =
  | { ok: true; created?: string; movedFrom?: string; movedTo?: string; report?: SliceBranchReport }
  /** The engine's own refusal, for the person to read. */
  | { ok: false; error: string };

/** Have the engine create the branch (and move the approval), or move the approval to the branch checked out now. */
export async function changeSliceBranch(configured: string | undefined, target: SliceBranchTarget, change: SliceBranchChange): Promise<SliceBranchChangeResult> {
  const planned = await planExecutable(configured, hostEnv(target.repoRoot), false);
  if (!planned.ok || planned.plan.kind === "shell") {
    return { ok: false, error: "The sparring CLI could not be resolved from this window." };
  }
  const file = planned.plan.path;
  cache.delete(keyOf(file, target));
  const { stdout, stderr, failed } = await run(file, target, "create" in change ? ["--create", change.create] : ["--move"]);
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    payload = undefined;
  }
  if (!payload || failed || payload["ok"] !== true) {
    const error = payload && typeof payload["error"] === "string" ? payload["error"] : `${stderr}${stdout}`.trim();
    return { ok: false, error: error || "the engine did not say what happened" };
  }
  const moved = payload["moved"] && typeof payload["moved"] === "object" ? (payload["moved"] as Record<string, unknown>) : undefined;
  const report = parseSliceBranch(stdout);
  return {
    ok: true,
    ...(typeof payload["created"] === "string" ? { created: payload["created"] } : {}),
    ...(moved && typeof moved["from_branch"] === "string" ? { movedFrom: moved["from_branch"] } : {}),
    ...(moved && typeof moved["to_branch"] === "string" ? { movedTo: moved["to_branch"] } : {}),
    ...(report ? { report } : {}),
  };
}

/** Testing seam: forget what was probed. */
export function resetSliceBranchCache(): void {
  cache.clear();
}
