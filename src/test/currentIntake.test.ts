/**
 * A plan's current intake is its newest in the project that prepared it.
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
import { currentIntakeOf, discoverRuns, intakeIdFor, selectRun, type SparringLocation } from "../core/discovery";
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
