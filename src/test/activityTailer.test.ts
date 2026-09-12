import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { describe, it } from "node:test";
import { ActivityTailer } from "../core/activityTailer";
import { Workspace, event } from "./fixtures";

const STAGE = "s1";

async function setup() {
  const ws = await Workspace.create();
  await ws.writeStage(STAGE);
  return { ws, tailer: new ActivityTailer(ws.activityPath(STAGE)) };
}

describe("activity tailer", () => {
  it("idles on a missing file and reads only appended events afterwards", async () => {
    const { ws, tailer } = await setup();
    let result = await tailer.poll();
    assert.equal(result.exists, false);
    assert.equal(result.reset, false);
    assert.deepEqual(result.events, []);

    await ws.appendActivity(STAGE, [event("loop", "loop.started"), event("stage", "turn.started", { provider: "claude-cli" })]);
    result = await tailer.poll();
    assert.equal(result.exists, true);
    assert.deepEqual(
      result.events.map((e) => e.event),
      ["loop.started", "turn.started"],
    );

    result = await tailer.poll();
    assert.deepEqual(result.events, []);

    await ws.appendActivity(STAGE, [event("stage", "file.changed", { path: "src/foo.py" })]);
    result = await tailer.poll();
    assert.deepEqual(
      result.events.map((e) => e.event),
      ["file.changed"],
    );
  });

  it("buffers a partial last line until its newline arrives", async () => {
    const { ws, tailer } = await setup();
    const full = JSON.stringify(event("sparrer", "verdict", { action: "SEND_BACK", summary: "fix the ünïcode test" })) + "\n";
    const cut = Buffer.from(full, "utf8");
    // Split in the middle of a multi-byte character to exercise the decoder too.
    const splitAt = cut.indexOf(Buffer.from("ü", "utf8")) + 1;
    await fs.appendFile(ws.activityPath(STAGE), cut.subarray(0, splitAt));

    let result = await tailer.poll();
    assert.deepEqual(result.events, []);
    assert.equal(result.malformed, 0);

    await fs.appendFile(ws.activityPath(STAGE), cut.subarray(splitAt));
    result = await tailer.poll();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].summary, "fix the ünïcode test");
  });

  it("counts malformed lines without stopping", async () => {
    const { ws, tailer } = await setup();
    await ws.appendActivity(STAGE, ["garbage line\n", event("loop", "loop.started"), "\n"]);
    const result = await tailer.poll();
    assert.equal(result.malformed, 1);
    assert.equal(result.events.length, 1);
  });

  it("resets when the file is deleted and replays when it is recreated", async () => {
    const { ws, tailer } = await setup();
    await ws.appendActivity(STAGE, [event("loop", "loop.started"), event("stage", "turn.started")]);
    assert.equal((await tailer.poll()).events.length, 2);

    await fs.rm(ws.activityPath(STAGE));
    let result = await tailer.poll();
    assert.equal(result.exists, false);
    assert.equal(result.reset, true);

    result = await tailer.poll();
    assert.equal(result.reset, false, "a second poll on a still-missing file is quiet");

    await ws.appendActivity(STAGE, [event("stage", "handoff.ready")]);
    result = await tailer.poll();
    assert.equal(result.exists, true);
    assert.deepEqual(
      result.events.map((e) => e.event),
      ["handoff.ready"],
    );
  });

  it("resets on truncation instead of reading from a stale offset", async () => {
    const { ws, tailer } = await setup();
    await ws.appendActivity(STAGE, [event("loop", "loop.started"), event("stage", "turn.started"), event("stage", "turn.finished")]);
    assert.equal((await tailer.poll()).events.length, 3);

    await fs.writeFile(ws.activityPath(STAGE), JSON.stringify(event("loop", "loop.started")) + "\n");
    const result = await tailer.poll();
    assert.equal(result.reset, true);
    assert.deepEqual(
      result.events.map((e) => e.event),
      ["loop.started"],
    );
  });

  it("detects a same-size recreation through the inode", async () => {
    const { ws, tailer } = await setup();
    const line = JSON.stringify(event("loop", "loop.started")) + "\n";
    await fs.writeFile(ws.activityPath(STAGE), line);
    assert.equal((await tailer.poll()).events.length, 1);

    await fs.rm(ws.activityPath(STAGE));
    await fs.writeFile(ws.activityPath(STAGE), line);
    const result = await tailer.poll();
    assert.equal(result.reset, true);
    assert.equal(result.events.length, 1);
  });
});
