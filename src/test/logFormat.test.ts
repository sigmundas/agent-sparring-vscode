import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEvent, formatTime } from "../core/logFormat";
import { event } from "./fixtures";

function line(actor: string, name: string, fields = {}): string | undefined {
  const formatted = formatEvent(event(actor, name, fields));
  return formatted?.slice(10); // drop the local-time column
}

describe("output channel formatting", () => {
  it("renders the semantic chronology from the spec", () => {
    assert.equal(line("stage", "turn.started", { provider: "claude-cli", resumed: false }), "Claude/stage    turn started");
    assert.equal(line("stage", "file.changed", { provider: "claude-cli", path: "src/foo.py", tool: "Edit" }), "Claude/stage    changed src/foo.py");
    assert.equal(line("stage", "handoff.ready", { provider: "claude-cli" }), "Stage           handoff ready");
    assert.equal(line("sparrer", "sparring.started", { provider: "codex-cli", resumed: false }), "Codex/sparrer   started");
    assert.equal(line("sparrer", "verdict", { provider: "codex-cli", action: "SEND_BACK", summary: "tests missing" }), "Sparrer         SEND_BACK — tests missing");
    assert.equal(line("loop", "loop.send_back", { cycle: 1, action: "SEND_BACK" }), "Loop            SEND_BACK · cycle 1 resumes both sessions");
    assert.equal(line("gate", "candidate.accepted", { sha: "0123456789abcdef" }), "Gate            accepted 01234567…");
    assert.equal(line("plan", "plan.stage.entered", { summary: "Stage 3/6" }), "Plan            entered Stage 3/6");
    assert.equal(line("plan", "plan.paused", { action: "NEEDS_YOU" }), "Plan            paused (NEEDS_YOU)");
  });

  it("drops noisy per-tool events and never prints payloads", () => {
    assert.equal(line("stage", "tool.call", { tool: "Read" }), undefined);
    assert.equal(line("stage", "command.started", { tool: "Bash" }), undefined);
    assert.equal(line("stage", "provider.result", { summary: "success, 12 turn(s)" }), undefined);
    assert.equal(line("sparrer", "command.finished", { provider: "codex-cli", tool: "shell", exit_code: 2 }), "Codex/sparrer   command exited 2");
  });

  it("labels unknown providers by id and missing ones by role", () => {
    assert.equal(line("stage", "turn.started", { provider: "other-cli" }), "other-cli/stage turn started");
    assert.equal(line("stage", "turn.started"), "Stage agent/stage turn started");
  });

  it("tolerates unparseable timestamps", () => {
    assert.equal(formatTime("nope"), "--:--:--");
  });
});
