# Authoritative run status and human recovery UX (VS Code)

**Status:** Draft for review (2026-10-10). Not approved; not started.
**Repository:** `agent-sparring-vscode` only. The engine contracts it consumes
are defined by the engine plan `agent-sparring:docs/plans/flexible-human-workflow.md`
(planning branch `plan/flexible-human-workflow`).

## Why (audit summary, 2026-10-10)

During the public-explorer-performance run the engine knew, from its own
artifacts, that Stage 1 was in the stage agent's turn. The cockpit still
showed `Working?`, a *Run status unknown* warning, and a failure banner from an
evidence submission that had already been recovered. Three separate causes:

1. **Liveness was not proven, so the workflow fact was hedged.** The runner
   was a hand-typed `resume-plan --run-key … --repo-root <source checkout>`.
   Its run lives in an engine-created worktree, so path attribution of the
   `ps` probe cannot match it. The fix on `fix/probe-managed-runner-by-run-key`
   (`cd863e3`, unmerged) matches `--run-key` instead, but the installed
   bundle predates it. Even with it, the
   overview builds the **main** label from liveness (`Working` only when the
   execution is proven alive, `Working?` when the source is telemetry, `Run
   status unknown` otherwise; `overviewModel.ts` ~1650–1765, `overviewHtml.ts`
   ~1800–1830). So any liveness uncertainty rewrites the workflow headline.
2. **Liveness has no engine source.** Only the extension's own executions and
   a `ps` parse exist. The engine plan's Stage 1 adds a `runner` state
   (`live | absent | unknown`) from a run-scoped kernel lock.
3. **Failure banners clear only on exact-text landing.** A submission failure
   is suppressed only if `notes.md` contains the submitted text verbatim
   (`overviewModel.ts:2470`). A recovery run by hand with re-worded evidence
   never matches, and there is one record per stage scope with no history
   (`submission.ts`).

## Prerequisite (outside this plan)

Review and merge `fix/probe-managed-runner-by-run-key` (`cd863e3`, run-key
attribution in `runnerProcesses.ts`, `executionTracker.ts`, test case 6b in
`killedRunnerRecovery.test.ts`) into `main` before Stage 1 starts, and
install a build containing it. It is small, already tested, and fixes the most
common false "unknown". This plan builds on it and does not redo it.
Limitations it leaves stay in scope here:
- `ps`-based attribution only;
- no Windows probe;
- a runner started without `--run-key` and with a source-checkout
  `--repo-root` stays unattributable;
- liveness still drives the headline.

## Stage 1 — Workflow state is the headline; runner liveness is a separate fact

**Outcome:** The main status always states the engine's authoritative workflow
position, in plain words. Runner liveness is shown as its own secondary fact.
Uncertain liveness never rewrites or question-marks the workflow headline.

**Hard constraints**
- Headline vocabulary, derived only from engine artifacts:
  - **Implementing** (stage agent's turn);
  - **Reviewing** (sparrer's turn, including the evidence turn);
  - **Waiting for you** (recorded NEEDS_YOU or a typed `awaiting`);
  - **Paused** (run paused, or ESCALATE);
  - **Complete**;
  - **Accepting**.

  The artifacts: run `status`, `current_stage`, stage `status` and
  `next_turn`, `## Routing outcome`, `evidence_pending`, `awaiting`. Docs:
  `docs/state.md` *Source-of-truth rule*. `Working?` and `Sparring?` are
  removed.
- Runner liveness stays `running | stopped | unknown`, from the existing
  sources in `docs/runners.md`. It is shown as one secondary line, for example
  *Runner: running · last activity 2 min ago*, with source and detail under
  **Technical details**. "Last activity" comes from `activity.jsonl`
  timestamps already read by `liveState.ts`.
- Warnings appear only on positive evidence:
  - a runner observed ended (non-zero exit, terminal closed, probe no longer
    finds it) while the workflow says an agent turn is active →
    *Runner stopped* with **Resume**;
  - a turn with no activity beyond the existing stale threshold → a stale
    warning.

  `unknown` alone produces no warning in the main status.
- **The guard is preserved.** While liveness is `unknown` and the workflow
  says an agent turn is active, mutating actions (Run/Resume, evidence
  submission) stay withheld or modal-confirmed exactly as today. Only the
  wording moves: the reason appears beside the withheld action and in
  Technical details, not as the headline. Telemetry is never promoted to
  *runner running*.
- Status bar and actor cards follow the same split.

**Starting points:** `src/core/overviewModel.ts` (busyState, `uncertain`,
actorCard, activityLine), `src/core/overviewHtml.ts`, `src/core/liveState.ts`
(`deriveLiveness`). Tests: `runStatusWords.test.ts`, `actorCards.test.ts`,
`liveness.test.ts`, `unknownRunnerRecovery.test.ts`,
`killedRunnerRecovery.test.ts`, and the integration suite's *Run status
unknown* case.

**Prerequisite:** run-key attribution of managed runners (`cd863e3`,
`probeRunnerProcesses(…, runId)`) is on `main`. If it is not, stop and say so.
Do not reimplement it.

**Boundaries / non-goals:** no new engine calls and no new liveness source
(Stage 3). No change to which actions the guard withholds.

**Acceptance evidence**
- A table-driven test maps every combination of workflow position × liveness
  (`running/stopped/unknown`) × activity age to headline, secondary line,
  warning and offered actions. The public-explorer case (stage agent's turn,
  liveness unknown, fresh activity) yields **Implementing**, *Runner: not
  confirmed · last activity N min ago*, no warning, and the guard still
  active.
- No rendered string contains `Working?` or `Sparring?`.
- A crashed runner (ended execution, turn still open) still produces
  *Runner stopped* plus Resume.
- `docs/state.md` and `docs/runners.md` *What the UI shows* are updated.
- Run `npm run typecheck`, `npm test` and `npm run lint`.

**Handoff:** the derivation function's name and its table of states, recorded
in `docs/state.md`.

## Stage 2 — Operation failures are resolved by later state, kept as history

**Outcome:** An operation-failure banner disappears once later engine state
shows the failure has been overtaken. The failure stays visible in a history
under Technical details, so it is never lost.

**Hard constraints**
- A failure is **superseded** (banner hidden, history kept) when the engine's
  own artifacts show progress past it. Any of these counts:
  - the gate instance it answered now has recorded evidence (any entry for
    that instance, not only identical text);
  - `evidence_pending` was set or consumed after it;
  - a newer verdict was recorded;
  - the stage or run advanced;
  - a later operation of the same kind for the same run and stage exited 0.

  The decision rests only on structured engine state and recorded exit codes,
  never on prose similarity beyond the existing gate-id matching.
- Drafts keep today's rule: they clear only on exit 0 of the submission that
  carried them. A superseded failure does **not** discard unsent drafts.
  Instead the drafts are offered as *not sent* if they differ from what
  landed.
- History: failures are retained per run and stage (bounded, newest first)
  with operation, time, exit code or reason, and what superseded them.
  Existing `workspaceState` records migrate without loss.
- Diagnostics: a failure that is *not* superseded keeps the engine's own
  output and a specific next action (for example *the candidate changed since
  the check was raised; see what changed*). A generic "failed" alone is not
  enough.

**Starting points:** `src/core/submission.ts`
(`withSubmissionFailure`/`withoutSubmission`), `src/vscode/controller.ts`
(~1340–1375), `src/core/overviewModel.ts` (~2450–2515). Tests:
`submissionSurvivesFailure.test.ts`, `evidenceHandoffRecovery.test.ts`,
`operationLifecycle.test.ts`.

**Boundaries / non-goals:** no engine changes. No new recovery actions
(Stage 4).

**Acceptance evidence**
- The public-explorer replay as a test: a submission fails on candidate
  drift → recovery by hand with different evidence text for the same gate
  instance → the banner is gone, history shows the failure as superseded by
  recorded evidence, and the original drafts are offered as not sent.
- Other supersession paths are covered: newer verdict, stage advance, and a
  same-kind success.
- A genuine unrecovered failure stays visible.
- Migration test for existing records.

## Stage 3 — Engine runner state and deviation report as sources

**Prerequisite:** engine plan Stages 1–2 merged (`runner` in `runs --json`,
`sparring run-status --json` with `deviations`).

**Outcome:** The extension uses the engine's runner state as its most exact
liveness source, for any run, however it was started. When a paused run cannot
continue, the overview presents the engine's deviation report (what changed,
why it matters, risk, offered actions) instead of a raw refusal.

**Hard constraints**
- Liveness precedence:
  1. the extension's own execution (exact);
  2. engine `runner.state`;
  3. `ps` probe;
  4. unknown.

  Engine `absent` is positive evidence of no runner. `live` is positive
  evidence of a runner even when the extension did not launch it. That clears
  the `unknown` guard for hand-started and outside-VS-Code runners. An engine
  without the field, or with a schema version the extension does not know,
  falls back to today's sources, and the version mismatch is reported as it
  is for `runs --json` today.
- The deviation report is rendered from the engine's JSON only:
  - **invariant** → explanation, no action;
  - **recoverable** → explanation, evidence (paths, commits, diff stat) and
    each offered action;
  - **warning** → Technical details only.

  The extension never computes deviations itself and never edits engine
  state. Actions execute only in Stage 4.
- Polling cost stays bounded: reuse the existing refresh cadence, with no
  per-second engine calls.

**Starting points:** `src/core/engineFormats.ts`, `src/core/cli.ts`,
`src/vscode/executionTracker.ts` (probe), `src/core/liveState.ts`. Use fake
engine fixtures for tests. `test:parity` is for contract parity against the
real engine output.

**Acceptance evidence**
- An externally started runner is shown as *Runner: running* through engine
  state, with no `ps` match needed. Engine `absent` with an open turn shows
  *Runner stopped*.
- A missing field or unknown version falls back to today's sources.
- Rendering tests cover each deviation class from fixtures captured from the
  engine's tests.
- A parity check runs against the engine's documented JSON.

## Stage 4 — Record without continuing, and authorized recovery actions

**Prerequisite:** engine plan Stages 3–5 merged (record-only evidence, token-
authorized prerequisite advance and evidence amendment).

**Outcome:** In the human-check panel, a person can **Save results** (record
without continuing) separately from **Continue run**. They can see that
results are recorded but not yet reviewed. They can authorize an offered
recovery action after seeing exactly what it will do.

**Hard constraints**
- **Save results** runs the engine's record-only command with a submission
  id. Repeating it is safe. Success is exit 0 plus the engine's JSON, and
  drafts clear on that alone. **Continue run** runs `resume-plan`. The two are
  never combined behind one button. The existing **Submit result and
  continue** remains as an explicit combined action.
- Recovery actions show the engine's preview (changed paths, diff, commits,
  effect) before confirmation. Confirming sends the engine's token unchanged.
  Rejection because the repository changed since preview returns to a fresh
  preview. An evidence amendment lists exactly the paths that will be
  committed and states that the reviewer will review the amended candidate.
- Every action is offered only from the engine's report. Under a running or
  unknown runner, mutating actions are withheld (Stage 1's guard). No Git
  operation is performed by the extension.
- Free text (evidence, notes) never passes through a shell. Follow the
  existing *Free-text arguments never go through a shell* rule.

**Acceptance evidence**
- Fake-engine journey tests:
  - Case 2: save now, no agent started, continue later → reviewer first;
  - Case 1: save, amendment preview, confirm, continue;
  - Case 3: prerequisite advance preview, confirm, continue;
  - a stale token → re-preview;
  - a live runner → actions withheld.
- `docs/state.md` source-of-truth rows are updated for the new buttons and
  panels. `docs/runners.md` is updated. The integration suite is extended.
- Run `npm test`, `npm run lint` and `npm run test:integration`.
