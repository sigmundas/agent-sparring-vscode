# Fresh agent sessions: VS Code UX

Repository: `agent-sparring-vscode`. Status: approved. Stage 3 of the
engine plan `agent-sparring/docs/plans/fresh-agent-session.md`, run here
because the work lives in this repository. Engine contract: branch
`feature/fresh-agent-session` of `agent-sparring` at `f9dd7f3` or later
(read its `docs/reference.md` sections on fresh sessions and
`provider_pause` only for protocol questions; do not edit the engine).

Like `/clear`, not reset-stage: same stage, same candidate, new provider
conversation for one role; history preserved.

## Stage 1 — Start fresh reviewer / implementation agent from Overview

### Engine contract (exists; consume it, do not reimplement)

- `sparring resume-plan … --fresh-sparrer | --fresh-stage-agent
  [--fresh-reason REASON]` with optional role-scoped overrides
  `--sparring-provider/--sparring-model/--sparring-effort` and
  `--stage-provider/--stage-model/--stage-effort`. Without overrides the
  engine resolves the user's current preference. The engine itself decides
  which actor runs next (`next_turn`); a fresh flag only replaces that
  role's conversation, and the engine refuses invalid combinations.
- `sparring show-config --json [--stage-provider …] [--sparring-model …]`
  reports the configuration a role would resolve to; use it for the
  confirmation text.
- Stage `state.json`: `sessions: {role: [{generation, session_id, agent:
  {provider, model, effort, …}, started_at, start_reason, ended_at,
  end_reason}]}` and `next_turn`. Plan-run state
  `.sparring/plans/<run>.json`: optional `provider_pause: {kind:
  "session-unresumable" | "provider-unavailable", role: "stage" |
  "sparring", stage_id, has_session, recorded_at}`. Descriptive only.

### Required behaviour

- `src/core/cli.ts`: extend the resume-plan invocation/builder with the
  fresh flags, reason and role-scoped overrides, emitted only when set.
- `src/core` engine formats: parse `sessions`, `next_turn` and
  `provider_pause` tolerantly (absent on older engines → feature hidden, no
  error).
- Overview, for the active plan run when it is paused (not running, not
  accepted/complete): actions "Start fresh reviewer…" and "Start fresh
  implementation agent…". Hidden while a process is running or the stage is
  accepted.
- Each action: quick pick "Use current preference (<provider> · <model> ·
  <effort>)" or "Choose another model/provider…" (reuse the existing model
  choice source, `model-choices` / configProbe), then a modal confirmation
  stating plainly: "Same stage and candidate", "New reviewer conversation"
  (or implementation-agent conversation), "Previous review history
  preserved", "Model: …", "Effort: …", and the provider. On confirm, launch
  `resume-plan` through the existing launch path with the flags. Cancel does
  nothing.
- When `provider_pause` is present for the current stage, show a card:
  `kind = session-unresumable`: "Reviewer session cannot be resumed" (or
  "Implementation-agent session cannot be resumed") / "The candidate is safe
  and unchanged." with [Start fresh reviewer] (role-matched) and [Details]
  (opens the run log / engine output already available). `kind =
  provider-unavailable`: "Provider unavailable (quota / rate limit)" with
  [Retry] (plain resume-plan) and [Start fresh … on another provider].
  `has_session: false` → do not offer "fresh", only Retry.
- Actor cards: show the current session generation number when > 1 (e.g.
  "generation 2 · fresh: <reason>") from `sessions`.
- Never write `.sparring` files for this feature; never infer pause reasons
  from activity, stdout or prose; never pick a turn or pass `--next-turn`.

### Tests

Using existing fixtures (`src/test/fixtures.ts`, overview model tests):
- builder emits exactly the flags given (fresh sparrer, fresh stage agent,
  overrides, reason) and nothing when unset;
- actions present only for a paused active run; absent while running,
  accepted, or on an older engine without `sessions`;
- confirmation text contains same stage/candidate, new conversation,
  history preserved, model, effort;
- `provider_pause` cards for both kinds and both roles, `has_session:
  false` hides fresh;
- generation label on actor cards;
- no `.sparring` writes in the new code paths.

Run `npm run typecheck`, `npm run lint` and `npm test`.
