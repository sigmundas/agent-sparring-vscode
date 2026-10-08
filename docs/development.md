# Development and validation

[Documentation index](README.md) · [Extension overview](../README.md)

## Develop

Run these commands from the repository root.

```sh
npm install
npm run build      # typecheck + esbuild bundle to dist/
npm test           # node:test unit tests against fake .sparring fixtures
npm run lint
npm run test:integration   # downloads VS Code once, opens a generated multi-root workspace, asserts discovery, runner lifecycle, bare-`sparring` resolution by the shell, command-not-found, Accept stage and plan association with a fake `sparring`; then opens an empty repository and asserts that invoking a command activates the extension; then opens a real Git repository whose run lives in a sibling worktree and asserts, against a fake engine, its discovery, the Run Plan workspace choice (`--managed --target-branch` vs `--expected-branch`) and Merge & clean up's dry run → confirm → `finish-run` path, including that cancelling issues nothing
npm run test:smoke         # the empty-repository activation check alone, at the declared minimum (VS Code 1.93.1) and at the current stable release
```

**Supported VS Code.** `engines.vscode` is `^1.93.0`: the terminal shell
execution events used during activation do not exist before 1.93. The
`@types/vscode` devDependency is pinned to the same minor (`~1.93.0`) so the
typechecker rejects any stable API newer than the declared minimum; a newer
API may only be used behind a runtime version check (the Overview tab's theme
icon is one). The manifest declares no proposed API, so the standard VSIX
is eligible for the Marketplace and every integration runner launches it
without `--enable-proposed-api`. Set `AGENT_SPARRING_VSCODE_VERSION` to an
exact release or `stable` to run `out/integration/runFreshWorkspace.js` on
another build.

**Activation.** `activationEvents` lists `workspaceContains:` patterns and
`onView:agentSparring.runs`, so existing Agent Sparring state or opening the
Runs view activates the extension. Commands also activate it in a brand-new
repository: VS Code (1.74 and later; `engines.vscode` requires 1.93) activates
an extension when one of its
`contributes.commands` is invoked. `src/integration/freshWorkspaceSuite.ts`
checks exactly that, so no redundant `onCommand:` events are declared.

Press F5 in VS Code to launch an Extension Development Host.

### Keeping the manifest contract in step with the engine

`src/core/manifest.ts` reimplements the engine's `parse_manifest` and
`manifest_digest` in TypeScript, because the digest it produces is compared
against the `plan_digest` the engine recorded for a run. The two are therefore
one contract with two authors, and a divergence is silent and expensive: it
either refuses a run's real manifest — costing that run its stage list, its
journey and the membership of every stage it executed — or accepts one the
engine never ran.

So the engine is the oracle, and it is asked rather than read. The inputs are
in `src/test/manifestVectors.ts`, what a live engine answered for them is
generated into `src/test/manifestParityPins.ts`, and
`src/test/manifestParity.test.ts` checks both directions:

```sh
npm test                                  # the TypeScript side against the pins — no Python needed

# and the pins themselves against a live engine:
AGENT_SPARRING_SRC=../agent-sparring/src PYTHON=/path/to/venv/bin/python3 \
  npm run test:parity
```

When the engine's manifest contract changes on purpose, regenerate the pins and
review the diff — that diff *is* the review of the change:

```sh
npm run compile-tests
AGENT_SPARRING_SRC=../agent-sparring/src PYTHON=/path/to/venv/bin/python3 \
  node scripts/generate-manifest-pins.js
```

Three divergences this found, none of them visible by reading the two
implementations side by side: Python's `str.strip()` removes U+0085 and
U+001C–U+001F while JavaScript's `trim()` does not, and `trim()` removes U+FEFF
while `str.strip()` does not; `version != 1` in Python accepts `true`, because
`True == 1`; and `str.encode("utf-8")` raises on an unpaired surrogate where
Node substitutes U+FFFD, so the extension used to hand a confident digest to a
manifest the engine cannot digest at all.

### What the integration harness cannot test

VS Code run under `--extensionTestsPath` keeps its storage **in memory**. With
a shared `--user-data-dir` across two launches the same workspace-storage
directory is created (`User/workspaceStorage/<hash>/`) and no `state.vscdb` is
ever written to it — not after a settling delay, and not after a graceful
`workbench.action.quit`. A second window therefore always starts with an empty
store, so no assertion here can show that a value written in one window is read
back in the next: it would be testing the harness.

Anything kept in `workspaceState` — plan associations, stage-mode and
sibling-repository declarations, the pin, manual check drafts — is therefore
verified two ways instead, and neither claims VS Code's own durability:

- the stored values are taken out and used to rebuild the result from cold,
  through the same readers and builders production uses, so a stored shape that
  was missing or ambiguous would fail (`declarations` in the integration
  suite);
- every accessor reads the Memento on the call and holds no in-process copy, so
  whatever VS Code restores is what the extension uses. That is asserted
  against the source.

A real reload remains a manual check; see [Manual verification](runners.md#manual-verification).

### Known follow-ups

Recorded rather than fixed, so they are visible without being smuggled into an
unrelated change:

- **A file cache keyed on size and mtime can serve a stale parse** if a file's
  contents are replaced while both are preserved (`src/vscode/fileHead.ts`).
- **Symlink aliases** are resolved for repository roots (`RealPaths`) but not
  everywhere a path is compared; `/tmp` and `/private/tmp` on macOS are the
  usual way to meet this.
- **`repositoryOwning` ranks candidate roots by string length** rather than by
  path depth, unlike `repositoryForFile` and `repositoryOfPath`, which were
  corrected to count segments.
- **Case sensitivity is assumed per platform, not per volume**
  (`canonicalPath`): a case-sensitive volume on macOS is treated as
  case-insensitive.
