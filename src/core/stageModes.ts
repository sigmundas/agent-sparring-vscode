/**
 * What kind of stage a plan stage is: work, or a review of work.
 *
 * A plan's last stage is often not work at all — a fresh independent
 * reviewer verifies the candidates the earlier stages accepted, checks every
 * gate, and the activation decision is taken on that. Run through the
 * ordinary lifecycle it gets an implementation agent with nothing to
 * implement, which opens a session, reads around, and sooner or later writes
 * something to try an idea out. The reviewer of the work is then also its
 * author, which is the one thing such a stage exists to prevent.
 *
 * The engine can run that stage as a review instead, and it takes the
 * instruction from one explicit field in the execution manifest —
 * `"mode": "independent_review"`. What it deliberately will *not* do is
 * infer it. A stage titled "Independent final review and activation
 * decision" runs the implementation lifecycle unless the manifest says
 * otherwise, because which agent runs is not something to read off a
 * heading, and a brief whose prose asks for a review is text an agent reads
 * rather than a decision about which agent reads it.
 *
 * So the declaration is a human's, and it is kept here: in VS Code workspace
 * state, keyed by **worktree**, plan and stage label, and emitted into the
 * manifest the engine executes. Nothing in the extension writes engine state.
 *
 * The worktree is part of the key because a plan key is a hash of the plan's
 * repo-relative path, so two worktrees running the same plan share one — see
 * {@link StageModes}. (A stage's sibling repositories, stageRepositories.ts,
 * are still keyed by plan alone and have the same exposure; that is recorded
 * as a known follow-up rather than changed here.)
 *
 * One consequence worth knowing before declaring one: the mode is part of
 * what the engine digests to identify a recorded run, so declaring it for a
 * stage of a run already under way changes that run's digest. The engine
 * refuses to continue across such a change by design; its `reset-stage`
 * command is the supported way through, and it re-records the digest itself.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";

/** The modes the engine reads. `implementation` is its default and is never emitted. */
export type StageMode = "implementation" | "independent_review";

export const STAGE_MODES: StageMode[] = ["implementation", "independent_review"];

/** How a mode is named to a person, and what choosing it actually does. */
export const STAGE_MODE_LABELS: Record<StageMode, { label: string; detail: string }> = {
  implementation: {
    label: "Implementation",
    detail: "A stage agent implements, a sparrer reviews, and READY freezes the commit the stage produced. The default.",
  },
  independent_review: {
    label: "Independent review (review only)",
    detail: "No implementation agent runs. A fresh reviewer inspects the candidates the earlier stages accepted and routes; a defect it finds stops the plan instead of becoming work.",
  },
};

/**
 * workspaceState entry: **scope key** → stage label (upper case, no `Stage `
 * prefix) → mode.
 *
 * Keyed by plan and stage rather than by run id for the same reason sibling
 * repositories are: the stage may not exist yet when its mode is declared,
 * which is the normal case for automatic continuation, where every stage
 * after the current one is created by the engine.
 *
 * ### Why the scope key is not just the plan key
 *
 * A plan key is a hash of the plan's **repo-relative** path (`plan.py:
 * plan_key`), so two worktrees of one repository running
 * `docs/plans/foo.md` produce the same key — and running two stages of a plan
 * side by side in two worktrees is the ordinary way to work here, not an edge
 * case. Keyed by plan alone, declaring Stage 5 review-only in worktree A
 * silently changed what worktree B executes.
 *
 * That is not a display bug. The mode goes into the execution manifest, the
 * engine folds a non-default mode into the digest that identifies a recorded
 * run, and it refuses to continue a run whose digest changed. So a
 * declaration made in A could stop B's in-flight run with a message about
 * changed executable content, for a change nobody made in B.
 *
 * The scope is therefore the plan key **and the worktree**, written as
 * `<plan key>@<resolved project directory>`. A path rather than a hash
 * because this is workspace state a person may have to read and repair, and
 * because {@link legacyScope} has to be able to tell a migrated key from an
 * unmigrated one by looking at it.
 */
export type StageModes = Record<string, Record<string, StageMode>>;

export const STAGE_MODES_KEY = "agentSparring.stageModes";

/**
 * The scope one declaration belongs to: this plan, in this worktree.
 *
 * `@` is a safe separator: a plan key is `<slug>-<8 hex>` with the slug drawn
 * from `[a-z0-9-]`, so it can never contain one, and everything after the
 * first `@` is the project directory.
 */
export function stageModeScope(planKey: string, projectDir: string): string {
  return `${planKey}@${path.resolve(projectDir)}`;
}

/**
 * The plan key of an **unscoped** entry, or undefined when the key is already
 * scoped to a worktree. Used only by the migration.
 */
export function legacyScope(key: string): string | undefined {
  return key.includes("@") ? undefined : key;
}

/** Normalised label key: `5`, `Stage 5`, `3c` all address the same stage. */
export function modeLabelKey(label: string): string {
  return label.trim().replace(/^stage\s+/i, "").toUpperCase();
}

function validate(value: unknown): StageMode | undefined {
  return value === "independent_review" || value === "implementation" ? value : undefined;
}

/**
 * Every mode recorded for one plan, defensively validated. Unknown shapes are
 * dropped rather than thrown on, and an explicit `implementation` is dropped
 * too: it is the engine's default, so recording it would only make the
 * manifest noisier without changing what runs.
 */
export function modesForPlan(state: StageModes | undefined, planKey: string, projectDir: string): Record<string, StageMode> {
  // Only the scoped key is ever read. An entry left at a bare plan key is one
  // the migration could not attribute to a single worktree, and applying it
  // would be exactly the accident the scope exists to prevent — so it is
  // reported (see {@link migrateStageModes}) and never executed.
  const byLabel = state?.[stageModeScope(planKey, projectDir)];
  if (!byLabel || typeof byLabel !== "object") {
    return {};
  }
  const out: Record<string, StageMode> = {};
  for (const [label, value] of Object.entries(byLabel)) {
    const mode = validate(value);
    if (mode && mode !== "implementation") {
      out[modeLabelKey(label)] = mode;
    }
  }
  return out;
}

/** One stage's declared mode in one worktree; `implementation` when nothing was declared. */
export function modeForStage(state: StageModes | undefined, planKey: string, projectDir: string, label: string): StageMode {
  return modesForPlan(state, planKey, projectDir)[modeLabelKey(label)] ?? "implementation";
}

/**
 * Declare a stage's mode, for this plan **in this worktree**. Setting it back
 * to `implementation` removes the entry, so "no declaration" and "declared as
 * the default" are the same state and cannot disagree about what the manifest
 * should say.
 */
export function withStageMode(state: StageModes | undefined, planKey: string, projectDir: string, label: string, mode: StageMode): StageModes {
  const scope = stageModeScope(planKey, projectDir);
  const key = modeLabelKey(label);
  const next = { ...modesForPlan(state, planKey, projectDir) };
  if (mode === "implementation") {
    delete next[key];
  } else {
    next[key] = mode;
  }
  const all: StageModes = { ...(state ?? {}) };
  if (Object.keys(next).length > 0) {
    all[scope] = next;
  } else {
    delete all[scope];
  }
  return all;
}

/** A plan run as the migration needs it: which plan, in which worktree. */
export interface ScopedPlanRun {
  planKey: string;
  location: { projectDir: string };
}

/** What a migration pass did, so the window can say it rather than doing it silently. */
export interface StageModeMigration {
  next: StageModes;
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
 * Move declarations made before modes were scoped to a worktree onto the
 * worktree they were made in, where that can be established.
 *
 * It can be established from recorded execution and nothing else: a discovered
 * plan run carries both the plan key and the project directory, so a legacy
 * entry whose plan key matches **exactly one** discovered plan run belongs to
 * that run's worktree. That covers the case this has to cover — a person with
 * one checkout of a plan, who declared Stage 5 review-only before the scope
 * existed and must not silently lose it.
 *
 * Everything else is left alone rather than guessed at. Two worktrees running
 * the same plan is precisely when a wrong guess changes what one of them
 * executes, and "no discovered run" usually just means the relevant folder is
 * not open right now — dropping the declaration then would be destroying
 * someone's work to tidy up.
 *
 * Idempotent: an already-scoped key has no legacy form, so a second pass over
 * the same state changes nothing and reports nothing.
 */
export function migrateStageModes(state: StageModes | undefined, runs: readonly ScopedPlanRun[]): StageModeMigration {
  const next: StageModes = { ...(state ?? {}) };
  const migrated: StageModeMigration["migrated"] = [];
  const ambiguous: StageModeMigration["ambiguous"] = [];
  for (const [key, byLabel] of Object.entries(state ?? {})) {
    const planKey = legacyScope(key);
    if (planKey === undefined || !byLabel || typeof byLabel !== "object") {
      continue;
    }
    const labels = Object.keys(byLabel);
    const owners = [...new Set(runs.filter((run) => run.planKey === planKey).map((run) => path.resolve(run.location.projectDir)))];
    if (owners.length !== 1) {
      ambiguous.push({ planKey, labels, candidates: owners });
      continue;
    }
    const scope = stageModeScope(planKey, owners[0]);
    // An explicit declaration already made in that worktree wins: it is the
    // newer statement, and the legacy entry is what is being retired.
    next[scope] = { ...byLabel, ...(next[scope] ?? {}) };
    delete next[key];
    migrated.push({ planKey, projectDir: owners[0], labels });
  }
  return { next, migrated, ambiguous };
}
