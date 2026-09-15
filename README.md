# Agent Sparring for VS Code

A thin desktop cockpit for the `agent-sparring` engine (the sibling Python project).
The engine stays the authority; this extension only observes, launches and
navigates.

## What it does (V1 shell)

- Detects every `.sparring/` directory in the workspace: directly under each
  workspace folder and in projects nested below one (a git worktree or a
  monorepo package checked out under a parent folder; see
  `agentSparring.nestedSearchDepth`). Each project is its own repository in
  the run list.
- Discovers recorded plan runs (`.sparring/plans/<key>.json`), their stages
  (`.sparring/stages/<id>/state.json`) and standalone stages.
- Shows one status-bar item, e.g. `● Agent Sparring: Stage 3/6 · Claude working`,
  `⏸ Agent Sparring: Stage 3/6 · NEEDS_YOU`, `✓ Agent Sparring: Plan complete`.
- Streams a terse chronology of the current stage's `activity.jsonl` into the
  **Agent Sparring** Output Channel (no prompts, payloads or tool output; the
  engine never writes them and the extension never invents them).
- Attaches automatically to runs started from any terminal, and rediscovers
  everything from disk after a reload.
- Launches `sparring run-plan` / `sparring resume-plan` / `sparring run-loop`
  in an integrated terminal through the shell-integration API (executable +
  argument array) and observes when the process ends; see "Runner lifecycle".
- **Continues a whole plan automatically**: interprets the plan document once
  into an execution manifest and hands it to the engine's managed run, which
  then goes from stage to stage on its own and stops when it needs you. One
  confirmation, at the start. See "Two ways to progress a plan".

## Commands

| Command | Effect |
| --- | --- |
| `Agent Sparring: Run Plan` | Pick a plan Markdown file (`## Stage <n> — <title>` headings), confirm the branch, launch `run-plan`. The branch is asked for here because nothing has been decided yet — this is the run that records it. |
| `Agent Sparring: Resume Plan` | Pick a paused/running plan run, optionally record human evidence, launch `resume-plan`. The branch is *not* asked for: the run recorded `expected_branch` when it started and the engine refuses any other, so the checked-out branch is used when it matches and the mismatch is explained when it does not. |
| `Agent Sparring: Run / Resume Stage` | For the selected standalone stage (or after picking one), launch `sparring run-loop <stage> --repo-root <project> --expected-branch <current branch>` in a terminal. The branch comes from the Git repository owning the project (built-in Git API, then `.git/HEAD`); a detached HEAD is refused, never guessed. Also offered as **Run stage** / **Resume stage** in the Overview. |
| `Agent Sparring: Accept Stage` | For a stage whose independent review passed (**Review complete**): one action that runs the engine's `freeze-candidate` and, only if that succeeds, `accept-candidate` for the selected stage, project and current branch. Refusals are translated (uncommitted changes, not pushed, wrong branch, code changed after the review); the engine's own output goes to the Output Channel. Also offered as **Accept stage** in the Overview. |
| `Agent Sparring: Choose Plan for Stage…` | Associate a Markdown plan file (any location, ordinary file picker) with the selected standalone stage. Stored in VS Code workspace state per repository + stage id, never in engine state; gives the Overview a **Plan document** button, this stage's place in the document and, once accepted, **What's next**. Change or remove it the same way. |
| `Agent Sparring: Match Stage to Plan Section…` | When the Overview cannot tell which stage of the associated plan the selected stage is, pick it from the plan's stages (also **Match this stage…** / **Change match…** in the Overview). It remaps **only the stage on screen**, and the dialog is titled with that stage's name so it cannot be mistaken for another. Stored with the association in VS Code workspace state, never in engine state. |
| `Agent Sparring: Review Stage Matches…` | The plan-level view: every stage this project has and which section of the plan it resolves to, with the ones nothing could place — and any two stages claiming the same section — first. Pick one to say which section *it* is. Use this to fix a historical stage; **Change match…** would remap the current one instead. When nothing needs placing the list says so — *All stages are matched. Select one only if you want to change it.* — and fixing the last unplaced stage closes it rather than reopening. Also **All stage matches…** in the Overview. |
| `Agent Sparring: Start Next Stage from Plan…` | For an accepted standalone stage with an associated plan: create the stage that follows it (by stage label) with the engine's own `sparring new-stage <id>`, after a confirmation naming the title, the proposed id and the plan section. The Overview switches to the new stage, the plan association follows it, and its fresh `brief.md` opens beside the plan section for you to fill in before **Run stage**. Also **Start next stage** in the Overview. |
| `Agent Sparring: Continue Plan Automatically` | Build the execution manifest for the plan of the selected run and start (or resume) the engine's managed plan run against it: `sparring run-plan --manifest … [--adopt]` / `sparring resume-plan --manifest …`. The engine then sequences the stages itself. One confirmation before the first stage; none between stages. Also **Continue automatically** in the Overview. |
| `Agent Sparring: Sibling Repositories for a Plan Stage…` | Declare which *other* repositories a plan stage's reviewed candidate spans, so acceptance pins and verifies the complete set instead of the primary commit alone. Pick the stage, pick a repository this window knows (or browse to one) and confirm the branch its candidate must be on; no commit is ever asked for. Stored in VS Code workspace state per plan and stage label, emitted into the execution manifest, and shown quietly in the Overview. Removing a declaration is the same command. |
| `Agent Sparring: Stage Mode for a Plan Stage…` | Declare that a plan stage is a *review* of work rather than work: no implementation agent runs for it, and a fresh independent reviewer inspects the candidates the earlier stages accepted. Nothing is inferred from a stage's title or its brief's prose — this command is the only way to say it. Stored in VS Code workspace state per plan and stage label and emitted into the execution manifest as `mode`. Setting it back to *Implementation* removes the declaration. |
| `Agent Sparring: Copy Review Context for Chat` | For a stage the reviewer handed back to you: put the whole review on the clipboard as plain Markdown — the stage and its goal, the routing state, the reviewer's summary and note, every human-gate check with its instruction and pass criteria verbatim, the concrete names the review refers to, the latest handoff claims, the reviewer's findings and the stage's plan section — so it can be pasted into ChatGPT/Claude, an issue or a message and asked about. No provider prompts, model reasoning, command output or activity log. Also **Copy context for chat** in the Overview, beside **Open detailed review**, with **Copy this check** under each outstanding check. |
| `Agent Sparring: Choose sparring Executable…` | Pick the `sparring` CLI with a file dialog and store it as `agentSparring.executable`. |
| `Agent Sparring: Open Overview` | One editor-area Run Overview panel: compact plan journey (accepted / current / paused / finalizing / future stages), the current stage as primary content (the stage as the plan names it — `Stage 3D — title`, with `6 of 8` as secondary metadata — a human state word with one explaining sentence, loop cycle, the Goal paragraph from `brief.md`, `Working for Xm Ys` or the last visible event), latest sparring result, small Stage Agent / Sparrer cards, Brief / Handoff / Sparring report / Diff / Plan document / Log buttons, and quiet metadata (where the engine's own words live). Never auto-opens; updates in place. |
| `Agent Sparring: Show Log` | Focus the Output Channel. |
| `Agent Sparring: Select Run` | Choose explicitly when several runs look active; the choice is remembered per workspace. The list is grouped — *Plan runs* first, then *Standalone / historical stages* — and each row is labelled by what a person calls it (the plan document's title, the plan's own `Stage 3D — …` name for a stage), with the repository and the raw stage id in the detail line. |
| `Agent Sparring: Rediscover State` | Re-scan `.sparring` from disk. |
| `Agent Sparring: Diagnose Discovery` | Trace discovery for every workspace folder into the Output Channel: scheme, path, the `.sparring` probed, nested projects, stage/plan files and whether they parsed (lifecycle status only), runs produced, what Select Repository / Run would list (group, label, description and the raw stage id), and why nothing is selected. Never logs file contents. |

## Settings

- `agentSparring.executable` — full path to `sparring`. Empty (the default)
  hands the bare word `sparring` to your integrated shell, which resolves it
  with its own `PATH` exactly as when you type it; the extension host's
  `PATH` is never consulted for that, so "works in the terminal" means
  "works from the button". See "Executable resolution" below.
- `agentSparring.planContinuation` — `automatic` (default) or `manual`. See
  "Two ways to progress a plan".
- `agentSparring.pollIntervalMs` — fallback poll interval for the activity log.
- `agentSparring.nestedSearchDepth` — how many levels below each workspace
  folder are searched for nested projects with their own `.sparring`
  (default 2; 0 probes only the folders themselves). Hidden and
  dependency/build directories are never entered.

## Executable resolution

| Situation | What runs | On failure |
| --- | --- | --- |
| Nothing configured, terminal shell integration available (the normal case) | Your integrated shell receives `sparring` plus the argument array through the shell-integration API; the shell's own `PATH`, venv activation and profile apply. Nothing is pre-checked from the extension host. | Only here can an exit code mean a missing CLI: if the shell reports the bare word as not found (exit 127, or 9009 on cmd.exe), the extension says so and offers **Open Settings** / **Choose executable…**. |
| `agentSparring.executable` set | Exactly that path (relative paths resolve against the project). It is validated before anything is launched. | `agentSparring.executable points at …, which does not exist or is not executable.` |
| Nothing configured, no shell integration within 5 s | A best-effort `PATH` search in the extension host, then a dedicated terminal whose process is `sparring`. | `Agent Sparring could not resolve the CLI from this VS Code environment. Set agentSparring.executable to the full path.` (never a suggestion to reinstall the engine). |

Short commands (Accept stage) use the same rule: your shell through shell
integration when available (the output is read back for translation and
the log), otherwise a direct process with a host-resolved path.

A configured or host-resolved path is checked before anything runs, so a
bad exit code from *that* is the command's own: the extension reports
`sparring <subcommand> exited with code N` with what it printed, and never
sends you to the executable setting for an executable it just ran. The full
output is in the Output Channel.

### Free-text arguments

`resume-plan --evidence` carries a whole `## Human evidence` entry — a
gate check's backticked id, the note you typed, several lines. VS Code's
`executeCommand(executable, args)` double-quotes an argument only when it
holds whitespace and none of `"`, `'` or a backtick, and appends everything
else raw, so such an entry would reach the shell as syntax rather than as
text. When an argument would not survive that escaping, the extension quotes
the command line itself (POSIX single quotes) and hands it over as one
string; on a shell whose quoting is not written here (cmd.exe, PowerShell)
it bypasses the shell and runs the process with an argument array instead.
Every other invocation — flags, stage ids, paths — is unaffected and still
goes through VS Code's own escaping.

## What the words mean

The Overview and status bar use one plain vocabulary; the engine's own
words stay in tooltips, the metadata footer and the Output Channel.

| Shown | Meaning | Engine state behind it |
| --- | --- | --- |
| **Working** | Implementation or independent review is happening (or a correction turn is running after a finding). | stage `working`; a live turn in `activity.jsonl` |
| **Changes requested** — *The independent reviewer found something to fix. Work will continue automatically.* | The sparrer sent the stage back; the loop continues on its own. | routing action `SEND_BACK` |
| **Needs you** — *the reviewer's request* | Only you can do the next thing. The header pill names it once; one panel — **Manual check required** for a structured gate, **Action required** otherwise — says why the run stopped, what to do, what counts as a pass and how to continue (see *Manual verification* below). Beside the reviewer's checks there is one freeform field, **Additional findings or instructions**, for what you found that is not a result for any of them. | routing action `NEEDS_YOU` |
| **Evidence ready** — *Evidence ready for review* | Same routing action, but every check the reviewer asked for now has a recorded outcome. One primary button — **Submit for review**, or **Submit result and continue** in a managed plan — hands the evidence back to the reviewer. | routing action `NEEDS_YOU` + `## Human evidence` and the outcomes recorded here |
| **Wrong branch** | The checked-out branch is not the one this stage's work belongs to. Nothing that runs the engine is offered, because every loop command passes `--expected-branch` and the engine's own guard would refuse. | `expected_branch` in the plan-run state, or `## Git context` in the stage's `handoff.md`, against the checked-out branch |
| **Escalated** | The reviewer could not settle it; the **Action required** panel carries the report's summary, **Open detailed review** opens `sparring.md`. | routing action `ESCALATE` |
| **Review complete** — *Independent review passed. No unresolved findings remain.* | Primary action **Accept stage**; **Run loop again** stays available as a quiet secondary action. | routing action `READY` |
| **Finalizing stage…** | The moment between the two acceptance steps. If it persists, *Finalizing did not complete. Use Accept stage to finish it.* (re-freezing is allowed by the engine). | stage `frozen` |
| **Accepted** — *Stage complete.* | Nothing further runs for this stage; **What's next** says what to do now (see below). | stage `accepted` |
| **Stopped** — *The last run was interrupted.* | The runner ended mid-turn (Ctrl-C, crash, reload); **Resume stage** returns. | runner liveness, see below |

## Two ways to progress a plan

`agentSparring.planContinuation` picks one; both only ever run engine
operations, and the extension never sequences stages itself.

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
state per plan and stage label, exactly like a sibling repository, and it
reaches the engine as `"mode": "independent_review"` in the execution
manifest. The engine then runs that stage as one fresh reviewer over the
accepted candidate set with no implementation turn at all, treats a defect it
finds as a stop rather than as work to do, and completes the stage over the
commit it reviewed instead of manufacturing one. Nothing is merged.

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

**Pause after each stage** (`manual`) keeps the per-stage checkpoints below
unchanged, for when you want to look before every provider turn. In automatic
mode those actions are still there, just no longer the obvious path.

## Plans: managed runs and associated files

- A **managed plan run** is the engine's `.sparring/plans/<key>.json`. It is
  authoritative: the Overview shows the journey, **Plan document** opens the
  recorded Markdown, and after the current stage is accepted **Continue plan** calls
  `sparring resume-plan`, which advances past the accepted stage and starts
  the next one (paused runs get **Resume plan**).
- A **standalone stage** has no machine-readable plan. **Choose plan…** lets
  you pick any Markdown file (no directory convention is assumed). The
  association is VS Code workspace state keyed by repository + stage id;
  the engine never sees it. The Overview then shows **Plan document** and
  this stage's place in the document. Because the engine has no operation that
  starts a standalone stage from a plan, nothing here offers to; the next
  section is information you read, not a button that runs something.

### Which stage is this, and which comes next?

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

### After acceptance: What's next

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

## Source-of-truth rule

| Displayed fact | Source |
| --- | --- |
| running / paused / complete, current stage index and id | `.sparring/plans/<key>.json` |
| working / frozen / accepted per stage | `.sparring/stages/<id>/state.json` |
| stage count and titles | the plan Markdown named in the run state |
| Changes requested / Needs you / Escalated / Review complete | `## Routing outcome` in the current stage's `sparring.md` |
| **Manual check required** — the gate title, the task, the results | the structured `human_gate` of the recorded verdict: the JSON block behind the `<!-- human-gate:v1 -->` marker in `sparring.md`. The gate's `title` is the requirement, stated once; each `checks` entry becomes one task — its `instruction` laid out as its own sentences, one **Pass if** line from its `pass_criteria`, and Pass / Fail / Can't test keyed by its stable `id`. Nothing is shortened or reworded: the split is a layout, and the verbatim text is in **Show technical details**. Nothing is added from the plan and nothing is inferred from prose — the engine requires a NEEDS_YOU to name what blocks the stage, and things the reviewer says about *after* acceptance (deployment, rollout, monitoring) belong to `findings`/`deferred` and are not shown as checks |
| **Show technical details** | the demoted layer of the same panel: the routing action, the gate's category and title, each check's id, its verbatim instruction and pass criteria (including the reviewer's *Fail if* wording), where the check is defined, and the plan and line the stage was located at. Never a prerequisite for doing the check; never deleted either |
| **Reviewer note** | `sparring.md`'s needs-you reason. With a structured gate it restates the gate title, so it lives in the technical details; without one it is the panel's one compact reviewer line, verbatim |
| the same panel for a verdict recorded **before** structured gates existed | the legacy derivation, unchanged: task-list items under the matched plan section's `### Manual verification` heading 1:1, else its human-worded list items as prose parents, plus the request clauses of `## Deferred` (else of the reason) split at sentence and semicolon boundaries and tagged *Reviewer*. The plan file is never modified (its stage sections are digest-guarded) |
| **Evidence already recorded** vs **Still required** | the `## Human evidence` section of the stage's `notes.md`: a check is recorded when an entry names its stable gate id (`· check \`…\``, which is why a result survives the reviewer rewording the same check), else names it exactly, else overlaps it clearly without itself saying the check is still pending — and the entry is shown beneath it; everything else is still required |
| `N / M verified` (two or more checks), the three results and notes before submitting | drafts in VS Code workspace state per repository + stage id; only outstanding checks take a new outcome. **Can't test** is the engine's `blocked`: the value recorded in `notes.md` is unchanged, only the word on the button says what it means to the person pressing it |
| **Submit for review**, or **Submit result and continue** in a managed plan | enabled once every requested check has an outcome. It records the drafted results as prose under `## Human evidence` in the stage's `notes.md`, the engine's own append shape — and only there: the engine reads that section live when it builds the sparring prompt, so nothing has to be mirrored into `handoff.md` any more. Then the **reviewer** runs: `sparring run-sparring <stage>` for a standalone stage, which resumes the recorded sparring session against the unchanged candidate, or the engine's own `resume-plan --evidence` inside a managed plan run, which records the evidence and resumes the sparrer against that same candidate. The stage agent is not started — there is no implementation work in handing over evidence — and nothing is frozen or accepted: the reviewer rules on its next turn, and inside a managed run the engine carries on from there by itself |
| **Additional findings or instructions**, and **Send feedback for review** | the freeform channel, independent of Pass / Fail / Can't test. It is for what a verification session actually turns up outside the reviewer's list — a reproducible crash on the way to the feature, wording that contradicts the parser, a design change to make before the checks are worth doing, or the reason the checks cannot be attempted yet. The text is a draft in VS Code workspace state (it survives rerenders, disclosures and a window reload, and is kept if the launch fails), and **Send feedback for review** works with none, some or all of the checks still unanswered. It records **no** check result: nothing becomes Pass, Fail or Can't test, `N / M verified` does not move, and **Submit result and continue** stays governed only by its own completeness rule |
| **Submitting…**, and when a draft is cleared | the exit code of the execution the submission launched, and nothing else. Launching a command is the one part of a submission that cannot fail, so it decides nothing: while the engine holds the evidence the panel says **Submitting…** and neither button is offered, and the drafted results, notes and freeform feedback are cleared *only* when that execution ends with exit code 0. A failed launch, a refused branch, a refused plan digest, a provider failure, a non-zero exit, Ctrl-C, a closed terminal or no exit code at all all keep every draft exactly as it was — as does a window reload mid-submission, which resolves against the exit code recorded for that execution. `resume-plan --evidence` records the evidence *before* it continues the plan, so a long managed run that fails at a later stage is not reported as a lost submission when the entry is already in `notes.md` |
| **Submission failed — your check results and feedback were preserved.** | shown in the panel when a submission's execution ended without recording the evidence, with the engine's own output verbatim underneath and every draft still on the page. The reassurance is first because it is the question the person is about to have; **Dismiss** removes the report and touches no draft |
| What sending feedback does | records the text verbatim under `## Human evidence` in a `### Additional human feedback` block — dated, never summarised or classified — and asks the **reviewer** to rule again on the unchanged candidate, by the same route a check result takes (`resume-plan --evidence` in a managed run, `run-sparring <stage>` standalone). The reviewer then decides: `SEND_BACK` if the feedback is an implementation defect, `NEEDS_YOU` again if the original checks still stand, revised or replaced checks if the feedback invalidated their assumptions, `READY` only where its own acceptance rules already allow it. Human feedback is evidence for that decision, not an instruction to the implementing agent — the prose is never handed to the stage agent, and this extension never routes on it. Each submission appends its own entry rather than replacing the last, and a block under that sub-heading is never matched as evidence *for a check*, however much of a check's wording it repeats |
| **Resume stage (implementation)** | the separate action, behind the panel's `…` disclosure: `run-loop`, which starts the stage agent again. Use it when there is work to do, not to hand over evidence — it is never the answer to a review |
| **Copy context for chat**, and **Copy this check** under each outstanding check | the same recorded artifacts, assembled as plain Markdown on the clipboard so the review can be pasted into a chat assistant, an issue or a message and asked about. The whole-review copy carries the repository, the plan, the stage and its goal, the routing state and the reviewer's summary and note, every gate check with its `instruction` and `pass_criteria` verbatim and the recorded result so far, the concrete names the review refers to (the gate's category, each check's stable id, the source the reviewer named), the stage agent's `## Claims` from `handoff.md`, the reviewer's `## Finding / discussion` from `sparring.md`, and the stage's own plan section. Freeform human feedback is carried too, and the workflow state it is in is never blurred: what has been sent to the reviewer appears as `## Additional human feedback` (from `notes.md`, verbatim), and what is still sitting in the field as `## Draft human feedback — not yet submitted`. A per-check copy is that check plus enough of the stage to make sense outside the extension, and carries no unrelated feedback. Nothing is composed or summarised, long quotes are cut at a line boundary and name the file they came from, and provider prompts, model reasoning, command transcripts, the self-contained handoff's embedded diff and the activity log are never included. Also `Agent Sparring: Copy Review Context for Chat` |
| **Show instructions** on the Claude or Codex card | the engine's captured prompt for that actor's latest turn: `.sparring/stages/<id>/prompts/index.jsonl` names the current capture per role, and the `.md` file beside it is the exact text the provider was handed, written at the moment it was handed over. Nothing is reconstructed and nothing is re-parsed — each section's character span comes from the engine, so what the sections show is a slice of the captured bytes. The card opens to the full width of the panel and leads with the role and the turn kind (**Implementation turn · first turn of this stage**, **Commit turn**, **Review turn · judging the evidence you recorded**, …), because that line alone is usually enough to see a stage running the wrong kind of turn. **This turn** and **Last turn** come from the same liveness as the card's own Working/Waiting word. Each section names where it came from: a file section offers to open it (`brief.md`, `PROJECT.md`, `sparring.md`, `handoff.md`, `notes.md`), and text Agent Sparring itself wrote — the branch constraint, the self-check, the scope reminder, the finalization instruction, the sparrer's verdict instruction — is labelled **Agent Sparring** rather than left looking like part of the plan. Sections over 2 000 characters start collapsed. Everything is escaped text, never rendered Markdown. A stage last run by an engine without prompt capture simply has no disclosure |
| **View exact generated prompt** and **Copy prompt** | the captured file verbatim. This is the one place the extension exports a provider prompt on purpose; **Copy context for chat** still excludes prompts entirely, because that artifact is the review and this one is the prompt |
| Plan button, this stage's section, the next stage label and "What's next" for a standalone stage | the Markdown file you associated and, when you picked one, the stage you matched (VS Code workspace state; display only) |
| A new stage started from the plan | `sparring new-stage <id>` (the engine writes the skeleton; the extension proposes the id and confirms) |
| Next stage's opening paragraph | the plan document itself (display only) |
| "The brief lists later work that is in this plan" | `Stage <label>` mentions in the current stage's `brief.md`, shown only when the plan has those headings (display only) |
| "Claude working", "Codex sparring", active-turn duration, loop cycle, last visible event, changed files, verdict chronology | `activity.jsonl` (observational only; the Overview and the Output Channel share one filter for what counts as visible activity) |
| Goal paragraph in the Overview | `## Goal` in the current stage's `brief.md`, else the brief's own opening description (the plan section a generated brief embeds), else the plan section's opening paragraph. When there is none the section is omitted: a brief without a `## Goal` heading is a fact for `Agent Sparring: Diagnose`, not a Markdown complaint on the stage screen (display only) |
| **Also reviews** — a stage's sibling repositories | *pinned by the engine* and *recorded for this stage* come from `repositories` in that stage's `state.json` (with the commit only when the freeze has pinned one); *declared in VS Code* is a declaration in workspace state that the engine has not written yet. Nothing here claims a sibling was reviewed or is current |

| **Continue plan automatically** on a standalone stage | the associated plan plus the stage directories on disk. It creates a managed run (`run-plan --manifest … --adopt`); it never edits a stage. A stage already stopped at NEEDS_YOU or ESCALATE keeps that pause — the engine reads the recorded verdict and stops there, running neither agent |
| A rebuilt manifest's `source_digest`, and why editing the plan's prose no longer ends a run | the manifest is regenerated on every invocation, and the engine folds `source_digest` — a hash of the whole plan document — into the digest that identifies a recorded run, refusing to continue when it changes. Recording a `## Stage 3D handoff — 2026-09-14 (…)` section in the plan, which the manifest builder deliberately excludes from execution and which the engine's own `plan_digest` says does not count, therefore used to end the run: a real managed run answered *the executable content of … has changed since this run started* with all eight executable stages byte-identical. So provenance is **carried forward**: when the manifest that would be written executes exactly what the manifest on disk executes — same version, plan label and stages, with the same ids, labels, titles, briefs and sibling repositories — it keeps that file's `source_digest`. Any difference in what would execute takes the new hash and the engine refuses exactly as before |
| The journey of a manifest run, and the stage's own name | the execution manifest the run was handed (read back from the extension's global storage), plus each stage's own `state.json` for its status. So a manifest run's stage is called `Stage 3D — …` as the plan calls it, its position (`6 of 8`) is secondary metadata, and the journey shows every stage of the manifest. Shown only when the run's recorded current stage is one of the manifest's — a file describing a different sequence is ignored, and then only the recorded stage is shown |
| The stage name of a *standalone* stage | the plan section it is matched to, when there is one (`Stage 3C — Cloud schema/RPC and sync transport`); otherwise its stage id, made readable. The id itself stays in the tooltip and the footer |

Deleting `activity.jsonl` removes the live decoration and nothing else.

### Terminals

There is **one reusable terminal per project**, `Agent Sparring — <project>`.
Run stage, Accept stage, run-plan and every resume-plan of a long managed run
share it, so a plan does not leave a row of dead tabs behind. It is leased for
the duration of each command: a terminal that is busy is never sent a second
one (a second terminal is opened instead), a terminal you closed is replaced,
and projects never share one. Only terminals the extension opened are ever
written to — a command you type in your own terminal is observed, never
interrupted.

Terminal identity is not liveness. Every shell execution is tracked
separately, so a finished command can never keep the Overview `Running`
because its terminal is still open, and Stop still reaches exactly the
terminal hosting the live execution.

### Which run the Overview follows

In order:

1. the run you chose explicitly, while that choice still holds;
2. the active managed plan run of the project;
3. the active standalone stage;
4. otherwise the remembered run, then the most recent finished one.

A choice stops holding when a managed plan run of the same project has
**advanced past** the finished stage you had chosen — which is what happens
when a stage you adopted is accepted and the engine moves to the next one.
The Overview then follows the managed run to its current stage. Every "a
runner is already alive" message offers **Show running plan** too, rather
than leaving you on a screen whose buttons cannot work.

### Plan run, historical stage, plan document

Three things, and the UI keeps them apart:

| | What it is | How to get to it |
| --- | --- | --- |
| **Plan run** | the whole job: the engine sequences its stages, records where it is, and the Overview draws the timeline | the *Plan runs* group of Select Repository / Run; **Back to plan run** from one of its stages |
| **Historical stage** | one finished stage of a plan run — good for inspecting its brief, handoff, review, diff and log | the *Standalone / historical stages* group |
| **Plan document** | the Markdown specification | **Plan document** / **Open plan section**, which open an editor and change nothing about which run is selected |

A stage is known to belong to a plan run when the **execution manifest that
run executes** lists its id. That is why a stage of a plan whose document the
engine's `## Stage <n>` parser refuses — one carrying `## Stage 3D handoff —
…` records — is still named `Stage 3D` and still knows where it came from,
and why nothing is claimed when no recorded run lists it.

Such a stage reads *Historical stage*, is named as its own run
names it, and offers **Back to plan run** as its primary action; that button
changes the selected run, so the timeline comes back. What the plan run owns
is withheld there: **Continue plan automatically** is not offered (whether
that run is still going or complete — adopting stages a managed run already
owns could only be refused, or start a second run over finished work), and
neither is **Start next stage** for a stage the engine has already created.

### Runner lifecycle

Two things are kept strictly apart:

- **Actor activity** comes from `activity.jsonl`: a turn was observed
  starting, a verdict was observed. It says what the engine last reported and
  never proves the `sparring` process is alive; an unmatched `turn.started`
  is exactly what Ctrl-C, a crash or a window reload leave behind.
- **Runner liveness** comes only from observing the process, and is one of
  `running`, `stopped` or `unknown`. Telemetry alone is never promoted to
  `Running`.

Liveness sources, most exact first:

| Source | How it is observed | Ends when |
| --- | --- | --- |
| Launched from the extension | This project's integrated terminal (your normal shell, cwd = project) runs `sparring` through the terminal shell-integration API with an argument array (see "Free-text arguments" for the one case that is quoted here instead). | The shell-execution end event fires (normal exit, non-zero exit, Ctrl-C), another command starts in that terminal, or the terminal closes. |
| Dedicated terminal (fallback) | Only if shell integration does not activate within 5 s: a terminal whose process *is* `sparring` (argument array, no shell). | That terminal closes, which VS Code does as soon as the process exits. |
| Typed in an integrated terminal | Shell integration reports the command line and cwd; `sparring run-loop <stage>`, `run-plan` and `resume-plan` are recognised and tied to the project by `--repo-root` / `--sparring-dir` / cwd (nested projects match their own root). | Same as a launched command. |
| Re-found after a window reload | Launches are recorded in `workspaceState`; after a reload the hosting terminal is re-found by process id and, on macOS/Linux, a `ps` probe checks that the runner still runs under it. | The probe no longer finds it, or a shell execution starts/ends in that terminal. On Windows the state stays `unknown`. |
| Outside VS Code / before activation | Nothing observes the process. | Never known; telemetry describes activity and liveness is labelled unknown. |

What the UI shows:

- Runner known alive: **Running** (non-clickable, exact), `Claude working for
  3m 12s`, and **Stop (Ctrl-C)**, which sends Ctrl-C to that exact terminal.
  No second loop can be launched.
- Runner known ended while telemetry still had an actor mid-turn: the busy
  claim is cleared for presentation, the duration stops, the Overview shows
  **Stopped · last turn interrupted** and **Runner stopped**, the status bar
  says `· stopped`, and **Resume stage** returns. A turn that started *after*
  the observed end is a new observation and is not masked; late or replayed
  telemetry with an older timestamp can never re-arm `Running`.
- Only telemetry claims a turn (external run, or right after a reload with
  nothing re-found): **Run status unknown** instead of Run/Resume, the
  activity line reads `Turn started 3m 12s ago · Claude · runner status
  unknown`, the actor card `Working? (turn observed 3m 12s ago)`, and the
  status bar `Claude working (unconfirmed)`. The command
  `Run / Resume Stage` can override this only through an explicit modal
  confirmation; the engine's worktree lock refuses a second live runner anyway.
  A busy claim with no telemetry for 30 minutes is additionally flagged
  stale; silence is information, never a death detector.
- Accepted stages have no action; a stage stuck in the engine's frozen
  state offers **Accept stage** again, whatever the telemetry says.

Engine state (`state.json`, `activity.jsonl`) is never modified; all of this is
presentation and liveness state inside the extension.

**Developer: Reload Window.** Because the launched command runs inside a
normal shell terminal, whether it survives a reload is VS Code's ordinary
terminal persistence (`terminal.integrated.enablePersistentSessions`, on by
default; terminals created by extensions are persisted unless marked
transient). VS Code exposes no API for "which command is currently running
in this reconnected terminal", so the reloaded extension re-establishes
liveness from the recorded launch: terminal gone → `stopped`; terminal
present and the `ps` probe finds the runner → `running`; terminal present
without a probe (Windows) → `unknown`. It never turns the replayed
`turn.started` into `Running`.

#### Manual verification

A. Ctrl-C

1. Open the Overview, select a working standalone stage, click **Run stage**.
2. Confirm **Running** and, once the first turn starts, `Claude working for …`.
3. Focus the `Agent Sparring: Run stage: <stage>` terminal and press Ctrl-C.
4. The Overview and status bar leave `Running` immediately (no wait for
   telemetry): **Stopped · last turn interrupted**, status bar `· stopped`.
5. Wait a minute: the duration is gone and does not grow.
6. **Resume stage** is offered; the Output Channel logs the exit.

B. Developer: Reload Window

1. Click **Run stage**; confirm **Running** and live telemetry.
2. Run `Developer: Reload Window`.
3. After reload, check the terminal: is the `sparring` command still printing
   (survived) or did the shell return to a prompt / disappear (killed)? Note
   the result; it depends on VS Code's persistence, not on the extension.
4. The reloaded extension must not show `Running` from the replayed
   telemetry: within ~6 s it shows **Running** only if the runner was
   re-found, otherwise **Stopped · last turn interrupted** (terminal gone)
   or **Run status unknown** (terminal open, no probe). The Output Channel
   logs which case applied.
5. If it survived: telemetry keeps flowing and **Stop (Ctrl-C)** still
   targets the right terminal.
6. If it did not survive: **Resume stage** is offered.

## Develop

```sh
npm install
npm run build      # typecheck + esbuild bundle to dist/
npm test           # node:test unit tests against fake .sparring fixtures
npm run lint
npm run test:integration   # downloads VS Code once, opens a generated multi-root workspace, asserts discovery, runner lifecycle, bare-`sparring` resolution by the shell, command-not-found, Accept stage and plan association with a fake `sparring`
```

Press F5 in VS Code to launch an Extension Development Host.

## Install locally

```sh
npm install
npm run package:vsix                     # writes agent-sparring-vscode-<version>.vsix
code --install-extension agent-sparring-vscode-0.1.0.vsix
```
