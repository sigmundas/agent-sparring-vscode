/**
 * Current work across repositories: a plan intake prepared in one repository
 * whose next eligible slice belongs to another.
 *
 * The scenario is the engine-generated `fixtures/plan-intake/ran/` snapshot —
 * slice `app` approved and its run complete, slice `web` (primary repository
 * `web`, earlier slice `app`) prepared — beside a `web` project that holds an
 * unrelated accepted standalone stage written *after* everything else.
 *
 * Held here:
 *  - following `web`, the intake is current work and outranks that stage,
 *    however recently the stage was written, and the Overview offers the
 *    existing Approve next slice for `web` — without anything being invoked;
 *  - following `app`, the intake is not claimed: its next slice is not there;
 *  - a person's pin of the old stage wins until Follow active repository;
 *  - open work in the followed repository still comes first;
 *  - with no relevant intake, standalone discovery is unchanged;
 *  - rediscovery (a reload) comes back to the same answer, and discovery
 *    never writes to the intake.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { describeRepositoryContext } from "../core/activeRepository";
import { continuingIntake, discoverRuns, intakeIdFor, runIdFor, selectRun, type SparringLocation } from "../core/discovery";
import { approveInvocation } from "../core/intakeActions";
import { buildOverviewModel } from "../core/overviewModel";
import { Workspace } from "./fixtures";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");
const INTAKE_ID = "plan-61bf2008-20260927T204930Z-faithful-fb55";
const OLD_STAGE = "finds-prefetch-and-enrichment";

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

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      out[file] = await fs.readFile(file, "utf8");
    }
  }
  return out;
}

/** `<base>/app` prepared the intake and ran slice `app`; `<base>/web` has only an old accepted stage, newer than all of it. */
async function crossRepository(options: { webStage?: "accepted" | "working" } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-current-work-")));
  const appRoot = path.join(base, "app");
  await fs.mkdir(appRoot, { recursive: true });
  await copyTree(path.join(FIXTURES, "ran"), appRoot, base);
  const app: SparringLocation = { sparringDir: path.join(appRoot, ".sparring"), projectDir: appRoot, repoRoot: appRoot, workspaceFolder: appRoot, folderName: "app" };
  const webWs = await Workspace.createNested(base, "web");
  const stageState = await webWs.writeStage(OLD_STAGE, options.webStage === "working" ? { status: "working" } : { status: "accepted", candidate_sha: "abc" });
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(stageState, "state.json"), later, later).catch(() => undefined);
  const web = webWs.location;
  const knownRoots = [app.repoRoot, web.repoRoot];
  const scope = (location: SparringLocation) => ({ repoRoot: location.repoRoot, knownRoots });
  return {
    app,
    web,
    scope,
    discover: () => discoverRuns([app, web]),
    intakeId: intakeIdFor(app, INTAKE_ID),
    stageId: runIdFor(web, "stage", OLD_STAGE),
    appRunId: runIdFor(app, "plan", "app-run-0001"),
    intakeDir: path.join(app.sparringDir, "intake", INTAKE_ID),
  };
}

describe("an intake whose next slice belongs to the followed repository is current work", () => {
  it("following web: the intake wins over a newer accepted standalone stage, and offers Approve for slice web", async () => {
    const world = await crossRepository();
    const discovery = await world.discover();
    const stage = discovery.runs.find((run) => run.id === world.stageId);
    assert.ok(stage, "the old stage is discovered");
    const appRun = discovery.runs.find((run) => run.id === world.appRunId);
    assert.ok(appRun && appRun.stateMtimeMs < stage.stateMtimeMs, "the stage is the most recently written finished work");

    const selection = selectRun(discovery.runs, undefined, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(selection.selected, undefined);
    assert.equal(selection.intake && intakeIdFor(selection.intake.location, selection.intake.record.intakeId), world.intakeId);
    assert.equal(describeRepositoryContext(selection).mode, "following");

    const model = buildOverviewModel(selection, undefined);
    assert.deepEqual(
      model.intake?.slices.map((slice) => [slice.runId, slice.stateLabel, slice.current]),
      [
        ["app", model.intake?.slices[0].stateLabel, false],
        ["web", model.intake?.slices[1].stateLabel, true],
      ],
    );
    assert.match(model.intake?.slices[0].stateLabel ?? "", /complete/i);
    assert.deepEqual(model.intake?.action && [model.intake.action.kind, model.intake.action.runId], ["approve", "web"]);
    // The action it would take is the existing one, from web; nothing is run by discovering it.
    const invocation = approveInvocation(selection.intake!, selection.intake!.slices[1], [world.app, world.web]);
    assert.ok(invocation.ok && invocation.cwd === world.web.repoRoot);
  });

  it("following app: the intake is not claimed, because its next slice is web's", async () => {
    const world = await crossRepository();
    const discovery = await world.discover();
    const selection = selectRun(discovery.runs, undefined, undefined, world.scope(world.app), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(selection.intake, undefined);
    assert.equal(selection.selected?.id, world.appRunId, "app's own finished run, as before");
    assert.equal(continuingIntake(discovery.intakes ?? [], world.scope(world.app)), undefined);
  });

  it("a pinned historical stage wins until Follow active repository, which returns to the intake", async () => {
    const world = await crossRepository();
    const discovery = await world.discover();
    const pinned = selectRun(discovery.runs, { id: world.stageId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(pinned.selected?.id, world.stageId);
    assert.equal(pinned.pinned, true);
    // Follow active repository clears the pin: no preference.
    const following = selectRun(discovery.runs, undefined, world.stageId, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(following.intake && intakeIdFor(following.intake.location, following.intake.record.intakeId), world.intakeId, "the remembered stage is not a reason to hide the next step");
  });

  it("an action attachment to the intake, made from app, holds when web is followed: web owns its next slice", async () => {
    const world = await crossRepository();
    const discovery = await world.discover();
    const attachment = { id: world.intakeId, origin: "action" as const, intent: "inspect" as const, atMs: 0, activeRootAtPin: world.app.repoRoot };
    const selection = selectRun(discovery.runs, attachment, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(selection.released, undefined);
    assert.equal(selection.intake && intakeIdFor(selection.intake.location, selection.intake.record.intakeId), world.intakeId);
  });

  it("open work in the followed repository still comes first", async () => {
    const world = await crossRepository({ webStage: "working" });
    const discovery = await world.discover();
    const selection = selectRun(discovery.runs, undefined, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(selection.selected?.id, world.stageId);
    assert.equal(selection.intake, undefined);
  });

  it("an earlier slice that is still running is not a next eligible slice for web", async () => {
    const world = await crossRepository();
    const planFile = path.join(world.app.sparringDir, "plans", "app-run-0001.json");
    const state = JSON.parse(await fs.readFile(planFile, "utf8"));
    await fs.writeFile(planFile, JSON.stringify({ ...state, status: "paused" }));
    const discovery = await world.discover();
    const selection = selectRun(discovery.runs, undefined, undefined, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
    assert.equal(selection.intake, undefined);
    assert.equal(selection.selected?.id, world.stageId);
  });

  it("with no relevant intake (app not in the window), standalone discovery is unchanged", async () => {
    const world = await crossRepository();
    const discovery = await discoverRuns([world.web]);
    const selection = selectRun(discovery.runs, undefined, undefined, { repoRoot: world.web.repoRoot, knownRoots: [world.web.repoRoot] }, undefined, [world.web], discovery.intakes);
    assert.equal(selection.selected?.id, world.stageId);
    assert.equal(selection.intake, undefined);
  });

  it("rediscovery gives the same answer, and discovery writes nothing to the intake", async () => {
    const world = await crossRepository();
    const before = await snapshotTree(world.intakeDir);
    for (let pass = 0; pass < 2; pass += 1) {
      const discovery = await world.discover();
      const selection = selectRun(discovery.runs, undefined, world.stageId, world.scope(world.web), undefined, [world.app, world.web], discovery.intakes);
      assert.equal(selection.intake && intakeIdFor(selection.intake.location, selection.intake.record.intakeId), world.intakeId, `pass ${pass}`);
    }
    assert.deepEqual(await snapshotTree(world.intakeDir), before);
  });
});
