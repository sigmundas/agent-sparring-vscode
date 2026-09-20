# Repository cleanup — 2026-09-20

A cleanup pass across this repository and the sibling `agent-sparring` engine.
Only the durable outcomes are here; the audit that produced them is not worth
keeping.

## Active branches

Both repositories end this pass with `main` as their only branch.

| Repository | Branch | State |
| --- | --- | --- |
| engine | `main` | `0720866`, the only branch |
| extension | `main` | carries the exact-argv transport work and this cleanup |

A branch is deleted here only after it is proved redundant: fully merged into
`main` with no commits of its own ahead of it. Deleted this pass, all in that
state:

- engine `feature/deferred-human-verification` (`a5e5278`) — `main` is its merge commit;
- extension `feature/deferred-human-verification` (`db00410`);
- extension `feature/evidence-submission-handoff-recovery` (`3485569`) — its
  ANSI-C shell quoting reached `main`, and the exact-argv work then removed that
  encoder in favour of never giving free text to a shell at all;
- extension `feature/exact-argv-human-submissions` (`407c83a`) — reviewed, then
  merged into `main` as `095b9a5` with `--no-ff`. The merge was a fast-forward
  in content: the merged tree is byte-identical to the reviewed candidate, so
  what is on `main` is exactly what was approved;
- extension `chore/repository-cleanup` — this pass.

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

The exact-argv work and this cleanup both touched `src/integration/suite.ts`,
and the two merged without conflict. That was checked rather than assumed: over
the merged `main`, this branch adds only the log renames, no reference to the
old shared `fake-argv.log` or `fake-resume-argv.log` survives anywhere, and the
exact-argv transport assertions read `fake-argv-resume-plan.log` — the log the
fixture writes for that subcommand. No executable code had to be reconciled by
hand.

## Running the integration suite

`npm run test:integration`, from anywhere, including a VS Code integrated
terminal.

It used to fail from inside VS Code with a bare `SyntaxError: Unexpected token
':'`, which looks like a broken workspace fixture and is not: the terminal
exports `ELECTRON_RUN_AS_NODE=1` and `VSCODE_*` into everything it starts, so
the test host ran as plain Node and read the `.code-workspace` argument as a
script. The harness now clears those before launching. If that error ever comes
back, suspect an inherited environment, not the fixture.

Stream the run to a file rather than piping it through `tail`, which buffers
everything until the pipeline ends and makes a hung suite look identical to a
slow one.

**A known flake, not yet fixed.** The Ctrl-C scenario can hang indefinitely.
When a command is handed to a shell, two things race to establish that it
started: the shell's own execution report, and the 5-second process probe. The
probe normally loses. When it wins, the operation is anchored to a pid instead
of to an execution (`advanceToProbedRunning` in `src/vscode/operationRegistry.ts`),
and in that state the run's end was never observed here — the suite sat for
fifteen minutes with the guarded process long gone and nothing logged after
"the operation stays guarded until that process is gone". Every `waitFor` in
that scenario has a 10–20 second deadline and none fired, so whatever does not
return is not one of them.

This predates both branches merged here: the probe path is on `main` from
before either, and re-running the suite passes. If it hangs, re-run it; if it
hangs often, start from the pid-anchored path and what is meant to release it,
not from the fixture.

## Agent instructions

`AGENTS.md` and `CLAUDE.md` are intentionally tracked in both repositories, and
are deliberately *not* copies of each other: the engine's describe a generic
Python orchestration engine, this repository's describe its VS Code client. This
repository's had been drafted and left untracked in a stash; they are now landed
as drafted, in their own commit.

In the engine they were swept into `3067829`, a deferred-gate commit they had
nothing to do with. History is not being rewritten for it; this note is the
record.

This repository's `AGENTS.md` now carries a `Git policy` section too, decided by
its owner rather than inferred here. It says agents may branch, commit, push,
merge and delete, and must not force-push, rewrite published history, push
secrets, merge unrelated work, or publish a release. It ends by naming the rule
it does *not* loosen: the `Boundaries to preserve` prohibition on pushing or
publishing as incidental validation is about proving a change works, which is a
different question from ordinary Git workflow. Both stand.

## Stashes

Both repositories now have none. Each was re-inspected against the committed
tree immediately before being dropped, not judged on its name or age:

- **extension** — "draft extension AGENTS and CLAUDE instructions". Untracked
  content only, and both files proved byte-identical to what this pass
  committed.
- **engine** — a README note saying Agent Sparring follows the active editor or
  Source Control focus because VS Code does not expose the lower-left repository
  selector to extensions. Superseded: this repository's `readme.md` documents the
  same behavior at far greater length, and it is client behavior, which the
  engine's own `AGENTS.md` says does not belong in the engine.

A dropped stash stays reachable by SHA while the reflog keeps it: extension
`fe0ba95`, engine `999b01e`.

## What was run

On the merged branch, with the exact-argv work in: `npm run typecheck` and
`npm run lint` clean, `npm test` 1019 tests with 1 pre-existing skip and no
failures, and `npm run test:integration` exit 0 — run plainly from a VS Code
integrated terminal exporting `ELECTRON_RUN_AS_NODE=1`, which is the case the
harness now defends against. The integration run covers the free-text
transport end to end: an 11554-byte payload reaching the engine as eight
intact arguments with no shell involved.
