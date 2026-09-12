# Agent Sparring for VS Code

A thin desktop cockpit for the [`agent-sparring`](../agent-sparring) engine.
The engine stays the authority; this extension only observes, launches and
navigates.

## What it does (V1 shell)

- Detects a workspace folder with a `.sparring/` directory.
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
| `Agent Sparring: Open Overview` | One editor-area Run Overview panel: stage timeline, Stage Agent / Sparrer cards, current stage line, last sparring outcome, and Open diff / handoff / sparring report / brief / plan buttons. Never auto-opens; updates in place. |
| `Agent Sparring: Show Log` | Focus the Output Channel. |
| `Agent Sparring: Select Run` | Choose explicitly when several runs look active; the choice is remembered per workspace. |
| `Agent Sparring: Rediscover State` | Re-scan `.sparring` from disk. |

## Settings

- `agentSparring.executable` — path to `sparring`; empty resolves it from `PATH`.
- `agentSparring.pollIntervalMs` — fallback poll interval for the activity log.

## Source-of-truth rule

| Displayed fact | Source |
| --- | --- |
| running / paused / complete, current stage index and id | `.sparring/plans/<key>.json` |
| working / frozen / accepted per stage | `.sparring/stages/<id>/state.json` |
| stage count and titles | the plan Markdown named in the run state |
| NEEDS_YOU / ESCALATE wording on a paused run | `## Routing outcome` in the current stage's `sparring.md` |
| "Claude working", "Codex sparring", changed files, verdict chronology | `activity.jsonl` (observational only) |

Deleting `activity.jsonl` removes the live decoration and nothing else.

## Develop

```sh
npm install
npm run build      # typecheck + esbuild bundle to dist/
npm test           # node:test unit tests against fake .sparring fixtures
npm run lint
```

Press F5 in VS Code to launch an Extension Development Host.
