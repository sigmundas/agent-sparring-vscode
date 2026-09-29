/**
 * One reusable runner terminal per repository, and cleanup of the ones known
 * to have ended. The decisions are pure (core/terminalOccupancy.ts); the pool
 * in src/vscode/terminalPool.ts applies them, and the integration suite drives
 * it against real terminals.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { chooseOwnedTerminal, knownEnded, redundantTerminals, terminalKey, type OwnedTerminalState } from "../core/terminalOccupancy";

const PY = "/Users/someone/Code/sporely-py";
const WEB = "/Users/someone/Code/sporely-web";

const idle = (over: Partial<OwnedTerminalState> = {}): OwnedTerminalState => ({ cwd: PY, exited: false, leased: false, activeExecutions: 0, observable: true, ...over });

describe("runner terminal reuse", () => {
  it("sequential commands in one repository reuse its idle terminal", () => {
    assert.deepEqual(chooseOwnedTerminal([idle()], PY), { kind: "reuse", index: 0 });
    assert.deepEqual(chooseOwnedTerminal([idle({ lastExitCode: 0 })], PY), { kind: "reuse", index: 0 }, "a definitely-ended command leaves it reusable");
  });

  it("a busy terminal is never chosen for a second command", () => {
    assert.equal(chooseOwnedTerminal([idle({ leased: true })], PY).kind, "create");
    assert.equal(chooseOwnedTerminal([idle({ activeExecutions: 1 })], PY).kind, "create");
    assert.equal(chooseOwnedTerminal([idle({ dedicated: true })], PY).kind, "create", "a terminal whose process is an engine command is never written to");
  });

  it("different repositories get separate terminals", () => {
    assert.deepEqual(chooseOwnedTerminal([idle({ cwd: WEB })], PY), { kind: "create", because: undefined });
    assert.deepEqual(chooseOwnedTerminal([idle({ cwd: WEB }), idle()], PY), { kind: "reuse", index: 1 });
  });

  it("unknown liveness — a terminal not watched since creation, as after a reload — is not reused", () => {
    assert.deepEqual(chooseOwnedTerminal([idle({ observable: false })], PY), { kind: "create", because: "unobservable" });
  });

  it("repository identity is the canonical real path, not the display name", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "runner-key-"));
    const repo = path.join(root, "sporely-py");
    const other = path.join(root, "other", "sporely-py");
    await fsp.mkdir(repo);
    await fsp.mkdir(other, { recursive: true });
    const link = path.join(root, "link");
    fs.symlinkSync(repo, link);
    assert.equal(terminalKey(link), terminalKey(repo), "a symlinked spelling is the same repository");
    assert.equal(terminalKey(repo + path.sep), terminalKey(repo));
    assert.notEqual(terminalKey(other), terminalKey(repo), "same folder name, different worktree: separate terminals");
    await fsp.rm(root, { recursive: true, force: true });
  });
});

describe("runner terminal cleanup", () => {
  it("only terminals known to be running nothing may be closed", () => {
    assert.equal(knownEnded(idle()), true);
    assert.equal(knownEnded(idle({ exited: true })), true);
    assert.equal(knownEnded(idle({ dedicated: true, exited: true })), true);
    assert.equal(knownEnded(idle({ leased: true })), false, "running");
    assert.equal(knownEnded(idle({ activeExecutions: 1 })), false, "someone's interactive command");
    assert.equal(knownEnded(idle({ dedicated: true })), false, "engine process still running");
    assert.equal(knownEnded(idle({ observable: false })), false, "unknown liveness");
  });

  it("closes this repository's other cleanly-ended terminals once one is kept, and nothing else", () => {
    const states = [
      idle(), // 0 kept
      idle({ lastExitCode: 0 }), // 1 redundant, clean
      idle({ lastExitCode: 2 }), // 2 failed: output kept for on-demand inspection
      idle({ leased: true }), // 3 running
      idle({ observable: false }), // 4 unknown
      idle({ cwd: WEB }), // 5 other repository
      idle({ dedicated: true, exited: true }), // 6 ended engine process
      idle({ dedicated: true }), // 7 running engine process
    ];
    assert.deepEqual(redundantTerminals(states, PY, 0), [1, 6]);
  });
});

describe("routine launches do not bring the Terminal panel forward", () => {
  it("no engine launch in the commands asks for its terminal to be revealed", async () => {
    const source = await fsp.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    assert.equal(/reveal:\s*true/.test(source), false, "the Overview shows progress; the raw terminal stays available on demand");
  });
});
