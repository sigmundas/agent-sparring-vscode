/**
 * Shared view model for the Run Overview. Built from the same inputs the
 * status bar uses (discovery selection + activity fold), so the two surfaces
 * cannot drift semantically. Pure: no vscode API, no filesystem access; the
 * caller supplies which stage artifacts exist and the brief text.
 *
 * Authoritative facts (plan status, stage status, journey, routing outcome,
 * session ids, SHAs) come from plan-run state, state.json and sparring.md.
 * Only the actor "Working / Sparring / Waiting" words, active durations, the
 * loop cycle and the last visible event come from the observational
 * activity fold. The Goal is display-only text from brief.md.
 */

import { parseBriefGoal } from "./brief";
import { currentStageOf, runLabel, type PlanRunSnapshot, type RunSelection, type RunSnapshot, type StageSnapshot } from "./discovery";
import { activeDurationMs, formatDuration, providerDisplayName, type LiveState } from "./liveState";
import { formatTime } from "./logFormat";
import { presentStage, stageDisplayName } from "./presentation";
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
  /** `Xm Ys` since the latest turn start/resume, while active. */
  duration?: string;
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

/**
 * Replaces the old "Last activity Ns ago": while a provider turn is active,
 * how long it has been running; otherwise the last event that the Output
 * Channel would have shown (same filter), never suppressed noise.
 */
export interface ActivityLine {
  kind: "active" | "last" | "none";
  text: string;
  /** Time of day of the last visible event (kind `last`). */
  time?: string;
}

export interface OverviewArtifacts {
  handoff: boolean;
  sparring: boolean;
  brief: boolean;
  plan: boolean;
  /** Contents of brief.md when it exists; only the Goal paragraph is displayed. */
  briefText?: string;
}

export interface OverviewActions {
  handoff: boolean;
  sparring: boolean;
  brief: boolean;
  plan: boolean;
  /** Present when base_sha is recorded; `detail` (for a tooltip) says what the diff spans. */
  diff?: { label: string; detail: string; baseSha: string; targetSha?: string };
}

export interface OverviewModel {
  kind: "empty" | "ambiguous" | "run";
  title: string;
  /** For ambiguous: the candidate labels. */
  choices?: string[];
  /** Plan journey: only for plan runs with a readable plan document. */
  timeline?: TimelineItem[];
  timelineNote?: string;
  /** `Stage 2 of 5` for plan runs. */
  position?: string;
  stageAgent?: ActorCard;
  sparrer?: ActorCard;
  stageHeading?: string;
  /** Raw engine stage id, for secondary metadata / tooltips only. */
  stageId?: string;
  /** Derived presentation label, e.g. `READY · awaiting acceptance`. */
  stageStatus?: string;
  stageStatusKind?: string;
  stageLine?: string;
  /** Current loop cycle when telemetry has reported one. */
  cycle?: number;
  goal?: string;
  activity?: ActivityLine;
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
      return { kind: "ambiguous", title: "Several runs look active", choices: selection.ambiguous.map((run) => `${run.location.folderName}: ${runLabel(run)}`) };
    }
    return { kind: "empty", title: "No active run" };
  }
  const run = selection.selected;
  const stage = currentStageOf(run);
  const halted = isHalted(run);

  const model: OverviewModel = {
    kind: "run",
    title: run.kind === "plan" ? runLabel(run) : stageDisplayName(stage),
    stageAgent: actorCard("stage", stage, live, halted, nowMs),
    sparrer: actorCard("sparrer", stage, live, halted, nowMs),
    actions: {
      handoff: artifacts.handoff,
      sparring: artifacts.sparring,
      brief: artifacts.brief,
      plan: run.kind === "plan" && artifacts.plan,
      diff: diffAction(stage),
    },
    facts: facts(run, stage),
    goal: artifacts.brief ? parseBriefGoal(artifacts.briefText) : undefined,
    activity: activityLine(live, halted, nowMs),
  };

  const outcome = run.kind === "plan" ? run.currentOutcome : run.outcome;
  if (run.kind === "plan") {
    Object.assign(model, timeline(run));
    const number = stage.number ?? run.state.currentStageIndex + 1;
    model.stageHeading = `Stage ${number} — ${stageDisplayName(stage)}`;
    const total = run.planStages?.length;
    model.position = total ? `Stage ${number} of ${total}` : `Stage ${number}`;
  } else {
    model.stageHeading = stageDisplayName(stage);
  }
  model.stageId = stage.stageId;
  if (!stage.exists) {
    model.stageStatus = "not created";
    model.stageStatusKind = "future";
  } else {
    const presentation = presentStage(stage.state?.status, outcome, live);
    model.stageStatus = presentation.label;
    model.stageStatusKind = presentation.kind;
  }
  if (!halted && live?.currentCycle !== undefined) {
    model.cycle = live.currentCycle;
  }

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
  let duration: string | undefined;
  if (!halted && actor?.busy) {
    activity = role === "stage" ? "Working" : "Sparring";
    const active = activeDurationMs(actor, nowMs);
    duration = active === undefined ? undefined : formatDuration(active);
    const age = actor.lastEventTs ? nowMs - Date.parse(actor.lastEventTs) : NaN;
    if (Number.isFinite(age) && age > QUIET_AFTER_MS) {
      quietFor = formatAge(age);
    }
  }
  return {
    role: role === "stage" ? "Stage agent" : "Sparrer",
    provider: providerDisplayName(actor?.provider ?? (role === "stage" ? "claude-cli" : "codex-cli"), role),
    activity,
    duration,
    sessionLabel: shortenId(sessionId),
    sessionKind: role === "stage" ? "session" : "thread",
    quietFor,
  };
}

/**
 * The single activity line under the current stage. The sparrer's turn
 * takes precedence over the stage agent's when both look busy (a SEND_BACK
 * cycle resumes both; sparring is the later phase).
 */
export function activityLine(live: LiveState | undefined, halted: boolean, nowMs: number): ActivityLine {
  if (!halted && live) {
    for (const role of ["sparrer", "stage"] as const) {
      const actor = live[role];
      const active = activeDurationMs(actor, nowMs);
      if (actor.busy && active !== undefined) {
        const verb = role === "stage" ? "Working" : "Sparring";
        return { kind: "active", text: `${verb} for ${formatDuration(active)} · ${providerDisplayName(actor.provider, role)}` };
      }
    }
  }
  if (live?.lastMeaningful) {
    const last = live.lastMeaningful;
    const who = last.actor === "stage" || last.actor === "sparrer" ? providerDisplayName(live[last.actor].provider, last.actor) : capitalize(last.actor);
    return { kind: "last", time: formatTime(last.ts), text: `${who}: ${last.description}` };
  }
  return { kind: "none", text: "No activity telemetry for this stage." };
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
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
    title: stageDisplayName(stage),
    current: index === current,
    state: timelineState(stage, index, current, run),
  }));
  return { timeline: items };
}

export function timelineState(stage: StageSnapshot, index: number, current: number, run: PlanRunSnapshot): TimelineState {
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
    return { stageLine: "Candidate accepted; nothing further runs for this stage.", banner: { kind: "done", text: "Stage complete — candidate accepted" } };
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
    label: "Diff",
    detail: target ? `base ${shortenId(base)} … candidate ${shortenId(target)}` : `base ${shortenId(base)} … current HEAD`,
    baseSha: base,
    targetSha: target,
  };
}

/** Quiet metadata for the bottom of the page; nothing here is primary content. */
function facts(run: RunSnapshot, stage: StageSnapshot): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [{ label: "Repository", value: run.location.folderName }];
  if (run.kind === "plan") {
    out.push({ label: "Plan", value: run.state.status });
    out.push({ label: "Branch", value: run.state.expectedBranch });
  }
  if (stage.state?.baseSha) {
    out.push({ label: "Base", value: shortenId(stage.state.baseSha) ?? "" });
  }
  if (stage.state?.candidateSha) {
    out.push({ label: "Candidate", value: shortenId(stage.state.candidateSha) ?? "" });
  }
  out.push({ label: "Stage id", value: stage.stageId });
  if (stage.state?.implementationSessionId) {
    out.push({ label: "Stage session", value: shortenId(stage.state.implementationSessionId, 12) ?? "" });
  }
  if (stage.state?.sparringSessionId) {
    out.push({ label: "Sparring thread", value: shortenId(stage.state.sparringSessionId, 12) ?? "" });
  }
  return out;
}
