/**
 * Shared view model for the Run Overview. Built from the same inputs the
 * status bar uses (discovery selection + activity fold), so the two surfaces
 * cannot drift semantically. Pure: no vscode API, no filesystem access; the
 * caller supplies which stage artifacts exist.
 *
 * Authoritative facts (plan status, stage status, timeline, routing outcome,
 * session ids, SHAs) come from plan-run state, state.json and sparring.md.
 * Only the actor "Working / Sparring / Waiting" words and the last-activity
 * age come from the observational activity fold.
 */

import { currentStageOf, runLabel, type PlanRunSnapshot, type RunSelection, type RunSnapshot, type StageSnapshot } from "./discovery";
import { providerDisplayName, type LiveState } from "./liveState";
import { QUIET_AFTER_MS, formatAge } from "./status";

export type TimelineState = "accepted" | "frozen" | "active" | "paused" | "working" | "future";

export interface TimelineItem {
  number: number;
  title: string;
  state: TimelineState;
  current: boolean;
}

export type ActorActivity = "Working" | "Sparring" | "Waiting" | "Idle";

export interface ActorCard {
  role: "Stage agent" | "Sparrer";
  provider: string;
  activity: ActorActivity;
  /** Persisted session/thread id, shortened for display. */
  sessionLabel?: string;
  sessionKind: "session" | "thread";
  /** Set when a busy claim has gone quiet for a long time. */
  quietFor?: string;
}

export interface Banner {
  kind: "stop" | "done" | "warn";
  text: string;
}

export interface OverviewArtifacts {
  handoff: boolean;
  sparring: boolean;
  brief: boolean;
  plan: boolean;
}

export interface OverviewActions {
  handoff: boolean;
  sparring: boolean;
  brief: boolean;
  plan: boolean;
  /** Present when base_sha is recorded; label says what the diff spans. */
  diff?: { label: string; baseSha: string; targetSha?: string };
}

export interface OverviewModel {
  kind: "empty" | "ambiguous" | "run";
  title: string;
  /** For ambiguous: the candidate labels. */
  choices?: string[];
  timeline?: TimelineItem[];
  timelineNote?: string;
  stageAgent?: ActorCard;
  sparrer?: ActorCard;
  stageHeading?: string;
  stageStatus?: string;
  stageLine?: string;
  banner?: Banner;
  lastSparring?: { action: string; summary: string; reason?: string };
  actions?: OverviewActions;
  facts?: { label: string; value: string }[];
}

const NO_ARTIFACTS: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };

export function buildOverviewModel(
  selection: RunSelection,
  live: LiveState | undefined,
  artifacts: OverviewArtifacts = NO_ARTIFACTS,
  nowMs: number = Date.now(),
): OverviewModel {
  if (!selection.selected) {
    if (selection.ambiguous.length > 0) {
      return { kind: "ambiguous", title: "Several runs look active", choices: selection.ambiguous.map(runLabel) };
    }
    return { kind: "empty", title: "No active run" };
  }
  const run = selection.selected;
  const stage = currentStageOf(run);
  const halted = isHalted(run);

  const model: OverviewModel = {
    kind: "run",
    title: runLabel(run),
    stageAgent: actorCard("stage", stage, live, halted, nowMs),
    sparrer: actorCard("sparrer", stage, live, halted, nowMs),
    actions: {
      handoff: artifacts.handoff,
      sparring: artifacts.sparring,
      brief: artifacts.brief,
      plan: run.kind === "plan" && artifacts.plan,
      diff: diffAction(stage),
    },
    facts: facts(run, stage, live, nowMs),
  };

  if (run.kind === "plan") {
    Object.assign(model, timeline(run));
    model.stageHeading = stage.number && stage.title ? `Stage ${stage.number} — ${stage.title}` : `Stage ${run.state.currentStageIndex + 1} · ${stage.stageId}`;
  } else {
    model.stageHeading = stage.stageId;
  }
  model.stageStatus = stage.state?.status ?? (stage.exists ? "working" : "not created");

  const outcome = run.kind === "plan" ? run.currentOutcome : run.outcome;
  if (outcome) {
    model.lastSparring = { action: outcome.action, summary: outcome.summary, reason: outcome.needsYouReason };
  }
  Object.assign(model, currentLine(run, stage, live));
  return model;
}

// ---------------------------------------------------------------- pieces

function isHalted(run: RunSnapshot): boolean {
  if (run.kind === "plan") {
    return run.state.status !== "running";
  }
  return run.stage.state?.status === "accepted";
}

function actorCard(role: "stage" | "sparrer", stage: StageSnapshot, live: LiveState | undefined, halted: boolean, nowMs: number): ActorCard {
  const actor = live?.[role];
  const persisted = role === "stage" ? stage.state?.implementationSessionId : stage.state?.sparringSessionId;
  const sessionId = persisted ?? actor?.sessionId ?? undefined;
  let activity: ActorActivity = halted ? "Idle" : "Waiting";
  let quietFor: string | undefined;
  if (!halted && actor?.busy) {
    activity = role === "stage" ? "Working" : "Sparring";
    const age = actor.lastEventTs ? nowMs - Date.parse(actor.lastEventTs) : NaN;
    if (Number.isFinite(age) && age > QUIET_AFTER_MS) {
      quietFor = formatAge(age);
    }
  }
  return {
    role: role === "stage" ? "Stage agent" : "Sparrer",
    provider: providerDisplayName(actor?.provider ?? (role === "stage" ? "claude-cli" : "codex-cli"), role),
    activity,
    sessionLabel: shortenId(sessionId),
    sessionKind: role === "stage" ? "session" : "thread",
    quietFor,
  };
}

export function shortenId(id: string | undefined | null, keep = 8): string | undefined {
  if (!id) {
    return undefined;
  }
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > keep ? `${trimmed.slice(0, keep)}…` : trimmed;
}

function timeline(run: PlanRunSnapshot): Pick<OverviewModel, "timeline" | "timelineNote"> {
  if (!run.planStages || run.planStages.length === 0) {
    return { timelineNote: `Plan document unavailable (${run.planError ?? "no stages"}); showing the recorded stage only.` };
  }
  const current = run.state.currentStageIndex;
  const items: TimelineItem[] = run.stages.map((stage, index) => ({
    number: stage.number ?? index + 1,
    title: stage.title ?? stage.stageId,
    current: index === current,
    state: timelineState(stage, index, current, run),
  }));
  return { timeline: items };
}

function timelineState(stage: StageSnapshot, index: number, current: number, run: PlanRunSnapshot): TimelineState {
  const status = stage.state?.status;
  if (status === "accepted") {
    return "accepted";
  }
  if (status === "frozen") {
    return "frozen";
  }
  if (index === current) {
    return run.state.status === "paused" ? "paused" : "active";
  }
  return index < current ? "working" : "future";
}

function currentLine(run: RunSnapshot, stage: StageSnapshot, live: LiveState | undefined): Pick<OverviewModel, "stageLine" | "banner"> {
  const outcome = run.kind === "plan" ? run.currentOutcome : run.outcome;
  const stageStatus = stage.state?.status;

  if (run.kind === "plan") {
    if (run.state.status === "complete") {
      const total = run.planStages?.length;
      return { stageLine: "All stages accepted.", banner: { kind: "done", text: `Plan complete${total ? ` — ${total} stage${total === 1 ? "" : "s"} accepted` : ""}` } };
    }
    if (run.state.status === "paused") {
      if (outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE") {
        const detail = outcome.summary ? ` — ${outcome.summary}` : "";
        return {
          stageLine: outcome.action === "NEEDS_YOU" ? "Waiting for you. Resume the plan with your answer or check result." : "Sparring escalated. Spar this stage elsewhere, then resume.",
          banner: { kind: "stop", text: `${outcome.action}${detail}` },
        };
      }
      const failure = live?.lastPlanEvent?.event === "plan.failed" ? live.lastPlanEvent.summary : undefined;
      return {
        stageLine: "The run stopped. Check the log and terminal, then resume the plan.",
        banner: { kind: "warn", text: `Paused${failure ? ` — ${failure}` : ""}` },
      };
    }
  } else if (stageStatus === "accepted") {
    return { stageLine: "Candidate accepted.", banner: { kind: "done", text: "Stage accepted" } };
  } else if (outcome?.action === "NEEDS_YOU" || outcome?.action === "ESCALATE") {
    if (!(live?.stage.busy || live?.sparrer.busy)) {
      return { stageLine: outcome.action === "NEEDS_YOU" ? "Waiting for you." : "Sparring escalated.", banner: { kind: "stop", text: `${outcome.action}${outcome.summary ? ` — ${outcome.summary}` : ""}` } };
    }
  }

  // running / working
  if (stageStatus === "frozen") {
    return { stageLine: "Candidate frozen; awaiting acceptance." };
  }
  if (stageStatus === "accepted") {
    return { stageLine: "Accepted; advancing to the next stage." };
  }
  if (live?.sparrer.busy) {
    return { stageLine: "Under sparring." };
  }
  if (outcome?.action === "SEND_BACK") {
    return { stageLine: "Correcting SEND_BACK finding" };
  }
  if (outcome?.action === "READY") {
    return { stageLine: "Sparrer said READY; acceptance pending." };
  }
  if (live?.stage.busy) {
    return { stageLine: "Implementing." };
  }
  return { stageLine: stage.exists ? "Working." : "Not started yet." };
}

function diffAction(stage: StageSnapshot): OverviewActions["diff"] {
  const base = stage.state?.baseSha;
  if (!base) {
    return undefined;
  }
  const target = stage.state?.candidateSha ?? undefined;
  return {
    label: target ? `Open diff ${shortenId(base)} … ${shortenId(target)}` : `Open diff ${shortenId(base)} … HEAD`,
    baseSha: base,
    targetSha: target,
  };
}

function facts(run: RunSnapshot, stage: StageSnapshot, live: LiveState | undefined, nowMs: number): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (run.kind === "plan") {
    out.push({ label: "Plan", value: run.state.status });
    out.push({ label: "Branch", value: run.state.expectedBranch });
  } else {
    out.push({ label: "Stage", value: stage.state?.status ?? "working" });
  }
  if (stage.state?.candidateSha) {
    out.push({ label: "Candidate", value: shortenId(stage.state.candidateSha) ?? "" });
  }
  if (live?.lastEventTs) {
    out.push({ label: "Last activity", value: `${formatAge(nowMs - Date.parse(live.lastEventTs))} ago` });
  } else {
    out.push({ label: "Last activity", value: "no telemetry" });
  }
  return out;
}
