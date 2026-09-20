/**
 * Building `sparring` invocations, resolving the executable, and handing the
 * result to a shell without the shell re-reading it as syntax.
 *
 * Arguments are always returned as arrays for a shell-less spawn; nothing is
 * quoted or joined, so paths with spaces are safe on every platform.
 *
 * CLI surface used (cli.py at 35a2fb2, plus push authorization):
 *   sparring [--sparring-dir DIR] run-plan    (PLAN | --manifest FILE) --repo-root ROOT --expected-branch BRANCH [--adopt] [--allow-push-for-run]
 *   sparring [--sparring-dir DIR] resume-plan (PLAN | --manifest FILE) --repo-root ROOT --expected-branch BRANCH [--evidence TEXT] [--allow-push-candidate SHA] [--allow-push-for-run]
 *   sparring [--sparring-dir DIR] run-loop    STAGE --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] run-sparring STAGE --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] freeze-candidate STAGE --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] accept-candidate STAGE --repo-root ROOT --expected-branch BRANCH
 *   sparring [--sparring-dir DIR] new-stage   STAGE [--brief-file PATH]   (engine 7b6b2d8)
 *
 * No dependency on the vscode API.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PlanRunSource } from "./engineFormats";

export const DEFAULT_EXECUTABLE = "sparring";

export interface PlanInvocation {
  /** The reviewed Markdown plan; omitted when `manifest` is given. */
  planPath?: string;
  /**
   * An execution manifest, passed as `--manifest` instead of the positional
   * plan. The engine then runs the stages the extension listed, in that
   * order, with those exact briefs (manifest.ts).
   */
  manifest?: string;
  repoRoot: string;
  expectedBranch: string;
  /** Passed as the global `--sparring-dir` when it is not `<repoRoot>/.sparring`. */
  sparringDir?: string;
}

/**
 * `sparring run-plan (<plan> | --manifest <file>) --repo-root … --expected-branch …`
 * (cli.py: run_plan). `adopt` adds `--adopt`, which lets the run take over
 * stages that already exist instead of refusing them — each one checked and
 * reported by the engine, never silently inherited. `allowPushForRun` adds
 * `--allow-push-for-run`, recording as part of creating the run that it may
 * push the verified candidates it produces (see `PushAuthorizationRequest`).
 */
export function buildRunPlanArgs(invocation: PlanInvocation & { adopt?: boolean; allowPushForRun?: boolean }): string[] {
  const args = [...globalArgs(invocation), "run-plan", ...planInput(invocation), ...loopArgs(invocation)];
  if (invocation.adopt) {
    args.push("--adopt");
  }
  if (invocation.allowPushForRun) {
    args.push("--allow-push-for-run");
  }
  return args;
}

/**
 * A person's answer to the engine's push-authorization request.
 *
 * `candidateSha` is the exact commit that was on screen, and it is always
 * sent: the engine refuses it unless the run is in fact waiting for
 * permission to push that commit, which is what makes a panel that has been
 * open a while unable to authorize a candidate the run has since replaced.
 * `forRun` is the "stop asking me for this run" half of the same click.
 */
export interface PushAuthorizationRequest {
  candidateSha: string;
  forRun?: boolean;
}

export interface ResumePlanInvocation extends PlanInvocation {
  /**
   * The input kind the run is **recorded** as (`source` in the engine's
   * plan-run state). Required, and required to agree with the input given:
   * the engine refuses to resume a run from a different kind of input than
   * it was started from, and that refusal is right — the two describe
   * different execution content for the same plan. Passing the recorded
   * source here is what makes generating such a request impossible instead
   * of merely unlikely.
   */
  source: PlanRunSource;
  evidence?: string;
  /** Present only when the person has just allowed a push; see `PushAuthorizationRequest`. */
  allowPush?: PushAuthorizationRequest;
  /**
   * Answers to the deferred manual checks the run is stopped on, one per
   * `--deferred-result`.
   *
   * Always addressed as `<gate instance>:<check id>`, never as the bare id:
   * two askings at one checkpoint can own the same check id, and the engine
   * refuses an ambiguous reference rather than guessing. Sending the
   * qualified form always means the answer lands on the asking that was on
   * screen, and on no other. A gate instance never contains a colon
   * (`human_gate.py`: `_INSTANCE_ID_RE`), so the left half is unambiguous; a
   * reviewer's check id may, and the engine reads the reference both ways to
   * cover that.
   */
  deferredResults?: DeferredResultAnswer[];
}

/** One answer to one deferred check, as the engine's `--deferred-result` takes it. */
export interface DeferredResultAnswer {
  /** The engine-minted asking this answers. */
  gateInstanceId: string;
  /** The reviewer's own check id. */
  checkId: string;
  outcome: "pass" | "fail" | "blocked";
  /** Optional; recorded with the result in the originating stage's notes.md. */
  note?: string;
}

export function buildResumePlanArgs(invocation: ResumePlanInvocation): string[] {
  requireRecordedInputKind(invocation);
  const args = [...globalArgs(invocation), "resume-plan", ...planInput(invocation), ...loopArgs(invocation)];
  if (invocation.evidence && invocation.evidence.trim()) {
    args.push("--evidence", invocation.evidence.trim());
  }
  for (const answer of invocation.deferredResults ?? []) {
    // `<ref>=<outcome>[=<note>]`, and the engine splits at most twice, so a
    // note may contain `=` freely. Newlines are collapsed: the value is one
    // shell argument, and a note is a sentence, not a document.
    const note = answer.note?.trim().replace(/\s+/g, " ");
    const ref = `${answer.gateInstanceId}:${answer.checkId}`;
    args.push("--deferred-result", note ? `${ref}=${answer.outcome}=${note}` : `${ref}=${answer.outcome}`);
  }
  if (invocation.allowPush) {
    args.push("--allow-push-candidate", invocation.allowPush.candidateSha);
    if (invocation.allowPush.forRun) {
      args.push("--allow-push-for-run");
    }
  }
  return args;
}

/**
 * The input kind of a resume must be the recorded one. Not a warning and not
 * a fallback: building the command at all is refused, because the engine
 * would refuse the run and the person would be left with a plan that cannot
 * be continued by any button.
 */
function requireRecordedInputKind(invocation: ResumePlanInvocation): void {
  const given: PlanRunSource = invocation.manifest ? "manifest" : "markdown";
  if (given === invocation.source) {
    return;
  }
  throw new Error(
    `this plan run was started from a ${invocation.source} plan input; refusing to build a resume from a ${given} one. ` +
      "The engine refuses to resume a run from a different kind of input, and an existing run's input kind is never changed.",
  );
}

/** Exactly one plan input, as the engine requires: the manifest flag or the positional plan. */
function planInput(invocation: PlanInvocation): string[] {
  if (invocation.manifest) {
    return ["--manifest", invocation.manifest];
  }
  if (!invocation.planPath) {
    throw new Error("a plan invocation needs either planPath or manifest");
  }
  return [invocation.planPath];
}

export interface LoopInvocation {
  stageId: string;
  repoRoot: string;
  expectedBranch: string;
  sparringDir?: string;
}

/** `sparring [--sparring-dir DIR] run-loop STAGE --repo-root ROOT --expected-branch BRANCH` (cli.py: run_loop). */
export function buildRunLoopArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "run-loop", invocation.stageId, ...loopArgs(invocation)];
}

/**
 * `sparring [--sparring-dir DIR] run-sparring STAGE --repo-root ROOT --expected-branch BRANCH`
 * (cli.py: run_sparring → run_sparring_agent): one independent-review turn,
 * resuming the stage's recorded sparring session when there is one. It does
 * not run the stage agent, so it is what asks the reviewer to look again at
 * the unchanged candidate plus the human evidence in the handoff.
 */
export function buildRunSparringArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "run-sparring", invocation.stageId, ...loopArgs(invocation)];
}

/** `sparring [--sparring-dir DIR] freeze-candidate STAGE --repo-root ROOT --expected-branch BRANCH` (cli.py: freeze_candidate). */
export function buildFreezeCandidateArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "freeze-candidate", invocation.stageId, ...loopArgs(invocation)];
}

/** `sparring [--sparring-dir DIR] accept-candidate STAGE --repo-root ROOT --expected-branch BRANCH` (cli.py: accept_candidate). */
export function buildAcceptCandidateArgs(invocation: LoopInvocation): string[] {
  return [...globalArgs(invocation), "accept-candidate", invocation.stageId, ...loopArgs(invocation)];
}

export interface NewStageInvocation {
  stageId: string;
  repoRoot: string;
  sparringDir?: string;
  /** A UTF-8 Markdown file the engine uses verbatim as the initial brief.md (`--brief-file`). */
  briefFile?: string;
}

/**
 * `sparring [--sparring-dir DIR] new-stage STAGE [--brief-file PATH]` (cli.py:
 * new_stage → Stage.create): the engine writes the stage skeleton
 * (state.json, brief.md, notes.md, handoff.md, sparring.md). With
 * --brief-file it reads that file first and writes it as brief.md in place
 * of the template; an unreadable file fails before any stage is created.
 * No --repo-root: the command takes only the global --sparring-dir,
 * resolved against cwd when omitted.
 */
export function buildNewStageArgs(invocation: NewStageInvocation): string[] {
  const args = [...globalArgs(invocation), "new-stage", invocation.stageId];
  if (invocation.briefFile) {
    args.push("--brief-file", invocation.briefFile);
  }
  return args;
}

function globalArgs(invocation: { repoRoot: string; sparringDir?: string }): string[] {
  if (!invocation.sparringDir) {
    return [];
  }
  const implicit = path.join(invocation.repoRoot, ".sparring");
  if (path.resolve(invocation.sparringDir) === path.resolve(implicit)) {
    return [];
  }
  return ["--sparring-dir", invocation.sparringDir];
}

function loopArgs(invocation: { repoRoot: string; expectedBranch: string }): string[] {
  return ["--repo-root", invocation.repoRoot, "--expected-branch", invocation.expectedBranch];
}

// ---------------------------------------------------------------------------
// executable resolution
// ---------------------------------------------------------------------------

export interface ResolveEnv {
  platform: NodeJS.Platform;
  PATH?: string;
  PATHEXT?: string;
  /** Base directory for a relative configured path (the workspace folder). */
  cwd?: string;
}

/**
 * What to hand the terminal:
 *  - `configured`: the user set `agentSparring.executable`; the path was
 *    checked here and is used exactly;
 *  - `shell`: nothing configured; the bare command word is passed to the
 *    user's own integrated shell, which resolves it with its normal PATH
 *    and environment (the extension host's PATH is not consulted, because
 *    it routinely lacks what a login shell has);
 *  - `resolved`: nothing configured and no shell available to do the
 *    resolving, so the bare name was found along the extension host's PATH
 *    as a best effort.
 */
export type ExecutablePlan = { kind: "configured"; path: string } | { kind: "shell"; command: string } | { kind: "resolved"; path: string };

/** Why an executable could not be planned; the message is user-facing. */
export type ExecutableProblem = "configured-invalid" | "unresolvable";

export type ResolvedExecutable = { ok: true; plan: ExecutablePlan } | { ok: false; problem: ExecutableProblem; error: string };

export const UNRESOLVABLE_MESSAGE = "Agent Sparring could not resolve the CLI from this VS Code environment. Set agentSparring.executable to the full path.";

/**
 * Decide how `sparring` will be invoked. `shellAvailable` says whether the
 * command will run through the user's integrated shell (terminal shell
 * integration); when it will, a bare `sparring` is never pre-rejected here,
 * because only that shell knows its PATH. A configured path is validated
 * regardless; without a shell, the bare name falls back to a PATH search
 * in this process and, failing that, an honest configuration message
 * (never a suggestion to reinstall the engine).
 */
export async function planExecutable(configured: string | undefined, env: ResolveEnv, shellAvailable: boolean): Promise<ResolvedExecutable> {
  const name = (configured ?? "").trim();
  const isWindows = env.platform === "win32";
  if (name) {
    const hasSeparator = name.includes("/") || (isWindows && name.includes("\\"));
    const candidate = path.isAbsolute(name) ? name : hasSeparator ? path.resolve(env.cwd ?? process.cwd(), name) : undefined;
    if (candidate === undefined) {
      // A bare name was configured: treat it like the default command word.
      return planBare(name, env, shellAvailable);
    }
    for (const variant of withExtensions(candidate, isWindows, env.PATHEXT)) {
      if (await isExecutableFile(variant, isWindows)) {
        return { ok: true, plan: { kind: "configured", path: variant } };
      }
    }
    return { ok: false, problem: "configured-invalid", error: `agentSparring.executable points at ${candidate}, which does not exist or is not executable.` };
  }
  return planBare(DEFAULT_EXECUTABLE, env, shellAvailable);
}

async function planBare(command: string, env: ResolveEnv, shellAvailable: boolean): Promise<ResolvedExecutable> {
  if (shellAvailable) {
    return { ok: true, plan: { kind: "shell", command } };
  }
  const found = await searchPath(command, env);
  if (found) {
    return { ok: true, plan: { kind: "resolved", path: found } };
  }
  return { ok: false, problem: "unresolvable", error: UNRESOLVABLE_MESSAGE };
}

/** The first executable named `command` along `env.PATH`, honouring PATHEXT on Windows; undefined when none. */
export async function searchPath(command: string, env: ResolveEnv): Promise<string | undefined> {
  const isWindows = env.platform === "win32";
  const dirs = (env.PATH ?? "").split(isWindows ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const variant of withExtensions(path.join(dir, command), isWindows, env.PATHEXT)) {
      if (await isExecutableFile(variant, isWindows)) {
        return variant;
      }
    }
  }
  return undefined;
}

/** The word or path the terminal is given for a plan. */
export function executableWord(plan: ExecutablePlan): string {
  return plan.kind === "shell" ? plan.command : plan.path;
}

/**
 * Whether an exit code *could* mean the shell could not find the command:
 * 127 on POSIX shells, 9009 from cmd.exe. PowerShell reports 1 for an
 * unknown command, which is indistinguishable from an ordinary failure, so
 * it is not claimed here.
 *
 * The code alone is never enough — 127 is also what a shell reports when
 * something the *engine* ran was missing, and what a program may exit with
 * for its own reasons. Use `wasCommandNotFound`.
 */
export function isCommandNotFoundExit(exitCode: number | undefined, platform: NodeJS.Platform): boolean {
  if (exitCode === undefined) {
    return false;
  }
  return exitCode === 127 || (platform === "win32" && exitCode === 9009);
}

/**
 * Whether the launch itself failed because the command word could not be
 * found. Only a bare word the *shell* had to resolve can fail that way: when
 * the extension handed over a path it had already checked exists and is
 * executable (`configured` / `resolved`), the executable was invoked and the
 * exit code belongs to it. Claiming otherwise sends the user off to fix a
 * setting that is correct, and hides the engine's real complaint.
 */
export function wasCommandNotFound(exitCode: number | undefined, platform: NodeJS.Platform, plan: ExecutablePlan | undefined): boolean {
  return plan?.kind === "shell" && isCommandNotFoundExit(exitCode, platform);
}

/** The message shown when the user's shell itself reported the command missing. */
export function commandNotFoundMessage(word: string): string {
  return `Your shell could not find '${word}'. Set agentSparring.executable to the full path of the sparring CLI, or make it available on your shell's PATH.`;
}

// ---------------------------------------------------------------------------
// choosing a transport
// ---------------------------------------------------------------------------

/**
 * How VS Code escapes `executeCommand(executable, args)`
 * (ExtHostTerminalShellIntegration, verbatim):
 *
 *   for (const arg of args) {
 *     !arg.match(/["'`]/) && arg.match(/\s/) ? line += ` "${arg}"` : line += ` ${arg}`;
 *   }
 *
 * An argument is double-quoted only when it holds whitespace and none of
 * `"`, `'` or a backtick; anything else is appended to the command line raw.
 * That is exact for subcommands, flags and ordinary paths, and wrong for
 * anything a person wrote: a backtick becomes command substitution, an
 * apostrophe opens a quote, a newline starts a second command, `$` expands,
 * and an empty argument disappears entirely.
 *
 * This says whether the shell will parse VS Code's line back into the
 * argument it was given. It is deliberately strict: an argument qualifies
 * only if it is made of characters no shell touches.
 */
export function vscodeQuotingIsFaithful(arg: string): boolean {
  if (arg === "") {
    return false; // appended as nothing at all: the argument would vanish
  }
  if (/["'`]/.test(arg)) {
    return false; // never quoted, so every metacharacter in it is live
  }
  if (TERMINAL_CONTROL.test(arg)) {
    // Terminal control bytes act on the interactive reader before the shell
    // parses quoting at all.
    return false;
  }
  if (/\s/.test(arg)) {
    // Double-quoted by VS Code: expansion and history are still active inside.
    return !/[$\\!]/.test(arg);
  }
  return !SHELL_ACTIVE.test(arg);
}

/** Anything outside this set can mean something to a shell when unquoted. */
const SHELL_ACTIVE = /[^\p{L}\p{N}_@%+=:,./-]/u;

// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\x00-\x1f\x7f]/;

/**
 * The flags whose **value** is text a person or a model wrote, rather than an
 * identifier this extension constructed.
 *
 * This set is the one place that distinction is made. No launch site asks
 * about a flag by name; they ask `transportSafety`, which is the only
 * authority on whether a shell may be shown a command at all.
 *
 * Adding a free-text flag to the engine means adding it here. The character
 * rule below means forgetting to is usually caught anyway — real human text
 * nearly always contains something `vscodeQuotingIsFaithful` rejects — but it
 * is not a substitute for the list. "All four checks passed" is free text that
 * happens to look like an identifier, and it must not be treated as one.
 */
export const FREE_TEXT_FLAGS: ReadonlySet<string> = new Set(["--evidence", "--deferred-result"]);

/** Whether any argument is the value of a free-text flag. */
export function carriesFreeText(args: readonly string[]): boolean {
  return args.some((_value, at) => at > 0 && FREE_TEXT_FLAGS.has(args[at - 1]));
}

/**
 * Whether a command may be given to an interactive shell at all.
 *
 * `no-shell` is a hard requirement, not a preference: the caller must reach
 * the engine with an exact argument array and nothing in between that reads
 * syntax — no interactive line editor, no `shell -c`, no environment
 * variable, no temporary file. It is returned when either
 *
 *  - an argument is the value of a free-text flag (`FREE_TEXT_FLAGS`), whatever
 *    that value happens to contain; or
 *  - VS Code's own escaping would not survive a round trip through the shell
 *    for the executable word or any argument.
 *
 * The first condition is what makes the guarantee unconditional. A person's
 * evidence is not a command line and is never made into one: this extension
 * spent two releases inventing progressively cleverer quoting for it — POSIX
 * `'...'`, then ANSI-C `$'...'` — and each time the text still had to cross an
 * interactive terminal that reads bytes before any shell parses them. A
 * command line long enough is corrupted in transit regardless of how
 * faithfully it was encoded, and the engine then receives something that is
 * not what the person wrote, or nothing at all. The only encoding a terminal
 * cannot damage is the one that never goes near it.
 *
 * What `no-shell` then guarantees is exact on POSIX, where the transport
 * reaches `execvp` with the argument vector itself. On Windows there is no
 * argv to pass — node-pty rebuilds a command line under the MSVCRT rules for
 * ConPTY and the engine's runtime parses it back — so the guarantee there
 * rests on that transform being invertible, which is untested in this
 * repository. It is still strictly better than an interactive shell, which
 * has the line-length ceiling as well.
 */
export type TransportSafety = "shell" | "no-shell";

export function transportSafety(word: string, args: readonly string[]): TransportSafety {
  if (carriesFreeText(args)) {
    return "no-shell";
  }
  return vscodeQuotingIsFaithful(word) && args.every(vscodeQuotingIsFaithful) ? "shell" : "no-shell";
}

/**
 * How a command should be handed to a shell:
 *  - `arguments`: VS Code's own escaping is exact for these, so nothing
 *    changes — this is every flag-and-path invocation the extension makes;
 *  - `no-shell`: the caller must reach the process with an argument array and
 *    no shell at all (`transportSafety`).
 *
 * There is deliberately no third answer. A `command-line` variant used to
 * exist, in which this file built the physical line itself and passed it as
 * one already-quoted string; it is gone, and with it `shellCommandLine`,
 * `ansiQuote` and `posixQuote`. Under this policy "shell-bound" and "VS Code's
 * escaping is already faithful" are the same set, so an encoder of our own had
 * no reachable caller left — only tests proving it correct to itself.
 */
export type ShellHandover = { via: "arguments" } | { via: "no-shell" };

export function planShellHandover(word: string, args: readonly string[]): ShellHandover {
  return transportSafety(word, args) === "shell" ? { via: "arguments" } : { via: "no-shell" };
}

function withExtensions(candidate: string, isWindows: boolean, pathext: string | undefined): string[] {
  if (!isWindows) {
    return [candidate];
  }
  const exts = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = candidate.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return [candidate];
  }
  return [candidate, ...exts.map((ext) => candidate + ext)];
}

async function isExecutableFile(file: string, isWindows: boolean): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return false;
    }
    if (isWindows) {
      return true;
    }
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// git branch (for the required --expected-branch)
// ---------------------------------------------------------------------------

/**
 * Read the checked-out branch from `.git/HEAD` (following a worktree
 * `.git` file). Returns undefined when detached or unreadable; the caller
 * must then ask the user.
 */
export async function readGitBranch(repoRoot: string): Promise<string | undefined> {
  let gitDir = path.join(repoRoot, ".git");
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isFile()) {
      const pointer = (await fs.readFile(gitDir, "utf8")).trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match) {
        return undefined;
      }
      gitDir = path.resolve(repoRoot, match[1].trim());
    }
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : undefined;
  } catch {
    return undefined;
  }
}
