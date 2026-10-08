# Plans, repositories and run selection

[Documentation index](README.md) · [Extension overview](../README.md)

- [Plans: managed runs and associated files](#plans-managed-runs-and-associated-files)
- [Which stage is this, and which comes next?](#which-stage-is-this-and-which-comes-next)
- [After acceptance: What's next](#after-acceptance-whats-next)
- [Which run the Overview follows](#which-run-the-overview-follows)
- [The repository context: following, and pinning](#the-repository-context-following-and-pinning)
- [Every Run Plan is a new run](#every-run-plan-is-a-new-run)
- [Plan run, historical stage, plan document](#plan-run-historical-stage-plan-document)

## Plans: managed runs and associated files

- A **managed plan run** is the engine's `.sparring/plans/<key>.json`. It is
  authoritative: the Overview shows the journey, **Plan document** opens the
  recorded Markdown, and after the current stage is accepted **Continue plan** calls
  `sparring resume-plan`, which advances past the accepted stage and starts
  the next one (paused runs get **Resume plan**).
- A **run in its own workspace** is a managed plan run the engine started in a
  worktree it created (`run-plan --managed`). Which runs those are, and where
  their worktrees are, comes only from `sparring runs --json`: a worktree
  that `git worktree list` shows but the engine's record does not name is not
  treated as a run's workspace, and a folder or branch name never makes it
  one. Such a worktree is added as a location of its repository even outside
  the workspace, the cockpit follows the run by its run key, and it is resumed
  from the primary checkout with `resume-plan --run-key`. Once complete it is
  finished with **Merge & clean up**
  ([details](workflows.md#run-in-its-own-workspace-then-merge--clean-up)).
  **Run in this checkout** runs stay exactly as described here.
- A **standalone stage** has no machine-readable plan. **Choose plan…** lets
  you pick any Markdown file (no directory convention is assumed). The
  association is VS Code workspace state keyed by repository + stage id;
  the engine never sees it. The Overview then shows **Plan document** and
  this stage's place in the document. Because the engine has no operation that
  starts a standalone stage from a plan, nothing here offers to; the next
  section is information you read, not a button that runs something.

## Which stage is this, and which comes next?

Headings are read leniently at levels `##`–`####`. A heading carries a
stage label when it is written `## Stage 3B — …` (a *definition*) or
names one in passing, `## Reviewer handoff — 2026-09-12 (Stage 3B)` (a
*mention*). Every heading with the same label is one logical stage, so a
plan that keeps a handoff and a status note per stage still has one Stage
3B. The stage's canonical section is the single non-historical definition
(headings with *handoff*, *accepted*, *candidate*, *status*, *history* or a
date are records, not definitions); two plausible definitions make the
stage ambiguous and nothing is chosen.

The current stage is placed only when exactly one candidate qualifies, in
this order: a stage you picked yourself; a heading whose title equals the
stage id (`stage-local-schema-barrier` ↔ `Local schema barrier`); a stage
label carried by the id (`stage-3b-…`) or by the brief's own title
(`# Stage 3B — …`); the stage's display title. Otherwise the Overview asks
with **Match this stage…**, a Quick Pick of the plan's stages. Your pick
is stored with the association (label and title, not a line number),
shown as *Current plan stage — Matched manually*, and can be changed
(**Change match…**), dropped (**Remove match**) or unlinked (**Remove plan
association**); changing the plan file drops it too.

**The next stage is the next label, never the next heading.** Labels sort
1 < 2 < 3 < 3A < 3B < 3C < 4, so after Stage 3B comes Stage 3C even when
the file lists the old Stage 3A handoff right below the current one. If
the plan has no later label it says so; if the later stage is defined
twice, or only mentioned in a handoff, the Overview says that and does
not start anything.

## After acceptance: What's next

Once a stage is accepted the Overview stops watching activity and answers
"what should I do now?" with one **Accepted** badge, one *Stage complete.*
line and a **What's next** block:

| Situation | What's next shows |
| --- | --- |
| Managed plan run, a stage follows | the engine's next stage, its opening paragraph from the plan, **Continue plan** (`resume-plan`), **Open plan section** |
| Managed plan run, last stage | *No stage follows this one in the plan.* and **Continue plan** |
| Standalone stage, plan linked and matched, next stage defined | `Stage 3C — title`, its opening paragraph, **Start next stage**, **Open plan section**, **Change match…** |
| Standalone stage, next stage ambiguous or only mentioned historically | the label and why it cannot be started; **Open plan section** |
| Standalone stage, no later label / plan without labels | *No later stage is defined in …* / the plan has no "Stage …" labels; **Open plan document** |
| Standalone stage, plan linked but not matched | *The plan is linked, but Agent Sparring doesn't yet know where this stage belongs in it.* **Match this stage…**, **Open plan document**; plan stages the brief lists as later work are shown as a hint |
| Standalone stage, no plan | *This stage has been accepted. Choose a plan to see what comes next.* **Choose plan…** |

**Start next stage** (the per-stage path) proposes `stage-<label>-<slug>`
(for example `stage-3c-cloud-schema-and-synchronization`), confirms *Start
Stage 3C — …?* with the id and the plan section, and runs the engine's
`sparring new-stage <id> --brief-file …` through the configured executable
with that plan section as the brief. The engine writes the stage directory,
`state.json` and `brief.md`; the extension writes nothing under `.sparring`.
It deliberately does not launch anything: **Run stage** is the separate,
deliberate step that spends provider tokens. **Continue automatically** does
the same interpretation for every remaining stage at once and lets the engine
run them.

## Which run the Overview follows

In order:

0. **the repository this window is in** — automatic selection only ever
   considers runs there (see below);
1. the run you chose explicitly, while that choice still holds — *regardless*
   of repository, because pinning a run is how you inspect history somewhere
   else;
2. the active managed plan run of the project;
3. the active standalone stage;
4. a plan intake that is prepared or slice-approved and has no run yet, when
   it is **newer** than every finished run there — judged by the
   `created_at` (or a later `approved_at`) the engine recorded. An intake
   whose `created_at` is missing or has no time zone is never assumed newer:
   it stays discoverable and never takes the screen. Only the newest intake
   of a plan counts;
5. otherwise the remembered run, then the most recent finished one.
   Finished runs stay reachable through **History / Runs…** whichever is shown.

A choice stops holding when a managed plan run of the same project has
**advanced past** the finished stage you had chosen — which is what happens
when a stage you adopted is accepted and the engine moves to the next one.
The Overview then follows the managed run to its current stage. Every "a
runner is already alive" message offers **Show running plan** too, rather
than leaving you on a screen whose buttons cannot work.

## The repository context: following, and pinning

A VS Code window is often several repositories, so the cockpit states which
one it is in — at the **top of the Overview**, before anything about the run:

> Following repository: **my-app-export-fix**

The contract is exactly this, and nothing else:

```
Agent Sparring repository context =
    the explicitly pinned Agent Sparring repository/run, if one is pinned
    otherwise the repository of the active editor / Source Control focus
```

Move to another repository and the run from the previous one is dropped
rather than left on screen looking current. If the repository you have moved
to has no `.sparring` run, you get

> **No Agent Sparring run for my-app-export-fix**
> This repository has no .sparring plan run or stage on disk. Nothing has been
> started or created for it.

and, when work exists elsewhere, a line naming where: *Agent Sparring has also
discovered 1 in my-app-reports.* Nothing is started, adopted
or created on your behalf.

**Starting work, and looking at history, are two controls.** The repository
line carries both:

> Following repository: **my-app-reports**
> \[ Run Plan ] \[ History / Runs… ]

**Run Plan** is the ordinary workflow and asks for what it needs, in order:
which repository, then which plan document. It then starts a **new run** of
that plan — see "Every Run Plan is a new run" below — so starting work never
goes by way of a list of finished runs. **History / Runs…** is that list: the
recorded runs, including completed ones, to pin and inspect.

**Pinning.** Picking a row in **History / Runs…** *pins* it. A pin is kept
even when the window moves to another repository — that is what makes
inspecting a finished run in another checkout possible — and both repositories
are then named at the top, with the way out beside them:

> 📌 Viewing pinned run from: **my-app-reports**
> Active repository context: **my-app-export-fix**
> \[ Run Plan ] \[ History / Runs… ] \[ Follow active repository ]

Both lines appear whenever a pin is in force, including when the pin is in the
repository you are already in, so the policy reads the same way every time.
Both controls are on every Overview screen — with a run, without one, and
while several look active — and `Agent Sparring: Follow Active Repository` is
in the Command Palette. Switching context never depends on a gesture this
extension cannot observe.

**Pins and attachments.** Only a run or intake you chose in **History /
Runs…** is a pin: it never switches by itself, the status bar marks it with
`$(pin)`, and only **Follow active repository** (or choosing something else)
ends it. Starting a plan run or an intake slice, **Show running plan**, **Back
to plan run** and creating a stage *attach* the cockpit to that work instead:

> Showing work in: **my-app**
> \[ Run Plan ] \[ History / Runs… ] \[ Follow active repository ]

so you see what you just started even though it usually lives in a different
checkout from the file you had open. An attachment is not a pin. It holds while
you stay in the repository you were in when it was made, or in the one that
owns the work, and is released the moment the active editor (or the Source
Control view) moves to a repository that does not own it — including back to
where you started — and the cockpit then follows that repository. A file
outside every repository, an Output tab or an untitled buffer changes nothing.
A selection stored before this distinction existed is kept as a pin.

## Every Run Plan is a new run

A plan document is an *input* to a run, not the run's identity. Each run has a
**run key** of its own. On the `start-plan` route, the engine supplies the
identity: an intake slice reports its key before launch, while a direct run
is discovered after the engine records it. In the legacy fallback, the
extension mints a key (`<plan key>-<8 hex>`) — as it does for a run in its
own workspace, which is launched with `run-plan` directly —, names the stage ids with it
(`<run key>-stage-1-foundation`) and passes it as `--run-key`.

So Run Plan starts new work even when the repository, the branch and the plan
file are the ones a previous run already finished, and even when the plan's
sections are numbered `Stage 1` again. Fresh Stage-agent and Sparrer sessions
start; the earlier run's accepted stages are not advanced past. Nothing has to
be deleted from `.sparring`, no stage has to be renumbered, and no adoption
decision is involved — adoption stays what it is for, which is taking over
hand-driven work that belongs to no run.

The one thing Run Plan will not do silently is start a second run of a plan
whose run is still **open** — running or paused — in the same worktree, since
two live runs would compete for the same candidate. It says so and offers to
continue that run instead. A *completed* run never stands in the way.

**Resume** means continuing one specific existing run, and is the only way
resumption is expressed.

A selection stored by a version of this extension from before pins survived a
change of repository is **not** silently promoted to one: on first start it is
demoted to the ordinary remembered run, which still shows while the window is
in its repository and lets go as soon as it is not.

**What "the repository of the active editor / Source Control focus" means, and
what it deliberately does not.** VS Code's lower-left repository selector
cannot be read through any public extension API: `vscode.scm` exposes only
`createSourceControl`, the selector's command (`scm.setActiveProvider`) sets an
internal pin no extension is told about, and core publishes the answer solely
as `when`-clause context keys an extension cannot read as values. Emulating it
would mean reaching into private commands or internals, so **Agent Sparring
does not claim to follow it.** What it follows is the two public signals the
built-in Git extension's stable API version 1 does offer:

- `Repository.ui.selected` / `Repository.ui.onDidChange` — which repository the
  Source Control view has focused;
- `API.getRepository(uri)` with `window.onDidChangeActiveTextEditor` — which
  repository owns the document you are looking at.

Whichever was observed most recently wins. An editor that belongs to no
repository (a Settings tab, the Output panel) says nothing rather than
emptying the answer, and a *re-read* — caused by a repository opening or
closing, or by the Git extension only just becoming available — re-resolves
what was already observed without counting as a new selection. No private
command is intercepted and no context key is read.

The consequence worth knowing: **using the lower-left selector alone is not
visible to this extension.** Opening a file in the repository you switched to
is, as is focusing it in the Source Control view — and the resolved repository
is named at the top of the Overview precisely so a disagreement is visible
rather than silent. **History / Runs…** overrides it.

If the built-in Git extension is disabled, not installed, or has not activated
yet, nothing is scoped at all and every discovered run is a candidate, exactly
as before following existed. Agent Sparring can activate before the Git
extension does; it then awaits that extension's activation and retries from
every later editor or Source Control signal, so following starts working
without a reload. `Agent Sparring: Diagnose Discovery` reports whether the API
is attached.

**Attribution is strict.** Repositories are told apart by **root path only**,
never by branch name; two worktrees of the same repository are two
repositories, a worktree checked out inside its parent belongs to itself (a
run is attributed to the *deepest* repository root that contains it), and two
roots with the same directory name are qualified by their parent
(`worktrees/republish-media`). A run that **no** known repository root owns — a
`.sparring` project in a folder that is not a git repository, or one the Git
extension has not opened — is never selected automatically, because showing it
under the words *Following the active repository: B* would be a claim that it
is B's. It stays in **History / Runs…**, and the empty state names it.

## Plan run, historical stage, plan document

Three things, and the UI keeps them apart:

| | What it is | How to get to it |
| --- | --- | --- |
| **Plan run** | the whole job: the engine sequences its stages, records where it is, and the Overview draws the timeline | the *Plan runs* group of Select Repository / Run; **Back to plan run** from one of its stages |
| **Historical stage** | one finished stage of a plan run — good for inspecting its brief, handoff, review, diff and log | the *Standalone / historical stages* group |
| **Plan document** | the Markdown specification | **Plan document** / **Open plan section**, which open an editor and change nothing about which run is selected |

A stage is known to belong to a plan run only through **recorded execution**:
the execution manifest that run executes lists its id, or the run's own
recorded current stage is it, or — for a run started from a Markdown plan — the
plan document's stage list, which is what the engine itself executes for such
a run. That is why a stage of a plan whose document the engine's
`## Stage <n>` parser refuses — one carrying `## Stage 3D handoff — …`
records — is still named `Stage 3D` and still knows where it came from, and
why nothing is claimed when no recorded run lists it. A stage id that merely
*looks* like one of a plan's, and a plan run that merely happens to be open in
the same project, are not records of anything and claim nothing.

A manifest is only believed once it is bound to the run it is claimed to
describe. It lives in the extension's global storage, which is per-user and
nothing else, so its file name is scoped to the run's project directory as
well as to the plan — two worktrees running `docs/plans/foo.md` no longer share
one file — and its contents are checked against what the engine recorded: the
plan label it executes, and the presence of the run's current stage. A
manifest that fails either check, or that is missing, attributes nothing; the
stage keeps its own screen rather than being handed to a run that cannot be
shown to have executed it.

Such a stage reads *Historical stage*, is named as its own run
names it, and offers **Back to plan run** as its primary action; that button
changes the selected run, so the timeline comes back. What the plan run owns
is withheld there: **Continue plan automatically** is not offered (whether
that run is still going or complete — adopting stages a managed run already
owns could only be refused, or start a second run over finished work), and
neither is **Start next stage** for a stage the engine has already created.
The refusal is in the command, not only in the screen: invoking
`Agent Sparring: Continue Plan Automatically` from the Command Palette or a
keybinding on a stage an existing plan run owns is refused with that run
named, and offers **Back to plan run**.
