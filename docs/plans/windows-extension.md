# Native Windows compatibility for the Agent Sparring VS Code extension

Status: deferred, optional future-contributor handoff. Not required for the
initial colleague sharing effort; no Windows work is scheduled by this plan.

Primary repository: `agent-sparring-vscode`. Proposed work; not approval to
launch a run, install into the user's editor or invoke providers.
Prerequisites: complete `colleague-sharing.md` here and Stages 1–2 of
`../agent-sparring/docs/plans/windows-compatibility.md` in the engine.
Engine changes run separately; this plan never edits the sibling.

Baseline (2026-10-07): `49f76e8`; typecheck, lint, 1,448 tests, live manifest
parity and VSIX packaging passed on macOS. Windows transport is unverified;
`processProbe.ts` supports POSIX only and command tokenization is POSIX-style.

## Stage 1 — Make Windows launch and text transport explicit and safe

**Repository:** `agent-sparring-vscode`. **Depends on:** sharing plan completed;
engine Windows locking and subprocess stages completed.

**Goal:** Windows can launch the engine and planning providers through supported
installations, and user evidence arrives unchanged without shell evaluation.

**Scope:** `src/core/cli.ts`, `src/vscode/commandRunner.ts`, `executionTracker.ts`,
`shellIntegration.ts`, `makePlan.ts`, `src/core/makePlan.ts`, and affected tests
including `cli.test.ts`, `exactArgvTransport.test.ts`, `makePlan.test.ts`,
`reviewSubmission.test.ts` and `submissionSurvivesFailure.test.ts`.

- Verify Python's native `sparring.exe`, configured paths, host PATH/PATHEXT,
  PowerShell shell-integration launches and the direct-process fallback.
  Test supported Claude/Codex `.exe` or npm launcher shapes for Make Plan;
  detect unsafe/unsupported wrappers and explain the supported alternative.
- Retain the no-shell rule for evidence, deferred results and planning prompts.
  Prefer supported executable/interpreter argument arrays. Do not route text
  through PowerShell, cmd.exe, `sendText` or a quoted physical command line.
- Use real Windows terminal/process fixtures to round-trip Unicode, CRLF/LF,
  backslashes, quotes, spaces, shell metacharacters and long multiline evidence.
  Test the dedicated-terminal route as well as `execFile`; a Node subprocess
  test alone does not prove ConPTY transport.
- Surface the Windows runtime's actual command-line length limit before
  handing over an oversized request. Preserve the draft and keep the operation
  retryable; do not truncate or treat an unsubmitted command as running.
- Keep executable resolution and operation identity scoped to the chosen
  repository and preserve existing submission/observation distinctions.

**Acceptance criteria:** native Windows fake engine/provider fixtures receive
the expected arguments through supported routes; shell metacharacters create
no side effects; failures retain evidence drafts and do not release live
duplicate guards. Run typecheck, compile-tests and affected tests, then
`npm test` and lint for shared command changes; applicable extension-host
checks must include native Windows terminal transport. Record gaps honestly.

**Non-goals:** change workflow authority or the engine; unsafe shell wrappers;
launch providers or live plans; install into the user's editor. Read AGENTS.md
and the README runner/submission contracts; preserve unrelated edits.

## Stage 2 — Recover Windows runners using verifiable process identity

**Repository:** `agent-sparring-vscode`. **Depends on:** Stage 1.

**Goal:** reload and Stop preserve the same identity and duplicate-prevention
guarantees on Windows that POSIX process probes currently support.

**Scope:** `src/vscode/processProbe.ts`, `src/core/processTree.ts`,
`processInvocation.ts`, `sparringCommand.ts`, `src/vscode/operationRegistry.ts`,
`executionTracker.ts`, `terminalPool.ts` and affected lifecycle tests.

- Add a bounded, read-only native process snapshot, for example a fixed
  PowerShell/CIM query for PID, parent PID, creation time and command line.
  No user text belongs in a PowerShell command string. Treat access denial,
  missing fields or incomplete snapshots as unknown, not proof of death.
- Use an opaque process birth fingerprint consistently. Preserve compatibility
  with saved records and refuse to identify a reused PID by PID alone.
- Parse Windows process command lines with the relevant Windows rules rather
  than POSIX backslash escaping. Keep terminal shell-command parsing distinct
  from native process argv reconstruction; unsupported/ambiguous forms are
  unknown. Cover unquoted `C:\\...` paths, spaces, escapes and Unicode.
- Test exact repository, worktree, plan/stage and executable attribution;
  same-name commands in another repository and PID reuse must never clear a
  guard or become a Stop target.
- Verify Ctrl-C through the positively bound terminal. Do not assume Node's
  `process.kill(pid, 'SIGINT')` provides a graceful Windows interrupt. If safe
  graceful interruption without the terminal is unavailable, retain a clear
  manual recovery path rather than using broad `taskkill` or forced termination.

**Acceptance criteria:** native Windows fake-runner reload scenarios restore
verified liveness or safely remain unknown; duplicate launch is refused;
PID reuse, access-denied snapshots and unrelated processes remain safe. Stop
interrupts only a proven target, and unavailable interruption is explained.
Cover affected `processTree`, `sparringCommand`, `processSimilarityIsNotIdentity`,
`stopRunner`, `restoredRunningShellIdentity`, `directExecutionReload`,
`unknownRunnerRecovery` and `operationLifecycle` tests as applicable. Run
typecheck, compile-tests, focused tests, then the suite and lint after changes.

**Non-goals:** derive acceptance from UI/process state, kill user processes,
modify the engine or weaken identity checks. Read AGENTS.md and README
Source-of-truth/Runner lifecycle/Manual verification contracts before edits.

## Stage 3 — Exercise the standard extension on Windows in CI

**Repository:** `agent-sparring-vscode`. **Depends on:** Stages 1 and 2.

**Goal:** native Windows failures become reproducible regression failures rather
than assumptions hidden by macOS fake executables.

**Scope:** CI configuration under `.github/workflows/` if appropriate,
`src/integration/`, platform-specific test fixtures and helpers, package scripts
and README harness notes. Keep the standard distribution from the sharing plan.

- Replace POSIX-only fake executable assumptions with portable Node/Python
  fixtures or explicit native launchers. Cover shebangs, `/bin/sh`, chmod,
  PATH separators, command extensions, symlinks and junctions. Keep the POSIX
  fixtures where they test POSIX behavior; avoid blanket Windows skips.
- Add Windows unit and extension-host jobs and retain POSIX jobs. Check the
  declared minimum VS Code activation and a current stable release; do not
  enable proposed APIs for the standard build.
- Cover fresh repository activation, discovery/multi-root/worktrees, configured
  and PATH engine launch, shell and direct transport, pause/evidence/resume,
  terminal occupancy, safe Stop and unknown recovery with fake processes only.
- Preserve the documented harness limitation: workspaceState durability across
  real reloads needs manual verification; two test-host launches do not prove it.
- Package and inspect the standard VSIX in CI using the sharing-plan allowlist.
  Add live engine manifest parity when the engine fixture is available; do not
  regenerate pins to suppress a mismatch.

**Acceptance criteria:** Windows and POSIX CI provide meaningful unit and
extension-host coverage, retain host-failure logs, and pass packaging checks.
`npm run typecheck`, `npm test`, lint and applicable integration tests pass on
native Windows. Report any OS-specific skipped behavior and real-reload gaps.

**Non-goals:** CI provider accounts, live runs, publishing, installation into a
user environment or engine changes. Follow AGENTS.md and preserve other edits.

## Stage 4 — Verify the Windows colleague experience and document support

**Repository:** `agent-sparring-vscode`. **Depends on:** Stages 1–3 and engine
Windows plan completion, including its provider sandbox verification.

**Goal:** claim only the native Windows workflows verified by tests and a real
Windows colleague-style session.

**Scope:** README installation/platform/runner sections and a concise native
Windows manual verification guide under `docs/` if helpful.

- Document PowerShell setup, Python/Git/provider requirements, supported
  executable shapes, configuration examples, PATH troubleshooting and push
  authorization. Explain WSL/Remote WSL as a separate environment.
- State tested versions and any remaining limits, including no-terminal Stop
  and argument-size limits. Keep project names and examples generic.
- Define a disposable-project smoke check with a local bare Git remote and
  fake engine/providers first: install the built VSIX into an isolated VS Code
  profile, create config, run a plan, submit long multiline evidence, resume,
  switch repositories and reload twice. Check drafts, associations, terminal
  occupancy and duplicate prevention across actual reloads.
- Only after separate explicit authorization, verify the supported real
  provider installation and planning flow in a disposable project. Require
  the engine plan's fresh/resumed read-only sandbox evidence before calling
  native independent review supported. Record concrete versions and outcomes.

**Acceptance criteria:** the real Windows smoke check and prerequisite engine
verification pass; the README's native support claim matches those results.
If unavailable, leave native Windows unsupported and hand off
the exact missing check. Documentation-only edits require diff inspection and
`git diff --check`; do not rerun passed broad suites without new evidence.

**Human checks:** perform the isolated Windows VSIX/reload check, and the real
provider check only when explicitly authorized. Report Pass/Fail/Blocked with
observed results; do not edit engine state to make a demonstration pass.

**Non-goals:** Marketplace publishing, installation into the user's normal
profile, running user plans, production changes or modifying the engine.
