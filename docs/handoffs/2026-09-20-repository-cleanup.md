# Repository cleanup — 2026-09-20

A cleanup pass across this repository and the sibling `agent-sparring` engine.
Only the durable outcomes are here; the audit that produced them is not worth
keeping.

## Active branches

| Repository | Branch | State |
| --- | --- | --- |
| engine | `main` | `0720866`, the only branch |
| extension | `main` | `7c64864` |
| extension | `feature/exact-argv-human-submissions` | candidate `407c83a`, reviewed, **not merged** — awaiting a human merge decision |
| extension | `chore/repository-cleanup` | this pass |

Anything else was deleted. A branch is deleted here only after it is proved
redundant: fully merged into `main` with no commits of its own ahead of it.
Deleted this pass, all in that state:

- engine `feature/deferred-human-verification` (`a5e5278`) — `main` is its merge commit;
- extension `feature/deferred-human-verification` (`db00410`);
- extension `feature/evidence-submission-handoff-recovery` (`3485569`) — its
  ANSI-C shell quoting is on `main`, and `feature/exact-argv-human-submissions`
  removes that encoder in favour of never giving free text to a shell at all.

## The integration fixture's argv log

The fake `sparring` truncates its argv record on every call. It used to write
one shared `fake-argv.log`, so:

- a background `show-config --json` probe could overwrite the record of the
  launch a test was asserting on; and
- "the engine never ran" and "the engine really did run" could be answered by
  some entirely different subcommand's call — a spurious failure in the first
  case and a false pass in the second.

`resume-plan` had been given its own log earlier, which fixed only the reported
symptom. Now every subcommand gets `fake-argv-<subcommand>.log`, and each
assertion names the subcommand it means. The name is derived by scanning past
global options rather than reading `$1`, because `--sparring-dir` precedes the
subcommand — and a `--sparring-dir` value containing a subcommand name must not
steal that subcommand's log.

**Do not add a second logging mechanism.** If a new test needs to know whether a
particular engine command ran, read that command's own log.

## Running the integration suite

`npm run test:integration`, from anywhere, including a VS Code integrated
terminal.

It used to fail from inside VS Code with a bare `SyntaxError: Unexpected token
':'`, which looks like a broken workspace fixture and is not: the terminal
exports `ELECTRON_RUN_AS_NODE=1` and `VSCODE_*` into everything it starts, so
the test host ran as plain Node and read the `.code-workspace` argument as a
script. The harness now clears those before launching. If that error ever comes
back, suspect an inherited environment, not the fixture.

## Agent instructions

`AGENTS.md` and `CLAUDE.md` are intentionally tracked in both repositories, and
are deliberately *not* copies of each other: the engine's describe a generic
Python orchestration engine, this repository's describe its VS Code client. This
repository's had been drafted and left untracked in a stash; they are now landed
as drafted, in their own commit.

In the engine they were swept into `3067829`, a deferred-gate commit they had
nothing to do with. History is not being rewritten for it; this note is the
record.

**Open question for a human:** the engine's `AGENTS.md` carries a `Git policy`
section (agents may branch, commit, push, merge, delete; no force-push, no
history rewriting, no secrets, no unrelated merges, no releases). This
repository's has no equivalent, and saying what it should be is a policy
decision, not a cleanup one, so nothing was invented here.

## Stashes

Both are preserved. Neither is needed, and both can be dropped whenever their
owner agrees:

- **extension `stash@{0}`** — "draft extension AGENTS and CLAUDE instructions".
  Fully landed this pass, verified byte-identical to the committed files.
- **engine `stash@{0}`** — a README note saying Agent Sparring follows the active
  editor or Source Control focus because VS Code does not expose the lower-left
  repository selector to extensions. Superseded: this repository's `readme.md`
  documents the same behavior at much greater length, and it is client behavior,
  which the engine's own `AGENTS.md` says does not belong in the engine.
