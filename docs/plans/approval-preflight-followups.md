# Follow-ups: intake approval preflight and intake labelling

Status: proposed, not started. Recorded 2026-10-12 after a Sporely plan's
Stage 4 was offered **Approve** in the intake screen and then refused by
`approve-plan` ("report.md is not the report this intake renders"). The engine
cause is being fixed separately in agent-sparring (recorded
`findings_version`); these UI changes are independent of that fix.

## 1. Preflight approval against the current engine

`intakeNextAction` (`src/core/intake.ts`) offers Approve from what
`intake.json` recorded at prepare time: no blocking findings, slice not yet
approved, recorded `approvable`. It never asks the installed engine whether
the intake still approves, so engine drift (or any other approval refusal)
first surfaces only after the person has selected sibling repositories and
clicked Approve.

Change: before presenting a slice as approvable, run a read-only engine
preflight (an `approve-plan --check` that calls the engine's existing
`build_approval`, which already performs every approval check without
writing) and show a refusal as the existing `unapprovable` state with the
engine's sentence. Keep the engine the only judge; do not re-implement its
checks in the extension. Requires the engine to expose the `--check` flag.

## 2. Do not call an intake historical because a newer one exists

A newer intake of the same plan is not a replacement for an older one when
it is blocked, cannot interpret the plan, or uses different run slices. The
intake that owns approved or completed runs (`runs/<slice>/approval.json`)
is the one later slices must be approved from. Only label an intake
superseded when a newer intake is approvable and the older one owns no
approved or completed runs; otherwise show which intake owns the plan's runs.
