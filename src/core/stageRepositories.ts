/**
 * Sibling repositories a plan stage reviews alongside the primary one.
 *
 * Some stages are genuinely two repositories — a desktop change here and the
 * coupled cloud migration there — and the sparrer's READY depends on both.
 * The engine already refuses to accept such a stage on the primary commit
 * alone: `freeze-candidate` pins every declared sibling after the same
 * branch/clean/pushed checks the primary gets, and `accept-candidate`
 * re-verifies each pin, so a sibling that moved after review refuses
 * acceptance as stale.
 *
 * What was missing was a way to *say so*. The declaration is a property of
 * the stage as planned, so it belongs where the plan is interpreted: it is
 * kept here, in VS Code workspace state, and emitted into the execution
 * manifest, which the engine then writes into the stage's own `state.json`
 * before anything runs. Nothing in the extension writes engine state.
 *
 * Two things are deliberately *not* stored:
 *
 *  - **the candidate commit.** Which commit was reviewed is the freeze
 *    boundary's answer, and only the engine is in a position to give it —
 *    asking a human to type a SHA would invite a stale one, which is exactly
 *    the failure the pinning exists to prevent. The manifest always emits
 *    `candidate_sha: null`.
 *  - **anything about status.** A declaration says which repositories this
 *    stage's candidate set spans, and nothing about how the work is going.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import type { ManifestRepository } from "./manifest";

/** One sibling repository, as the user declared it. */
export interface DeclaredRepository {
  /** Display name and the key the engine records the pin under (`sporely-web`). */
  name: string;
  /** Absolute path of the sibling's repository root, as picked in this window. */
  path: string;
  /** The branch that repository's candidate must be on; the engine refuses any other. */
  branch: string;
}

/**
 * workspaceState entry: plan key → stage label (upper case, no `Stage `
 * prefix) → declarations. Keyed by plan rather than by run id because a
 * stage may not exist yet when its sibling is declared — that is the normal
 * case for automatic continuation, where every stage after the current one
 * is created by the engine.
 */
export type StageRepositories = Record<string, Record<string, DeclaredRepository[]>>;

export const STAGE_REPOSITORIES_KEY = "agentSparring.stageRepositories";

/** Normalised label key: `3c`, `Stage 3C`, `3C` all address the same stage. */
export function repositoryLabelKey(label: string): string {
  return label.trim().replace(/^stage\s+/i, "").toUpperCase();
}

/** Every declaration recorded for one plan, defensively validated. Unknown shapes are dropped, never thrown on. */
export function repositoriesForPlan(state: StageRepositories | undefined, planKey: string): Record<string, DeclaredRepository[]> {
  const byLabel = state?.[planKey];
  if (!byLabel || typeof byLabel !== "object") {
    return {};
  }
  const out: Record<string, DeclaredRepository[]> = {};
  for (const [label, value] of Object.entries(byLabel)) {
    const declarations = Array.isArray(value) ? value.map(validate).filter((entry): entry is DeclaredRepository => entry !== undefined) : [];
    if (declarations.length > 0) {
      out[repositoryLabelKey(label)] = declarations;
    }
  }
  return out;
}

/** The declarations for one stage of one plan. */
export function repositoriesForStage(state: StageRepositories | undefined, planKey: string, label: string): DeclaredRepository[] {
  return repositoriesForPlan(state, planKey)[repositoryLabelKey(label)] ?? [];
}

function validate(value: unknown): DeclaredRepository | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entry = value as Partial<DeclaredRepository>;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const repoPath = typeof entry.path === "string" ? entry.path.trim() : "";
  const branch = typeof entry.branch === "string" ? entry.branch.trim() : "";
  return name && repoPath && branch ? { name, path: repoPath, branch } : undefined;
}

/**
 * Add or replace a declaration. Names are unique per stage — the engine
 * records pins by name, so two entries called the same thing would be one
 * candidate overwriting the other — and declaring the same name again is how
 * a branch or path is corrected.
 */
export function withStageRepository(state: StageRepositories | undefined, planKey: string, label: string, repository: DeclaredRepository): StageRepositories {
  const key = repositoryLabelKey(label);
  const current = repositoriesForPlan(state, planKey);
  const kept = (current[key] ?? []).filter((entry) => entry.name !== repository.name);
  return write(state, planKey, { ...current, [key]: [...kept, repository].sort((a, b) => a.name.localeCompare(b.name)) });
}

/** Remove one declaration by name; removing the last one drops the stage's entry entirely. */
export function withoutStageRepository(state: StageRepositories | undefined, planKey: string, label: string, name: string): StageRepositories {
  const key = repositoryLabelKey(label);
  const current = repositoriesForPlan(state, planKey);
  const kept = (current[key] ?? []).filter((entry) => entry.name !== name);
  const next = { ...current };
  if (kept.length > 0) {
    next[key] = kept;
  } else {
    delete next[key];
  }
  return write(state, planKey, next);
}

function write(state: StageRepositories | undefined, planKey: string, byLabel: Record<string, DeclaredRepository[]>): StageRepositories {
  const next: StageRepositories = { ...(state ?? {}) };
  if (Object.keys(byLabel).length > 0) {
    next[planKey] = byLabel;
  } else {
    delete next[planKey];
  }
  return next;
}

/**
 * The declarations as the manifest carries them: paths relative to the
 * primary repository root (which is what the engine resolves them against),
 * and no candidate commit — the freeze boundary resolves and pins that.
 *
 * A relative path keeps the manifest independent of where the checkouts sit
 * on one machine; a sibling on another drive, where no relative path exists,
 * stays absolute rather than being mangled.
 */
export function manifestRepositories(byLabel: Record<string, DeclaredRepository[]>, repoRoot: string): Record<string, ManifestRepository[]> {
  const out: Record<string, ManifestRepository[]> = {};
  for (const [label, declarations] of Object.entries(byLabel)) {
    out[label] = declarations.map((entry) => ({
      name: entry.name,
      path: relativeRepositoryPath(repoRoot, entry.path),
      branch: entry.branch,
      candidate_sha: null,
    }));
  }
  return out;
}

/** `../sporely-web-reported-statistics` for a sibling checkout next door; the absolute path when no relative one exists. */
export function relativeRepositoryPath(repoRoot: string, repositoryPath: string): string {
  if (!path.isAbsolute(repositoryPath)) {
    return repositoryPath;
  }
  const relative = path.relative(repoRoot, repositoryPath);
  if (!relative || path.isAbsolute(relative)) {
    return repositoryPath;
  }
  return relative.split(path.sep).join("/");
}
