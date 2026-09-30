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
  /**
   * How full the window is right now: the tokens the model was holding
   * on its latest request, the cached prompt included. A different fact
   * from `totalTokens`, which only grows — every request re-sends the
   * conversation, so a session's cumulative total passes the window
   * several times over and is a share of nothing.
   */
  contextUsed?: number;
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
  /**
   * At least one shell command this actor started has not yet reported
   * finishing (see `openCommands`). The one concrete fact telemetry offers
   * about what a busy actor is doing right now, and demonstrable activity
   * in its own right: a long command with no other event in between must
   * never be presented as "no meaningful activity" while this is true.
   * Derived from `openCommands`; never set on its own.
   */
  commandBusy?: boolean;
  /** When the oldest still-running command started, while `commandBusy`. */
  commandSince?: string;
  /**
   * Every command started and not yet reported finished, oldest first.
   * The Claude CLI names each by the provider's `tool_use_id`, and parallel
   * calls finish in any order, so a finish removes exactly the command it
   * names. Codex events carry no id; those are counted, one finish per
   * start. A finish that matches nothing changes nothing.
   */
  openCommands?: { id?: string; ts: string }[];
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
   * When an actor last reported using a tool (a tool call, a subagent
   * starting, a command starting or finishing, a file edit), whether or not
   * it earned an Output line. A tool in use is activity: a subagent that
   * only reads files emits nothing but tool calls, and must not read as a
   * silent turn. See {@link quietSince}.
   */
  lastToolTs?: string;
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
    merge("contextUsed", stated(event.context_used_tokens));
    merge("contextWindow", stated(event.context_window));
    merge("primaryPercent", stated(event.rate_limit_percent));
    merge("primaryWindowMinutes", stated(event.rate_limit_window_minutes));
    merge("secondaryPercent", stated(event.rate_limit_secondary_percent));
    merge("secondaryWindowMinutes", stated(event.rate_limit_secondary_window_minutes));
    actor.budget = budget;
  }

  if (actor && TOOL_EVENTS.has(event.event)) {
    state.lastToolTs = event.ts;
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
    case "command.started":
      if (actor) {
        (actor.openCommands ??= []).push({ id: event.tool_use_id, ts: event.ts });
        syncCommand(actor);
      }
      break;
    case "command.finished":
      if (actor?.openCommands) {
        const at = actor.openCommands.findIndex((open) => open.id === event.tool_use_id);
        if (at >= 0) {
          actor.openCommands.splice(at, 1);
        }
        syncCommand(actor);
      }
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
  actor.openCommands = undefined;
  syncCommand(actor);
}

function syncCommand(actor: ActorLive): void {
  const open = actor.openCommands ?? [];
  actor.commandBusy = open.length > 0;
  actor.commandSince = open[0]?.ts;
}

/** Events that say an actor is using a tool right now (see `lastToolTs`). */
const TOOL_EVENTS = new Set(["tool.call", "subagent.started", "command.started", "command.finished", "file.changed"]);

/**
 * The moment a busy turn's silence is measured from: the later of the last
 * Output-worthy event and the last tool use. Hidden bookkeeping (usage
 * dials, session notices) still does not make a turn look lively, but a
 * tool in use does. `fallback` is used when neither has happened.
 */
export function quietSince(live: LiveState, fallback?: string): string | undefined {
  const candidates = [live.lastMeaningful?.ts, live.lastToolTs].filter((ts): ts is string => typeof ts === "string" && Number.isFinite(Date.parse(ts)));
  if (candidates.length === 0) {
    return fallback;
  }
  return candidates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** Whether either actor has a command running, which is never silence. */
export function commandInFlight(live: LiveState | undefined): boolean {
  return Boolean(live?.stage.commandBusy || live?.sparrer.commandBusy);
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
