/**
 * A run as a generic "agent session" item: the shape VS Code's (proposed)
 * chat-sessions API lists — a label, a one-line description, a status, a
 * tooltip and timing — derived from {@link RunSummary} and nothing else.
 *
 * This is the whole interpretation an agent-sessions host gets. The adapter
 * that hands it to VS Code (vscode/agentSessionsAdapter.ts) only copies these
 * fields, so a host that later lists third-party sessions natively can adopt
 * the same mapping without a second reading of engine state.
 *
 * No dependency on the vscode API.
 */

import { formatWhen, stagePositionText, type RunSummary } from "./runSummary";

/** The generic session states; mirrors `ChatSessionStatus` without depending on it. */
export type AgentSessionState = "inProgress" | "needsInput" | "completed" | "failed";

export interface AgentSessionItemData {
  /** The discovery run id: the session's identity. */
  id: string;
  label: string;
  /** `Stage 2 of 5 · Reviewer` — position and who acts next. */
  description: string;
  /** What the run waits on, when it waits on a person. */
  badge?: string;
  state: AgentSessionState;
  /** Markdown. */
  tooltip: string;
  timing: { created: number; lastRequestEnded?: number };
}

/**
 * Engine phases as session states. A paused run is waiting for a person to
 * continue it, which is what `needsInput` means to a session list; the engine
 * records no failed state for a run, so `failed` is never produced.
 */
const STATES: Record<RunSummary["phase"], AgentSessionState> = {
  running: "inProgress",
  "needs-you": "needsInput",
  paused: "needsInput",
  open: "needsInput",
  complete: "completed",
};

export function agentSessionItem(summary: RunSummary, nowMs: number): AgentSessionItemData {
  const description = [stagePositionText(summary), summary.actor].filter(Boolean).join(" · ") || summary.statusWord;
  const lines = [
    `**${summary.title}**`,
    "",
    `${summary.statusWord}${summary.stage ? ` · ${stagePositionText(summary) ?? "Stage"} — ${summary.stage.name}` : ""}`,
    ...(summary.actor ? [`Next: ${summary.actor}`] : []),
    ...(summary.outcome ? [`Last review: ${summary.outcome.word}`] : []),
    ...(summary.gate ? [`Waiting on: ${summary.gate.text}`] : []),
    "",
    `Run \`${summary.runKey}\` · ${summary.repository.name} · updated ${formatWhen(summary.updatedAtMs, nowMs)}`,
  ];
  return {
    id: summary.id,
    label: summary.title,
    description,
    ...(summary.gate && STATES[summary.phase] === "needsInput" ? { badge: summary.gate.text } : {}),
    state: STATES[summary.phase],
    tooltip: lines.join("  \n"),
    timing: { created: summary.updatedAtMs, ...(summary.phase === "running" ? {} : { lastRequestEnded: summary.updatedAtMs }) },
  };
}
