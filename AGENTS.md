# Agent instructions

This repository is the VS Code client for the sibling `agent-sparring` engine.
The engine owns workflow state, routing, candidate verification and acceptance;
the extension observes, presents and invokes it. Keep that boundary intact.

## Read only what the task needs

- Start with `git status --short`; preserve unrelated edits. For a review,
  identify the requested base/candidate and inspect diff stat, names, then
  targeted diffs, including staged/untracked work for a working-tree review.
- Search symbols with scoped `rg -n`, then read bounded definitions/callers.
  Narrow truncated output. Do not read the entire README, `controller.ts`,
  `commands.ts`, overview renderer, logs or generated bundles for orientation.
- Use README headings as an index to the behavior under investigation. Read
  `Source-of-truth rule` when changing what a displayed state means, and the
  relevant runner section for process/lifecycle changes.
- Cross into the engine only for a concrete protocol/ownership question, after
  reading its `AGENTS.md`. Do not search the parent workspace or other worktrees.
- Reuse findings within the session. Keep delegated questions narrow and
  independent; do not run concurrent implementation writers in this worktree.

## Navigation by task

| Area | Starting points |
| --- | --- |
| Activation / command registration | `src/extension.ts`, `src/vscode/commands.ts` |
| Selection / refresh / orchestration | `src/vscode/controller.ts`, `src/core/activeRepository.ts`, `src/core/discovery.ts` |
| Overview presentation | `src/core/overviewModel.ts`, `src/core/overviewHtml.ts`, `src/vscode/overview/overviewPanel.ts` |
| Processes / terminals | `src/core/runner.ts`, `src/core/submission.ts`, `src/vscode/commandRunner.ts`, `src/vscode/executionTracker.ts`, `src/vscode/terminalPool.ts` |
| Engine formats / manifest | `src/core/engineFormats.ts`, `src/core/manifest.ts`, `src/core/cli.ts` |
| Human evidence / copied review | `src/core/humanChecks.ts`, `src/core/humanTask.ts`, `src/core/reviewCopy.ts` |
| Captured agent instructions | `src/core/promptInspector.ts` |

Start with the relevant row and matching tests in `src/test/`, not every file.
`src/core/` holds testable logic; `src/vscode/` owns editor integration.

## Boundaries to preserve

- Do not infer acceptance or human-gate results from prose, activity or UI state.
  Use the engine's structured artifacts and commands. Do not directly rewrite
  engine-owned state to make a UI action succeed.
- Keep repository, worktree, plan, stage and process identity scoped correctly
  across refresh/reload. UI liveness is not acceptance authority.
- Preserve the distinction between captured provider prompts and review context.
  Read the relevant README contract before changing either export.
- Do not launch providers, resume live user plans, kill user processes, install
  the extension, push or publish as incidental validation. Use fake engine
  fixtures unless the task authorizes a live operation.

## Validation and handoff

Use installed dependencies; do not reinstall them as a routine first step.
Run from this repository root:

- TypeScript changes: `npm run typecheck`, then `npm run compile-tests` and
  `node --test out/test/<affected>.test.js` using actual affected test names.
- Shared command, lifecycle or format changes: broaden to `npm test` and
  `npm run lint` as relevant. The Sporely app's npm-test restriction does not
  apply to this separate repository.
- Manifest/protocol changes: read README's `Keeping the manifest contract in
  step with the engine` section and run the applicable parity checks. Do not
  regenerate pins just to silence a mismatch.
- Use `npm run test:integration` when an extension-host change needs that
  coverage; it may download VS Code and launch a test host. Check the README's
  harness limitations before claiming real interactive behavior is verified.
- Bundle/package only when needed for the requested result. Documentation-only
  edits need diff inspection and `git diff --check`, not a build/test run.

Report what changed, validation and limitations concisely. Do not rerun passed
broad suites without new changes/evidence. Managed stages use their assigned
role-specific response format and stop at their scope boundary.

## Git policy

Agents may create branches, commit, push, merge, and delete branches as needed
to complete the task.

Use normal Git workflows and keep history understandable.

Do not:

- force-push unless the user explicitly asks for it;
- rewrite published history unnecessarily;
- push secrets or credentials;
- merge obviously unrelated work;
- publish an extension/release or modify production systems unless the task
  explicitly includes that.

For staged/agent-sparring work:

- commit and push completed stage work;
- merge when the stage or plan calls for it;
- leave a clear handoff describing what changed, what was tested, and any
  unresolved issues.

This is about ordinary Git workflow, and does not loosen the rule above in
`Boundaries to preserve`: pushing or publishing must never happen merely as
incidental validation of a change.
