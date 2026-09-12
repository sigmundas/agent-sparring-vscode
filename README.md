# Agent Sparring for VS Code

A thin desktop cockpit for the `agent-sparring` engine (the sibling Python project).
The engine stays the authority; this extension only observes, launches and
navigates.

## What it does (V1 shell)

- Detects every `.sparring/` directory in the workspace: directly under each
  workspace folder and in projects nested below one (a git worktree or a
  monorepo package checked out under a parent folder; see
  `agentSparring.nestedSearchDepth`). Each project is its own repository in
  the run list.
- Discovers recorded plan runs (`.sparring/plans/<key>.json`), their stages
  (`.sparring/stages/<id>/state.json`) and standalone stages.
- Shows one status-bar item, e.g. `● Agent Sparring: Stage 3/6 · Claude working`,
  `⏸ Agent Sparring: Stage 3/6 · NEEDS_YOU`, `✓ Agent Sparring: Plan complete`.
- Streams a terse chronology of the current stage's `activity.jsonl` into the
  **Agent Sparring** Output Channel (no prompts, payloads or tool output; the
  engine never writes them and the extension never invents them).
- Attaches automatically to runs started from any terminal, and rediscovers
  everything from disk after a reload.
- Launches `sparring run-plan` / `sparring resume-plan` / `sparring run-loop`
  in an integrated terminal through the shell-integration API (executable +
  argument array, no quoting) and observes when the process ends; see
  "Runner lifecycle".

## Commands

| Command | Effect |
| --- | --- |
| `Agent Sparring: Run Plan` | Pick a plan Markdown file (`## Stage <n> — <title>` headings), confirm the branch, launch `run-plan`. |
| `Agent Sparring: Resume Plan` | Pick a paused/running plan run, optionally record human evidence, launch `resume-plan`. |
| `Agent Sparring: Run / Resume Stage` | For the selected standalone stage (or after picking one), launch `sparring run-loop <stage> --repo-root <project> --expected-branch <current branch>` in a terminal. The branch comes from the Git repository owning the project (built-in Git API, then `.git/HEAD`); a detached HEAD is refused, never guessed. Also offered as **Run stage** / **Resume stage** in the Overview; accepted and frozen stages have no run action, READY offers only an explicit **Run loop again**. |
| `Agent Sparring: Open Overview` | One editor-area Run Overview panel: compact plan journey (accepted / current / paused / frozen / future stages), the current stage as primary content (`Stage N — title`, presentation status, routing state, loop cycle, the Goal paragraph from `brief.md`, `Working for Xm Ys` or the last visible event), last sparring outcome, small Stage Agent / Sparrer cards, Open diff / handoff / sparring report / brief / plan buttons, and quiet metadata. Never auto-opens; updates in place. |
| `Agent Sparring: Show Log` | Focus the Output Channel. |
| `Agent Sparring: Select Run` | Choose explicitly when several runs look active; the choice is remembered per workspace. |
| `Agent Sparring: Rediscover State` | Re-scan `.sparring` from disk. |
| `Agent Sparring: Diagnose Discovery` | Trace discovery for every workspace folder into the Output Channel: scheme, path, the `.sparring` probed, nested projects, stage/plan files and whether they parsed (lifecycle status only), runs produced, what Select Repository / Run would list, and why nothing is selected. Never logs file contents. |

## Settings

- `agentSparring.executable` — path to `sparring`; empty resolves it from `PATH`.
- `agentSparring.pollIntervalMs` — fallback poll interval for the activity log.
- `agentSparring.nestedSearchDepth` — how many levels below each workspace
  folder are searched for nested projects with their own `.sparring`
  (default 2; 0 probes only the folders themselves). Hidden and
  dependency/build directories are never entered.

## Source-of-truth rule

| Displayed fact | Source |
| --- | --- |
| running / paused / complete, current stage index and id | `.sparring/plans/<key>.json` |
| working / frozen / accepted per stage | `.sparring/stages/<id>/state.json` |
| stage count and titles | the plan Markdown named in the run state |
| NEEDS_YOU / ESCALATE wording on a paused run | `## Routing outcome` in the current stage's `sparring.md` |
| "Claude working", "Codex sparring", active-turn duration, loop cycle, last visible event, changed files, verdict chronology | `activity.jsonl` (observational only; the Overview and the Output Channel share one filter for what counts as visible activity) |
| Goal paragraph in the Overview | `## Goal` in the current stage's `brief.md` (display only) |

Deleting `activity.jsonl` removes the live decoration and nothing else.

### Runner lifecycle

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
| Launched from the extension | A fresh integrated terminal (your normal shell, cwd = project) runs `sparring` through the terminal shell-integration API with an argument array; no quoted command line is built. | The shell-execution end event fires (normal exit, non-zero exit, Ctrl-C), another command starts in that terminal, or the terminal closes. |
| Dedicated terminal (fallback) | Only if shell integration does not activate within 5 s: a terminal whose process *is* `sparring` (argument array, no shell). | That terminal closes, which VS Code does as soon as the process exits. |
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
- Accepted / frozen stages have no run action, whatever the telemetry says.

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

#### Manual verification

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

## Develop

```sh
npm install
npm run build      # typecheck + esbuild bundle to dist/
npm test           # node:test unit tests against fake .sparring fixtures
npm run lint
npm run test:integration   # downloads VS Code once, opens a generated multi-root workspace, asserts discovery and runner lifecycle with a fake `sparring`
```

Press F5 in VS Code to launch an Extension Development Host.

## Install locally

```sh
npm install
npm run package:vsix                     # writes agent-sparring-vscode-<version>.vsix
code --install-extension agent-sparring-vscode-0.1.0.vsix
```
