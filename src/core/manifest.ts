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
 * ### Reading one back, and the authority boundary
 *
 * The same file is also the only record of *which stages a plan run executed*,
 * so the Overview reads it back to name a stage, draw a journey and decide
 * whether a rediscovered stage is that run's history. That is a much stronger
 * claim than "a file for this plan exists", and the second half of this module
 * draws the line:
 *
 *     global-storage manifest  =  candidate evidence
 *     run state + executable digest + worktree identity  =  authority
 *
 * {@link parseExecutionManifest} reimplements the engine's own parser and
 * `manifest_digest`, so the extension can ask the only question that settles
 * it — *is this the manifest the run recorded?* — and
 * {@link bindParsedManifest} refuses everything that cannot answer yes. The
 * worktree, which no digest can distinguish, is stated in a sidecar
 * ({@link ManifestBindingRecord}). Anything missing or uncertain degrades to
 * no membership.
 *
 * No dependency on the vscode API.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
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
  /**
   * The key of the run instance this manifest is for, which fresh stage ids
   * are namespaced by (`<run key>-stage-<label>-<slug>`).
   *
   * An input rather than something derived here, because it *cannot* be
   * derived: a run key identifies one execution of the plan, and the same
   * document may be executed again tomorrow. Whoever starts the run mints
   * it, writes it into these stage ids, and passes it to `run-plan
   * --run-key` so the engine files the run under the same key.
   */
  runKey: string;
  /**
   * Stage ids **this run** already uses for particular plan labels, so its
   * own history stays visible. Only stages that provably belong to this run
   * may appear here; another run's stages are not this run's history —
   * whether that run executed a different document or the same one — and
   * supplying them is how a new run ends up adopting work it never did.
   */
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
 * Which id each stage gets: the id this *run* already uses for that label,
 * when one is known, so a run being continued keeps its history and its
 * recorded sessions; otherwise a fresh `<run-key>-stage-<label>-<slug>` id,
 * namespaced to this run.
 *
 * That namespace is load-bearing, not cosmetic. Two ordinary workflows
 * depend on it: finishing one plan and starting a follow-up one on the same
 * branch, whose sections may well be numbered Stage 1..3 again; and running
 * the *same* plan document a second time. In both, the new run's stages must
 * be new work rather than an earlier run's accepted history under a
 * colliding name. `known` is scoped to this run for the same reason: see
 * `knownStageIds` in commands.ts, which decides what "already uses" is
 * allowed to mean.
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
  const key = input.runKey;
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
    const stageId = existing?.stageId ?? proposeStageId(entry, key);
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

/**
 * The id a stage of *this run* gets: `<run-key>-stage-<label>-<slug>`.
 *
 * The run key is the namespace that makes execution-stage identity
 * `(run instance, stage)` rather than a project-global directory name, and
 * it is the engine's own convention for a managed run's stages (plan.py:
 * `_stage_id_for`, which prefixes exactly this way for a Markdown plan
 * run). Without it, two runs in one worktree that both define "Stage 1 —
 * Foundation" generate the same id and the second run's Stage 1 lands on the
 * first run's accepted directory — which is the bug this prefix closes,
 * before the engine's ownership refusal ever has to.
 *
 * Note that it is the *run* key and not the plan key. Namespacing by the
 * document would keep two different plans apart but not two runs of one
 * plan, and re-running a plan document is ordinary work.
 *
 * Deliberately *not* the unprefixed `stage-<label>-<slug>` that
 * `proposeNextStage` still uses. That is the id of a hand-driven standalone
 * stage, which belongs to no plan run and is exactly what adoption takes
 * over; a managed run's stage is a different thing and now says so. An
 * existing run keeps whichever ids it already uses, prefixed or not, via
 * `KnownStage`.
 */
function proposeStageId(entry: StageEntry, runKey: string): string | undefined {
  const slug = slugify(entry.title ?? "");
  const stageId = `${runKey}-stage-${entry.label.toLowerCase()}${slug ? `-${slug}` : ""}`.slice(0, 128).replace(/-+$/, "");
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

/** A manifest read back from disk, with the fields that say *whose* it is. */
export interface ManifestIdentity {
  /** `plan_label`: the repo-relative plan path this manifest executes. */
  planLabel: string;
  /** `source_digest`: provenance of the plan text it was built from. */
  sourceDigest: string;
  stages: ManifestStageIdentity[];
}

/**
 * A manifest file parsed under the engine's own rules, with the digest the
 * engine would record for it.
 *
 * Keeping the two together is deliberate: the digest is only meaningful for a
 * manifest the engine would actually accept, so nothing can compute one from a
 * half-read file.
 */
export interface ParsedManifest {
  identity: ManifestIdentity;
  /**
   * The engine's `manifest_digest` (manifest.py) for this file — the value it
   * writes as `plan_digest` when a run starts from it, and the value it
   * re-checks on every resume.
   */
  digest: string;
}

// ---------------------------------------------------------------------------
// the engine's executable identity, recomputed here
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["version", "plan_label", "source_digest", "stages"]);
const STAGE_KEYS: ReadonlySet<string> = new Set(["stage_id", "label", "title", "brief", "mode", "repositories"]);
const REPOSITORY_KEYS: ReadonlySet<string> = new Set(["name", "path", "branch", "candidate_sha"]);
const STAGE_MODES: ReadonlySet<string> = new Set(["implementation", "independent_review"]);

// ---------------------------------------------------------------------------
// three places where JavaScript's own semantics are the wrong contract
// ---------------------------------------------------------------------------

/**
 * Every code point Python's `str.strip()` removes, which is **not** the set
 * JavaScript's `String.prototype.trim()` removes.
 *
 * The engine trims with `str.strip()` (`manifest.py: _text`), so that set is
 * the contract, and `trim()` differs from it in both directions:
 *
 *  - Python strips and JavaScript does not: U+001C…U+001F (the four ASCII
 *    separator controls) and **U+0085** (NEL). A title of `"\u0085Cloud"`
 *    reaches the engine's digest as `"Cloud"` and reached ours as
 *    `"\u0085Cloud"` — a different digest for the same file, which is exactly
 *    the divergence that makes a run's manifest unreadable or, worse, makes an
 *    unrelated one look readable.
 *  - JavaScript strips and Python does not: **U+FEFF** (ZWNBSP), which ES
 *    spec-lists in `WhiteSpace` and `str.isspace()` does not. A BOM-wrapped
 *    title digests verbatim in the engine and was silently stripped here.
 *
 * The set is generated from the engine's own runtime — every `c` where
 * `chr(c).isspace()` is true, Python 3.14 — and pinned rather than derived
 * from a JavaScript Unicode property, because no JavaScript property matches
 * it: Python's rule is "bidirectional class WS, B or S, or category Zs", and
 * the separator controls come from the `B`/`S` classes alone.
 *
 * It is written as code points and not as characters in a string literal. An
 * invisible character in source is exactly what an editor, a formatter or a
 * careless edit changes without anyone noticing, and this list is a contract
 * with another language.
 */
const PYTHON_WHITESPACE: ReadonlySet<string> = new Set(
  [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, // tab, newline, vertical tab, form feed, carriage return
    0x1c, 0x1d, 0x1e, 0x1f, // file, group, record and unit separators — Python whitespace, not JavaScript whitespace
    0x20, // space
    0x85, // NEL — the divergence that changed digests
    0xa0, 0x1680, // no-break space, Ogham space mark
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, // line and paragraph separators
    0x202f, 0x205f, 0x3000,
    // Deliberately absent: U+FEFF, which JavaScript trims and Python does not.
  ].map((code) => String.fromCharCode(code)),
);

/** Python's `str.strip()`, exactly. Never `trim()`: see {@link PYTHON_WHITESPACE}. */
export function pythonStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PYTHON_WHITESPACE.has(value[start])) {
    start++;
  }
  while (end > start && PYTHON_WHITESPACE.has(value[end - 1])) {
    end--;
  }
  return value.slice(start, end);
}

/**
 * Whether the engine's `version` check would pass: `payload.get("version") !=
 * 1` in Python.
 *
 * Python compares *values*, and `True == 1`, so the engine accepts
 * `"version": true` — as it accepts `1.0`, and refuses `false`, `0` and
 * `"1"`. This extension used `!== 1`, which refused `true`, so a manifest the
 * engine runs happily had no digest here and its run lost its stage list.
 *
 * Parity is the rule and not a preference: the digest computed here is
 * compared against a `plan_digest` the engine wrote, so a file this side
 * refuses is a run this side cannot describe. `true` is a wart in the engine's
 * contract rather than a feature, and tightening it is a change to the engine
 * that has to happen there, in a change that moves both sides at once.
 */
function acceptedVersion(value: unknown): boolean {
  return value === MANIFEST_VERSION || value === true;
}

/**
 * The UTF-8 bytes of one digest part, or `undefined` when Python could not
 * produce them.
 *
 * `digest_planned_stages` does `part.encode("utf-8")`, and Python raises
 * `UnicodeEncodeError` on an unpaired surrogate — which `json.loads` will
 * happily produce from a `"\ud800"` escape. Node's `Buffer.from(…, "utf8")`
 * instead substitutes U+FFFD, so the extension used to hand out a confident
 * digest for a manifest the engine cannot digest at all.
 *
 * A value the engine cannot digest must never be given an authoritative
 * digest here, so this returns `undefined` and the whole parse fails: such a
 * file can never be the manifest a recorded run executes, because the engine
 * would have raised before recording anything.
 */
function utf8Bytes(part: string): Buffer | undefined {
  for (let at = 0; at < part.length; at++) {
    const unit = part.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = at + 1 < part.length ? part.charCodeAt(at + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return undefined; // high surrogate with no low surrogate after it
      }
      at++;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return undefined; // low surrogate with no high surrogate before it
    }
  }
  return Buffer.from(part, "utf8");
}

/** One manifest stage as the engine's parser normalises it, which is what its digest is taken over. */
interface ExecutableStage {
  /** `_text`: trimmed, and valid as a single path segment (stage.py: `validate_stage_id`). */
  stageId: string;
  label: string;
  title: string;
  /** Not trimmed: the engine digests the brief exactly as written, because that is what it writes to `brief.md`. */
  brief: string;
  /** Only the non-default mode contributes, exactly as in `manifest_digest`. */
  mode?: "independent_review";
  repositories: { name: string; path: string; branch: string; candidateSha: string | null }[];
}

interface ExecutableManifest {
  planLabel: string;
  sourceDigest: string;
  stages: ExecutableStage[];
}

/**
 * Parse a manifest file exactly as the engine parses it, and compute the
 * identity the engine records for it.
 *
 * This is a reimplementation of `agent_sparring/manifest.py` — `parse_manifest`
 * and `manifest_digest` — and it is deliberately not "a similar hash". The
 * value it produces is compared against `plan_digest` in the engine's own
 * `.sparring/plans/<key>.json`, so any divergence would either reject a run's
 * real manifest or accept one the engine never ran. What that means in
 * practice:
 *
 *  - **The validation is the engine's.** Unknown top-level, stage or
 *    repository keys are refused rather than ignored, the version must be 1,
 *    `plan_label`/`source_digest`/`stage_id`/`label`/`title` must be non-empty
 *    strings and are trimmed, `brief` must be non-empty but is digested
 *    verbatim, `mode` must be one the engine knows, repository names must be
 *    unique, and stage ids must be unique and usable as one path segment. A
 *    file the engine would refuse has no digest here either, so it can never
 *    be read as membership.
 *  - **The digest content is the engine's.** SHA-256 over NUL-terminated
 *    parts (`plan_model.digest_planned_stages`): the version, the plan label
 *    and the source digest, then per stage in order its id, label, title and
 *    brief, a *non-default* mode, and each declared repository's name, path,
 *    branch and candidate SHA (`""` when null). A stage in the default
 *    implementation mode contributes nothing for its mode — that is the
 *    engine's rule, and copying it is what keeps manifests written before
 *    modes existed digesting to the value their recorded runs hold.
 *
 * `source_digest` is *provenance* of the plan text (see {@link sourceDigest})
 * and is a different concept: it is one input to this digest, never a
 * substitute for it.
 */
export function parseExecutionManifest(text: string | undefined): ParsedManifest | undefined {
  const executable = readExecutableManifest(text);
  if (!executable) {
    return undefined;
  }
  // A manifest the engine would accept but could not *digest* (an unpaired
  // surrogate anywhere in it) has no identity to compare against a recorded
  // run, so it yields nothing rather than a digest only this side can compute.
  const digest = digestOf(executable);
  if (digest === undefined) {
    return undefined;
  }
  return {
    identity: {
      planLabel: executable.planLabel,
      sourceDigest: executable.sourceDigest,
      stages: executable.stages.map((stage) => ({ stageId: stage.stageId, label: stage.label, title: stage.title })),
    },
    digest,
  };
}

/** The digest of a manifest this extension has just built, taken through the same path a reader takes. */
export function manifestDigest(manifest: ExecutionManifest): string | undefined {
  return parseExecutionManifest(renderManifest(manifest))?.digest;
}

/** The engine's `manifest_digest`, or `undefined` when Python's own encode step would raise. */
function digestOf(manifest: ExecutableManifest): string | undefined {
  const parts: string[] = [String(MANIFEST_VERSION), manifest.planLabel, manifest.sourceDigest];
  for (const stage of manifest.stages) {
    parts.push(stage.stageId, stage.label, stage.title, stage.brief);
    if (stage.mode) {
      parts.push(stage.mode);
    }
    for (const repository of stage.repositories) {
      parts.push(repository.name, repository.path, repository.branch, repository.candidateSha ?? "");
    }
  }
  const digest = crypto.createHash("sha256");
  for (const part of parts) {
    const bytes = utf8Bytes(part);
    if (bytes === undefined) {
      return undefined;
    }
    digest.update(bytes);
    digest.update(NUL);
  }
  return digest.digest("hex");
}

const NUL = Buffer.from([0]);

function readExecutableManifest(text: string | undefined): ExecutableManifest | undefined {
  const payload = asObject(text);
  if (!payload || unknownKeys(payload, TOP_LEVEL_KEYS) || !acceptedVersion(payload["version"])) {
    return undefined;
  }
  const planLabel = requiredText(payload["plan_label"]);
  const sourceDigest = requiredText(payload["source_digest"]);
  const raw = payload["stages"];
  if (planLabel === undefined || sourceDigest === undefined || !Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const stages: ExecutableStage[] = [];
  for (const entry of raw) {
    const stage = readExecutableStage(entry);
    if (!stage) {
      return undefined;
    }
    stages.push(stage);
  }
  if (!unique(stages.map((stage) => stage.stageId))) {
    return undefined;
  }
  return { planLabel, sourceDigest, stages };
}

function readExecutableStage(entry: unknown): ExecutableStage | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const payload = entry as Record<string, unknown>;
  if (unknownKeys(payload, STAGE_KEYS)) {
    return undefined;
  }
  const stageId = requiredText(payload["stage_id"]);
  const label = requiredText(payload["label"]);
  const title = requiredText(payload["title"]);
  const brief = payload["brief"];
  if (stageId === undefined || label === undefined || title === undefined) {
    return undefined;
  }
  if (!STAGE_ID_RE.test(stageId) || stageId === "." || stageId === "..") {
    return undefined;
  }
  // `brief` is validated as non-empty under Python's strip and then digested
  // verbatim, because that is the byte-for-byte content the engine writes to
  // `brief.md` (`manifest.py: _stage`).
  if (typeof brief !== "string" || !pythonStrip(brief)) {
    return undefined;
  }
  const mode = readMode(payload["mode"]);
  if (mode === false) {
    return undefined;
  }
  const repositories = readRepositories(payload["repositories"]);
  if (!repositories) {
    return undefined;
  }
  return { stageId, label, title, brief, ...(mode ? { mode } : {}), repositories };
}

/** `undefined` for the default implementation mode, the mode itself for the other, `false` for one the engine refuses. */
function readMode(raw: unknown): "independent_review" | undefined | false {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    return false;
  }
  const mode = pythonStrip(raw);
  if (!STAGE_MODES.has(mode)) {
    return false;
  }
  return mode === "independent_review" ? "independent_review" : undefined;
}

function readRepositories(raw: unknown): ExecutableStage["repositories"] | undefined {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const out: ExecutableStage["repositories"] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const payload = entry as Record<string, unknown>;
    if (unknownKeys(payload, REPOSITORY_KEYS)) {
      return undefined;
    }
    // Validated as non-empty, but digested as written: the engine keeps these
    // three verbatim (`stage.py: CandidateRepository.from_dict`).
    const [name, repoPath, branch] = [payload["name"], payload["path"], payload["branch"]];
    if (!isNonEmptyString(name) || !isNonEmptyString(repoPath) || !isNonEmptyString(branch)) {
      return undefined;
    }
    const sha = payload["candidate_sha"];
    if (sha !== undefined && sha !== null && typeof sha !== "string") {
      return undefined;
    }
    out.push({ name, path: repoPath, branch, candidateSha: typeof sha === "string" ? sha : null });
  }
  return unique(out.map((repository) => repository.name)) ? out : undefined;
}

function asObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function unknownKeys(payload: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(payload).some((key) => !allowed.has(key));
}

/** The engine's `_text`: a string that is non-empty once Python-stripped, returned stripped. */
function requiredText(value: unknown): string | undefined {
  return isNonEmptyString(value) ? pythonStrip(value) : undefined;
}

/**
 * The engine's `not isinstance(value, str) or not value.strip()`.
 *
 * Python's strip, never `trim()`: a repository name of `"\\u0085"` is empty to
 * the engine and was not empty here, and one of `"\\ufeff"` is the other way
 * round. `CandidateRepository.from_dict` validates with this rule and then
 * keeps the value **verbatim**, so the two must not be conflated.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && pythonStrip(value).length > 0;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

// ---------------------------------------------------------------------------
// binding a manifest to a run and a worktree
// ---------------------------------------------------------------------------

/**
 * The extension's own record of which worktree a manifest in global storage
 * was written for, kept beside the manifest and never inside it.
 *
 * It is a *sidecar* because the manifest is the engine's payload: the engine
 * refuses a manifest that carries a field it does not know, so extension-only
 * metadata cannot go in the file itself without breaking the contract it
 * exists to satisfy. And it is needed because nothing inside the engine's
 * payload identifies the worktree — `plan_label` is repo-relative, and a
 * stage's `repositories` name *sibling* repositories, not the primary one. Two
 * worktrees of the same repository running `docs/plans/foo.md` therefore write
 * byte-identical manifests, and their recorded plan-run state is identical
 * too.
 *
 * So the worktree is stated here, as a resolved absolute path, together with
 * the manifest file it vouches for and that file's executable digest. A reader
 * requires all three to agree before it treats the manifest as this run's; the
 * *file name* proves nothing on its own, whatever it hashes.
 */
export interface ManifestBindingRecord {
  version: number;
  /** Base name of the manifest this record vouches for. */
  manifestFile: string;
  /** `path.resolve`d project directory of the worktree that wrote it. */
  projectDir: string;
  planKey: string;
  planLabel: string;
  /** The executable digest of the manifest as written (see {@link parseExecutionManifest}). */
  manifestDigest: string;
}

export const BINDING_VERSION = 1;

export function renderBindingRecord(record: ManifestBindingRecord): string {
  return `${JSON.stringify(
    {
      version: record.version,
      manifest_file: record.manifestFile,
      manifest_digest: record.manifestDigest,
      plan_key: record.planKey,
      plan_label: record.planLabel,
      project_dir: record.projectDir,
    },
    null,
    2,
  )}\n`;
}

export function readBindingRecord(text: string | undefined): ManifestBindingRecord | undefined {
  const payload = asObject(text);
  if (!payload || payload["version"] !== BINDING_VERSION) {
    return undefined;
  }
  const manifestFile = requiredText(payload["manifest_file"]);
  const manifestDigest = requiredText(payload["manifest_digest"]);
  const planKey = requiredText(payload["plan_key"]);
  const planLabel = requiredText(payload["plan_label"]);
  const projectDir = requiredText(payload["project_dir"]);
  if (!manifestFile || !manifestDigest || !planKey || !planLabel || !projectDir) {
    return undefined;
  }
  return { version: BINDING_VERSION, manifestFile, manifestDigest, planKey, planLabel, projectDir };
}

/**
 * What a manifest must match before it may describe a run's stages.
 *
 * A manifest is only ever *written* by this extension, into global storage,
 * and global storage is per-user, not per-worktree or per-machine-state. So a
 * file being there is not evidence that it belongs to the run being displayed,
 * and neither is its name. The manifest in global storage is **candidate
 * evidence**; the authority is the run's own recorded state, the executable
 * digest and the worktree identity, and every one of them is checked:
 *
 *  - the plan label must be the one the run records as executing, so a
 *    manifest for another plan can never be read as this one's stage list;
 *  - the manifest's **executable digest** must equal the `plan_digest` the
 *    engine recorded for the run. This is the check that makes membership
 *    authoritative rather than plausible: a regenerated manifest that keeps
 *    the plan label and the current stage but adds, removes or rewrites any
 *    other stage executes something else, digests to something else, would be
 *    refused by the engine on the next resume — and is refused here too,
 *    before it can move a historical stage between runs;
 *  - the run's recorded current stage must still be one of the manifest's
 *    stages, which is what a truncated or otherwise surprising file fails;
 *  - the sidecar binding record must name this worktree, this manifest file
 *    and this digest (see {@link ManifestBindingRecord}), because the digest
 *    and the recorded state are *identical* between two worktrees running the
 *    same plan and cannot tell them apart.
 *
 * Any check that is missing or uncertain degrades to no membership. Nothing
 * here guesses at historical ownership.
 */
export interface ManifestExpectation {
  /** The plan label the run records (`PlanRunState.plan`). */
  planLabel: string;
  /** The stage the run records itself as being at (`PlanRunState.currentStage`). */
  currentStageId: string;
  /** The identity the engine recorded for what this run executes (`PlanRunState.planDigest`). */
  planDigest: string;
  /** The worktree the run belongs to, resolved. */
  projectDir: string;
  /** The manifest file name this run reads, which the binding record must vouch for. */
  manifestFile: string;
}

/** Why a manifest on disk was not accepted as a run's stage list; for the log and the diagnostic. */
export type ManifestRejection = "unreadable" | "plan-label" | "plan-digest" | "current-stage" | "unbound-worktree" | "ambiguous-legacy";

export type ManifestBinding = { ok: true; identity: ManifestIdentity } | { ok: false; reason: ManifestRejection; detail: string };

/**
 * Read a manifest and its binding record and bind them to the run they are
 * claimed to describe, or say why they cannot be. Never returns a partial
 * answer: an unbound manifest yields nothing, and the caller degrades to "no
 * recorded membership" rather than to a guess.
 */
export function bindManifest(text: string | undefined, binding: string | undefined, expect: ManifestExpectation): ManifestBinding {
  return bindParsedManifest(parseExecutionManifest(text), readBindingRecord(binding), expect);
}

/**
 * The same binding, over content that has already been parsed.
 *
 * Parsing is what costs — a manifest carries every stage's brief verbatim and
 * is by far the largest file the Overview reads — so a caller may cache the
 * parsed bytes. It may never cache *this*: the answer depends on the run's
 * recorded state, which changes under a file that does not, so it is derived
 * fresh from a `RunSnapshot` every time.
 */
export function bindParsedManifest(parsed: ParsedManifest | undefined, binding: ManifestBindingRecord | undefined, expect: ManifestExpectation): ManifestBinding {
  const bound = bindWithoutWorktree(parsed, expect);
  if (!bound.ok || !parsed) {
    return bound;
  }
  const unbound = worktreeMismatch(binding, parsed.digest, expect);
  if (unbound) {
    return { ok: false, reason: "unbound-worktree", detail: unbound };
  }
  return bound;
}

/**
 * Bind a manifest written **before binding records existed**, without writing
 * anything and without weakening any check that can still be made.
 *
 * ### The problem this closes
 *
 * Binding is strict, and correctly so. But a manifest is only ever *written*
 * when a plan run is started or resumed, and a **completed** run is never
 * resumed again — so upgrading to a build that requires a sidecar left every
 * finished run permanently unable to prove its own stage list. Its historical
 * stages went back to looking like unrelated standalone work, its journey
 * stopped being drawn, and there was no action a person could take to fix it
 * short of re-running an engine that has nothing left to do. That failure is
 * real and reproduced: a completed plan run whose manifest sits at the
 * oldest, unscoped file name with no sidecar beside it.
 *
 * ### Why nothing is written
 *
 * The obvious repair is to synthesise the missing sidecar. This does not,
 * deliberately: the fact a sidecar states can be established at read time from
 * evidence that is already on disk, so writing one would add a file that is
 * *derived* from that evidence and then outlives it — a second authority,
 * created by a reader, which is the shape of mistake the binding rules exist
 * to prevent. Deriving it instead is idempotent by construction, has no
 * side effects, cannot half-succeed, and needs no repair command and no user
 * action for a failure they cannot see.
 *
 * ### What is still proved
 *
 * Everything except the one thing the sidecar exists for, plus a replacement
 * for that one thing:
 *
 *  - the plan label is the one the run records;
 *  - the manifest's **executable digest equals the `plan_digest` the engine
 *    itself recorded** for this run. This is not a resemblance: it is a
 *    SHA-256 over every byte that decides what executes, computed by the
 *    engine's own rules (see {@link parseExecutionManifest}) and compared
 *    against a value the engine wrote. A manifest for a different plan, or a
 *    rewritten one, cannot match it;
 *  - the run's recorded current stage is one of the manifest's stages;
 *  - and `sole` — no *other* discovered plan run could bind to this same file.
 *
 * That last clause is what stands in for the worktree. The sidecar exists
 * because two worktrees of one repository running the same plan write
 * byte-identical manifests to one shared legacy name and record identical
 * state, so nothing in the file can tell them apart. When only one discovered
 * run could claim it, there is nothing to tell apart. When two could, this
 * refuses — `ambiguous-legacy` — rather than attributing history to a guess.
 */
export function bindLegacyManifest(parsed: ParsedManifest | undefined, expect: ManifestExpectation, provenance: { file: string; sole: boolean }): ManifestBinding {
  const bound = bindWithoutWorktree(parsed, expect);
  if (!bound.ok) {
    return bound;
  }
  if (!provenance.sole) {
    return {
      ok: false,
      reason: "ambiguous-legacy",
      detail: `${provenance.file} was written before manifests said which worktree they belong to, and more than one discovered plan run executes exactly what it contains; it is not attributed to any of them`,
    };
  }
  return bound;
}

/** The checks that do not need the sidecar, shared by the strict and the legacy paths. */
function bindWithoutWorktree(parsed: ParsedManifest | undefined, expect: ManifestExpectation): ManifestBinding {
  if (!parsed) {
    return { ok: false, reason: "unreadable", detail: "not a version 1 execution manifest this engine would accept" };
  }
  const { identity, digest } = parsed;
  if (identity.planLabel !== expect.planLabel) {
    return { ok: false, reason: "plan-label", detail: `it executes ${identity.planLabel}, while the run records ${expect.planLabel}` };
  }
  if (digest !== expect.planDigest) {
    return {
      ok: false,
      reason: "plan-digest",
      detail: `its executable content digests to ${short(digest)}, while the run records ${short(expect.planDigest)}; it is not the manifest this run executes`,
    };
  }
  if (!identity.stages.some((stage) => stage.stageId === expect.currentStageId)) {
    return { ok: false, reason: "current-stage", detail: `it does not contain the run's recorded current stage ${expect.currentStageId}` };
  }
  return { ok: true, identity };
}

/**
 * Whether a manifest could belong to more than one of these runs — the
 * question {@link bindLegacyManifest} asks before attributing an unbound file.
 *
 * "Could belong to" is exactly the legacy binding's own test, applied to every
 * other discovered run: same plan label, same recorded `plan_digest`, and that
 * run's current stage present. Anything less would be a weaker question than
 * the one being answered.
 */
export function soleLegacyClaimant(parsed: ParsedManifest | undefined, expect: ManifestExpectation, peers: readonly ManifestExpectation[]): boolean {
  return !peers.some((peer) => !sameRun(peer, expect) && bindWithoutWorktree(parsed, peer).ok);
}

function sameRun(a: ManifestExpectation, b: ManifestExpectation): boolean {
  return path.resolve(a.projectDir) === path.resolve(b.projectDir) && a.manifestFile === b.manifestFile;
}

/** Why the sidecar record does not prove this manifest was written for this run's worktree, or undefined when it does. */
function worktreeMismatch(binding: ManifestBindingRecord | undefined, digest: string, expect: ManifestExpectation): string | undefined {
  if (!binding) {
    return "no binding record says which worktree it was written for";
  }
  if (path.resolve(binding.projectDir) !== path.resolve(expect.projectDir)) {
    return `it was written for ${binding.projectDir}, not for ${expect.projectDir}`;
  }
  if (binding.manifestFile !== expect.manifestFile) {
    return `its binding record vouches for ${binding.manifestFile}, not for ${expect.manifestFile}`;
  }
  if (binding.manifestDigest !== digest) {
    return `its binding record vouches for ${short(binding.manifestDigest)}, while the file digests to ${short(digest)}`;
  }
  if (binding.planLabel !== expect.planLabel) {
    return `its binding record names ${binding.planLabel}, while the run records ${expect.planLabel}`;
  }
  return undefined;
}

function short(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

/**
 * Where a plan run's manifest lives. One place this is computed, so the
 * writer, the reader and the tests cannot drift into different files.
 */
export function manifestPathFor(directory: string, run: ManifestOwner): string {
  return path.join(directory, manifestFileName(run.runKey, run.location.projectDir));
}

/** Where its binding record lives: beside the manifest, under the same identity. */
export function bindingPathFor(directory: string, run: ManifestOwner): string {
  return path.join(directory, bindingFileName(run.runKey, run.location.projectDir));
}

/** The parts of a run that decide where its manifest is kept. */
export interface ManifestOwner {
  /**
   * The run *instance*'s key, which is what the file is named by. It used to
   * be the plan key, and then two runs of one plan document overwrote each
   * other's manifest — the second run's rebuild would have been read as the
   * first run's stage list.
   *
   * A run recorded before run instances existed has the plan key as its run
   * key, so its file keeps exactly the name it already has.
   */
  runKey: string;
  /** The plan document's key, recorded in the binding record. */
  planKey: string;
  location: { projectDir: string };
}

/** What a manifest must match to be that run's: taken from the engine's own recorded state. */
export function manifestExpectationFor(run: ManifestOwner & { state: { plan: string; currentStage: string; planDigest: string } }): ManifestExpectation {
  return {
    planLabel: run.state.plan,
    currentStageId: run.state.currentStage,
    planDigest: run.state.planDigest,
    projectDir: run.location.projectDir,
    manifestFile: manifestFileName(run.runKey, run.location.projectDir),
  };
}

/**
 * A stable file name for one plan run's manifest, so regenerating it
 * overwrites in place — and a *different* name for a different run of the
 * same plan document, which is why this is keyed by run and not by plan.
 *
 * Scoped to the project directory as well, because a run key contains a hash
 * of the plan's **repo-relative** path: two worktrees of the same repository —
 * the ordinary way to run two stages of the same plan side by side — can
 * produce the same key for `docs/plans/foo.md`, and used to share one file in
 * global storage.
 *
 * The scope is the *full* SHA-256 of the resolved project directory. It was
 * eight hex digits, which is 32 bits and collides in practice: a reviewer
 * found `/tmp/sparring-worktree-33503` and `/tmp/sparring-worktree-75970`
 * sharing one file name. A file name is not an authority in any case — see
 * {@link ManifestBindingRecord} for what actually proves ownership — but a
 * namespace that collides is not even a useful *index*, and there is no reason
 * to spend only 32 bits on it.
 */
export function manifestFileName(runKey: string, projectDir: string): string {
  return `${runKey}-${projectDigest(projectDir)}.manifest.json`;
}

/** The binding record beside it, under the same run-and-project identity. */
export function bindingFileName(runKey: string, projectDir: string): string {
  return `${runKey}-${projectDigest(projectDir)}.binding.json`;
}

/**
 * The names this plan run's manifest has been written under before, newest
 * first: the 8-hex project scope, then the unscoped name shared by every
 * worktree with the same plan path.
 *
 * None of them is ever written again, and none is ever read as authority. They
 * are read for one thing only: `source_digest` provenance when a run that
 * started against an older name writes its first manifest under the current
 * one (see {@link carriedForward}). Without that, the rebuilt manifest would
 * take a fresh hash of the plan text, the engine's run identity would change,
 * and a run in flight would be refused — the exact failure that lost a
 * submission before.
 *
 * Until that next write happens such a run has no manifest at the name it
 * reads, so its stage membership degrades honestly to "not recorded here"
 * rather than being taken from a file whose worktree nothing vouches for.
 */
export function previousManifestFileNames(runKey: string, projectDir: string): string[] {
  return [`${runKey}-${shortProjectDigest(projectDir)}.manifest.json`, legacyManifestFileName(runKey)];
}

/** The name manifests had before they were scoped to a project at all. */
export function legacyManifestFileName(runKey: string): string {
  return `${runKey}.manifest.json`;
}

/** SHA-256 of the resolved project directory, in full: an index, never an authority. */
function projectDigest(projectDir: string): string {
  return crypto.createHash("sha256").update(path.resolve(projectDir), "utf8").digest("hex");
}

/** The first 8 hex digits it used to be, kept only to find a run's previous file for provenance. */
function shortProjectDigest(projectDir: string): string {
  return projectDigest(projectDir).slice(0, 8);
}
