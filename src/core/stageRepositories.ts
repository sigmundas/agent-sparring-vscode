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
import { declarationScope, migrateDeclarations, type DeclarationMigration, type ScopedPlanRun } from "./declarationScope";
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
 * workspaceState entry: **scope key** → stage label (upper case, no `Stage `
 * prefix) → declarations.
 *
 * Keyed by plan and stage rather than by run id because a stage may not exist
 * yet when its sibling is declared — that is the normal case for automatic
 * continuation, where every stage after the current one is created by the
 * engine.
 *
 * And keyed by **worktree** as well, through the shared identity in
 * declarationScope.ts. A plan key is a hash of the plan's repo-relative path,
 * so every checkout of the same plan shares one; keyed by plan alone,
 * declaring `sporely-web` as Stage 3D's sibling in one worktree changed what
 * every other worktree of that repository executes. Like a stage's mode, this
 * is not a display setting: it goes into the execution manifest, the engine
 * folds each declared repository's name, path, branch and candidate SHA into
 * the digest that identifies a recorded run, and it refuses to continue a run
 * whose digest changed — so a declaration made in A could stop B's in-flight
 * run over a change nobody made in B.
 */
export type StageRepositories = Record<string, Record<string, DeclaredRepository[]>>;

export const STAGE_REPOSITORIES_KEY = "agentSparring.stageRepositories";

/**
 * The scope one declaration belongs to: this plan, in this worktree. The same
 * identity a stage's mode uses (declarationScope.ts), deliberately — two
 * schemes for one question is how two surfaces end up disagreeing about which
 * worktree they are talking about.
 */
export function stageRepositoryScope(planKey: string, projectDir: string): string {
  return declarationScope(planKey, projectDir);
}

/** Normalised label key: `3c`, `Stage 3C`, `3C` all address the same stage. */
export function repositoryLabelKey(label: string): string {
  return label.trim().replace(/^stage\s+/i, "").toUpperCase();
}

/**
 * Every declaration recorded for one plan **in one worktree**, defensively
 * validated. Unknown shapes are dropped, never thrown on.
 *
 * Only the scoped key is ever read. An entry left at a bare plan key is one
 * the migration could not attribute to a single worktree, and applying it
 * would be exactly the accident the scope exists to prevent — so it is
 * reported (see {@link migrateStageRepositories}) and never executed.
 */
export function repositoriesForPlan(state: StageRepositories | undefined, planKey: string, projectDir: string): Record<string, DeclaredRepository[]> {
  const byLabel = state?.[stageRepositoryScope(planKey, projectDir)];
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

/** The declarations for one stage of one plan, in one worktree. */
export function repositoriesForStage(state: StageRepositories | undefined, planKey: string, projectDir: string, label: string): DeclaredRepository[] {
  return repositoriesForPlan(state, planKey, projectDir)[repositoryLabelKey(label)] ?? [];
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
export function withStageRepository(
  state: StageRepositories | undefined,
  planKey: string,
  projectDir: string,
  label: string,
  repository: DeclaredRepository,
): StageRepositories {
  const key = repositoryLabelKey(label);
  const current = repositoriesForPlan(state, planKey, projectDir);
  const kept = (current[key] ?? []).filter((entry) => entry.name !== repository.name);
  return write(state, planKey, projectDir, { ...current, [key]: [...kept, repository].sort((a, b) => a.name.localeCompare(b.name)) });
}

/** Remove one declaration by name; removing the last one drops the stage's entry entirely. */
export function withoutStageRepository(state: StageRepositories | undefined, planKey: string, projectDir: string, label: string, name: string): StageRepositories {
  const key = repositoryLabelKey(label);
  const current = repositoriesForPlan(state, planKey, projectDir);
  const kept = (current[key] ?? []).filter((entry) => entry.name !== name);
  const next = { ...current };
  if (kept.length > 0) {
    next[key] = kept;
  } else {
    delete next[key];
  }
  return write(state, planKey, projectDir, next);
}

function write(state: StageRepositories | undefined, planKey: string, projectDir: string, byLabel: Record<string, DeclaredRepository[]>): StageRepositories {
  const scope = stageRepositoryScope(planKey, projectDir);
  const next: StageRepositories = { ...(state ?? {}) };
  if (Object.keys(byLabel).length > 0) {
    next[scope] = byLabel;
  } else {
    delete next[scope];
  }
  return next;
}

/** A plan run as the migration reads one (declarationScope.ts). */
export type { ScopedPlanRun };

/** What a migration pass did; the shared shape, so both surfaces report alike. */
export type StageRepositoryMigration = DeclarationMigration<DeclaredRepository[]>;

/**
 * Move sibling-repository declarations made before they were scoped to a
 * worktree onto the worktree they were made in.
 *
 * The same rule, and the same helper, as a stage's mode: a legacy entry whose
 * plan key matches exactly one discovered plan run belongs to that run's
 * worktree, and anything else is kept unapplied rather than guessed at. See
 * {@link migrateDeclarations}.
 */
export function migrateStageRepositories(state: StageRepositories | undefined, runs: readonly ScopedPlanRun[]): StageRepositoryMigration {
  return migrateDeclarations<DeclaredRepository[]>(state, runs);
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
