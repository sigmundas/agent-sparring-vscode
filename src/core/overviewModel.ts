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

import { describeRepositoryContext, emptyStateLines, emptyStateTitle, type RepositoryContextView } from "./activeRepository";
import { agentConfigView, providerLabel, type AgentConfigView, type ConfigRole, type EffectiveConfig } from "./effectiveConfig";
import { parseBriefGoal, parseBriefOpening } from "./brief";
import { currentStageOf, runLabel, type PlanRunSnapshot, type RunSelection, type RunSnapshot, type StageSnapshot } from "./discovery";
import { activeDurationMs, formatDuration, providerDisplayName, type LiveState, type MeaningfulEvent } from "./liveState";
import { DEFERRED_VERIFICATION_REQUIRED, PUSH_AUTHORIZATION_REQUIRED, obligationResolved, parseHandoffBranch, type DeferredObligation, type PlanRunState, type SparringOutcome, type StageStatus, type StateRepository } from "./engineFormats";
import type { DeclaredRepository } from "./stageRepositories";
import { deriveDeferredVerification, deriveVerification, draftKeyFor, HUMAN_FEEDBACK_HEADING, parseHumanEvidence, parseHumanFeedback, planChecks, type CheckRecord, type VerificationView } from "./humanChecks";
import { categoryWord, checkNameList } from "./humanTask";
import { SUBMISSION_PRESERVED, SUBMISSION_UNRESOLVED, type SubmissionRecord } from "./submission";
import { sameStageScope, stageScopeOf } from "./stageScope";
import { formatTime } from "./logFormat";
import { deriveLiveness, type ExecutionRecord, type LivenessState, type RunnerLiveness } from "./liveness";
import { proposeNextStage, type NextStageProposal } from "./nextStage";
import { buildPromptView, latestCapture, type CaptureEntry, type PromptView } from "./promptInspector";
import { briefMentionedStages, buildStageIndex, locateStage, parsePlanHeadings, planTitle, sectionSummary, type HeadingRef, type MatchSource, type PlanHeading } from "./planAssociation";
import { actionWord, presentStage, stageDisplayName, type StagePresentation } from "./presentation";
import { hasSessions, planAction, stageActions, type PlanAction, type StageRunAction } from "./runner";
import { QUIET_AFTER_MS, formatAge } from "./status";

export type TimelineState = "accepted" | "finalizing" | "active" | "paused" | "working" | "future";

/**
 * One stage of the execution manifest a managed run is executing, with what
 * the engine has recorded for it.
 *
 * A manifest run's stages are not the plan document's `## Stage <n>` headings
 * — that convention is exactly what the manifest exists to replace — so the
 * journey and the stage's own name have to come from the manifest the engine
 * was handed. The extension wrote that file and can read it back; `status`
 * is the stage's own `state.json`, so every word shown about a stage is still
 * the engine's recorded state.
 */
export interface ManifestStageView {
  stageId: string;
  /** `Stage 3D` exactly as the manifest labels it; display only, the array order is the execution order. */
  label: string;
  title: string;
  /** `state.json` status; undefined for a stage the engine has not created yet. */
  status?: StageStatus;
}

/** The manifest resolved against the run: only ever set when the recorded current stage is one of its stages. */
interface ManifestView {
  stages: ManifestStageView[];
  /** Index of the run's current stage in the manifest. */
  at: number;
  current: ManifestStageView;
}

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
  /** The plan's own label for the stage (`3D`), when the run knows one; the number is then only its position. */
  label?: string;
}

export type ActorActivity = "Working" | "Sparring" | "Waiting" | "Idle";

export interface ActorCard {
  /**
   * What this actor *is* in the workflow. It is the card's primary heading:
   * the role is the concept a person reasons about, and the provider
   * currently filling it is secondary to it.
   */
  role: "Stage agent" | "Sparrer";
  /** The same role in the engine's configuration vocabulary, which the controls are keyed by. */
  configRole: ConfigRole;
  provider: string;
  /**
   * Absent on the no-run screen, where the card is a configuration surface
   * for a role that is not doing anything: there is no stage, so there is no
   * activity to report and "Idle" would be a claim about a run that does not
   * exist.
   */
  activity?: ActorActivity;
  /** `Xm Ys` since the latest turn start/resume, while active. */
  duration?: string;
  /** Persisted session/thread id, shortened for display. */
  sessionLabel?: string;
  /** Absent together with {@link activity}: with no run there is no session to name. */
  sessionKind?: "session" | "thread";
  /** Set when a busy claim has had no meaningful activity for a long time (formatted age). */
  quietFor?: string;
  /** True when the Working/Sparring claim rests on telemetry alone: no runner process has been observed alive. */
  uncertain?: boolean;
  /**
   * What this actor was actually told, built from the engine's captured
   * prompt for its latest turn. Absent for a stage that has not run a turn
   * since prompt capture existed, which is an ordinary state, not an error.
   */
  prompt?: PromptView;
}

/** One captured turn the caller read off disk: its index line, and the prompt file it names. */
export interface CapturedPrompt {
  entry: CaptureEntry;
  text: string;
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

/**
 * What a person is told when a runner's fate could not be established.
 *
 * Deliberately in the vocabulary of the thing they can act on — a previous
 * runner they can go and look at — and deliberately not in the extension's
 * own lifecycle vocabulary: nobody outside this code needs the words
 * "attribution", "guard" or "observation lost" to decide whether a process is
 * still working.
 */
export const UNKNOWN_RUNNER_EXPLANATION = "Agent Sparring cannot determine whether the previous runner is still active. Check it before allowing another attempt.";

/**
 * What a run whose fate cannot be established says, and what it says once a
 * stop has been asked for and not answered.
 *
 * Both name the consequence rather than the internals, because the
 * consequence is the only part a person has to act on: the run may still be
 * doing work, so Agent Sparring will not start a second copy of it. Neither
 * says or implies that anything failed.
 */
const RUN_UNKNOWN_DETAIL = "Run may still be active — starting another copy is blocked.";
const STOP_UNPROVEN_DETAIL = "The interrupt was sent, but nothing has proved that runner ended. Run may still be active — starting another copy is blocked.";
const STOP_REQUESTED_DETAIL = "An interrupt was sent to this runner. It is still reported as running; this will say Stopped once it has actually ended.";

/** What Stop would do, by the target it would do it to. */
const STOP_DETAIL: Readonly<Record<"terminal" | "process", string>> = {
  terminal: "Interrupt this run the way Ctrl-C in its terminal would. The engine records its state as it goes, so nothing is reset and the run can be resumed.",
  process: "Interrupt exactly the process running this run, after re-checking that it is still that process. The engine records its state as it goes, so nothing is reset and the run can be resumed.",
};

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
  /** Outcomes the user has recorded for the plan's manual checks (VS Code workspace state, drafts until submitted). */
  humanChecks?: Record<string, CheckRecord>;
  /** Freeform findings the user has typed but not sent yet (VS Code workspace state); not a check result. */
  humanFeedback?: string;
  /**
   * The "Auto-push future accepted candidates in this run" toggle as the
   * person has currently set it, before they have allowed anything (VS Code
   * workspace state, so a rerender does not move it back).
   *
   * It is a draft of an intention and nothing more. The *decision* is
   * recorded by the engine when Allow push runs, and the Overview reads it
   * back from the run state (`autoPushEnabled`) — never from here — so what
   * survives a reload is what the engine was actually told.
   */
  autoPushDraft?: boolean;
  /** Evidence handed to the engine and not yet recorded by it, or a submission that failed; see submission.ts. */
  submission?: SubmissionRecord;
  /** Contents of the stage's notes.md when readable; only its `## Human evidence` section is consulted (what is already recorded). */
  notesText?: string;
  /** Contents of the stage's handoff.md when readable; only its `## Git context` branch line is consulted. */
  handoffText?: string;
  /**
   * The engine's captured prompts for this stage — the latest turn per role,
   * each with the exact text the provider was handed. Supplied by the caller
   * that can read `prompts/`; empty for a stage last run by an engine
   * without prompt capture, which is an ordinary state.
   */
  capturedPrompts?: CapturedPrompt[];
  /**
   * How the user wants a plan to progress (`agentSparring.planContinuation`):
   * `automatic` hands the whole plan to the engine as one managed run and
   * offers no per-stage clicks between healthy stages; `manual` keeps the
   * explicit Accept stage / Start next stage / Run stage checkpoints. Both
   * only ever offer engine operations; the extension never sequences.
   */
  continuation?: PlanContinuation;
  /**
   * Sibling repositories declared for this stage in VS Code (workspace
   * state, emitted into the execution manifest). Shown quietly next to what
   * the engine has actually recorded in `state.json`: a declaration says
   * which repositories the candidate set spans, a pin says which commit was
   * frozen, and the two are labelled differently because they are.
   */
  siblingRepositories?: DeclaredRepository[];
  /**
   * The stages of the execution manifest this managed run executes, in
   * execution order, each with its recorded status — supplied by the caller
   * that can read the manifest file. Used for the stage's plan identity
   * (`Stage 3D`, not "the manifest's sixth entry") and for the journey.
   * Ignored unless the run's recorded current stage is one of them.
   */
  manifestStages?: ManifestStageView[];
  /**
   * The managed plan run this *standalone* stage belongs to — the run that
   * adopted it and has since advanced past it, whether that run is still
   * going or has finished. Everything that would sequence this stage by hand
   * is that run's business, so those offers are withdrawn and the Overview
   * offers the way back to the run instead.
   */
  managedPlanRun?: ManagedPlanRun;
  /**
   * Stage ids the engine has already created in this project. Start next
   * stage is not offered for one of them: `sparring new-stage` refuses an
   * existing stage, and a managed run creates the next stage itself.
   */
  existingStageIds?: readonly string[];
  /**
   * The immutable id of the operation holding this run's duplicate guard at
   * the moment the panel was built, when there is one. It is carried into the
   * rendered recovery control so a confirmation acts on the record the person
   * was actually shown, instead of whichever operation holds that run's key
   * when the click arrives.
   */
  guardedOperationId?: string;
  /**
   * Whether this run's duplicate guard is one this window cannot account
   * for by itself: a command a shell was given and never seen to start, an
   * operation from before a reload, or one whose terminal is gone. That is
   * the registry's own `outstanding` question (operationRegistry.ts), and
   * it is exactly the condition under which starting the run again would
   * risk doing the same engine operation twice.
   *
   * The Overview reads it so the refusal is on screen *before* the click.
   * Without it the panel offered Run/Resume, the registry refused the
   * launch, and the person learned about the guard from an error dialog.
   */
  guardOutstanding?: boolean;
  /**
   * The exact execution a Stop would interrupt, and how it would be
   * reached, as the tracker resolved it when this panel was built. Absent
   * whenever there is no target that is positively this operation, which
   * is what keeps the button off the screen rather than letting it guess.
   */
  stopTarget?: { executionId: string; via: "terminal" | "process" };
  /**
   * What the engine says the two roles would run with, from
   * `sparring show-config --json` (see core/effectiveConfig.ts). Supplied by
   * the caller that can run the engine; absent when nothing asked. The
   * extension never derives any of it from project.toml itself.
   */
  agentConfig?: EffectiveConfig;
}

/** The managed plan run the standalone stage on screen is a stage of. */
export interface ManagedPlanRun {
  runId: string;
  /** The plan's display name, as the run list shows it. */
  planName: string;
  /** The stage the managed run is at now. */
  stageId: string;
  /** Its plan identity when the manifest gives one (`Stage 4`). */
  stageLabel?: string;
  /** The engine's recorded status of the run (`running`, `paused`, `complete`). */
  status: string;
  /** The plan's own name for the stage on screen (`Stage 3D`), when the manifest gives one. */
  memberLabel?: string;
  /** The plan's own title for the stage on screen, when the manifest gives one. */
  memberTitle?: string;
}

export type PlanContinuation = "automatic" | "manual";

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
  /** 1-based line of the current stage's heading in the document, when it was located there. */
  currentLine?: number;
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
    | "next-created" // associated plan, matched: the next stage exists already (a managed run created it, or it was created by hand)
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

/**
 * The checked-out branch is not the one this stage's work belongs to, as
 * far as the recorded artifacts say. Both sides are facts: `expected` is
 * the plan run's `expected_branch` (the engine refuses any other) or the
 * branch written in the stage's last handoff; `actual` is the repository's
 * checked-out branch, absent on a detached HEAD. While this is set the
 * extension offers nothing that runs the engine, because every loop command
 * takes `--expected-branch` and the engine's branch guard would refuse.
 */
export interface BranchGuard {
  expected: string;
  /** Undefined when HEAD is detached or the branch could not be read. */
  actual?: string;
  /** Where `expected` comes from: the engine's plan-run state, or the stage's handoff.md. */
  source: "plan-run" | "handoff";
  /** One sentence naming the source, for the warning's second line. */
  detail: string;
}

/**
 * The single "Action required" panel for a stage the reviewer handed to
 * the human. It replaces the banner, the card's state word and the Latest
 * sparring result block for NEEDS_YOU / ESCALATE, so the routing action is
 * named once in the header pill and explained once here. The lists are
 * derived from the matched plan section, the routing outcome and the
 * notes.md `## Human evidence` section (see humanChecks.ts).
 */
/**
 * One demoted fact: the exact reviewer wording, an id, a category, a source
 * path. Everything a person does not need in order to act, kept one
 * disclosure away rather than deleted — the normal layer says what to do, the
 * details layer says why the harness believes it.
 */
export interface TechnicalDetail {
  label: string;
  value: string;
}

/**
 * One deferred obligation as the checkpoint presents it: what a reviewer
 * asked for, which stage's review asked, and why it was judged safe to
 * carry.
 *
 * The rationale is shown, not hidden in a details layer. It is the answer to
 * the question a person arriving at this checkpoint actually has — "why am I
 * being asked about stage 2 now?" — and it is the record that lets them
 * disagree with the reviewer's judgement.
 */
export interface DeferredGroup {
  /** The engine-minted asking; every answer is addressed to it. */
  instanceId: string;
  /** The stage whose review raised it. */
  stageId: string;
  /** `Device manual check`, `Ui visual check`, … made readable. */
  category: string;
  title: string;
  rationale: string;
  /** A later reviewer decided this one could not wait; it is why the run stopped early. */
  promoted: boolean;
  /** The draft keys of this obligation's checks, in the reviewer's order. */
  checkKeys: string[];
}

export interface ActionRequired extends VerificationView {
  /**
   * `deferred_verification` is not a stage handed back to the human: every
   * stage is accepted and the run is at the plan's own verification
   * checkpoint, holding the checks earlier reviewers deferred. It shares
   * this panel because the thing a person does is identical — Pass, Fail,
   * Can't test, with a note — and a second evidence surface would mean a
   * second set of rules about which recorded answer counts.
   */
  kind: "needs_you" | "escalate" | "deferred_verification";
  /**
   * `deferred_verification` only: the obligations this checkpoint gathered,
   * each with the stage that raised it and the reviewer's own reason for
   * deferring. The checks themselves are in the shared lists; this is what
   * groups and explains them.
   */
  deferredGroups?: DeferredGroup[];
  /** `Needs you` / `Escalated`. */
  word: string;
  /**
   * The panel's own title: `Manual check required` for a structured gate,
   * `Action required` for the legacy derived path, and `Evidence ready for
   * review` once every requested check has an outcome.
   */
  headline: string;
  /**
   * The gate's own title — the one sentence saying what must be true before
   * the stage can be READY. Structured gates only; it is the requirement, and
   * it is stated once.
   */
  gateTitle?: string;
  /**
   * The reviewer's exact wording, ids, categories and source paths, for the
   * collapsed technical layer. Never a prerequisite for acting.
   */
  technical: TechnicalDetail[];
  /** One sentence under a headline that replaces the reviewer's summary. */
  subtitle?: string;
  /** The reviewer's routing summary (sparring.md), verbatim. */
  summary: string;
  /** The reviewer's needs-you reason, verbatim: the one compact reviewer note. */
  reviewerNote?: string;
  /** Why there are no checks at all, when there are none. */
  noChecks?: string;
  /**
   * The last observed review run (`run-sparring`) ended without succeeding.
   * Said as a failed review, never as an interrupted stage: the stage agent
   * was not involved.
   */
  reviewFailure?: string;
  /**
   * Submit for review: record the drafted outcomes and ask the independent
   * reviewer to look again — `sparring run-sparring` for a standalone stage,
   * the engine's own `resume-plan --evidence` inside a plan run. Enabled only
   * once every requested check has an outcome: it is not an implementation
   * turn, so partial evidence has nothing to add for the reviewer.
   */
  submit: { label: string; enabled: boolean; detail: string };
  /**
   * The freeform channel beside the structured checks: what the human found
   * that is not a result for any requested check.
   *
   * It exists because the three controls above force every observation into
   * one of the reviewer's predefined checks, and verification does not work
   * that way — a crash on the way to the feature, a table whose wording
   * contradicts the parser, a reason the checks cannot be attempted yet.
   * Sending it records nothing about any check: `submit` stays governed by
   * its own completeness rule, no outstanding check becomes Can't test, and
   * `progress` does not move.
   *
   * The reviewer reads the text against the unchanged candidate and rules
   * again — SEND_BACK, the same checks, revised checks, or READY only where
   * its own acceptance rules already allow it. Human feedback is input to
   * that decision, never an implementation order.
   */
  feedback: {
    /** Typed here and not sent yet; survives rerenders and reloads. */
    draft?: string;
    /** Feedback already recorded in notes.md, verbatim, oldest first. */
    submitted: string[];
    send: { label: string; enabled: boolean; detail: string };
  };
  /**
   * Evidence is with the engine and its execution has not ended. Neither
   * button is offered while this is set, and nothing is cleared: launching a
   * command is not the same as the engine recording what it was given.
   */
  submitting?: { label: string; detail: string };
  /**
   * The last submission for this run ended without the engine recording it.
   * `preserved` is the first thing said, because it is the answer to what the
   * person is about to fear; `error` is the engine's own output, verbatim.
   */
  submissionFailure?: { preserved: string; reason: string; what: string; error?: string };
  /**
   * A submission nobody could resolve, settled by the person saying the
   * runner is no longer active. Says what is unknown and what was kept; it
   * claims neither success nor failure, because neither is known.
   */
  submissionUnresolved?: { preserved: string; reason: string; what: string };
  /**
   * Resume *implementation* without new evidence: the existing Resume stage
   * / Resume plan operation, when one is offered. Deliberately separate from
   * Submit for review — that asks the reviewer to evaluate the unchanged
   * candidate, this starts the stage agent again.
   */
  resume?: { action: "runStage" | "resumePlan"; label: string; detail: string };
  /** Open plan section is possible (the plan was located). */
  planSection: boolean;
  /** The detailed review (sparring.md) exists. */
  review: boolean;
}

/**
 * The engine is holding a finished, verified candidate and will not push it
 * without being told to.
 *
 * This is **not** a manual check and must never be presented as one. It came
 * to exist because the reviewer could express the requirement as a
 * human-gate check — "explicit push authorization is required" — and a
 * person answering *Pass* to that check authorized nothing: the answer went
 * back as evidence, the reviewer said READY again, and the acceptance gate
 * refused the same candidate again. So there are no Pass / Fail / Can't test
 * controls here, no progress count and no submit-for-review path. There is
 * one decision, and it is a permission.
 *
 * Every fact is the engine's own record of why the run stopped (`awaiting`
 * in the plan-run state): the commit, the remote and the branch are read,
 * never derived, and nothing here runs git.
 */
export interface PushAuthorization {
  /** `Push authorization required`. */
  headline: string;
  /** One sentence: what is ready, and where it would go. */
  text: string;
  /** The full commit id, for the engine contract; `shortSha` is what is shown. */
  candidateSha: string;
  shortSha: string;
  /** `origin/feature/x`, as the acceptance gate would check it. */
  target: string;
  /** The stage the candidate belongs to, as the engine named it. */
  stageId: string;
  allow: { label: string; enabled: boolean; detail: string };
  /** Leaving it for now: nothing is run, nothing is recorded, the run stays paused. */
  dismiss: { label: string; detail: string };
  /**
   * The run-scoped half of the same decision, as a toggle the person sets
   * before allowing: on, the permission covers the candidates this run
   * verifies from here on, and the engine stops asking.
   */
  autoPush: { label: string; checked: boolean; detail: string };
  /** The engine's own vocabulary and identifiers, one disclosure away. */
  technical: TechnicalDetail[];
}

/**
 * The effective provider/model/effort for both roles, the controls that
 * change it, and the Settings action.
 *
 * The controls are drawn inside the actor card of the role they configure
 * (see overviewHtml's renderActors), so this is a description of the
 * configuration rather than of a panel: there is no second Agents section,
 * and there must not be one, because two places describing the same two
 * agents is one place too many to keep true.
 *
 * Every value is the engine's answer verbatim. The controls are a
 * convenience surface, not a replacement for the file: Settings still opens
 * the project's own `project.toml`, which remains where the whole
 * configuration is visible, and a change made here goes through the engine's
 * `set-config` rather than through anything in this extension that knows
 * TOML — because nothing in this extension does.
 */
export interface AgentConfigSection extends AgentConfigView {
  settings: { label: string; detail: string };
  /**
   * The project.toml a control was rendered from, absolute, as the engine
   * reported it. It travels with every mutation the webview posts and is
   * compared against the cockpit's current target before anything is
   * written, so a control left open across a repository switch cannot apply
   * itself to the repository that is now on screen.
   */
  scope?: string;
  /**
   * Said beside the controls while a managed run is executing. Configuration
   * is read when a turn is launched, so a change reaches the next one and
   * cannot reconfigure a provider process already running.
   */
  activeRunNote?: string;
}

/**
 * What one attempted inline configuration change did.
 *
 * `refused` means the cockpit itself declined -- the change named a
 * repository this window is no longer looking at. `error` is the engine's
 * own diagnostic for a change it would not make. Either way nothing was
 * written and the panel was re-rendered from the engine's actual state.
 */
export interface AgentConfigOutcome {
  applied: boolean;
  refused?: string;
  error?: string;
}

export const APPLIES_NEXT_TURN =
  "This run is active. A change here applies to the next agent turn; it does not affect a turn already running.";

export interface OverviewModel {
  kind: "empty" | "ambiguous" | "run";
  /** The plan the stage belongs to (managed run or associated file), for the header. */
  planName?: string;
  /** The checked-out branch is not this stage's; nothing that runs the engine is offered while it is set. */
  branchGuard?: BranchGuard;
  /**
   * The engine is waiting for permission to push a verified candidate. It
   * takes the place of `actionRequired`, because it is the reason the run is
   * stopped and it is a decision of a different kind — a permission, not a
   * test.
   */
  pushAuthorization?: PushAuthorization;
  /**
   * This run already has run-scoped push authorization recorded, so it will
   * not stop to ask again. Shown quietly, and read from the engine's own run
   * state — which is why it survives a reload: the choice was never kept
   * here.
   */
  autoPushEnabled?: { label: string; detail: string };
  /** Reviewer hand-back to the human; present only for NEEDS_YOU / ESCALATE with no turn in progress. */
  actionRequired?: ActionRequired;
  /**
   * This run owes manual verification a reviewer deferred, and is not at the
   * checkpoint for it yet.
   *
   * Said quietly and said always, because a stage accepted with a deferral
   * is accepted *and* still owes a check, and a panel that shows only the
   * first half claims the second. It is not an action: nothing is waiting on
   * the person here, and the journey continues.
   */
  deferredNote?: {
    label: string;
    detail: string;
    entries: { stageId: string; title: string; rationale: string }[];
  };
  title: string;
  /** `Plan run`, `Historical stage` or `Standalone stage`; see RUN_KIND. */
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
  /**
   * Hand the whole plan to the engine (automatic mode). Present only when
   * `agentSparring.planContinuation` is `automatic`, a plan is known and
   * nothing is running; see the function of the same name.
   */
  continueAutomatically?: { label: string; detail: string; primary: boolean; kind: "adopt" | "continue" };
  /**
   * This standalone stage is a stage of a managed plan run: what that run is,
   * and the one action that makes sense here — Back to plan run, which changes
   * the cockpit's selection to that run. Never a document action.
   */
  followPlan?: { runId: string; label: string; text: string; detail: string };
  /** An Accept stage operation from this window is in flight. */
  accepting?: { label: string; detail: string };
  /**
   * The Stop control, present only when there is an exact operation to
   * interrupt. It carries the execution id it was rendered for, so the
   * click acts on the runner the person was looking at and on no other.
   */
  runner?: { alive: boolean; label: string; executionId: string; detail: string };
  /**
   * The way out of a runner whose fate nothing could establish.
   *
   * `unknown` used to be a dead end: the runner could not be attributed, so
   * every action for the run was withheld — including the evidence
   * submission the person had already typed — with nothing on screen that
   * could settle it. This is the explicit human statement, and it names one
   * exact execution so a stale panel cannot settle a newer run's runner.
   */
  /**
   * The explicit way out of `unknown`, with both ids the confirmation acts on
   * baked into what was rendered: the execution whose liveness it ends, and
   * the duplicate guard whose release the person is taking responsibility for.
   * The operation id is carried rather than looked up when the click arrives,
   * so a panel left open while a newer run starts can only ever settle what it
   * was showing (`operationId` absent: there was no guard to release).
   */
  unknownRunner?: { label: string; detail: string; executionId?: string; operationId?: string };
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
  /**
   * Which repository the cockpit is in, and whether it got there by following
   * this window or by an explicit pin.
   *
   * Always present, and rendered at the *top* of the screen rather than in a
   * footer, because "which repository am I actually looking at" is the
   * question this whole screen answers. It is also the only place the contract
   * is stated: VS Code's own repository selector cannot be read by an
   * extension, so a person must be able to see what Agent Sparring resolved
   * instead of assuming it followed that selector.
   */
  repositoryContext?: RepositoryContextView;
  /** For empty: the sentences under the title (see activeRepository.emptyStateLines). */
  emptyLines?: string[];
  /** Plan journey: only for managed plan runs with a readable plan document. */
  timeline?: TimelineItem[];
  timelineNote?: string;
  /** `Stage 2 of 5` for plan runs. */
  position?: string;
  /**
   * The plan's own name for the current stage (`Stage 3D`), when the run
   * knows one. It is what a person calls the stage; the manifest ordinal is
   * an implementation detail of the execution order and belongs in
   * `positionNote`, not in the stage's apparent name.
   */
  stageLabel?: string;
  /** `6 of 8`: where the stage sits in the run, as secondary metadata. */
  positionNote?: string;
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
  /** Effective agent configuration and the Settings action; see AgentConfigSection. */
  agentConfig?: AgentConfigSection;
  facts?: { label: string; value: string }[];
}

const SETTINGS_ACTION = {
  label: "Settings",
  detail: "Open this project's .sparring/project.toml, where the provider, model and effort for both roles are set.",
};

/**
 * The section, or nothing at all.
 *
 * Nothing is shown when nobody asked the engine. When the engine answered,
 * the Settings action is offered even if the answer was an error or a
 * missing file — that is precisely when a person wants to open the file.
 */
function agentConfigSection(
  config: EffectiveConfig | undefined,
  active = false,
): AgentConfigSection | undefined {
  const view = agentConfigView(config);
  if (!view) {
    return undefined;
  }
  return {
    ...view,
    settings: SETTINGS_ACTION,
    scope: view.configPath,
    // Only said when it is true, and worded as a fact about when the change
    // lands rather than as a warning against making it. Nothing here blocks
    // the edit: the engine has no restriction to enforce, and inventing one
    // would be the cockpit deciding something it has no basis to decide.
    activeRunNote: active ? APPLIES_NEXT_TURN : undefined,
  };
}

/**
 * The same two cards, for a repository with no run yet.
 *
 * The cards are where model and effort are set, so they have to exist before
 * there is anything to run — that is exactly when someone configures a
 * project. They carry role, provider and nothing else: no activity word and
 * no session line, because there is no stage and inventing either would be
 * the cockpit describing a run that does not exist.
 */
function configOnlyActor(
  role: ConfigRole,
  section: AgentConfigSection | undefined,
): ActorCard | undefined {
  const controls = section?.controls.find((entry) => entry.role === role);
  if (!controls) {
    return undefined;
  }
  return {
    role: role === "stage" ? "Stage agent" : "Sparrer",
    configRole: role,
    provider: providerLabel(controls),
  };
}

const NO_ARTIFACTS: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };

export function buildOverviewModel(
  selection: RunSelection,
  rawLive: LiveState | undefined,
  artifacts: OverviewArtifacts = NO_ARTIFACTS,
  nowMs: number = Date.now(),
  execution?: ExecutionRecord,
): OverviewModel {
  const repositoryContext = describeRepositoryContext(selection);
  if (!selection.selected) {
    if (selection.ambiguous.length > 0) {
      return {
        kind: "ambiguous",
        title: "Several runs look active",
        choices: selection.ambiguous.map((run) => `${run.location.folderName}: ${runLabel(run)}`),
        repositoryContext,
      };
    }
    // A repository with no run yet is exactly where someone sets this up,
    // so the two role cards — and Settings — are reachable before the first
    // stage exists.
    const config = agentConfigSection(artifacts.agentConfig);
    return {
      kind: "empty",
      title: emptyStateTitle(selection),
      emptyLines: emptyStateLines(selection),
      repositoryContext,
      stageAgent: configOnlyActor("stage", config),
      sparrer: configOnlyActor("sparring", config),
      agentConfig: config,
    };
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
  const fresh = isFreshStage(run, stage, presentation, liveness);
  const manifest = manifestView(run, artifacts);
  const plan = planContext(run, stage, artifacts, manifest);
  const branchGuard = branchMismatch(run, artifacts);

  const model: OverviewModel = {
    kind: "run",
    title: run.kind === "plan" ? runLabel(run) : stageDisplayName(stage),
    repositoryContext,
    stageAgent: actorCard("stage", stage, live, halted, nowMs, uncertain, artifacts.capturedPrompts),
    sparrer: actorCard("sparrer", stage, live, halted, nowMs, uncertain, artifacts.capturedPrompts),
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
    agentConfig: agentConfigSection(
      artifacts.agentConfig,
      !halted && (liveness.state === "running" || liveness.turnActive),
    ),
    facts: facts(run, stage, artifacts.git, presentation, artifacts.associatedPlan, artifacts.siblingRepositories),
    goal: goal(artifacts, plan),
    activity: activityLine(live, halted, nowMs, uncertain),
    history: history(live),
    runKind: runKindWord(run, artifacts),
    status: fresh ? { label: "Ready to start", tone: "info" } : runStatus(run, presentation, liveness),
    liveness: { state: liveness.state, source: liveness.source, detail: liveness.detail },
    plan,
  };
  model.lastEvent = model.history?.[model.history.length - 1];
  if (liveness.interrupted) {
    model.activity = { kind: "stopped", text: liveness.execution?.kind === "run-sparring" ? "Stopped · independent review did not finish" : "Stopped · last turn interrupted" };
  } else if (liveness.stale) {
    model.activity = { kind: "stale", text: `${model.activity?.text ?? "Working"} · no meaningful activity for ${formatAge(nowMs - Date.parse(live?.lastMeaningful?.ts ?? live?.lastEventTs ?? ""))}` };
  }
  // Stop is offered only for a target that is positively this run's live
  // execution, and only for the execution the panel is actually showing:
  // the id is carried into the control and back on the click, so a panel
  // left open while a newer runner started cannot interrupt that one.
  // Asking twice is not offered either — the first request stands until
  // this exact execution is observed ending.
  if (liveness.state === "running" && liveness.stop === undefined && artifacts.stopTarget && artifacts.stopTarget.executionId === liveness.execution?.id) {
    model.runner = { alive: true, label: "Stop", executionId: artifacts.stopTarget.executionId, detail: STOP_DETAIL[artifacts.stopTarget.via] };
  }
  const loopEligible = run.kind === "plan" || (stage.state?.status !== "accepted" && stage.state?.status !== "frozen");
  // The exact question, asked once: is starting this run again a risk of
  // doing the same engine operation twice? The one authority on that is the
  // registry's `outstanding` (operationRegistry.ts), read when this panel
  // was built. It is true for a command a shell was given and never seen to
  // start, for anything restored from before a reload, and for anything
  // whose terminal is gone — every case in which nobody here can account
  // for what may be running.
  const guarded = artifacts.guardOutstanding === true;
  // The way out, wherever the run is being held: an execution whose fate
  // could not be established, a duplicate guard this window cannot account
  // for, or both at once.
  //
  // It is offered for the guard *on its own* as well, which it was not
  // before. Nothing withheld an action for a guard alone back then — the
  // person pressed Run, the registry refused the launch, and the refusal
  // dialog carried the override. Now the screen withholds the action, so
  // the screen has to carry the way out too, or an unaccountable guard
  // would be a dead end with nothing on it to press.
  if ((liveness.execution && liveness.execution.state === "unknown") || guarded) {
    const execution = liveness.execution?.state === "unknown" ? liveness.execution : undefined;
    model.unknownRunner = {
      label: "I checked — runner is no longer active",
      detail: `${UNKNOWN_RUNNER_EXPLANATION} Confirming records your statement: it releases this run's actions${execution ? " and lets you send your evidence again" : ""}. It does not claim the engine did, or did not, do anything.`,
      // Absent when there is no execution to end: then the only thing the
      // confirmation settles is the guard, and it says so rather than
      // naming an execution it would not be about.
      executionId: execution?.id,
      operationId: artifacts.guardedOperationId,
    };
  }
  if (artifacts.accepting) {
    model.accepting = { label: "Accepting stage…", detail: "sparring freeze-candidate, then sparring accept-candidate, are running in a terminal of this window." };
  } else if (!halted && loopEligible && liveness.state === "running") {
    // "Working" rests on positive current evidence that *this* execution is
    // alive: its shell execution has not ended, its dedicated terminal's
    // process has not exited, or its bound pid was found under it. Never on
    // the plan record saying `running`, on activity.jsonl having changed, or
    // on the launch having succeeded.
    model.busyState =
      liveness.stop === "requested"
        ? { label: "Stop requested…", detail: `${STOP_REQUESTED_DETAIL} ${liveness.detail}`, state: "running" }
        : { label: "Working", detail: liveness.detail, state: "running" };
  } else if (guarded || (!halted && loopEligible && liveness.turnActive)) {
    // Recorded as active, and neither alive nor ended can be established.
    // Two ways in, and they are said differently: the person asked for this
    // to stop and the answer never came, or nothing was asked and the run
    // simply cannot be accounted for. Both keep the guard, and the sentence
    // says so rather than implying a failure.
    model.busyState = {
      label: liveness.stop === "requested" ? "Stop requested · status unknown" : "Run status unknown",
      detail: `${liveness.stop === "requested" ? STOP_UNPROVEN_DETAIL : RUN_UNKNOWN_DETAIL} ${liveness.detail}`,
      state: "unknown",
    };
  } else if (liveness.state !== "running" && !guarded && !branchGuard) {
    // On the wrong branch nothing is offered: every loop command passes
    // --expected-branch and the engine's own guard would refuse the run.
    if (run.kind === "stage") {
      const actions = stageActions(run, liveness);
      model.stageAction = actions.primary;
      model.secondaryAction = actions.secondary;
    } else {
      model.planAction = planAction(run, liveness);
    }
  }
  model.branchGuard = branchGuard;

  if (run.kind === "plan") {
    Object.assign(model, timeline(run, manifest));
    const number = manifest ? manifest.at + 1 : (stage.number ?? run.state.currentStageIndex + 1);
    const total = manifest ? manifest.stages.length : run.planStages?.length;
    // The stage is named as the plan names it; where it sits in the run is
    // separate, secondary metadata. "Stage 6" was the manifest's execution
    // order wearing the stage's name.
    model.stageHeading = manifest ? `${manifest.current.label} — ${manifest.current.title}` : `Stage ${number} — ${stageDisplayName(stage)}`;
    model.stageLabel = manifest?.current.label;
    model.position = total ? `Stage ${number} of ${total}` : `Stage ${number}`;
    model.positionNote = total ? `${number} of ${total}` : undefined;
  } else {
    // A standalone stage that is matched to a plan section is called what the
    // plan calls it as well; its engine id stays in the tooltip and the
    // footer. `3c cloud schema rpc and sync transport` is a slug read aloud.
    //
    // A stage of a managed plan run is named by that run's own manifest, which
    // is the same authority the plan run's screen uses — so the two screens
    // call the stage the same thing, and only the run kind differs.
    const matched = plan?.source === "associated" ? plan : undefined;
    const managed = artifacts.managedPlanRun;
    const fromRun = managed?.memberLabel && managed.memberTitle ? `${managed.memberLabel} — ${managed.memberTitle}` : undefined;
    model.stageHeading = matched?.current ?? fromRun ?? stageDisplayName(stage);
    model.stageLabel = matched?.currentLabel ? `Stage ${matched.currentLabel}` : managed?.memberLabel;
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
    model.stageStatus = fresh ? "Ready to start" : presentation.label;
    model.stageStatusKind = presentation.kind;
    model.stageRaw = presentation.raw;
  }
  if (!halted && live?.currentCycle !== undefined) {
    model.cycle = live.currentCycle;
  }

  if (outcome) {
    model.lastSparring = { action: outcome.action, word: actionWord(outcome.action), summary: outcome.summary, reason: outcome.needsYouReason };
  }
  Object.assign(model, currentLine(run, stage, live, presentation, liveness, Boolean(artifacts.accepting), model.planAction, fresh));
  if (stage.state?.status === "accepted" && !(run.kind === "plan" && run.state.status === "complete")) {
    model.whatsNext = whatsNext(run, plan, artifacts, model.planAction);
  }
  model.planName = plan?.name;
  model.continueAutomatically = continueAutomatically(run, plan, artifacts, model, liveness);
  model.followPlan = followPlan(run, artifacts);
  if (model.followPlan) {
    // A managed run owns the sequencing of these stages. Adopting them a
    // second time, or creating a stage it has already created, are both
    // refusals waiting to happen — and when that run is *complete*, offering
    // to continue the plan from one of its finished stages is worse than
    // useless, because it would start a second run over work that is done.
    // The way forward, or back, is that run's own screen.
    delete model.continueAutomatically;
  }
  model.autoPushEnabled = autoPushEnabled(run);
  // Before the push gate's early return: what this run still owes is true
  // whatever else it happens to be stopped on, and a note that disappears
  // when another panel opens is a note that cannot be relied on.
  model.deferredNote = deferredNote(run, outcome);
  model.pushAuthorization = pushAuthorization(run, artifacts, model, branchGuard, liveness);
  if (model.pushAuthorization) {
    // The run is stopped on a permission, not on a review. Nothing that would
    // start work is offered beside it: continuing is exactly what Allow push
    // does, and a second route to it would either race the first or resume
    // into the same refusal.
    delete model.continueAutomatically;
    delete model.planAction;
    delete model.banner;
    return model;
  }
  model.actionRequired =
    deferredVerification(run, artifacts, model, branchGuard, liveness) ??
    actionRequired(run, presentation, outcome, plan, artifacts, model, branchGuard, liveness);
  if (model.actionRequired) {
    if (model.actionRequired.kind === "deferred_verification") {
      // The plan is at its own checkpoint. Resuming it is exactly what
      // submitting does, and a second route to it would resume into the same
      // pause with nothing answered.
      delete model.continueAutomatically;
      delete model.planAction;
    } else if (model.continueAutomatically?.kind === "adopt") {
      // Adopting is not answering the gate, and it does not touch it: the
      // engine reads the recorded NEEDS_YOU, keeps the pause exactly as it
      // stands and stops there. So it stays offered — this is the one place
      // a standalone stage can become a managed run, and hiding it here is
      // what made the mode undiscoverable — but never as the primary
      // action. Submit for review is still what moves this stage.
      model.continueAutomatically = { ...model.continueAutomatically, primary: false };
    } else {
      // A managed run at a gate needs nothing handed to it: it already owns
      // the sequencing and resumes itself once the gate is answered.
      delete model.continueAutomatically;
    }
    // The panel names and explains the action; no banner repeats it.
    delete model.banner;
    if (model.actionRequired.ready && model.actionRequired.kind !== "escalate") {
      // The recorded routing action is still NEEDS_YOU; what changed is that
      // every check it asked for now has an outcome. The pill says that, and
      // the panel's own headline is the only other place it is said.
      model.status = { label: "Evidence ready", tone: "info" };
    }
  }
  return model;
}

// ---------------------------------------------------------------- branch guard

/**
 * The recorded branch for this run against the checked-out one. A managed
 * plan run records `expected_branch` and the engine refuses every other
 * branch; a standalone stage records none, so the branch its last handoff
 * was generated on (handoff.py's `## Git context`) is the only written-down
 * answer. Undefined when nothing is recorded, when the checked-out branch
 * is unknown *and* nothing is recorded, or when the two agree.
 */
export function branchMismatch(run: RunSnapshot, artifacts: OverviewArtifacts): BranchGuard | undefined {
  // An accepted stage (or a finished plan) runs nothing, and the branch it
  // was written on may legitimately have been merged away since: warning
  // about the checkout there would be noise, not a guard.
  if (run.kind === "plan" ? run.state.status === "complete" : run.stage.state?.status === "accepted") {
    return undefined;
  }
  const expected =
    run.kind === "plan"
      ? { branch: run.state.expectedBranch, source: "plan-run" as const, detail: "The plan run was started for this branch (expected_branch in the engine's plan-run state); the engine refuses any other." }
      : artifacts.handoffText
        ? { branch: parseHandoffBranch(artifacts.handoffText), source: "handoff" as const, detail: "This stage's last recorded handoff was generated on that branch (## Git context in handoff.md); state.json records no branch." }
        : undefined;
  if (!expected?.branch?.trim()) {
    return undefined;
  }
  const actual = artifacts.git?.branch?.trim();
  if (actual === expected.branch.trim()) {
    return undefined;
  }
  if (actual === undefined && artifacts.git === undefined) {
    return undefined; // nothing was read about the repository: no claim either way
  }
  return { expected: expected.branch.trim(), actual, source: expected.source, detail: expected.detail };
}

// ---------------------------------------------------------------- push authorization

/**
 * The engine's typed request for permission to push, turned into the one
 * decision a person makes about it.
 *
 * Built **only** from `awaiting` in the engine's plan-run state — the run
 * itself recorded why it stopped, with the exact commit and remote ref
 * involved. Nothing here reads a reviewer's summary, a needs-you reason,
 * AGENTS.md or any prose, and nothing here runs git: a permission question
 * assembled by guessing at sentences is how a human "passed" a check that
 * authorized nothing.
 *
 * Withheld while a runner is alive (the engine is not waiting for anything),
 * while the branch is wrong (the engine refuses the resume outright), and
 * while a stage-accept operation of this window is in flight.
 */
function pushAuthorization(
  run: RunSnapshot,
  artifacts: OverviewArtifacts,
  model: OverviewModel,
  branchGuard: BranchGuard | undefined,
  liveness: RunnerLiveness,
): PushAuthorization | undefined {
  if (run.kind !== "plan" || run.state.status !== "paused") {
    return undefined;
  }
  const awaiting = run.state.awaiting;
  if (!awaiting || awaiting.kind !== PUSH_AUTHORIZATION_REQUIRED) {
    return undefined;
  }
  if (model.accepting || liveness.state === "running") {
    return undefined;
  }
  const target = `${awaiting.remote}/${awaiting.remoteBranch}`;
  // Git's own abbreviation, with no ellipsis: this is a commit id a person
  // will compare against `git log`, not a shortened session id.
  const shortSha = awaiting.candidateSha.slice(0, 7);
  const autoPushDraft = artifacts.autoPushDraft === true;
  let enabled = true;
  let detail = autoPushDraft
    ? `Pushes ${shortSha} to ${target} and lets this run push the candidates it verifies from here on, so it stops asking. Ordinary Git push of this branch; the engine then checks the commit really is there and accepts the stage as usual.`
    : `Pushes ${shortSha} to ${target} and continues. Ordinary Git push of this branch, nothing else; the engine then checks the commit really is there and accepts the stage as usual.`;
  if (branchGuard) {
    enabled = false;
    detail = `Switch to ${branchGuard.expected} first; the engine refuses to continue this run from another branch.`;
  } else if (liveness.turnActive) {
    enabled = false;
    detail = liveness.detail;
  }
  return {
    headline: "Push authorization required",
    text: `Candidate ${shortSha} is ready to push to ${target}.`,
    candidateSha: awaiting.candidateSha,
    shortSha,
    target,
    stageId: awaiting.stageId,
    allow: { label: "Allow push", enabled, detail },
    dismiss: {
      label: "Do not allow",
      detail: "Leaves this run exactly as it is: nothing is pushed, nothing is recorded, and the candidate is not accepted. You can push the branch yourself and continue the plan instead.",
    },
    autoPush: {
      label: "Auto-push future accepted candidates in this run",
      checked: autoPushDraft,
      detail: "Applies to this run only, and is recorded by the engine rather than remembered here. It covers the candidates this run verifies, on this branch, to this one remote branch — nothing else, and no other plan.",
    },
    technical: [
      { label: "Engine state", value: `awaiting.kind = ${awaiting.kind}` },
      { label: "Candidate commit", value: awaiting.candidateSha },
      { label: "Stage", value: awaiting.stageId },
      { label: "Local branch", value: awaiting.branch },
      { label: "Intended remote branch", value: `${awaiting.remote} refs/heads/${awaiting.remoteBranch}` },
      ...(awaiting.detail ? [{ label: "Why the gate refused it", value: awaiting.detail }] : []),
      { label: "What allowing does", value: "sparring resume-plan … --allow-push-candidate <commit>, plus --allow-push-for-run when the toggle is on. The engine performs the push; the extension never runs git push itself." },
    ],
  };
}

/**
 * This run has already been given run-scoped push authorization.
 *
 * Read from the engine's recorded state, which is the whole point: the
 * choice was made once, by a person, and it is the engine that remembers it
 * — so it is still true after a window reload, and it is still true in
 * another window.
 */
function autoPushEnabled(run: RunSnapshot): OverviewModel["autoPushEnabled"] {
  if (run.kind !== "plan" || run.state.pushAuthorization?.scope !== "run") {
    return undefined;
  }
  const authorization = run.state.pushAuthorization;
  return {
    label: "Auto-push is on for this run",
    detail: `Candidates this run verifies are pushed to ${authorization.remote}/${authorization.remoteBranch} without asking. Recorded by the engine for this run; it covers no other plan and no other branch.`,
  };
}

// ---------------------------------------------------------------- deferred verification checkpoint

/**
 * The plan's verification checkpoint: every stage accepted, and the manual
 * checks earlier reviewers deferred now due.
 *
 * Built **only** from the engine's own records — `awaiting` says the run is
 * stopped on this, and the ledger in the plan-run state says what is owed —
 * so nothing here is inferred from prose and nothing is derived from the
 * current stage's `sparring.md`, which by now belongs to a stage that
 * finished and was accepted.
 *
 * It is deliberately not phrased as a stage waiting for the human. No stage
 * is waiting; the plan is, and it is waiting on work the reviewers said
 * could be done at the end. The one interruption covers everything that
 * accumulated, with each check still naming the stage that raised it.
 */
function deferredVerification(
  run: RunSnapshot,
  artifacts: OverviewArtifacts,
  model: OverviewModel,
  branchGuard: BranchGuard | undefined,
  liveness: RunnerLiveness,
): ActionRequired | undefined {
  if (run.kind !== "plan" || run.state.status !== "paused") {
    return undefined;
  }
  const awaiting = run.state.awaiting;
  if (!awaiting || awaiting.kind !== DEFERRED_VERIFICATION_REQUIRED) {
    return undefined;
  }
  if (model.accepting || liveness.state === "running") {
    return undefined;
  }
  // Only the askings this pause named, in the engine's order, and only the
  // ones still in the ledger. A pause that names an asking the ledger no
  // longer holds is a state file this version cannot present honestly, so
  // that entry is skipped rather than invented.
  const obligations = awaiting.instanceIds
    .map((id) => run.state.deferredHumanChecks.find((entry) => entry.gate.instanceId === id))
    .filter((entry): entry is DeferredObligation => entry !== undefined);
  if (obligations.length === 0) {
    return undefined;
  }
  const view = deriveDeferredVerification(obligations, parseHumanEvidence(artifacts.notesText), artifacts.humanChecks ?? {});
  const groups: DeferredGroup[] = obligations.map((obligation) => ({
    instanceId: obligation.gate.instanceId as string,
    stageId: obligation.stageId,
    category: categoryWord(obligation.gate.category),
    title: obligation.gate.title,
    rationale: obligation.rationale,
    promoted: obligation.promoted,
    checkKeys: obligation.gate.checks.map((check) => draftKeyFor(check.id, obligation.gate.instanceId)),
  }));
  const stages = new Set(obligations.map((obligation) => obligation.stageId));
  const total = view.recorded.length + view.required.length;
  const failedChecks = obligations.flatMap((obligation) => obligation.results.filter((result) => result.outcome === "fail"));

  const submissionScope = stageScopeOf(run);
  const submission = sameStageScope(artifacts.submission && { runId: artifacts.submission.runId, stageId: artifacts.submission.stageId }, submissionScope) ? artifacts.submission : undefined;
  const inFlight = submission && !submission.failure && !submission.unresolved ? submission : undefined;
  const submitting = inFlight
    ? { label: "Submitting…", detail: "Your results are with the engine. Nothing is cleared until it finishes; if it fails, everything you entered is still here." }
    : undefined;

  const outstanding = view.required.filter((item) => !item.record?.outcome);
  let submitEnabled = false;
  let submitDetail: string;
  if (branchGuard) {
    submitDetail = `Switch to ${branchGuard.expected} first; the engine refuses to continue this run from another branch.`;
  } else if (view.required.length === 0) {
    submitDetail = "Every deferred check already has a recorded result in the engine's own ledger. There is nothing further to send.";
  } else if (!view.ready) {
    const names = checkNameList(outstanding);
    const which = names ? `the remaining ${outstanding.length === 1 ? "check" : "checks"} (${names})` : outstanding.length === 1 ? "the remaining check" : `all ${outstanding.length} remaining checks`;
    submitDetail = `Record a result for ${which} first. The plan finishes when every deferred check has been answered, so the results go together.`;
  } else if (submitting) {
    submitDetail = submitting.detail;
  } else if (blocked(model)) {
    submitDetail = blockedDetail(model);
  } else {
    submitEnabled = true;
    submitDetail =
      "Records each result against the asking it answers (sparring resume-plan --deferred-result) and lets the engine finish the plan. A Pass resolves its check; a Fail keeps the plan open and is written into the stage that raised it; Can't test records that no result could be obtained, which resolves nothing.";
  }

  const headline = total === 1 ? "Manual verification required" : `Manual verification required — ${total} deferred checks`;
  const subtitle =
    awaiting.reason === "promoted"
      ? `A later review decided ${stages.size === 1 ? "this check" : "these checks"} can wait no longer. The run stopped before the next stage.`
      : `${total} deferred ${total === 1 ? "check" : "checks"} from ${stages.size} earlier ${stages.size === 1 ? "stage" : "stages"}. Every stage is accepted; this is the verification the reviewers judged safe to leave until now.`;

  return {
    ...view,
    kind: "deferred_verification",
    word: "Verification owed",
    deferredGroups: groups,
    headline,
    subtitle,
    summary: failedChecks.length > 0
      ? `${failedChecks.length} deferred ${failedChecks.length === 1 ? "check has" : "checks have"} been recorded as failed. The plan will not complete until the behaviour is corrected and the check is answered again.`
      : subtitle,
    technical: [
      { label: "Engine state", value: `awaiting.kind = ${awaiting.kind}, reason = ${awaiting.reason}` },
      ...groups.map((group) => ({ label: `Gate instance (${group.stageId})`, value: group.instanceId })),
      { label: "What submitting does", value: "sparring resume-plan … --deferred-result '<gate instance>:<check id>=<pass|fail|blocked>[=note]'. The engine records it in its own ledger and in the originating stage's notes.md; the plan completes only once every obligation passes." },
    ],
    submit: { label: "Submit verification and finish", enabled: submitEnabled, detail: submitDetail },
    feedback: {
      draft: artifacts.humanFeedback?.trim() ? artifacts.humanFeedback : undefined,
      submitted: parseHumanFeedback(artifacts.notesText),
      send: {
        label: "Send feedback for review",
        enabled: false,
        detail: "Feedback goes to a reviewer about a candidate under review. There is no stage under review here: every stage is accepted and the plan is waiting on these results. Record a Fail with a note instead — it reaches the stage that raised the check.",
      },
    },
    submitting,
    planSection: false,
    review: artifacts.sparring,
  };
}

/**
 * The quiet counterpart, for a stage that was accepted *with* a deferral:
 * the review passed and a person still owes a check.
 *
 * Both halves are said, because "accepted" on its own would read as
 * "verified" and the whole point of a deferral is that it is not a waiver.
 * It is never a "waiting for you" state — nothing is waiting, and the plan
 * is already on the next stage.
 */
function deferredNote(run: RunSnapshot, outcome: SparringOutcome | undefined): OverviewModel["deferredNote"] {
  if (run.kind !== "plan") {
    return undefined;
  }
  const owed = run.state.deferredHumanChecks.filter((entry) => !obligationResolved(entry));
  if (owed.length === 0) {
    return undefined;
  }
  // Already at the checkpoint: the panel above states all of this, and
  // saying it twice would read as two separate things to do.
  if (run.state.awaiting?.kind === DEFERRED_VERIFICATION_REQUIRED) {
    return undefined;
  }
  const checks = owed.reduce((count, entry) => count + entry.gate.checks.length, 0);
  const raisedHere = outcome?.action === "READY" ? outcome.deferredHumanGate : undefined;
  return {
    label: `Review passed — ${checks} manual ${checks === 1 ? "check" : "checks"} deferred until plan completion`,
    detail: raisedHere
      ? `This stage's reviewer deferred "${raisedHere.gate.title}": ${raisedHere.rationale}`
      : `Raised by ${[...new Set(owed.map((entry) => entry.stageId))].join(", ")}. The engine will not report this plan complete until they are answered.`,
    entries: owed.map((entry) => ({ stageId: entry.stageId, title: entry.gate.title, rationale: entry.rationale })),
  };
}

// ---------------------------------------------------------------- action required (NEEDS_YOU / ESCALATE)

/**
 * Built when the recorded routing outcome hands the stage to the human and
 * no turn is acting on it: a standalone stage presenting Needs you /
 * Escalated, or a paused plan run whose current outcome is one of those.
 * The manual checks come from the matched plan section (managed: the
 * engine's current stage located in the document; associated: the same
 * match the plan context used); the reviewer's sentences are attached to
 * the check they overlap with, else listed as additional requests.
 */
function actionRequired(
  run: RunSnapshot,
  presentation: StagePresentation,
  outcome: SparringOutcome | undefined,
  plan: PlanContext | undefined,
  artifacts: OverviewArtifacts,
  model: OverviewModel,
  branchGuard: BranchGuard | undefined,
  liveness: RunnerLiveness,
): ActionRequired | undefined {
  if (!outcome || (outcome.action !== "NEEDS_YOU" && outcome.action !== "ESCALATE")) {
    return undefined;
  }
  const handedOver = run.kind === "plan" ? run.state.status === "paused" : presentation.kind === "needs_you" || presentation.kind === "escalate";
  if (!handedOver || model.accepting) {
    return undefined;
  }
  const kind = outcome.action === "NEEDS_YOU" ? "needs_you" : "escalate";
  const planText = run.kind === "plan" ? artifacts.planText : artifacts.associatedPlan?.text;
  const sectionLine = plan?.currentLine;
  // With a structured gate the reviewer already said exactly what blocks
  // this stage, so the plan is not consulted for checks at all.
  const checks = !outcome.humanGate && planText && sectionLine ? planChecks(planText, sectionLine) : { explicit: [], parents: [] };
  const view = deriveVerification(checks, outcome, parseHumanEvidence(artifacts.notesText), artifacts.humanChecks ?? {});
  let noChecks: string | undefined;
  if (view.recorded.length === 0 && view.required.length === 0) {
    if (!plan) {
      noChecks = "No plan is linked to this stage, so no plan checks can be listed, and the sparring report requests nothing specific. Choose plan… links one.";
    } else if (!planText) {
      noChecks = `The plan ${plan.name} could not be read.`;
    } else if (!sectionLine) {
      noChecks = plan.source === "associated" ? `Agent Sparring doesn't yet know which section of ${plan.name} is this stage. Match this stage… to list its manual checks.` : `The current stage could not be located in ${plan.name}.`;
    } else {
      noChecks = "The plan section for this stage lists no manual or human-gated checks, and the sparring report requests nothing specific.";
    }
  }
  const resume: ActionRequired["resume"] | undefined =
    run.kind === "plan"
      ? model.planAction
        ? { action: "resumePlan", label: model.planAction.label, detail: model.planAction.detail }
        : undefined
      : model.stageAction && model.stageAction.kind !== "accept"
        ? { action: "runStage", label: model.stageAction.label, detail: `sparring run-loop ${model.stageId ?? ""}: the stage agent implements again first, then the reviewer looks. Use it when there is work to do, not to hand over evidence.` }
        : undefined;
  const ready = view.ready;
  const outstanding = view.required.filter((item) => !item.record?.outcome);
  const pending = outstanding.length;
  const command =
    run.kind === "plan"
      ? "sparring resume-plan --evidence …: the engine records the evidence and continues the plan at this same stage"
      : `sparring run-sparring ${model.stageId ?? ""}: the recorded sparring session reads the evidence and rules again. The stage agent is not started.`;
  // In a managed plan the button describes what the person is doing —
  // recording their result so the run goes on — and the tooltip says who
  // reads it. Standalone, "Submit for review" is the whole of it.
  const submitLabel = run.kind === "plan" ? "Submit result and continue" : "Submit for review";
  let submitDetail: string;
  let submitEnabled = false;
  if (branchGuard) {
    submitDetail = `Switch to ${branchGuard.expected} first; the engine refuses to review a candidate from another branch.`;
  } else if (view.recorded.length === 0 && view.required.length === 0) {
    submitDetail = "No requested check is listed, so there is no recorded evidence to send.";
  } else if (view.required.length === 0) {
    // Every check of *this* asking is already recorded in notes.md, so there
    // is nothing left to send and the reviewer has it. Previously this state
    // enabled the button — `required.every(…)` is vacuously true over an
    // empty list — and Submit then refused with a message about remaining
    // checks it was itself reporting as done.
    submitDetail = "Every requested check already has a recorded result in notes.md. There is nothing further to send; the reviewer rules on what is already there.";
  } else if (!ready) {
    // The reviewer's own ids, when the checks have them: "all 2 remaining
    // checks" makes a person go and work out which two, and the names that
    // answer that are already recorded.
    const names = checkNameList(outstanding);
    const which = names ? `the remaining ${pending === 1 ? "check" : "checks"} (${names})` : pending === 1 ? "the remaining check" : `all ${pending} remaining checks`;
    submitDetail = `Record a result for ${which} first. Submitting asks the reviewer to rule on the evidence, so it goes when the evidence is complete.`;
  } else if (blocked(model)) {
    submitDetail = blockedDetail(model);
  } else {
    submitEnabled = true;
    submitDetail = `Records the drafted results under '## Human evidence' and asks the reviewer to rule on them (${command}). The reviewer decides; nothing is marked ready or accepted here.`;
  }
  // The freeform channel. It shares the submit path's guards — the wrong
  // branch and a live runner stop everything — but not its completeness rule:
  // a crash found on the way to the first check is exactly what has to reach
  // the reviewer *before* the checks are done.
  const draft = artifacts.humanFeedback?.trim() ? artifacts.humanFeedback : undefined;
  let sendEnabled = false;
  let sendDetail: string;
  if (branchGuard) {
    sendDetail = `Switch to ${branchGuard.expected} first; the engine refuses to review a candidate from another branch.`;
  } else if (!draft) {
    sendDetail = "Describe what you found in the field above first. It goes to the reviewer as it is written, against the unchanged candidate.";
  } else if (blocked(model)) {
    sendDetail = blockedDetail(model);
  } else {
    sendEnabled = true;
    sendDetail = `Records this text under '## Human evidence' as '${HUMAN_FEEDBACK_HEADING.replace(/^#+\s*/, "")}' and asks the reviewer to rule again on the unchanged candidate (${command}). It records no check result: ${pending === 0 ? "nothing is claimed about the checks either way" : `the ${pending === 1 ? "outstanding check stays outstanding" : `${pending} outstanding checks stay outstanding`}`}. The reviewer decides what follows — changes, the same checks again, or revised checks.`;
  }
  // A submission in flight, or one that failed. While the engine holds the
  // evidence neither button is offered — pressing Submit twice would ask the
  // reviewer to rule on the same thing twice — and when it comes back without
  // having recorded anything, the panel says so above the reviewer's own
  // checks, with every drafted result still where the user left it.
  // Belongs to this run *and* to the stage it is current at. A managed plan
  // run keeps one id from its first stage to its last, so a run check alone
  // let Stage 1's "Submission failed" sit on top of a healthy Stage 2 —
  // including one that arrived late, after the run had already advanced.
  // Both identities are the engine's own; nothing here compares titles,
  // positions or panel instances. See core/stageScope.ts.
  const submissionScope = stageScopeOf(run);
  const submission = sameStageScope(artifacts.submission && { runId: artifacts.submission.runId, stageId: artifacts.submission.stageId }, submissionScope) ? artifacts.submission : undefined;
  // A submission a person has settled as unresolved is not in flight: the
  // engine is not holding it, nobody knows what it did, and the whole point
  // of that statement is that the evidence may be sent again.
  const inFlight = submission && !submission.failure && !submission.unresolved ? submission : undefined;
  const submitting = inFlight
    ? {
        label: "Submitting…",
        detail: `${inFlight.results > 0 ? `${inFlight.results} result${inFlight.results === 1 ? "" : "s"} are` : "Your feedback is"} with the engine (${inFlight.channel === "checks" ? "to be recorded under '## Human evidence'" : "to be recorded as additional human feedback"}). Nothing is cleared until it finishes; if it fails, everything you entered is still here.`,
      }
    : undefined;
  // `resume-plan --evidence` records the evidence and *then* continues the
  // plan, which can run for a long time and fail at a later stage for reasons
  // that have nothing to do with this submission. So a failed execution whose
  // entry is nevertheless in notes.md — verbatim, as the engine appends it —
  // is not a lost submission, and is not reported as one. The drafts are kept
  // either way; those checks now read their outcome from the recorded
  // evidence, so nothing is claimed twice.
  const landed = Boolean(submission && artifacts.notesText?.includes(submission.entry.trim()));
  const failure = landed ? undefined : submission?.failure;
  const submissionFailure = failure && submission
    ? {
        preserved: SUBMISSION_PRESERVED,
        reason: failure.reason,
        what: submission.results > 0 ? `${submission.results} check result${submission.results === 1 ? "" : "s"} and any notes are still drafted below.` : "Your feedback is still in the field below.",
        error: failure.output,
      }
    : undefined;
  const unresolvedSubmission =
    submission?.unresolved && !landed
      ? {
          preserved: SUBMISSION_UNRESOLVED,
          reason: submission.unresolved.note,
          what: submission.results > 0 ? `${submission.results} check result${submission.results === 1 ? "" : "s"} and any notes are still drafted below.` : "Your feedback is still in the field below.",
        }
      : undefined;
  if (submitting) {
    submitEnabled = false;
    submitDetail = submitting.detail;
    sendEnabled = false;
    sendDetail = submitting.detail;
  }
  // The simple, gate-shaped presentation: the reviewer stated the
  // requirement, so it is shown once as their gate title and their note goes
  // to the details layer with the rest of their verbatim wording.
  const gateLayer = view.source === "gate" && kind === "needs_you" && view.recorded.length + view.required.length > 0;
  return {
    ...view,
    kind,
    word: actionWord(outcome.action),
    reviewFailure: reviewFailure(liveness),
    headline: headlineFor(view, kind, ready, gateLayer),
    subtitle: ready && kind === "needs_you" ? "All requested checks have evidence. Send it back to the independent reviewer." : undefined,
    summary: outcome.summary,
    reviewerNote: outcome.needsYouReason,
    gateTitle: gateLayer ? view.gate?.title : undefined,
    technical: technicalDetails(view, outcome, plan, sectionLine, { summaryShown: !ready, noteShown: !gateLayer }),
    noChecks,
    submit: { label: submitLabel, enabled: submitEnabled, detail: submitDetail },
    feedback: { draft, submitted: parseHumanFeedback(artifacts.notesText), send: { label: "Send feedback for review", enabled: sendEnabled, detail: sendDetail } },
    submitting,
    submissionFailure,
    submissionUnresolved: unresolvedSubmission,
    resume,
    planSection: Boolean(sectionLine && (run.kind === "plan" ? artifacts.plan : artifacts.associatedPlan?.exists)),
    review: artifacts.sparring,
  };
}

/**
 * What the panel calls itself. A structured gate is one concrete thing to
 * do, so it says so; the legacy derived path can be a mixture of plan prose
 * and reviewer requests, and keeps the older, vaguer title.
 */
function headlineFor(view: VerificationView, kind: "needs_you" | "escalate", ready: boolean, gateLayer: boolean): string {
  if (ready && kind === "needs_you") {
    return "Evidence ready for review";
  }
  if (gateLayer) {
    const total = view.recorded.length + view.required.length;
    return total === 1 ? "Manual check required" : `${total} manual checks required`;
  }
  return "Action required";
}

/**
 * The demoted layer: the reviewer's exact words, the engine's own vocabulary,
 * the ids a bug report needs, and where the check is defined. Everything here
 * used to be prerequisite reading in the main flow; none of it is needed to
 * perform the check, and all of it is needed when something looks wrong.
 */
function technicalDetails(
  view: VerificationView,
  outcome: SparringOutcome,
  plan: PlanContext | undefined,
  sectionLine: number | undefined,
  shown: { summaryShown: boolean; noteShown: boolean },
): TechnicalDetail[] {
  const out: TechnicalDetail[] = [{ label: "Routing action", value: outcome.action }];
  // Whatever the primary layer already says is not repeated here: reviewer
  // text is shown once, and this layer exists for what was left out of it.
  if (outcome.summary && !shown.summaryShown) {
    out.push({ label: "Reviewer's summary", value: outcome.summary });
  }
  if (outcome.needsYouReason && !shown.noteShown) {
    out.push({ label: "Reviewer's note", value: outcome.needsYouReason });
  }
  if (view.gate) {
    out.push({ label: "Gate category", value: view.gate.category });
    out.push({ label: "Gate title", value: view.gate.title });
  }
  const checks = [...view.required, ...view.recorded];
  const many = checks.length > 1;
  checks.forEach((check, at) => {
    const prefix = many ? `Check ${at + 1} ` : "Check ";
    if (view.source === "gate") {
      out.push({
        label: `${prefix}id`,
        value: check.gateId ?? `${check.key} (derived from the instruction: the reviewer's own id is not a shape this panel can round-trip)`,
      });
    }
    out.push({ label: `${prefix}instruction, verbatim`, value: check.text });
    if (check.passCriteria) {
      out.push({ label: `${prefix}pass criteria, verbatim`, value: check.passCriteria });
    }
    if (check.source) {
      out.push({ label: `${prefix}defined in`, value: check.source });
    }
    if (check.line !== undefined) {
      out.push({ label: `${prefix}plan line`, value: String(check.line) });
    }
  });
  if (view.source === "derived" && view.reviewerCount > 0) {
    out.push({
      label: "How these checks were derived",
      value: `${view.reviewerCount} of them come from the sparring report's own sentences, not from the plan; this verdict was recorded before the engine emitted structured gates.`,
    });
  }
  if (plan) {
    out.push({ label: "Plan", value: sectionLine ? `${plan.name}, line ${sectionLine}` : plan.name });
  }
  return out;
}

/**
 * Hand the whole plan to the engine and let it run.
 *
 * Offered when the user is in automatic mode (the default) and a plan
 * document is known — the engine's own for a managed run, the associated
 * file for a standalone stage. It is the *primary* next step whenever there
 * is a plan to continue: the point of the mode is that healthy stages need
 * no clicks, so Accept stage / Start next stage / Run stage become the
 * quieter alternatives rather than the path.
 *
 * Nothing is offered while a runner is alive or its liveness is unknown
 * mid-turn, when the branch is wrong, or when the managed run is complete.
 * Manual mode omits it entirely, which is exactly what that mode is for.
 */
function continueAutomatically(
  run: RunSnapshot,
  plan: PlanContext | undefined,
  artifacts: OverviewArtifacts,
  model: OverviewModel,
  liveness: RunnerLiveness,
): OverviewModel["continueAutomatically"] {
  if ((artifacts.continuation ?? "automatic") !== "automatic") {
    return undefined;
  }
  if (!plan || model.branchGuard || blocked(model) || model.accepting) {
    return undefined;
  }
  if (liveness.state === "running") {
    return undefined;
  }
  if (run.kind === "plan") {
    if (run.state.status === "complete") {
      return undefined;
    }
    // Which input the resume will use is the run's own recorded `source`,
    // never a choice this button makes — see commands.ts `planInvocationFor`.
    // Saying `--manifest` for a run the engine recorded as a Markdown one
    // described a command that would be refused, and was how the wrong one
    // came to be issued.
    const input = run.state.source === "manifest" ? "--manifest …" : `${plan.name}`;
    return {
      label: "Continue automatically",
      primary: true,
      kind: "continue",
      detail: `sparring resume-plan ${input}: the engine continues this managed run of ${plan.name} stage by stage, accepting each READY candidate through its own gate, and stops when it needs you.`,
    };
  }
  return {
    label: "Continue plan automatically",
    primary: true,
    kind: "adopt",
    detail: `Adopt the existing stages into a managed plan and continue until Agent Sparring needs you. (sparring run-plan --manifest … --adopt over ${plan.name}: accepted stages are verified and advanced past, this stage keeps its sessions and its recorded review, and the engine takes the sequencing from there.)`,
  };
}

/**
 * What kind of thing is on screen, in the plainest words there are.
 *
 * The vocabulary is the mental model and nothing else: a **plan run** is the
 * whole job, a **historical stage** is one old stage to inspect, and a **plan
 * document** is the specification. "Standalone" is the extension's own reason
 * for a stage record existing on its own, and a label is not the place for
 * it — the person reading the pill wants to know what they are looking at,
 * not why the harness has a separate record for it.
 *
 * Three kinds, never two: the middle one used to be indistinguishable from
 * the first — same layout, same pill, no timeline — which is how a complete
 * plan run looked like it had lost its stages. The third is the odd case, a
 * stage no plan run claims, and there the word earns its place: it is why
 * that screen may still offer to adopt the stage into a managed run.
 */
export const RUN_KIND = {
  plan: "Plan run",
  historicalStage: "Historical stage",
  standaloneStage: "Standalone stage",
} as const;

export function runKindWord(run: RunSnapshot, artifacts: OverviewArtifacts): string {
  if (run.kind === "plan") {
    return RUN_KIND.plan;
  }
  return artifacts.managedPlanRun ? RUN_KIND.historicalStage : RUN_KIND.standaloneStage;
}

/**
 * A standalone stage screen for a stage that belongs to a managed plan run of
 * the same project. That happens after a stage is adopted and the managed run
 * advances: the stage it left behind is an accepted stage of its own again,
 * and everything this screen would offer to sequence it by hand — Continue
 * plan automatically, Start next stage — belongs to that run. Say where the
 * work actually is, and offer the one way back.
 *
 * It holds for a run that has *finished* too, which is the case that caused
 * the reported confusion: a complete plan's stages were still being offered
 * for adoption into a new managed run, and the only route back to the
 * timeline was the run picker.
 *
 * `label` is deliberately not about opening a document: it changes which run
 * the cockpit follows. Open plan document / Open plan section are the actions
 * that open Markdown, and the two must never sound alike.
 */
function followPlan(run: RunSnapshot, artifacts: OverviewArtifacts): OverviewModel["followPlan"] {
  const managed = artifacts.managedPlanRun;
  if (run.kind !== "stage" || !managed) {
    return undefined;
  }
  const at = managed.stageLabel ? `${managed.stageLabel} (${managed.stageId})` : managed.stageId;
  const mine = managed.memberLabel ? `${managed.memberLabel} is one of its stages` : "This stage is one of its stages";
  const text =
    managed.status === "complete"
      ? `${managed.planName} is the managed plan run this stage belongs to, and the engine has completed it. ${mine}; this screen shows only that one stage.`
      : `${managed.planName} is being run by the engine as a managed plan run, now at ${at}. ${mine}, and this screen shows only that one.`;
  return {
    runId: managed.runId,
    label: "Back to plan run",
    text,
    detail: `Follow the managed plan run of ${managed.planName} (${managed.status}, currently ${at}) instead of this single stage. This changes what the Overview shows; it does not open the plan document.`,
  };
}

/**
 * The last observed run for this stage was a review (`run-sparring`) that
 * ended without succeeding. Only the process observation speaks here: which
 * command it was, and how it ended.
 */
function reviewFailure(liveness: RunnerLiveness): string | undefined {
  const execution = liveness.execution;
  if (!execution || execution.kind !== "run-sparring" || execution.state !== "ended" || execution.exitCode === 0) {
    return undefined;
  }
  const how = execution.exitCode === undefined ? "was interrupted or its terminal closed" : `exited with code ${execution.exitCode}`;
  return `The last review run ${how}. The stage and its candidate are unchanged, and the recorded evidence is still there: Submit for review tries the reviewer again.`;
}

/** Nothing may be launched: a runner is alive, or telemetry claims a turn nothing has observed ending. */
function blocked(model: OverviewModel): boolean {
  return model.busyState !== undefined || model.runner?.alive === true;
}

/**
 * What is said about a withheld action. When the reason is an unknown runner
 * it names the way out, because "its status is unknown" with nothing to press
 * is the dead end this panel had.
 */
function blockedDetail(model: OverviewModel): string {
  if (model.unknownRunner) {
    return `${UNKNOWN_RUNNER_EXPLANATION} Confirm it with "${model.unknownRunner.label}" above and this is offered again, with everything you entered still here.`;
  }
  if (model.busyState?.label === "Stop requested…") {
    return "You asked this runner to stop and it is still reported as running; this is offered again once it has actually ended.";
  }
  if (model.runner?.alive === true || model.busyState?.state === "running") {
    return "A runner is alive for this run; wait for it to finish.";
  }
  return `${UNKNOWN_RUNNER_EXPLANATION} ${RUN_UNKNOWN_DETAIL}`;
}

// ---------------------------------------------------------------- pieces

/**
 * A standalone stage that exists but has never run: state.json is `working`
 * with no session ids, sparring.md records no outcome, telemetry has seen no
 * turn and no runner is or was alive. Those recorded absences are what
 * "Ready to start" claims; nothing about the stage's readiness in any
 * other sense.
 */
function isFreshStage(run: RunSnapshot, stage: StageSnapshot, presentation: StagePresentation, liveness: RunnerLiveness): boolean {
  if (run.kind !== "stage" || !stage.exists || presentation.kind !== "working" || run.outcome) {
    return false;
  }
  if (liveness.interrupted || liveness.state === "running" || liveness.turnActive) {
    return false;
  }
  return !hasSessions(run, liveness.live);
}

function runStatus(run: RunSnapshot, presentation: StagePresentation, liveness: RunnerLiveness): RunStatus {
  // A run the person stopped, and whose runner has since been observed
  // ending, is named for what happened and for what can be done about it.
  // An ordinary completion and an ordinary failure keep their own words:
  // `stop` is set only when somebody actually asked.
  if (liveness.stop === "stopped") {
    return { label: "Stopped — ready to resume", tone: "warn" };
  }
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

function actorCard(role: "stage" | "sparrer", stage: StageSnapshot, live: LiveState | undefined, halted: boolean, nowMs: number, uncertain: boolean, captures: CapturedPrompt[] | undefined): ActorCard {
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
    configRole: role === "stage" ? "stage" : "sparring",
    provider: providerDisplayName(actor?.provider ?? (role === "stage" ? "claude-cli" : "codex-cli"), role),
    activity,
    duration,
    sessionLabel: shortenId(sessionId),
    sessionKind: role === "stage" ? "session" : "thread",
    quietFor,
    uncertain: activity === "Working" || activity === "Sparring" ? uncertain : undefined,
    // Built here so "this turn" versus "the last turn" rests on exactly the
    // liveness that decided the Working/Waiting word above, and the two can
    // never contradict each other on the same card.
    prompt: promptView(role, captures, activity === "Working" || activity === "Sparring"),
  };
}

/**
 * The captured prompt for this role's latest turn, as the card's view of it.
 *
 * The reviewing card falls back to the `reviewer` role: a review-only stage
 * runs no sparrer, and its independent actor is a fresh reviewer over an
 * already-accepted candidate set. Showing nothing there would hide the one
 * thing someone opens this card to check — whether the actor working right
 * now really is that reviewer and not a stage agent. The view it builds says
 * `Independent reviewer` rather than `Review turn`, so the two are never
 * mistaken for each other.
 */
function promptView(role: "stage" | "sparrer", captures: CapturedPrompt[] | undefined, busy: boolean): PromptView | undefined {
  if (!captures || captures.length === 0) {
    return undefined;
  }
  const indexed = captures.map((capture) => capture.entry);
  const entry = latestCapture(indexed, role) ?? (role === "sparrer" ? latestCapture(indexed, "reviewer") : undefined);
  if (!entry) {
    return undefined;
  }
  const captured = captures.find((capture) => capture.entry.seq === entry.seq && capture.entry.role === entry.role);
  if (!captured) {
    return undefined;
  }
  return buildPromptView(entry, captured.text, { live: busy });
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

/**
 * The manifest this managed run executes, resolved against the run.
 *
 * Only ever returned when the run's own recorded current stage is one of the
 * manifest's stages: the file on disk is regenerated from the plan, and a
 * generation that no longer contains the stage the engine is on describes a
 * different sequence. Saying nothing then is right — the engine's recorded
 * state is the authority, and a journey drawn from a mismatched file would be
 * a claim nothing supports.
 */
function manifestView(run: RunSnapshot, artifacts: OverviewArtifacts): ManifestView | undefined {
  if (run.kind !== "plan" || run.state.source !== "manifest") {
    return undefined;
  }
  const stages = artifacts.manifestStages;
  const at = stages?.findIndex((entry) => entry.stageId === run.state.currentStage) ?? -1;
  if (!stages || at < 0) {
    return undefined;
  }
  return { stages, at, current: stages[at] };
}

/**
 * The one-paragraph description of what this stage is for: the brief's
 * `## Goal`, else the brief's own opening description, else the plan
 * section's opening paragraph. When none of those exist the Overview says
 * nothing — a brief without a `## Goal` heading is a fact for diagnostics,
 * not a complaint to show someone who came here to answer a review.
 */
function goal(artifacts: OverviewArtifacts, plan: PlanContext | undefined): string | undefined {
  const fromBrief = artifacts.brief ? (parseBriefGoal(artifacts.briefText) ?? parseBriefOpening(artifacts.briefText)) : undefined;
  if (fromBrief) {
    return fromBrief;
  }
  const document = plan?.source === "managed" ? artifacts.planText : artifacts.associatedPlan?.text;
  return document && plan?.currentLine ? sectionSummary(document, plan.currentLine) : undefined;
}

function timeline(run: PlanRunSnapshot, manifest: ManifestView | undefined): Pick<OverviewModel, "timeline" | "timelineNote"> {
  if (manifest) {
    // The manifest is this run's plan: its stages, in its order, each with the
    // status the engine recorded for it.
    return {
      timeline: manifest.stages.map((stage, index) => ({
        number: index + 1,
        label: shortStageLabel(stage.label),
        title: stage.title,
        current: index === manifest.at,
        state: timelineStateOf(stage.status, index, manifest.at, run.state.status),
      })),
    };
  }
  if (!run.planStages || run.planStages.length === 0) {
    // A manifest run's stages are the manifest's, not the plan document's
    // `## Stage <n>` convention, so failing to read that convention says
    // nothing about the plan and must not be reported as if it did.
    if (run.state.source === "manifest") {
      return { timelineNote: "This run executes an execution manifest; its own list of stages could not be read here, so only the recorded stage is shown." };
    }
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

/** `Stage 3D` → `3D`; the journey node is already in a row of stages. */
export function shortStageLabel(label: string): string {
  return label.replace(/^stage\s+/i, "").trim() || label;
}

export function timelineState(stage: StageSnapshot, index: number, current: number, run: PlanRunSnapshot): TimelineState {
  return timelineStateOf(stage.state?.status, index, current, run.state.status);
}

export function timelineStateOf(status: StageStatus | undefined, index: number, current: number, planStatus: PlanRunState["status"]): TimelineState {
  if (status === "accepted") {
    return "accepted";
  }
  if (status === "frozen") {
    return "finalizing";
  }
  if (index === current) {
    return planStatus === "paused" ? "paused" : "active";
  }
  return index < current ? "working" : "future";
}

// ---------------------------------------------------------------- plan context

/**
 * Managed plan run: the next heading from the engine-parsed plan. Standalone
 * stage with an associated file: the document's headings, and this stage's
 * place in them only when one heading unambiguously matches.
 */
function planContext(run: RunSnapshot, stage: StageSnapshot, artifacts: OverviewArtifacts, manifest?: ManifestView): PlanContext | undefined {
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
    } else if (manifest && manifest.at + 1 < manifest.stages.length) {
      // The engine's next stage for a manifest run: the manifest's own next
      // entry, located in the document only to open it there.
      const entry = manifest.stages[manifest.at + 1];
      const label = shortStageLabel(entry.label);
      const inDocument = artifacts.planText ? buildStageIndex(parsePlanHeadings(artifacts.planText)).find((candidate) => candidate.label.toUpperCase() === label.toUpperCase())?.canonical : undefined;
      next = {
        display: `${entry.label} — ${entry.title}`,
        label,
        line: inDocument?.line ?? 0,
        summary: inDocument && artifacts.planText ? sectionSummary(artifacts.planText, inDocument.line) : undefined,
        defined: true,
      };
    }
    const headings = artifacts.planText ? parsePlanHeadings(artifacts.planText) : [];
    // A manifest run's stage is located by the label the manifest gave it
    // (`Stage 3D`), which is how the plan names it; a Markdown run's by the
    // engine's own numbering.
    const currentInDocument = manifest
      ? buildStageIndex(headings).find((entry) => entry.label.toUpperCase() === shortStageLabel(manifest.current.label).toUpperCase())?.canonical
      : headings.find((heading) => heading.label === String(stage.number ?? index + 1) && heading.title === stage.title);
    return {
      source: "managed",
      name: (artifacts.planText ? planTitle(artifacts.planText) : undefined) ?? run.state.plan,
      current: manifest ? `${manifest.current.label} — ${manifest.current.title}` : `Stage ${stage.number ?? index + 1} — ${stageDisplayName(stage)}`,
      currentLabel: manifest ? shortStageLabel(manifest.current.label) : undefined,
      currentLine: currentInDocument?.line,
      next,
      hasHeadings: Boolean(manifest || (stages && stages.length > 0)),
      hasStageLabels: Boolean(manifest || (stages && stages.length > 0)),
      note: "The engine's plan run: it records which stage is current and resume-plan continues it.",
    };
  }
  if (!associated) {
    return undefined;
  }
  const name = (associated.text ? planTitle(associated.text) : undefined) ?? basename(associated.path);
  const note = "Associated with this stage in VS Code for display only; the engine does not know about it. A following stage is created with the engine's own new-stage command, briefed with that stage's plan section.";
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
    // The stage's defining section when the plan has one; else the heading that was matched.
    currentLine: position ? (position.stage?.canonical ?? position.current).line : undefined,
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
  const proposal = entry && next.defined ? proposeNextStage(entry) : undefined;
  // `sparring new-stage` refuses a stage that exists, and a managed run
  // creates its own next stage: in both cases the button could only fail.
  const created = proposal && artifacts.existingStageIds?.includes(proposal.stageId) ? proposal.stageId : undefined;
  const start = created ? undefined : proposal;
  if (created) {
    return {
      kind: "next-created",
      heading: next.display,
      summary: next.summary,
      text: artifacts.managedPlanRun
        ? artifacts.managedPlanRun.status === "complete"
          ? `${next.display} already exists (${created}); the managed plan run that created it is complete.`
          : `${next.display} already exists (${created}); the managed plan run is sequencing it.`
        : `${next.display} already exists as ${created}, so there is nothing to create. Select that stage to work on it.`,
    };
  }
  if (start) {
    return { kind: "next-stage", heading: next.display, summary: next.summary, text: "Start next stage creates it with the engine, using this plan section as its brief. Run stage then begins implementation.", start };
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
  fresh = false,
): Pick<OverviewModel, "stageLine" | "banner"> {
  const outcome = run.kind === "plan" ? run.currentOutcome : run.outcome;
  const stageStatus = stage.state?.status;

  if (run.kind === "plan") {
    if (run.state.status === "complete") {
      const total = run.planStages?.length;
      return { stageLine: "All stages accepted.", banner: { kind: "done", text: `Plan complete${total ? ` — ${total} stage${total === 1 ? "" : "s"} accepted` : ""}` } };
    }
    if (run.state.status === "paused") {
      if (run.state.awaiting?.kind === DEFERRED_VERIFICATION_REQUIRED) {
        // Not "waiting for you" about a stage, because no stage is waiting:
        // every stage the plan could run is accepted, and what is left is
        // the verification earlier reviewers deliberately deferred.
        const owed = run.state.awaiting.instanceIds.length;
        return {
          stageLine:
            run.state.awaiting.reason === "promoted"
              ? "A later review decided a deferred check can wait no longer. Record the result and the plan continues."
              : "Every stage is accepted. The plan finishes once the deferred manual checks are answered.",
          banner: { kind: "warn", text: `Verification owed — ${owed} deferred ${owed === 1 ? "check" : "checks"}` },
        };
      }
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
    // A review run that died says so, even while the recorded outcome is
    // still NEEDS_YOU: the stage agent was never involved in it.
    if (liveness.interrupted && liveness.execution?.kind === "run-sparring") {
      return { stageLine: "The independent review did not finish. The stage and its candidate are unchanged." };
    }
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
    return { stageLine: liveness.execution?.kind === "run-sparring" ? "The independent review did not finish. The stage and its candidate are unchanged." : "The last run was interrupted." };
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
  if (fresh) {
    return { stageLine: "Ready to start. Run stage begins implementation." };
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
function facts(
  run: RunSnapshot,
  stage: StageSnapshot,
  git: GitContext | undefined,
  presentation: StagePresentation,
  associated: AssociatedPlan | undefined,
  siblings: DeclaredRepository[] | undefined,
): { label: string; value: string }[] {
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
  out.push(...siblingFacts(stage.state?.repositories ?? [], siblings ?? []));
  return out;
}

/**
 * The stage's candidate set beyond the primary repository, said exactly as
 * far as the data goes: a commit the engine pinned is a pin, a repository
 * the engine recorded without one is recorded, and one that so far exists
 * only as this window's declaration says so. Nothing here claims a sibling
 * was reviewed or is up to date.
 */
function siblingFacts(recorded: StateRepository[], declared: DeclaredRepository[]): { label: string; value: string }[] {
  const names = [...new Set([...recorded.map((entry) => entry.name), ...declared.map((entry) => entry.name)])].sort();
  return names.map((name) => {
    const pinned = recorded.find((entry) => entry.name === name);
    const local = declared.find((entry) => entry.name === name);
    const branch = pinned?.branch ?? local?.branch;
    const sha = pinned?.candidateSha ? shortenId(pinned.candidateSha) : undefined;
    const note = pinned ? (sha ? "pinned by the engine" : "recorded for this stage") : "declared in VS Code";
    return { label: "Also reviews", value: `${name}${branch ? ` on ${branch}` : ""}${sha ? ` @ ${sha}` : ""} (${note})` };
  });
}
