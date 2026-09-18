/**
 * Which managed plan run a standalone stage belongs to.
 *
 * Three things the UI must never let masquerade as each other:
 *
 *  - a **plan run** is the whole job: the engine's own `.sparring/plans/<key>.json`,
 *    with a position, a journey and `resume-plan` to continue it;
 *  - a **historical standalone stage** is one finished stage of that job,
 *    rediscovered on its own, good for inspection and nothing else;
 *  - a **plan document** is the Markdown specification, which opens in an editor.
 *
 * The second one exists for a mechanical reason: `discoverStandaloneStages`
 * only excludes the stage ids a plan run names in its own parsed stage list,
 * and the engine-shaped parser refuses a plan document that carries
 * `## Stage 3D handoff — …` records. Such a run therefore claims only its
 * *current* stage, and every other stage of the very same plan comes back as
 * a standalone run. A person then sees a screen that looks like the plan-run
 * screen but has no timeline, and is offered things the managed run already
 * did.
 *
 * The association that fixes it is the **execution manifest the extension
 * itself wrote for that run** (manifest.ts): it lists, for each stage the
 * engine was handed, the exact stage id and the label and title the plan gives
 * it. So membership is read off recorded data, never guessed from titles, and
 * a run whose manifest is unreadable simply has no members — there is no
 * fallback that invents one.
 *
 * ### What counts as recorded, and what does not
 *
 * Exactly three things establish membership, and all three are recorded
 * execution, not inference:
 *
 *  1. the run's **execution manifest**, validated against the run it is
 *     claimed to belong to (controller.manifestStagesFor / manifest.ts) — the
 *     answer for a `source: "manifest"` run, and the one that holds after the
 *     run has finished;
 *  2. the run's own recorded **current stage** (`state.json`);
 *  3. for a `source: "markdown"` run only, the **plan document's stage list**,
 *     because that list *is* what the engine executes for such a run: it
 *     parses the same headings into the same ids.
 *
 * What used to count and no longer does is a **stage-id prefix**. A stage id
 * beginning `<plan key>-stage-` merely looks like something that plan run
 * might have created; the engine records nothing to say that it did. Acting on
 * it turned unrelated stages into "Historical stage", hid their own actions
 * behind a plan run that had never executed them, and — on a plan that had
 * merely advanced — offered "Back to plan run" as the way out of a stage that
 * run did not own. The prefix is still used by `discoverStandaloneStages` for
 * the opposite, conservative purpose: keeping such a stage out of the
 * standalone list entirely.
 *
 * Unlike `supersedingPlanRun` (discovery.ts), which answers "has an *open*
 * managed run advanced past this stage, so the cockpit should follow it",
 * membership is a statement about identity and holds for a finished run too.
 * That difference is the point: the reported confusion was a *complete* plan
 * whose stages still offered to be adopted into a new managed run.
 *
 * No dependency on the vscode API.
 */

import { isOpenRun, type PlanRunSnapshot, type RunSnapshot, type StageOwnership, type StandaloneStageSnapshot } from "./discovery";
import type { PlanRunState } from "./engineFormats";
import type { ManifestStageIdentity } from "./manifest";

/** A plan run together with the stages of the manifest it executes, when that file could be read. */
export interface PlanRunMembers {
  run: PlanRunSnapshot;
  manifestStages?: readonly ManifestStageIdentity[];
}

/** What a standalone stage's own managed plan run is, and where the stage sits in it. */
export interface PlanMembership {
  /** The run id to select in order to see the plan run itself. */
  planRunId: string;
  /** The plan as a person names it: the document's title, else its file name. */
  planName: string;
  /** The engine's recorded status of the run. */
  planStatus: PlanRunState["status"];
  /** `Stage 3D`: what the plan calls this stage, when the manifest says. */
  stageLabel?: string;
  /** The plan's title for this stage, when the manifest says. */
  stageTitle?: string;
  /** 1-based position of this stage in the run's execution order, when known. */
  position?: number;
  /** How many stages the run executes, when known. */
  totalStages?: number;
  /** The stage the managed run is at now. */
  currentStageId: string;
  /** Its plan identity (`Stage 4`), when the manifest says. */
  currentStageLabel?: string;
}

/** The plan as a person names it: the document's own title, else its file name. */
export function planRunDisplayName(run: PlanRunSnapshot): string {
  const title = run.planDocumentTitle?.trim();
  return title || fileName(run.state.plan);
}

function fileName(label: string): string {
  return label.split(/[\\/]/).pop() ?? label;
}

/**
 * The managed plan run this standalone stage is a stage of, or undefined when
 * no discovered run claims it.
 *
 * Only runs of the same project are considered, and only recorded execution
 * claims a stage — see {@link claims}. Should two runs both claim it, an open
 * one wins, then the most recently written.
 */
export function planMembershipFor(stage: StandaloneStageSnapshot, plans: readonly PlanRunMembers[]): PlanMembership | undefined {
  const owners = plans
    .filter((candidate) => candidate.run.location.projectDir === stage.location.projectDir && claims(candidate, stage.stage.stageId))
    .sort((a, b) => Number(isOpenRun(b.run)) - Number(isOpenRun(a.run)) || b.run.stateMtimeMs - a.run.stateMtimeMs);
  const owner = owners[0];
  if (!owner) {
    return undefined;
  }
  const stages = owner.manifestStages;
  const at = stages?.findIndex((entry) => entry.stageId === stage.stage.stageId) ?? -1;
  const member = at >= 0 ? stages?.[at] : undefined;
  return {
    planRunId: owner.run.id,
    planName: planRunDisplayName(owner.run),
    planStatus: owner.run.state.status,
    stageLabel: member?.label,
    stageTitle: member?.title,
    position: at >= 0 ? at + 1 : undefined,
    totalStages: stages?.length,
    currentStageId: owner.run.currentStage.stageId,
    currentStageLabel: stages?.find((entry) => entry.stageId === owner.run.currentStage.stageId)?.label,
  };
}

/**
 * Whether this plan run recorded that stage as one of its own. Three sources,
 * all of them recorded execution; see the module header for what was removed
 * and why.
 */
function claims(candidate: PlanRunMembers, stageId: string): boolean {
  if (candidate.manifestStages?.some((entry) => entry.stageId === stageId)) {
    return true;
  }
  if (candidate.run.currentStage.stageId === stageId) {
    return true;
  }
  // The plan document's stage list is the engine's own execution order for a
  // markdown run, and means nothing for a manifest run — there the engine
  // executes the manifest, and these ids are not the ones it used.
  return candidate.run.state.source === "markdown" && candidate.run.stages.some((entry) => entry.stageId === stageId);
}

/** Membership of every standalone stage among `runs`, keyed by run id; runs with no owner are absent. */
export function planMemberships(runs: readonly RunSnapshot[], plans: readonly PlanRunMembers[]): Map<string, PlanMembership> {
  const out = new Map<string, PlanMembership>();
  for (const run of runs) {
    if (run.kind !== "stage") {
      continue;
    }
    const membership = planMembershipFor(run, plans);
    if (membership) {
      out.set(run.id, membership);
    }
  }
  return out;
}

/**
 * Membership for every standalone stage of a discovery, resolving each plan
 * run's manifest through the caller's reader (the extension's cached one).
 * One code path for the Overview, the run picker and the diagnostic, so the
 * three can never disagree about whose stage a stage is.
 */
export async function resolveMemberships(
  runs: readonly RunSnapshot[],
  manifestStages: (run: PlanRunSnapshot) => Promise<readonly ManifestStageIdentity[] | undefined>,
): Promise<Map<string, PlanMembership>> {
  const plans = runs.filter((run): run is PlanRunSnapshot => run.kind === "plan");
  const members = await Promise.all(plans.map(async (run) => ({ run, manifestStages: await manifestStages(run) })));
  return planMemberships(runs, members);
}

/**
 * The same answer reduced to identity: which plan run owns each standalone
 * stage. `selectRun` needs the edge and none of the display fields, and taking
 * it from here is what keeps "has a plan run taken over from this stage?" and
 * "whose stage is this?" from ever being answered differently.
 */
export function stageOwnership(memberships: ReadonlyMap<string, PlanMembership>): StageOwnership {
  return new Map([...memberships].map(([runId, membership]) => [runId, membership.planRunId]));
}
