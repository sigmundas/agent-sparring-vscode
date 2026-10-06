/**
 * A start-plan direct-route run is tracked under its confirmation's
 * provisional id, while evidence submitted to it is filed under the engine's
 * run id. Confirming its runner inactive must act on the execution under the
 * first identity and on the evidence under the second.
 */

import assert from "node:assert/strict";
import { before, it } from "node:test";
import { START_PLAN_RUNS_KEY } from "../core/startPlanBinding";
import { SUBMISSIONS_KEY, submissionKeyOf, withSubmission, type SubmissionRecord, type Submissions } from "../core/submission";
import { install } from "./vscodeStub";

install();
let Controller: typeof import("../vscode/controller").SparringController;
before(async () => {
  Controller = (await import("../vscode/controller")).SparringController;
});

it("confirming a bound run's execution inactive keeps the drafts and marks its evidence unresolved", async () => {
  const engineRun = "/repo|plan|plans-direct-0badf00d";
  const provisional = "/repo|plan|plans-direct-start-12345678";
  const record: SubmissionRecord = { runId: engineRun, channel: "checks", executionId: "exec-1", startedAtMs: 1, entry: "four Passes", results: 4, stageId: "stage-1" };
  const values = new Map<string, unknown>([
    [START_PLAN_RUNS_KEY, { pending: [], bindings: { [engineRun]: provisional } }],
    [SUBMISSIONS_KEY, withSubmission(undefined, record)],
  ]);
  const workspaceState = { get: <T>(key: string, fallback?: T): T => (values.get(key) ?? fallback) as T, update: async (key: string, value: unknown) => void values.set(key, value), keys: () => [...values.keys()] };
  const asked: [string, string][] = [];
  const fake = {
    context: { workspaceState },
    tracker: { confirmInactive: (runId: string, executionId: string) => (asked.push([runId, executionId]), { confirmed: true as const }) },
    submissions: { inFlightFor: () => undefined, override: () => ({ overridden: false }) },
    log: () => {},
    render: () => {},
  };
  const outcome = await Controller.prototype.confirmRunnerInactive.call(fake as never, engineRun, "exec-1");
  assert.deepEqual(asked, [[provisional, "exec-1"]], "the execution is ended under the id it is tracked by");
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.submission, true, "the evidence is found under the engine's run id");
  const stored = (values.get(SUBMISSIONS_KEY) as Submissions)[submissionKeyOf(record)] as SubmissionRecord;
  assert.ok(stored.unresolved, "and made retryable");
  assert.equal(stored.entry, "four Passes", "with its text intact");
});
