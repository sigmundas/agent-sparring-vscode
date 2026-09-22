/**
 * Fold the observational activity stream into "what is happening right
 * now": which actor is mid-turn, the last verdict, the last file touched.
 *
 * This is live decoration only. It is never used to decide lifecycle
 * status (running/paused/complete, working/frozen/accepted); those come
 * from the authoritative plan-run and stage state files (see status.ts).
 *
 * No dependency on the vscode API.
 */

import { describeActivity, isMeaningfulActivity, shortId } from "./activityFilter";
import type { ActivityEvent } from "./engineFormats";

export { shortId };

/**
 * What a provider last said about its own budget (`provider.usage`).
 *
 * Every field is optional, and `undefined` means **the provider did not
 * say** — never zero, and never a figure derived from the model name. The
 * two are shown differently, because a context ring drawn from a guessed
 * window would carry a measurement's authority without being one. Codex
 * states all of these; the Claude CLI states only the token counts.
 */
export interface ActorBudget {
  inputTokens?: number;
  outputTokens?: number;
  /** The provider's own cumulative total for the session. */
  totalTokens?: number;
  /** The model's context size as the provider stated it. */
  contextWindow?: number;
  /** Primary rate-limit window usage, 0-100, and the window it is of. */
  primaryPercent?: number;
  primaryWindowMinutes?: number;
  /** The longer window (weekly, typically). */
  secondaryPercent?: number;
  secondaryWindowMinutes?: number;
  /** When the provider last stated any of the above. */
  ts?: string;
}

export interface ActorLive {
  provider?: string;
  sessionId?: string;
  model?: string;
  /**
   * Merged field by field across `provider.usage` events, because one
   * event may carry tokens and another the rate limits, and a later
   * token-only event must not erase a context window already stated.
   * Cleared when the session changes: these totals are per session, and
   * carrying a finished session's context into a new one would overstate
   * it.
   */
  budget?: ActorBudget;
  /** A turn started and has not yet finished/failed (as far as telemetry says). */
  busy: boolean;
  /** Timestamp of the latest turn start/resume while busy; cleared when the turn ends. */
  busySince?: string;
  lastEventTs?: string;
}

/** The last event that would earn a line in the Output Channel. */
export interface MeaningfulEvent {
  ts: string;
  actor: string;
  event: string;
  description: string;
}

export interface LiveVerdict {
  action: string;
  summary?: string;
  ts: string;
}

export interface LiveState {
  stage: ActorLive;
  sparrer: ActorLive;
  lastVerdict?: LiveVerdict;
  lastFileChanged?: { path?: string; actor: string; ts: string };
  lastPlanEvent?: { event: string; action?: string; summary?: string; ts: string };
  lastGateEvent?: { event: string; sha?: string; summary?: string; ts: string };
  lastLoopEvent?: { event: string; action?: string; summary?: string; cycle?: number; ts: string };
  /** Latest loop cycle number any loop event carried. */
  currentCycle?: number;
  /** Last event that passes the shared Output filter; suppressed noise never lands here. */
  lastMeaningful?: MeaningfulEvent;
  /**
   * The most recent meaningful events, oldest first, capped at
   * RECENT_MEANINGFUL_MAX; consecutive repeats (same actor and description,
   * e.g. a burst of edits to one file) collapse into one entry.
   */
  recentMeaningful: MeaningfulEvent[];
  lastEventTs?: string;
  eventCount: number;
  sendBackCount: number;
}

export const RECENT_MEANINGFUL_MAX = 8;

export function emptyLiveState(): LiveState {
  return { stage: { busy: false }, sparrer: { busy: false }, eventCount: 0, sendBackCount: 0, recentMeaningful: [] };
}

export function foldEvents(events: Iterable<ActivityEvent>, initial: LiveState = emptyLiveState()): LiveState {
  let state = initial;
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

/** Apply one event; mutates and returns `state` for convenience. */
export function applyEvent(state: LiveState, event: ActivityEvent): LiveState {
  state.eventCount++;
  state.lastEventTs = event.ts;
  const actor = event.actor === "stage" ? state.stage : event.actor === "sparrer" ? state.sparrer : undefined;
  if (actor) {
    actor.lastEventTs = event.ts;
    if (event.provider) {
      actor.provider = event.provider;
    }
    if (event.session_id) {
      if (actor.sessionId !== undefined && actor.sessionId !== event.session_id) {
        actor.budget = undefined; // a different session starts a fresh context
      }
      actor.sessionId = event.session_id;
    }
    if (event.model) {
      actor.model = event.model;
    }
  }

  if (isMeaningfulActivity(event)) {
    const meaningful: MeaningfulEvent = { ts: event.ts, actor: event.actor, event: event.event, description: describeActivity(event) ?? event.event };
    state.lastMeaningful = meaningful;
    const previous = state.recentMeaningful[state.recentMeaningful.length - 1];
    if (previous && previous.actor === meaningful.actor && previous.description === meaningful.description) {
      state.recentMeaningful[state.recentMeaningful.length - 1] = meaningful; // same fact again: keep the latest time
    } else {
      state.recentMeaningful.push(meaningful);
      if (state.recentMeaningful.length > RECENT_MEANINGFUL_MAX) {
        state.recentMeaningful.splice(0, state.recentMeaningful.length - RECENT_MEANINGFUL_MAX);
      }
    }
  }

  if (event.event === "provider.usage" && actor) {
    const budget: ActorBudget = { ...(actor.budget ?? {}), ts: event.ts };
    const stated = (value: number | undefined) => (typeof value === "number" ? value : undefined);
    const merge = (key: keyof ActorBudget, value: number | undefined) => {
      if (value !== undefined) {
        (budget as Record<string, unknown>)[key] = value;
      }
    };
    merge("inputTokens", stated(event.input_tokens));
    merge("outputTokens", stated(event.output_tokens));
    merge("totalTokens", stated(event.total_tokens));
    merge("contextWindow", stated(event.context_window));
    merge("primaryPercent", stated(event.rate_limit_percent));
    merge("primaryWindowMinutes", stated(event.rate_limit_window_minutes));
    merge("secondaryPercent", stated(event.rate_limit_secondary_percent));
    merge("secondaryWindowMinutes", stated(event.rate_limit_secondary_window_minutes));
    actor.budget = budget;
  }

  switch (event.event) {
    case "turn.started":
      state.stage.busy = true;
      state.stage.busySince = event.ts;
      break;
    case "turn.finished":
    case "turn.failed":
    case "handoff.ready":
      idle(state.stage);
      break;
    case "sparring.started":
      state.sparrer.busy = true;
      state.sparrer.busySince = event.ts;
      break;
    case "sparring.failed":
      idle(state.sparrer);
      break;
    case "verdict":
      idle(state.sparrer);
      if (event.action) {
        state.lastVerdict = { action: event.action, summary: event.summary, ts: event.ts };
        if (event.action === "SEND_BACK") {
          state.sendBackCount++;
        }
      }
      break;
    case "file.changed":
      state.lastFileChanged = { path: event.path, actor: event.actor, ts: event.ts };
      break;
    default:
      break;
  }

  if (event.actor === "plan") {
    state.lastPlanEvent = { event: event.event, action: event.action, summary: event.summary, ts: event.ts };
    if (event.event === "plan.paused" || event.event === "plan.failed" || event.event === "plan.completed") {
      idle(state.stage);
      idle(state.sparrer);
    }
  } else if (event.actor === "gate") {
    state.lastGateEvent = { event: event.event, sha: event.sha, summary: event.summary, ts: event.ts };
  } else if (event.actor === "loop") {
    state.lastLoopEvent = { event: event.event, action: event.action, summary: event.summary, cycle: event.cycle, ts: event.ts };
    if (typeof event.cycle === "number") {
      state.currentCycle = event.cycle;
    }
    if (event.event === "loop.stopped" || event.event === "loop.runaway") {
      idle(state.stage);
      idle(state.sparrer);
    }
  }
  return state;
}

function idle(actor: ActorLive): void {
  actor.busy = false;
  actor.busySince = undefined;
}

/** Milliseconds an actor has been in its current turn, or undefined when not busy / unparseable. */
export function activeDurationMs(actor: ActorLive, nowMs: number): number | undefined {
  if (!actor.busy || !actor.busySince) {
    return undefined;
  }
  const since = Date.parse(actor.busySince);
  return Number.isFinite(since) ? Math.max(0, nowMs - since) : undefined;
}

/** `Xm Ys` / `Xh Ym` style duration for an active turn. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Display name for a provider id, falling back to the role. */
export function providerDisplayName(provider: string | undefined, role: "stage" | "sparrer"): string {
  switch (provider) {
    case "claude-cli":
      return "Claude";
    case "codex-cli":
      return "Codex";
    case undefined:
      return role === "stage" ? "Stage agent" : "Sparrer";
    default:
      return provider;
  }
}
