/**
 * A plan's current intake is its newest USABLE intake in the project that
 * prepared it — not merely its newest by timestamp (see "an intake still
 * being prepared is never current" below for the completion-marker rules).
 *
 *  - an intake opened by an action (not chosen by a person) follows its plan
 *    to the current intake once the plan is prepared again;
 *  - a person's explicit choice of an older intake stays on screen, labelled
 *    historical, and never replaces the current one;
 *  - the newest intake is current whatever the older one's run activity.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { currentIntakeOf, discoverRuns, intakeIdFor, promotableIntake, selectRun, type DiscoveredIntake, type SparringLocation } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel } from "../core/overviewModel";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");
const OLD_ID = "plan-61bf2008-20260927T204930Z-faithful-fb55";
const NEW_ID = "plan-61bf2008-20260929T101010Z-faithful-aaaa";

async function copyTree(from: string, to: string, base: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      await copyTree(source, target, base);
    } else {
      await fs.writeFile(target, (await fs.readFile(source, "utf8")).split("__ROOT__").join(base));
    }
  }
}

/** The fixture's approved intake, plus a later prepare of the same plan with no approvals. */
async function preparedTwice(): Promise<{ location: SparringLocation; oldId: string; newId: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-current-intake-")));
  const root = path.join(base, "app");
  await fs.mkdir(root, { recursive: true });
  await copyTree(path.join(FIXTURES, "approved"), root, base);
  const intakes = path.join(root, ".sparring", "intake");
  const newer = path.join(intakes, NEW_ID);
  await fs.cp(path.join(intakes, OLD_ID), newer, { recursive: true });
  await fs.rm(path.join(newer, "runs"), { recursive: true, force: true });
  const file = path.join(newer, "intake.json");
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  record.intake_id = NEW_ID;
  record.created_at = "2026-09-29T10:10:10.000000+00:00";
  await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n");
  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: "app" };
  return { location, oldId: intakeIdFor(location, OLD_ID), newId: intakeIdFor(location, NEW_ID) };
}

describe("a plan's current intake", () => {
  it("is the newest prepare of the plan, whatever the older one has approved since", async () => {
    const { location } = await preparedTwice();
    const discovery = await discoverRuns([location]);
    const old = discovery.intakes!.find((intake) => intake.record.intakeId === OLD_ID)!;
    assert.equal(old.state, "approved", "the older intake has later approval activity");
    assert.equal(currentIntakeOf(old, discovery.intakes!).record.intakeId, NEW_ID);
  });

  it("an intake opened by an action follows its plan to the current intake", async () => {
    const { location, oldId, newId } = await preparedTwice();
    const discovery = await discoverRuns([location]);
    for (const origin of ["action", "follow"] as const) {
      const selection = selectRun(discovery.runs, { id: oldId, origin: origin === "follow" ? "action" : origin, intent: origin === "follow" ? "follow" : "inspect" }, undefined, undefined, undefined, [location], discovery.intakes);
      assert.equal(selection.intake?.record.intakeId, NEW_ID);
      assert.deepEqual(selection.released, { id: oldId, reason: "replaced", to: newId });
      assert.equal(selection.newerIntake, undefined);
    }
  });

  it("an explicitly chosen older intake stays, labelled historical, and names the current one", async () => {
    const { location, oldId } = await preparedTwice();
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, { id: oldId, origin: "explicit" }, undefined, undefined, undefined, [location], discovery.intakes);
    assert.equal(selection.intake?.record.intakeId, OLD_ID);
    assert.equal(selection.released, undefined);
    assert.equal(selection.newerIntake?.record.intakeId, NEW_ID);
    const model = buildOverviewModel(selection, undefined);
    assert.equal(model.kind, "intake");
    const html = renderOverviewHtml(model, "nonce", "csp");
    assert.match(html, /Historical intake · Source plan has newer intake/);
    assert.ok(html.includes(NEW_ID));
  });

  it("the current intake chosen explicitly carries no historical label", async () => {
    const { location, newId } = await preparedTwice();
    const discovery = await discoverRuns([location]);
    const selection = selectRun(discovery.runs, { id: newId, origin: "explicit" }, undefined, undefined, undefined, [location], discovery.intakes);
    assert.equal(selection.intake?.record.intakeId, NEW_ID);
    assert.equal(selection.newerIntake, undefined);
  });
});

// -------------------------------------------------------------------------
// completion_marker: current = newest USABLE intake, not newest timestamp.
// These are pure selection-logic tests — no filesystem, no prepare-plan.
// `usable` is set directly, standing in for what discoverIntakes computes
// from `intake.json`'s `completion_marker` and whether that file exists
// (src/core/intake.ts: snapshotIntake). A legacy intake (no marker recorded)
// is exactly `usable: true`.
// -------------------------------------------------------------------------

function fixtureLocation(project = "app"): SparringLocation {
  const root = `/synthetic/${project}`;
  return { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: project };
}

/** A synthetic intake for pure selection-logic tests: `usable` set directly, standing in for a marker check. */
function fixtureIntake(id: string, createdAtMs: number, usable: boolean, location: SparringLocation = fixtureLocation()): DiscoveredIntake {
  const dir = path.join(location.sparringDir, "intake", id);
  return {
    location,
    dir,
    sparringDir: location.sparringDir,
    record: { intakeId: id, planLabel: "docs/plan.md", createdAtMs, runKeys: [], repositories: {} },
    slices: [],
    state: "prepared",
    reportPath: path.join(dir, "report.md"),
    activityMs: createdAtMs,
    usable,
  };
}

describe("an intake still being prepared is never current", () => {
  it("a newer intake with no completion marker yet does not replace the current one", () => {
    const older = fixtureIntake("older", 1000, true);
    const midPrepare = fixtureIntake("newer", 2000, false);
    assert.equal(currentIntakeOf(older, [older, midPrepare]).record.intakeId, "older");
  });

  it("once the marker is written, that same intake becomes current", () => {
    const older = fixtureIntake("older", 1000, true);
    const nowPrepared = fixtureIntake("newer", 2000, true);
    assert.equal(currentIntakeOf(older, [older, nowPrepared]).record.intakeId, "newer");
  });

  it("legacy intakes (no completion_marker key, so usable as today) behave exactly as before", () => {
    const older = fixtureIntake("older", 1000, true);
    const newer = fixtureIntake("newer", 2000, true);
    assert.equal(currentIntakeOf(older, [older, newer]).record.intakeId, "newer");
    assert.equal(currentIntakeOf(newer, [older, newer]).record.intakeId, "newer");
  });

  it("an action-origin (incidental) selection does not follow to an unfinished intake, and pins nothing new", () => {
    const location = fixtureLocation();
    const older = fixtureIntake("older", 1000, true, location);
    const midPrepare = fixtureIntake("newer", 2000, false, location);
    const oldId = intakeIdFor(location, "older");
    const selection = selectRun([], { id: oldId, origin: "action", intent: "inspect" }, undefined, undefined, undefined, [location], [older, midPrepare]);
    assert.equal(selection.intake?.record.intakeId, "older");
    assert.equal(selection.released, undefined, "there is nothing current to switch to yet");
  });

  it("once that prepare succeeds, the same action-origin pin follows to the now-current intake", () => {
    const location = fixtureLocation();
    const older = fixtureIntake("older", 1000, true, location);
    const nowPrepared = fixtureIntake("newer", 2000, true, location);
    const oldId = intakeIdFor(location, "older");
    const newId = intakeIdFor(location, "newer");
    const selection = selectRun([], { id: oldId, origin: "action", intent: "inspect" }, undefined, undefined, undefined, [location], [older, nowPrepared]);
    assert.equal(selection.intake?.record.intakeId, "newer");
    assert.deepEqual(selection.released, { id: oldId, reason: "replaced", to: newId });
  });

  it("a failed prepare (intake.json written, marker never appears) leaves the previous current intake selected, and stays that way across a reload", () => {
    const location = fixtureLocation();
    const older = fixtureIntake("older", 1000, true, location);
    const failed = fixtureIntake("failed", 2000, false, location);
    const oldId = intakeIdFor(location, "older");
    const live = selectRun([], { id: oldId, origin: "action", intent: "inspect" }, undefined, undefined, undefined, [location], [older, failed]);
    assert.equal(live.intake?.record.intakeId, "older");
    // A reload restores the identical persisted pin from workspaceState; the
    // failed intake's marker still never appears, so nothing changes.
    const reloaded = selectRun([], { id: oldId, origin: "action", intent: "inspect" }, undefined, undefined, undefined, [location], [older, failed]);
    assert.equal(reloaded.intake?.record.intakeId, "older");
    assert.equal(reloaded.released, undefined);
  });

  it("an explicit pin on the older intake claims no newerIntake while the newer one is unfinished", () => {
    const location = fixtureLocation();
    const older = fixtureIntake("older", 1000, true, location);
    const midPrepare = fixtureIntake("newer", 2000, false, location);
    const oldId = intakeIdFor(location, "older");
    const selection = selectRun([], { id: oldId, origin: "explicit" }, undefined, undefined, undefined, [location], [older, midPrepare]);
    assert.equal(selection.intake?.record.intakeId, "older");
    assert.equal(selection.newerIntake, undefined, "an unusable intake is not yet 'the current one' to name as newer");
  });

  it("an unfinished intake is discoverable but never auto-followed when nothing is pinned", () => {
    const midPrepare = fixtureIntake("mid-prepare", 1000, false);
    const automatic = selectRun([], undefined, undefined, undefined, undefined, [midPrepare.location], [midPrepare]);
    assert.equal(automatic.intake, undefined, "not promoted while its own completion marker is missing");
    assert.equal(promotableIntake([midPrepare], []), undefined);

    const sameOnceUsable = fixtureIntake("mid-prepare", 1000, true);
    assert.equal(promotableIntake([sameOnceUsable], [])?.record.intakeId, "mid-prepare", "sanity: the same intake IS promotable once usable");
  });
});
