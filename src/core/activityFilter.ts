/**
 * What counts as visible activity, shared by the Output Channel renderer and
 * the Run Overview so the two never disagree.
 *
 * Only semantic facts the engine already chose to record are described; the
 * engine's redaction (no prompts, reasoning, tool output, command text) is
 * preserved by construction because those fields do not exist. Noisy
 * per-tool-call events, successful command completions and the engine's own
 * writes under `.sparring/` are not activity worth showing.
 *
 * No dependency on the vscode API.
 */

import type { ActivityEvent } from "./engineFormats";

export function shortId(id: string | undefined, length = 4): string | undefined {
  if (!id) {
    return undefined;
  }
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

/**
 * True when the event would earn a line in the Output Channel (before the
 * renderer's stateless-independent collapse of repeated edits of one file).
 */
export function isMeaningfulActivity(event: ActivityEvent): boolean {
  if (event.event === "file.changed") {
    return !(event.path && (event.path === ".sparring" || event.path.startsWith(".sparring/")));
  }
  if (event.event === "command.finished" && (typeof event.exit_code !== "number" || event.exit_code === 0)) {
    return false;
  }
  return describeActivity(event) !== undefined;
}

/** Short message for an event, or undefined when it is not worth a line. */
export function describeActivity(event: ActivityEvent): string | undefined {
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
