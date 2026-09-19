import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { appendHumanEvidence, checkKey, renderHumanEvidence, submittableChecks } from "../core/humanChecks";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { Workspace, normalUi } from "./fixtures";

const NOW = Date.parse("2026-09-13T10:00:00.000Z");
const STAGE_ID = "stage-3c-cloud-schema-rpc-and-sync-transport";

/** The real Stage 3C shape: prose that bundles several human checks, no explicit checklist. */
const PROSE_PLAN = [
  "# Reported statistics and explicit range semantics",
  "",
  "## Stage 3B — Local persistence",
  "",
  "Done.",
  "",
  "## Stage 3C — Cloud schema/RPC and sync transport",
  "",
  "### Verification expectations",
  "",
  "- Desktop: focused sync modules, `py_compile`, `git diff --check`.",
  "- Human-gated under AGENTS.md: live cloud/CAS/cross-client behaviour, and",
  "  that a deployed pre-Stage-3C server rejects an enhanced write. Do not claim",
  "  either without the branch owner's evidence.",
  "",
  "## Stage 3D — Snapshot v2",
  "",
].join("\n");
const HUMAN_GATED = "Human-gated under AGENTS.md: live cloud/CAS/cross-client behaviour, and that a deployed pre-Stage-3C server rejects an enhanced write. Do not claim either without the branch owner's evidence.";

/** The same stage with an explicit checklist. */
const EXPLICIT_PLAN = PROSE_PLAN.replace(
  "\n## Stage 3D",
  ["", "### Manual verification", "", "- [ ] Enhanced push from desktop A, pull on desktop B: byte-identical row.", "- [ ] CAS retry after a concurrent edit keeps the extension group intact.", "- [ ] Deployed pre-Stage-3C server rejects an enhanced write with invalid_payload.", "", "## Stage 3D"].join("\n"),
);

const SPARRING = [
  `# Sparring: ${STAGE_ID}`,
  "",
  "## Finding / discussion",
  "",
  "Long findings.",
  "",
  "## Routing outcome",
  "",
  "- Action: `NEEDS_YOU`",
  "- Summary: Code review found no bounded implementation defect; deployment and live compatibility checks remain required.",
  "- Needs-you reason: EXTERNAL CONDITION -- deploy the cloud migration and verify live cross-client/CAS behavior",
  "",
  "## NEEDS YOU",
  "",
  "Code review found no bounded implementation defect.",
  "",
  "## Deferred",
  "",
  "Human-gated checks remain: apply/deploy migration 20260913120000 after migration-list/dry-run review; exercise live enhanced push, pull, CAS retry, cross-client reconciliation, and real PostgREST JSONB reads; and verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload. The known bare-tombstone invalid_parent behavior is appropriately deferred to a separate stage.",
  "",
].join("\n");

const DEPLOY = "Apply/deploy migration 20260913120000 after migration-list/dry-run review";
const LIVE = "Exercise live enhanced push, pull, CAS retry, cross-client reconciliation, and real PostgREST JSONB reads";
const OLDER = "Verify a deployed pre-Stage-3C server rejects an enhanced write with invalid_payload";

const NOTES_WITH_DEPLOYMENT = [
  `# Notes: ${STAGE_ID}`,
  "",
  "## Human evidence",
  "",
  "2026-09-13 (branch owner):",
  "",
  "- Pre-deploy checks: `supabase migration list` showed `20260913120000` local-only; `supabase db push --dry-run` listed exactly that one migration.",
  "- `supabase db push` applied the migration; `supabase migration list` afterwards shows local and remote both at `20260913120000`.",
  "",
  "Still pending, not claimed: live enhanced push → pull → reconcile between two clients, CAS retry and cross-client conflict behaviour, PostgREST JSONB rendering. The deployed pre-Stage-3C server check can no longer be observed live.",
  "",
].join("\n");

async function stage3c(options: { drafts?: OverviewArtifacts["humanChecks"]; plan?: string | false; notes?: string; sparring?: string } = {}) {
  const ws = await Workspace.create();
  const files: Record<string, string> = { "sparring.md": options.sparring ?? SPARRING };
  if (options.notes) {
    files["notes.md"] = options.notes;
  }
  await ws.writeStage(STAGE_ID, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar", base_sha: "d".repeat(40) }, files);
  const planPath = path.join(ws.root, "docs", "plan.md");
  const planText = options.plan === false ? undefined : (options.plan ?? PROSE_PLAN);
  if (planText) {
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, planText);
  }
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const artifacts: OverviewArtifacts = {
    handoff: true,
    sparring: true,
    brief: false,
    plan: false,
    associatedPlan: planText ? { path: planPath, exists: true, text: planText } : undefined,
    humanChecks: options.drafts ?? {},
    notesText: options.notes,
  };
  return { ws, planPath, planText, model: buildOverviewModel(selection, undefined, artifacts, NOW) };
}

describe("Action required — prose plan (Stage 3C shape)", () => {
  it("keeps the plan sentence as the parent and lists the reviewer's clauses as separately labelled checks", async () => {
    const { model } = await stage3c();
    const panel = model.actionRequired;
    assert.ok(panel);
    assert.equal(panel.kind, "needs_you");
    assert.equal(model.banner, undefined);
    assert.equal(model.planName, "Reported statistics and explicit range semantics");
    assert.equal(panel.reviewerNote, "EXTERNAL CONDITION -- deploy the cloud migration and verify live cross-client/CAS behavior");
    assert.deepEqual(
      panel.parents.map((parent) => parent.text),
      [HUMAN_GATED],
    );
    assert.equal(panel.explicitCount, 0);
    assert.equal(panel.reviewerCount, 3);
    assert.deepEqual(panel.recorded, []);
    assert.deepEqual(
      panel.required.map((item) => [item.origin, item.text]),
      [
        ["reviewer", DEPLOY],
        ["reviewer", LIVE],
        ["reviewer", OLDER],
      ],
    );
    assert.equal(panel.progress, "0 / 3 verified");
    assert.equal(panel.ready, false);
    assert.equal(panel.headline, "Action required");
    assert.equal(panel.submit.label, "Submit for review");
    assert.equal(panel.submit.enabled, false);
    assert.match(panel.submit.detail, /Record a result for all 3 remaining checks first/);
    assert.deepEqual(panel.resume, { action: "runStage", label: "Resume stage", detail: `sparring run-loop ${STAGE_ID}: the stage agent implements again first, then the reviewer looks. Use it when there is work to do, not to hand over evidence.` });
    assert.equal(panel.planSection, true);
  });

  it("evidence already in notes.md moves a check out of Still required, with the entry that proves it; denials do not", async () => {
    const { model } = await stage3c({ notes: NOTES_WITH_DEPLOYMENT, drafts: { [checkKey(LIVE)]: { outcome: "pass", note: "Two clients agree." } } });
    const panel = model.actionRequired!;
    assert.deepEqual(
      panel.recorded.map((item) => [item.text, item.evidence?.how]),
      [[DEPLOY, "prose"]],
    );
    assert.match(panel.recorded[0].evidence?.excerpt ?? "", /^Pre-deploy checks|^`supabase db push` applied/);
    assert.deepEqual(
      panel.required.map((item) => [item.text, item.record?.outcome]),
      [
        [LIVE, "pass"],
        [OLDER, undefined],
      ],
      "the still-pending paragraph names these checks but denies them, so they stay required",
    );
    assert.equal(panel.progress, "2 / 3 verified");
    assert.equal(panel.ready, false, "one requested check still has no outcome");
    assert.equal(panel.submit.enabled, false);
    assert.match(panel.submit.detail, /Record a result for the remaining check first/);
    assert.deepEqual(
      submittableChecks(panel).map((check) => check.text),
      [LIVE],
      "recorded checks are never re-claimed on submit",
    );
    assert.equal(model.stageStatus, "Needs you", "recording changes nothing about the stage's state");
  });

  it("renders the hierarchy once each: parent prose, recorded ✓ with excerpt, required ○ with controls; no repeated reviewer text", async () => {
    const { model } = await stage3c({ notes: NOTES_WITH_DEPLOYMENT, drafts: { [checkKey(LIVE)]: { outcome: "pass", note: "Two <clients> agree." } } });
    const html = renderOverviewHtml(model, "n", "c");
    const ui = normalUi(html);
    assert.match(html, /<h2><svg[^>]*>.*?<\/svg>Action required<\/h2><p class="summary">Code review found no bounded implementation defect; deployment and live compatibility checks remain required.<\/p><p class="reason"><span class="tag reviewer">Reviewer note<\/span> EXTERNAL CONDITION -- deploy the cloud migration and verify live cross-client\/CAS behavior<\/p>/);
    assert.equal((ui.match(/EXTERNAL CONDITION/g) ?? []).length, 1, "the reviewer's category line appears once");
    assert.equal((ui.match(/Human-gated checks remain/g) ?? []).length, 0, "the Deferred block is not repeated as prose; its clauses are the checks");
    assert.equal((ui.match(/Needs you/g) ?? []).length, 1, "one primary status badge");
    assert.ok(html.indexOf("<h4>Plan requirement</h4>") < html.indexOf("<h4>Evidence already recorded</h4>"));
    assert.ok(html.indexOf("<h4>Evidence already recorded</h4>") < html.indexOf("<h4>Still required</h4>"));
    assert.ok(html.includes(`<p class="criterion parent" title="Plan line 12">${HUMAN_GATED.replace(/'/g, "&#39;")}</p>`), "the plan's own words, escaped only");
    // How the checks were derived is provenance, not instruction: it moved to
    // the collapsed technical layer, where the reader can still find it.
    assert.ok(!/checks taken from the sparring report/.test(ui), "the derivation prose is not part of the human task");
    assert.match(html, /<dt>How these checks were derived<\/dt><dd>3 of them come from the sparring report/);
    assert.match(html, new RegExp(`<ol class="checklist recorded"><li class="check done pass"><div class="checkrow"><span class="mark">✓</span><div class="checkbody"><p class="criterion">${DEPLOY.replace(/\//g, "\\/")} <span class="tag reviewer"[^>]*>Reviewer</span></p><p class="muted small evidence"[^>]*>notes.md: `));
    const key = checkKey(LIVE);
    assert.match(html, new RegExp(`<li class="check pass">\\s*<div class="checkrow"><span class="mark">○</span><div class="checkbody"><p class="criterion">${LIVE} <span class="tag reviewer"[^>]*>Reviewer</span></p></div></div>\\s*<div class="record"><span class="choices"><button type="button" class="choice pass on" data-check="${key}" data-outcome="pass" aria-pressed="true" title="[^"]*">Pass</button><button type="button" class="choice fail" data-check="${key}"`));
    assert.match(html, new RegExp(`<textarea class="note" data-check="${key}" rows="1" placeholder="Evidence or note \\(optional\\)">Two &lt;clients&gt; agree.</textarea>`));
    assert.ok(!html.includes(`data-check="${checkKey(DEPLOY)}"`), "recorded checks have no result controls");
    assert.match(
      html,
      /<button type="button" class="primary" data-action="submitForReview" title="[^"]*" disabled>Submit for review<\/button><button type="button" data-action="sendFeedbackForReview" title="[^"]*" disabled>Send feedback for review<\/button><button type="button" data-action="openPlanSection"[^>]*>Open plan section<\/button><button type="button" data-action="openSparring"[^>]*>Open detailed review<\/button><button type="button" data-copy="review"[^>]*>Copy context for chat<\/button><button type="button" class="quiet" data-action="continueAutomatically"[^>]*>Continue plan automatically<\/button><details class="more"[^>]*><summary[^>]*>…<\/summary><div class="actions"><button type="button" class="quiet" data-action="runStage"[^>]*>Resume stage \(implementation\)<\/button>/,
      "resuming implementation is behind the … disclosure, never beside the button that answers the review",
    );
    assert.ok(!html.includes('class="banner') && !html.includes("Latest sparring result") && !/<span class="status needs_you"/.test(html));
    assert.ok(!/data-action="acceptStage"/.test(html), "no acceptance is offered from the panel");
  });

  it("with no reviewer clauses, the parent requirement itself is the recordable unit", async () => {
    const plain = SPARRING.replace(/## Deferred[\s\S]*$/, "").replace(/- Needs-you reason:.*\n/, "");
    const { model } = await stage3c({ sparring: plain });
    const panel = model.actionRequired!;
    assert.deepEqual(
      panel.required.map((item) => [item.origin, item.text]),
      [["plan", HUMAN_GATED]],
    );
    assert.equal(panel.reviewerNote, undefined);
    assert.match(renderOverviewHtml(model, "n", "c"), new RegExp(`<p class="criterion">${HUMAN_GATED.replace(/'/g, "&#39;").replace(/\//g, "\\/")} <span class="tag plan"`));
  });
});

describe("Action required — explicit ### Manual verification checklist", () => {
  it("renders the task items 1:1 as plan checks, adds only reviewer clauses that are new, and counts progress from recorded lines", async () => {
    const notes = appendHumanEvidence(`# Notes: ${STAGE_ID}\n`, renderHumanEvidence([{ text: "Enhanced push from desktop A, pull on desktop B: byte-identical row.", origin: "plan", record: { outcome: "pass", note: "ok" } }], new Date(NOW))!);
    const { model } = await stage3c({ plan: EXPLICIT_PLAN, notes });
    const panel = model.actionRequired!;
    assert.equal(panel.explicitCount, 3);
    assert.deepEqual(
      panel.recorded.map((item) => [item.origin, item.text, item.evidence?.how, item.evidence?.outcome]),
      [["plan", "Enhanced push from desktop A, pull on desktop B: byte-identical row.", "exact", "pass"]],
    );
    assert.deepEqual(
      panel.required.map((item) => [item.origin, item.text]),
      [
        ["plan", "CAS retry after a concurrent edit keeps the extension group intact."],
        ["plan", "Deployed pre-Stage-3C server rejects an enhanced write with invalid_payload."],
        ["reviewer", DEPLOY],
      ],
      "the reviewer's live-behaviour and pre-Stage-3C clauses are the same checks as plan items and are dropped; deployment is new",
    );
    assert.equal(panel.reviewerCount, 1);
    assert.equal(panel.progress, "1 / 4 verified");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /<p class="criterion">CAS retry after a concurrent edit keeps the extension group intact\. <span class="tag plan" title="Plan line 19">Plan<\/span><\/p>/);
    // An explicit plan checklist speaks for itself: the checks are shown as
    // written, and the count of them is not a thing to read first.
    assert.ok(!/explicit checks under the plan/.test(normalUi(html)));
  });
});

describe("Action required — absence and boundaries", () => {
  it("says why there are no checks instead of inventing them", async () => {
    const plain = SPARRING.replace(/## Deferred[\s\S]*$/, "").replace(/- Needs-you reason:.*\n/, "");
    const noPlan = (await stage3c({ plan: false, sparring: plain })).model.actionRequired!;
    assert.deepEqual([noPlan.recorded, noPlan.required], [[], []]);
    assert.match(noPlan.noChecks ?? "", /No plan is linked/);
    assert.equal(noPlan.planSection, false);
    const unmatched = (await stage3c({ plan: "# Plan\n\n## Stage 9 — Something else\n\n- Manual: x\n", sparring: plain })).model.actionRequired!;
    assert.match(unmatched.noChecks ?? "", /doesn't yet know which section/);
    const html = renderOverviewHtml((await stage3c({ plan: false, sparring: plain })).model, "n", "c");
    assert.match(html, /Manual verification <\/h3><p class="muted">No plan is linked to this stage/);
  });

  it("without a plan, the reviewer's clauses are still offered as checks, labelled reviewer", async () => {
    const panel = (await stage3c({ plan: false })).model.actionRequired!;
    assert.deepEqual(
      panel.required.map((item) => item.origin),
      ["reviewer", "reviewer", "reviewer"],
    );
    assert.deepEqual(panel.parents, []);
  });

  it("never modifies the plan file, whatever is derived or drafted", async () => {
    const { planPath, planText } = await stage3c({ notes: NOTES_WITH_DEPLOYMENT, drafts: { [checkKey(LIVE)]: { outcome: "pass" } } });
    assert.equal(await fs.readFile(planPath, "utf8"), planText);
  });

  it("is absent while a turn acts on the outcome and for outcomes that are not a hand-over", async () => {
    const { model } = await stage3c({ sparring: SPARRING.replace("`NEEDS_YOU`", "`SEND_BACK`") });
    assert.equal(model.actionRequired, undefined);
    assert.ok(model.lastSparring, "the ordinary Latest sparring result stays for SEND_BACK");
  });
});
