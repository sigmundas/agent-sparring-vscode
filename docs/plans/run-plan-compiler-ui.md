# Run Plan compiler: VS Code thin presenter

Repository: `agent-sparring-vscode` (primary). Sibling: `agent-sparring`
branch `feature/run-plan-compiler` pinned at
`7c4817ef141d99fea6a4407737145983b4265c0d` (read-only for this stage).
Status: approved. Stage 5 of `agent-sparring/docs/plans/run-plan-compiler.md`,
run here because the work lives in this repository; executed from
`docs/plans/run-plan-compiler-ui.manifest.json`, which declares the sibling
pin.

## Stage 1 — Run Plan through start-plan; v2 parsers; stage-label grouping

Engine contract (sibling, read-only; read only what you need):
`agent-sparring/docs/intake.md` section "One-command start: `sparring
start-plan`", `src/agent_sparring/plan_start.py` (JSON status keys),
`src/agent_sparring/manifest.py` (v2: `gates_before`, `completion_gates`),
and `sparring start-plan --help` from that checkout.

Required (from the engine plan's Stage 5):

- Run Plan → `start-plan --json`: render preparation states (including the
  notice that a dry run / answer rerun may spend a read-only provider turn),
  decision cards (engine-posed decisions and options; the person answers;
  reruns with `--answer`), findings, a details link to the intake report,
  the summary of what will run (models, effort, permission mode,
  executables, push, gates), and a single "Start run" that reruns the same
  command plus `--confirm <token>`. Any refusal or token mismatch is shown
  as the engine reported it; never reuse a token, never answer decisions or
  confirm on the person's behalf.
- Overview groups nodes by human-plan stage label.
- TypeScript manifest and intake-envelope parsers accept v2 (`gates_before`,
  `completion_gates`); regenerate any parity vectors from the sibling's
  engine output.
- Run Plan stops using `buildManifest`; keep it for engines without
  `start-plan` (detect capability, e.g. via `--help` or a version probe)
  and for resuming existing `source=manifest` runs.
- Do not edit `.sparring` files or the sibling repository.

Tests: unit tests for start-plan JSON → view model (`overviewModel`), v2
parser cases, capability fallback, and an integration test with a stubbed
engine. Run `npm run typecheck`, `npm run lint`, `npm test`.
