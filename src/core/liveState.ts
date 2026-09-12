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

import type { ActivityEvent } from "./engineFormats";

export interface ActorLive {
  provider?: string;
  sessionId?: string;
  model?: string;
  /** A turn started and has not yet finished/failed (as far as telemetry says). */
  busy: boolean;
  lastEventTs?: string;
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
  lastEventTs?: string;
  eventCount: number;
  sendBackCount: number;
}

export function emptyLiveState(): LiveState {
  return { stage: { busy: false }, sparrer: { busy: false }, eventCount: 0, sendBackCount: 0 };
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
      actor.sessionId = event.session_id;
    }
    if (event.model) {
      actor.model = event.model;
    }
  }

  switch (event.event) {
    case "turn.started":
      state.stage.busy = true;
      break;
    case "turn.finished":
    case "turn.failed":
    case "handoff.ready":
      state.stage.busy = false;
      break;
    case "sparring.started":
      state.sparrer.busy = true;
      break;
    case "sparring.failed":
      state.sparrer.busy = false;
      break;
    case "verdict":
      state.sparrer.busy = false;
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
      state.stage.busy = false;
      state.sparrer.busy = false;
    }
  } else if (event.actor === "gate") {
    state.lastGateEvent = { event: event.event, sha: event.sha, summary: event.summary, ts: event.ts };
  } else if (event.actor === "loop") {
    state.lastLoopEvent = { event: event.event, action: event.action, summary: event.summary, cycle: event.cycle, ts: event.ts };
    if (event.event === "loop.stopped" || event.event === "loop.runaway") {
      state.stage.busy = false;
      state.sparrer.busy = false;
    }
  }
  return state;
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

export function shortId(id: string | undefined, length = 4): string | undefined {
  if (!id) {
    return undefined;
  }
  return id.length > length ? `${id.slice(0, length)}…` : id;
}
