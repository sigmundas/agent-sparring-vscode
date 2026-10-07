# Agent Sparring for VS Code documentation

Start with the [extension overview and suggested workflows](../README.md).
These pages cover setup, detailed behavior and the extension's technical contracts.

| Page | What it covers |
| --- | --- |
| [Set up the extension](setup.md) | Requirements, planning plugin, first run, platform support and VSIX installation |
| [Configuration](configuration.md) | Models and effort, project settings, executable resolution and free-text arguments |
| [Commands](commands.md) | Command Palette and Runs sidebar actions |
| [Workflows](workflows.md) | Run Plan, legacy and per-stage continuation, review-only stages, fresh sessions, deferred checks and push authorization |
| [Plans and run selection](runs.md) | Plan associations, stage matching, run identity, repository following and history |
| [Displayed state](state.md) | Which engine artifact supports each displayed fact, human evidence and captured prompts |
| [Terminals and runners](runners.md) | Command submission, process liveness, reload recovery and manual verification |
| [Development](development.md) | Build and test commands, manifest parity, integration harness limits and known follow-ups |

Two plans are retained in the repository:

- [Colleague sharing](https://github.com/sigmundas/agent-sparring-vscode/blob/main/docs/plans/colleague-sharing.md)
  is a completed example of a staged implementation plan.
- [Windows extension](https://github.com/sigmundas/agent-sparring-vscode/blob/main/docs/plans/windows-extension.md)
  describes proposed Windows support.

Use the reference pages above for current behavior.

The [engine documentation](https://github.com/sigmundas/agent-sparring/blob/main/docs/README.md)
covers engine installation, plan formats and CLI behavior.
