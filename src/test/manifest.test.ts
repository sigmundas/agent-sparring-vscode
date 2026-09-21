/**
 * The execution manifest: what the extension interprets out of a human plan
 * document, and what it deliberately leaves alone.
 *
 * The plan used here is the shape that motivated the whole feature — a real
 * one, with `3A`/`3B`/`3C`/`3D` labels, a stack of dated handoff sections
 * that record what happened and define nothing, and a canonical stage
 * sequence further down.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BINDING_VERSION,
  adoptionGaps,
  bindManifest,
  bindingFileName,
  buildManifest,
  legacyManifestFileName,
  manifestDigest,
  manifestFileName,
  parseExecutionManifest,
  previousManifestFileNames,
  renderBindingRecord,
  renderManifest,
  sourceDigest,
  type KnownStage,
  type ManifestBindingRecord,
  type ManifestExpectation,
} from "../core/manifest";

const PLAN_LABEL = "docs/plans/active/reported-statistics.md";
const PLAN_NAME = "reported-statistics.md";

const PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "The executable stage definitions are the `## Stage <label> — …` sections under",
  "*Canonical stage sequence*. The `… handoff` sections are records, newest first.",
  "",
  "## Stage 3D handoff — 2026-09-14 (current stage; candidates pushed in both repositories)",
  "",
  "Status: Stage 3D implemented and self-verified in both repositories.",
  "",
  "## Stage 3C handoff — 2026-09-13 (accepted at `3c0f65b5`)",
  "",
  "The cloud slice landed.",
  "",
  "## Stage 1 handoff — 2026-09-11 (accepted at `a0bdcd37`)",
  "",
  "The contract landed.",
  "",
  "## Canonical stage sequence",
  "",
  "The order is Stage 1 → Stage 3C → Stage 3D → Stage 4.",
  "",
  "## Stage 1 — Contract and compatibility fixtures",
  "",
  "Freeze the measurement contract and its fixtures.",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "### Goal",
  "",
  "Add the cloud schema and the RPC guards.",
  "",
  "## Stage 3D — Snapshot v2 and attachment/export/import transport",
  "",
  "Owns the frozen-evidence representation of enhanced content.",
  "",
  "## Stage 4 — Editor and UI inspection",
  "",
  "Guarded editing in the UI.",
  "",
  "## Required regression matrix",
  "",
  "Prose that is not a stage.",
  "",
].join("\n");

/** plan.py: plan_key over PLAN_LABEL — the namespace this plan's fresh stage ids carry. */
const PLAN_KEY = "reported-statistics-bbd2e9fe";

/**
 * The id `buildManifest` gives a stage of *this* plan that does not exist
 * yet. Namespaced by the plan key, so a different plan document in the same
 * worktree — even one numbering its sections Stage 1 again — never proposes
 * the same directory.
 */
function proposed(label: string, slug: string): string {
  return `${PLAN_KEY}-stage-${label}-${slug}`;
}

function build(known: KnownStage[] = []) {
  return buildManifest({ markdown: PLAN, planLabel: PLAN_LABEL, planName: PLAN_NAME, known });
}

describe("building an execution manifest from a human plan", () => {
  it("lists the canonical stages in workflow-label order, with lettered labels intact", () => {
    const built = build();
    assert.ok(built.ok);
    assert.deepEqual(
      built.manifest.stages.map((stage) => stage.label),
      ["Stage 1", "Stage 3C", "Stage 3D", "Stage 4"],
    );
    assert.equal(built.manifest.plan_label, PLAN_LABEL);
    assert.equal(built.manifest.version, 1);
  });

  it("excludes the historical handoff sections, and says which ones", () => {
    const built = build();
    assert.ok(built.ok);
    // Stage 3C and 3D are also *mentioned* by handoff headings, but each has
    // a real defining section, so they run once and only once.
    assert.equal(built.manifest.stages.filter((stage) => stage.label === "Stage 3C").length, 1);
    assert.ok(
      built.manifest.stages.every((stage) => !stage.title.includes("handoff")),
      "no handoff record becomes an executable stage",
    );
    assert.deepEqual(built.skipped, [], "every label here also has a defining section");

    // A stage that exists only as a record is skipped, not guessed at.
    const recordOnly = buildManifest({
      markdown: `${PLAN}\n## Stage 5 handoff — 2026-09-20 (accepted)\n\nNothing defines Stage 5.\n`,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
    });
    assert.ok(recordOnly.ok);
    assert.deepEqual(
      recordOnly.manifest.stages.map((stage) => stage.label),
      ["Stage 1", "Stage 3C", "Stage 3D", "Stage 4"],
    );
    assert.deepEqual(
      recordOnly.skipped.map((problem) => problem.label),
      ["5"],
    );
    assert.match(recordOnly.skipped[0].reason, /only as a record of what happened/);
  });

  it("each brief is the plan section verbatim under the engine's own header", () => {
    const built = build();
    assert.ok(built.ok);
    const stage = built.manifest.stages.find((entry) => entry.label === "Stage 3C")!;
    assert.equal(
      stage.brief,
      [
        `# Stage brief: ${proposed("3c", "cloud-schema-rpc-and-sync-transport")}`,
        "",
        `Stage 3C from plan \`${PLAN_NAME}\`. Implement only this section; the other stages are separate.`,
        "",
        "## Stage 3C — Cloud schema/RPC and sync transport",
        "",
        "### Goal",
        "",
        "Add the cloud schema and the RPC guards.",
        "",
      ].join("\n"),
    );
    assert.ok(!stage.brief.includes("Stage 3D"), "the next stage's section is not swept in");
    assert.ok(!stage.brief.includes("handoff"), "nor is the handoff record");
  });

  it("keeps the stage ids the project already uses, so history stays visible", () => {
    const built = build([
      { label: "1", stageId: "stage-reported-statistics-contract" },
      { label: "3C", stageId: "stage-3c-cloud-schema-rpc-and-sync-transport" },
      { label: "3D", stageId: "stage-3d-snapshot-v2-and-attachment-export-import-transport" },
    ]);
    assert.ok(built.ok);
    assert.deepEqual(
      built.manifest.stages.map((stage) => stage.stage_id),
      [
        "stage-reported-statistics-contract",
        "stage-3c-cloud-schema-rpc-and-sync-transport",
        "stage-3d-snapshot-v2-and-attachment-export-import-transport",
        // Not yet started, so it gets a fresh id in this plan's own
        // namespace. The three above keep the unprefixed ids they were
        // actually created under, which is the whole point of `known`: a
        // sequence that already ran does not get renamed.
        proposed("4", "editor-and-ui-inspection"),
      ],
    );
  });

  it("gives two plans that define the same stage headings different stage ids", () => {
    // The follow-up-plan collision, at its source. Plan A is finished; plan
    // B is a different document in the same worktree whose sections happen
    // to be worded the same. Nothing about B may resolve to A's directories,
    // because A's accepted work is not B's Stage 1.
    const a = buildManifest({ markdown: PLAN, planLabel: "docs/plans/a.md", planName: "a.md" });
    const b = buildManifest({ markdown: PLAN, planLabel: "docs/plans/b.md", planName: "b.md" });
    assert.ok(a.ok && b.ok);

    const ids = (built: typeof a & { ok: true }) => built.manifest.stages.map((stage) => stage.stage_id);
    assert.deepEqual(
      ids(a).filter((id) => ids(b).includes(id)),
      [],
      "not one shared stage id, though every heading is identical",
    );
    // And each is namespaced by its own plan, not by a random discriminator:
    // the same plan document always rebuilds to the same ids, which is what
    // lets the engine refuse a manifest that changed.
    assert.deepEqual(ids(a), ids(buildManifest({ markdown: PLAN, planLabel: "docs/plans/a.md", planName: "a.md" }) as typeof a & { ok: true }));
  });

  it("briefs an already-executed stage from its own brief.md, and a future stage from the plan", () => {
    // The real Stage 3D case. The plan's Stage 3D section was rewritten
    // after the work was done — it now records what was implemented — while
    // the stage itself still holds the brief it was actually started with,
    // and two live sessions. The brief that was implemented and reviewed
    // against is the contract, so it is carried verbatim; Stage 4, which
    // does not exist yet, is briefed from the plan's current section.
    const original = ["# Stage brief: stage-3d-snapshot-v2-and-attachment-export-import-transport", "", `Stage 3D from plan \`${PLAN_NAME}\`. Implement only this section; the other stages are separate.`, "", "## Stage 3D — Snapshot v2 and attachment/export/import transport", "", "Future stage; starts after Stage 3C is accepted.", ""].join("\n");
    const evolved = PLAN.replace("Owns the frozen-evidence representation of enhanced content.", ["Owns the frozen-evidence representation of enhanced content.", "", "### Implementation record — 2026-09-14", "", "Snapshot v2 landed in both repositories; candidates pushed.", ""].join("\n"));

    const built = buildManifest({
      markdown: evolved,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
      known: [{ label: "3D", stageId: "stage-3d-snapshot-v2-and-attachment-export-import-transport", brief: original }],
    });

    assert.ok(built.ok);
    const stage3d = built.manifest.stages.find((stage) => stage.label === "Stage 3D")!;
    assert.equal(stage3d.brief, original, "the brief the work was reviewed against, byte for byte");
    assert.ok(!stage3d.brief.includes("Implementation record"), "the plan's later record is not smuggled into the executed stage's contract");
    const stage4 = built.manifest.stages.find((stage) => stage.label === "Stage 4")!;
    assert.match(stage4.brief, /Guarded editing in the UI\./, "a stage that has not run yet is briefed from the plan as it stands");
  });

  it("keeps a preserved stage even after its heading became a record of what happened", () => {
    // Nothing has to be extracted from the plan for a stage whose brief is
    // already known, so a plan that turned its section into a handoff note
    // must not silently shorten the sequence.
    const rewritten = PLAN.replace("## Stage 3D — Snapshot v2 and attachment/export/import transport", "## Stage 3D handoff — 2026-09-14 (candidates pushed)");
    const brief = "# Stage brief: stage-3d-snapshot-v2\n\nSnapshot v2 transport.\n";

    const built = buildManifest({ markdown: rewritten, planLabel: PLAN_LABEL, planName: PLAN_NAME, known: [{ label: "3D", stageId: "stage-3d-snapshot-v2", brief }] });

    assert.ok(built.ok);
    const stage3d = built.manifest.stages.find((stage) => stage.stage_id === "stage-3d-snapshot-v2");
    assert.ok(stage3d, "the executed stage stays in the sequence");
    assert.equal(stage3d.brief, brief);
    assert.equal(stage3d.label, "Stage 3D");
    assert.ok(stage3d.title.length > 0, "a display title is still produced");
    assert.ok(
      !built.skipped.some((problem) => problem.label === "3D"),
      "and it is not reported as skipped",
    );
  });

  it("a preserved brief does not excuse an ambiguous stage: identity is still refused", () => {
    const ambiguous = buildManifest({
      markdown: `${PLAN}\n## Stage 3D — Snapshot v2, revised\n\nA second definition.\n`,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
      known: [{ label: "3D", stageId: "stage-3d-snapshot-v2", brief: "# Stage brief\n\nBody.\n" }],
    });
    assert.ok(!ambiguous.ok);
    assert.deepEqual(
      ambiguous.problems.map((problem) => problem.label),
      ["3D"],
    );
  });

  it("an existing stage with no execution history is still briefed from the plan", () => {
    // No brief is supplied for such a stage: there is no history to protect,
    // and the plan as it stands is the better text.
    const built = build([{ label: "4", stageId: "stage-4-editor-and-ui-inspection" }]);
    assert.ok(built.ok);
    assert.match(built.manifest.stages.find((stage) => stage.label === "Stage 4")!.brief, /Guarded editing in the UI\./);
  });

  it("is deterministic: the same plan and matches always produce the same bytes", () => {
    const first = build();
    const second = build();
    assert.ok(first.ok && second.ok);
    assert.equal(renderManifest(first.manifest), renderManifest(second.manifest));
    // Which matters because the engine refuses to continue a run whose
    // manifest digest changed, and the file is rewritten on every launch.
    assert.equal(first.manifest.source_digest, second.manifest.source_digest);
    assert.match(first.manifest.source_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(renderManifest(first.manifest).endsWith("\n"), true);
  });

  it("an edited plan changes the source digest even when the stage sections do not", () => {
    const edited = buildManifest({ markdown: PLAN.replace("Prose that is not a stage.", "Edited prose."), planLabel: PLAN_LABEL, planName: PLAN_NAME });
    const original = build();
    assert.ok(edited.ok && original.ok);
    assert.notEqual(edited.manifest.source_digest, original.manifest.source_digest);
    assert.equal(sourceDigest(PLAN), original.manifest.source_digest);
  });

  it("carries declared sibling repositories for a cross-repository stage", () => {
    const built = buildManifest({
      markdown: PLAN,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
      repositories: { "3D": [{ name: "sporely-web", path: "../sporely-web-worktree", branch: "feature/cloud", candidate_sha: null }] },
    });
    assert.ok(built.ok);
    const withSibling = built.manifest.stages.find((stage) => stage.label === "Stage 3D")!;
    assert.deepEqual(withSibling.repositories, [{ name: "sporely-web", path: "../sporely-web-worktree", branch: "feature/cloud", candidate_sha: null }]);
    assert.equal(built.manifest.stages.find((stage) => stage.label === "Stage 1")!.repositories, undefined, "no empty array where there is nothing to declare");
  });

  it("refuses rather than guesses when a stage is defined twice", () => {
    const ambiguous = buildManifest({
      markdown: `${PLAN}\n## Stage 4 — Editor and UI inspection, revised\n\nA second definition.\n`,
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
    });
    assert.ok(!ambiguous.ok);
    assert.deepEqual(
      ambiguous.problems.map((problem) => problem.label),
      ["4"],
    );
    assert.match(ambiguous.problems[0].reason, /more than one section/);
  });

  it("refuses a stage whose section is a heading with nothing under it", () => {
    const empty = buildManifest({
      markdown: ["# Plan", "", "## Stage 1 — Foundation", "", "## Stage 2 — Next", "", "Body.", ""].join("\n"),
      planLabel: PLAN_LABEL,
      planName: PLAN_NAME,
    });
    assert.ok(!empty.ok);
    assert.match(empty.problems[0].reason, /no content to brief the stage with/);
  });

  it("refuses a plan with nothing executable in it", () => {
    const prose = buildManifest({ markdown: "# Notes\n\nJust prose.\n", planLabel: PLAN_LABEL, planName: PLAN_NAME });
    assert.ok(!prose.ok);
    assert.match(prose.problems[0].reason, /no stage with a section to run/);
  });

  it("spots a stage that would be created inside a sequence that has already run past it", () => {
    // The real hazard behind the preserved-brief rule: matching is
    // deliberately conservative, so an old brief whose opening paragraph
    // mentions three stage numbers matches none of them, the stage keeps its
    // history under its own id, and the manifest proposes a fresh one for
    // that label. Adopting that would re-implement accepted work.
    const built = build([{ label: "3D", stageId: "stage-3d-snapshot-v2" }]);
    assert.ok(built.ok);
    const idOf = (label: string) => built.manifest.stages.find((stage) => stage.label === label)!.stage_id;
    const existing = new Set([idOf("Stage 3C"), "stage-3d-snapshot-v2"]);

    assert.deepEqual(
      adoptionGaps(built.manifest, existing).map((stage) => stage.label),
      ["Stage 1"],
      "Stage 1 comes before stages that exist, so its absence is a hole, not the future",
    );
    assert.deepEqual(adoptionGaps(built.manifest, new Set([...existing, "stage-reported-statistics-contract"])).map((stage) => stage.label), ["Stage 1"], "an existing stage under an id the manifest does not use is still a hole");
  });

  it("stages after the last existing one are the future, not a gap", () => {
    const built = build();
    assert.ok(built.ok);
    assert.deepEqual(adoptionGaps(built.manifest, new Set([proposed("1", "contract-and-compatibility-fixtures")])), []);
    assert.deepEqual(adoptionGaps(built.manifest, new Set()), [], "a plan that has never run is all future");
    assert.deepEqual(adoptionGaps(built.manifest, new Set(built.manifest.stages.map((stage) => stage.stage_id))), [], "a fully existing sequence has no hole");
  });

  it("names the manifest file after the plan key *and* the project, so regenerating overwrites in place", () => {
    const name = manifestFileName("reported-statistics-3f9a2c1b", "/code/sporely-py-reported-statistics");
    assert.match(name, /^reported-statistics-3f9a2c1b-[0-9a-f]{64}\.manifest\.json$/);
    assert.equal(name, manifestFileName("reported-statistics-3f9a2c1b", "/code/sporely-py-reported-statistics"), "same run, same file");
    assert.equal(bindingFileName("reported-statistics-3f9a2c1b", "/code/sporely-py-reported-statistics").replace(".binding.json", ""), name.replace(".manifest.json", ""), "the binding record shares the manifest's identity");
  });

  it("gives two worktrees running the same plan path two different manifests", () => {
    // The plan key is a hash of the *repo-relative* plan path, so two
    // worktrees of one repository produce the same key for docs/plans/foo.md.
    // They used to share one file in global storage, and whichever window
    // wrote last decided what the other believed its stages were.
    const key = "reported-statistics-3f9a2c1b";
    assert.notEqual(
      manifestFileName(key, "/code/sporely-py-reported-statistics"),
      manifestFileName(key, "/code/worktrees/sporely-py-reported-statistics"),
    );
  });

  /**
   * The project scope used to be the first eight hex digits of SHA-256 — 32
   * bits — and a reviewer found two real directories that collide under it.
   * A file name is an index and never an authority (see the worktree binding
   * below), but a 32-bit namespace is not a useful index either.
   */
  it("scopes the file name by enough of the project digest that the reviewer's collision is gone", () => {
    const key = "same-plan-7ea7171f";
    assert.notEqual(
      manifestFileName(key, "/tmp/sparring-worktree-33503"),
      manifestFileName(key, "/tmp/sparring-worktree-75970"),
      "the two directories that produced one file name under an 8-hex scope",
    );
    assert.notEqual(bindingFileName(key, "/tmp/sparring-worktree-33503"), bindingFileName(key, "/tmp/sparring-worktree-75970"));
  });

  it("remembers the names it used to write, for provenance and never as authority", () => {
    const names = previousManifestFileNames("reported-statistics-3f9a2c1b", "/code/sporely-py-reported-statistics");
    assert.match(names[0], /^reported-statistics-3f9a2c1b-[0-9a-f]{8}\.manifest\.json$/, "the 8-hex project scope");
    assert.equal(names[1], legacyManifestFileName("reported-statistics-3f9a2c1b"), "then the unscoped name");
    assert.equal(names[1], "reported-statistics-3f9a2c1b.manifest.json");
    assert.ok(!names.includes(manifestFileName("reported-statistics-3f9a2c1b", "/code/sporely-py-reported-statistics")), "the current name is not one of them");
  });

  it("carries no status, position, verdict or session: it is input, not a second workflow engine", () => {
    const built = build();
    assert.ok(built.ok);
    assert.deepEqual(Object.keys(built.manifest).sort(), ["plan_label", "source_digest", "stages", "version"]);
    for (const stage of built.manifest.stages) {
      assert.ok(
        Object.keys(stage).every((key) => ["stage_id", "label", "title", "brief", "repositories"].includes(key)),
        `stage carries only execution content, got ${Object.keys(stage).join(", ")}`,
      );
    }
    const text = renderManifest(built.manifest);
    for (const forbidden of ["status", "current_stage", "accepted", "session", "candidate_sha\": \"", "digest\": \"sha256:0"]) {
      assert.ok(!text.includes(`"${forbidden}"`), `no ${forbidden} field`);
    }
  });
});

/**
 * A manifest lives in global storage, which is per-user and nothing else. It
 * being there is not evidence that it belongs to the run on screen, and
 * neither is the name it is under. The manifest is candidate evidence; the
 * authority is the run's recorded state, the executable digest and the
 * worktree identity, and all of it is checked before a single stage of it is
 * believed.
 */
describe("binding a manifest to the run it is claimed to describe", () => {
  const PLAN_LABEL = "docs/plans/reported-statistics.md";
  const WORKTREE = "/code/sporely-py-reported-statistics";
  const STAGES = [
    { stage_id: "stage-3d-transport", label: "Stage 3D", title: "Transport", brief: "# Stage brief: 3D\n\nThe transport.\n" },
    { stage_id: "stage-4-editor", label: "Stage 4", title: "Editor", brief: "# Stage brief: 4\n\nThe editor.\n" },
  ];
  const manifest = (overrides: Record<string, unknown> = {}) => JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: STAGES, ...overrides }, null, 2);

  const MANIFEST_FILE = manifestFileName("reported-statistics-3f9a2c1b", WORKTREE);

  /** The sidecar the extension writes beside a manifest, or a doctored one. */
  const binding = (text: string, overrides: Partial<ManifestBindingRecord> = {}) =>
    renderBindingRecord({
      version: BINDING_VERSION,
      manifestFile: MANIFEST_FILE,
      manifestDigest: parseExecutionManifest(text)?.digest ?? "unreadable",
      planKey: "reported-statistics-3f9a2c1b",
      planLabel: PLAN_LABEL,
      projectDir: WORKTREE,
      ...overrides,
    });

  /** What the engine records for a run started from `text`, as this run's state holds it. */
  const expectationFor = (text: string, overrides: Partial<ManifestExpectation> = {}): ManifestExpectation => ({
    planLabel: PLAN_LABEL,
    currentStageId: "stage-4-editor",
    planDigest: parseExecutionManifest(text)?.digest ?? "",
    projectDir: WORKTREE,
    manifestFile: MANIFEST_FILE,
    ...overrides,
  });

  it("accepts the run's own manifest and hands back its stage identities", () => {
    const text = manifest();
    const bound = bindManifest(text, binding(text), expectationFor(text));
    assert.ok(bound.ok);
    assert.deepEqual(
      bound.identity.stages.map((stage) => stage.label),
      ["Stage 3D", "Stage 4"],
    );
    assert.equal(bound.identity.planLabel, PLAN_LABEL);
  });

  it("refuses a manifest that executes a different plan", () => {
    const text = manifest({ plan_label: "docs/plans/something-else.md" });
    const bound = bindManifest(text, binding(text, { planLabel: "docs/plans/something-else.md" }), expectationFor(text));
    assert.equal(bound.ok, false);
    assert.equal(bound.ok === false && bound.reason, "plan-label");
  });

  it("refuses a manifest that has been regenerated into something this run does not execute", () => {
    // The plan was rewritten and the stage ids changed under a run that is
    // still recorded as being at stage-4-editor. Redefining that run's stage
    // membership from it would move historical stages between runs.
    const text = manifest({ stages: [{ stage_id: "stage-5-something-new", label: "Stage 5", title: "New", brief: "x\n" }] });
    const bound = bindManifest(text, binding(text), expectationFor(text));
    assert.equal(bound.ok, false);
    assert.equal(bound.ok === false && bound.reason, "current-stage");
  });

  it("refuses an absent or unreadable manifest rather than guessing at one", () => {
    const good = manifest();
    for (const text of [undefined, "", "not json", JSON.stringify({ version: 2, plan_label: "x", source_digest: "y", stages: STAGES })]) {
      const bound = bindManifest(text, binding(good), expectationFor(good));
      assert.equal(bound.ok, false, `refused: ${String(text).slice(0, 20)}`);
      assert.equal(bound.ok === false && bound.reason, "unreadable");
    }
  });

  it("a complete run keeps its stages: its recorded current stage is its last one", () => {
    const text = manifest();
    assert.ok(bindManifest(text, binding(text), expectationFor(text)).ok, "completion is a status, and a manifest carries no status at all");
  });
});

/**
 * The reviewer's first reproduction, and the invariant that answers it.
 *
 * Checking the plan label and the presence of the current stage is not
 * membership: a regenerated manifest can keep both, add stages the run never
 * executed, be refused by the engine on the next resume, and still be read by
 * the UI as this run's history. The only honest statement of "this is the
 * manifest this run executes" is the engine's own identity for it — the
 * executable digest recorded as `plan_digest` — so that is what membership
 * follows.
 */
describe("membership follows the executable digest the run recorded", () => {
  const PLAN_LABEL = "docs/plans/reported-statistics.md";
  const WORKTREE = "/code/sporely-py-reported-statistics";
  const STAGE_3D = { stage_id: "stage-3d-transport", label: "Stage 3D", title: "Transport", brief: "# Stage brief: 3D\n\nThe transport.\n" };
  const STAGE_4 = { stage_id: "stage-4-editor", label: "Stage 4", title: "Editor", brief: "# Stage brief: 4\n\nThe editor.\n" };
  const M1 = JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [STAGE_3D, STAGE_4] }, null, 2);

  const D = parseExecutionManifest(M1)?.digest ?? "";
  const MANIFEST_FILE = manifestFileName("reported-statistics-3f9a2c1b", WORKTREE);

  const bindingFor = (text: string, overrides: Partial<ManifestBindingRecord> = {}) =>
    renderBindingRecord({
      version: BINDING_VERSION,
      manifestFile: MANIFEST_FILE,
      manifestDigest: parseExecutionManifest(text)?.digest ?? "unreadable",
      planKey: "reported-statistics-3f9a2c1b",
      planLabel: PLAN_LABEL,
      projectDir: WORKTREE,
      ...overrides,
    });

  /** The completed run: it recorded D when it started, and is at its last stage. */
  const RUN: ManifestExpectation = { planLabel: PLAN_LABEL, currentStageId: "stage-4-editor", planDigest: D, projectDir: WORKTREE, manifestFile: MANIFEST_FILE };

  const refused = (text: string, why: string) => {
    const bound = bindManifest(text, bindingFor(text), RUN);
    assert.equal(bound.ok, false, why);
    assert.equal(bound.ok === false && bound.reason, "plan-digest", why);
  };

  it("computes the same digest the engine records, over the engine's own content", () => {
    assert.match(D, /^[0-9a-f]{64}$/, "the engine's plan_digest shape");
    assert.equal(manifestDigest({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [STAGE_3D, STAGE_4] }), D, "the writer and the reader agree");
  });

  it("accepts M1, which is what the run recorded", () => {
    assert.ok(bindManifest(M1, bindingFor(M1), RUN).ok);
  });

  it("refuses M2: same plan label, same current stage, one stage the run never executed", () => {
    // The reviewer's attack, exactly: everything the old validation looked at
    // is unchanged, and the engine would refuse this file on the next resume.
    const M2 = JSON.stringify(
      { version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [STAGE_3D, STAGE_4, { stage_id: "stage-5-never-ran", label: "Stage 5", title: "Never ran", brief: "x\n" }] },
      null,
      2,
    );
    const identity = parseExecutionManifest(M2);
    assert.equal(identity?.identity.planLabel, PLAN_LABEL, "the plan label is unchanged");
    assert.ok(identity?.identity.stages.some((stage) => stage.stageId === "stage-4-editor"), "and the run's current stage is still there");
    refused(M2, "an appended stage changes what would execute");
  });

  it("refuses a manifest whose only change is to a historical stage", () => {
    refused(JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [STAGE_4] }, null, 2), "a removed stage");
    refused(JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [STAGE_4, STAGE_3D] }, null, 2), "a reordered sequence");
  });

  it("refuses a changed title, brief, mode or declared repository", () => {
    const withStage = (stage: Record<string, unknown>) => JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [stage, STAGE_4] }, null, 2);
    refused(withStage({ ...STAGE_3D, title: "Transport, revised" }), "the title participates");
    refused(withStage({ ...STAGE_3D, label: "Stage 3E" }), "the label participates");
    refused(withStage({ ...STAGE_3D, brief: "# Stage brief: 3D\n\nSomething else.\n" }), "the brief participates");
    refused(withStage({ ...STAGE_3D, mode: "independent_review" }), "the mode participates when it is not the default");
    refused(withStage({ ...STAGE_3D, repositories: [{ name: "sporely-web", path: "../sporely-web", branch: "feature/x", candidate_sha: null }] }), "a declared repository participates");
    refused(JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:different", stages: [STAGE_3D, STAGE_4] }, null, 2), "and so does the source digest");
  });

  it("keeps the default mode out of the digest, as the engine does", () => {
    // A manifest written before modes existed executes the implementation
    // lifecycle either way, so it must digest to the value its recorded run
    // already holds and must keep resuming.
    const explicit = JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages: [{ ...STAGE_3D, mode: "implementation" }, STAGE_4] }, null, 2);
    assert.equal(parseExecutionManifest(explicit)?.digest, D, "declaring the default changes nothing");
  });

  it("refuses to digest a manifest the engine itself would refuse", () => {
    const withStages = (stages: unknown[]) => JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "sha256:abc", stages }, null, 2);
    assert.equal(parseExecutionManifest(JSON.stringify({ version: 1, plan_label: PLAN_LABEL, source_digest: "s", stages: [STAGE_3D], status: "running" })), undefined, "an unknown top-level key");
    assert.equal(parseExecutionManifest(withStages([{ ...STAGE_3D, position: 1 }])), undefined, "an unknown stage key");
    assert.equal(parseExecutionManifest(withStages([{ ...STAGE_3D, brief: "   " }])), undefined, "a stage with nothing to implement from");
    assert.equal(parseExecutionManifest(withStages([{ ...STAGE_3D, stage_id: "../escape" }])), undefined, "a stage id that is not one path segment");
    assert.equal(parseExecutionManifest(withStages([STAGE_3D, STAGE_3D])), undefined, "duplicate stage ids");
    assert.equal(parseExecutionManifest(withStages([{ ...STAGE_3D, mode: "review" }])), undefined, "a mode this engine does not know");
    assert.equal(parseExecutionManifest(withStages([{ ...STAGE_3D, repositories: [{ name: "a", path: "../a", branch: "b", role: "sibling" }] }])), undefined, "an unknown repository key");
    assert.equal(
      parseExecutionManifest(
        withStages([{ ...STAGE_3D, repositories: [{ name: "a", path: "../a", branch: "b", candidate_sha: null }, { name: "a", path: "../b", branch: "c", candidate_sha: null }] }]),
      ),
      undefined,
      "duplicate repository names",
    );
  });

  it("does not mistake source-digest provenance for executable identity", () => {
    // `source_digest` is a hash of the plan *document* and is carried forward
    // across rebuilds precisely so prose edits do not end a run. It is one
    // input to the executable digest, never a stand-in for it.
    assert.notEqual(parseExecutionManifest(M1)?.identity.sourceDigest, D);
    assert.equal(parseExecutionManifest(M1)?.identity.sourceDigest, "sha256:abc");
  });
});

/**
 * The reviewer's third reproduction. Two worktrees of one repository running
 * the same plan path record identical state and build byte-identical
 * manifests, so neither the recorded state nor the executable digest can tell
 * them apart — and a file name never could, whatever it hashes. The worktree
 * is therefore *stated*, in a sidecar record beside the manifest.
 */
describe("a manifest is bound to a worktree by what it says, not by where it sits", () => {
  const PLAN_LABEL = "docs/plans/reported-statistics.md";
  const PLAN_KEY = "same-plan-7ea7171f";
  const A = "/tmp/sparring-worktree-33503";
  const B = "/tmp/sparring-worktree-75970";
  const TEXT = JSON.stringify(
    {
      version: 1,
      plan_label: PLAN_LABEL,
      source_digest: "sha256:abc",
      stages: [{ stage_id: "stage-4-editor", label: "Stage 4", title: "Editor", brief: "# Stage brief: 4\n" }],
    },
    null,
    2,
  );
  const DIGEST = parseExecutionManifest(TEXT)?.digest ?? "";

  const expectationFor = (worktree: string): ManifestExpectation => ({
    planLabel: PLAN_LABEL,
    currentStageId: "stage-4-editor",
    planDigest: DIGEST,
    projectDir: worktree,
    manifestFile: manifestFileName(PLAN_KEY, worktree),
  });

  const bindingWritten = (worktree: string) =>
    renderBindingRecord({
      version: BINDING_VERSION,
      manifestFile: manifestFileName(PLAN_KEY, worktree),
      manifestDigest: DIGEST,
      planKey: PLAN_KEY,
      planLabel: PLAN_LABEL,
      projectDir: worktree,
    });

  it("accepts each worktree's own record", () => {
    assert.ok(bindManifest(TEXT, bindingWritten(A), expectationFor(A)).ok);
    assert.ok(bindManifest(TEXT, bindingWritten(B), expectationFor(B)).ok);
  });

  it("refuses the other worktree's record even when everything else matches", () => {
    // Same plan path, same plan label, same current stage, same digest: the
    // two runs are indistinguishable except for this statement.
    const bound = bindManifest(TEXT, bindingWritten(B), expectationFor(A));
    assert.equal(bound.ok, false, "B's record must never establish membership for A");
    assert.equal(bound.ok === false && bound.reason, "unbound-worktree");
    assert.match(bound.ok === false ? bound.detail : "", /it was written for/);
  });

  it("refuses a manifest with no binding record at all", () => {
    const bound = bindManifest(TEXT, undefined, expectationFor(A));
    assert.equal(bound.ok, false, "an unvouched file is candidate evidence and nothing more");
    assert.equal(bound.ok === false && bound.reason, "unbound-worktree");
  });

  it("refuses a record that vouches for a different file or a different digest", () => {
    const wrongFile = bindManifest(TEXT, bindingWritten(A).replace(manifestFileName(PLAN_KEY, A), "someone-elses.manifest.json"), expectationFor(A));
    assert.equal(wrongFile.ok === false && wrongFile.reason, "unbound-worktree");
    const wrongDigest = bindManifest(TEXT, bindingWritten(A).replace(DIGEST, "f".repeat(64)), expectationFor(A));
    assert.equal(wrongDigest.ok === false && wrongDigest.reason, "unbound-worktree", "a stale record cannot vouch for a replaced manifest");
  });
});

/**
 * The digests below were produced by the engine itself, not by this code:
 *
 *     python -c "from agent_sparring.manifest import parse_manifest, manifest_digest; \
 *                print(manifest_digest(parse_manifest(open('m.json').read())))"
 *
 * against `agent_sparring/manifest.py` as it stands. They are pinned here so
 * that a change to either implementation is caught as a change to a recorded
 * value rather than discovered when a real run is refused mid-flight: the
 * extension compares this digest against the `plan_digest` the engine wrote,
 * so the two agreeing is not an optimisation, it is the contract.
 *
 * Each case pins one rule of `manifest_digest`: field order and NUL
 * separation, the default mode contributing nothing, a non-default mode and
 * declared repositories contributing, `candidate_sha: null` digesting as the
 * empty string, the trimming `_text` performs, and UTF-8 content.
 */
describe("the digest is the engine's own, vector by vector", () => {
  const VECTORS: { why: string; manifest: unknown; digest: string }[] = [
    {
      why: "two ordinary stages",
      manifest: {
        version: 1,
        plan_label: "docs/plans/active/reported-statistics.md",
        source_digest: "sha256:abc",
        stages: [
          { stage_id: "stage-3d-transport", label: "Stage 3D", title: "Transport", brief: "# Stage brief: 3D\n\nThe transport.\n" },
          { stage_id: "stage-4-editor", label: "Stage 4", title: "Editor", brief: "# Stage brief: 4\n\nThe editor.\n" },
        ],
      },
      digest: "00e14ac8114c3da13a0820263e944746b3aca06f5b8f8e0b2e0b403e40cbeb2b",
    },
    {
      why: "an explicitly declared default mode, which the engine leaves out of the digest",
      manifest: {
        version: 1,
        plan_label: "docs/plans/active/reported-statistics.md",
        source_digest: "sha256:abc",
        stages: [
          { stage_id: "stage-3d-transport", label: "Stage 3D", title: "Transport", brief: "b", mode: "implementation" },
          { stage_id: "stage-4-editor", label: "Stage 4", title: "Editor", brief: "b2" },
        ],
      },
      digest: "368a7af2cb47c5fbe9a340f11794775f3572808a948ef9f97180df9afdf9bdf2",
    },
    {
      why: "a review-only stage with two declared repositories, one unpinned",
      manifest: {
        version: 1,
        plan_label: "p.md",
        source_digest: "sha256:x",
        stages: [
          {
            stage_id: "s1",
            label: "Stage 1",
            title: "One",
            brief: "brief one",
            mode: "independent_review",
            repositories: [
              { name: "sporely-web", path: "../sporely-web-rs", branch: "feature/x", candidate_sha: null },
              { name: "sporely-py", path: "../sporely-py", branch: "feature/y", candidate_sha: "abc123" },
            ],
          },
        ],
      },
      digest: "1872dfed24f669c4e7f80016f1add8e90dd4eb5a2b2860da50a2a9eab0d63583",
    },
    {
      why: "surrounding whitespace, which the engine trims everywhere except the brief",
      manifest: {
        version: 1,
        plan_label: "  padded.md  ",
        source_digest: "  sha256:pad  ",
        stages: [{ stage_id: "  s1  ", label: "  Stage 1  ", title: "  One  ", brief: "  brief with spaces  " }],
      },
      digest: "458555dd56a9274fa909dbd3c3f0f235b2acae104aa9daac8dd554945ab95328",
    },
    {
      why: "non-ASCII labels, titles and briefs",
      manifest: {
        version: 1,
        plan_label: "unicode.md",
        source_digest: "sha256:u",
        stages: [{ stage_id: "s1-unicode", label: "Stage 1 — é", title: "Trykk på «knappen»", brief: "Norsk brief med æøå og — dash\n" }],
      },
      digest: "253586a7a82d0dddff4eaee3f60383bd8b8f59b6bc41ac01f031488a151d03e8",
    },
    {
      why: "explicit nulls for the two optional fields",
      manifest: { version: 1, plan_label: "nullrepo.md", source_digest: "sha256:n", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b", repositories: null, mode: null }] },
      digest: "f0747985cb38f78c02310f859591c023818b56ee1228e166dac16d1b8cad7f8f",
    },
  ];

  for (const vector of VECTORS) {
    it(`matches the engine for ${vector.why}`, () => {
      assert.equal(parseExecutionManifest(JSON.stringify(vector.manifest))?.digest, vector.digest);
    });
  }

  /**
   * And the other half of the agreement: a manifest the engine refuses has no
   * digest here either. A more lenient reader would compute a value for a file
   * the engine would never run, and the UI would read it as history.
   */
  it("refuses everything the engine refuses", () => {
    const REFUSED: unknown[] = [
      { version: 2, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b" }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b" }], status: "running" },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b", position: 1 }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "   " }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "../escape", label: "L", title: "T", brief: "b" }] },
      {
        version: 1,
        plan_label: "p.md",
        source_digest: "s",
        stages: [
          { stage_id: "s1", label: "L", title: "T", brief: "b" },
          { stage_id: "s1", label: "L2", title: "T2", brief: "b2" },
        ],
      },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b", mode: "review" }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b", repositories: [{ name: "a", path: "../a", branch: "b", role: "x" }] }] },
      {
        version: 1,
        plan_label: "p.md",
        source_digest: "s",
        stages: [
          {
            stage_id: "s1",
            label: "L",
            title: "T",
            brief: "b",
            repositories: [
              { name: "a", path: "../a", branch: "b", candidate_sha: null },
              { name: "a", path: "../c", branch: "d", candidate_sha: null },
            ],
          },
        ],
      },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [] },
      { version: 1, plan_label: "", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b" }] },
      { version: 1, plan_label: "p.md", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b" }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "L", title: "T", brief: "b", repositories: [{ name: "a", path: "../a", branch: "b", candidate_sha: 7 }] }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: [{ stage_id: "s1", label: "", title: "T", brief: "b" }] },
      { version: 1, plan_label: "p.md", source_digest: "s", stages: "not-an-array" },
    ];
    for (const refused of REFUSED) {
      assert.equal(parseExecutionManifest(JSON.stringify(refused)), undefined, `refused: ${JSON.stringify(refused).slice(0, 90)}`);
    }
  });
});
