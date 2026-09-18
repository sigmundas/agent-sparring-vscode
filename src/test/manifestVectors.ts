/**
 * Cross-language vectors for the execution manifest contract.
 *
 * Each vector is the *exact text* of a manifest file, because that is the unit
 * both sides read: whitespace, escapes and surrogates all have to survive
 * being written down, and building the JSON from objects on either side would
 * quietly normalise the very thing under test.
 *
 * What the engine answers for each of them is **not** here. It is generated
 * from a live engine into `manifestParity.pinned.json` by
 * `scripts/manifest_probe.py`, so no expectation in this repository is a
 * hand-written guess about Python's behaviour. `manifestParity.test.ts` checks
 * the TypeScript reimplementation against those pins on every `npm test` with
 * no Python present, and re-checks the pins themselves against the engine
 * whenever one is importable. Either side drifting is then a test failure
 * rather than a silent divergence that surfaces months later as a run losing
 * its stage list.
 *
 * ### Why this needs a live engine at all
 *
 * src/core/manifest.ts recomputes `parse_manifest` and `manifest_digest` so
 * the extension can ask whether a manifest on disk is the one a recorded run
 * executes — comparing its own digest against the `plan_digest` the engine
 * wrote. A divergence is never cosmetic: it either refuses a run's real
 * manifest, so the run loses its stage list, its journey and the historical
 * membership of its finished stages, or it accepts one the engine never ran.
 *
 * Three of these divergences were real, and none of them is visible by reading
 * the two implementations side by side:
 *
 *  - Python's `str.strip()` and JavaScript's `trim()` are different sets.
 *    Python strips U+0085 and the U+001C–U+001F separators; JavaScript strips
 *    U+FEFF. Each side silently produced a different digest for the same file.
 *  - `version != 1` in Python accepts `true`, because `True == 1`. `!== 1` in
 *    TypeScript did not.
 *  - `str.encode("utf-8")` raises on an unpaired surrogate; Node substitutes
 *    U+FFFD, so the extension produced a confident digest for a manifest the
 *    engine cannot digest at all.
 *
 * No dependency on the vscode API.
 */

/** One manifest file's text, and why that text is worth pinning. */
export interface ManifestVector {
  name: string;
  /** Why this input is interesting, so a failure explains itself. */
  why: string;
  /** The manifest file's exact bytes, as text. */
  json: string;
}

/** What the engine answered for one vector; generated, never hand-written. */
export interface ManifestVectorResult {
  name: string;
  /** Whether `parse_manifest` returned. */
  accepted: boolean;
  /** `manifest_digest`'s hex answer; absent when it raised or the file was refused. */
  digest?: string;
  /** The exception, when there was one — from either step. */
  error?: string;
}

const STAGE = { stage_id: "stage-1-contract", label: "Stage 1", title: "Contract", brief: "Do the thing.\n" };
const TOP = { version: 1, plan_label: "docs/plans/foo.md", source_digest: "sha256:abc" };

/** One manifest, with `top` and `stage` merged over the minimal valid shape. */
function one(top: Record<string, unknown> = {}, stage: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...TOP, ...top, stages: [{ ...STAGE, ...stage }] });
}

/** A raw JSON text, for shapes `JSON.stringify` cannot produce (a lone surrogate escape). */
function raw(text: string): string {
  return text;
}

export const MANIFEST_VECTORS: ManifestVector[] = [
  { name: "baseline", why: "the minimal valid manifest every other vector is measured against", json: one() },

  // ------------------------------------------------------------- whitespace
  {
    name: "title-ascii-space",
    why: "ordinary ASCII whitespace around a _text field: both sides strip it, so the digest equals the baseline's",
    json: one({}, { title: "  Contract \t" }),
  },
  {
    name: "title-newlines-and-tabs",
    why: "tabs and newlines around a _text field strip on both sides",
    json: one({}, { title: "\n\tContract\r\n" }),
  },
  {
    name: "title-u0085",
    why: "U+0085 NEL: Python's str.strip() removes it, JavaScript's trim() does not — this digested differently on the two sides",
    json: one({}, { title: "Contract" }),
  },
  {
    name: "title-u00a0",
    why: "U+00A0 NBSP: both sides strip it, which is why it cannot stand in for the U+0085 case",
    json: one({}, { title: " Contract " }),
  },
  {
    name: "title-ufeff",
    why: "U+FEFF ZWNBSP: JavaScript's trim() removes it, Python's str.strip() does not — the divergence in the other direction",
    json: one({}, { title: "﻿Contract﻿" }),
  },
  {
    name: "title-u001c-separators",
    why: "U+001C–U+001F: Python whitespace by bidirectional class, and not JavaScript whitespace at all",
    json: one({}, { title: "Contract" }),
  },
  {
    name: "title-only-u0085",
    why: "a title that is *only* U+0085 is empty to Python and non-empty to trim(): refused there, accepted here",
    json: one({}, { title: "" }),
  },
  {
    name: "title-only-ufeff",
    why: "a title that is only U+FEFF is non-empty to Python and empty to trim(): the mirror image",
    json: one({}, { title: "﻿" }),
  },
  {
    name: "plan-label-u0085",
    why: "the same strip rule applies to plan_label, which is part of the digest",
    json: one({ plan_label: "docs/plans/foo.md" }),
  },
  {
    name: "source-digest-ufeff",
    why: "and to source_digest, which the engine treats as opaque provenance but still digests",
    json: one({ source_digest: "﻿sha256:abc" }),
  },
  {
    name: "stage-id-ufeff",
    why: "a stage id Python does not strip then fails its path-segment regex; trim() stripped it and let the file through",
    json: one({}, { stage_id: "stage-1-contract﻿" }),
  },
  {
    name: "stage-id-u0085",
    why: "a stage id Python does strip, so both sides see a valid id",
    json: one({}, { stage_id: "stage-1-contract" }),
  },

  // ------------------------------------------------------------- brief bytes
  {
    name: "brief-verbatim-whitespace",
    why: "brief is validated as non-empty but digested verbatim, so surrounding whitespace changes the digest on both sides",
    json: one({}, { brief: "  Do the thing.\n  " }),
  },
  {
    name: "brief-only-u0085",
    why: "brief emptiness is Python's strip too: U+0085 alone is not an executable brief",
    json: one({}, { brief: "" }),
  },
  {
    name: "brief-only-ufeff",
    why: "and U+FEFF alone is one, because Python does not strip it",
    json: one({}, { brief: "﻿" }),
  },

  // ------------------------------------------------------------- non-ASCII
  {
    name: "non-ascii",
    why: "ordinary UTF-8 must digest identically: the bytes are the contract, not the code units",
    json: one({}, { title: "Kjøttdeig — 日本語 — 🜁" }),
  },
  {
    name: "astral-pair",
    why: "a surrogate *pair* is one code point and encodes fine on both sides",
    json: one({}, { title: "Contract \u{1f600}" }),
  },
  {
    name: "lone-high-surrogate",
    why: "an unpaired surrogate: the engine accepts the file and then raises in str.encode('utf-8'), so no authoritative digest exists for it",
    json: raw('{"version":1,"plan_label":"docs/plans/foo.md","source_digest":"sha256:abc","stages":[{"stage_id":"stage-1-contract","label":"Stage 1","title":"Contract \\ud800","brief":"Do the thing.\\n"}]}'),
  },
  {
    name: "lone-low-surrogate-in-brief",
    why: "the same in the brief, which is the largest field and the one carried verbatim",
    json: raw('{"version":1,"plan_label":"docs/plans/foo.md","source_digest":"sha256:abc","stages":[{"stage_id":"stage-1-contract","label":"Stage 1","title":"Contract","brief":"Do \\udc00 the thing.\\n"}]}'),
  },

  // ------------------------------------------------------------- version
  { name: "version-true", why: "Python's `version != 1` accepts True, because True == 1; `!== 1` refused it", json: one({ version: true }) },
  { name: "version-false", why: "False != 1, so the engine refuses it — both sides must", json: one({ version: false }) },
  {
    name: "version-float-one",
    why: "1.0 == 1 in Python and 1.0 === 1 in JavaScript, so both accept it — written raw because JSON.stringify renders 1.0 as 1",
    json: raw('{"version":1.0,"plan_label":"docs/plans/foo.md","source_digest":"sha256:abc","stages":[{"stage_id":"stage-1-contract","label":"Stage 1","title":"Contract","brief":"Do the thing.\\n"}]}'),
  },
  { name: "version-string-one", why: '"1" != 1: refused by both', json: one({ version: "1" }) },
  { name: "version-zero", why: "0 != 1: refused", json: one({ version: 0 }) },
  { name: "version-two", why: "a future version is refused rather than half-read", json: one({ version: 2 }) },
  { name: "version-null", why: "null != 1: refused", json: one({ version: null }) },
  { name: "version-absent", why: "an absent version is None, and None != 1: refused", json: JSON.stringify({ plan_label: "docs/plans/foo.md", source_digest: "sha256:abc", stages: [STAGE] }) },

  // ------------------------------------------------------------- mode
  { name: "mode-absent", why: "the default: no mode contributes nothing to the digest, so this equals the baseline", json: one() },
  { name: "mode-null", why: "explicit null is the default too, and must digest as the baseline", json: one({}, { mode: null }) },
  {
    name: "mode-explicit-implementation",
    why: "an explicit default mode contributes nothing either — the rule that keeps pre-mode manifests digesting to their recorded value",
    json: one({}, { mode: "implementation" }),
  },
  { name: "mode-independent-review", why: "the non-default mode does contribute, in both directions", json: one({}, { mode: "independent_review" }) },
  { name: "mode-padded", why: "mode is stripped before it is looked up, with Python's strip", json: one({}, { mode: " independent_review\n" }) },
  { name: "mode-u0085-padded", why: "…so a U+0085-padded mode is valid to the engine and was not to trim()", json: one({}, { mode: "independent_review" }) },
  { name: "mode-unknown", why: "an unrecognised mode is refused, never defaulted: which agent runs is not guessed", json: one({}, { mode: "review" }) },
  { name: "mode-not-a-string", why: "a non-string mode is refused", json: one({}, { mode: 1 }) },

  // ------------------------------------------------------------- repositories
  {
    name: "repositories-one",
    why: "a declared sibling contributes name, path, branch and candidate_sha to the digest",
    json: one({}, { repositories: [{ name: "sporely-web", path: "../sporely-web", branch: "feature/x", candidate_sha: null }] }),
  },
  {
    name: "repositories-sha-empty-string",
    why: "`candidate_sha or ''` means null and '' digest identically",
    json: one({}, { repositories: [{ name: "sporely-web", path: "../sporely-web", branch: "feature/x", candidate_sha: "" }] }),
  },
  {
    name: "repositories-sha-absent",
    why: "an absent candidate_sha is None, so this equals the null case",
    json: one({}, { repositories: [{ name: "sporely-web", path: "../sporely-web", branch: "feature/x" }] }),
  },
  {
    name: "repositories-verbatim-padding",
    why: "name/path/branch are validated stripped and digested verbatim, so padding changes the digest",
    json: one({}, { repositories: [{ name: " sporely-web ", path: "../sporely-web", branch: "feature/x", candidate_sha: null }] }),
  },
  {
    name: "repositories-name-only-ufeff",
    why: "a name that is only U+FEFF is non-empty to Python and empty to trim(): accepted there, refused here",
    json: one({}, { repositories: [{ name: "﻿", path: "../sporely-web", branch: "feature/x", candidate_sha: null }] }),
  },
  {
    name: "repositories-name-only-u0085",
    why: "and one that is only U+0085 is the mirror image",
    json: one({}, { repositories: [{ name: "", path: "../sporely-web", branch: "feature/x", candidate_sha: null }] }),
  },
  {
    name: "repositories-duplicate-names",
    why: "repository names must be unique",
    json: one(
      {},
      {
        repositories: [
          { name: "a", path: "../a", branch: "b", candidate_sha: null },
          { name: "a", path: "../a2", branch: "b", candidate_sha: null },
        ],
      },
    ),
  },
  {
    name: "repositories-order",
    why: "declaration order is digest order: the same two siblings the other way round is a different manifest",
    json: one(
      {},
      {
        repositories: [
          { name: "b", path: "../b", branch: "x", candidate_sha: null },
          { name: "a", path: "../a", branch: "x", candidate_sha: null },
        ],
      },
    ),
  },
  { name: "repositories-null", why: "explicit null is no repositories, not an error", json: one({}, { repositories: null }) },
  { name: "repositories-not-an-array", why: "a non-array repositories field is refused", json: one({}, { repositories: {} }) },
  { name: "repositories-sha-number", why: "a non-string candidate_sha is refused", json: one({}, { repositories: [{ name: "a", path: "../a", branch: "b", candidate_sha: 7 }] }) },

  // ------------------------------------------------------------- shape and keys
  { name: "unknown-top-level-key", why: "unknown keys are refused rather than ignored, so a newer contract fails loudly", json: one({ extra: 1 }) },
  { name: "unknown-stage-key", why: "the same at stage level", json: one({}, { extra: 1 }) },
  {
    name: "unknown-repository-key",
    why: "and at repository level",
    json: one({}, { repositories: [{ name: "a", path: "../a", branch: "b", candidate_sha: null, extra: 1 }] }),
  },
  { name: "stages-empty", why: "a manifest must declare at least one stage", json: JSON.stringify({ ...TOP, stages: [] }) },
  { name: "stages-not-an-array", why: "stages must be an array", json: JSON.stringify({ ...TOP, stages: {} }) },
  { name: "not-an-object", why: "a manifest must be a JSON object", json: "[]" },
  { name: "not-json", why: "unparseable text is refused", json: "{" },
  {
    name: "stage-order",
    why: "stage order is execution order and therefore digest order",
    json: JSON.stringify({
      ...TOP,
      stages: [
        { ...STAGE, stage_id: "stage-2-schema", label: "Stage 2", title: "Schema" },
        STAGE,
      ],
    }),
  },
  {
    name: "duplicate-stage-ids",
    why: "stage ids must be unique",
    json: JSON.stringify({ ...TOP, stages: [STAGE, STAGE] }),
  },
  { name: "stage-id-with-slash", why: "a stage id must be usable as one path segment", json: one({}, { stage_id: "a/b" }) },
  { name: "stage-id-dotdot", why: "traversal segments are refused", json: one({}, { stage_id: ".." }) },
  { name: "label-empty", why: "label must be a non-empty string", json: one({}, { label: "   " }) },
  { name: "brief-missing", why: "a stage with nothing to implement from is not executable", json: one({}, { brief: undefined }) },
];
