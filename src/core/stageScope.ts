/**
 * The identity that per-stage UI state belongs to.
 *
 * A managed plan run keeps **one** run id from its first stage to its last
 * (`discovery.runIdFor`: `<project>|plan:<plan key>`). Everything this window
 * remembers on a person's behalf — drafted check results, notes, freeform
 * feedback, the record of a submission that is in flight or failed — used to
 * be keyed by that id alone, so it outlived the stage it was entered for.
 * A Stage 1 submission that failed went on saying "Submission failed" while
 * the engine was already several turns into Stage 2, which makes a healthy
 * stage look broken; and Stage 1's drafted results would have populated
 * Stage 2's controls for checks that merely happened to share a key.
 *
 * So the unit of attribution is the run *and* the stage it was current at:
 * two facts the engine records, never a title, an index or a panel position.
 * A standalone stage run has exactly one stage, so its scope is stable for
 * its whole life and nothing about it changes.
 *
 * Keys are opaque and stable across reloads. They are built from the run id,
 * which already carries the project directory, so state from one repository's
 * run can never be read under another's.
 *
 * No dependency on the vscode API.
 */

import { currentStageOf, type RunSnapshot } from "./discovery";

export interface StageScope {
  runId: string;
  stageId: string;
}

/**
 * The separator between the run id and the stage id.
 *
 * Deliberately not `|`, which `runIdFor` already uses: a key must never be
 * ambiguous about where the run id ends, and `runId.split("|")` is used
 * elsewhere to recover a run's label.
 */
const SEPARATOR = "#stage:";

/** The scope a run's *current* stage is. The one place that answers this. */
export function stageScopeOf(run: RunSnapshot): StageScope {
  return { runId: run.id, stageId: currentStageOf(run).stageId };
}

/** The workspace-state key for one scope. */
export function stageScopeKey(scope: StageScope): string {
  return `${scope.runId}${SEPARATOR}${scope.stageId}`;
}

/** Whether two scopes are the same run at the same stage. */
export function sameStageScope(a: StageScope | undefined, b: StageScope | undefined): boolean {
  return a !== undefined && b !== undefined && a.runId === b.runId && a.stageId === b.stageId;
}

/**
 * The scope a stored key names, or undefined for a key stored before state
 * was scoped to a stage (those are keyed by the bare run id).
 */
export function parseStageScopeKey(key: string): StageScope | undefined {
  const at = key.lastIndexOf(SEPARATOR);
  if (at <= 0) {
    return undefined;
  }
  const stageId = key.slice(at + SEPARATOR.length);
  return stageId ? { runId: key.slice(0, at), stageId } : undefined;
}

/**
 * Move state stored under a bare run id into the scope it belongs to.
 *
 * Entries written before this window scoped state to a stage carry no stage
 * of their own, so the only honest answer for them is the stage their run is
 * current at now — which is right in the ordinary case, a person part-way
 * through a stage when the extension is updated, and is what keeps their
 * typed notes from silently vanishing. An entry whose run is not discovered
 * in this window is left exactly where it is: it is somebody's work, and
 * nothing here knows which stage it was for.
 *
 * A caller that *can* tell which stage an entry was for (a submission record
 * carries its own `stageId`) passes `stageOf`, and that answer wins.
 */
export function migrateToStageScope<V>(
  stored: Record<string, V> | undefined,
  currentStageFor: (runId: string) => string | undefined,
  stageOf?: (value: V) => string | undefined,
): { next: Record<string, V>; moved: { runId: string; stageId: string }[] } | undefined {
  const moved: { runId: string; stageId: string }[] = [];
  const next: Record<string, V> = { ...(stored ?? {}) };
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (parseStageScopeKey(key)) {
      continue; // already scoped
    }
    const stageId = stageOf?.(value) ?? currentStageFor(key);
    if (!stageId) {
      continue; // nothing in this window can say which stage it was for
    }
    const scoped = stageScopeKey({ runId: key, stageId });
    if (next[scoped] === undefined) {
      next[scoped] = value;
    }
    delete next[key];
    moved.push({ runId: key, stageId });
  }
  return moved.length > 0 ? { next, moved } : undefined;
}
