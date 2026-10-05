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
  /** The provider-unavailable recovery: the new conversation must run on a different provider. */
  otherProvider?: boolean;
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
export function freshSessionOffers(runStatus: string, stage: StageState | undefined | null, pause?: ProviderPause, currentStageId?: string): FreshSessionOffer[] {
  if (runStatus !== "paused" || !stage || stage.status === "accepted" || stage.sessions === null || freshRefusedByPause(pause, currentStageId)) {
    return [];
  }
  return [freshOffer("sparring"), freshOffer("stage")];
}

/**
 * The engine recorded a pause for this stage with no session to replace
 * (`has_session: false`): only a retry is offered, anywhere on screen.
 */
export function freshRefusedByPause(pause: ProviderPause | undefined, currentStageId: string | undefined): boolean {
  return pause !== undefined && pause.stageId === currentStageId && !pause.hasSession;
}

/**
 * The provider-pause card for the current stage, or undefined when none is
 * recorded for it. Shown only while the engine reports the run paused: a
 * leftover record on a complete or failed run is not a pause to recover.
 */
export function providerPauseCard(pause: ProviderPause | undefined, runStatus: string, currentStageId: string, offersFresh: boolean): ProviderPauseCard | undefined {
  if (!pause || runStatus !== "paused" || pause.stageId !== currentStageId) {
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
    fresh: fresh ? { role: fresh.role, label: `${fresh.label} with another model/provider`, otherProvider: true } : undefined,
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

/** One provider a role could use, as `show-config` enumerates it. */
export interface ProviderOption {
  provider: string;
  label: string;
}

/**
 * The quick-pick entry for not keeping the current preference. The engine
 * enumerates the providers a role supports; with only one there is only a
 * model to choose.
 */
export function otherAgentLabel(providerCount: number): string {
  return providerCount > 1 ? "Choose another model/provider\u2026" : "Choose another model\u2026";
}

/** What the person chose for the new conversation. */
export type FreshChoice = { provider?: string; model?: string; effort?: string };

/**
 * The editor surface the fresh-session flow asks through. Every method
 * returns undefined when the person cancels, and the flow then does nothing.
 */
export interface FreshSessionUi {
  /** What the role resolves to with these role-scoped overrides (`show-config`). */
  resolve(overrides: FreshChoice): Promise<ResolvedAgent | undefined>;
  /** `true` to keep the current preference, `false` to choose; undefined on cancel. */
  pickCurrentOrOther(current: ResolvedAgent): Promise<boolean | undefined>;
  /** Choose provider (from `providers`), model and effort; undefined on cancel. */
  chooseAgent(providers: readonly ProviderOption[], requireProvider: boolean): Promise<FreshChoice | undefined>;
  /** The role's current provider id and the providers the engine offers it. */
  providers(): Promise<{ current: string; options: ProviderOption[] } | undefined>;
  confirm(message: string, detail: string, confirmLabel: string): Promise<boolean>;
  /** Tell the person why nothing is offered. */
  notify(text: string): void;
}

/**
 * Ask for the fresh conversation's configuration and its confirmation.
 *
 * The result is the request to put on `resume-plan`, or undefined when the
 * person cancelled or nothing can be offered. `otherProvider` is the
 * provider-unavailable recovery: the current preference is not offered.
 * Where the engine reports another provider for the role, the current one
 * is not listed and the chosen provider is always passed as an override;
 * where the role has only its current provider, a different model on it
 * must be chosen. Only providers the engine lists for the role are offered.
 */
export async function askFreshSession(role: SessionRole, otherProvider: boolean, ui: FreshSessionUi): Promise<FreshChoice | undefined> {
  let choice: FreshChoice = {};
  if (otherProvider) {
    const known = await ui.providers();
    if (!known) {
      return undefined;
    }
    const others = known.options.filter((option) => option.provider !== known.current);
    if (others.length > 0) {
      const chosen = await ui.chooseAgent(others, true);
      if (!chosen?.provider || chosen.provider === known.current) {
        return undefined;
      }
      choice = chosen;
    } else {
      const current = await ui.resolve({});
      const own = known.options.filter((option) => option.provider === known.current);
      if (!current || own.length === 0) {
        return undefined;
      }
      const chosen = await ui.chooseAgent(own, false);
      if (!chosen) {
        return undefined;
      }
      if (!chosen.model || chosen.model === current.model) {
        ui.notify(`The ${roleNoun(role)} has no other provider; choose a different model to start it on.`);
        return undefined;
      }
      // The current provider needs no override: the engine resolves it anyway.
      choice = { model: chosen.model, effort: chosen.effort };
    }
  } else {
    const current = await ui.resolve({});
    if (!current) {
      return undefined;
    }
    const keep = await ui.pickCurrentOrOther(current);
    if (keep === undefined) {
      return undefined;
    }
    if (!keep) {
      const known = await ui.providers();
      if (!known) {
        return undefined;
      }
      const chosen = await ui.chooseAgent(known.options, false);
      if (!chosen) {
        return undefined;
      }
      // The current provider needs no override: the engine resolves it anyway.
      choice = { ...chosen, provider: chosen.provider === known.current ? undefined : chosen.provider };
    }
  }
  const agent = await ui.resolve(choice);
  if (!agent) {
    return undefined;
  }
  const confirmation = freshSessionConfirmation(role, agent);
  const label = `Start fresh ${roleNoun(role)}`;
  return (await ui.confirm(confirmation.message, confirmation.detail, label)) ? choice : undefined;
}
