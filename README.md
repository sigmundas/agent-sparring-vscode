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
  argument array, no quoting) and observes when the process ends; see
  "Runner lifecycle".
- **Continues a whole plan automatically**: interprets the plan document once
  into an execution manifest and hands it to the engine's managed run, which
  then goes from stage to stage on its own and stops when it needs you. One
  confirmation, at the start. See "Two ways to progress a plan".

## Commands

| Command | Effect |
| --- | --- |
| `Agent Sparring: Run Plan` | Pick a plan Markdown file (`## Stage <n> — <title>` headings), confirm the branch, launch `run-plan`. |
| `Agent Sparring: Resume Plan` | Pick a paused/running plan run, optionally record human evidence, launch `resume-plan`. |
| `Agent Sparring: Run / Resume Stage` | For the selected standalone stage (or after picking one), launch `sparring run-loop <stage> --repo-root <project> --expected-branch <current branch>` in a terminal. The branch comes from the Git repository owning the project (built-in Git API, then `.git/HEAD`); a detached HEAD is refused, never guessed. Also offered as **Run stage** / **Resume stage** in the Overview. |
| `Agent Sparring: Accept Stage` | For a stage whose independent review passed (**Review complete**): one action that runs the engine's `freeze-candidate` and, only if that succeeds, `accept-candidate` for the selected stage, project and current branch. Refusals are translated (uncommitted changes, not pushed, wrong branch, code changed after the review); the engine's own output goes to the Output Channel. Also offered as **Accept stage** in the Overview. |
| `Agent Sparring: Choose Plan for Stage…` | Associate a Markdown plan file (any location, ordinary file picker) with the selected standalone stage. Stored in VS Code workspace state per repository + stage id, never in engine state; gives the Overview a **Plan** button, this stage's place in the document and, once accepted, **What's next**. Change or remove it the same way. |
| `Agent Sparring: Match Stage to Plan Section…` | When the Overview cannot tell which stage of the associated plan the selected stage is, pick it from the plan's stages (also **Match this stage…** / **Change match…** in the Overview). Stored with the association in VS Code workspace state, never in engine state. |
| `Agent Sparring: Start Next Stage from Plan…` | For an accepted standalone stage with an associated plan: create the stage that follows it (by stage label) with the engine's own `sparring new-stage <id>`, after a confirmation naming the title, the proposed id and the plan section. The Overview switches to the new stage, the plan association follows it, and its fresh `brief.md` opens beside the plan section for you to fill in before **Run stage**. Also **Start next stage** in the Overview. |
| `Agent Sparring: Continue Plan Automatically` | Build the execution manifest for the plan of the selected run and start (or resume) the engine's managed plan run against it: `sparring run-plan --manifest … [--adopt]` / `sparring resume-plan --manifest …`. The engine then sequences the stages itself. One confirmation before the first stage; none between stages. Also **Continue automatically** in the Overview. |
| `Agent Sparring: Choose sparring Executable…` | Pick the `sparring` CLI with a file dialog and store it as `agentSparring.executable`. |
| `Agent Sparring: Open Overview` | One editor-area Run Overview panel: compact plan journey (accepted / current / paused / finalizing / future stages), the current stage as primary content (`Stage N — title`, a human state word with one explaining sentence, loop cycle, the Goal paragraph from `brief.md`, `Working for Xm Ys` or the last visible event), latest sparring result, small Stage Agent / Sparrer cards, Brief / Handoff / Sparring report / Diff / Plan / Log buttons, and quiet metadata (where the engine's own words live). Never auto-opens; updates in place. |
| `Agent Sparring: Show Log` | Focus the Output Channel. |
| `Agent Sparring: Select Run` | Choose explicitly when several runs look active; the choice is remembered per workspace. |
| `Agent Sparring: Rediscover State` | Re-scan `.sparring` from disk. |
| `Agent Sparring: Diagnose Discovery` | Trace discovery for every workspace folder into the Output Channel: scheme, path, the `.sparring` probed, nested projects, stage/plan files and whether they parsed (lifecycle status only), runs produced, what Select Repository / Run would list, and why nothing is selected. Never logs file contents. |

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
| Nothing configured, terminal shell integration available (the normal case) | Your integrated shell receives `sparring` plus the argument array through the shell-integration API; the shell's own `PATH`, venv activation and profile apply. Nothing is pre-checked from the extension host. | If the shell itself reports the command as not found (exit 127, or 9009 on cmd.exe), the extension says so and offers **Open Settings** / **Choose executable…**. |
| `agentSparring.executable` set | Exactly that path (relative paths resolve against the project). It is validated before anything is launched. | `agentSparring.executable points at …, which does not exist or is not executable.` |
| Nothing configured, no shell integration within 5 s | A best-effort `PATH` search in the extension host, then a dedicated terminal whose process is `sparring`. | `Agent Sparring could not resolve the CLI from this VS Code environment. Set agentSparring.executable to the full path.` (never a suggestion to reinstall the engine). |

Short commands (Accept stage) use the same rule: your shell through shell
integration when available (the output is read back for translation and
the log), otherwise a direct process with a host-resolved path.

## What the words mean

The Overview and status bar use one plain vocabulary; the engine's own
words stay in tooltips, the metadata footer and the Output Channel.

| Shown | Meaning | Engine state behind it |
| --- | --- | --- |
| **Working** | Implementation or independent review is happening (or a correction turn is running after a finding). | stage `working`; a live turn in `activity.jsonl` |
| **Changes requested** — *The independent reviewer found something to fix. Work will continue automatically.* | The sparrer sent the stage back; the loop continues on its own. | routing action `SEND_BACK` |
| **Needs you** — *the reviewer's request* | Only you can do the next thing. The header pill names it once; one **Action required** panel explains it (see *Manual verification* below). | routing action `NEEDS_YOU` |
| **Evidence ready** — *Evidence ready for review* | Same routing action, but every check the reviewer asked for now has a recorded outcome. One primary button, **Submit for review**, hands the evidence back to the reviewer. | routing action `NEEDS_YOU` + `## Human evidence` and the outcomes recorded here |
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

**Pause after each stage** (`manual`) keeps the per-stage checkpoints below
unchanged, for when you want to look before every provider turn. In automatic
mode those actions are still there, just no longer the obvious path.

## Plans: managed runs and associated files

- A **managed plan run** is the engine's `.sparring/plans/<key>.json`. It is
  authoritative: the Overview shows the journey, **Plan** opens the recorded
  document, and after the current stage is accepted **Continue plan** calls
  `sparring resume-plan`, which advances past the accepted stage and starts
  the next one (paused runs get **Resume plan**).
- A **standalone stage** has no machine-readable plan. **Choose plan…** lets
  you pick any Markdown file (no directory convention is assumed). The
  association is VS Code workspace state keyed by repository + stage id;
  the engine never sees it. The Overview then shows **Plan** and this
  stage's place in the document. Because the engine has no operation that
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
| Managed plan run, a stage follows | the engine's next stage, its opening paragraph from the plan, **Continue plan** (`resume-plan`), **Open in plan** |
| Managed plan run, last stage | *No stage follows this one in the plan.* and **Continue plan** |
| Standalone stage, plan linked and matched, next stage defined | `Stage 3C — title`, its opening paragraph, **Start next stage**, **Open in plan**, **Change match…** |
| Standalone stage, next stage ambiguous or only mentioned historically | the label and why it cannot be started; **Open in plan** |
| Standalone stage, no later label / plan without labels | *No later stage is defined in …* / the plan has no "Stage …" labels; **Open plan** |
| Standalone stage, plan linked but not matched | *The plan is linked, but Agent Sparring doesn't yet know where this stage belongs in it.* **Match this stage…**, **Open plan**; plan stages the brief lists as later work are shown as a hint |
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
| **What the reviewer requires** — the Pass / Fail / Blocked list | the structured `human_gate` of the recorded verdict: the JSON block behind the `<!-- human-gate:v1 -->` marker in `sparring.md`. One control per `checks` entry, in the reviewer's order, showing its instruction, its *Pass when* criteria and the plan reference it names, keyed by its stable `id`. Nothing is added from the plan and nothing is inferred from prose — the engine requires a NEEDS_YOU to name what blocks the stage, and things the reviewer says about *after* acceptance (deployment, rollout, monitoring) belong to `findings`/`deferred` and are not shown as checks |
| **Reviewer note** | `sparring.md`'s needs-you reason: one compact line, verbatim |
| the same panel for a verdict recorded **before** structured gates existed | the legacy derivation, unchanged: task-list items under the matched plan section's `### Manual verification` heading 1:1, else its human-worded list items as prose parents, plus the request clauses of `## Deferred` (else of the reason) split at sentence and semicolon boundaries and tagged *Reviewer*. The plan file is never modified (its stage sections are digest-guarded) |
| **Evidence already recorded** vs **Still required** | the `## Human evidence` section of the stage's `notes.md`: a check is recorded when an entry names its stable gate id (`· check \`…\``, which is why a result survives the reviewer rewording the same check), else names it exactly, else overlaps it clearly without itself saying the check is still pending — and the entry is shown beneath it; everything else is still required |
| `N / M verified`, Pass / Fail / Blocked and notes before submitting | drafts in VS Code workspace state per repository + stage id; only outstanding checks take a new outcome |
| **Submit for review** | enabled once every requested check has an outcome. It records the drafted results as prose under `## Human evidence` in the stage's `notes.md`, the engine's own append shape — and only there: the engine reads that section live when it builds the sparring prompt, so nothing has to be mirrored into `handoff.md` any more. Then the **reviewer** runs: `sparring run-sparring <stage>` for a standalone stage, which resumes the recorded sparring session against the unchanged candidate, or the engine's own `resume-plan --evidence` inside a managed plan run, which records the evidence and resumes the sparrer against that same candidate. The stage agent is not started — there is no implementation work in handing over evidence — and nothing is frozen or accepted: the reviewer rules on its next turn, and inside a managed run the engine carries on from there by itself |
| **Resume stage (implementation)** | the separate, quiet action: `run-loop`, which starts the stage agent again. Use it when there is work to do, not to hand over evidence |
| Plan button, this stage's section, the next stage label and "What's next" for a standalone stage | the Markdown file you associated and, when you picked one, the stage you matched (VS Code workspace state; display only) |
| A new stage started from the plan | `sparring new-stage <id>` (the engine writes the skeleton; the extension proposes the id and confirms) |
| Next stage's opening paragraph | the plan document itself (display only) |
| "The brief lists later work that is in this plan" | `Stage <label>` mentions in the current stage's `brief.md`, shown only when the plan has those headings (display only) |
| "Claude working", "Codex sparring", active-turn duration, loop cycle, last visible event, changed files, verdict chronology | `activity.jsonl` (observational only; the Overview and the Output Channel share one filter for what counts as visible activity) |
| Goal paragraph in the Overview | `## Goal` in the current stage's `brief.md` (display only) |

Deleting `activity.jsonl` removes the live decoration and nothing else.

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
| Launched from the extension | A fresh integrated terminal (your normal shell, cwd = project) runs `sparring` through the terminal shell-integration API with an argument array; no quoted command line is built. | The shell-execution end event fires (normal exit, non-zero exit, Ctrl-C), another command starts in that terminal, or the terminal closes. |
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
