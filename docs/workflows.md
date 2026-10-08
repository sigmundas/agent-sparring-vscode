# Workflow reference

[Documentation index](README.md) · [Extension overview](../README.md)

- [What the words mean](#what-the-words-mean)
- [Run in its own workspace, then Merge & clean up](#run-in-its-own-workspace-then-merge--clean-up)
- [Two ways to progress a plan](#two-ways-to-progress-a-plan)
- [When a deferred check fails](#when-a-deferred-check-fails)
- [Push authorization](#push-authorization)

## What the words mean

The Overview and status bar use one plain vocabulary; the engine's own
words stay in tooltips, the metadata footer and the Output Channel.

| Shown | Meaning | Engine state behind it |
| --- | --- | --- |
| **Working** | Implementation or independent review is happening (or a correction turn is running after a finding). | stage `working`; a live turn in `activity.jsonl` |
| **Changes requested** — *The independent reviewer found something to fix. Work will continue automatically.* | The sparrer sent the stage back; the loop continues on its own. | routing action `SEND_BACK` |
| **Needs you** — *the reviewer's request* | Only you can do the next thing. The header pill names it once; one panel — **Manual check required** for a structured gate, **Action required** otherwise — says why the run stopped, what to do, what counts as a pass and how to continue (see [human checks and evidence](state.md#source-of-truth-rule)). Beside the reviewer's checks there is one freeform field, **Additional findings or instructions**, for what you found that is not a result for any of them. | routing action `NEEDS_YOU` |
| **Evidence ready** — *Evidence ready for review* | Same routing action, but every check the reviewer asked for now has a recorded outcome. One primary button — **Submit for review**, or **Submit result and continue** in a managed plan — hands the evidence back to the reviewer. | routing action `NEEDS_YOU` + `## Human evidence` and the outcomes recorded here |
| **Wrong branch** | The checked-out branch is not the one this stage's work belongs to. Nothing that runs the engine is offered, because every loop command passes `--expected-branch` and the engine's own guard would refuse. | `expected_branch` in the plan-run state, or `## Git context` in the stage's `handoff.md`, against the checked-out branch |
| **Escalated** | The reviewer could not settle it; the **Action required** panel carries the report's summary, **Open detailed review** opens `sparring.md`. | routing action `ESCALATE` |
| **Review complete** — *Independent review passed. No unresolved findings remain.* | Primary action **Accept stage**; **Run loop again** stays available as a quiet secondary action. | routing action `READY` |
| **Finalizing stage…** | The moment between the two acceptance steps. If it persists, *Finalizing did not complete. Use Accept stage to finish it.* (re-freezing is allowed by the engine). | stage `frozen` |
| **Accepted** — *Stage complete.* | Nothing further runs for this stage; **What's next** says what to do now (see [after acceptance](runs.md#after-acceptance-whats-next)). | stage `accepted` |
| **Stopped** — *The last run was interrupted.* | The runner ended mid-turn (Ctrl-C, crash, reload); **Resume stage** returns. | [runner liveness](runners.md#runner-lifecycle) |

## Run in its own workspace, then Merge & clean up

The usual path is *pick plan → Run → watch → Merge & clean up*. **Run Plan**
asks where the run goes:

- **Run in its own workspace (recommended)** — the engine creates a Git
  worktree and branch for the run from the branch checked out where you picked
  the plan (`run-plan … --managed --target-branch <that branch>`), with the
  same plan input, run key, push choice and provider settings as a run in this
  checkout and no `--expected-branch`. Your checkout is not switched or
  changed. This route goes straight to `run-plan`, not through `start-plan`'s
  preparation: an intake run cannot run in its own workspace.
- **Run in this checkout** — the advanced path, unchanged: the run works on
  the branch checked out here, as described under
  [Two ways to progress a plan](#two-ways-to-progress-a-plan).

Before either choice, the engine classifies the document with
`sparring check-plan --json`, which records nothing. A document with no
`## Stage <n> — <title>` sections is planning input, and that is not a dead end.
The Overview offers **Prepare intake (recommended)**, which is the engine's
`start-plan` intake route: it analyzes the document into runnable stages and
asks its decisions before anything runs. It also offers **Make Plan…** as an
optional further planning or audit pass. Nothing about a workspace or branch is
asked on that screen. The engine's `start-plan --managed` does not yet accept
intake-based plans, and the screen says so. Prepare intake therefore runs in
this checkout and asks for the feature branch only once you choose it. A staged
plan the engine refuses shows the engine's reason. **Close** returns to
a neutral view of the repository, not to whatever intake automatic selection
would pick; older intakes stay under **History / Runs…**, and their screen
names the source plan file.

The managed run is always listed first and is what Enter picks; the last
choice is marked "last used here". A managed run asks for no branch or path;
the engine decides both. In this checkout, the feature-branch field starts
empty and names the branch checked out only as context. A protected branch
typed anyway is refused by the engine's branch guard.

**Watch.** The extension reads `sparring runs --json` for each known
repository on refresh. Each run listed there adds its worktree as a location
of that repository, even outside the workspace, and the cockpit follows the
new run by its run key as soon as the engine lists it — no folder has to be
opened. **Runs…** lists these runs with the others, and Running / Paused /
Needs you / Complete mean exactly what they mean for any plan run. Resume,
evidence and the other plan actions continue such a run from the
repository's primary checkout with `resume-plan --run-key <key>` and the
recorded input; the engine reads the branch and worktree from its record.

**Merge & clean up.** For a complete run in its own workspace the Overview
offers **Merge & clean up** (also the command
`Agent Sparring: Merge & Clean Up Run`). Pressing it:

1. runs `finish-run --run-key <key> --dry-run --json` without a terminal —
   read-only; the engine decides whether and how the run can be merged;
2. if the engine says it cannot, shows each failing check as a sentence (an
   unknown check shows the engine's own wording) and issues nothing;
3. if the target branch moved on and only a merge commit would do, says so and
   asks before checking again with a merge commit allowed;
4. otherwise asks for confirmation in plain words: what is merged into which
   branch, fast-forward or merge commit, which ignored files are deleted with
   the workspace, and that the run's remote branch is kept. **Merge & clean
   up**, and when the run has a remote branch **Merge, push <target> & clean
   up** (`--push-target`);
5. runs the confirmed `finish-run` through the tracked command runner, then
   refreshes from the engine. On success the cockpit follows the repository's
   primary checkout; if the engine stopped part-way, its `stopped_at`,
   `reason` and remaining steps are shown, and running it again continues.

**Ready to merge** is shown only when the engine's own finish check, for the
run's current listed state and seconds old, says it can be merged and cleaned
up — never because the run is complete. The extension never creates, merges
or removes a worktree or branch itself. The dialogs name the branch the run
merges into and the ignored paths that would be deleted, because that is what
you are confirming; the run's own branch, the workspace's location, SHAs,
the engine's planned actions and check codes go to the Output Channel
(**Show Log**), not the dialogs.

## Two ways to progress a plan

### Run Plan with a current engine

This applies to **Run in this checkout**; a run in its own workspace skips
this preparation and goes straight to `run-plan`. When capability detection
confirms `sparring start-plan` support, **Run Plan** asks the engine to prepare the selected document with `start-plan --json`.
The Overview shows preparation progress, findings, any decisions you must
answer, and the proposed stages, gates and execution settings. Preparation
may use a read-only provider turn and write an intake before you press Start.
The extension does not choose decision answers.

When the engine reports **Ready to start**, **Start** submits the same inputs
with its confirmation token. The engine checks that confirmation against the
current files and owns execution, verification and acceptance. A refusal is
shown with the engine's explanation. Resume continues the recorded run using
its original Markdown or manifest input.

### Legacy engines and stage-by-stage continuation

If `start-plan` support cannot be confirmed, Run Plan uses the fallback below.
`agentSparring.planContinuation` selects its automatic or manual mode and also
controls per-stage continuation actions. The extension never sequences stages
itself. The extension-built manifests and workspace declarations described
below apply to this fallback and **Continue Plan Automatically**; they are
not passed to the engine's `start-plan` preparation.

**Continue automatically** (the default) treats the plan as the unit of work.
The extension interprets the document once — which headings are canonical
stages, how `3A`/`3B`/`3C` order, which sections are historical handoffs that
define nothing, which stage ids this project already uses, what each brief
says — writes that out as an **execution manifest**, and starts or resumes the
engine's own managed run against it:

```sh
sparring run-plan    --manifest <manifest> --repo-root <project> --expected-branch <branch> [--adopt]
sparring resume-plan --manifest <manifest> --repo-root <project> --expected-branch <branch>
```

From there the engine sequences: implementation ↔ review per stage, and on
READY it freezes and accepts the exact pushed commit through its existing
hard gate and starts the next stage. There is no Accept stage / Start next
stage / Run stage click between healthy stages, and no second confirmation —
you are asked once, *Run this plan automatically until Agent Sparring needs
you?*, with the ordered stage list and which ones are already accepted. The
run stops at NEEDS_YOU, an escalation, a failure, or the end of the plan.

**Adopting a sequence you have been driving by hand.** A standalone stage
with an associated plan offers **Continue plan automatically** — *adopt the
existing stages into a managed plan and continue until Agent Sparring needs
you*. It is offered from the stage you are looking at, including one that is
waiting for you: adopting does not touch the gate. The engine reads the
recorded NEEDS_YOU, keeps the pause exactly as it stands — same candidate,
same sessions, same `sparring.md`, same checks — and stops there with the
position recorded. Accepted stages are verified and advanced past. Your next
action is what it already was: **Submit for review**, which the engine now
answers with `resume-plan --evidence`. At a gate the button is never the
primary one; the gate is.

**Preflight.** If something would make the run fail or do damage, one modal
says all of it at once, before the confirmation: a stage that would be
started again because nothing could place it in the plan, a declared sibling
repository that is missing or on another branch, a checked-out branch that is
not the one this stage's candidate was built on, uncommitted changes (the
engine refuses to freeze from a dirty worktree, so the run would stop at the
first acceptance), or an engine with no `run-plan --manifest`. If nothing is
wrong you get the one confirmation and nothing else. Checks that cannot be
answered from what this window can actually read — a worktree the Git
extension has not opened, a CLI only your shell can resolve — say nothing at
all rather than a maybe.

The manifest is a derived file: regenerated on every launch, byte-stable
while the plan is unchanged, and written to the extension's own global
storage — never into a repository, where the engine's freeze would rightly
refuse it as an unrepresented change. It carries stage ids, labels, titles,
briefs and the order, and no status, position, verdict or session: those stay
in `.sparring/plans/` and each stage's `state.json`, exactly as before.
`--adopt` is added only for a fresh run whose stages already exist from
stage-by-stage work; the engine then checks each one and reports what it
inherits, and refuses anything it would have to guess at.

Headings that only *record* what happened — `## Stage 3D handoff — 2026-09-14
(accepted at …)` — are left in the plan and never run; the Output Channel
names each one it skipped.

**Stages that have already run keep their own brief.** A stage with real
execution history — it is accepted, or holds a session or a candidate commit —
is briefed in the manifest from its own `brief.md`, not from the plan's
section for it. That brief is the contract the work was actually implemented
and reviewed against, and the plan section usually moves on afterwards, when
the plan is rewritten to record what was built. Re-extracting it would claim
the stage was briefed with text it never saw, and the engine would refuse to
adopt the sequence unless the stage were deleted or the plan rolled back.
Stages that do not exist yet are briefed from the plan as it stands. So one
manifest describes both the preserved history and the future execution, and
neither the plan nor a live stage has to be rewritten to run it.

That only works while every existing stage is recognised, and matching is
deliberately conservative — an old brief whose opening paragraph mentions
three stage numbers matches none of them. So if a stage would be *created*
before stages that already exist, automatic continuation refuses and names
it: a hole in a sequence that has already run past that point is almost
always a stage under an id nobody recognised, and starting it would
re-implement accepted work. **Review Stage Matches…** lists every stage and
what it resolves to; fix the one that is unplaced there and continue. (Fixing
it with **Change match…** would remap the stage on screen instead — which is
exactly the accident that command's stage-named dialog now prevents.)

**Cross-repository stages.** A stage whose reviewed candidate also lives in a
second repository must declare it, or acceptance would pin only the primary
commit and let the sibling move between review and acceptance. **Agent
Sparring: Sibling Repositories for a Plan Stage…** declares it: pick the
stage, pick a repository this window already knows (or browse to one), and
confirm the branch its candidate must be on. You are never asked for a
commit — which commit was reviewed is the freeze boundary's answer, and a
hand-typed SHA would be the stale pin the verification exists to catch.

The declaration is VS Code workspace state, kept per plan and stage label,
and it goes into the execution manifest; the engine writes it into that
stage's `state.json` when the run reaches it. Both the manual **Accept
stage** and the managed run then honour it: freeze pins each sibling after
the same branch / clean / pushed checks the primary gets, and acceptance
re-verifies every pin and refuses if one has moved. Declared and pinned
repositories are listed quietly at the bottom of the Overview, each said only
as far as the data goes — *declared in VS Code*, *recorded for this stage*, or
*pinned by the engine* with the commit.

**Review-only stages.** A plan's last stage is often not work: a fresh
independent reviewer verifies the candidates the earlier stages accepted,
checks every gate, and the activation decision is taken on that. Run through
the ordinary lifecycle, such a stage gets an implementation agent with
nothing to implement — one that opens a session, reads around, and sooner or
later writes something to try an idea out, at which point the reviewer of the
work is also its author.

**Agent Sparring: Stage Mode for a Plan Stage…** says so instead: pick the
stage, pick *Independent review (review only)*. Nothing is inferred — a stage
titled "Independent final review and activation decision" runs the
implementation lifecycle until someone declares otherwise, because which
agent runs is not a thing to read off a heading. The declaration is workspace
state per worktree, plan and stage label, exactly like a sibling repository,
and it reaches the engine as `"mode": "independent_review"` in the execution
manifest. The engine then runs that stage as one fresh reviewer over the
accepted candidate set with no implementation turn at all, treats a defect it
finds as a stop rather than as work to do, and completes the stage over the
commit it reviewed instead of manufacturing one. Nothing is merged.

#### What each agent is spending

Beside Model and Effort each card carries three dials: how full the context
window is, and the two rate-limit windows. Every number in them is a
quotation from that provider's own output (the engine's `provider.usage`
telemetry) — nothing is computed from a model name.

The context ring is **occupancy, not spend**. Both CLIs re-send the
conversation on every request, so what a session has spent in total passes
the window several times over; drawn as a share of it, every ring would sit
full by mid-morning. The ring is the tokens the model was holding on its
latest request, the cached prompt included, over the window that provider
stated; the cumulative spend is in the tooltip. Claude states its occupancy
on each assistant line and its window on the turn's final line; Codex states
both in its own session log for the thread, which is where its rate limits
live too — its `--json` stream carries neither.

A dial the provider never reported is **greyed with no arc**, and that is
deliberate. "Not reported" and "zero" are different facts: a rate ring drawn
at 0% would claim you have used none of your quota, which is a measurement
nobody took. The Claude CLI reports no rate limits at all, so on an ordinary
run the Stage agent's two rate dials stay grey for the whole session while
its context ring is drawn. A dial with a numerator and no denominator —
Claude's first messages, before the turn's final line states the window —
reads as a count rather than as a guessed share.

Both kinds of declaration are scoped to the **worktree** they were made in, as
well as to the plan and the stage. They are keyed by the *plan document*
rather than by the run, so a second run of the same plan inherits what you
declared about its stages. A plan key is a hash of the plan's repo-relative
path, so every checkout of the same plan shares one, and keying
by plan alone meant a declaration made in one worktree changed what another
worktree executed — and, through the run digest the engine folds it into,
whether that worktree's in-flight run could continue at all. Declarations made
before this move to the worktree they belong to when exactly one discovered
plan run can be shown to own them; when two could, or none is open, they are
kept, left unapplied, and said so in the Output Channel rather than guessed at.

Two consequences worth knowing before declaring one. A declared mode is part
of what the engine digests to identify a recorded run, so declaring it
mid-run changes that digest and the engine refuses to continue across the
change — deliberately. And a stage that has *already run* under the other
mode cannot simply be relabelled: the engine refuses to adopt an
implementation session into a review meant to be independent of it, and names
`sparring reset-stage`, which archives that attempt as history, verifies the
repository is at the preceding accepted candidate, and restarts the stage with
a fresh reviewer. Both refusals arrive in the terminal with the command to
run.

In the Overview, the reviewing actor card reads **Independent reviewer** for
such a stage rather than *Review turn*, and its instructions are the captured
`prompts/0001-reviewer-original.md` — which is how you check that the actor
working right now really is a fresh reviewer.

**A run's plan input never changes.** Which of the two inputs a *managed run*
is continued from is the run's own recorded `source`, and nothing in the UI
may change it: a run started from a Markdown plan is resumed with that plan's
path, and one started from a manifest with `--manifest`. The engine refuses a
resume from the other kind — rightly, since the two describe different
execution content for the same plan — so generating such a request left a
plan that no button could continue. One function decides the input from the
recorded source, every path that reaches `resume-plan` goes through it, and
the command builder refuses to assemble a mismatch at all. Historical
Markdown runs therefore stay resumable exactly as they are; nothing migrates
or rewrites a run's input kind.

In the legacy fallback, **Run Plan** starts a fresh manifest-driven run in
automatic mode and hands the plan's own path to `run-plan` in manual mode.
An open run of the same plan offers **Continue that run**; a completed run
does not block a new one. Current engines use the `start-plan` flow above.

**Pause after each stage** (`manual`) keeps the explicit per-stage checkpoints, for when you want to look before every provider turn. In automatic
mode those actions are still there, just no longer the obvious path.

#### Starting a fresh reviewer or implementation agent

For a **paused** plan run whose current stage is not accepted, the Overview
offers **Start fresh reviewer…** and **Start fresh implementation agent…**.
Each replaces only that role's conversation, through the engine's own
`resume-plan --fresh-sparrer` / `--fresh-stage-agent`: same stage, same
candidate, previous review history preserved. The engine still decides whose
turn runs next; the extension never picks one. The flow asks whether to keep
the current preference or choose another, shows the resolved provider, model
and effort from `show-config`, and launches only after a modal confirmation.
Only the providers the engine lists for the role are offered — today one per
role, so the choice reads **Choose another model…** — and a role override is
passed only when it differs from the preference. The actions are absent while
a runner is alive, for an accepted stage, and on an older engine that records
no `sessions`. A role's actor card shows `generation N · fresh: <reason>` once
it is past its first conversation. This is not **reset-stage**, which
archives the attempt and restarts the stage from the preceding candidate.

**Pause cards.** When the engine paused the run because a provider failed, the
Overview shows a card for the current stage:

- *Reviewer / Implementation-agent session cannot be resumed* — the candidate
  is safe; the action is **Start fresh …** for that role. There is nothing to
  retry.
- *Provider unavailable (quota / rate limit)* — **Retry** (plain
  `resume-plan`) or **Start fresh … with another model/provider**, which never
  offers the current preference: another provider the engine lists for the
  role, or, where it lists only one, a different model on it.

When the engine records that the role has no session to replace
(`has_session: false`), only **Retry** is offered, anywhere on the screen.
Source of truth: the card comes only from the plan run's `provider_pause`
record, for the current stage, while the run's own status is `paused`. A
record of an unknown kind or role, or with no stage id, is not shown; nothing
is inferred from terminal output, prose or a process exit.

## When a deferred check fails

At the plan's verification checkpoint every stage is already accepted, and
only a Pass settles a check the reviewers deferred. So recording a Fail and
resuming does exactly what the engine says and no more: the answer is written
into the stage that raised it, and the run stops again on the same question.
Correct — the plan is not verified — but not a route anywhere, and the route
must not be to make the check pass by hand.

So once something here has been reported failing, the panel offers **Reopen
stage to fix this** beside the submit action. It runs `sparring reopen-stage`,
which puts the raising stage back from accepted to in progress, keeping its
candidate commit, both agents' sessions and its notes, and withdraws the
asking that failed. The stage agent reads the Fail first, because the engine
wrote it into that stage's `notes.md` when it was recorded. The plan does not
continue by itself; resume it when you are ready.

The button is addressed by the **asking**, never the stage: a panel rendered
from an older state cannot reopen a stage over a question the run has since
replaced, and the engine refuses one it is no longer stopped on.

It is shown whenever something has failed, and disabled with the reason when
the engine would refuse it — most importantly when an **earlier** stage raised
the failing check. The stages after it were accepted on top of its acceptance,
so reopening it would rewrite their history; that repair belongs in a
follow-up stage, and the button says so rather than going quiet. Knowing which
of those two situations you are in is not guessable from anything else on the
panel, which is why the offer is never simply hidden.

## Push authorization

Acceptance only ever freezes a commit that is already on its intended remote
branch. When a reviewed candidate is not — usually because the project's own
agent instructions forbid an agent from pushing unasked — the engine pauses
and records *why*, as typed state rather than prose:

```json
"awaiting": { "kind": "push_authorization_required", "candidate_sha": "f2e455c…",
              "remote": "origin", "remote_branch": "feature/add-reference-dialog" }
```

The Overview reads exactly that and shows a **permission**, not a test:

> **Push authorization required**
> Candidate f2e455c is ready to push to origin/feature/add-reference-dialog.
> `[ Allow push ]` `[ Do not allow ]`
> `[ ]` Auto-push future accepted candidates in this run

There are deliberately no Pass / Fail / Can't test controls, no progress
count and no Submit for review. That is the defect this replaced: a reviewer
could express the requirement as a human-gate check ("explicit push
authorization is required"), the panel rendered it as a manual check, a
person pressed *Pass* — and nothing was authorized. The answer went back as
reviewer evidence, the reviewer said READY again, and the gate refused the
same candidate again.

**Allow push** hands the engine the permission for the exact commit on
screen (`resume-plan --allow-push-candidate <commit>`), and with the toggle
on, for this run's later verified candidates too (`--allow-push-for-run`).
The engine performs the push, re-proves that the commit really is reachable
from that remote branch, and then runs its own unchanged acceptance gate. The
extension never runs `git push` itself, on any path: the component that owns
acceptance owns the push.

The commit is the one the panel was rendered from, and the engine refuses the
flag unless the run is in fact waiting for that exact commit — so a panel
left open while the run moved on cannot authorize a candidate nobody looked
at. **Do not allow** changes nothing at all: pushing the branch yourself and
continuing the plan normally is a perfectly good way through.

The toggle's position is a draft in this window (so a rerender does not move
it); the *decision* is recorded by the engine for that run, which is why
**Auto-push is on for this run** is still shown after a window reload. It
covers this run, this worktree, this branch and that one remote branch, by
ordinary non-force push, and nothing else — no force, no tags, no other
branch, no sibling repository, and no project-wide default. Starting a new
managed run offers the same choice up front, as the second button on the
confirmation (a modal dialog cannot hold a checkbox); the ordinary button
starts the run with no push authorization at all, which is the default.
