# Prepare Agent Sparring for colleague sharing

Primary repository: `agent-sparring-vscode`. This is a proposed implementation
plan, not approval to start a run, install an extension or publish a release.
This plan stands alone: native Windows work is deferred to a future contributor
and does not block sharing with macOS/Linux colleagues. Optional future plans
are `windows-extension.md` and the engine's
`../agent-sparring/docs/plans/windows-compatibility.md`.

Review baseline (2026-10-07): extension `49f76e8`; engine `49d2e45`.
Typecheck, lint, 1,448 extension tests and live manifest parity passed.
The VSIX packages successfully but includes development-only files.

### Execute the sharing plan

Run this three-stage plan from `agent-sparring-vscode`; no engine changes are
required. Commit the plan and start on a clean feature branch. Validate with
`sparring check-plan <plan-path>`, then use VS Code Run Plan or
`sparring start-plan <plan-path> --expected-branch <feature-branch> --json`.
The latter is a preflight, not a run: review its output and use its returned
confirmation command only when ready. Confirm push permission separately when
the engine asks. Starting a plan does not authorize publishing or the live
provider/manual checks called out below. Rough developer effort for sharing
cleanup is 1–2 days, subject to the minimum-version host tests.

Windows plans are retained as an optional contribution handoff, not part of
this run or its acceptance criteria. A future contributor should run the engine
plan in the engine first, then the extension plan here; each run has one primary
repository. The rough native Windows estimate is 1–2 developer weeks including
testing, not a commitment for the initial sharing effort.

## Stage 1 — Declare the supported VS Code API and stable distribution

**Repository:** `agent-sparring-vscode`. **Depends on:** none.

**Goal:** colleagues can install a stable extension whose declared minimum
matches the APIs it calls, and whose manifest allows ordinary Marketplace
publishing later.

**Scope:** `package.json`, `package-lock.json`, `src/vscode/agentSessionsAdapter.ts`,
`src/integration/runWorktreeRuns.ts`, `src/integration/worktreeRunsSuite.ts`,
relevant tests and the matching README sections. Inspect
`src/vscode/terminalPool.ts`, `operationRegistry.ts`, `executionTracker.ts` and
`shellIntegration.ts` only for their API requirements.

- Raise `engines.vscode` to at least 1.93: shell execution events used during
  activation are absent from 1.90 and present in 1.93. Audit other unguarded
  stable API calls before choosing the final minimum.
- Align the VS Code type dependency with that minimum so the latest resolved
  `@types/vscode` cannot silently authorize newer APIs. Update the lockfile
  only for this dependency change, using the installed tooling.
- Remove `enabledApiProposals` and the proposed `contributes.chatSessions`
  contribution from the standard distribution. Preserve the Runs view and
  Overview. Remove or clearly retire the now-inert experimental setting and
  adapter; do not leave an advertised feature that cannot work.
- If retaining an experimental distribution is worthwhile, make it an explicit
  separate build with its own verification. Otherwise remove the experimental
  integration expectations. The standard harness must exercise the standard
  manifest without `--enable-proposed-api`.
- Add a way to run the fresh-workspace activation smoke test at the declared
  minimum and the current stable VS Code release; keep fixtures isolated.

**Acceptance criteria:** standard manifest contains no proposed API dependency;
fresh-workspace activation and Runs/Overview registration succeed at the
declared minimum and current stable release. Normal VSIX packaging passes.
Marketplace eligibility is checked locally; nothing is published. Required
checks: `npm run typecheck`, `npm run compile-tests`, relevant actual test files,
`npm run lint`, and the applicable extension-host tests. Record any unavailable
host/version coverage rather than claiming it passed.

**Non-goals:** change engine state semantics, launch providers, alter acceptance,
install the extension into the user's editor, obtain publisher credentials or
publish. Preserve unrelated changes and use each repository's AGENTS.md.

## Stage 2 — Package only the extension's distributable files

**Repository:** `agent-sparring-vscode`. **Depends on:** Stage 1.

**Goal:** a colleague's VSIX contains the runtime and user documentation,
without this project's plans, agent instructions or `.sparring` configuration.

**Scope:** `.vscodeignore`, packaging scripts in `package.json` if necessary,
and a focused packaging validation script under `scripts/` if useful.

- Exclude `.sparring/**`, `docs/plans/**`, `AGENTS.md`, `CLAUDE.md`,
  `install-extension.sh` and design-only icon sources from the VSIX. Prefer a
  small explicit distribution set if supported by the existing packaging tool.
- Keep the bundle, runtime icons, package manifest, README and MIT license.
  Do not delete development files from Git to fix packaging.
- Check `vsce ls --no-dependencies`, build a VSIX outside the repository, and
  inspect its archive contents. Make absence of development/workflow files
  mechanically checkable so future plans or local state cannot leak into it.

**Acceptance criteria:** `npm run package:vsix -- --out <temporary-vsix>` passes;
the archive has everything referenced by the standard manifest and no workflow
state, plans, source maps, instructions or local installation script. Runtime
icons and license are present. Document the inspected file set. Run
`git diff --check`; use typecheck/lint if executable validation code changes.

**Non-goals:** install, push or publish as validation; modify the engine;
remove the development workflow from this repository. Preserve unrelated edits
and follow AGENTS.md. Keep packaging verification independent of live plans.

## Stage 3 — Give colleagues a generic first-run guide

**Repository:** `agent-sparring-vscode`. **Depends on:** Stages 1 and 2.

**Goal:** a new colleague can distinguish requirements, supported environments
and optional planning tools before attempting their first run.

**Scope:** README first-run, settings, executable resolution, installation,
platform and example sections; narrowly relevant source comments and test
fixture labels. Engine documentation is read-only in this stage.

- State the verified VS Code minimum, Python 3.11+, engine installation,
  authenticated Claude/Codex defaults, per-project setup and the requirement
  for a writable intended Git remote. Explain that acceptance requires the
  reviewed commit to be available on that remote and pushing needs permission.
- Document local VSIX installation with the actual generated filename and
  no hardcoded developer path. Explain that the extension does not include
  the engine or provider CLIs.
- Label native Windows unsupported in the current release, with a port left
  for future contribution. Describe WSL/Remote WSL only as a separate route needing its own
  verification, with engine and providers installed inside WSL.
- State that Make Plan with Codex currently reads the planning skill from the
  installed Claude Code plugin, and Make Plan resolves provider executables
  from the extension host's PATH. Give setup steps and a manual-plan fallback;
  do not turn this documentation stage into a planning-provider redesign.
- Replace Sporely names in user-facing examples with neutral repository names.
  Clean up source-comment examples where useful without changing behavior or
  rewriting regression fixtures solely for cosmetic consistency.
- Check the reported product behavior against code. Project-specific test
  commands and conventions remain consuming-project config/context; the
  optional Supabase migration parser is not a dependency for ordinary runs.

**Acceptance criteria:** a short first-run path lists required versus optional
components, Git/push behavior and honest platform support; examples require no
Sporely knowledge. All links and commands are checked against current files.
Documentation-only changes require diff inspection and `git diff --check`,
not another broad test run. Hand off any engine documentation changes to its
Windows plan instead of editing the sibling here.

**Non-goals:** native Windows implementation, live provider validation,
publishing or installation. No changes to engine-owned workflow state.
