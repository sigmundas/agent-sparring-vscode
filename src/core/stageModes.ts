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
 * state, keyed by plan and stage label, exactly like a stage's sibling
 * repositories (stageRepositories.ts), and emitted into the manifest the
 * engine executes. Nothing in the extension writes engine state.
 *
 * One consequence worth knowing before declaring one: the mode is part of
 * what the engine digests to identify a recorded run, so declaring it for a
 * stage of a run already under way changes that run's digest. The engine
 * refuses to continue across such a change by design; its `reset-stage`
 * command is the supported way through, and it re-records the digest itself.
 *
 * No dependency on the vscode API.
 */

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
 * workspaceState entry: plan key → stage label (upper case, no `Stage `
 * prefix) → mode. Keyed by plan rather than by run id for the same reason
 * sibling repositories are: the stage may not exist yet when its mode is
 * declared, which is the normal case for automatic continuation, where every
 * stage after the current one is created by the engine.
 */
export type StageModes = Record<string, Record<string, StageMode>>;

export const STAGE_MODES_KEY = "agentSparring.stageModes";

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
export function modesForPlan(state: StageModes | undefined, planKey: string): Record<string, StageMode> {
  const byLabel = state?.[planKey];
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

/** One stage's declared mode; `implementation` when nothing was declared. */
export function modeForStage(state: StageModes | undefined, planKey: string, label: string): StageMode {
  return modesForPlan(state, planKey)[modeLabelKey(label)] ?? "implementation";
}

/**
 * Declare a stage's mode. Setting it back to `implementation` removes the
 * entry, so "no declaration" and "declared as the default" are the same
 * state and cannot disagree about what the manifest should say.
 */
export function withStageMode(state: StageModes | undefined, planKey: string, label: string, mode: StageMode): StageModes {
  const key = modeLabelKey(label);
  const current = modesForPlan(state, planKey);
  const next = { ...current };
  if (mode === "implementation") {
    delete next[key];
  } else {
    next[key] = mode;
  }
  const all: StageModes = { ...(state ?? {}) };
  if (Object.keys(next).length > 0) {
    all[planKey] = next;
  } else {
    delete all[planKey];
  }
  return all;
}
