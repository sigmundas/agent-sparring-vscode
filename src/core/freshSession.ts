/**
 * Start one role's conversation afresh, as the Overview offers it.
 *
 * The engine owns all of it: `resume-plan --fresh-sparrer` /
 * `--fresh-stage-agent` replaces a conversation, the engine still decides
 * which actor runs next, and `sessions` / `provider_pause` are only ever
 * read here. Nothing in this module writes a file or infers a reason from
 * activity, output or prose.
 */

import type { ProviderPause, SessionRole, StageSession, StageState } from "./engineFormats";

/** One role a fresh conversation may be started for. */
export interface FreshSessionOffer {
  role: SessionRole;
  /** `Start fresh reviewer…` / `Start fresh implementation agent…`. */
  label: string;
}

/** The card shown when the engine recorded a provider pause for the current stage. */
export interface ProviderPauseCard {
  kind: ProviderPause["kind"];
  role: SessionRole;
  title: string;
  detail: string;
  /** Plain `resume-plan`, offered for an unavailable provider. */
  retry: boolean;
  /** Absent when the role has no session to replace (`has_session: false`). */
  fresh?: FreshSessionOffer;
}

/** The person-facing name of a role's conversation partner. */
export function roleNoun(role: SessionRole): string {
  return role === "sparring" ? "reviewer" : "implementation agent";
}

export function freshOffer(role: SessionRole, ellipsis = true): FreshSessionOffer {
  return { role, label: `Start fresh ${roleNoun(role)}${ellipsis ? "…" : ""}` };
}

/**
 * Both fresh actions, or none.
 *
 * Offered only for a paused run whose stage the engine has a session
 * history for: an engine that records no `sessions` cannot take the flags,
 * and an accepted stage has no conversation left to replace.
 */
export function freshSessionOffers(runStatus: string, stage: StageState | undefined | null): FreshSessionOffer[] {
  if (runStatus !== "paused" || !stage || stage.status === "accepted" || stage.sessions === null) {
    return [];
  }
  return [freshOffer("sparring"), freshOffer("stage")];
}

/** The provider-pause card for the current stage, or undefined when none is recorded for it. */
export function providerPauseCard(pause: ProviderPause | undefined, currentStageId: string, offersFresh: boolean): ProviderPauseCard | undefined {
  if (!pause || pause.stageId !== currentStageId) {
    return undefined;
  }
  const fresh = pause.hasSession && offersFresh ? freshOffer(pause.role, false) : undefined;
  if (pause.kind === "session-unresumable") {
    return {
      kind: pause.kind,
      role: pause.role,
      title: `${pause.role === "sparring" ? "Reviewer" : "Implementation-agent"} session cannot be resumed`,
      detail: "The candidate is safe and unchanged.",
      // Nothing to retry: the engine already found this conversation cannot
      // continue. Without a session to replace, a retry is all there is.
      retry: !fresh,
      fresh,
    };
  }
  return {
    kind: pause.kind,
    role: pause.role,
    title: "Provider unavailable (quota / rate limit)",
    detail: "The candidate is safe and unchanged.",
    retry: true,
    fresh: fresh ? { role: fresh.role, label: `${fresh.label} on another provider` } : undefined,
  };
}

/** `generation 2 · fresh: <reason>` for the role's current conversation, when it is not the first. */
export function generationLabel(sessions: Record<string, StageSession[]> | null | undefined, role: SessionRole): string | undefined {
  const list = sessions?.[role];
  if (!list || list.length === 0) {
    return undefined;
  }
  const current = list.reduce((latest, entry) => (entry.generation > latest.generation ? entry : latest));
  if (current.generation <= 1) {
    return undefined;
  }
  return current.startReason ? `generation ${current.generation} · fresh: ${current.startReason}` : `generation ${current.generation}`;
}

/** What the role would run with, as the engine resolved it. */
export interface ResolvedAgent {
  provider: string;
  model: string | null;
  effort: string | null;
}

export function describeAgent(agent: ResolvedAgent): string {
  return `${agent.provider} · ${agent.model ?? "provider default"} · ${agent.effort ?? "provider default"}`;
}

/** The modal confirmation, stated plainly. */
export function freshSessionConfirmation(role: SessionRole, agent: ResolvedAgent): { message: string; detail: string } {
  return {
    message: `Start a fresh ${roleNoun(role)}?`,
    detail: [
      "Same stage and candidate.",
      `New ${roleNoun(role)} conversation.`,
      "Previous review history preserved.",
      `Provider: ${agent.provider}`,
      `Model: ${agent.model ?? "provider default"}`,
      `Effort: ${agent.effort ?? "provider default"}`,
    ].join("\n"),
  };
}
