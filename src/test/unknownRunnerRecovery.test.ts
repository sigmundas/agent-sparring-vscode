/**
 * `unknown` must not be a place where a person's work is stranded.
 *
 * The reported sequence: a runner's fate could not be established, its
 * terminal never reconnected, the in-memory launch stayed `unknown`, the
 * evidence submission tied to it stayed `pending` — and the launch was not
 * persisted at all, because only a launch that still had a terminal object
 * was written down. After the next reload there was nothing left to settle,
 * the submission was pending for ever, and every evidence action was
 * disabled with no way back to the five results and the findings the person
 * had typed.
 *
 * Two things fix that, and both are asserted here:
 *
 *  9. an unknown launch is persisted, with its explanation, and survives
 *     another reload;
 * 10. there is an explicit human recovery — "I checked — runner is no longer
 *     active" — which settles the runner, makes the submission retryable and
 *     keeps every drafted byte, while claiming neither that the engine
 *     recorded the evidence nor that it failed.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, before, beforeEach } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { humanChecksFor, humanFeedbackFor, withHumanCheck, withHumanFeedback, type CheckRecord } from "../core/humanChecks";
import type { ExecutionRecord } from "../core/liveness";
import { renderOverviewHtml } from "../core/overviewHtml";
import { UNKNOWN_RUNNER_EXPLANATION, buildOverviewModel, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import {
  SUBMISSION_UNRESOLVED,
  submissionFor,
  submissionState,
  withSubmission,
  withSubmissionUnresolved,
  type SubmissionRecord,
  type Submissions,
} from "../core/submission";
import { Workspace } from "./fixtures";
import { FakeTerminal, install, reset, until } from "./vscodeStub";

const stub = install();

type Tracker = import("../vscode/executionTracker").ExecutionTracker;
type Registry = import("../vscode/operationRegistry").OperationRegistry;

let OperationRegistry: typeof import("../vscode/operationRegistry").OperationRegistry;
let ExecutionTracker: typeof import("../vscode/executionTracker").ExecutionTracker;
let runnerKey: typeof import("../vscode/operationRegistry").runnerKey;

const LAUNCHES_KEY = "agentSparring.launches";

before(async () => {
  const registry = await import("../vscode/operationRegistry");
  OperationRegistry = registry.OperationRegistry;
  runnerKey = registry.runnerKey;
  ExecutionTracker = (await import("../vscode/executionTracker")).ExecutionTracker;
});

interface Store {
  get<T>(key: string, fallback?: T): T;
  update(key: string, value: unknown): Promise<void>;
  keys(): string[];
}

function store(): Store {
  const kept = new Map<string, unknown>();
  return {
    get: <T,>(key: string, fallback?: T) => (kept.has(key) ? (kept.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown) => void (value === undefined ? kept.delete(key) : kept.set(key, value)),
    keys: () => [...kept.keys()],
  };
}

function pool(): { acquire: (cwd: string) => unknown; acquired: FakeTerminal[] } {
  const acquired: FakeTerminal[] = [];
  return {
    acquired,
    acquire: () => {
      const terminal = new FakeTerminal(`Agent Sparring — test ${acquired.length + 1}`, 9100 + acquired.length);
      acquired.push(terminal);
      stub.window.terminals.push(terminal);
      return { terminal, idle: () => true, release: () => undefined, discard: () => undefined, retire: () => undefined };
    },
  };
}

const waitingForIntegration = () => until(() => (stub.window.integrationEmitter.waiting > 0 ? true : undefined), "the launch to wait for shell integration");

// ---------------------------------------------------------------------------
// 9. an unknown launch is a fact worth keeping
// ---------------------------------------------------------------------------

describe("a runner whose fate is unknown survives a reload", () => {
  beforeEach(() => reset());

  const cwd = path.join(os.tmpdir(), "agent-sparring-unknown-persistence");
  const runId = `${cwd}|plan:foo-abcd1234`;
  const manifest = `${cwd}/foo.manifest.json`;
  const options = {
    configured: process.execPath,
    args: ["run-plan", "--manifest", manifest, "--repo-root", cwd],
    cwd,
    repoRoot: cwd,
    name: "run-plan",
    runId,
    kind: "run-plan" as const,
    manifest,
    reveal: false,
  };

  it("9. it is persisted as unknown, with its explanation, and is still there after the next reload", async () => {
    const logged: string[] = [];
    const kept = store();
    // A dedicated runner whose terminal then goes away without the pty host
    // reporting an exit code — the case where nothing is known either way.
    const first: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const firstPool = pool();
    const firstTracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], firstPool as never, first, () => false, async () => []);
    try {
      const launching = firstTracker.launch(options);
      await waitingForIntegration();
      firstPool.acquired[0].dispose(); // no shell integration: the dedicated route
      assert.equal((await launching).ok, true);
      const dedicated = stub.window.terminals[stub.window.terminals.length - 1];
      await until(() => (kept.get<unknown[]>(LAUNCHES_KEY, []).length === 1 ? true : undefined), "the launch to be persisted");

      dedicated.close(); // gone, with no exit code for its process
      await until(() => (firstTracker.executionFor(runId)?.state === "unknown" ? true : undefined), "liveness to become unknown rather than stopped");
      assert.match(firstTracker.executionFor(runId)?.detail ?? "", /cannot determine whether the previous runner is still active/);
      await until(() => (firstTracker.persisted().some((launch) => launch.runId === runId && launch.state === "unknown") ? true : undefined), "the unknown launch to be persisted");
      assert.equal(first.inFlightFor(runnerKey(runId))?.state, "running-dedicated", "and the operation guard is untouched by any of it");
    } finally {
      firstTracker.dispose();
      first.dispose();
    }

    // The reload. Nothing reconnects — which is the condition that used to
    // make the record vanish altogether.
    reset();
    const second: Registry = new OperationRegistry({ workspaceState: kept } as never, (message: string) => logged.push(message), () => false, async () => []);
    const secondTracker: Tracker = new ExecutionTracker({ workspaceState: kept } as never, (message) => logged.push(message), () => [], pool() as never, second, () => false, async () => []);
    try {
      await secondTracker.reattach();
      const record = secondTracker.executionFor(runId);
      assert.equal(record?.state, "unknown", "the unknown runner is still on the record after the reload");
      assert.deepEqual(
        secondTracker.persisted().filter((launch) => launch.runId === runId),
        [{ runId, state: "unknown" }],
        "and it is persisted again, so a third reload finds it too",
      );
      assert.equal(second.inFlightFor(runnerKey(runId))?.state, "running-dedicated", "with its guard, which only evidence or the person releases");
    } finally {
      secondTracker.dispose();
      second.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. the recovery, on the surface the person is looking at
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-18T11:13:00.000Z");
const STAGE = "stage-4-editor-and-ui-inspection";
const CHECKS = [
  { id: "editor-roundtrip", instruction: "Edit a synthetic table, save it, reopen the application.", pass_criteria: "Pass if the reopened attachment holds the edited values." },
  { id: "wording-and-layout", instruction: "Inspect both editors in light and dark themes.", pass_criteria: "Pass if no line is clipped." },
] as const;
const NOTES: Record<string, string> = {
  "editor-roundtrip": "Saved, reopened: the edited values survived the round trip.",
  "wording-and-layout": "Both themes; the tag line wraps and focus stays visible.",
};
const FEEDBACK = "The correction flow should offer an explicit semantic selector rather than a developer-oriented override.";

function sparringReport(): string {
  const gate = { category: "DEVICE_MANUAL_CHECK", title: "Verify the editor interactions before committing", checks: CHECKS.map((check) => ({ ...check, source: null })) };
  return [
    "# Sparring: stage 4",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: Two interactive checks are the remaining acceptance blockers.",
    "- Needs-you reason: DEVICE/MANUAL CHECK -- the editors cannot be exercised by the agents.",
    "",
    "## NEEDS YOU",
    "",
    HUMAN_GATE_MARKER,
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
  ].join("\n");
}

/** A standalone stage waiting for a human, with the drafts a person had entered. */
async function gate() {
  const ws = await Workspace.create();
  await ws.writeStage(STAGE, { status: "working", implementation_session_id: "impl", sparring_session_id: "spar" }, { "sparring.md": sparringReport() });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const runId = selection.selected!.id;
  let drafts = {};
  for (const check of CHECKS) {
    drafts = withHumanCheck(drafts, runId, check.id, { outcome: "pass" });
    drafts = withHumanCheck(drafts, runId, check.id, { note: NOTES[check.id] });
  }
  const entered = { checks: humanChecksFor(drafts, runId) as Record<string, CheckRecord>, feedback: humanFeedbackFor(withHumanFeedback({}, runId, FEEDBACK), runId) as string };

  /** Exactly what the panel does on every update, from persisted state only. */
  const view = (state: { submissions?: Submissions; execution?: ExecutionRecord }): { model: OverviewModel; html: string } => {
    const artifacts: OverviewArtifacts = {
      handoff: false,
      sparring: true,
      brief: false,
      plan: false,
      humanChecks: entered.checks,
      humanFeedback: entered.feedback,
      submission: submissionFor(state.submissions, runId),
    };
    const model = buildOverviewModel(selection, undefined, artifacts, NOW, state.execution);
    return { model, html: renderOverviewHtml(model, "n", "c") };
  };
  return { runId, view, entered };
}

/** The runner this evidence was handed to, whose fate nothing could establish. */
const unknownRunner = (runId: string): ExecutionRecord => ({
  id: "1789463594979-1",
  runId,
  kind: "run-sparring",
  source: "reattached",
  state: "unknown",
  startedAtMs: NOW - 120_000,
  detail: "No process in the table can be positively attributed to this run. Agent Sparring cannot determine whether the previous runner is still active.",
});

describe("a submission stranded behind an unknown runner can be recovered by the person", () => {
  it("10. the drafts survive, the confirmation makes it retryable, and no success or failure is invented", async () => {
    const { runId, view } = await gate();
    const submitted: SubmissionRecord = {
      runId,
      channel: "checks",
      executionId: "1789463594979-1",
      startedAtMs: NOW - 120_000,
      entry: "2026-09-18 — manual verification recorded in VS Code…",
      results: 2,
      stageId: STAGE,
    };
    let submissions = withSubmission({}, submitted);

    // The dead end, as reported: the runner is unknown, the submission is
    // pending, and every evidence action is withheld.
    const stuck = view({ submissions, execution: unknownRunner(runId) });
    assert.equal(submissionState({ state: "unknown" }), "pending", "an unknown runner says nothing about the submission, so it stays pending");
    assert.equal(stuck.model.kind, "run");
    assert.equal(stuck.model.actionRequired?.submitting?.label, "Submitting…");
    assert.equal(stuck.model.actionRequired?.submit.enabled, false);
    assert.equal(stuck.model.actionRequired?.feedback.send.enabled, false);

    // What is new: the way out is on the screen, next to the state it
    // settles, and it names the exact execution it is about.
    const recovery = stuck.model.unknownRunner;
    assert.ok(recovery, "the Overview offers the explicit recovery");
    assert.equal(recovery.label, "I checked — runner is no longer active");
    assert.equal(recovery.executionId, "1789463594979-1", "targeting the exact execution, so a stale panel cannot settle a newer run");
    assert.match(recovery.detail, /cannot determine whether the previous runner is still active/);
    assert.equal(UNKNOWN_RUNNER_EXPLANATION, "Agent Sparring cannot determine whether the previous runner is still active. Check it before allowing another attempt.");
    assert.doesNotMatch(recovery.detail, /guard|attribution|observation lost|running-shell|operation id/i, "and it says none of that in the extension's own lifecycle words");
    assert.match(stuck.html, /data-action="confirmRunnerInactive"/, "as a real control on the page");
    assert.ok(stuck.html.includes("I checked — runner is no longer active"));

    // The person checks, and says so. That is an assertion about the runner,
    // and it is all it is: the submission becomes unresolved, not recorded
    // and not failed.
    submissions = withSubmissionUnresolved(submissions, runId, { atMs: NOW, note: "You confirmed that the runner this evidence was handed to is no longer active. Whether the engine recorded it is unknown, so nothing is claimed either way." });
    const confirmed = submissionFor(submissions, runId);
    assert.ok(confirmed?.unresolved, "the statement is recorded on the submission");
    assert.equal(confirmed.entry, submitted.entry, "with what was submitted kept verbatim");
    assert.equal(confirmed.failure, undefined, "it was not marked failed to make the buttons work");

    const after = view({ submissions, execution: { ...unknownRunner(runId), state: "ended", endedAtMs: NOW, detail: "You confirmed that this runner is no longer active." } });
    const panel = after.model.actionRequired!;

    // Every drafted byte is still exactly where the person left it.
    assert.deepEqual(
      panel.required.map((item) => [item.key, item.record?.outcome, item.record?.note]),
      CHECKS.map((check) => [check.id, "pass", NOTES[check.id]]),
      "two Pass results with their notes, unchanged",
    );
    assert.equal(panel.feedback.draft, FEEDBACK, "and the freeform findings, byte for byte");

    // And it can be sent again.
    assert.equal(panel.submitting, undefined, "it is no longer presented as in flight");
    assert.equal(panel.submit.enabled, true, "the evidence can be submitted again");
    assert.equal(panel.feedback.send.enabled, true);
    assert.equal(panel.submissionUnresolved?.preserved, SUBMISSION_UNRESOLVED);
    assert.match(panel.submissionUnresolved?.reason ?? "", /Whether the engine recorded it is unknown/);
    assert.equal(panel.submissionUnresolved?.what, "2 check results and any notes are still drafted below.");
    assert.equal(panel.submissionFailure, undefined, "nothing claims the engine failed");
    assert.match(after.html, new RegExp(`<p class="preserved">.*?${SUBMISSION_UNRESOLVED.slice(0, 40)}`));
    for (const check of CHECKS) {
      assert.match(after.html, new RegExp(`class="choice pass on" data-check="${check.id}" data-outcome="pass" aria-pressed="true"`), `${check.id} still shows Pass`);
      assert.ok(after.html.includes(NOTES[check.id]), `${check.id} still shows its note`);
    }
  });
});
