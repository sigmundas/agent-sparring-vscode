/**
 * The reported defect, at the decision it turns on.
 *
 * What happened: Agent Sparring had created and reused its project terminal;
 * after the engine command finished, an interactive Claude CLI was started in
 * that same terminal and left running; Run plan then handed the terminal a
 * `sparring run-plan …` line, which appeared in the Claude prompt instead of
 * being executed — and the extension recorded a runner as alive.
 *
 * The lease was the only thing consulted, and the lease only ever described
 * Agent Sparring's own commands. These tests pin the rule that replaced it:
 * a terminal is available when *its shell* is idle, whoever last used it,
 * and when this window is in a position to know that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseOwnedTerminal, explainCreation, unavailability, type OwnedTerminalState } from "../core/terminalOccupancy";

const PROJECT = "/Users/someone/Code/sporely-py";
const OTHER = "/Users/someone/Code/sporely-web";

/** A terminal this extension opened, used, and got back: the reuse case. */
const idle = (over: Partial<OwnedTerminalState> = {}): OwnedTerminalState => ({
  cwd: PROJECT,
  exited: false,
  leased: false,
  activeExecutions: 0,
  observable: true,
  ...over,
});

describe("whether an owned terminal may be sent a command", () => {
  it("an idle, watched terminal of this project is reused: one terminal per project, as before", () => {
    assert.equal(unavailability(idle()), undefined);
    assert.deepEqual(chooseOwnedTerminal([idle()], PROJECT), { kind: "reuse", index: 0 });
  });

  it("a shell running something started outside Agent Sparring is occupied, and gets a second terminal", () => {
    // The reproduction: the lease is free, because Agent Sparring's own
    // command finished. The shell is not.
    const occupied = idle({ activeExecutions: 1 });
    assert.equal(occupied.leased, false, "the lease says nothing about this");
    assert.equal(unavailability(occupied), "occupied");
    assert.deepEqual(chooseOwnedTerminal([occupied], PROJECT), { kind: "create", because: "occupied" });
  });

  it("an Agent Sparring command in flight still gets a second terminal, as it always did", () => {
    assert.equal(unavailability(idle({ leased: true })), "leased");
    assert.deepEqual(chooseOwnedTerminal([idle({ leased: true })], PROJECT), { kind: "create", because: "leased" });
  });

  it("a terminal whose executions this window never watched is left alone: no history is not idleness", () => {
    // What a window reload leaves behind, and what a shell without shell
    // integration is: nothing here can tell whether anything is running in
    // it, so it is never written to.
    const unwatched = idle({ observable: false });
    assert.equal(unwatched.activeExecutions, 0, "the pool knows of no execution in it");
    assert.equal(unavailability(unwatched), "unobservable", "which is not the same as the shell being idle");
    assert.deepEqual(chooseOwnedTerminal([unwatched], PROJECT), { kind: "create", because: "unobservable" });
  });

  it("a terminal whose shell has exited is never reused, whatever else is recorded about it", () => {
    assert.equal(unavailability(idle({ exited: true })), "exited");
    assert.equal(unavailability(idle({ exited: true, activeExecutions: 1 })), "exited");
    assert.deepEqual(chooseOwnedTerminal([idle({ exited: true })], PROJECT), { kind: "create", because: "exited" });
  });

  it("another project's idle terminal is never taken: projects never share a cwd", () => {
    assert.deepEqual(chooseOwnedTerminal([idle({ cwd: OTHER })], PROJECT), { kind: "create", because: undefined });
  });

  it("with one occupied and one idle terminal for the project, the idle one is reused", () => {
    const states = [idle({ activeExecutions: 1 }), idle()];
    assert.deepEqual(chooseOwnedTerminal(states, PROJECT), { kind: "reuse", index: 1 });
  });

  it("when several are unusable the log is told about the occupied one, not the exited one", () => {
    const states = [idle({ exited: true }), idle({ activeExecutions: 1 })];
    assert.deepEqual(chooseOwnedTerminal(states, PROJECT), { kind: "create", because: "occupied" });
  });

  it("the log says a command was kept out of the occupied terminal, not merely that one was opened", () => {
    const message = explainCreation("occupied", "Agent Sparring — sporely-py (2)", PROJECT);
    assert.match(message, /running another command/);
    assert.match(message, /nothing was written into it/);
    assert.match(explainCreation("unobservable", "Agent Sparring — sporely-py (2)", PROJECT), /cannot be established/);
    assert.match(explainCreation(undefined, "Agent Sparring — sporely-py", PROJECT), /opened the terminal/);
  });
});
