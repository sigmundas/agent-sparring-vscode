import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun, type RunSnapshot } from "../core/discovery";
import { buildOverviewModel, type OverviewArtifacts } from "../core/overviewModel";
import { PINNED_MARK, buildRunQuickPickSections, initialRunFocus, resolveAmbiguousChoice } from "../core/runPick";
import { buildRunIndex } from "../core/runIndex";
import { Workspace } from "./fixtures";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const NONE: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false };
const PLAN = "## Stage 1 — One\nbody\n## Stage 2 — Two\nbody\n## Stage 3 — Three\nbody\n";

/** The reported case: fix2 Running at stage 1 and s1 Paused at stage 3, plus a completed run. */
async function twoOpenRuns(withComplete = true): Promise<{ ws: Workspace; runs: RunSnapshot[] }> {
  const ws = await Workspace.create();
  await ws.writePlan("docs/plans/fresh-agent-session-fixes-2.md", PLAN);
  await ws.writePlan("docs/plans/s1.md", PLAN);
  await ws.writePlan("docs/plans/old.md", PLAN);
  await ws.writePlanRun("s1", { plan: "docs/plans/s1.md", status: "paused", current_stage_index: 2, current_stage: "s1-stage-3-three" });
  await ws.writePlanRun("fresh-agent-session-fix2", { plan: "docs/plans/fresh-agent-session-fixes-2.md", status: "running", current_stage_index: 0, current_stage: "fresh-agent-session-fix2-stage-1-one" });
  if (withComplete) {
    await ws.writePlanRun("old", { plan: "docs/plans/old.md", status: "complete", current_stage_index: 2, current_stage: "old-stage-3-three" });
  }
  return { ws, runs: (await discoverRuns([ws.location])).runs };
}

function key(run: RunSnapshot | undefined): string | undefined {
  return run?.kind === "plan" ? run.runKey : run?.stage.stageId;
}

describe("run quick pick", () => {
  it("open runs first, running before paused, recent after; status leads each label", async () => {
    const { runs } = await twoOpenRuns();
    const sections = buildRunQuickPickSections(buildRunIndex(runs), { nowMs: NOW });
    assert.deepEqual(
      sections.map((section) => [section.title, section.items.map((item) => key(item.run))]),
      [
        ["OPEN", ["fresh-agent-session-fix2", "s1"]],
        ["RECENT", ["old"]],
      ],
    );
    assert.match(sections[0].items[0].label, /^Running {2}fresh-agent-session-fixes-2\.md$/);
    assert.match(sections[0].items[0].description, /^Stage 1 of 3 · /);
    assert.match(sections[0].items[1].label, /^Paused {2}s1\.md$/);
    assert.match(sections[1].items[0].label, /^Complete {2}old\.md$/);
    // The run key is secondary: in the detail line, never the label.
    assert.match(sections[0].items[0].detail, / · fresh-agent-session-fix2$/);
  });

  it("the pinned run is ticked and says pinned", async () => {
    const { runs } = await twoOpenRuns();
    const s1 = runs.find((run) => key(run) === "s1");
    const items = buildRunQuickPickSections(buildRunIndex(runs), { pinnedId: s1?.id, nowMs: NOW }).flatMap((section) => section.items);
    const pinned = items.filter((item) => item.label.startsWith("$(check) "));
    assert.deepEqual(pinned.map((item) => key(item.run)), ["s1"]);
    assert.ok(pinned[0].description.startsWith(`${PINNED_MARK} · `));
    assert.ok(items.filter((item) => item.run !== s1).every((item) => !item.description.includes(PINNED_MARK)));
  });

  it("initial focus: the pin wins, else the single running run in the followed repository", async () => {
    const { ws, runs } = await twoOpenRuns();
    const s1 = runs.find((run) => key(run) === "s1");
    assert.equal(key(initialRunFocus(runs, s1?.id, ws.root)), "s1");
    assert.equal(key(initialRunFocus(runs, undefined, ws.root)), "fresh-agent-session-fix2");
    assert.equal(initialRunFocus(runs, undefined, undefined), undefined);
  });

  it("a remembered, unpinned run on screen wins over the single running run", async () => {
    const { ws, runs } = await twoOpenRuns();
    const s1 = runs.find((run) => key(run) === "s1");
    const selection = selectRun(runs, undefined, s1?.id);
    assert.equal(key(selection.selected), "s1");
    assert.ok(!selection.pinned);
    assert.equal(key(initialRunFocus(runs, undefined, ws.root, selection.selected?.id)), "s1");
    const items = buildRunQuickPickSections(buildRunIndex(runs), { pinnedId: undefined, nowMs: NOW }).flatMap((section) => section.items);
    assert.ok(items.every((item) => !item.label.startsWith("$(check) ")), "only a real pin is ticked");
  });

  it("a shown run outside the followed repository does not win focus", async () => {
    const { ws, runs: here } = await twoOpenRuns(false);
    const other = await Workspace.create({ name: "other" });
    await other.writePlan("docs/plans/x.md", PLAN);
    await other.writePlanRun("stale", { plan: "docs/plans/x.md", status: "paused", current_stage_index: 0, current_stage: "stale-stage-1-one" });
    const stale = (await discoverRuns([other.location])).runs;
    assert.equal(key(initialRunFocus([...stale, ...here], undefined, ws.root, stale[0].id)), "fresh-agent-session-fix2");
  });

  it("never focuses a run from another repository than the one followed", async () => {
    const { runs: here } = await twoOpenRuns(false);
    const other = await Workspace.create({ name: "other" });
    await other.writePlan("docs/plans/x.md", PLAN);
    await other.writePlanRun("stale", { plan: "docs/plans/x.md", status: "running", current_stage_index: 0, current_stage: "stale-stage-1-one" });
    const stale = (await discoverRuns([other.location])).runs;
    const followed = await Workspace.create({ name: "followed" });
    assert.equal(initialRunFocus([...stale, ...here], undefined, followed.root), undefined, "nothing running in the followed repository");
    assert.equal(key(initialRunFocus([...stale, ...here], undefined, here[0].location.repoRoot)), "fresh-agent-session-fix2");
  });
});

describe("ambiguity screen", () => {
  it("two open runs: rows with status, stage, run key and plan; nothing auto-selected", async () => {
    const { runs } = await twoOpenRuns();
    const selection = selectRun(runs);
    assert.equal(selection.selected, undefined);
    const model = buildOverviewModel(selection, undefined, NONE, NOW);
    assert.equal(model.kind, "ambiguous");
    assert.equal(model.title, "Multiple open runs found — choose one to follow");
    assert.deepEqual(
      model.runChoices?.map((row) => [row.status, row.stage, row.runKey, row.plan.endsWith(".md"), row.likely]),
      [
        ["Running", "Stage 1 of 3", "fresh-agent-session-fix2", true, true],
        ["Paused", "Stage 3 of 3", "s1", true, false],
      ],
    );
    assert.ok(model.runChoices?.[0].plan.includes("fresh-agent-session-fixes-2.md"));
  });

  it("a single open run is still selected automatically", async () => {
    const ws = await Workspace.create();
    await ws.writePlan("docs/plans/s1.md", PLAN);
    await ws.writePlanRun("s1", { plan: "docs/plans/s1.md", status: "paused", current_stage_index: 2, current_stage: "s1-stage-3-three" });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    assert.equal(key(selection.selected), "s1");
    assert.equal(buildOverviewModel(selection, undefined, NONE, NOW).kind === "ambiguous", false);
  });

  it("a row's id is honoured only when it is one of the offered runs, and then pins like the quick pick", async () => {
    const { runs } = await twoOpenRuns();
    const selection = selectRun(runs);
    const s1 = runs.find((run) => key(run) === "s1");
    const old = runs.find((run) => key(run) === "old");
    assert.equal(resolveAmbiguousChoice(selection, "not-a-run"), undefined);
    assert.equal(resolveAmbiguousChoice(selection, old?.id), undefined, "a discovered but not offered run is refused");
    assert.equal(resolveAmbiguousChoice(selection, 42), undefined);
    const chosen = resolveAmbiguousChoice(selection, s1?.id);
    assert.equal(chosen, s1);
    // chooseRun stores the id as the explicit preference; the next selection keeps it.
    assert.equal(key(selectRun(runs, chosen?.id).selected), "s1");
    assert.equal(resolveAmbiguousChoice(selectRun(runs, chosen?.id), s1?.id), undefined, "nothing to choose once a run is selected");
  });
});
