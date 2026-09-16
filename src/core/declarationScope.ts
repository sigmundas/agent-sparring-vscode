/**
 * Which worktree a human's declaration about a plan stage belongs to.
 *
 * Two kinds of declaration are kept in VS Code workspace state and emitted
 * into the execution manifest: what kind of stage a stage is
 * (stageModes.ts) and which sibling repositories its candidate spans
 * (stageRepositories.ts). Neither is engine state; both change what the
 * engine is handed.
 *
 * ### Why a plan key is not enough to key them by
 *
 * A plan key is a hash of the plan's **repo-relative** path (`plan.py:
 * plan_key`), so two worktrees of one repository with `docs/plans/foo.md`
 * checked out produce the same key — and running two stages of a plan side by
 * side in two worktrees is the ordinary way to work here, not an edge case.
 * Keyed by plan alone, a declaration made in worktree A silently applied to
 * worktree B.
 *
 * That is not a display bug. Both kinds of declaration go into the execution
 * manifest, the engine folds the manifest's executable content into the digest
 * that identifies a recorded run, and it refuses to continue a run whose
 * digest changed. So declaring something in A could stop B's in-flight run
 * with a complaint about changed executable content, for a change nobody made
 * in B — and the supported way out of that is `reset-stage`, which archives
 * the attempt.
 *
 * So both are keyed by {@link declarationScope}, and they share this module
 * rather than each inventing an identity: two schemes for one question is how
 * the two surfaces end up disagreeing about which worktree they are talking
 * about.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";

/**
 * The scope one declaration belongs to: this plan, in this worktree, written
 * `<plan key>@<resolved project directory>`.
 *
 * `@` is a safe separator: a plan key is `<slug>-<8 hex>` with the slug drawn
 * from `[a-z0-9-]`, so it can never contain one, and everything after the
 * first `@` is the project directory.
 *
 * A path rather than a hash, because this is workspace state a person may
 * have to read and repair, and because {@link legacyPlanKey} has to be able to
 * tell a scoped key from an unscoped one by looking at it.
 */
export function declarationScope(planKey: string, projectDir: string): string {
  return `${planKey}@${path.resolve(projectDir)}`;
}

/**
 * The plan key of an **unscoped** entry, or `undefined` when the key is
 * already scoped to a worktree. Used only by the migration.
 */
export function legacyPlanKey(key: string): string | undefined {
  return key.includes("@") ? undefined : key;
}

/** A plan run as the migration reads one: which plan, in which worktree. */
export interface ScopedPlanRun {
  planKey: string;
  location: { projectDir: string };
}

/** What a migration pass did, so the window can say it rather than doing it silently. */
export interface DeclarationMigration<V> {
  next: Record<string, Record<string, V>>;
  /** Declarations attributed to exactly one worktree and moved there. */
  migrated: { planKey: string; projectDir: string; labels: string[] }[];
  /**
   * Declarations that could belong to more than one discovered worktree, or
   * to none that is open. They are **kept and not applied**: re-declaring one
   * is a click, and applying it to the wrong worktree changes what that
   * worktree executes.
   */
  ambiguous: { planKey: string; labels: string[]; candidates: string[] }[];
}

/**
 * Move declarations made before they were scoped to a worktree onto the
 * worktree they were made in, where that can be established.
 *
 * It can be established from recorded execution and nothing else: a discovered
 * plan run carries both the plan key and the project directory, so a legacy
 * entry whose plan key matches **exactly one** discovered plan run belongs to
 * that run's worktree. That covers the case this has to cover — a person with
 * one checkout of a plan, who declared something before the scope existed and
 * must not silently lose it.
 *
 * Everything else fails closed rather than being guessed at. Two worktrees
 * running the same plan is precisely when a wrong guess changes what one of
 * them executes; and "no discovered run" usually just means the relevant
 * folder is not open right now, so dropping the declaration would be
 * destroying someone's work to tidy up.
 *
 * A declaration already made in that worktree wins over the legacy one, label
 * by label: it is the newer statement, and the legacy entry is what is being
 * retired.
 *
 * Idempotent: an already-scoped key has no legacy form, so a second pass over
 * the same state changes nothing and reports nothing.
 */
export function migrateDeclarations<V>(
  state: Record<string, Record<string, V>> | undefined,
  runs: readonly ScopedPlanRun[],
): DeclarationMigration<V> {
  const next: Record<string, Record<string, V>> = { ...(state ?? {}) };
  const migrated: DeclarationMigration<V>["migrated"] = [];
  const ambiguous: DeclarationMigration<V>["ambiguous"] = [];
  for (const [key, byLabel] of Object.entries(state ?? {})) {
    const planKey = legacyPlanKey(key);
    if (planKey === undefined || !byLabel || typeof byLabel !== "object") {
      continue;
    }
    const labels = Object.keys(byLabel);
    const owners = [...new Set(runs.filter((run) => run.planKey === planKey).map((run) => path.resolve(run.location.projectDir)))];
    if (owners.length !== 1) {
      ambiguous.push({ planKey, labels, candidates: owners });
      continue;
    }
    const scope = declarationScope(planKey, owners[0]);
    next[scope] = { ...byLabel, ...(next[scope] ?? {}) };
    delete next[key];
    migrated.push({ planKey, projectDir: owners[0], labels });
  }
  return { next, migrated, ambiguous };
}
