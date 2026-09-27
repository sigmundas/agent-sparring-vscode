/**
 * The intake screen's actions and the repository-following rules.
 *
 * Intake fixtures are the engine-generated ones under `fixtures/plan-intake/`
 * (see its `generate.py`), which now carry the engine's display metadata:
 * `findings` and `approval_requirements` in `intake.json`.
 *
 * Held here:
 *  - the action offered comes only from what the engine recorded: no Approve
 *    when blocking findings are recorded, Approve for the next unapproved
 *    slice otherwise, Start for an approved slice with no run;
 *  - approve-plan is invoked for the right slice from its primary repository,
 *    with no gate, sibling or amendment flag supplied on the person's behalf;
 *  - Start runs the exact sealed manifest with the approval's own values;
 *  - an engine refusal is shown verbatim and nothing else is attempted;
 *  - once the run's state exists the managed run takes over;
 *  - following: an editor in another repository switches the cockpit unless
 *    the person pinned something; action attachments are released by that
 *    move; an editor outside every repository changes nothing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ActiveRepositoryFold, describeRepositoryContext, type GitSource } from "../core/activeRepository";
import { buildApprovePlanArgs } from "../core/cli";
import { discoverRuns, intakeIdFor, runIdFor, selectRun, type DiscoveredIntake, type SparringLocation } from "../core/discovery";
import { intakeNextAction } from "../core/intake";
import { approveInvocation, startInvocation } from "../core/intakeActions";
import { isIntakeActionMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, intakeView } from "../core/overviewModel";
import { deriveStatus } from "../core/status";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");
const INTAKE_ID = "plan-61bf2008-20260927T204930Z-faithful-fb55";
const RUN_KEY = "app-run-0001";
const CREATED_AT_MS = Date.parse("2026-09-27T20:49:30.293Z");

async function copyTree(from: string, to: string, root: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await copyTree(source, target, root);
    } else {
      await fs.writeFile(target, (await fs.readFile(source, "utf8")).split("__ROOT__").join(root));
    }
  }
}

function locationAt(root: string): SparringLocation {
  return { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: path.basename(root) };
}

/** `<tmp>/app` holding a fixture snapshot, and `<tmp>/web` as the sibling project intake inspected. */
async function project(snapshot: "approved" | "ran" | "prepared"): Promise<{ base: string; root: string; location: SparringLocation; intakeDir: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-intake-actions-")));
  const root = path.join(base, "app");
  await fs.mkdir(root, { recursive: true });
  await copyTree(path.join(FIXTURES, snapshot === "prepared" ? "approved" : snapshot), root, base);
  const intakeDir = path.join(root, ".sparring", "intake", INTAKE_ID);
  if (snapshot === "prepared") {
    await fs.rm(path.join(intakeDir, "runs"), { recursive: true });
    await fs.rm(path.join(root, ".sparring", "intake", "registry"), { recursive: true });
  }
  return { base, root, location: locationAt(root), intakeDir };
}

async function editRecord(intakeDir: string, change: (record: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(intakeDir, "intake.json");
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  change(record);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n");
}

async function onlyIntake(location: SparringLocation): Promise<DiscoveredIntake> {
  const discovery = await discoverRuns([location]);
  const [intake] = discovery.intakes ?? [];
  assert.ok(intake, `an intake; problems: ${JSON.stringify(discovery.problems)}`);
  return intake;
}

describe("the action comes from what the engine recorded", () => {
  it("blocking findings recorded: Open intake report, approval shown as blocked, no Approve or Start", async () => {
    const { location, intakeDir } = await project("prepared");
    await editRecord(intakeDir, (record) => {
      record.findings = { blocking: 2, recommendation: 6, info: 0, verdict: "executable_with_recommendations" };
    });
    const intake = await onlyIntake(location);
    assert.equal(intakeNextAction(intake).kind, "blocked");
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined);
    assert.equal(model.intake?.action, undefined);
    assert.equal(model.intake?.stateLabel, "Prepared — 2 blocking findings, 6 recommendations");
    assert.match(model.intake?.blocked ?? "", /Approval is blocked: prepare-plan recorded 2 blocking findings/);
    const html = renderOverviewHtml(model, "nonce", "csp");
    assert.ok(!html.includes("data-intake="), "no approve or start button");
    assert.match(html, /data-action="openIntakeReport"[^>]*>Open intake report|class="primary" data-action="openIntakeReport"/);
  });

  it("no blocking findings: Approve next slice, for the first unapproved slice, with the counts in the header", async () => {
    const { location, intakeDir } = await project("prepared");
    const intake = await onlyIntake(location);
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined);
    assert.equal(model.intake?.stateLabel, "Prepared — 0 blocking findings, 0 recommendations");
    assert.deepEqual(model.intake?.action && [model.intake.action.kind, model.intake.action.label, model.intake.action.runId, model.intake.action.intakeDir], ["approve", "Approve next slice", "app", intakeDir]);
    const html = renderOverviewHtml(model, "nonce", "csp");
    assert.match(html, new RegExp(`data-intake="approve" data-intake-dir="${intakeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" data-intake-run="app"`));
  });

  it("an intake without recorded counts is offered Approve and says the findings were not recorded", async () => {
    const { location, intakeDir } = await project("prepared");
    await editRecord(intakeDir, (record) => {
      delete record.findings;
      delete record.approval_requirements;
    });
    const model = buildOverviewModel({ ambiguous: [], intake: await onlyIntake(location) }, undefined);
    assert.equal(model.intake?.stateLabel, "Prepared — findings not recorded; see the report");
    assert.equal(model.intake?.action?.kind, "approve");
  });

  it("a slice the engine recorded as not approvable from this intake shows its reason and no action", async () => {
    const { location, intakeDir } = await project("prepared");
    await editRecord(intakeDir, (record) => {
      const requirements = record.approval_requirements as Record<string, Record<string, unknown>>;
      requirements.app = { ...requirements.app, approvable: false, reason: "the plan runs slice 'app' on 'main', but app was on 'feature/widgets'" };
    });
    const model = buildOverviewModel({ ambiguous: [], intake: await onlyIntake(location) }, undefined);
    assert.equal(model.intake?.action, undefined);
    assert.match(model.intake?.blocked ?? "", /cannot be approved from this intake: the plan runs slice 'app' on 'main'/);
  });

  it("the next slice's recorded requirements are shown, and left to the engine to enforce", async () => {
    const { location } = await project("ran");
    const intake = await onlyIntake(location);
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined);
    assert.equal(model.intake?.action?.runId, "web");
    assert.deepEqual(model.intake?.requirements, [
      "Waits for run slice app to be approved and complete.",
      "Needs a person to confirm gate release (sparring approve-plan --confirm-prerequisite) once actually satisfied.",
    ]);
  });

  it("an approved slice is 'Approved — ready to start' and offers Start slice; nothing says ready to run", async () => {
    const { location } = await project("approved");
    const model = buildOverviewModel({ ambiguous: [], intake: await onlyIntake(location) }, undefined);
    assert.equal(model.intake?.stateLabel, "Approved — ready to start");
    assert.equal(model.intake?.action?.kind, "start");
    assert.ok(model.intake?.slices.some((slice) => slice.stateLabel === "Approved — ready to start"));
    assert.ok(!JSON.stringify(model).includes("ready to run"));
  });
});

describe("the engine commands, built from the engine's own records", () => {
  it("approve-plan for the next slice, from that slice's primary repository", async () => {
    const { location, root, intakeDir } = await project("prepared");
    const intake = await onlyIntake(location);
    const next = intakeNextAction(intake);
    assert.equal(next.kind, "approve");
    const invocation = approveInvocation(intake, next.kind === "approve" ? next.slice : intake.slices[0], [location]);
    assert.ok(invocation.ok);
    assert.deepEqual(invocation.args, ["approve-plan", intakeDir, "--run", "app", "--repo-root", root, "--repository-name", "app"]);
    assert.equal(invocation.cwd, root);
  });

  it("a later slice is approved from its own primary repository, as intake recorded it", async () => {
    const { location, base, intakeDir } = await project("ran");
    const intake = await onlyIntake(location);
    const web = intake.slices.find((slice) => slice.runId === "web");
    assert.ok(web);
    const invocation = approveInvocation(intake, web, [location]);
    assert.ok(invocation.ok);
    assert.deepEqual(invocation.args, ["approve-plan", intakeDir, "--run", "web", "--repo-root", path.join(base, "web"), "--repository-name", "web"]);
    assert.equal(invocation.cwd, path.join(base, "web"));
  });

  it("no gate, sibling or amendment flag is ever supplied on the person's behalf", () => {
    const args = buildApprovePlanArgs({ intakeDir: "/i", runId: "web", repoRoot: "/r", repositoryName: "web" });
    for (const flag of ["--confirm-prerequisite", "--repository", "--repository-branch", "--without-amendment", "--expected-branch"]) {
      assert.ok(!args.includes(flag), flag);
    }
  });

  it("Start slice runs the exact sealed manifest with the approval's run key, worktree and branch", async () => {
    const { location, root, intakeDir } = await project("approved");
    const intake = await onlyIntake(location);
    const next = intakeNextAction(intake);
    assert.equal(next.kind, "start");
    const invocation = startInvocation(next.kind === "start" ? next.slice : intake.slices[0], [location]);
    assert.ok(invocation.ok);
    assert.deepEqual(invocation.args, ["run-plan", "--manifest", path.join(intakeDir, "runs", "app", "manifest.json"), "--repo-root", root, "--expected-branch", "feature/widgets", "--run-key", RUN_KEY]);
    assert.equal(invocation.runId, runIdFor(location, "plan", RUN_KEY));
    assert.equal(invocation.cwd, root);
  });

  it("Start refuses, launching nothing, when the slice's project is not open in this window", async () => {
    const { location } = await project("approved");
    const intake = await onlyIntake(location);
    const invocation = startInvocation(intake.slices[0], []);
    assert.equal(invocation.ok, false);
    assert.match(invocation.ok ? "" : invocation.problem, /not open in this window/);
  });

  it("an engine refusal is shown verbatim, Approve stays available, and nothing else is proposed", async () => {
    const { location } = await project("ran");
    const intake = await onlyIntake(location);
    const refusal = "could not approve plan: run slice 'web' waits for gate 'release'; confirm it with --confirm-prerequisite release once it is actually satisfied";
    const view = intakeView(intake, undefined, { state: "refused", output: refusal, exitCode: 1 });
    assert.equal(view.refusal?.text, refusal);
    assert.equal(view.action?.kind, "approve");
    assert.equal(view.action?.enabled, true);
    const html = renderOverviewHtml({ kind: "intake", title: "t", intake: view }, "nonce", "csp");
    assert.ok(html.includes("Approval refused by the engine. Nothing was approved."));
    assert.ok(html.includes("waits for gate &#39;release&#39;") || html.includes("waits for gate 'release'"));
  });

  it("while approving, the button says so and cannot be pressed twice", async () => {
    const { location } = await project("prepared");
    const view = intakeView(await onlyIntake(location), undefined, { state: "approving" });
    assert.equal(view.action?.label, "Approving…");
    assert.equal(view.action?.enabled, false);
  });

  it("the host acts only on the slice the click names, and only while the intake still offers that action", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const body = /async function handleIntakeAction[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.match(body, /next\.kind !== message\.action \|\| next\.slice\.runId !== message\.runId/);
    assert.match(body, /result\.outcome\.exitCode === 0/, "only exit 0 is an approval");
    assert.match(body, /controller\.launch\(/, "Start goes through the shared launcher and its duplicate guard");
    assert.ok(!/confirm-prerequisite|without-amendment/.test(body));
  });

  it("the intake message guard accepts only a complete, known action", () => {
    assert.ok(isIntakeActionMessage({ type: "intake", action: "approve", intakeDir: "/i", runId: "app" }));
    assert.ok(!isIntakeActionMessage({ type: "intake", action: "delete", intakeDir: "/i", runId: "app" }));
    assert.ok(!isIntakeActionMessage({ type: "intake", action: "start", intakeDir: "", runId: "app" }));
    assert.ok(!isIntakeActionMessage({ type: "intake", action: "start", intakeDir: "/i" }));
  });
});

describe("once the run's state exists, the managed run is the authority", () => {
  it("the attachment made at Start becomes the run, and the intake is no longer shown for it", async () => {
    const { root, location } = await project("approved");
    const runId = runIdFor(location, "plan", RUN_KEY);
    const attachment = { id: runId, intent: "starting" as const, origin: "action" as const, activeRootAtPin: root, atMs: Date.now() };
    let discovery = await discoverRuns([location]);
    let selection = selectRun(discovery.runs, attachment, undefined, { repoRoot: root }, undefined, [location], discovery.intakes);
    assert.equal(selection.selected, undefined, "not written yet");
    assert.equal(selection.released, undefined, "a starting attachment is not released before its run exists");

    const state = path.join(root, ".sparring", "plans", `${RUN_KEY}.json`);
    await fs.mkdir(path.dirname(state), { recursive: true });
    await fs.writeFile(state, JSON.stringify({ current_stage: "app-run-0001-stage-0-audit", current_stage_index: 0, expected_branch: "feature/widgets", plan: "docs/plan.md", plan_digest: "0".repeat(64), run: RUN_KEY, source: "intake-manifest", status: "running" }));
    discovery = await discoverRuns([location]);
    selection = selectRun(discovery.runs, attachment, undefined, { repoRoot: root }, undefined, [location], discovery.intakes);
    assert.equal(selection.selected?.id, runId);
    assert.equal(selection.intake, undefined);
    assert.equal(discovery.intakes?.[0].state, "running");
    // And without any attachment, automatic selection reaches the same run.
    assert.equal(selectRun(discovery.runs, undefined, undefined, { repoRoot: root }, undefined, [location], discovery.intakes).selected?.id, runId);
  });
});

describe("following the active repository", () => {
  class Git implements GitSource {
    constructor(private readonly roots: string[]) {}
    repositories() {
      return this.roots.map((rootPath) => ({ rootPath, selected: false }));
    }
    repositoryOf(fsPath: string) {
      return this.roots.find((root) => fsPath.startsWith(`${root}/`));
    }
  }

  it("an editor in sporely-web moves the cockpit from sporely-py; a file outside every repository changes nothing", () => {
    const fold = new ActiveRepositoryFold(new Git(["/code/sporely-py", "/code/sporely-web"]), 0);
    assert.equal(fold.editorActivated("/code/sporely-py/main.py", 1_000), "/code/sporely-py");
    assert.equal(fold.editorActivated("/code/sporely-web/src/app.ts", 2_000), "/code/sporely-web");
    assert.equal(fold.editorActivated("/tmp/scratch.md", 3_000), "/code/sporely-web", "a non-repository file keeps the repository");
    assert.equal(fold.editorActivated(undefined, 4_000), "/code/sporely-web", "an editor with no file keeps it too");
    assert.equal(fold.editorActivated("/code/sporely-py/taxonomy.py", 5_000), "/code/sporely-py");
  });

  /** Two projects with a finished run each: the automatic answer is whichever repository is active. */
  async function twoRepositories() {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-follow-")));
    const make = async (name: string) => {
      const root = path.join(base, name);
      const file = path.join(root, ".sparring", "plans", `${name}-run.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ current_stage: `${name}-s`, current_stage_index: 0, expected_branch: "main", plan: "docs/p.md", plan_digest: "0".repeat(64), run: `${name}-run`, source: "markdown", status: "complete" }));
      return locationAt(root);
    };
    const py = await make("sporely-py");
    const web = await make("sporely-web");
    const discovery = await discoverRuns([py, web]);
    const knownRoots = [py.repoRoot, web.repoRoot];
    const scope = (location: SparringLocation) => ({ repoRoot: location.repoRoot, knownRoots });
    const runOf = (location: SparringLocation) => runIdFor(location, "plan", `${location.folderName}-run`);
    return { py, web, discovery, scope, runOf };
  }

  it("unpinned, the selection follows the active repository", async () => {
    const { py, web, discovery, scope, runOf } = await twoRepositories();
    assert.equal(selectRun(discovery.runs, undefined, undefined, scope(py), undefined, [py, web]).selected?.id, runOf(py));
    assert.equal(selectRun(discovery.runs, undefined, undefined, scope(web), undefined, [py, web]).selected?.id, runOf(web));
  });

  it("an action attachment is released when the active editor moves to another repository", async () => {
    const { py, web, discovery, scope, runOf } = await twoRepositories();
    const attachment = { id: runOf(py), intent: "follow" as const, origin: "action" as const, activeRootAtPin: py.repoRoot };
    const stay = selectRun(discovery.runs, attachment, undefined, scope(py), undefined, [py, web]);
    assert.equal(stay.selected?.id, runOf(py));
    assert.equal(stay.pinOrigin, "action");
    assert.equal(describeRepositoryContext(stay).mode, "attached");
    const moved = selectRun(discovery.runs, attachment, undefined, scope(web), undefined, [py, web]);
    assert.equal(moved.selected?.id, runOf(web));
    assert.deepEqual(moved.released, { id: runOf(py), reason: "repository", to: web.repoRoot });
  });

  it("an attachment made while the editor was already elsewhere holds until the person actually moves", async () => {
    const { py, web, discovery, scope, runOf } = await twoRepositories();
    // Started a sporely-py run while editing in sporely-web.
    const attachment = { id: runOf(py), intent: "starting" as const, origin: "action" as const, activeRootAtPin: web.repoRoot };
    assert.equal(selectRun(discovery.runs, attachment, undefined, scope(web), undefined, [py, web]).selected?.id, runOf(py));
    // Opening a sporely-py file is not a move away from what is shown.
    assert.equal(selectRun(discovery.runs, attachment, undefined, scope(py), undefined, [py, web]).selected?.id, runOf(py));
  });

  it("an explicit pin survives every repository change, and is marked in the status bar", async () => {
    const { py, web, discovery, scope, runOf } = await twoRepositories();
    const pin = { id: runOf(py), intent: "inspect" as const, origin: "explicit" as const };
    const selection = selectRun(discovery.runs, pin, undefined, scope(web), undefined, [py, web]);
    assert.equal(selection.selected?.id, runOf(py));
    assert.equal(selection.released, undefined);
    assert.equal(describeRepositoryContext(selection).mode, "pinned");
    assert.match(deriveStatus(selection, undefined, Date.now()).text, /^\$\(pin\) /);
    // An attachment is not marked as a pin.
    const attached = selectRun(discovery.runs, { ...pin, origin: "action" as const, activeRootAtPin: web.repoRoot }, undefined, scope(web), undefined, [py, web]);
    assert.ok(!deriveStatus(attached, undefined, Date.now()).text.startsWith("$(pin)"));
  });

  it("a pin stored before origins were recorded is treated as explicit, never dropped", async () => {
    const { py, web, discovery, scope, runOf } = await twoRepositories();
    const selection = selectRun(discovery.runs, { id: runOf(py), intent: "inspect" }, undefined, scope(web), undefined, [py, web]);
    assert.equal(selection.selected?.id, runOf(py));
  });

  it("Follow active repository releases the pin: with no stored preference the active repository decides", async () => {
    const { py, web, discovery, scope, runOf } = await twoRepositories();
    assert.equal(selectRun(discovery.runs, undefined, undefined, scope(web), undefined, [py, web]).selected?.id, runOf(web));
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "controller.ts"), "utf8");
    assert.match(/async followActiveRepository[\s\S]*?\n {2}}\n/.exec(source)?.[0] ?? "", /this\.chooseRun\(undefined, "explicit"\)/);
    assert.match(/private async recordPinOrigin[\s\S]*?\n {2}}\n/.exec(source)?.[0] ?? "", /PIN_ORIGIN_KEY, origin/);
  });

  it("an intake can be pinned explicitly and stays on screen in another repository", async () => {
    const { root, location } = await project("approved");
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-other-")));
    const discovery = await discoverRuns([location]);
    const id = intakeIdFor(location, INTAKE_ID);
    const selection = selectRun(discovery.runs, { id, origin: "explicit" }, undefined, { repoRoot: other, knownRoots: [root] }, undefined, [location], discovery.intakes);
    assert.equal(selection.intake?.record.intakeId, INTAKE_ID);
    assert.equal(selection.pinned, true);
    assert.equal(describeRepositoryContext(selection).mode, "pinned");
    void CREATED_AT_MS;
  });

  it("only History / Runs and Follow active repository record explicit selections; everything else attaches", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    const calls = [...source.matchAll(/controller\.chooseRun\(([\s\S]*?)\);/g)].map((match) => match[1]);
    const explicit = calls.filter((call) => call.endsWith('"explicit"'));
    const action = calls.filter((call) => call.endsWith('"action"'));
    assert.equal(explicit.length + action.length, calls.length, "every call states its origin");
    assert.equal(explicit.length, 2, "the picker and the test hook");
    assert.ok(/await controller\.chooseRun\(picked\.run, "explicit"\)/.test(source));
  });
});
