/**
 * Why free text is never handed to a shell: the measurement itself.
 *
 * This is the root cause of the second Submit-for-review failure, and the
 * reason no encoder could have fixed it. An interactive shell on a pty accepts
 * a single logical command line only up to a bounded number of bytes — on the
 * machine where the incident happened, about 1968 — and simply stops taking
 * the rest. What the shell then holds is a truncated line, which is why the
 * terminal showed a command corrupted part-way through the evidence with a
 * fragment of the command's own head inside it, and why no engine process ever
 * appeared.
 *
 * The limit is on the physical line. It does not care whether the line was
 * quoted with `'…'`, with ANSI-C `$'…'`, or not at all, so it cannot be
 * escaped around — only avoided, by not building a command line for human text
 * in the first place (core/cli.ts, `transportSafety`).
 *
 * The exact threshold is a property of the operating system and is not
 * asserted. What is asserted is the property the architecture rests on: the
 * ceiling exists, it is far below the size of a real evidence submission, and
 * a payload that clears it arrives intact while one that does not is lost.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";
import { hostileEvidence } from "./fixtures/hostileEvidence";

const run = promisify(execFile);

interface ShellResult {
  output: string;
  returnedToPrompt: boolean;
  sent: number;
  accepted: number;
}

/** Offer one command line to a throwaway interactive zsh and report what it took. */
async function offer(line: string, cwd: string): Promise<ShellResult> {
  const requestFile = path.join(cwd, `request-${line.length}.json`);
  await fs.writeFile(requestFile, JSON.stringify({ shell: "/bin/zsh", cwd, line }));
  const { stdout } = await run("python3", [path.join(__dirname, "../../src/test/fixtures/interactiveShell.py"), requestFile], { timeout: 60_000 });
  return JSON.parse(stdout) as ShellResult;
}

it("an interactive shell stops accepting a long command line, however it is quoted", { skip: process.platform === "win32" }, async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "sparring-input-limit-"));
  try {
    // Nothing here is quoted at all: only `true` and a run of harmless
    // characters, so the one variable is length.
    const short = await offer(`true ${"x".repeat(600)}`, cwd);
    assert.equal(short.accepted, short.sent, "a short command line is taken in full");
    assert.equal(short.returnedToPrompt, true, "and the shell runs it and comes back");

    const long = await offer(`true ${"x".repeat(16_000)}`, cwd);
    assert.ok(long.accepted < long.sent, `a long command line is not taken in full, got ${long.accepted} of ${long.sent}`);
    assert.ok(
      long.accepted < 8000,
      `the ceiling is far below a real evidence submission, got ${long.accepted} bytes — if this has genuinely changed, the reasoning in core/cli.ts transportSafety needs revisiting, not this assertion relaxing`,
    );

    // And the payload that matters is well past it, so there was never a
    // version of the shell transport that could have carried it.
    const evidence = hostileEvidence();
    assert.ok(
      Buffer.byteLength(evidence) > long.accepted,
      `the evidence a person submits (${Buffer.byteLength(evidence)} bytes) exceeds what any shell command line can carry (${long.accepted})`,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
