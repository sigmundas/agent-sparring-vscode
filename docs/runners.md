# Terminals and runner lifecycle

[Documentation index](README.md) · [Extension overview](../README.md)

- [Terminals](#terminals)
- [Submitting a command is not running it](#submitting-a-command-is-not-running-it)
- [Runner lifecycle](#runner-lifecycle)

## Terminals

There is **one reusable terminal per project**, `Agent Sparring — <project>`.
Run stage, Accept stage, run-plan and every resume-plan of a long managed run
share it, so a plan does not leave a row of dead tabs behind. A terminal is
reused only while its shell is idle, and "idle" is decided from the shell,
not from the extension's own bookkeeping: every shell execution in the
terminals the extension owns is watched (`onDidStartTerminalShellExecution` /
`onDidEndTerminalShellExecution`), whoever started it. So if you start an
interactive CLI — `claude`, a long test run — in `Agent Sparring — <project>`
after a command has finished, the next engine command opens
`Agent Sparring — <project> (2)` instead. Your terminal is not written to and
your command is not interrupted; the extension never sends it Ctrl-C, and
never leaves an engine command sitting in your prompt.

The same holds for a terminal whose occupancy cannot be established: one
whose shell integration never reported, or one VS Code restored after a
window reload (nothing in the new window saw what has been running in it). A
fresh terminal is opened rather than an idle shell assumed. A terminal you
closed is replaced, and projects never share one. Only terminals the
extension opened are ever written to — a command you type in your own
terminal is observed, never interrupted.

## Submitting a command is not running it

Handing a command line to shell integration submits it. The shell may run it
at once, later (a stopped or busy shell runs the line when it continues), or
never. So every engine command — `run-plan`, `resume-plan`, `run-loop` and the
short ones, `freeze-candidate`, `accept-candidate`, `new-stage` — goes through
one submission registry, and a submission becomes a runner only when the shell
reports **that exact execution** as started:

| State | What it means | What the extension does |
| --- | --- | --- |
| Submitted, waiting | the start report is being waited for (5 s) | nothing is `Running`, nothing is persisted as a live launch, no runner is claimed |
| Submitted, uncertain | that wait expired with no start report | the same, plus: the terminal is quarantined (never reused, never closed or signalled — your command may be what is holding it), and the extension keeps looking for evidence |
| Running | the shell reported that execution as started | an ordinary tracked runner: persisted, shown, stopped with Ctrl-C, ended by its own end event |

**The invariant.** Once a command has been handed to a shell and nothing has
*proved* that it can no longer execute, that submission keeps refusing a second
copy of the same operation — a second `run-plan` for that run, a second
`freeze-candidate` for that stage. The check happens before the executable is
resolved, before a terminal is acquired and before anything is sent. The
wording says what is known — "Agent Sparring handed this command to the
terminal and has not been able to confirm whether it started" — and never that
a runner is alive.

**What resolves a submission.** Only evidence:

| Evidence | What it proves |
| --- | --- |
| the shell reports that exact execution started | it ran (a runner is then tracked as usual, however late the start) |
| the shell reports that exact execution finished | the shell only reports an end for a command it ran |
| its terminal was closed | the pty and the shell reading it are gone, so a queued line can never be read |
| `ps` no longer lists the shell process that took it | the same conclusion, for a submission this window can no longer identify |
| `ps` lists *this exact command* (same subcommand, stage / plan / manifest) | it started |
| the command line was never handed over (no terminal of this project had an idle, observable shell) | there is no submitted line at all |

**What never resolves one:** a timer of any kind, the terminal-reconnect grace
period after a reload, and *any other* runner turning up in the project's
process table. "There is a runner in this project" is not "the command I queued
started": a probed runner and an unresolved submission coexist, and the probed
runner ending does not settle the submission either.

**The human override.** Agent Sparring cannot cancel a line a shell already
has, so there is no "cancel". What there is, on the refusal, is
**I checked — allow retry**: a modal confirmation stating that you have looked
at that terminal and the command cannot start any more, and that retrying while
it can could run the operation twice. It is recorded in the log as your
override, never as evidence that the command did not run.

**After a reload.** Submissions are persisted separately from the launches, so
a reload never turns one into a live runner. VS Code cannot hand a
`TerminalShellExecution` back, so a restored submission cannot be recognised by
identity: it stays uncertain and keeps refusing a duplicate until its terminal
closes, until `ps` shows the shell that took it is gone or shows the exact
command running, or until you override it. A terminal that merely does not
reconnect proves nothing. On a platform without a process probe, an unresolved
submission stays unresolved until a terminal event or your override — the log
says so.

## Runner lifecycle

Two things are kept strictly apart:

- **Actor activity** comes from `activity.jsonl`: a turn was observed
  starting, a verdict was observed. It says what the engine last reported and
  never proves the `sparring` process is alive; an unmatched `turn.started`
  is exactly what Ctrl-C, a crash or a window reload leave behind.
- **Runner liveness** comes only from observing the process, and is one of
  `running`, `stopped` or `unknown`. Telemetry alone is never promoted to
  `Running`.

Liveness sources, most exact first:

| Source | How it is observed | Ends when |
| --- | --- | --- |
| Launched from the extension | This project's integrated terminal (your normal shell, cwd = project — only when its shell is idle) runs `sparring` through the terminal shell-integration API with an argument array (see [Free-text arguments never go through a shell](configuration.md#free-text-arguments-never-go-through-a-shell) for the commands that bypass the shell entirely). Recorded as a runner only once the shell reports that exact execution started; a submission the shell has not started is kept apart from the launches and is never a runner (see "Submitting a command is not running it"). | The shell-execution end event fires (normal exit, non-zero exit, Ctrl-C), another command starts in that terminal, or the terminal closes. |
| Dedicated terminal | A terminal whose process *is* `sparring` (argument array, no shell). Used for every command carrying free text, and whenever shell integration does not activate within 5 s. | That terminal closes, which VS Code does as soon as the process exits. |
| Typed in an integrated terminal | Shell integration reports the command line and cwd; `sparring run-loop <stage>`, `run-plan` and `resume-plan` are recognised and tied to the project by `--repo-root` / `--sparring-dir` / cwd (nested projects match their own root). | Same as a launched command. |
| Re-found after a window reload | Launches are recorded in `workspaceState`; after a reload the hosting terminal is re-found by process id and, on macOS/Linux, a `ps` probe checks that the runner still runs under it. | The probe no longer finds it, or a shell execution starts/ends in that terminal. On Windows the state stays `unknown`. |
| Outside VS Code / before activation | Nothing observes the process. | Never known; telemetry describes activity and liveness is labelled unknown. |

What the UI shows:

- Runner known alive: **Running** (non-clickable, exact), `Claude working for
  3m 12s`, and **Stop (Ctrl-C)**, which sends Ctrl-C to that exact terminal.
  No second loop can be launched.
- Runner known ended while telemetry still had an actor mid-turn: the busy
  claim is cleared for presentation, the duration stops, the Overview shows
  **Stopped · last turn interrupted** and **Runner stopped**, the status bar
  says `· stopped`, and **Resume stage** returns. A turn that started *after*
  the observed end is a new observation and is not masked; late or replayed
  telemetry with an older timestamp can never re-arm `Running`.
- Only telemetry claims a turn (external run, or right after a reload with
  nothing re-found): **Run status unknown** instead of Run/Resume, the
  activity line reads `Turn started 3m 12s ago · Claude · runner status
  unknown`, the actor card `Working? (turn observed 3m 12s ago)`, and the
  status bar `Claude working (unconfirmed)`. The command
  `Run / Resume Stage` can override this only through an explicit modal
  confirmation; the engine's worktree lock refuses a second live runner anyway.
  A busy claim with no telemetry for 30 minutes is additionally flagged
  stale; silence is information, never a death detector.
- Accepted stages have no action; a stage stuck in the engine's frozen
  state offers **Accept stage** again, whatever the telemetry says.

Engine state (`state.json`, `activity.jsonl`) is never modified; all of this is
presentation and liveness state inside the extension.

**Developer: Reload Window.** Because the launched command runs inside a
normal shell terminal, whether it survives a reload is VS Code's ordinary
terminal persistence (`terminal.integrated.enablePersistentSessions`, on by
default; terminals created by extensions are persisted unless marked
transient). VS Code exposes no API for "which command is currently running
in this reconnected terminal", so the reloaded extension re-establishes
liveness from the recorded launch: terminal gone → `stopped`; terminal
present and the `ps` probe finds the runner → `running`; terminal present
without a probe (Windows) → `unknown`. It never turns the replayed
`turn.started` into `Running`.

### Manual verification

A. Ctrl-C

1. Open the Overview, select a working standalone stage, click **Run stage**.
2. Confirm **Running** and, once the first turn starts, `Claude working for …`.
3. Focus the `Agent Sparring: Run stage: <stage>` terminal and press Ctrl-C.
4. The Overview and status bar leave `Running` immediately (no wait for
   telemetry): **Stopped · last turn interrupted**, status bar `· stopped`.
5. Wait a minute: the duration is gone and does not grow.
6. **Resume stage** is offered; the Output Channel logs the exit.

B. Developer: Reload Window

1. Click **Run stage**; confirm **Running** and live telemetry.
2. Run `Developer: Reload Window`.
3. After reload, check the terminal: is the `sparring` command still printing
   (survived) or did the shell return to a prompt / disappear (killed)? Note
   the result; it depends on VS Code's persistence, not on the extension.
4. The reloaded extension must not show `Running` from the replayed
   telemetry: within ~6 s it shows **Running** only if the runner was
   re-found, otherwise **Stopped · last turn interrupted** (terminal gone)
   or **Run status unknown** (terminal open, no probe). The Output Channel
   logs which case applied.
5. If it survived: telemetry keeps flowing and **Stop (Ctrl-C)** still
   targets the right terminal.
6. If it did not survive: **Resume stage** is offered.

C. Declarations across a reload

The integration harness cannot make this check for itself, because a test
host never writes its workspace storage to disk. See
[What the integration harness cannot test](development.md#what-the-integration-harness-cannot-test).

1. In a worktree with a plan, run **Agent Sparring: Sibling Repositories for a
   Plan Stage…** and declare one for a stage, then **Agent Sparring: Stage Mode
   for a Plan Stage…** and set that stage to *Independent review*.
2. Run `Developer: Reload Window`.
3. Re-open both commands: the stage still shows the sibling under its label and
   *review only* beside it.
4. If a second worktree of the same repository with the same plan path is open,
   both commands must show it as declaring **nothing** — the two share a plan
   key, and that is exactly what the worktree scope exists to separate.
