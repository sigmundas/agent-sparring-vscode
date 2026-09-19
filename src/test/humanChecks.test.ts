import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSparringOutcome, type SparringOutcome } from "../core/engineFormats";
import {
  appendHumanEvidence,
  checkKey,
  deriveVerification,
  humanChecksFor,
  matchReviewerRequest,
  parseHumanEvidence,
  planChecks,
  PROGRESS_UNTESTED_WORD,
  progressText,
  recordedEvidenceFor,
  renderHumanEvidence,
  reviewerChecks,
  submittableChecks,
  withHumanCheck,
  withoutHumanChecks,
} from "../core/humanChecks";

/** A cut-down Stage 3C section in the plan's own shape: prose that bundles several checks, no explicit checklist. */
const PROSE_PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Stage 3B — Local persistence",
  "",
  "- Human-gated: shipped old build opens the library.",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "Implemented 2026-09-13; candidate awaiting sparring.",
  "",
  "### Scope — `sporely-web`",
  "",
  "- Reviewed migration adding the three columns; the branch owner deploys it.",
  "",
  "### Verification expectations",
  "",
  "- Round trip: an enhanced local row pushed, pulled into a second library and",
  "  reconciled is byte-identical in canonical form.",
  "- Desktop: focused sync modules, `py_compile`, `git diff --check`.",
  "- Human-gated under AGENTS.md: live cloud/CAS/cross-client behaviour, and",
  "  that a deployed pre-Stage-3C server rejects an enhanced write. Do not claim",
  "  either without the branch owner's evidence.",
  "",
  "```md",
  "- Manual: inside a fence, ignored",
  "```",
  "",
  "### Hard boundaries",
  "",
  "Do not: change the manual parser work.",
  "",
  "## Stage 3D — Snapshot v2",
  "",
  "- Manual: belongs to the next stage.",
  "",
].join("\n");
const STAGE_3C_LINE = 7;
const HUMAN_GATED = "Human-gated under AGENTS.md: live cloud/CAS/cross-client behaviour, and that a deployed pre-Stage-3C server rejects an enhanced write. Do not claim either without the branch owner's evidence.";

/** The same stage written with an explicit checklist. */
const EXPLICIT_PLAN = [
  "# Plan",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "### Verification expectations",
  "",
  "- Human-gated under AGENTS.md: live behaviour; see the checklist below.",
  "",
  "### Manual verification",
  "",
  "- [ ] Enhanced push from desktop A, pull on desktop B: the row is byte-identical.",
  "- [ ] CAS retry after a concurrent edit keeps the extension group intact.",
  "- [x] Deployed pre-Stage-3C server rejects an enhanced write with `invalid_payload`.",
  "- Not a task item: notes for the tester.",
  "",
  "## Stage 3D — Next",
  "",
].join("\n");

const DEFERRED =
  "Human-gated checks remain: apply/deploy migration 20260913120000 after migration-list/dry-run review; exercise live enhanced push, pull, CAS retry, cross-client reconciliation, and real PostgREST JSONB reads; and verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload. The known bare-tombstone invalid_parent behavior is appropriately deferred to a separate stage; snapshot v2 and attachment transport remain Stage 3D.";
const OUTCOME: SparringOutcome = {
  action: "NEEDS_YOU",
  summary: "Code review found no bounded implementation defect; deployment and live compatibility checks remain required.",
  needsYouReason: "EXTERNAL CONDITION -- deploy the cloud migration and verify live cross-client/CAS behavior",
  deferred: DEFERRED,
};

describe("plan checks from the matched section", () => {
  it("explicit ### Manual verification task items become checks 1:1, marks ignored, plain bullets there ignored", () => {
    const checks = planChecks(EXPLICIT_PLAN, 3);
    assert.deepEqual(
      checks.explicit.map((check) => check.text),
      ["Enhanced push from desktop A, pull on desktop B: the row is byte-identical.", "CAS retry after a concurrent edit keeps the extension group intact.", "Deployed pre-Stage-3C server rejects an enhanced write with `invalid_payload`."],
    );
    assert.deepEqual(
      checks.explicit.map((check) => check.line),
      [11, 12, 13],
    );
    assert.deepEqual(
      checks.parents.map((check) => check.text),
      ["Human-gated under AGENTS.md: live behaviour; see the checklist below."],
      "the prose requirement stays as the parent, not as a duplicate check",
    );
  });

  it("prose plan: the human-worded items of the verification sub-section are parents, verbatim with continuation lines; no explicit checks", () => {
    const checks = planChecks(PROSE_PLAN, STAGE_3C_LINE);
    assert.deepEqual(checks.explicit, []);
    assert.deepEqual(
      checks.parents.map((check) => [check.text, check.heading, check.line]),
      [[HUMAN_GATED, "Verification expectations", 20]],
    );
  });

  it("does not leak items from scope, hard boundaries, fenced code or neighbouring stages", () => {
    const texts = planChecks(PROSE_PLAN, STAGE_3C_LINE).parents.map((check) => check.text);
    assert.ok(!texts.some((text) => text.includes("Reviewed migration")));
    assert.ok(!texts.some((text) => text.includes("inside a fence")));
    assert.ok(!texts.some((text) => text.includes("next stage")));
    assert.ok(!texts.some((text) => text.includes("shipped old build")));
  });

  it("falls back to the whole section without a verification sub-heading; empty without human items or for a non-heading line", () => {
    const plan = ["## Stage 2 — Schema", "", "- Add the column.", "- Manual: check the device shows it.", "", "## Stage 3 — Next", ""].join("\n");
    assert.deepEqual(
      planChecks(plan, 1).parents.map((check) => check.text),
      ["Manual: check the device shows it."],
    );
    assert.deepEqual(planChecks("## Stage 1 — Contract\n\n### Verification\n- Unit tests pass.\n", 1), { explicit: [], parents: [] });
    assert.deepEqual(planChecks("## Stage 1 — Contract\n\n- Manual: x\n", 2), { explicit: [], parents: [] });
  });

  it("keys are stable across whitespace and case, distinct for different wording", () => {
    assert.equal(checkKey("Manual:  check  the device"), checkKey("manual: check the device"));
    assert.notEqual(checkKey("Manual: check the device"), checkKey("Manual: check the server"));
  });
});

describe("reviewer requested checks from the sparring result", () => {
  it("splits ## Deferred prose at sentence and semicolon boundaries only, drops the lead-in and deferrals to other stages", () => {
    assert.deepEqual(reviewerChecks(OUTCOME), [
      "Apply/deploy migration 20260913120000 after migration-list/dry-run review",
      "Exercise live enhanced push, pull, CAS retry, cross-client reconciliation, and real PostgREST JSONB reads",
      "Verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload",
    ]);
  });

  it("uses the needs-you reason when there is no Deferred section, minus its category prefix; nothing without either", () => {
    assert.deepEqual(reviewerChecks({ ...OUTCOME, deferred: undefined }), ["Deploy the cloud migration and verify live cross-client/CAS behavior"]);
    assert.deepEqual(reviewerChecks({ action: "NEEDS_YOU", summary: "s" }), []);
    assert.deepEqual(reviewerChecks(undefined), []);
  });

  it("takes list items 1:1 when the reviewer wrote a list", () => {
    const listed = { ...OUTCOME, deferred: "- Verify push → pull on two clients.\n- Confirm CAS retry keeps the group.\n- Snapshot v2 is deferred to a separate stage." };
    assert.deepEqual(reviewerChecks(listed), ["Verify push → pull on two clients", "Confirm CAS retry keeps the group"]);
  });

  it("matches a sentence to the single check sharing enough words; ties and unrelated text match nothing", () => {
    const checks = planChecks(PROSE_PLAN, STAGE_3C_LINE).parents;
    assert.equal(matchReviewerRequest(checks, OUTCOME.needsYouReason!), 0);
    assert.equal(matchReviewerRequest(checks, "Please rename the migration file."), undefined);
    const twins = [{ text: "Manual: verify the enhanced row on the desktop client." }, { text: "Manual: verify the enhanced row on the second desktop client." }];
    assert.equal(matchReviewerRequest(twins, "enhanced row on the desktop"), undefined);
  });
});

const NOTES = [
  "# Notes: stage-3c",
  "",
  "## Implementation notes",
  "",
  "- Local proof of the C0 behaviour: on the pre-migration local schema the RPC returned invalid_payload. (Not human evidence: wrong section.)",
  "",
  "## Human evidence",
  "",
  "2026-09-13 (branch owner, via Claude Code; deployment approved interactively):",
  "",
  "- Pre-deploy checks in `sporely-web-reported-statistics`: `supabase migration list` showed 106 versions",
  "  identical local/remote and `20260913120000` local-only; `supabase db push --dry-run` listed exactly",
  "  that one migration.",
  "- `supabase db push` applied `20260913120000_add_reference_measurement_content_extension.sql` to the",
  "  project; `supabase migration list` afterwards shows local and remote both at `20260913120000`.",
  "- Deployed state read back (read-only SQL): the three columns exist on `public.reference_measurement_sets`",
  "  (jsonb / double precision ×2, nullable, no default); 12 existing rows, 0 enhanced: no data was touched.",
  "",
  "Still pending, not claimed: live enhanced push → pull → reconcile between two signed-in desktop clients,",
  "CAS retry and cross-client conflict behaviour, and PostgREST JSONB rendering on a real owner read. The",
  '"deployed pre-Stage-3C server rejects an enhanced write" check can no longer be observed live.',
  "",
  "2026-09-14 — manual verification recorded in VS Code:",
  "",
  "- Blocked — Verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload · reviewer request",
  "  Server is post-3C now; the local pre-migration run stands.",
  "",
].join("\n");

describe("recorded evidence from notes.md ## Human evidence", () => {
  it("parses entries (bullets with continuation lines, paragraphs), flags negative ones and structured result lines", () => {
    const entries = parseHumanEvidence(NOTES);
    assert.equal(entries.length, 7, "intro line, three bullets, the still-pending paragraph, the second date line, the structured line");
    assert.ok(!entries.some((entry) => entry.text.includes("Local proof")), "other sections are not human evidence");
    assert.match(entries[1].text, /^Pre-deploy checks .* that one migration\.$/);
    assert.equal(entries[1].negative, false);
    assert.equal(entries[4].negative, true, '"Still pending, not claimed" is not evidence of completion');
    assert.deepEqual([entries[6].outcome, entries[6].checkText], ["blocked", "Verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload"]);
    assert.deepEqual(parseHumanEvidence(undefined), []);
    assert.deepEqual(parseHumanEvidence("# Notes\n\n## Implementation notes\n\n- x\n"), []);
  });

  it("recorded evidence: exact structured lines first, else a clearly overlapping non-negative entry, else nothing", () => {
    const entries = parseHumanEvidence(NOTES);
    const [deploy, live, older] = reviewerChecks(OUTCOME);
    const deployed = recordedEvidenceFor({ text: deploy }, entries);
    assert.equal(deployed?.how, "prose");
    assert.match(deployed?.excerpt ?? "", /^Pre-deploy checks|^`supabase db push` applied/);
    assert.equal(recordedEvidenceFor({ text: live }, entries), undefined, "the still-pending paragraph names these checks but denies them");
    const olderEvidence = recordedEvidenceFor({ text: older }, entries);
    assert.deepEqual([olderEvidence?.how, olderEvidence?.outcome], ["exact", "blocked"]);
    assert.match(olderEvidence?.excerpt ?? "", new RegExp(`^Blocked — ${older} · reviewer request Server is post-3C now`));
  });
});

describe("deriveVerification", () => {
  const drafts = { [checkKey("Exercise live enhanced push, pull, CAS retry, cross-client reconciliation, and real PostgREST JSONB reads")]: { outcome: "pass" as const, note: "Both clients agree." } };

  it("prose plan: the parent stays as prose, the reviewer's clauses are the recordable checks, recorded ones leave Still required", () => {
    const view = deriveVerification(planChecks(PROSE_PLAN, STAGE_3C_LINE), OUTCOME, parseHumanEvidence(NOTES), drafts);
    assert.deepEqual(
      view.parents.map((parent) => parent.text),
      [HUMAN_GATED],
    );
    assert.equal(view.explicitCount, 0);
    assert.equal(view.reviewerCount, 3);
    assert.deepEqual(
      view.recorded.map((item) => [item.text, item.origin, item.evidence?.how, item.evidence?.outcome]),
      [
        ["Apply/deploy migration 20260913120000 after migration-list/dry-run review", "reviewer", "prose", undefined],
        ["Verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload", "reviewer", "exact", "blocked"],
      ],
    );
    assert.deepEqual(
      view.required.map((item) => [item.text, item.origin, item.record?.outcome]),
      [["Exercise live enhanced push, pull, CAS retry, cross-client reconciliation, and real PostgREST JSONB reads", "reviewer", "pass"]],
    );
    assert.equal(view.progress, "2 / 3 verified · 1 couldn't test", "the engine's Blocked is reported as what it means: no result was obtained");
    assert.deepEqual(
      submittableChecks(view).map((check) => [check.text.slice(0, 8), check.origin, check.record.outcome]),
      [["Exercise", "reviewer", "pass"]],
      "only outstanding checks with a drafted outcome are submitted; recorded ones are not re-claimed",
    );
  });

  it("explicit plan: task items are the checks; a reviewer clause that is the same check is dropped, a new one is added and labelled reviewer", () => {
    const outcome: SparringOutcome = { action: "NEEDS_YOU", summary: "s", deferred: "Verify CAS retry after a concurrent edit keeps the extension group intact; also confirm real PostgREST JSONB reads render the details object." };
    const view = deriveVerification(planChecks(EXPLICIT_PLAN, 3), outcome, [], {});
    assert.equal(view.explicitCount, 3);
    assert.equal(view.reviewerCount, 1);
    assert.deepEqual(
      view.required.map((item) => [item.origin, item.text]),
      [
        ["plan", "Enhanced push from desktop A, pull on desktop B: the row is byte-identical."],
        ["plan", "CAS retry after a concurrent edit keeps the extension group intact."],
        ["plan", "Deployed pre-Stage-3C server rejects an enhanced write with `invalid_payload`."],
        ["reviewer", "Confirm real PostgREST JSONB reads render the details object"],
      ],
    );
    assert.equal(view.progress, "0 / 4 verified · 4 remaining");
  });

  it("without explicit or reviewer checks, the parent requirement itself is the recordable unit", () => {
    const view = deriveVerification(planChecks(PROSE_PLAN, STAGE_3C_LINE), { action: "NEEDS_YOU", summary: "s" }, [], {});
    assert.deepEqual(
      view.required.map((item) => [item.origin, item.text]),
      [["plan", HUMAN_GATED]],
    );
    assert.equal(view.reviewerCount, 0);
  });

  it("no checks at all yields empty lists and no progress", () => {
    const view = deriveVerification({ explicit: [], parents: [] }, { action: "NEEDS_YOU", summary: "s" }, [], {});
    assert.deepEqual([view.recorded, view.required, view.progress], [[], [], undefined]);
  });
});

describe("recorded outcomes (drafts) and the ## Human evidence entry", () => {
  it("merges outcome and note per check, drops empty records, clears per run", () => {
    let drafts = withHumanCheck(undefined, "run|a", "k1", { outcome: "pass" });
    drafts = withHumanCheck(drafts, "run|a", "k1", { note: "Seen on both clients." });
    drafts = withHumanCheck(drafts, "run|a", "k2", { outcome: "blocked" });
    assert.deepEqual(humanChecksFor(drafts, "run|a"), { k1: { outcome: "pass", note: "Seen on both clients." }, k2: { outcome: "blocked", note: undefined } });
    drafts = withHumanCheck(drafts, "run|a", "k1", { note: "   " });
    assert.deepEqual(humanChecksFor(drafts, "run|a").k1, { outcome: "pass", note: undefined }, "an empty note is withdrawn; the outcome it was written under is not");
    // A field the change does not carry is a field the message did not carry:
    // the two controls of one check report separately and must not erase each
    // other. Clearing a whole run's drafts is what withoutHumanChecks is for.
    drafts = withHumanCheck(drafts, "run|a", "k2", { outcome: undefined });
    assert.deepEqual(humanChecksFor(drafts, "run|a").k2, { outcome: "blocked", note: undefined }, "an absent outcome changes nothing");
    drafts = withHumanCheck(drafts, "run|a", "k2", { note: "Second client unavailable." });
    assert.deepEqual(humanChecksFor(drafts, "run|a").k2, { outcome: "blocked", note: "Second client unavailable." });
    assert.deepEqual(humanChecksFor(withoutHumanChecks(drafts, "run|a"), "run|a"), {});
    assert.deepEqual(humanChecksFor(undefined, "run|a"), {});
  });

  it("ignores malformed stored records", () => {
    const drafts = { "run|a": { k1: { outcome: "maybe" }, k2: "junk", k3: { note: 7 } } } as unknown as Parameters<typeof humanChecksFor>[0];
    assert.deepEqual(humanChecksFor(drafts, "run|a"), {});
  });

  it("progress counts every outcome as itself, and never as another", () => {
    const pass = { record: { outcome: "pass" as const } };
    const fail = { record: { outcome: "fail" as const } };
    const cantTest = { record: { outcome: "blocked" as const } };
    const unanswered = {};
    const times = <T,>(count: number, item: T): T[] => Array.from({ length: count }, () => item);

    assert.equal(progressText([]), undefined);

    // 1. all Pass. 2. all Fail. Nothing is added when a bucket is empty.
    assert.equal(progressText(times(5, pass)), "5 / 5 verified");
    assert.equal(progressText(times(5, fail)), "0 / 5 verified · 5 failed");

    // 3. The reported case: five checks a person could not run. It is not
    // five things blocking the stage and it is not five failures — it is
    // five verifications that could not be obtained.
    const allUntested = progressText(times(5, cantTest));
    assert.equal(allUntested, "0 / 5 verified · 5 couldn't test");
    assert.doesNotMatch(allUntested!, /blocked/i, "never the engine's own word, which reads as something standing in the way");
    assert.doesNotMatch(allUntested!, /failed/, "and never as a failure, which nobody observed");
    assert.equal(PROGRESS_UNTESTED_WORD, "couldn't test");

    // 4. Mixed, all answered. 5. Mixed with unanswered checks, which are
    // their own bucket: "I could not test it" and "I have not said" are
    // different statements.
    assert.equal(progressText([pass, pass, pass, fail, cantTest]), "3 / 5 verified · 1 failed · 1 couldn't test");
    assert.equal(progressText([pass, pass, fail, cantTest, unanswered]), "2 / 5 verified · 1 failed · 1 couldn't test · 1 remaining");
    assert.equal(progressText(times(3, unanswered)), "0 / 3 verified · 3 remaining");

    // Evidence already in notes.md counts the same way as a draft, by its
    // own recorded outcome; an entry with no outcome word is a pass.
    assert.equal(progressText([pass, { evidence: { excerpt: "x", how: "prose" } }, unanswered]), "2 / 3 verified · 1 remaining");
    assert.equal(progressText([pass, fail, { evidence: { excerpt: "x", how: "exact", outcome: "blocked" } }]), "1 / 3 verified · 1 failed · 1 couldn't test");
  });

  it("renders only checks with an outcome, quoting the check wording, marking reviewer checks, indenting the note", () => {
    const entry = renderHumanEvidence(
      [
        { text: "Exercise live enhanced push", origin: "reviewer", record: { outcome: "pass", note: "Both clients agree;\nsee screenshots." } },
        { text: HUMAN_GATED, origin: "plan", record: { outcome: "blocked" } },
        { text: "ignored", origin: "plan", record: { note: "only a note" } },
      ],
      new Date("2026-09-13T10:00:00Z"),
      "Reported statistics and explicit range semantics",
    );
    assert.equal(
      entry,
      [
        "2026-09-13 — manual verification recorded in VS Code against the checks of Reported statistics and explicit range semantics:",
        "",
        "- Pass — Exercise live enhanced push · reviewer request",
        "  Both clients agree;",
        "  see screenshots.",
        `- Blocked — ${HUMAN_GATED}`,
      ].join("\n"),
    );
    assert.equal(renderHumanEvidence([{ text: "x", origin: "plan", record: { note: "only a note" } }], new Date()), undefined);
  });

  it("what Submit writes is read back as recorded evidence for the same checks (round trip)", () => {
    const entry = renderHumanEvidence([{ text: "Exercise live enhanced push", origin: "reviewer", record: { outcome: "pass", note: "ok" } }], new Date("2026-09-13T10:00:00Z"))!;
    const notes = appendHumanEvidence("# Notes: x\n", entry);
    const recorded = recordedEvidenceFor({ text: "Exercise live enhanced push" }, parseHumanEvidence(notes));
    assert.deepEqual([recorded?.how, recorded?.outcome], ["exact", "pass"]);
  });

  it("appends under ## Human evidence exactly as the engine does, creating the heading once", () => {
    const first = appendHumanEvidence("# Notes: x\n\n## Implementation notes\n\n- a\n", "entry one");
    assert.equal(first, "# Notes: x\n\n## Implementation notes\n\n- a\n\n## Human evidence\n\nentry one\n");
    const second = appendHumanEvidence(first, "entry two\n");
    assert.equal(second, `${first.replace(/\n$/, "")}\n\nentry two\n`);
    assert.equal(second.split("## Human evidence").length, 2);
  });
});

describe("sparring.md ## Deferred", () => {
  it("is carried on the routing outcome when present, not when templated", () => {
    const md = ["# Sparring: x", "", "## Routing outcome", "", "- Action: `NEEDS_YOU`", "- Summary: s", "- Needs-you reason: r", "", "## NEEDS YOU", "", "s", "", "## Deferred", "", "Human-gated checks remain: live push/pull.", ""].join("\n");
    assert.equal(parseSparringOutcome(md)?.deferred, "Human-gated checks remain: live push/pull.");
    assert.equal(parseSparringOutcome(md.replace("Human-gated checks remain: live push/pull.", "(none)"))?.deferred, undefined);
    assert.equal(parseSparringOutcome(md.replace(/## Deferred[\s\S]*$/, ""))?.deferred, undefined);
  });
});
