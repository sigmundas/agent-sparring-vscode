# Fresh agent sessions: Stage 4 (VS Code) — skills, README, test gaps

Repository: `agent-sparring-vscode`. Status: approved. VS Code half of
Stage 4 of `agent-sparring/docs/plans/fresh-agent-session.md`. Baseline:
accepted `d128d76`. Engine contract: `agent-sparring`
`feature/fresh-agent-session` at `ffcfb6d` or later (read-only reference).

## Stage 1 — Fresh-session skills, README and review leftovers

### Documentation

- `skills/sparring-run/SKILL.md` (and `sparring-plan` / `sparring-setup`
  only where they describe resume or recovery): explain fresh-session resume
  versus ordinary resume versus reset-stage; when to use `--fresh-sparrer` /
  `--fresh-stage-agent`; that the engine decides whose turn it is and that
  `--next-turn` is only for ambiguous legacy state the engine refused to
  derive; recovery from `session-unresumable` and `provider-unavailable`
  pauses. No instruction may tell an agent to edit `.sparring` state.
- README: the Overview "Start fresh reviewer… / Start fresh implementation
  agent…" actions and the pause cards, under the existing Overview section,
  including the source-of-truth note that cards come from the engine's
  `provider_pause` record.

### Review leftovers

- Gate the provider-pause card on the plan run's structured status being
  paused (not only "not live").
- Add tests: `has_session: false` card (Retry only, no fresh); the
  provider-unavailable "on another provider" label for both roles; a
  malformed `provider_pause` (unknown kind/role, empty `stage_id`) is dropped;
  the card hidden when the run is complete or failed.
- "Choose another model/provider…": offer only providers the engine
  reports as supporting that role (today one per role, so effectively a
  model choice); never offer a provider the engine would refuse. Label the
  quick pick and the provider-unavailable card accordingly, and test it.
- Optional, only if small: an optional reason field in the fresh-session
  flow passed as `--fresh-reason`; otherwise leave it out.

Run `npm run typecheck`, `npm run lint` and `npm test`.
