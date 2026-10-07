# Agent Sparring for VS Code

Run staged coding plans with an implementation agent and an independent reviewer,
and follow their progress from VS Code. The
[agent-sparring engine](https://github.com/sigmundas/agent-sparring) owns execution,
verification and acceptance; the extension presents its state and invokes its commands.

![Agent Sparring Overview showing a completed three-stage plan, stage agent and reviewer cards, and recent events](docs/Screenshot%202026-10-07%20at%2013.09.32.png)

## What it does

- **Plan and run work:** create a staged plan with Claude or Codex, review what
  will run, then start it from the Overview.
- **Follow implementation and review:** see the plan's stages, current activity,
  agent settings and review results in one place.
- **Handle pauses:** answer human checks, send feedback to the reviewer and
  continue when the engine is ready.
- **Navigate your work:** follow the active repository, inspect earlier runs,
  and open briefs, handoffs, diffs and captured agent instructions.

## Get started

You need **VS Code 1.93+**, the separately installed **agent-sparring engine**
(Python 3.11+), signed-in **Claude and Codex CLIs** for the default setup, and a
Git repository with a writable remote. The engine repository is currently private;
you need access to install it and read its Quickstart.

**macOS and Linux are supported.** Native Windows is not supported in this release;
WSL has not been verified.

1. Follow the engine's
   [Quickstart](https://github.com/sigmundas/agent-sparring/blob/main/QUICKSTART.md)
   to install `sparring` and the provider CLIs.
2. Install the extension with **Extensions: Install from VSIX…**.
   To build a VSIX from this repository, see [Install locally](docs/setup.md#install-locally).
3. Open your repository and run **Agent Sparring: Open Project Settings**.
   Choose **Create project settings** if this is its first run.
4. Run **Agent Sparring: Open Overview** and choose model and effort on the
   **Stage agent** and **Sparrer** cards, or leave them at **Provider default**.

See the [setup guide](docs/setup.md) for planning-plugin installation and the
[executable settings](docs/configuration.md#executable-resolution) if VS Code
cannot find `sparring`.

## Suggested workflows

### Run a whole plan

1. Write a staged plan, or use **Agent Sparring: Make Plan…** with an idea or
   notes file. Make Plan needs the optional [planning plugin](docs/setup.md#steps).
   Review the plan before running it.
2. Choose **Agent Sparring: Run Plan**, select the document and confirm the branch.
3. Answer any decisions the engine asks, review the proposed stages and gates,
   and press **Start**. Preparation may use a read-only provider turn before
   this confirmation.
4. Follow the Overview. The engine runs implementation and independent review,
   advances through accepted stages, and pauses when it needs you.

This is the recommended path with an engine that supports `start-plan`.
[Workflow details](docs/workflows.md#two-ways-to-progress-a-plan) cover the
preparation flow, older engines and stage-by-stage continuation.

### Respond to a paused review

Open the run's Overview and read the requested checks. Record **Pass**, **Fail**
or **Can't test**, add evidence, then use **Submit result and continue** for a
managed run or **Submit for review** for a standalone stage. Use **Send feedback
for review** for additional findings or instructions.

If the engine requests push authorization, review the candidate and use
**Allow push**. The engine verifies and accepts the candidate.
See [human evidence and review actions](docs/state.md#source-of-truth-rule),
[push authorization](docs/workflows.md#push-authorization) and
[failed deferred checks](docs/workflows.md#when-a-deferred-check-fails).

### Continue or inspect existing work

Use **Agent Sparring: Resume Plan** to continue an existing run.
**History / Runs…** lets you select and pin a run to inspect; **Follow active
repository** returns to that repository's current work. Use **Choose Repository
to Follow** when you want to keep following one repository while editing another.

**Run Plan** starts new work, including a fresh run of a completed plan.
If the same plan still has an open run, it offers to continue that run.
See [plans and run selection](docs/runs.md) for stage associations and history.

## Documentation

The [documentation index](docs/README.md) links to the full reference:

- [Setup](docs/setup.md) and [configuration](docs/configuration.md)
- [Commands](docs/commands.md) and [workflow details](docs/workflows.md)
- [Plans, repositories and run selection](docs/runs.md)
- [Displayed state and engine authority](docs/state.md)
- [Terminals, process liveness and reload recovery](docs/runners.md)
- [Development, tests and manifest parity](docs/development.md)

## License

[MIT](LICENSE).
