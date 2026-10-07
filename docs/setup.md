# Set up Agent Sparring

[Documentation index](README.md) · [Extension overview](../README.md)

- [First run](#first-run)
- [Install locally](#install-locally)

## First run

### What you need

| Component | Required? | Notes |
| --- | --- | --- |
| VS Code 1.93 or newer | Required | The minimum declared in `package.json` (`engines.vscode`). |
| Python 3.11 or newer | Required | For the engine. |
| The `agent-sparring` engine (`sparring` CLI) | Required | Installed separately; this extension does **not** include it. |
| `claude` and `codex` CLIs, signed in | Required for the default setup | The default project config uses both providers. Neither is bundled with the extension. |
| A Git repository with a writable intended remote | Required | See "Git and pushing" below. |
| Per-project settings (`project.toml`) | Required, once per repository | Created by the engine's `init-config` (**Open Project Settings** → **Create project settings**). Test commands and project conventions belong there and in the project's own context, not in the extension. |
| agent-sparring Claude Code plugin | Optional | Needed only for **Make Plan…** (both with Claude and with Codex). You can write a plan by hand instead. |

The engine repository is currently private. You need access to it to follow
the installation and Quickstart links or install its planning plugin. Readers
without access will see a GitHub 404.

Nothing database-specific is needed for ordinary runs; the engine's optional
Supabase migration parser only matters to projects that use it.

### Git and pushing

The engine works in your repository's Git history. Accepting a stage needs
the reviewed commit to be available on the repository's intended remote, so
that remote must exist and you must have permission to push to it. When the
reviewed commit is not yet there, the engine pauses and the Overview asks you
to allow the push (see [Push authorization](workflows.md#push-authorization)); the extension itself never
runs `git push`.

### Platform support

- **macOS and Linux:** supported.
- **Native Windows:** not supported in the current release. Some code paths
  already account for Windows, but no end-to-end run is verified there; a
  port is left for future contribution.
- **WSL / Remote - WSL:** a separate route that has not been verified. If
  you try it, install the engine and the provider CLIs *inside* WSL and open
  the repository through the Remote - WSL window, and verify it yourself.

### Steps

1. Install the engine and set up your repository as its
   [QUICKSTART](https://github.com/sigmundas/agent-sparring/blob/main/QUICKSTART.md)
   describes: `sparring` on your shell's `PATH`, with the `claude` and `codex`
   CLIs signed in.
2. Install this extension (see [Install locally](#install-locally)).
3. Get a staged plan. Either write one by hand under `docs/plans/` following
   the engine's plan format, or run **Agent Sparring: Make Plan…**, choose
   the idea, INBOX or notes file and Claude or Codex. Make Plan opens that
   agent in a terminal with the Agent Sparring planning skill
   (`/agent-sparring:sparring-plan`), which audits the repository and writes
   a staged plan under `docs/plans/` without implementing or running
   anything. Review the generated plan.
   **Run Plan starts from an existing document.** With a compatible engine,
   it can prepare an execution plan and ask you to resolve decisions before
   starting. Use **Make Plan…** to turn an idea into a reviewed staged plan.

   Make Plan setup:
   - Install the planning skill: in Claude Code run
     `/plugin marketplace add sigmundas/agent-sparring`, then
     `/plugin install agent-sparring@agent-sparring`. **Codex currently reads
     the same skill file from the installed Claude Code plugin**
     (`~/.claude/plugins/installed_plugins.json`), so the plugin is needed
     even when you plan with Codex.
   - Make Plan finds `claude` or `codex` on the `PATH` the extension host
     (VS Code) was started with, not your integrated shell's `PATH`. If it
     reports the CLI was not found, start VS Code from a shell where the CLI
     is on `PATH` (for instance `code .`), or write the plan by hand.
4. Open the repository and run **Agent Sparring: Open Project Settings**.
   A repository without any `.sparring` state yet is fine. Running any Agent
   Sparring command activates the extension; **Create project settings**
   runs the engine's `init-config` if settings do not exist yet.
5. Run **Agent Sparring: Open Overview**. On its **Stage agent** and
   **Sparrer** cards, pick your model and effort. These are your own
   preferences, shared by every repository that uses the same provider for that role, and are never
   written to the repository. Leave them at **Provider default** to let each
   provider choose.
6. Run **Agent Sparring: Run Plan**, select the document and confirm the
   branch. Review the Run Plan screen, answer any decisions the engine asks,
   and press **Start** when it is ready. Preparation may use a read-only provider
   turn before this confirmation. Older engines use the fallback described
   in [Two ways to progress a plan](workflows.md#two-ways-to-progress-a-plan).
7. After that, the **Overview** is where you continue a paused run, answer
   checks, accept stages and apply setup fixes. Every one of those is an
   engine command.

If the integrated terminal can't find `sparring`, run **Agent Sparring:
Choose sparring Executable…** (see [Executable resolution](configuration.md#executable-resolution)).

## Install locally

From a clone of this repository:

```sh
npm install
npm run package:vsix                     # writes agent-sparring-vscode-<version>.vsix here
npm run check:vsix -- agent-sparring-vscode-0.1.0.vsix  # verify the packaged files
code --install-extension agent-sparring-vscode-0.1.0.vsix   # use the filename it printed
```

Or, in VS Code, **Extensions: Install from VSIX…** and pick that file. The
VSIX contains only the extension: install the engine and the provider CLIs
separately (see "First run").
