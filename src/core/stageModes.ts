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

import { declarationScope, migrateDeclarations, type DeclarationMigration, type ScopedPlanRun } from "./declarationScope";

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
 * And keyed by **worktree** as well, because a plan key is shared by every
 * checkout of the same plan path — declaring Stage 5 review-only in worktree
 * A used to change what worktree B executes, and through the run digest,
 * whether B's in-flight run could continue at all. declarationScope.ts has
 * the whole argument; sibling repository declarations are keyed the same way,
 * by the same helpers.
 */
export type StageModes = Record<string, Record<string, StageMode>>;

export const STAGE_MODES_KEY = "agentSparring.stageModes";

/**
 * The scope one declaration belongs to: this plan, in this worktree. The
 * shared identity (declarationScope.ts), not a second scheme of its own —
 * sibling repository declarations are keyed exactly the same way, and two
 * schemes for one question is how the two surfaces end up disagreeing about
 * which worktree they are talking about.
 */
export function stageModeScope(planKey: string, projectDir: string): string {
  return declarationScope(planKey, projectDir);
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

/** A plan run as the migration reads one (declarationScope.ts). */
export type { ScopedPlanRun };

/** What a migration pass did; the shared shape, so the two surfaces report alike. */
export type StageModeMigration = DeclarationMigration<StageMode>;

/**
 * Move stage-mode declarations made before they were scoped to a worktree
 * onto the worktree they were made in. See
 * {@link migrateDeclarations} for what counts as establishing that, and for
 * why everything else is kept rather than guessed at.
 */
export function migrateStageModes(state: StageModes | undefined, runs: readonly ScopedPlanRun[]): StageModeMigration {
  return migrateDeclarations<StageMode>(state, runs);
}
