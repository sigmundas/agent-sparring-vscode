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
- Launches `sparring run-plan` / `sparring resume-plan` in a VS Code terminal,
  executed directly with an argument array (no shell, no quoting).

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

A stage loop launched from the extension runs in its own terminal, which the
extension tracks. When that terminal's process exits for any reason (normal
completion, Ctrl-C, error, killing the terminal) the "working / sparring"
claims derived from telemetry are cleared for presentation and everything is
recomputed from the authoritative files; an exit without a matching
`turn.finished` / verdict shows **Runner stopped · last run interrupted**.
While the runner is alive the Overview offers **Stop (Ctrl-C)**, which sends
Ctrl-C to that exact terminal. Engine state is never modified.

Whenever the telemetry shows a stage or sparring turn in progress, whoever
started it, the Overview shows a non-clickable **Running** state instead of
Run/Resume, so a second loop can never be launched for a busy stage. The
tooltip says whether that liveness is exact (our terminal) or inferred from
telemetry. Once the turn has ended and the stage is still non-terminal,
**Resume stage** returns. A busy claim with no meaningful activity for a
while reads "no meaningful activity for Xm" rather than implying a hang.

Overview document actions (Brief, Handoff, Sparring report, Plan) open as
preview tabs in the editor group the Overview panel is in and follow it if
it is moved; Diff keeps its dedicated diff view and Log focuses the Output
panel.

For loops started elsewhere, process liveness is unknown: telemetry is
trusted as before, but a busy claim with no events for 30 minutes is shown as
stale ("the runner may have stopped") rather than as certain work.

## Develop

```sh
npm install
npm run build      # typecheck + esbuild bundle to dist/
npm test           # node:test unit tests against fake .sparring fixtures
npm run lint
npm run test:integration   # downloads VS Code once, opens a generated multi-root workspace, asserts real discovery
```

Press F5 in VS Code to launch an Extension Development Host.

## Install locally

```sh
npm install
npm run package:vsix                     # writes agent-sparring-vscode-<version>.vsix
code --install-extension agent-sparring-vscode-0.1.0.vsix
```
