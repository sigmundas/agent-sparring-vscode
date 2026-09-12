/**
 * Shared view model for the Run Overview. Built from the same inputs the
 * status bar uses (discovery selection + activity fold), so the two surfaces
 * cannot drift semantically. Pure: no vscode API, no filesystem access; the
 * caller supplies which stage artifacts exist, the brief text, the plan
 * association and whether an acceptance is in flight.
 *
 * Authoritative facts (plan status, stage status, journey, routing outcome,
 * session ids, SHAs) come from plan-run state, state.json and sparring.md.
 * Only the actor "Working / Sparring / Waiting" words, active durations, the
 * loop cycle and the last visible event come from the observational
 * activity fold. The Goal is display-only text from brief.md. An associated
 * plan (chosen in VS Code) is display-only too and is never confused with
 * the engine's own plan run.
 *
 * Wording is the human vocabulary of presentation.ts; the engine's own
 * words are carried separately (`stageRaw`, the Engine state fact) for
 * tooltips and the footer.
 */

import { parseBriefGoal } from "./brief";
import { currentStageOf, runLabel, type PlanRunSnapshot, type RunSelection, type RunSnapshot, type StageSnapshot } from "./discovery";
import { activeDurationMs, formatDuration, providerDisplayName, type LiveState, type MeaningfulEvent } from "./liveState";
import { formatTime } from "./logFormat";
import { deriveLiveness, type ExecutionRecord, type LivenessState, type RunnerLiveness } from "./liveness";
import { proposeNextStage, type NextStageProposal } from "./nextStage";
import { briefMentionedStages, buildStageIndex, locateStage, parsePlanHeadings, planTitle, sectionSummary, type HeadingRef, type MatchSource, type PlanHeading } from "./planAssociation";
import { actionWord, presentStage, stageDisplayName, type StagePresentation } from "./presentation";
import { planAction, stageActions, type PlanAction, type StageRunAction } from "./runner";
import { QUIET_AFTER_MS, formatAge } from "./status";

export type TimelineState = "accepted" | "finalizing" | "active" | "paused" | "working" | "future";

/** The word shown under a journey node; only the current stage gets one. */
export const TIMELINE_STATE_WORD: Record<TimelineState, string> = {
  accepted: "Accepted",
  finalizing: "Finalizing",
  active: "In progress",
  paused: "Paused",
  working: "Not accepted",
  future: "Pending",
};

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
  /** Set when a busy claim has had no meaningful activity for a long time (formatted age). */
  quietFor?: string;
  /** True when the Working/Sparring claim rests on telemetry alone: no runner process has been observed alive. */
  uncertain?: boolean;
}

/** Git facts for the footer, supplied by the caller; never inferred here. */
export interface GitContext {
  branch?: string;
  /** Abbreviated HEAD commit. */
  head?: string;
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
  /**
   * `active`: a turn is in progress and the runner is observed alive;
   * `inferred`: telemetry says a turn started but no process backs it;
   * `stopped`: the runner ended mid-turn; `stale`: an inferred turn with no
   * telemetry for a long time.
   */
  kind: "active" | "inferred" | "last" | "none" | "stopped" | "stale";
  text: string;
  /** Time of day of the last visible event (kind `last`). */
  time?: string;
}

/** One line of the glanceable résumé: a past event, never a claim about the present. */
export interface HistoryEntry {
  time: string;
  /** Provider name for stage/sparrer events, else the actor (Loop, Gate, Plan). */
  who: string;
  description: string;
}

/** How many recent meaningful events the Overview shows. */
export const HISTORY_MAX = 4;

/** A Markdown plan the user associated with a standalone stage in VS Code (workspace state only). */
export interface AssociatedPlan {
  path: string;
  exists: boolean;
  /** Document text when readable; headings are parsed for display. */
  text?: string;
  /** The heading the user matched this stage to (workspace state), when automatic matching was not enough. */
  manualMatch?: HeadingRef;
}

export interface OverviewArtifacts {
  handoff: boolean;
  sparring: boolean;
  brief: boolean;
  plan: boolean;
  /** Contents of brief.md when it exists; the Goal paragraph is displayed and its `Stage <label>` markers help match an associated plan. */
  briefText?: string;
  /** Contents of a managed plan run's document when readable; only used for the next stage's opening paragraph. */
  planText?: string;
  /** Checked-out branch and HEAD of the repository owning the run, when known. */
  git?: GitContext;
  /** Extension-side plan association for a standalone stage (UI metadata, never engine state). */
  associatedPlan?: AssociatedPlan;
  /** An Accept stage operation started from this window is still running. */
  accepting?: boolean;
}

export interface OverviewActions {
  handoff: boolean;
  sparring: boolean;
  brief: boolean;
  /** A plan document can be opened: the managed plan run's, or the associated file. */
  plan: boolean;
  /** Standalone stage with no association: offer Choose plan…. */
  choosePlan: boolean;
  /** An associated plan exists and can be changed or removed. */
  changePlan: boolean;
  /** The associated plan is readable and has headings: the user can pick (or change) which one is this stage. */
  matchStage: boolean;
  /** Present when base_sha is recorded; `detail` (for a tooltip) says what the diff spans. */
  diff?: { label: string; detail: string; baseSha: string; targetSha?: string };
}

/** Header pill: the lifecycle word for the run, with a colour tone. */
export interface RunStatus {
  label: string;
  tone: "good" | "info" | "warn" | "muted";
}

/**
 * Where this stage sits in a plan document. `managed` is authoritative
 * (the engine's plan run); `associated` is a file the user chose here and
 * carries no engine meaning.
 */
export interface PlanContext {
  source: "managed" | "associated";
  /** Display name: the document's first heading, else its file name. */
  name: string;
  /**
   * This stage as the plan names it: managed → `Stage N — title`;
   * associated → the canonical `Stage 3B — title` of the matched stage when
   * the plan defines one, else the matched heading's own text.
   */
  current?: string;
  /** How the current heading was decided (associated plans only; managed runs are authoritative). */
  matched?: MatchSource;
  /** The label of the current logical stage (associated plans; undefined for an unlabelled heading). */
  currentLabel?: string;
  /**
   * The stage that follows in workflow order: for a managed run the engine's
   * next stage; for an associated plan the next stage *label* found in the
   * plan, never the next heading in the file. `defined` is false when the
   * plan mentions the label without a clear section for it (only history,
   * or several candidate definitions: `ambiguous`).
   */
  next?: { display: string; label?: string; line: number; summary?: string; defined: boolean; ambiguous?: boolean };
  /** Why there is no `next` for a matched associated stage. */
  nextState?: "found" | "last" | "unlabelled";
  /** Whether the document has any headings to match against at all. */
  hasHeadings: boolean;
  /** Whether the document carries stage labels at all (without them no progression can be derived). */
  hasStageLabels: boolean;
  /** One sentence for the tooltip / note about what this context is. */
  note: string;
}

/**
 * The answer to "this stage is done; what should I do now?", shown in
 * place of current-activity emphasis once a stage is accepted. Every
 * variant says only what the recorded data supports.
 */
export interface WhatsNext {
  kind:
    | "continue" // managed run: the engine's next stage; Continue plan runs it
    | "last-managed" // managed run: no stage follows; Continue plan closes the run
    | "next-stage" // associated plan, matched: the next stage by label, with a clear section; Start next stage
    | "next-unclear" // associated plan, matched: a later label exists but the plan defines it unclearly; read the plan
    | "last-stage" // associated plan, matched: no later stage label in the plan
    | "no-labels" // associated plan, matched to a plain heading: the plan has no stage labels to order by
    | "match" // associated plan, unmatched: ask the user where this stage belongs
    | "missing-plan" // associated file is gone
    | "choose"; // no plan at all
  /** The heading to show, e.g. `Stage 3C — Cloud schema and synchronization`. */
  heading?: string;
  /** Its opening paragraph, when the document has one. */
  summary?: string;
  /** One or two plain sentences. */
  text: string;
  /** Plan stages the brief lists as later work, when the stage itself could not be matched. */
  hints?: string[];
  /** For `next-stage`: what Start next stage would create (`sparring new-stage <stageId>`). */
  start?: NextStageProposal;
}

export interface OverviewModel {
  kind: "empty" | "ambiguous" | "run";
  title: string;
  /** `Plan run` or `Standalone stage`. */
  runKind?: string;
  status?: RunStatus;
  /** The last meaningful event, also while a turn is active. */
  lastEvent?: HistoryEntry;
  /** Primary stage action (Run stage / Resume stage / Accept stage); hidden while the runner is alive or its liveness unknown mid-turn. */
  stageAction?: StageRunAction;
  /** Advanced alternative (Run loop again after Review complete). */
  secondaryAction?: StageRunAction;
  /** Resume plan / Continue plan for a managed plan run. */
  planAction?: PlanAction;
  /** An Accept stage operation from this window is in flight. */
  accepting?: { label: string; detail: string };
  /** A runner observed for this run: alive (Stop offered) or stopped. */
  runner?: { alive: boolean; label: string };
  /**
   * Non-action state shown instead of Run/Resume: `Running` only when a
   * process observation backs it; `Run status unknown` when telemetry alone
   * claims an active turn. `detail` (tooltip) names the observation.
   */
  busyState?: { label: string; detail: string; state: LivenessState };
  /** Runner liveness as derived; the status bar and tests read it too. */
  liveness?: { state: LivenessState; source: RunnerLiveness["source"]; detail: string };
  /** For ambiguous: the candidate labels. */
  choices?: string[];
  /** Plan journey: only for managed plan runs with a readable plan document. */
  timeline?: TimelineItem[];
  timelineNote?: string;
  /** `Stage 2 of 5` for plan runs. */
  position?: string;
  stageAgent?: ActorCard;
  sparrer?: ActorCard;
  stageHeading?: string;
  /** Raw engine stage id, for secondary metadata / tooltips only. */
  stageId?: string;
  /** Human state word, e.g. `Review complete`. */
  stageStatus?: string;
  stageStatusKind?: string;
  /** The engine's vocabulary for the state (tooltip only). */
  stageRaw?: string;
  /** One sentence under the state word. */
  stageLine?: string;
  /** Current loop cycle when telemetry has reported one. */
  cycle?: number;
  goal?: string;
  activity?: ActivityLine;
  /** The last few meaningful events, oldest first; omitted without telemetry. */
  history?: HistoryEntry[];
  banner?: Banner;
  lastSparring?: { action: string; word: string; summary: string; reason?: string };
  plan?: PlanContext;
  /** Present only for an accepted stage. */
  whatsNext?: WhatsNext;
  actions?: OverviewActions;
  facts?: { label: string; value: string }[];
}

const NO_ARTIFACTS: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };

export function buildOverviewModel(
  selection: RunSelection,
  rawLive: LiveState | undefined,
  artifacts: OverviewArtifacts = NO_ARTIFACTS,
  nowMs: number = Date.now(),
  execution?: ExecutionRecord,
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
  const ownExecution = execution && execution.runId === run.id ? execution : undefined;
  const liveness = deriveLiveness(rawLive, ownExecution, nowMs);
  const live = liveness.live;
  const uncertain = liveness.source === "telemetry";
  const outcome = run.kind === "plan" ? run.currentOutcome : run.outcome;
  const presentation = presentStage(stage.state?.status, outcome, live);
  const plan = planContext(run, stage, artifacts);

  const model: OverviewModel = {
    kind: "run",
    title: run.kind === "plan" ? runLabel(run) : stageDisplayName(stage),
    stageAgent: actorCard("stage", stage, live, halted, nowMs, uncertain),
    sparrer: actorCard("sparrer", stage, live, halted, nowMs, uncertain),
    actions: {
      handoff: artifacts.handoff,
      sparring: artifacts.sparring,
      brief: artifacts.brief,
      plan: run.kind === "plan" ? artifacts.plan : Boolean(artifacts.associatedPlan?.exists),
      choosePlan: run.kind === "stage" && !artifacts.associatedPlan,
      changePlan: run.kind === "stage" && Boolean(artifacts.associatedPlan),
      matchStage: run.kind === "stage" && plan?.source === "associated" && plan.hasHeadings,
      diff: diffAction(stage),
    },
    facts: facts(run, stage, artifacts.git, presentation, artifacts.associatedPlan),
    goal: artifacts.brief ? parseBriefGoal(artifacts.briefText) : undefined,
    activity: activityLine(live, halted, nowMs, uncertain),
    history: history(live),
    runKind: run.kind === "plan" ? "Plan run" : "Standalone stage",
    status: runStatus(run, presentation, liveness),
    liveness: { state: liveness.state, source: liveness.source, detail: liveness.detail },
    plan,
  };
  model.lastEvent = model.history?.[model.history.length - 1];
  if (liveness.interrupted) {
    model.activity = { kind: "stopped", text: "Stopped · last turn interrupted" };
  } else if (liveness.stale) {
    model.activity = { kind: "stale", text: `${model.activity?.text ?? "Working"} · no meaningful activity for ${formatAge(nowMs - Date.parse(live?.lastMeaningful?.ts ?? live?.lastEventTs ?? ""))}` };
  }
  if (liveness.state === "running") {
    model.runner = { alive: true, label: "Stop (Ctrl-C)" };
  } else if (liveness.interrupted) {
    model.runner = { alive: false, label: "Runner stopped" };
  }
  const loopEligible = run.kind === "plan" || (stage.state?.status !== "accepted" && stage.state?.status !== "frozen");
  if (artifacts.accepting) {
    model.accepting = { label: "Accepting stage…", detail: "sparring freeze-candidate, then sparring accept-candidate, are running in a terminal of this window." };
  } else if (!halted && loopEligible && liveness.state === "running") {
    model.busyState = { label: "Running", detail: liveness.detail, state: "running" };
  } else if (!halted && loopEligible && liveness.turnActive) {
    // Telemetry alone: no second loop from the button, and no certain claim either.
    model.busyState = { label: "Run status unknown", detail: liveness.detail, state: "unknown" };
  } else if (liveness.state !== "running") {
    if (run.kind === "stage") {
      const actions = stageActions(run, liveness);
      model.stageAction = actions.primary;
      model.secondaryAction = actions.secondary;
    } else {
      model.planAction = planAction(run, liveness);
    }
  }

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
    model.stageStatus = "Not created";
    model.stageStatusKind = "future";
    model.stageRaw = "no stage directory";
  } else if (liveness.interrupted && (presentation.kind === "working" || presentation.kind === "send_back")) {
    model.stageStatus = "Stopped";
    model.stageStatusKind = "stopped";
    model.stageRaw = presentation.raw;
  } else {
    model.stageStatus = presentation.label;
    model.stageStatusKind = presentation.kind;
    model.stageRaw = presentation.raw;
  }
  if (!halted && live?.currentCycle !== undefined) {
    model.cycle = live.currentCycle;
  }

  if (outcome) {
    model.lastSparring = { action: outcome.action, word: actionWord(outcome.action), summary: outcome.summary, reason: outcome.needsYouReason };
  }
  Object.assign(model, currentLine(run, stage, live, presentation, liveness, Boolean(artifacts.accepting), model.planAction));
  if (stage.state?.status === "accepted" && !(run.kind === "plan" && run.state.status === "complete")) {
    model.whatsNext = whatsNext(run, plan, artifacts, model.planAction);
  }
  return model;
}

// ---------------------------------------------------------------- pieces

function runStatus(run: RunSnapshot, presentation: StagePresentation, liveness: RunnerLiveness): RunStatus {
  if (run.kind === "plan") {
    switch (run.state.status) {
      case "running":
        return liveness.interrupted ? { label: "Stopped", tone: "warn" } : { label: "Running", tone: "good" };
      case "paused": {
        const action = run.currentOutcome?.action;
        return { label: action === "NEEDS_YOU" || action === "ESCALATE" ? actionWord(action) : "Paused", tone: "warn" };
      }
      case "complete":
        return { label: "Complete", tone: "good" };
    }
  }
  if (liveness.interrupted && (presentation.kind === "working" || presentation.kind === "send_back")) {
    return { label: "Stopped", tone: "warn" };
  }
  switch (presentation.kind) {
    case "accepted":
      return { label: "Accepted", tone: "good" };
    case "finalizing":
      return { label: "Finalizing", tone: "info" };
    case "ready":
      return { label: "Review complete", tone: "good" };
    case "needs_you":
    case "escalate":
    case "send_back":
      return { label: presentation.label, tone: "warn" };
    default:
      return { label: "Working", tone: "good" };
  }
}

function isHalted(run: RunSnapshot): boolean {
  if (run.kind === "plan") {
    return run.state.status !== "running";
  }
  return run.stage.state?.status === "accepted";
}

function actorCard(role: "stage" | "sparrer", stage: StageSnapshot, live: LiveState | undefined, halted: boolean, nowMs: number, uncertain: boolean): ActorCard {
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
    // Measured from the last event the Output Channel would show, so hidden
    // tool noise does not make a silent turn look lively.
    const since = live?.lastMeaningful?.ts ?? actor.lastEventTs;
    const age = since ? nowMs - Date.parse(since) : NaN;
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
    uncertain: activity === "Working" || activity === "Sparring" ? uncertain : undefined,
  };
}

/**
 * The single activity line under the current stage. The sparrer's turn
 * takes precedence over the stage agent's when both look busy (a SEND_BACK
 * cycle resumes both; sparring is the later phase).
 */
export function activityLine(live: LiveState | undefined, halted: boolean, nowMs: number, uncertain = false): ActivityLine {
  if (!halted && live) {
    for (const role of ["sparrer", "stage"] as const) {
      const actor = live[role];
      const active = activeDurationMs(actor, nowMs);
      if (actor.busy && active !== undefined) {
        const verb = role === "stage" ? "Working" : "Sparring";
        if (uncertain) {
          // Telemetry saw the turn start; nothing has seen the runner alive.
          return { kind: "inferred", text: `${role === "stage" ? "Turn" : "Sparring turn"} started ${formatDuration(active)} ago · ${providerDisplayName(actor.provider, role)} · runner status unknown` };
        }
        return { kind: "active", text: `${verb} for ${formatDuration(active)} · ${providerDisplayName(actor.provider, role)}` };
      }
    }
  }
  if (live?.lastMeaningful) {
    // Phrased as a past fact ("last event: Claude · changed x.py"), never as
    // what an actor is doing right now; telemetry cannot support the latter.
    const last = live.lastMeaningful;
    return { kind: "last", time: formatTime(last.ts), text: `${whoFor(last, live)} · ${describeForOverview(last)}` };
  }
  return { kind: "none", text: "No activity telemetry for this stage." };
}

/** The last HISTORY_MAX meaningful events as a résumé, oldest first. */
export function history(live: LiveState | undefined): HistoryEntry[] | undefined {
  if (!live || live.recentMeaningful.length === 0) {
    return undefined;
  }
  return live.recentMeaningful.slice(-HISTORY_MAX).map((entry) => ({ time: formatTime(entry.ts), who: whoFor(entry, live), description: describeForOverview(entry) }));
}

/**
 * The Output Channel keeps the engine's words (`SEND_BACK — range handling`);
 * the Overview shows the same event with the human word in front.
 */
function describeForOverview(entry: MeaningfulEvent): string {
  if (entry.event !== "verdict") {
    return entry.description;
  }
  return entry.description.replace(/^[A-Z_]+/, (action) => actionWord(action));
}

function whoFor(entry: MeaningfulEvent, live: LiveState): string {
  if (entry.actor === "stage" || entry.actor === "sparrer") {
    return providerDisplayName(live[entry.actor].provider, entry.actor);
  }
  return entry.actor.charAt(0).toUpperCase() + entry.actor.slice(1);
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
    return "finalizing";
  }
  if (index === current) {
    return run.state.status === "paused" ? "paused" : "active";
  }
  return index < current ? "working" : "future";
}

// ---------------------------------------------------------------- plan context

/**
 * Managed plan run: the next heading from the engine-parsed plan. Standalone
 * stage with an associated file: the document's headings, and this stage's
 * place in them only when one heading unambiguously matches.
 */
function planContext(run: RunSnapshot, stage: StageSnapshot, artifacts: OverviewArtifacts): PlanContext | undefined {
  const associated = artifacts.associatedPlan;
  if (run.kind === "plan") {
    const stages = run.planStages;
    const index = run.state.currentStageIndex;
    const nextHeading = stages?.[index + 1];
    let next: PlanContext["next"];
    if (nextHeading) {
      // The engine parsed the heading; its line and opening paragraph come
      // from the same document, read here for display only.
      const inDocument = artifacts.planText ? parsePlanHeadings(artifacts.planText).find((heading) => heading.label === String(nextHeading.number) && heading.title === nextHeading.title) : undefined;
      next = {
        display: `Stage ${nextHeading.number} — ${nextHeading.title}`,
        label: String(nextHeading.number),
        line: inDocument?.line ?? 0,
        summary: inDocument && artifacts.planText ? sectionSummary(artifacts.planText, inDocument.line) : undefined,
        defined: true,
      };
    }
    return {
      source: "managed",
      name: run.state.plan,
      current: `Stage ${stage.number ?? index + 1} — ${stageDisplayName(stage)}`,
      next,
      hasHeadings: Boolean(stages && stages.length > 0),
      hasStageLabels: Boolean(stages && stages.length > 0),
      note: "The engine's plan run: it records which stage is current and resume-plan continues it.",
    };
  }
  if (!associated) {
    return undefined;
  }
  const name = (associated.text ? planTitle(associated.text) : undefined) ?? basename(associated.path);
  const note = "Associated with this stage in VS Code for display only; the engine does not know about it. A following stage is created with the engine's own new-stage command.";
  if (!associated.exists || associated.text === undefined) {
    return { source: "associated", name, hasHeadings: false, hasStageLabels: false, note: associated.exists ? note : `${note} The file is currently missing.` };
  }
  const headings: PlanHeading[] = parsePlanHeadings(associated.text);
  const position = locateStage(headings, { stageId: stage.stageId, title: stage.title, briefText: artifacts.briefText, manual: associated.manualMatch });
  const text = associated.text;
  let next: PlanContext["next"];
  if (position?.next.state === "found") {
    const entry = position.next.stage;
    next = {
      display: entry.display,
      label: entry.label,
      line: entry.canonical?.line ?? entry.occurrences[0]?.line ?? 0,
      summary: entry.canonical ? sectionSummary(text, entry.canonical.line) : undefined,
      defined: Boolean(entry.canonical),
      ambiguous: entry.ambiguous,
    };
  }
  return {
    source: "associated",
    name,
    current: position?.display,
    matched: position?.source,
    currentLabel: position?.stage?.label,
    next,
    nextState: position?.next.state,
    hasHeadings: headings.length > 0,
    hasStageLabels: headings.some((heading) => heading.label !== undefined),
    note,
  };
}

/** See WhatsNext. Only called for an accepted current stage of a run that is not complete. */
function whatsNext(run: RunSnapshot, plan: PlanContext | undefined, artifacts: OverviewArtifacts, planAction: PlanAction | undefined): WhatsNext {
  if (run.kind === "plan") {
    const canContinue = planAction?.kind === "continue";
    if (plan?.next) {
      return { kind: "continue", heading: plan.next.display, summary: plan.next.summary, text: canContinue ? "Continue plan starts it." : "The engine's next stage; Continue plan is offered once no runner is alive." };
    }
    return { kind: "last-managed", text: canContinue ? "No stage follows this one in the plan. Continue plan hands the finished run back to the engine." : "No stage follows this one in the plan." };
  }
  if (!plan) {
    return { kind: "choose", text: "This stage has been accepted. Choose a plan to see what comes next." };
  }
  const associated = artifacts.associatedPlan;
  if (!associated?.exists || associated.text === undefined) {
    return { kind: "missing-plan", text: `The linked plan file (${basename(associated?.path ?? "")}) is missing. Choose another plan to see what comes next.` };
  }
  if (!associated.exists) {
    return { kind: "missing-plan", text: "The linked plan file is missing." };
  }
  const headings = parsePlanHeadings(associated.text);
  const index = buildStageIndex(headings);
  if (!plan.current) {
    const hints = plan.hasHeadings ? briefMentionedStages(index, artifacts.briefText).map((entry) => entry.display) : [];
    return {
      kind: "match",
      text: plan.hasHeadings
        ? "The plan is linked, but Agent Sparring doesn't yet know where this stage belongs in it."
        : "The plan is linked, but it has no section headings to place this stage under.",
      hints: hints.length > 0 ? hints : undefined,
    };
  }
  if (plan.nextState === "unlabelled") {
    return { kind: "no-labels", text: `${plan.name} has no "Stage …" labels, so Agent Sparring cannot tell which section comes after this one.` };
  }
  if (plan.nextState === "last" || !plan.next) {
    return { kind: "last-stage", text: `No later stage is defined in ${plan.name}.` };
  }
  const next = plan.next;
  const entry = index.find((candidate) => candidate.label === next.label);
  const start = entry && next.defined ? proposeNextStage(entry) : undefined;
  if (start) {
    return { kind: "next-stage", heading: next.display, summary: next.summary, text: "Start next stage creates it with the engine; you then fill in its brief from this plan section and run it.", start };
  }
  return {
    kind: "next-unclear",
    heading: next.display,
    text: next.ambiguous
      ? `${plan.name} defines Stage ${next.label ?? ""} in more than one section, so Agent Sparring cannot say which one to start. Read the plan to decide.`
      : `${plan.name} mentions Stage ${next.label ?? ""} only in passing (a handoff or status note), without a section that defines it.`,
  };
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

// ---------------------------------------------------------------- state line + banner

function currentLine(
  run: RunSnapshot,
  stage: StageSnapshot,
  live: LiveState | undefined,
  presentation: StagePresentation,
  liveness: RunnerLiveness,
  accepting: boolean,
  plan: PlanAction | undefined,
): Pick<OverviewModel, "stageLine" | "banner"> {
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
          stageLine: outcome.action === "NEEDS_YOU" ? "Waiting for you. Resume the plan with your answer or check result." : "The independent reviewer could not settle this. Read the sparring report, then resume the plan.",
          banner: { kind: "stop", text: `${actionWord(outcome.action)}${detail}` },
        };
      }
      const failure = live?.lastPlanEvent?.event === "plan.failed" ? live.lastPlanEvent.summary : undefined;
      return {
        stageLine: "The run stopped. Check the log and terminal, then resume the plan.",
        banner: { kind: "warn", text: `Paused${failure ? ` — ${failure}` : ""}` },
      };
    }
    if (stageStatus === "accepted") {
      return { stageLine: plan?.kind === "continue" ? "Stage complete. Continue plan starts the next stage." : "Stage complete." };
    }
  } else if (stageStatus === "accepted") {
    // No banner: the header pill already says Accepted and this line says complete.
    return { stageLine: "Stage complete." };
  } else if (presentation.kind === "needs_you") {
    return {
      stageLine: "Waiting for you. When it is done, resume the stage; the reviewer checks again.",
      banner: { kind: "stop", text: `Needs you${outcome?.summary ? ` — ${outcome.summary}` : ""}` },
    };
  } else if (presentation.kind === "escalate") {
    return {
      stageLine: "The independent reviewer could not settle this. Read the sparring report and decide how to continue.",
      banner: { kind: "stop", text: `Escalated${outcome?.summary ? ` — ${outcome.summary}` : ""}` },
    };
  }

  if (stageStatus === "frozen") {
    if (accepting) {
      return { stageLine: "Finalizing stage…" };
    }
    if (liveness.state === "running") {
      return { stageLine: "Finalizing stage…" };
    }
    return { stageLine: "Finalizing did not complete. Use Accept stage to finish it." };
  }
  if (liveness.interrupted && (presentation.kind === "working" || presentation.kind === "send_back")) {
    return { stageLine: "The last run was interrupted." };
  }
  if (live?.sparrer.busy) {
    return { stageLine: "Under independent review." };
  }
  if (presentation.kind === "send_back") {
    return { stageLine: presentation.detail };
  }
  if (presentation.kind === "ready") {
    return { stageLine: presentation.detail };
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

/** Quiet metadata for the bottom of the page; nothing here is primary content. The engine's own vocabulary lives here. */
function facts(run: RunSnapshot, stage: StageSnapshot, git: GitContext | undefined, presentation: StagePresentation, associated: AssociatedPlan | undefined): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [{ label: "Repository", value: run.location.folderName }];
  if (run.kind === "plan") {
    out.push({ label: "Plan", value: run.state.status });
    out.push({ label: "Expected branch", value: run.state.expectedBranch });
  } else if (associated) {
    out.push({ label: "Plan", value: `${basename(associated.path)} (associated in VS Code)` });
  }
  if (git?.branch || git?.head) {
    const head = git.head ? shortenId(git.head, 8)?.replace(/…$/, "") : undefined;
    out.push({ label: "Checked out", value: [git.branch ?? "(detached)", head ? `@ ${head}` : ""].filter(Boolean).join(" ") });
  }
  if (stage.exists) {
    out.push({ label: "Engine state", value: presentation.raw });
  }
  if (stage.state?.baseSha) {
    out.push({ label: "Base", value: shortenId(stage.state.baseSha) ?? "" });
  }
  if (stage.state?.candidateSha) {
    out.push({ label: "Candidate", value: shortenId(stage.state.candidateSha) ?? "" });
  }
  if (stage.state?.implementationSessionId) {
    out.push({ label: "Stage session", value: shortenId(stage.state.implementationSessionId, 12) ?? "" });
  }
  if (stage.state?.sparringSessionId) {
    out.push({ label: "Sparring thread", value: shortenId(stage.state.sparringSessionId, 12) ?? "" });
  }
  return out;
}
