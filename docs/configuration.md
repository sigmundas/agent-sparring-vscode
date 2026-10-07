# Configuration and executable resolution

[Documentation index](README.md) · [Extension overview](../README.md)

- [Which model and effort the agents run at](#which-model-and-effort-the-agents-run-at)
- [Settings](#settings)
- [Executable resolution](#executable-resolution)

## Which model and effort the agents run at

**Model and effort are your own preferences**, not project configuration.
They are kept per role (stage agent, sparrer) *and per provider*, in one
engine-owned file outside every repository, whose path the engine reports.
Every project you open shares them, and changing one never dirties a
repository. **The provider is still a project setting**: it lives in the
repository's `.sparring/project.toml` under `[agents.stage]` and
`[agents.sparring]`. The engine resolves each value as: command-line flag,
then environment, then your preference, then the provider's own default.
This extension adds **no** VS Code setting that could override any of it.

The Overview's actor cards show what the *next* provider turn would run with,
for example:

```text
Stage agent   Model: claude-opus-5-5 · Your preference
Sparrer       Model: Provider default
```

Every one of those values is the engine's own answer, obtained by running
`sparring show-config --json`. The extension does not parse TOML, does not
know which providers or effort levels exist, and does not decide precedence.
An exact configured model is stated with where it came from; no configured
model reads **Provider default**, drawn quietly, which is a different fact
from any model and never a guessed name. An effort that is unset — or that
the provider has no concept of — is not rendered as a level.

The model a provider *reported running* is a third, separate fact. When the
provider stated it (the stage's `session.observed` telemetry), the card says
"Provider reported running …" beneath the configured value; when it did not,
nothing is claimed.

Each card's **Technical details** lists the engine's facts for the role: role
id, provider id and its source, the user preferences file, the configured
model (or none) and its source, effort and its source, where the model
suggestions came from, and the runtime-reported model if known.

If the engine cannot answer (an older engine without `show-config`, or one
this window cannot resolve), the section says so in one line and the rest of
the Overview is unaffected. If the engine reports the configuration as
invalid, its own sentence is shown and no role values are displayed.

### Changing it from the Overview

Each role's **Model** and **Effort** are dropdowns on its card.

**Model** offers, in order: *Provider default* (clears your preference);
the model currently configured, even when no suggestion names it; the
engine's suggestions for exactly that role and provider; and **Other exact
model…**, which asks for an exact model id and sends it to the engine as one
argument, never through a shell; the input refuses an empty id and one
beginning with `-` before the engine is asked, and any refusal the engine
returns is still shown in its own words. The suggestions come from
`sparring model-choices --json` — for Codex the provider's own catalog, for
Claude the models the engine knows — and are only suggestions: they are
never a validation boundary; a list the engine does not call complete says
"not a complete list" in the dropdown's tooltip. A list for one
provider is never offered for another. They are read once per session per
role and provider (the Codex catalog spawns `codex`) and read again on an
explicit **Refresh**. The engine refuses a Claude alias such as `opus` as a
saved model, because it is not an exact model; its sentence is shown.

**Effort** lists the levels the engine reported for that role's provider,
with *Provider default* first. This extension contains no list of effort
levels. A provider with no effort setting gets no dropdown.

**Provider** is shown rather than chosen while the engine reports one
provider for the role. It becomes a dropdown as soon as the engine reports a
second, and a provider change is written to `project.toml` by the engine.

A model or effort change runs `sparring set-config <role> --model … |
--effort … --for-provider <provider on the card> --json`, which writes your
preference file; there is no per-worktree override and no "Project setting"
option. **Nothing in this extension writes a configuration file**, and a
test asserts that nothing does. Afterwards the effective configuration is
re-read with `show-config` and the controls are redrawn from the engine's
answer — never from the value that was requested — so a refused change
leaves the engine's diagnostic on screen and its value in the control.
Switching repositories re-reads `show-config` for the new repository, which
reports the same preference while the role and provider are the same.

**A stage keeps one configuration for its whole life.** Before a stage's
first provider turn the engine records what each role runs with in the
stage's `state.json` (`agents`), and every later turn of that stage —
SEND_BACK, a resume in a new process, finalization — reuses it. Editing your
preference stays allowed at any time, and whenever the selected stage is in
progress (running or paused) the Agents area says **Applies from the next
stage.** When the stage's pin differs from your current preference, the card
also says what this stage runs with ("This stage: claude-opus-5-5 · high"),
and the pin is in the role's Technical details. The pin is shown, never acted
on: nothing is rebuilt or switched mid-stage.

A change carries the `project.toml` its control was drawn from, and is
applied only if that is still the repository this window is looking at, so
a control left open across a repository switch is refused and redrawn. A
control is disabled while its own change is in flight, and changes are
carried out one at a time.

### Obsolete project model/effort settings

Older projects may still set `model` or `effort` in `project.toml`. The
engine no longer reads them and reports each as a setup problem; the
Overview shows **Agent configuration needs updating** — "Model and effort
are now your own preferences, shared by every project. This project still
has old model/effort settings." — with the engine-owned **Fix
configuration** button. It runs `sparring fix-config --json`, which removes the
keys and chooses no preference in their place; commit the file afterwards.
Role, field, value, config path and the engine's own message are under
Technical details.

While they are there the engine refuses every command that starts a provider
turn (`run-plan`, `resume-plan`, `run-loop`, `run-sparring`, …). So Run Plan,
Resume Plan, Continue automatically, Run/Resume stage and a review turn first
read `show-config` afresh and, when it reports an obsolete setting, launch
nothing: they say so in plain words with the same **Fix configuration**
action, instead of opening a terminal that would fail. This is decided from
the engine's `setup_problems`, never from its error text.

**Settings**, beside the cards, still opens `project.toml`, where the
provider is set.

## Settings

- `agentSparring.executable` — full path to `sparring`. Empty (the default)
  lets terminal launches use your integrated shell's `PATH` when shell
  integration is available. Preparation, capability probes and direct
  processes use the extension host's `PATH`; set the full path if those
  cannot find your engine. See "Executable resolution" below.
- `agentSparring.planContinuation` — `automatic` (default) or `manual` for
  the legacy Run Plan fallback and per-stage continuation controls. When
  `start-plan` is supported, the engine prepares Run Plan regardless of this
  setting. See [Two ways to progress a plan](workflows.md#two-ways-to-progress-a-plan).
- **Make Plan…** does not use `agentSparring.executable`: it looks up `claude`
  or `codex` on the extension host's `PATH` (see [First run](setup.md#first-run)).
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
| Nothing configured, submitting free text (`--evidence`, `--deferred-result`) | The same host `PATH` search, because no shell is involved to do the resolving (see "Free-text arguments never go through a shell"). | Same message. If your shell finds `sparring` but VS Code's environment does not — a venv activated only by your shell profile, for instance — set `agentSparring.executable` to the full path and every route works. |

Run Plan capability detection and preparation (`start-plan --help` and
`start-plan --json`) use a direct process and the extension host's `PATH`.
If the probe cannot resolve the engine or confirm support, Run Plan uses the
legacy fallback. Set `agentSparring.executable` to the full path to make the
engine available to preparation as well as terminal launches.

Short commands (Accept stage) use the same rule: your shell through shell
integration when available (the output is read back for translation and
the log), otherwise a direct process with a host-resolved path.

A configured or host-resolved path is checked before anything runs, so a
bad exit code from *that* is the command's own: the extension reports
`sparring <subcommand> exited with code N` with what it printed, and never
sends you to the executable setting for an executable it just ran. The full
output is in the Output Channel.

### Free-text arguments never go through a shell

`resume-plan --evidence` carries a whole `## Human evidence` entry — a gate
check's backticked id, the note you typed, several lines — and
`--deferred-result` carries your answer to a manual check. Those do not need
shell semantics and are never given any.

Such a command is classified `no-shell` before anything else happens
(`core/cli.ts`, `transportSafety`) and runs as the process of its own
**Agent Sparring** terminal: the `sparring` executable *is* that terminal's
process and the argument array is passed straight to it, so your text reaches
the engine as one argument, byte for byte, with no interactive line editor, no
`shell -c` and no quoting of any kind in between. The terminal still shows the
engine's output. Every other invocation — flags, stage ids, paths — is
unaffected and still goes to your own shell through VS Code's escaping.

On macOS and Linux that is exact: the argument vector is what the process is
started with. On Windows it is one step less certain — there is no argv to
pass through ConPTY, so the arguments are reassembled into a command line and
parsed back by the engine's own runtime. That transform is meant to be
invertible and in practice is, but it is not tested here, so treat the
byte-for-byte guarantee as proven on POSIX and expected on Windows.

This is not a preference. Two earlier versions did encode the entry into a
single command line — first POSIX `'…'`, then ANSI-C `$'…'` — and both failed
in use, because an interactive shell on a pty stops accepting a command line
after roughly 1968 bytes and a real four-check entry is larger than that. The
line was cut off part-way through and no engine process appeared. No encoding
survives that, since the limit is on the line and not on its syntax.
