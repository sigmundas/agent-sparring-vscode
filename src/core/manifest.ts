/**
 * Turning a human plan document into an execution manifest the engine runs.
 *
 * The architectural line this file sits on: **the Markdown plan is a human
 * document, the extension interprets it, and the Python engine executes.**
 * Everything interpretive happens here — identifying canonical stages,
 * ordering labels like `3A`/`3B`/`3C`, excluding historical handoff
 * sections, honouring the user's manual stage matches, extracting the exact
 * brief — and the result is a flat, explicit list. Everything about
 * *running* it — sequencing, the implementation/sparring loop, SEND_BACK,
 * the NEEDS_YOU pause, evidence resume, freezing, acceptance, advancing,
 * completion, the persisted position — stays in the engine, which already
 * has one state model for it.
 *
 * So a manifest carries no status, no position, no verdict and no session.
 * It is input, not a second workflow engine.
 *
 * Determinism matters twice over: the file is regenerated on every
 * invocation, and the engine refuses to continue a recorded run whose
 * manifest digest changed. So the same plan, matches and stage ids must
 * always produce byte-identical JSON — hence the fixed key order and the
 * two-space indent here.
 *
 * `source_digest` is a hash of the plan text, and because the engine folds it
 * into that identity it is carried forward across rebuilds whenever the
 * manifest still executes the same thing — see {@link carriedForward}.
 * Without that, appending a handoff record to the plan document ends the run.
 *
 * No dependency on the vscode API.
 */

import * as crypto from "node:crypto";
import { renderNextStageBrief, type NextStageProposal } from "./nextStage";
import { buildStageIndex, parsePlanHeadings, type PlanHeading, type StageEntry } from "./planAssociation";
import { slugify } from "./engineFormats";
import { humanizeStageId } from "./presentation";
import { STAGE_ID_RE } from "./nextStage";
import type { StageMode } from "./stageModes";

export const MANIFEST_VERSION = 1;

export interface ManifestRepository {
  name: string;
  path: string;
  branch: string;
  candidate_sha: string | null;
}

export interface ManifestStage {
  stage_id: string;
  /** `Stage 3C`: display only; the array order is the execution order. */
  label: string;
  title: string;
  /** The exact `brief.md` content the engine will write. */
  brief: string;
  /**
   * What kind of stage this is (stageModes.ts). Emitted only for
   * `independent_review`: `implementation` is the engine's default, so
   * writing it would change no behaviour and would only make the file
   * noisier. Never derived from the title or the brief — see stageModes.ts
   * for why that line matters.
   */
  mode?: "independent_review";
  repositories?: ManifestRepository[];
}

export interface ExecutionManifest {
  version: number;
  plan_label: string;
  source_digest: string;
  stages: ManifestStage[];
}

/** How an existing stage of this project is known to belong to a plan label. */
export interface KnownStage {
  /** The plan stage label (`3C`) this stage id is that project's stage for. */
  label: string;
  stageId: string;
  /**
   * That stage's own `brief.md`, supplied only when the stage has real
   * execution history (it is accepted, or holds a session or a candidate).
   * It is then used verbatim instead of the plan's current section — see
   * "Briefs of stages that have already run" below.
   */
  brief?: string;
}

export interface ManifestInput {
  /** The plan document's text. */
  markdown: string;
  /** Repo-relative POSIX path of the plan (cli.ts: planLabel). */
  planLabel: string;
  /** Display name used inside each brief's header line (the plan's file name). */
  planName: string;
  /** Stage ids already in use for particular plan labels, so history stays visible. */
  known?: KnownStage[];
  /** Sibling repositories a given plan label's stage reviews alongside the primary one. */
  repositories?: Record<string, ManifestRepository[]>;
  /**
   * Stages the user declared as review-only, keyed the same way
   * (`modeLabelKey`). Absent labels run the implementation lifecycle, which
   * is the engine's default and what every manifest written before modes
   * existed means.
   */
  modes?: Record<string, StageMode>;
}

/** One stage the plan defines but that cannot be executed as written. */
export interface ManifestProblem {
  label: string;
  reason: string;
}

export type ManifestBuild = { ok: true; manifest: ExecutionManifest; skipped: ManifestProblem[] } | { ok: false; problems: ManifestProblem[]; skipped: ManifestProblem[] };

/**
 * Build the manifest for a plan document.
 *
 * Which headings become stages: the logical stage index (planAssociation.ts)
 * in workflow-label order, keeping only stages that have a *canonical*
 * section. A stage the plan merely mentions — a `## Stage 3B handoff —
 * 2026-09-12 (accepted at …)` record, a status note — has no canonical
 * section and is skipped, because there is no definition to brief from; it
 * stays visible in the document and in `skipped`, and is never executed.
 *
 * Which id each stage gets: the id that project *already* uses for that
 * label, when one is known, so an existing sequence keeps its history and
 * its recorded sessions; otherwise the same `stage-<label>-<slug>` id
 * "Start next stage" would have proposed, so manual and automatic mode
 * agree.
 *
 * A stage the plan defines ambiguously (several plausible definitions), or
 * whose section has a heading but no content, or whose id would be unusable,
 * is a hard problem: the whole manifest is refused rather than executing a
 * guess.
 *
 * ### Briefs of stages that have already run
 *
 * A stage that has real execution history is briefed from its *own*
 * `brief.md` (supplied as `KnownStage.brief`), not from the plan's section
 * for it. That brief is the contract the work was actually implemented and
 * reviewed against; the plan section is a living document and is routinely
 * rewritten afterwards to record what was built. Re-extracting it would make
 * the manifest claim the stage was briefed with text it never saw, and the
 * engine — which compares an existing started stage's brief against the plan
 * input's — would refuse to adopt the sequence unless the stage were deleted
 * or the plan rolled back. Both are wrong: the history is the point.
 *
 * So one manifest describes both. Stages that already ran keep their briefs
 * verbatim; stages that do not exist yet are briefed from the plan's current
 * section, which is exactly what "Start next stage" would have written. A
 * preserved stage is kept in the list even if its heading has since become a
 * historical record, because nothing has to be extracted from the plan for
 * it — dropping it would silently shorten the sequence instead.
 */
export function buildManifest(input: ManifestInput): ManifestBuild {
  const headings = parsePlanHeadings(input.markdown);
  const index = buildStageIndex(headings);
  const known = new Map((input.known ?? []).map((entry) => [entry.label.toUpperCase(), entry]));
  const problems: ManifestProblem[] = [];
  const skipped: ManifestProblem[] = [];
  const stages: ManifestStage[] = [];

  for (const entry of index) {
    const existing = known.get(entry.label.toUpperCase());
    // Ambiguity is a hard problem whatever the stage's history: which stage
    // of the plan this *is* must be certain before anything is executed.
    if (entry.ambiguous) {
      problems.push({ label: entry.label, reason: `${entry.display} is defined in more than one section, so which one to run cannot be decided.` });
      continue;
    }
    const preserved = existing?.brief;
    if (!preserved && (!entry.canonical || !entry.title)) {
      skipped.push({ label: entry.label, reason: describeSkip(entry) });
      continue;
    }
    const stageId = existing?.stageId ?? proposeStageId(entry);
    if (!stageId) {
      problems.push({ label: entry.label, reason: `No usable stage id could be formed for ${entry.display}.` });
      continue;
    }
    let brief = preserved;
    if (brief === undefined) {
      const proposal: NextStageProposal = { stageId, label: entry.label, title: entry.title as string, display: entry.display, line: (entry.canonical as PlanHeading).line };
      const rendered = renderNextStageBrief(input.markdown, proposal, input.planName);
      if (!rendered.ok) {
        problems.push({ label: entry.label, reason: rendered.message });
        continue;
      }
      brief = rendered.brief;
    }
    const repositories = input.repositories?.[entry.label.toUpperCase()];
    const mode = input.modes?.[entry.label.toUpperCase()];
    stages.push({
      stage_id: stageId,
      label: `Stage ${entry.label}`,
      title: entry.title ?? titleOf(entry, stageId),
      brief,
      ...(mode === "independent_review" ? { mode } : {}),
      ...(repositories && repositories.length > 0 ? { repositories } : {}),
    });
  }

  if (problems.length > 0) {
    return { ok: false, problems, skipped };
  }
  if (stages.length === 0) {
    return { ok: false, problems: [{ label: "", reason: "The plan defines no stage with a section to run." }], skipped };
  }
  const duplicates = stages.map((stage) => stage.stage_id).filter((id, at, all) => all.indexOf(id) !== at);
  if (duplicates.length > 0) {
    return { ok: false, problems: [{ label: "", reason: `Two stages would use the same stage id (${[...new Set(duplicates)].join(", ")}).` }], skipped };
  }
  return {
    ok: true,
    manifest: { version: MANIFEST_VERSION, plan_label: input.planLabel, source_digest: sourceDigest(input.markdown), stages },
    skipped,
  };
}

/**
 * A display title for a preserved stage whose plan heading no longer defines
 * it (it became a handoff record, say). The heading's own words first, then
 * the stage id read back as words; display only, and the engine never parses
 * it.
 */
function titleOf(entry: StageEntry, stageId: string): string {
  const heading = entry.occurrences[0]?.title?.trim();
  return heading || humanizeStageId(stageId);
}

/** Why a stage of the plan yields nothing executable, said in the plan's own terms. */
function describeSkip(entry: StageEntry): string {
  const where = entry.occurrences.map((heading: PlanHeading) => heading.display).join(", ");
  return entry.occurrences.length === 0
    ? `Stage ${entry.label} has no section.`
    : `Stage ${entry.label} appears only as a record of what happened (${where}), not as a section defining the work.`;
}

/** The `stage-<label>-<slug>` id "Start next stage" would propose, so both modes agree on identity. */
function proposeStageId(entry: StageEntry): string | undefined {
  const slug = slugify(entry.title ?? "");
  const stageId = `stage-${entry.label.toLowerCase()}${slug ? `-${slug}` : ""}`.slice(0, 128).replace(/-+$/, "");
  return STAGE_ID_RE.test(stageId) ? stageId : undefined;
}

/**
 * Stages that would be *created* in the middle of a sequence that is already
 * under way — the shape of an existing stage the extension failed to
 * recognise.
 *
 * A stage id is only carried over when the stage could be located in the
 * plan unambiguously, and a deliberately conservative match sometimes finds
 * nothing: an old brief that mentions three stage numbers in its opening
 * paragraph matches none of them. The stage then keeps its history on disk
 * while the manifest proposes a fresh id for that label, and adopting the
 * run would re-implement accepted work under a new stage.
 *
 * Reading it as an ordering question is what makes it safe to act on: a
 * missing stage *before* one that exists is a sequence with a hole in it,
 * whereas everything after the last existing stage is simply the future.
 * Unrelated stages of other plans are never consulted, so nothing here
 * misfires on a project that has run several plans.
 */
export function adoptionGaps(manifest: ExecutionManifest, existing: ReadonlySet<string>): ManifestStage[] {
  let last = -1;
  manifest.stages.forEach((stage, at) => {
    if (existing.has(stage.stage_id)) {
      last = at;
    }
  });
  return manifest.stages.slice(0, Math.max(last, 0)).filter((stage) => !existing.has(stage.stage_id));
}

/** SHA-256 of the plan document exactly as it was read; opaque provenance for the engine. */
export function sourceDigest(markdown: string): string {
  return `sha256:${crypto.createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

/**
 * Keep the provenance of an unchanged manifest, so editing the plan's *prose*
 * does not end a run.
 *
 * The engine folds `source_digest` into the manifest digest that identifies a
 * recorded run (manifest.py: `manifest_digest`), and refuses to continue when
 * that digest changes. `source_digest` is the hash of the whole plan
 * document — every byte, including the historical `## Stage 3D handoff — …`
 * records this very file deliberately excludes from execution, and the
 * narrative sections the engine's own `plan_digest` docstring says do not
 * count ("Prose outside the stage sections does not count").
 *
 * The consequence was a real managed run refused mid-flight: two handoff
 * records were appended to the plan and a status paragraph was updated, not
 * one executable stage changed, and `resume-plan --evidence` answered *the
 * executable content of … has changed since this run started* — discarding
 * the submission that carried five human check results.
 *
 * So provenance is carried forward: when the manifest that would be written
 * executes exactly what the manifest on disk executes — same version, same
 * plan label, same stages in the same order with the same ids, labels, titles,
 * briefs and repositories — it keeps that file's `source_digest` instead of
 * taking a fresh hash of the plan text. The run's identity then tracks what it
 * runs, which is what the guard is for.
 *
 * Protection is unchanged in the other direction: any difference in what
 * would execute — a reworded stage section that becomes a different brief, a
 * retitled stage, a new or reordered stage, a changed sibling repository —
 * takes the new digest and the engine refuses, exactly as before.
 */
export function carriedForward(next: ExecutionManifest, existing: string | undefined): ExecutionManifest {
  const previous = readManifest(existing);
  if (!previous || !executesTheSame(previous, next)) {
    return next;
  }
  return { ...next, source_digest: previous.source_digest };
}

/** True when two manifests would run the same thing; `source_digest` is provenance and is not compared. */
function executesTheSame(a: ExecutionManifest, b: ExecutionManifest): boolean {
  return a.version === b.version && a.plan_label === b.plan_label && JSON.stringify(a.stages) === JSON.stringify(b.stages);
}

/** A manifest file as it is on disk, or undefined when it is absent or not one. */
function readManifest(text: string | undefined): ExecutionManifest | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as ExecutionManifest;
    const usable = typeof parsed?.version === "number" && typeof parsed.plan_label === "string" && typeof parsed.source_digest === "string" && Array.isArray(parsed.stages);
    return usable ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The manifest as the file the engine reads. Key order is fixed by the
 * interfaces above and `JSON.stringify`, so the same inputs always produce
 * the same bytes — which is what lets the extension regenerate the file on
 * every invocation without invalidating the run it is continuing.
 */
export function renderManifest(manifest: ExecutionManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The identity of one manifest stage, as the Overview needs it back. */
export interface ManifestStageIdentity {
  stageId: string;
  /** `Stage 3D`: what a person calls this stage. */
  label: string;
  title: string;
}

/**
 * Read back the stages of a manifest this extension wrote, for display.
 *
 * A manifest run's stages are not the plan document's `## Stage <n>`
 * headings, so without this the Overview can only call the current stage by
 * its position in the execution order — "Stage 6" for what everyone involved
 * calls Stage 3D — and can draw no journey at all.
 *
 * Lenient about absence, strict about certainty: a missing file, another
 * version, or an entry without an id, label and title yields nothing rather
 * than a partial list, because a half-read journey would misstate where the
 * run is. The caller checks that the run's recorded current stage is among
 * the stages before showing any of it.
 */
export function readManifestStages(text: string | undefined): ManifestStageIdentity[] | undefined {
  if (!text) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const payload = raw as Record<string, unknown>;
  if (payload["version"] !== MANIFEST_VERSION || !Array.isArray(payload["stages"]) || payload["stages"].length === 0) {
    return undefined;
  }
  const out: ManifestStageIdentity[] = [];
  for (const entry of payload["stages"] as unknown[]) {
    if (!entry || typeof entry !== "object") {
      return undefined;
    }
    const stage = entry as Record<string, unknown>;
    const stageId = typeof stage["stage_id"] === "string" ? stage["stage_id"].trim() : "";
    const label = typeof stage["label"] === "string" ? stage["label"].trim() : "";
    const title = typeof stage["title"] === "string" ? stage["title"].trim() : "";
    if (!stageId || !label || !title) {
      return undefined;
    }
    out.push({ stageId, label, title });
  }
  return out;
}

/** A stable file name for one plan's manifest, so regenerating it overwrites in place. */
export function manifestFileName(planKey: string): string {
  return `${planKey}.manifest.json`;
}
