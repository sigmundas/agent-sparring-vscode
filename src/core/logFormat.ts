/**
 * Terse, one-line rendering of activity events for the Output Channel.
 *
 * Only semantic facts the engine already chose to record are shown; the
 * engine's redaction (no prompts, reasoning, tool output, command text) is
 * preserved by construction because those fields do not exist. Noisy
 * per-tool-call events are dropped entirely.
 *
 * No dependency on the vscode API.
 */

import type { ActivityEvent } from "./engineFormats";
import { providerDisplayName, shortId } from "./liveState";

const LABEL_WIDTH = 15;

/** Events translated from a provider's own stream (labelled `Claude/stage`). */
const PROVIDER_EVENTS = new Set([
  "session.observed",
  "tool.call",
  "file.changed",
  "command.started",
  "command.finished",
  "subagent.started",
  "provider.result",
  "provider.error",
  "turn.started",
  "turn.finished",
  "turn.failed",
  "sparring.started",
  "sparring.failed",
]);

/** Returns the formatted line, or undefined when the event is not worth a line. */
export function formatEvent(event: ActivityEvent): string | undefined {
  const message = describe(event);
  if (message === undefined) {
    return undefined;
  }
  return `${formatTime(event.ts)}  ${labelFor(event).padEnd(LABEL_WIDTH)} ${message}`;
}

export function formatTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function labelFor(event: ActivityEvent): string {
  const actor = event.actor;
  if ((actor === "stage" || actor === "sparrer") && PROVIDER_EVENTS.has(event.event)) {
    return `${providerDisplayName(event.provider, actor)}/${actor}`;
  }
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function describe(event: ActivityEvent): string | undefined {
  const summary = event.summary ? `: ${event.summary}` : "";
  switch (event.event) {
    // stage orchestration
    case "turn.started":
      return event.resumed ? "turn resumed" : "turn started";
    case "turn.finished":
      return event.summary ? `turn finished (${event.summary})` : "turn finished";
    case "turn.failed":
      return `turn failed${summary}`;
    case "handoff.ready":
      return "handoff ready";
    // sparring orchestration
    case "sparring.started":
      return event.resumed ? "resumed" : "started";
    case "sparring.failed":
      return `failed${summary}`;
    case "verdict":
      return event.action ? `${event.action}${event.summary ? ` — ${event.summary}` : ""}` : "verdict";
    // provider-translated
    case "session.observed": {
      const parts = ["session"];
      const id = shortId(event.session_id, 8);
      if (id) {
        parts.push(id);
      }
      if (event.model) {
        parts.push(`(${event.model})`);
      }
      return parts.join(" ");
    }
    case "file.changed": {
      const verb = event.kind === "add" ? "added" : event.kind === "delete" ? "deleted" : "changed";
      return `${verb} ${event.path ?? "(file outside repo)"}`;
    }
    case "command.started":
      return undefined; // finished carries the useful fact
    case "command.finished":
      return typeof event.exit_code === "number" && event.exit_code !== 0 ? `command exited ${event.exit_code}` : "command finished";
    case "subagent.started":
      return "subagent started";
    case "tool.call":
      return undefined;
    case "provider.result":
      return undefined;
    case "provider.error":
      return "provider error";
    // loop
    case "loop.started":
      return "loop started";
    case "loop.send_back":
      return `SEND_BACK · cycle ${event.cycle ?? "?"} resumes both sessions`;
    case "loop.stopped":
      return event.action ? `stopped (${event.action})` : `stopped${summary}`;
    case "loop.runaway":
      return `runaway limit reached (cycle ${event.cycle ?? "?"})`;
    // gate
    case "candidate.frozen":
      return `frozen ${shortId(event.sha, 8) ?? ""}`.trim();
    case "candidate.accepted":
      return `accepted ${shortId(event.sha, 8) ?? ""}`.trim();
    case "gate.refused":
      return `refused${summary}`;
    // plan
    case "plan.stage.entered":
      return `entered${summary.replace(":", "")}`;
    case "plan.stage.accepted":
      return `stage accepted ${shortId(event.sha, 8) ?? ""}`.trim();
    case "plan.paused":
      return `paused${event.action ? ` (${event.action})` : ""}`;
    case "plan.failed":
      return `failed${summary}`;
    case "plan.completed":
      return `complete${summary}`;
    case "plan.evidence_recorded":
      return "human evidence recorded";
    default:
      return `${event.event}${summary}`;
  }
}
