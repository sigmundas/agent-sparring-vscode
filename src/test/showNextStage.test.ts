/**
 * What's next's "Show next stage" shows the next stage, whether or not its
 * repository is the one already followed.
 *
 * The reported defect: after Taxonomy v3 Stage 5 (sporely-web), What's next
 * named Stage 3W, also in sporely-web; clicking Show next stage did nothing.
 * The button only released the run pin and let current-work selection pick
 * again — in the same repository, with the same inputs, so it picked the same
 * finished run. That selection never reached 3W because the plan had been
 * prepared again: a plan's continuing intake is its *newest*, which had
 * nothing complete, while What's next reads the intake the run is bound to.
 * A cross-repository continuation only worked because changing the followed
 * repository changed the selection's inputs.
 *
 * The button now navigates to the work What's next names (nextWorkOf), via
 * one controller operation that follows another repository only when needed.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { nextWorkOf, nextWorkPreference, selectRun, type DiscoveredIntake, type RunPreference } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel } from "../core/overviewModel";
import { crossRepositoryIntake, snapshotTree } from "./fixtures";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { install } from "./vscodeStub";

install();
let Controller: typeof import("../vscode/controller").SparringController;
before(async () => {
  Controller = (await import("../vscode/controller")).SparringController;
});

const T0 = Date.now();

async function world() {
  const w = await crossRepositoryIntake();
  for (const stageId of ["app-run-0001-stage-0-audit", "app-run-0001-stage-1a-app-change"]) {
    const dir = path.join(w.app.sparringDir, "stages", stageId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ base_sha: "a", candidate_sha: "b", implementation_session_id: null, sparring_session_id: null, status: "accepted", run: "app-run-0001" }));
  }
  const discovery = await w.discover();
  const run = discovery.runs.find((entry) => entry.id === w.appRunId)!;
  const knownRoots = [w.app.repoRoot, w.web.repoRoot];
  return { ...w, discovery, run, knownRoots };
}

/** The same intake with its next slice in `app` — Stage 5 → Stage 3W, both in sporely-web. */
function sameRepository(intake: DiscoveredIntake, root: string): DiscoveredIntake {
  return { ...intake, slices: intake.slices.map((slice) => (slice.runId === "web" ? { ...slice, primaryPath: root, approval: undefined } : slice)) };
}

/** A later prepare of the same plan with nothing complete — what made current-work selection miss the next stage live. */
function preparedAgain(intake: DiscoveredIntake): DiscoveredIntake {
  const later = (intake.record.createdAtMs ?? 0) + 86_400_000;
  return {
    ...intake,
    dir: `${intake.dir}-again`,
    record: { ...intake.record, intakeId: `${intake.record.intakeId}-again`, createdAtMs: later },
    slices: intake.slices.map((slice) => ({ ...slice, state: "prepared" as const, approval: undefined })),
    state: "prepared",
    activityMs: later,
  };
}

/** Run the controller's navigation with a recording workspace state, and return what the next refresh would select from. */
async function navigate(next: NonNullable<ReturnType<typeof nextWorkOf>>, owner: string, followed: string, stored: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(stored));
  const logs: string[] = [];
  let refreshes = 0;
  const context = { workspaceState: { get: <T>(key: string, fallback?: T): T => (values.get(key) ?? fallback) as T, update: async (key: string, value: unknown) => void values.set(key, value), keys: () => [...values.keys()] } };
  const self = {
    context,
    log: (line: string) => logs.push(line),
    refresh: async () => void refreshes++,
    repositoryScope: async () => ({ repoRoot: (values.get("agentSparring.chosenRepositoryRoot") as string | undefined) ?? followed }),
  };
  (self as Record<string, unknown>).recordPinOrigin = (Controller.prototype as unknown as Record<string, unknown>)["recordPinOrigin"];
  await Controller.prototype.navigateToNextWork.call(self as never, next, owner);
  const preference = (Controller.prototype as unknown as { preference(this: unknown): RunPreference | undefined }).preference.call(self);
  return { values, logs, refreshes, preference, followed: (await self.repositoryScope()).repoRoot };
}

describe("Show next stage", () => {
  it("same repository: the displayed stage changes to the next stage's approval, and nothing is approved or started", async () => {
    const w = await world();
    const intake = sameRepository(w.discovery.intakes!.find((entry) => entry.slices.some((slice) => slice.runId === "app"))!, w.app.repoRoot);
    const intakes = [intake, preparedAgain(intake)];
    const scope = { repoRoot: w.app.repoRoot, knownRoots: w.knownRoots };
    // The live screen: the finished run, selected automatically.
    const shown = selectRun(w.discovery.runs, undefined, w.appRunId, scope, undefined, [w.app, w.web], intakes);
    assert.equal(shown.selected?.id, w.appRunId);
    const model = buildOverviewModel(shown, undefined, { handoff: false, sparring: false, brief: false, plan: false, intake, knownRoots: w.knownRoots }, T0);
    assert.equal(model.whatsNext?.repository?.action, "show");
    assert.match(renderOverviewHtml(model, "n", "c"), /data-action="showNextWork"[^>]*>Show next stage</);
    // The old mechanism: releasing a pin and reselecting in the same repository reselects the same run.
    assert.equal(selectRun(w.discovery.runs, undefined, w.appRunId, scope, undefined, [w.app, w.web], intakes).selected?.id, w.appRunId, "repository unchanged → selection unchanged; this was the bug");

    const before = await snapshotTree(w.intakeDir);
    const next = nextWorkOf(shown.selected!, intakes)!;
    assert.equal(next.slice.runId, "web");
    const after = await navigate(next, w.app.repoRoot, w.app.repoRoot);
    assert.equal(after.values.has("agentSparring.chosenRepositoryRoot"), false, "no repository switch is needed or made");
    assert.equal(after.refreshes, 1);
    assert.match(after.logs.join("\n"), /show next stage: .* in app, the repository already followed; nothing was approved or started/);
    const selection = selectRun(w.discovery.runs, after.preference, w.appRunId, scope, undefined, [w.app, w.web], intakes);
    assert.equal(selection.selected, undefined, "the finished run is left");
    assert.equal(selection.intake?.dir, intake.dir, "the intake What's next was computed from, not the newer prepare");
    const screen = buildOverviewModel(selection, undefined);
    assert.equal(screen.intake?.action?.kind, "approve");
    assert.equal(screen.intake?.action?.runId, "web", "the next stage — not the first, nor the finished one");
    assert.deepEqual(await snapshotTree(w.intakeDir), before, "nothing on disk was written: nothing approved, launched or started");
  });

  it("different repository: follows the next stage's repository and shows the next stage", async () => {
    const w = await world();
    const shown = selectRun(w.discovery.runs, undefined, w.appRunId, { repoRoot: w.app.repoRoot, knownRoots: w.knownRoots }, undefined, [w.app, w.web], w.discovery.intakes);
    const next = nextWorkOf(shown.selected!, w.discovery.intakes)!;
    assert.equal(next.root, w.web.repoRoot);
    const after = await navigate(next, w.web.repoRoot, w.app.repoRoot);
    assert.equal(after.followed, w.web.repoRoot);
    assert.match(after.logs.join("\n"), /following web/);
    const selection = selectRun(w.discovery.runs, after.preference, w.appRunId, { repoRoot: after.followed, knownRoots: w.knownRoots, chosen: true }, undefined, [w.app, w.web], w.discovery.intakes);
    assert.equal(selection.intake?.dir, next.intake.dir);
    assert.equal(buildOverviewModel(selection, undefined).intake?.action?.kind, "approve");
  });

  it("an old run pinned explicitly in the right repository is left for the next work", async () => {
    const w = await world();
    const intake = sameRepository(w.discovery.intakes!.find((entry) => entry.slices.some((slice) => slice.runId === "app"))!, w.app.repoRoot);
    const scope = { repoRoot: w.app.repoRoot, knownRoots: w.knownRoots };
    const historical: RunPreference = { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 };
    assert.equal(selectRun(w.discovery.runs, historical, undefined, scope, undefined, [w.app, w.web], [intake]).selected?.id, w.appRunId, "the pin holds on its own");
    const next = nextWorkOf(w.run, [intake])!;
    const after = await navigate(next, w.app.repoRoot, w.app.repoRoot, { "agentSparring.selectedRunId": historical.id, "agentSparring.pinIntent": "inspect", "agentSparring.pinOrigin": "explicit" });
    assert.notEqual(after.preference?.id, historical.id, "the click replaces the deliberate pin");
    const selection = selectRun(w.discovery.runs, after.preference, w.appRunId, scope, undefined, [w.app, w.web], [intake]);
    assert.equal(selection.selected, undefined);
    assert.equal(selection.intake?.dir, intake.dir);
  });

  it("the next work is an explicit intake choice: kept over a newer prepare, which is flagged, not swapped in", async () => {
    const w = await world();
    const intake = w.discovery.intakes!.find((entry) => entry.slices.some((slice) => slice.runId === "app"))!;
    const again = preparedAgain(intake);
    const preference = nextWorkPreference(nextWorkOf(w.run, [intake, again])!, T0);
    assert.equal(preference.origin, "explicit");
    const selection = selectRun(w.discovery.runs, preference, undefined, { repoRoot: w.web.repoRoot, knownRoots: w.knownRoots }, undefined, [w.app, w.web], [intake, again]);
    assert.equal(selection.intake?.dir, intake.dir);
    assert.equal(selection.newerIntake?.dir, again.dir);
    assert.equal(selection.released, undefined);
  });

  it("no next work: nothing to navigate to, and Plan complete / waiting keep their screens", async () => {
    const w = await world();
    const intake = w.discovery.intakes!.find((entry) => entry.slices.some((slice) => slice.runId === "app"))!;
    const done: DiscoveredIntake = { ...intake, slices: intake.slices.filter((slice) => slice.runId === "app") };
    assert.equal(nextWorkOf(w.run, [done]), undefined);
    const waiting: DiscoveredIntake = { ...intake, slices: intake.slices.map((slice) => (slice.runId === "web" ? { ...slice, requirements: { ...slice.requirements!, earlierSlices: ["app", "elsewhere"] } } : slice)) };
    assert.equal(nextWorkOf(w.run, [waiting]), undefined);
    const model = buildOverviewModel(selectRun(w.discovery.runs, { id: w.appRunId, origin: "explicit", intent: "inspect", atMs: 0 }, undefined, { repoRoot: w.app.repoRoot, knownRoots: w.knownRoots }, undefined, [w.app, w.web], [done]), undefined, { handoff: false, sparring: false, brief: false, plan: false, intake: done, knownRoots: w.knownRoots }, T0);
    assert.equal(model.whatsNext?.kind, "plan-complete");
    assert.doesNotMatch(renderOverviewHtml(model, "n", "c"), /showNextWork|switchToNextRepository/);
  });

  it("both What's next buttons reach the same navigation, not a pin release", async () => {
    const source = await fs.readFile(path.join(__dirname, "..", "..", "src", "vscode", "commands.ts"), "utf8");
    assert.match(source, /case "switchToNextRepository":\s*case "showNextWork":\s*await showNextWork\(controller\);/);
    const handler = /async function showNextWork[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
    assert.match(handler, /controller\.navigateToNextWork\(next, owner\)/);
    assert.doesNotMatch(handler, /followActiveRepository|chooseRepository|approve|runPlan|launch/);
    assert.match(handler, /controller\.log\(`show next stage: nothing to show/, "a click with nothing to show says so in the Output channel");
  });
});
