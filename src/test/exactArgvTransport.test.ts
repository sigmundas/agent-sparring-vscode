/**
 * The second transport failure, and the policy that ends the class.
 *
 * After free-text `--evidence` was encoded as one ANSI-C quoted command line,
 * Submit for review still did not start. The terminal no longer showed the
 * `quote>` continuation prompt — the encoder was correct — but the physical
 * command became corrupted part-way through the evidence, with a fragment of
 * the command's own head appearing inside the payload, and no engine process
 * ever appeared.
 *
 * The encoder was never the defect. A real interactive zsh on a pty stops
 * accepting input at roughly 1968 bytes of one logical line; past that the
 * line is truncated in transit whatever it contains. Measured directly:
 *
 *     payload=1500  wireBytes=1506  acceptedByPty=1506  OK
 *     payload=2000  wireBytes=2006  acceptedByPty=1968  stalled
 *     payload=8000  wireBytes=8006  acceptedByPty=1968  stalled
 *
 * The four-check payload that the existing integration test sends produces a
 * 1124-byte command line, which is why it passed every time while the live
 * submission — a longer one — failed. No quoting survives that limit, because
 * the limit is on the line and not on its syntax.
 *
 * So free text is not made into a command line at all. It reaches the engine
 * as an exact argument array with no shell anywhere in between, and these
 * tests assert that end to end rather than asserting that some encoder returns
 * an expected string.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  buildAcceptCandidateArgs,
  buildFreezeCandidateArgs,
  buildNewStageArgs,
  buildResumePlanArgs,
  buildRunLoopArgs,
  buildRunPlanArgs,
  buildRunSparringArgs,
  carriesFreeText,
  FREE_TEXT_FLAGS,
  planShellHandover,
  transportSafety,
} from "../core/cli";
import { hostileEvidence } from "./fixtures/hostileEvidence";
import { install, reset, type VscodeStub } from "./vscodeStub";

const run = promisify(execFile);
const stub: VscodeStub = install();

let Registry: typeof import("../vscode/operationRegistry").OperationRegistry;
let Tracker: typeof import("../vscode/executionTracker").ExecutionTracker;
before(async () => {
  Registry = (await import("../vscode/operationRegistry")).OperationRegistry;
  Tracker = (await import("../vscode/executionTracker")).ExecutionTracker;
});

/** An executable that writes the argv it was given, as JSON, and nothing else. */
async function argvReporter(): Promise<{ dir: string; file: string; argvFile: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sparring-exact-argv-"));
  const argvFile = path.join(dir, "argv.json");
  const file = path.join(dir, "sparring");
  await fs.writeFile(file, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  return { dir, file, argvFile };
}

/** The evidence submission exactly as the panel builds it. */
function submission(dir: string, evidence: string): string[] {
  return buildResumePlanArgs({ source: "markdown", planPath: path.join(dir, "docs/plans/active/reported.md"), repoRoot: dir, expectedBranch: "feature/reported-statistics", evidence });
}

function context(): { workspaceState: unknown } {
  const values = new Map<string, unknown>();
  return { workspaceState: { get: <T>(key: string, fallback?: T): T => (values.get(key) ?? fallback) as T, update: async (key: string, value: unknown) => void values.set(key, value), keys: () => [...values.keys()] } };
}

describe("which commands a shell is allowed to see", () => {
  it("every free-text channel is no-shell, whatever the text happens to contain", () => {
    for (const evidence of [hostileEvidence(), "All four checks passed", "ok", ""]) {
      const args = submission("/repo", evidence);
      if (!evidence) {
        assert.equal(carriesFreeText(args), false, "an empty entry is not sent at all, so there is nothing to classify");
        continue;
      }
      assert.equal(carriesFreeText(args), true, JSON.stringify(evidence.slice(0, 20)));
      assert.equal(transportSafety("/venv/bin/sparring", args), "no-shell", "including text that happens to look like an identifier");
      assert.deepEqual(planShellHandover("/venv/bin/sparring", args), { via: "no-shell" });
    }
  });

  it("deferred results are the other free-text channel and are covered by the same rule", () => {
    const args = buildResumePlanArgs({
      source: "markdown",
      planPath: "/repo/docs/plans/active/reported.md",
      repoRoot: "/repo",
      expectedBranch: "feature/x",
      deferredResults: [{ gateInstanceId: "human-gate-2026-09-20T09-31-44-a41f9c", checkId: "norwegian-locale-sort-order", outcome: "pass", note: "Sorterer æ, ø og å sist" }],
    });
    assert.equal(transportSafety("sparring", args), "no-shell");
    // A result with no note at all is still a free-text channel: it is
    // classified by which flag carries it, not by what today's value holds.
    const bare = buildResumePlanArgs({ source: "markdown", planPath: "/repo/p.md", repoRoot: "/repo", expectedBranch: "feature/x", deferredResults: [{ gateInstanceId: "g", checkId: "c", outcome: "pass" }] });
    assert.equal(transportSafety("sparring", bare), "no-shell");
    assert.deepEqual([...FREE_TEXT_FLAGS].sort(), ["--deferred-result", "--evidence"], "the whole list, in one place");
  });

  it("leaves every flag-and-path invocation on the shell exactly as it was", () => {
    const loop = { stageId: "stage-reported-statistics-typed-parser", repoRoot: "/Users/me/Code/my repo", expectedBranch: "feature/reported-statistics" };
    for (const args of [
      buildRunPlanArgs({ planPath: "/Users/me/Code/my repo/docs/plans/active/reported.md", repoRoot: loop.repoRoot, expectedBranch: loop.expectedBranch, adopt: true }),
      buildResumePlanArgs({ source: "manifest", manifest: "/Users/me/Library/Application Support/Code/User/globalStorage/m.json", repoRoot: loop.repoRoot, expectedBranch: loop.expectedBranch }),
      buildRunLoopArgs(loop),
      buildRunSparringArgs(loop),
      buildFreezeCandidateArgs(loop),
      buildAcceptCandidateArgs(loop),
      buildNewStageArgs({ stageId: loop.stageId, repoRoot: loop.repoRoot, briefFile: "/tmp/brief.md" }),
    ]) {
      assert.equal(transportSafety("/Users/me/venv/bin/sparring", args), "shell", `unchanged: ${args[0]}`);
      assert.deepEqual(planShellHandover("/Users/me/venv/bin/sparring", args), { via: "arguments" });
    }
  });

  it("an executable path a shell would read as syntax takes the engine off the shell too", () => {
    const plain = buildRunLoopArgs({ stageId: "stage-a", repoRoot: "/r", expectedBranch: "feature/x" });
    assert.equal(transportSafety("/Users/o'brien/venv/bin/sparring", plain), "no-shell");
  });
});

describe("the evidence reaches the engine as exact argv", () => {
  it("argv[n] is the evidence byte for byte, through the transport the launcher actually chose", async () => {
    reset();
    const { dir, file, argvFile } = await argvReporter();
    try {
      const evidence = hostileEvidence();
      assert.ok(evidence.length > 4000, `the payload must exceed the live submission and every terminal input buffer, got ${evidence.length}`);
      const args = submission(dir, evidence);
      const at = args.indexOf("--evidence") + 1;
      assert.equal(args[at], evidence, "the argument array itself is the evidence, unmodified");

      const registry = new Registry(context() as never, () => {}, () => true, async () => []);
      const leased: unknown[] = [];
      const pool = { acquire: () => { const lease = { terminal: {}, idle: () => true, release: () => {}, discard: () => {}, retire: () => {} }; leased.push(lease); return lease; } };
      const tracker = new Tracker(context() as never, () => {}, () => [], pool as never, registry, () => false, async () => []);
      try {
        const result = await tracker.launch({ configured: file, args, cwd: dir, name: "resume-plan", runId: "run-evidence", kind: "resume-plan", planPath: path.join(dir, "docs/plans/active/reported.md"), reveal: false });
        assert.equal(result.ok, true, "the submission starts");
        assert.equal(result.via, "terminal", "and it starts as a process of its own, not as a line in somebody's shell");

        // What the launcher asked the pty host to spawn. This is the whole
        // claim: an executable and an argument array, with no shell named
        // anywhere and no command line built for anything to re-read.
        assert.equal(stub.window.created.length, 1, "exactly one process is launched");
        const created = stub.window.created[0];
        assert.equal(created.shellPath, file, "the engine itself is the terminal's process");
        assert.deepEqual(created.shellArgs, args, "and the argument array is passed through untouched");
        assert.equal(leased.length, 0, "and no terminal was leased from the pool: a command no shell may be shown never asks for one, nor waits for shell integration on it");

        // Now spawn exactly that, the way the pty host does: execvp with this
        // argv and no shell. The engine's own view of argv is what is asserted.
        await run(created.shellPath!, created.shellArgs!, { cwd: dir });
        const recorded = JSON.parse(await fs.readFile(argvFile, "utf8")) as string[];
        assert.deepEqual(recorded, args, "every argument arrives exactly as built");
        assert.equal(recorded[at], evidence, "and the evidence is one argument, byte for byte");
        assert.equal(Buffer.from(recorded[at]).equals(Buffer.from(evidence)), true, "byte for byte, not merely equal after normalisation");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("a second submission for the same run is refused while the first is under way", async () => {
    reset();
    const { dir, file } = await argvReporter();
    try {
      const args = submission(dir, hostileEvidence());
      const registry = new Registry(context() as never, () => {}, () => true, async () => []);
      const pool = { acquire: () => ({ terminal: {}, idle: () => true, release: () => {}, discard: () => {}, retire: () => {} }) };
      const tracker = new Tracker(context() as never, () => {}, () => [], pool as never, registry, () => false, async () => []);
      const options = { configured: file, args, cwd: dir, name: "resume-plan", runId: "run-duplicate", kind: "resume-plan" as const, planPath: path.join(dir, "p.md"), reveal: false };
      try {
        assert.equal((await tracker.launch(options)).ok, true);
        const guard = registry.inFlightFor("run:run-duplicate");
        assert.equal(guard?.state, "running-dedicated", "the guard knows the exact transport, so a reload still recognises it");
        assert.equal(guard?.transport, "dedicated-terminal");

        const second = await tracker.launch(options);
        assert.equal(second.ok, false, "a second submission for the same run is not launched");
        assert.equal(stub.window.created.length, 1, "and no second process exists");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("nothing is launched, and no guard is left behind, when the executable cannot be resolved", async () => {
    reset();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sparring-exact-argv-miss-"));
    try {
      const registry = new Registry(context() as never, () => {}, () => true, async () => []);
      const pool = { acquire: () => ({ terminal: {}, idle: () => true, release: () => {}, discard: () => {}, retire: () => {} }) };
      const tracker = new Tracker(context() as never, () => {}, () => [], pool as never, registry, () => false, async () => []);
      try {
        const result = await tracker.launch({ configured: path.join(dir, "not-here"), args: submission(dir, hostileEvidence()), cwd: dir, name: "resume-plan", runId: "run-missing", kind: "resume-plan", planPath: path.join(dir, "p.md"), reveal: false });
        assert.equal(result.ok, false);
        assert.equal(stub.window.created.length, 0, "no process was created");
        // The drafts are only ever cleared by a submission that the engine
        // ended successfully; a launch that never reached a process must
        // leave the run unguarded so the person can simply press again.
        assert.equal(registry.inFlightFor("run:run-missing"), undefined, "and the run is free to be submitted again");
      } finally {
        tracker.dispose();
        registry.dispose();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("no shell is anywhere in the free-text path", () => {
  const read = async (file: string) => fs.readFile(path.join(__dirname, "..", "..", "src", file), "utf8");

  it("neither launcher ever asks a shell to interpret a constructed command", async () => {
    for (const file of ["vscode/executionTracker.ts", "vscode/commandRunner.ts", "vscode/shellIntegration.ts", "vscode/shellHandover.ts"]) {
      const source = await read(file);
      const code = source.split("\n").filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("/*"));
      assert.ok(!code.some((line) => /["'`]-c["'`]/.test(line)), `${file} never runs the engine as \`shell -c …\`, which would only move the quoting problem`);
      assert.ok(!code.some((line) => /commandLine\s*\)/.test(line) && /executeCommand\(/.test(line)), `${file} never hands a shell a command line it built itself`);
    }
  });

  it("the shell hand-over passes an argument array and nothing else", async () => {
    const shared = await read("vscode/shellIntegration.ts");
    assert.match(shared, /integration\.executeCommand\(word, args\)/, "only the (word, args) form, which is VS Code's own escaping");
    assert.equal((shared.match(/integration\.executeCommand\(/g) ?? []).length, 1, "and there is exactly one call of it");
    assert.match(shared, /planShellHandover\(word, args\)/, "the decision comes from the one rule in core, not a second copy of it");
  });

  it("the evidence is never written into the log", async () => {
    // What is logged is how many arguments there were, never what was in them.
    const tracker = await read("vscode/executionTracker.ts");
    const logs = [...tracker.matchAll(/this\.log\(\s*`([^`]*)`/g)].map((match) => match[1]);
    for (const line of logs) {
      assert.ok(!/\$\{options\.args\}|\$\{args\}|args\.join/.test(line), `a log line must not spell out the arguments: ${line}`);
    }
    assert.ok(logs.some((line) => line.includes("${options.args.length} args")), "the count is what is logged instead");
  });
});
