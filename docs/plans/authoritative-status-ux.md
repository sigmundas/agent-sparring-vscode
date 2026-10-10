# Authoritative run status and human recovery UX (VS Code)

**Status:** Approved direction with decisions (2026-10-10). Not started.
**Repository:** `agent-sparring-vscode` only. Engine contracts come from
`agent-sparring` plans on branch `plan/flexible-human-workflow`:
- `docs/plans/run-ownership-lock.md` (P0): the run ownership lock, and
  `run-status --json` with separate `workflow` and `runner` objects;
- `docs/plans/flexible-human-workflow.md`: deviation report, record-only
  evidence, authorized re-pin and amendment.

**Dependencies by stage**

| Stage | Needs |
| --- | --- |
| 1, 2 | `cd863e3` merged to `main` |
| 3 | run-ownership-lock Stages 1–2 merged in the engine |
| 4 | flexible-human-workflow Stages 1–4 merged in the engine |

Do not install or reload the active extension while a live run is executing
with it, in particular `public-explorer-performance-34ff457f-3a7d53c5`.

## Why (audit summary, 2026-10-10)

During the public-explorer-performance run, the engine's own artifacts showed
Stage 1 in the stage agent's turn. The cockpit still showed `Working?`, a
prominent *Run status unknown* warning, and a failure banner from an evidence
submission that had already been recovered. Three causes:

1. **Liveness drives the headline.**
   - The runner was a hand-typed `resume-plan --run-key … --repo-root <source
     checkout>`, and its run lives in an engine-created worktree. Path
     attribution of the `ps` probe cannot match it.
   - `cd863e3` (unmerged) matches by run key, but the installed bundle
     predates it.
   - Independently, the overview builds the **main** label from liveness
     (`overviewModel.ts` ~1650–1765, `overviewHtml.ts` ~1800–1830). Any
     uncertainty rewrites or question-marks the workflow headline.
2. **No engine source for liveness.** Only the extension's own executions
   and a `ps` parse exist. The engine's P0 plan adds a run-scoped lock and
   `runner.state`.
3. **Failure banners clear only on exact-text landing.**
   - A submission failure is suppressed only if `notes.md` contains the
     submitted text verbatim (`overviewModel.ts:2470`).
   - The recovery was run by hand with re-worded evidence, so the text never
     matched.
   - There is one record per stage scope, and no history.

## Approved decisions (2026-10-10)

- **Remove the misleading indicators.** `Working?`, `Sparring?` and the
  prominent *Run status unknown* indicator go. Uncertain liveness is
  diagnostic information, not a substitute for workflow state.
- **Keep the safety guard for now.** The guard that withholds mutating
  actions under unknown liveness stays until the engine has reliable
  run-level ownership (Stage 3). After that, the indefinite refusal is
  replaced by a guided recovery that checks ownership under the engine's lock.
  Human authorization alone never overrides an active runner.
- **Runner attribution.** `cd863e3` is reviewed and merged independently,
  before this plan. Installing it waits until no live run depends on the
  installed extension.

## Stage 1 — Workflow state is the headline; liveness is a diagnostic fact

**Prerequisite:** run-key attribution of managed runners (`cd863e3`,
`probeRunnerProcesses(…, runId)`) is on `main`. If it is not, stop and say so.
Do not reimplement it.

**Outcome:** The main status always states the engine's authoritative workflow
position, in plain words. Runner liveness is a separate secondary fact.
Uncertain liveness never rewrites, hedges or replaces the headline.

**Hard constraints**
- **Headline vocabulary**, derived only from engine artifacts:
  - **Implementing**: the stage agent's turn.
  - **Reviewing**: the sparrer's turn, including the evidence turn.
  - **Waiting for you**: a recorded NEEDS_YOU, or a typed `awaiting`.
  - **Paused**: the run is paused, or the stage is at ESCALATE.
  - **Complete**.
  - **Accepting**.

  The artifacts are: run `status`, `current_stage`, stage `status` and
  `next_turn`, `## Routing outcome`, `evidence_pending`, `awaiting`. The
  derivation follows the *Source-of-truth rule* in `docs/state.md`.
  `Working?` and `Sparring?` are removed everywhere: overview, actor cards,
  status bar.
- **Liveness line.**
  - Runner liveness stays `running | stopped | unknown`, from the existing
    sources in `docs/runners.md`.
  - It is shown as one secondary line, for example *Runner: running · last
    activity 2 min ago*. *Unknown* is phrased neutrally, as *Runner: not
    confirmed*.
  - The source and its detail sit under **Technical details**.
  - "Last activity" comes from the `activity.jsonl` timestamps that
    `liveState.ts` already reads.
  - *Run status unknown* no longer appears as a headline or banner.
- **Warnings only on positive evidence:**
  - *Runner stopped*, with **Resume**: a runner was observed ending (non-zero
    exit, terminal closed, the probe no longer finds it) while the workflow
    says an agent turn is active;
  - the existing stale warning, for a turn with no activity beyond the
    existing threshold.
- **The guard is unchanged.** Under `unknown` liveness while an agent turn is
  active, mutating actions (Run/Resume, evidence submission) stay withheld,
  exactly as today. That includes today's modal override; Stage 3 removes it.
  Only the wording moves: the reason sits beside the withheld action and in
  Technical details. Telemetry is never promoted to *runner running*.

**Starting points:**
- `src/core/overviewModel.ts`: busyState, `uncertain`, actorCard,
  activityLine;
- `src/core/overviewHtml.ts`;
- `src/core/liveState.ts` (`deriveLiveness`).

Tests: `runStatusWords.test.ts`, `actorCards.test.ts`, `liveness.test.ts`,
`unknownRunnerRecovery.test.ts`, `killedRunnerRecovery.test.ts`, and the
integration suite's *Run status unknown* case.

**Boundaries / non-goals:** no new engine calls or liveness sources. No change
to which actions the guard withholds.

**Acceptance evidence**
- A table-driven test maps workflow position × liveness × activity age to
  headline, secondary line, warning and offered actions.
- The public-explorer case (stage agent's turn, liveness unknown, fresh
  activity) yields:
  - headline **Implementing**;
  - secondary line *Runner: not confirmed · last activity N min ago*;
  - no warning or banner;
  - the guard still active.
- No rendered string contains `Working?` or `Sparring?`. *Run status unknown*
  never appears as a headline.
- A crashed runner still yields *Runner stopped* with **Resume**.
- `docs/state.md` and `docs/runners.md` *What the UI shows* are updated.
- Run `npm run typecheck`, `npm test` and `npm run lint`.

## Stage 2 — Operation failures are resolved by later state, kept as history

**Prerequisite:** none beyond Stage 1.

**Outcome:** An operation-failure banner disappears once later engine state
shows the failure was overtaken. The failure stays in a history under
Technical details.

**Hard constraints**
- **Superseded failures.** A failure is superseded — banner hidden, history
  kept — when engine artifacts show progress past it, through any of:
  - recorded evidence now exists for the gate instance it answered (any entry
    for that instance, not only identical text);
  - `evidence_pending` was set or consumed after it;
  - a newer verdict;
  - the stage or run advanced;
  - a later operation of the same kind, for the same run and stage, exited 0.

  Only structured engine state and recorded exit codes decide this, never
  prose similarity beyond the existing gate-id matching.
- **Drafts.**
  - Drafts still clear only on exit 0 of the submission that carried them.
  - A superseded failure does not discard unsent drafts. They are offered as
    *not sent* if they differ from what landed.
- **History.**
  - Failures are retained per run and stage (bounded, newest first): the
    operation, time, exit code or reason, and what superseded each.
  - Existing `workspaceState` records migrate without loss.
- **Diagnostics.** A failure that has not been superseded keeps the engine's
  own output and gives a specific next step. A generic "failed" alone is not
  enough.

**Starting points:**
- `src/core/submission.ts`;
- `src/vscode/controller.ts` (~1340–1375);
- `src/core/overviewModel.ts` (~2450–2515).

Tests: `submissionSurvivesFailure.test.ts`, `evidenceHandoffRecovery.test.ts`,
`operationLifecycle.test.ts`.

**Boundaries / non-goals:** no engine changes and no recovery actions.

**Acceptance evidence**
- **Public-explorer replay:**
  1. A submission fails on candidate drift.
  2. Recovery is run by hand, with different evidence text for the same gate
     instance.
  3. The banner is gone.
  4. History shows the failure as superseded by the recorded evidence.
  5. The original drafts are offered as *not sent*.
- The other supersession paths each have a test, and a genuine unrecovered
  failure stays visible.
- Existing records migrate without loss (migration test).

## Stage 3 — Engine-authoritative status and guided recovery for unknown liveness

**Prerequisite:** engine run-ownership-lock Stages 1–2 are merged. That
provides the run ownership lock, and `sparring run-status --json` with
separate `workflow` and `runner` objects, plus `runner` in `runs --json`.

**Outcome:**
- The overview's workflow position and runner liveness come from the engine's
  two separate facts, for any run, however it was started.
- The indefinite *withheld under unknown liveness* state is replaced by a
  guided recovery. The engine checks ownership under its lock, and no human
  confirmation can override a live runner.

**Hard constraints**
- **Workflow.** The headline is derived from the engine's `workflow` object
  when available. Stage 1's derivation from artifacts remains as a fallback
  for an engine without the command; the two must agree on fixtures.
- **Liveness precedence**, most exact first:
  1. the extension's own execution;
  2. engine `runner.state`;
  3. the `ps` probe;
  4. unknown.

  Engine `absent` is positive evidence that no runner holds the run. Engine
  `live` is positive evidence that one does, even if the extension did not
  launch it.
- **Engine compatibility.** A missing field, or an unknown schema version,
  falls back to today's sources and is reported as a version mismatch, the way
  `runs --json` mismatches are today.
- **Guided recovery.** When liveness is still not established, the overview
  offers **Check runner**, which asks the engine:
  - `absent` → **Resume** is offered. A race remains safe because the
    engine's resume acquires the lock itself.
  - `live` → the holder is shown in Technical details. No resume or override
    is offered.
  - `unknown` (an unsupported platform or an older engine) → the guard stays,
    with an explanation.
- **No override.** Today's modal "override unknown" confirmation is removed.
  Human authorization alone never overrides an active runner.
- **Bounded polling.** Use the existing refresh cadence; no per-second engine
  calls.

**Starting points:** `src/core/engineFormats.ts`, `src/core/cli.ts`,
`src/vscode/executionTracker.ts`, `src/core/liveState.ts`,
`src/core/overviewModel.ts`. Use fake engine fixtures, and `test:parity`
against the engine's published `run-status` fixture.

**Acceptance evidence**
- An externally started runner is shown as *Runner: running* through engine
  state, with no `ps` match needed.
- Engine `absent` while a turn is open shows *Runner stopped* with **Resume**.
- **Check runner** follows each branch (`absent`, `live`, `unknown`). No code
  path issues a mutating command while the engine reports `live`.
- The modal override and its tests are removed and replaced.
- Fallback when the field or command is absent works, and the parity check
  passes against the engine fixture.
- `docs/state.md` and `docs/runners.md` are updated.

## Stage 4 — Save results, Continue run, and authorized recovery actions

**Prerequisite:** engine flexible-human-workflow Stages 1–4 are merged. They
provide the deviation report, record-only evidence, the token-authorized
prerequisite advance, and the evidence amendment.

**Outcome:**
- In the human-check panel, a person can **Save results** (record without
  continuing) separately from **Continue run**.
- They can see recorded-but-unreviewed evidence as such.
- When a paused run cannot simply continue, they see the engine's
  explanation, and can authorize a specific offered recovery after seeing
  exactly what it will do.

**Hard constraints**
- **Two actions.** **Save results** runs the engine's record-only command
  with a submission id; repeating it is safe. Drafts clear on its exit 0 and
  JSON result. **Continue run** runs `resume-plan`. The two are separate
  buttons. The combined **Submit result and continue** remains only as an
  explicit, separately labelled action.
- **Unverified evidence.** Evidence the engine reports as pending review —
  including evidence recorded while the candidate drifted — is labelled
  *Recorded · awaiting review*, never *verified* or *passed*.
- **Deviation report**, rendered from the engine's JSON only:
  - *invariant* → explanation, no action;
  - *recoverable* → explanation, evidence (paths, commits, diff stat), each
    offered action;
  - *warning* → Technical details.

  The extension never computes deviations itself.
- **Recovery actions.**
  - Each action shows the engine's preview — changed paths, diff, commits,
    effect — before confirmation.
  - Confirming sends the engine's token unchanged. A "changed since preview"
    refusal returns to a fresh preview.
  - An evidence amendment lists exactly the paths it will commit, and states
    that the reviewer will review the amended candidate.
- **Guards.** Actions are offered only while the engine reports `runner:
  absent`. The extension performs no Git operation. Free text never passes
  through a shell (the existing rule).

**Acceptance evidence** — fake-engine journey tests:
- Case 2: save → no agent started → continue later → reviewer first.
- Case 1: save → amendment preview → confirm → continue.
- Case 3: prerequisite-advance preview → confirm → continue.
- A stale token returns to a fresh preview.
- A live runner withholds all actions.
- Evidence recorded during drift is labelled *awaiting review*.

Also: `docs/state.md` source-of-truth rows are updated for every new button
and panel, the integration suite is extended, and `npm test`, `npm run lint`
and `npm run test:integration` are run.
