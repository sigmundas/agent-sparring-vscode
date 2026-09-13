import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EngineFormatError,
  parseActivityLine,
  parsePlanRunState,
  parsePlanStages,
  parseSparringOutcome,
  parseStageState,
  stageIdFor,
} from "../core/engineFormats";
import { FOO_PLAN_KEY, FOO_PLAN_MARKDOWN, FOO_STAGE_IDS, sparringMarkdown } from "./fixtures";

describe("plan-run state (plans/<key>.json)", () => {
  it("parses the engine's exact field names", () => {
    const state = parsePlanRunState(
      JSON.stringify({
        current_stage: "foo-1cd13d24-stage-2-schema-api",
        current_stage_index: 1,
        expected_branch: "feature/x",
        plan: "docs/plans/foo.md",
        plan_digest: "abc",
        status: "paused",
      }),
    );
    assert.equal(state.currentStage, "foo-1cd13d24-stage-2-schema-api");
    assert.equal(state.currentStageIndex, 1);
    assert.equal(state.status, "paused");
    assert.equal(state.expectedBranch, "feature/x");
  });

  it("rejects unknown statuses and missing fields", () => {
    assert.throws(() => parsePlanRunState(JSON.stringify({ plan: "p", plan_digest: "d", expected_branch: "b", current_stage_index: 0, current_stage: "s", status: "done" })), EngineFormatError);
    assert.throws(() => parsePlanRunState(JSON.stringify({ status: "running" })), EngineFormatError);
    assert.throws(() => parsePlanRunState("not json"), EngineFormatError);
  });
});

describe("stage state (state.json)", () => {
  it("defaults status to working and keeps nulls", () => {
    const state = parseStageState("{}");
    assert.equal(state.status, "working");
    assert.equal(state.candidateSha, null);
  });

  it("reads accepted state with session ids", () => {
    const state = parseStageState(
      JSON.stringify({ status: "accepted", implementation_session_id: "82ab", sparring_session_id: "019d", base_sha: "a", candidate_sha: "b" }),
    );
    assert.equal(state.status, "accepted");
    assert.equal(state.implementationSessionId, "82ab");
    assert.equal(state.sparringSessionId, "019d");
  });

  it("rejects a wrong-typed session id like the engine does", () => {
    assert.throws(() => parseStageState(JSON.stringify({ implementation_session_id: 5 })), EngineFormatError);
  });
});

describe("activity lines", () => {
  it("parses the envelope and closed optional fields", () => {
    const parsed = parseActivityLine('{"v":1,"ts":"2026-09-12T19:02:13.000Z","actor":"stage","event":"turn.started","resumed":false,"provider":"claude-cli","junk":"x"}');
    assert.ok(parsed);
    assert.equal(parsed.actor, "stage");
    assert.equal(parsed.provider, "claude-cli");
    assert.equal(parsed.resumed, false);
    assert.equal((parsed as unknown as Record<string, unknown>)["junk"], undefined);
  });

  it("returns undefined for blank, malformed and non-object lines", () => {
    assert.equal(parseActivityLine(""), undefined);
    assert.equal(parseActivityLine("{"), undefined);
    assert.equal(parseActivityLine("[1,2]"), undefined);
    assert.equal(parseActivityLine('{"v":1}'), undefined);
  });
});

describe("plan stage headings", () => {
  it("derives the same stage ids as the engine", () => {
    const stages = parsePlanStages(FOO_PLAN_MARKDOWN, FOO_PLAN_KEY);
    assert.deepEqual(
      stages.map((s) => s.stageId),
      FOO_STAGE_IDS,
    );
    assert.deepEqual(
      stages.map((s) => s.title),
      ["Contract", "Schema & API", "Device/UI check!"],
    );
  });

  it("refuses malformed headings and numbering gaps", () => {
    assert.throws(() => parsePlanStages("## Stage one — x\n"), EngineFormatError);
    assert.throws(() => parsePlanStages("## Stage 1 — a\n## Stage 3 — c\n"), EngineFormatError);
  });

  it("returns an empty list for a document without stages", () => {
    assert.deepEqual(parsePlanStages("# Notes\n\nNo stages here.\n"), []);
  });

  it("clamps long ids to 128 characters", () => {
    const id = stageIdFor("k", 1, "x".repeat(200));
    assert.ok(id.length <= 128);
    assert.ok(!id.endsWith("-"));
  });
});

describe("sparring.md routing outcome", () => {
  it("reads action, summary and reason", () => {
    const outcome = parseSparringOutcome(sparringMarkdown("NEEDS_YOU", "Confirm on device", "device_manual_check"));
    assert.deepEqual(outcome, { action: "NEEDS_YOU", summary: "Confirm on device", needsYouReason: "device_manual_check", deferred: undefined });
  });

  it("returns undefined for the untouched template", () => {
    assert.equal(parseSparringOutcome("# Sparring: x\n\n## Finding / discussion\n\n(Open discussion.)\n"), undefined);
  });
});
