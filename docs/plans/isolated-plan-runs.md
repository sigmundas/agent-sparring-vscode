# Isolated plan runs and Merge & clean up (VS Code)

Goal: *pick plan → Run → watch → Merge & clean up* without the user creating,
opening, merging or removing Git worktrees. The engine
(`agent-sparring` main at `99e5e70`, sibling checkout `../agent-sparring`; docs: its
`docs/plans.md` "Managed runs" and `docs/reference.md` JSON schemas) now owns
all of it: `run-plan --managed [--target-branch B]`, `resume-plan --run-key K`
from any checkout, `sparring runs --json`, `finish-run --run-key K --dry-run
--json`, `finish-run --run-key K [--merge-only] [--allow-merge-commit]
[--push-target] [--json]`. This extension only presents and invokes.

## Shared rules (every stage reads this section first)

- **No Git surgery in TypeScript.** The extension never creates, removes,
  merges or deletes a worktree or branch, and never decides whether merge or
  cleanup is safe. Eligibility and reasons come only from `finish-run
  --dry-run --json`; worktree ownership only from `sparring runs --json`
  (`git worktree list` alone never makes a worktree the engine's).
- **Vocabulary.** The extension already says "managed run" for every
  engine-driven plan run. The engine's worktree concept is shown to users as
  "Run in its own workspace" / "Ready to merge" / "Merge & clean up"; in code
  use a distinct name (e.g. `isolated`/`IsolatedRun`), not "managed".
  Branch names, worktree paths, base/target SHAs and check codes appear only
  under the existing Technical details/diagnostics disclosure.
- **Identity.** A run's identity is its run key (minted by the extension as
  today) plus its recorded input kind. Resume keeps using the recorded
  manifest/Markdown/intake input (`requireRecordedInputKind`); never
  reconstruct a different invocation. The worktree path comes from the
  engine's record, never from a folder name.
- **Unmanaged runs unchanged.** "Run in this checkout" keeps today's exact
  invocation and behaviour.
- Engine JSON is parsed strictly with schema-version checks, alongside the
  existing formats in `src/core/engineFormats.ts`; an unknown version is
  shown as an engine/extension mismatch, not guessed at.
- This plan itself runs in an engine-created worktree, which starts without
  `node_modules`: run `npm ci` once there before building or testing (it is
  needed setup, not a routine reinstall). Do not install anything else.
- Tests use fake engine fixtures/stubbed CLI output; never a live provider,
  never a real `finish-run`. Validation per `AGENTS.md`: `npm run typecheck`,
  `npm run compile-tests`, affected `node --test out/test/<x>.test.js`, then
  `npm test` and `npm run lint`.

## Stage 1 — Start, follow and resume a run in its own workspace

Read the "Shared rules" section above first (it is in the plan file this
stage was created from; the engine's managed-run docs are in `../agent-sparring/docs`).

1. **Run Plan choice.** The Run Plan flow offers "Run in its own workspace
   (recommended)" and "Run in this checkout". Own workspace builds
   `run-plan … --managed --target-branch <branch checked out where the plan
   was picked>` with the same input, run key, push choice and provider flags
   as today, and no `--expected-branch`. Remember the user's last choice per
   repository; do not ask for a branch or path.
2. **Discovery.** Read `sparring runs --json` (schema v1) for each known
   repository at refresh, with the existing refresh cadence/debounce, and add
   each run's `worktree_path` as a location of that repository even when it
   is outside the workspace, through the existing location/external-worktree
   machinery. Ownership and the run ↔ worktree association come only from
   that output.
3. **Follow.** After launching, the cockpit follows the run by its run key as
   soon as the engine's record lists it; no folder needs to be opened.
   "Runs…" lists isolated runs with the others.
4. **Resume.** An isolated run resumes with `resume-plan --run-key K` and the
   recorded input, `--repo-root` the repository's primary checkout, and no
   `--expected-branch` (the engine reads it from the record). A manifest-backed
   isolated run must resume as a manifest run.
5. **Status words.** Running / Paused / Needs you / Complete come from the
   existing engine state, unchanged.

Tests: argument building for both choices; discovery from stubbed `runs --json`
including a worktree outside the workspace and an unmanaged worktree that is
not adopted; resume args for Markdown and manifest isolated runs; restart
(reload) still follows the run by key.

Stop at READY.

## Stage 2 — Merge & clean up

Read the "Shared rules" section above first.

1. For a complete isolated run, the cockpit offers **Merge & clean up**.
   Selecting it runs `finish-run --run-key K --dry-run --json` (read-only,
   not in a terminal), then:
   - **eligible**: a modal confirmation in plain language — what will be
     merged into which branch, fast-forward vs merge commit, which ignored
     files will be deleted (`deleted_ignored_paths`), that the remote branch is
     kept — with "Merge & clean up" and, when the run has a remote, a separate
     "Merge, push <target> & clean up" (`--push-target`). A `merge_commit` mode
     needs its own explicit wording and passes `--allow-merge-commit` only
     when the user chose that.
   - **ineligible**: the reasons, each failing check code mapped to a human
     sentence (unknown codes show the engine's `detail`), and no destructive
     command is issued.
2. The confirmed command runs through the existing tracked command runner
   (liveness, terminal ownership), then the cockpit refreshes from engine
   state. On success it follows the target repository's primary checkout; on
   a partial stop it shows the engine's `stopped_at`/`reason`/`remaining`.
3. "Ready to merge" is shown only from a dry-run result the engine returned
   for the run's current state, never inferred from "complete".

Tests: eligible → confirmation shows the engine's facts and confirming issues
exactly the expected args; ineligible → reasons shown, no command issued;
merge-commit and push variants pass their flags only when chosen; a stopped
finish shows remaining work; a guard test that no Git write command
(`worktree`, `merge`, `branch -d`, `push`) is spawned by the extension.

Stop at READY.

## Stage 3 — Documentation and integration coverage

Read the "Shared rules" section above first.

Update `docs/workflows.md`, `docs/runs.md`, `docs/commands.md`,
`docs/state.md` (which engine artifact supports each new displayed fact) and
the README workflow line to *pick plan → Run → watch → Merge & clean up*,
keeping "Run in this checkout" as the advanced path. Add extension-host
integration coverage where the harness allows (see `docs/development.md` for
its limits) for the Run Plan choice and the Merge & clean up dry-run →
confirm → command path with a fake engine.

Stop at READY.
