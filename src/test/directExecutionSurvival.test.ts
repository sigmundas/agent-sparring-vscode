/**
 * How long a direct engine execution actually lives, measured rather than
 * assumed.
 *
 * The submission record's first design left a direct operation out of the
 * persisted set on the grounds that such a process cannot outlive the
 * extension host. That was an assumption, and it is false. `commandRunner.ts`
 * reaches the engine with `execFile` when no shell integration is available,
 * and a window reload restarts the extension host — which on POSIX does not
 * touch its children at all:
 *
 *   - killing the parent, even with SIGKILL, does not signal the child;
 *   - the child is reparented to pid 1 and keeps running;
 *   - its command line stays in the process table, which is what makes it
 *     recognisable to the window that comes back.
 *
 * This test spawns a child the same way `commandRunner.ts` does, kills its
 * parent as brutally as anything can be killed, and asserts all three. The
 * other direct transport — a dedicated terminal, whose process belongs to VS
 * Code's pty host and not to the extension host — is asserted in the
 * integration suite (section `outlives`), because it needs a real host.
 *
 * Consequence, and the reason this test exists: a started direct operation
 * must keep an identity across a reload, or a reload becomes permission to
 * run freeze-candidate, accept-candidate or new-stage a second time.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parsePsOutput } from "../core/processTree";

/** The process table, read exactly as processProbe.ts reads it. */
function processes(): Promise<ReturnType<typeof parsePsOutput>> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(parsePsOutput(stdout))));
  });
}

function alive(pid: number, table: ReturnType<typeof parsePsOutput>): (typeof table)[number] | undefined {
  return table.find((item) => item.pid === pid);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a direct engine execution outlives the process that started it", () => {
  it("survives its parent being SIGKILLed, reparented and still identifiable", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process semantics");
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-survival-"));
    const log = path.join(dir, "calls.log");
    const engine = path.join(dir, "sparring");
    // Stands in for the engine: records the call, then works for a while.
    await fs.writeFile(engine, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nsleep 20\n`);
    await fs.chmod(engine, 0o755);
    // Stands in for the extension host: spawns the engine the way
    // commandRunner.ts does, prints the two pids, and then just exists.
    const host = path.join(dir, "host.js");
    await fs.writeFile(
      host,
      ['const { execFile } = require("node:child_process");', 'const child = execFile(process.argv[2], ["freeze-candidate", "stage-4"], () => {});', "console.log(JSON.stringify({ host: process.pid, child: child.pid }));", "setInterval(() => {}, 1000);", ""].join("\n"),
    );

    const pids = await new Promise<{ host: number; child: number }>((resolve, reject) => {
      const spawned = execFile(process.execPath, [host, engine], { cwd: dir }, () => undefined);
      spawned.stdout?.once("data", (chunk: Buffer) => {
        try {
          resolve(JSON.parse(chunk.toString()) as { host: number; child: number });
        } catch (error) {
          reject(error as Error);
        }
      });
      spawned.once("error", reject);
    });

    try {
      await until(async () => ((await fs.readFile(log, "utf8").catch(() => "")).includes("freeze-candidate") ? true : undefined), "the engine stand-in to record its call");
      const before = await processes();
      const child = alive(pids.child, before);
      assert.ok(child, `the child is running before the kill, got ${JSON.stringify(pids)}`);
      assert.equal(child.ppid, pids.host, "and is a child of the host stand-in");

      // The reload: the extension host dies, as hard as it can.
      process.kill(pids.host, "SIGKILL");
      await until(async () => (alive(pids.host, await processes()) === undefined ? true : undefined), "the host stand-in to be gone");
      await wait(500);

      const after = await processes();
      const orphan = alive(pids.child, after);
      assert.ok(orphan, "the engine process is still running with its parent dead — a reload does not end it");
      assert.equal(orphan.ppid, 1, "it has been reparented to pid 1");
      assert.ok(orphan.command.includes(engine), `its own executable is still in its command line, got ${JSON.stringify(orphan.command)}`);
      assert.ok(orphan.command.includes("freeze-candidate") && orphan.command.includes("stage-4"), "and so is the operation it is doing, which is what makes it recognisable after a reload");
      assert.deepEqual((await fs.readFile(log, "utf8")).trim().split("\n"), ["freeze-candidate stage-4"], "it ran the operation once, and that operation is not finished");
    } finally {
      try {
        process.kill(pids.child, "SIGKILL");
      } catch {
        // already gone
      }
      try {
        process.kill(pids.host, "SIGKILL");
      } catch {
        // already gone
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

async function until<T>(condition: () => Promise<T | undefined>, what: string, budgetMs = 10_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await condition();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await wait(25);
  }
}
