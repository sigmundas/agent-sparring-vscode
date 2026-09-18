/**
 * The reported failure: in a managed plan run, Submit result and continue
 * built a correct `resume-plan --evidence …` argument array, handed it to
 * shell integration, and the user was told
 *
 *   Your shell could not find '/…/.venv/bin/sparring'.
 *
 * about an executable that exists, is executable, and had in fact just run.
 *
 * Two separate defects, both exercised here on the real path rather than
 * described:
 *
 *  1. VS Code's `executeCommand(executable, args)` does not escape an
 *     argument that contains a quote or a backtick — it appends it to the
 *     command line raw. A `## Human evidence` entry contains backticks (the
 *     gate check's id), apostrophes (the human's note) and newlines, so the
 *     shell read it as syntax: the backticks became command substitution and
 *     each further line became another command. The last of those was not a
 *     command, so the execution ended 127.
 *  2. 127 was then translated into "your shell could not find <executable>",
 *     although the extension had itself checked that file and the shell had
 *     already run it.
 *
 * The first test below is the control: it replicates VS Code's escaping and
 * shows what the shell then receives. The rest run real shells.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { explainAcceptanceFailure } from "../core/acceptance";
import {
  buildAcceptCandidateArgs,
  buildFreezeCandidateArgs,
  buildNewStageArgs,
  buildResumePlanArgs,
  buildRunLoopArgs,
  buildRunPlanArgs,
  buildRunSparringArgs,
  needsOwnQuoting,
  planShellHandover,
  posixQuote,
  shellCommandLine,
  shellFamily,
  vscodeQuotingIsFaithful,
  wasCommandNotFound,
} from "../core/cli";
import { renderHumanEvidence } from "../core/humanChecks";

const run = promisify(execFile);

/**
 * VS Code's escaping, copied from ExtHostTerminalShellIntegration in the
 * shipped product (Code 1.10x, out/vs/workbench/api/node/extensionHostProcess.js):
 *
 *   executeCommand(s, a) {
 *     let l = s;
 *     if (a) for (let u of a) !u.match(/["'`]/) && u.match(/\s/) ? l += ` "${u}"` : l += ` ${u}`;
 *     …
 *
 * Kept here so the assumption this fix rests on is visible and testable.
 */
function asVsCodeWouldSend(executable: string, args: readonly string[]): string {
  let line = executable;
  for (const arg of args) {
    line += !arg.match(/["'`]/) && arg.match(/\s/) ? ` "${arg}"` : ` ${arg}`;
  }
  return line;
}

/** The evidence a structured gate check produces, as the failing screen produced it. */
function realEvidence(): string {
  return renderHumanEvidence(
    [
      {
        text: "Open the desktop feed before activation and confirm the pre-activation placeholder is shown.",
        origin: "gate",
        id: "pre-activation-desktop-v2-feed",
        record: { outcome: "pass", note: "Checked on the reviewer's build; the placeholder doesn't flash." },
      },
    ],
    new Date("2026-09-14T10:00:00Z"),
    "Reported statistics",
  ) as string;
}

/** A script that reports the arguments it was given, one per line, unambiguously. */
async function argvReporter(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-argv-"));
  const file = path.join(dir, "sparring");
  await fs.writeFile(file, ['#!/bin/sh', 'for a in "$@"; do printf "<%s>\\n" "$a"; done', ""].join("\n"), { mode: 0o755 });
  return { dir, file };
}

/** What a shell actually passed to the process, and how the shell's own line ended. */
async function throughShell(shell: string, line: string, cwd: string): Promise<{ argv: string[]; exitCode: number }> {
  const result = await run(shell, ["-c", line], { cwd }).then(
    ({ stdout }) => ({ stdout, exitCode: 0 }),
    (error: { stdout?: string; code?: number }) => ({ stdout: error.stdout ?? "", exitCode: error.code ?? -1 }),
  );
  return { argv: [...result.stdout.matchAll(/<([^]*?)>\n/g)].map((match) => match[1]), exitCode: result.exitCode };
}

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"];

describe("handing a free-text argument to a shell", () => {
  it("VS Code's own escaping turns a gate check's evidence into shell syntax — the reported failure", async () => {
    const { dir, file } = await argvReporter();
    const args = buildResumePlanArgs({ source: "manifest", manifest: path.join(dir, "m.json"), repoRoot: dir, expectedBranch: "feature/x", evidence: realEvidence() });
    assert.deepEqual(args.slice(-2, -1), ["--evidence"], "the argument array itself is correct: this was never an argument-building bug");

    const line = asVsCodeWouldSend(file, args);
    assert.ok(!line.includes(`"${args[args.length - 1]}"`), "the evidence is appended raw: it holds a backtick, so VS Code does not quote it");
    const seen = await throughShell("/bin/sh", line, dir);
    assert.notDeepEqual(seen.argv, args, "the shell does not give the engine back the arguments it was meant to have");
    assert.ok(!seen.argv.includes(args[args.length - 1]), "the evidence never reaches the engine as one argument");
    assert.ok(seen.argv.includes("manual"), "it arrives split on every space instead");
    // And the exit code the user saw: the leftover lines are run as commands,
    // the last of which is not one. That 127 was reported as a missing CLI.
    assert.equal(seen.exitCode, 127, "the execution ends 127 although the executable itself ran");
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const shell of SHELLS) {
    it(`a command line built here survives ${shell} exactly`, async () => {
      const { dir, file } = await argvReporter();
      const args = buildResumePlanArgs({ source: "manifest", manifest: path.join(dir, "m.json"), repoRoot: dir, expectedBranch: "feature/x", evidence: realEvidence() });
      const line = shellCommandLine(file, args, "posix");
      assert.ok(line, "a POSIX shell is one this extension can quote for");
      const seen = await throughShell(shell, line, dir);
      assert.deepEqual(seen.argv, args, "every argument reaches the process byte for byte");
      assert.equal(seen.exitCode, 0, "and the shell has nothing left over to run");
      await fs.rm(dir, { recursive: true, force: true });
    });
  }

  it("survives everything a person can type, not only the evidence that failed", async () => {
    const { dir, file } = await argvReporter();
    const nasty = [
      "it's `date` $HOME \\ \"quoted\" & ; | > < (sub) {brace} [glob] * ? ~ #hash !bang",
      "line one\nline two\n\n- PASS — em dash · middot",
      "  leading and trailing  ",
      "",
      "\t\ttabs\t",
      "$(rm -rf /) — must arrive as text",
    ];
    const line = shellCommandLine(file, nasty, "posix");
    assert.ok(line);
    for (const shell of SHELLS) {
      assert.deepEqual((await throughShell(shell, line, dir)).argv, nasty, `${shell} passes it through unchanged`);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("leaves every existing invocation exactly as it was: VS Code's escaping is only bypassed when it would lie", () => {
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
      assert.equal(needsOwnQuoting(args), false, `unchanged: ${args[0]}`);
    }
    assert.equal(needsOwnQuoting(buildResumePlanArgs({ source: "markdown", planPath: "p.md", repoRoot: "/r", expectedBranch: "b", evidence: realEvidence() })), true, "only the free-text one is taken over");
  });

  it("knows exactly which arguments VS Code's escaping can carry", () => {
    for (const safe of ["resume-plan", "--evidence", "/Users/me/Code/repo/.sparring", "feature/x", "stage-a_b.c", "/with space/plan.md", "æøå-ünïcode"]) {
      assert.equal(vscodeQuotingIsFaithful(safe), true, safe);
    }
    for (const unsafe of ["", "it's", "`id`", 'say "hi"', "a\nb", "$HOME", "with space and $var", "a;b", "a&b", "a|b", "a*b", "~/x", "a!b", "with space and !bang"]) {
      assert.equal(vscodeQuotingIsFaithful(unsafe), false, JSON.stringify(unsafe));
    }
  });

  it("the launcher's decision, for the exact invocation that failed", async () => {
    const { dir, file } = await argvReporter();
    const args = buildResumePlanArgs({ source: "manifest", manifest: path.join(dir, "m.json"), repoRoot: dir, expectedBranch: "feature/x", evidence: realEvidence() });
    const handover = planShellHandover(file, args, "posix");
    assert.equal(handover.via, "command-line", "the evidence launch is quoted here, not by VS Code");
    assert.deepEqual((await throughShell("/bin/zsh", (handover as { commandLine: string }).commandLine, dir)).argv, args);

    const plain = buildRunLoopArgs({ stageId: "stage-a", repoRoot: dir, expectedBranch: "feature/x" });
    assert.deepEqual(planShellHandover(file, plain, "posix"), { via: "arguments" }, "everything else keeps VS Code's own escaping");
    assert.deepEqual(planShellHandover(file, args, "cmd"), { via: "no-shell" }, "a shell whose quoting is not written here is bypassed entirely");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("quotes for the POSIX shells and refuses to guess for the rest", () => {
    assert.equal(posixQuote("it's"), "'it'\\''s'");
    assert.equal(shellFamily("/bin/zsh", "darwin"), "posix");
    assert.equal(shellFamily("/usr/local/bin/fish", "linux"), "posix");
    assert.equal(shellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32"), "cmd");
    assert.equal(shellFamily("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
    assert.equal(shellFamily("C:\\Program Files\\Git\\bin\\bash.exe", "win32"), "posix", "Git Bash on Windows is still a POSIX shell");
    assert.equal(shellFamily(undefined, "darwin"), "posix");
    assert.equal(
      shellCommandLine("sparring", ["resume-plan", "--evidence", "it's"], "cmd"),
      undefined,
      "no command line is invented for a shell whose quoting is not written here; the caller runs the process without a shell instead",
    );
  });
});

describe("what a bad exit code is allowed to mean", () => {
  it("never blames the shell for an executable this extension resolved and checked", () => {
    const configured = { kind: "configured", path: "/Users/me/sporely-py/.venv/bin/sparring" } as const;
    assert.equal(wasCommandNotFound(127, "darwin", configured), false, "the reported failure: the file exists, was checked, and ran");
    assert.equal(wasCommandNotFound(127, "darwin", { kind: "resolved", path: "/usr/local/bin/sparring" }), false);
    assert.equal(wasCommandNotFound(9009, "win32", configured), false);
    assert.equal(wasCommandNotFound(127, "darwin", undefined), false, "an observed or reattached run says nothing about resolution");
  });

  it("still says so when the shell really did have to find a bare word", () => {
    const shell = { kind: "shell", command: "sparring" } as const;
    assert.equal(wasCommandNotFound(127, "darwin", shell), true);
    assert.equal(wasCommandNotFound(9009, "win32", shell), true);
    assert.equal(wasCommandNotFound(1, "darwin", shell), false);
    assert.equal(wasCommandNotFound(undefined, "darwin", shell), false);
  });

  it("a short command that exits 127 from a checked path reports what it printed, not a settings problem", () => {
    const output = "Traceback (most recent call last):\ncould not freeze candidate: no candidate to freeze\n";
    const fromPath = explainAcceptanceFailure("freeze", { exitCode: 127, output, resolvedBy: "path" }, "darwin");
    assert.equal(fromPath.commandNotFound, undefined);
    assert.match(fromPath.message, /no candidate to freeze/);
    const fromShell = explainAcceptanceFailure("freeze", { exitCode: 127, output: "", resolvedBy: "shell" }, "darwin");
    assert.equal(fromShell.commandNotFound, true);
  });
});

describe("one launcher for every engine action", () => {
  const read = async (file: string) => fs.readFile(path.join(__dirname, "..", "..", "src", file), "utf8");

  it("only the launcher and the short-command runner start anything", async () => {
    const starters = /integration\.executeCommand\(|executeCommand\(word|createTerminal\(|execFile\(|spawn\(/;
    // engineProbe.ts is deliberately not here: `run-plan --help` asks the
    // installed CLI what it supports and runs no engine action.
    for (const file of ["vscode/commands.ts", "vscode/controller.ts", "vscode/overview/overviewPanel.ts", "vscode/git.ts"]) {
      const source = await read(file);
      const offenders = source
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => starters.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
      assert.deepEqual(offenders, [], `${file} must reach the engine through controller.launch / controller.runCommand only`);
    }
  });

  it("and only the terminal pool opens terminals", async () => {
    for (const file of ["vscode/commands.ts", "vscode/controller.ts", "vscode/commandRunner.ts", "vscode/overview/overviewPanel.ts", "vscode/git.ts"]) {
      assert.ok(!/createTerminal\(/.test(await read(file)), `${file} does not open its own terminal`);
    }
    // The launcher opens exactly one kind of terminal itself: the dedicated
    // one whose process *is* the engine, used when no shell can be watched.
    const tracker = await read("vscode/executionTracker.ts");
    assert.equal((tracker.match(/vscode\.window\.createTerminal\(/g) ?? []).length, 1, "only the shell-less fallback");
    assert.match(tracker, /this\.terminals\.acquire\(options\.cwd\)/, "everything else is leased from the pool");
    assert.match(tracker, /item\.lease\?\.release\(\)/, "and handed back when the execution ends, not when the terminal closes");
    assert.match(await read("vscode/commandRunner.ts"), /this\.terminals\.acquire\(options\.cwd\)/);
  });

  it("both of those hand the arguments over through the one shared function", async () => {
    for (const file of ["vscode/executionTracker.ts", "vscode/commandRunner.ts"]) {
      const source = await read(file);
      // Two halves of the one shared hand-over: deciding whether this shell
      // can be given the command (before anything durable is written), then
      // performing it (the first irreversible step).
      assert.match(source, /shellHandoverFor\(/, `${file} decides the shell hand-over through the shared function`);
      // Performing it is the shared race-safe step: the final occupancy check
      // and `executeCommand` with nothing awaited in between. Neither
      // launcher may keep a copy of that ordering, and neither calls
      // `executeCommand` itself at all.
      assert.match(source, /handOverToIdleShell\(/, `${file} performs it through the shared, race-safe hand-over`);
      assert.ok(!/performShellHandover\(/.test(source), `${file} does not perform the hand-over outside the idle-terminal check`);
      assert.ok(!/integration\.executeCommand\(/.test(source), `${file} does not call executeCommand itself`);
    }
    const shared = await read("vscode/shellIntegration.ts");
    assert.match(shared, /planShellHandover\(word, args, shellFamily\(/, "and it decides by the one rule in core, not by a second copy of it");
    // The one place the final check and the hand-over meet, and they meet
    // with no `await` between them.
    const handover = await read("vscode/shellHandover.ts");
    const critical = handover.slice(handover.indexOf("if (handover.via !== \"no-shell\" && lease.idle())"), handover.indexOf("if (handover.via === \"no-shell\")"));
    assert.ok(critical.includes("performShellHandover("), "the shared hand-over performs it right after the idle check");
    assert.ok(!/await/.test(critical), `nothing is awaited between the occupancy check and the hand-over, got ${critical}`);
  });
});
