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
 * two-space indent here, and `source_digest` over the plan text so an
 * *edited* plan does change it.
 *
 * No dependency on the vscode API.
 */

import * as crypto from "node:crypto";
import { renderNextStageBrief, type NextStageProposal } from "./nextStage";
import { buildStageIndex, parsePlanHeadings, type PlanHeading, type StageEntry } from "./planAssociation";
import { slugify } from "./engineFormats";
import { STAGE_ID_RE } from "./nextStage";

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
 */
export function buildManifest(input: ManifestInput): ManifestBuild {
  const headings = parsePlanHeadings(input.markdown);
  const index = buildStageIndex(headings);
  const known = new Map((input.known ?? []).map((entry) => [entry.label.toUpperCase(), entry.stageId]));
  const problems: ManifestProblem[] = [];
  const skipped: ManifestProblem[] = [];
  const stages: ManifestStage[] = [];

  for (const entry of index) {
    if (entry.ambiguous) {
      problems.push({ label: entry.label, reason: `${entry.display} is defined in more than one section, so which one to run cannot be decided.` });
      continue;
    }
    if (!entry.canonical || !entry.title) {
      skipped.push({ label: entry.label, reason: describeSkip(entry) });
      continue;
    }
    const stageId = known.get(entry.label.toUpperCase()) ?? proposeStageId(entry);
    if (!stageId) {
      problems.push({ label: entry.label, reason: `No usable stage id could be formed for ${entry.display}.` });
      continue;
    }
    const proposal: NextStageProposal = { stageId, label: entry.label, title: entry.title, display: entry.display, line: entry.canonical.line };
    const rendered = renderNextStageBrief(input.markdown, proposal, input.planName);
    if (!rendered.ok) {
      problems.push({ label: entry.label, reason: rendered.message });
      continue;
    }
    const repositories = input.repositories?.[entry.label.toUpperCase()];
    stages.push({
      stage_id: stageId,
      label: `Stage ${entry.label}`,
      title: entry.title,
      brief: rendered.brief,
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

/** SHA-256 of the plan document exactly as it was read; opaque provenance for the engine. */
export function sourceDigest(markdown: string): string {
  return `sha256:${crypto.createHash("sha256").update(markdown, "utf8").digest("hex")}`;
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

/** A stable file name for one plan's manifest, so regenerating it overwrites in place. */
export function manifestFileName(planKey: string): string {
  return `${planKey}.manifest.json`;
}
