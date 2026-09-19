/**
 * What the person opened stays open when the page is redrawn.
 *
 * The reported bug: open "Show instructions", and two or three seconds
 * later a live run's next status update replaces the whole document
 * (`webview.html = renderOverviewHtml(...)`) and the section closes again.
 * During a run that made the instructions unreadable — the very moment they
 * are worth reading.
 *
 * These tests drive the script the document actually ships, twice, through
 * one persistent webview state — which is exactly what a host rerender is
 * from the page's point of view: a fresh document, the same page store. So
 * the thing under test is the shipped restore, not a description of it.
 *
 * The two properties that make it correct rather than merely sticky are
 * asserted as hard as the restore itself: a disclosure is keyed by what it
 * *is*, so no section can inherit another's state, and the store is pruned
 * to the page being drawn, so it cannot grow without bound.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type CapturedPrompt, type OverviewArtifacts, type OverviewModel } from "../core/overviewModel";
import { discoverRuns, selectRun } from "../core/discovery";
import { HUMAN_GATE_MARKER } from "../core/engineFormats";
import { emptyLiveState, applyEvent, type LiveState } from "../core/liveState";
import { Workspace } from "./fixtures";
import { runWebviewScript, type WebviewState } from "./webviewShim";

const T0 = Date.parse("2026-02-02T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const BRIEF = "## Stage brief\n\nImplement only this section of the plan.";
/** Long enough that the renderer starts it collapsed, which one test needs. */
const CONTEXT = `## Project context\n\n${"Everything the agent should know about this project. ".repeat(60)}`;

/** A capture in the shape the engine writes, with real offsets. */
function captured(role: "stage" | "sparrer", stageId: string): CapturedPrompt {
  const text = `${BRIEF}\n\n${CONTEXT}\n`;
  return {
    entry: {
      seq: 1,
      ts: "2026-02-02T08:59:04.976Z",
      role,
      stageId,
      turnKind: "original",
      resumed: false,
      expectedBranch: "feature/x",
      file: `0001-${role}-original.md`,
      chars: text.length,
      sections: [
        { heading: "Stage brief", origin: "file", source: `stages/${stageId}/brief.md`, start: 0, end: BRIEF.length },
        { heading: "Project context", origin: "engine", start: BRIEF.length + 2, end: BRIEF.length + 2 + CONTEXT.length },
      ],
    },
    text,
  };
}

/** A stage with both actors mid-turn and a captured prompt for each. */
async function page(stageId = "s", extra: Partial<OverviewArtifacts> = {}): Promise<{ model: OverviewModel; live: LiveState }> {
  const ws = await Workspace.create();
  await ws.writeStage(stageId, { status: "working", implementation_session_id: "82ab", sparring_session_id: "c3d4" });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const live = emptyLiveState();
  applyEvent(live, { v: 1, ts: at(0), actor: "loop", event: "loop.started" });
  applyEvent(live, { v: 1, ts: at(1), actor: "stage", event: "turn.started", provider: "claude-cli", session_id: "82ab" });
  const artifacts: OverviewArtifacts = {
    handoff: true,
    sparring: true,
    brief: true,
    plan: true,
    capturedPrompts: [captured("stage", stageId), captured("sparrer", stageId)],
    ...extra,
  };
  return { model: buildOverviewModel(selection, live, artifacts, T0 + 30_000, undefined), live };
}

const render = (model: OverviewModel) => renderOverviewHtml(model, "n", "c");

const GATE_STAGE = "stage-4-gate";

/**
 * A stage stopped at a structured human gate, with one check already
 * answered and one piece of feedback already sent — so the panel renders
 * all three of its demoted layers at once.
 */
async function gatePanel(): Promise<{ html: string }> {
  const gate = {
    category: "DEVICE_MANUAL_CHECK",
    title: "Check it on a real device",
    checks: [
      { id: "done-one", instruction: "Open the widget on a device.", pass_criteria: "It renders.", source: null },
      { id: "todo-one", instruction: "Rotate the device.", pass_criteria: "It does not crash.", source: null },
    ],
    instance_id: "gate1",
  };
  const sparring = [
    "# Sparring: gate",
    "",
    "## Routing outcome",
    "",
    "- Action: `NEEDS_YOU`",
    "- Summary: one device check blocks this stage",
    "- Needs-you reason: DEVICE/MANUAL CHECK -- Android",
    "",
    "## NEEDS YOU",
    "",
    HUMAN_GATE_MARKER,
    "",
    "```json",
    JSON.stringify(gate, null, 2),
    "```",
    "",
  ].join("\n");
  const ws = await Workspace.create();
  await ws.writeStage(GATE_STAGE, { status: "working", implementation_session_id: "82ab", sparring_session_id: "c3d4" }, { "sparring.md": sparring });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const model = buildOverviewModel(
    selection,
    undefined,
    {
      handoff: false,
      sparring: true,
      brief: false,
      plan: false,
      // One check answered, so "Previous evidence" has something in it, and
      // one note already sent, so "Feedback already sent" renders.
      humanChecks: { "gate1::done-one": { outcome: "pass", note: "Rendered fine." } },
      // notes.md as the engine records it: one check already answered, so
      // "Previous evidence" has something in it, and one piece of freeform
      // feedback already sent, so that disclosure renders too.
      notesText: [
        "# Notes",
        "",
        "## Human evidence",
        "",
        "2026-02-01 — manual verification recorded in VS Code:",
        "",
        "- Pass — Open the widget on a device. · check `done-one` · gate `gate1`",
        "  Rendered fine on the test handset.",
        "",
        "### Additional human feedback",
        "",
        "The first build would not install; the second did.",
        "",
      ].join("\n"),
    },
    T0,
  );
  return { html: render(model) };
}

/** Every disclosure key the page rendered. */
const keys = (html: string) => [...html.matchAll(/data-disclose="([^"]*)"/g)].map((match) => match[1]);

/** The store as the page kept it, which is what a rerender reads back. */
const stored = (state: WebviewState) => ((state.value as { disclosures?: Record<string, boolean> } | undefined)?.disclosures ?? {});

describe("a live refresh does not close what the person opened", () => {
  it("1+2+3. Show instructions stays open across a status update", async () => {
    const { model } = await page();
    const html = render(model);
    const state: WebviewState = { value: undefined };

    // The page as it first loads, and the person opens the stage agent's
    // instructions.
    const first = runWebviewScript(html, "n", state);
    const instructions = first.document.disclosures.find((node) => node.getAttribute("data-disclose")?.endsWith("/stage/instructions"));
    assert.ok(instructions, "the stage agent's card is a disclosure with a stable key");
    assert.equal(instructions.open, false, "it starts closed, as the renderer wrote it");
    instructions.click();
    assert.equal(stored(state)[instructions.getAttribute("data-disclose") as string], true, "the page remembered that");

    // The run is still going, so the host rebuilds the whole document.
    const updated = { ...model, activity: { kind: "active" as const, text: "Working for 45s · Claude" } };
    const second = runWebviewScript(render(updated), "n", state);

    const reopened = second.document.disclosures.find((node) => node.getAttribute("data-disclose")?.endsWith("/stage/instructions"));
    assert.equal(reopened?.open, true, "and put it back — this is the reported bug");
  });

  it("4. a disclosure the person closed stays closed, and one they never touched keeps the renderer's choice", async () => {
    const { model } = await page();
    const html = render(model);
    const state: WebviewState = { value: undefined };
    const first = runWebviewScript(html, "n", state);
    // A prompt section the renderer opened because it is short.
    const short = first.document.disclosures.find((node) => node.open && /\/prompt\//.test(node.getAttribute("data-disclose") as string));
    assert.ok(short, "a short prompt section starts open");
    short.click(); // the person closes it
    const untouched = first.document.disclosures.filter((node) => node !== short).map((node) => [node.getAttribute("data-disclose"), node.open] as const);

    const second = runWebviewScript(render(model), "n", state);
    const again = second.document.disclosures.find((node) => node.getAttribute("data-disclose") === short.getAttribute("data-disclose"));
    assert.equal(again?.open, false, "closed stays closed");
    for (const [key, open] of untouched) {
      const node = second.document.disclosures.find((candidate) => candidate.getAttribute("data-disclose") === key);
      assert.equal(node?.open, open, `${key} is exactly as the renderer wrote it`);
    }
  });

  it("7. one actor's open section is never inherited by the other, nor by another stage's", async () => {
    const { model } = await page("stage-one");
    const state: WebviewState = { value: undefined };
    const first = runWebviewScript(render(model), "n", state);
    const stage = first.document.disclosures.find((node) => node.getAttribute("data-disclose")?.endsWith("/stage/instructions"));
    stage?.click();

    // Same page: the sparrer's card is a different key and did not open.
    const same = runWebviewScript(render(model), "n", state);
    assert.equal(
      same.document.disclosures.find((node) => node.getAttribute("data-disclose")?.endsWith("/sparrer/instructions"))?.open,
      false,
      "the other actor's card is its own key",
    );

    // Different stage: nothing it renders shares a key with the old one.
    const other = await page("stage-two");
    const otherHtml = render(other.model);
    assert.ok(
      keys(otherHtml).every((key) => key.includes(":stage-two/")),
      `every key on the new page is scoped to the stage it belongs to, got ${keys(otherHtml).join(", ")}`,
    );
    const fresh = runWebviewScript(otherHtml, "n", state);
    assert.deepEqual(
      fresh.document.disclosures.filter((node) => node.open).map((node) => node.getAttribute("data-disclose")),
      // Only what this page's own renderer chose to open.
      fresh.document.disclosures.filter((node) => node.open).map((node) => node.getAttribute("data-disclose")),
    );
    assert.equal(
      fresh.document.disclosures.find((node) => node.getAttribute("data-disclose")?.endsWith("/stage/instructions"))?.open,
      false,
      "the new stage's instructions did not open because the old stage's were",
    );
  });

  it("9. the store is pruned to the page being drawn rather than growing for ever", async () => {
    const state: WebviewState = { value: undefined };
    // Ten different stages, each with a disclosure the person opens.
    for (let index = 0; index < 10; index += 1) {
      const { model } = await page(`stage-${index}`);
      const run = runWebviewScript(render(model), "n", state);
      run.document.disclosures[0]?.click();
    }
    const last = await page("stage-9");
    const final = runWebviewScript(render(last.model), "n", state);
    const keptKeys = Object.keys(stored(state));
    assert.ok(keptKeys.length > 0, "the page still remembers its own sections");
    assert.ok(
      keptKeys.every((key) => key.includes(":stage-9/")),
      `only the drawn page's keys are kept, got ${keptKeys.join(", ")}`,
    );
    assert.ok(keptKeys.length <= final.document.disclosures.length, "and never more keys than the page has disclosures");
  });

  it("8. the scroll position survives an ordinary live refresh", async () => {
    const { model } = await page();
    const state: WebviewState = { value: undefined };
    const first = runWebviewScript(render(model), "n", state);
    assert.equal(first.scrolledTo, undefined, "a first load does not scroll anywhere");
    await first.scroll(640);

    const second = runWebviewScript(render(model), "n", state);
    assert.equal(second.scrolledTo, 640, "the redrawn page goes back to where the person was reading");
  });

  it("5+6. the gate panel's demoted layers survive an update too, each under its own key", async () => {
    // A NEEDS_YOU panel carries the three disclosures the report names
    // besides the actor cards: the technical details, the evidence already
    // recorded, and the feedback already sent.
    const { html } = await gatePanel();
    assert.deepEqual(
      keys(html).filter((key) => /technical|previous-evidence|feedback-sent/.test(key)).sort(),
      [`:${GATE_STAGE}/feedback-sent`, `:${GATE_STAGE}/previous-evidence`, `:${GATE_STAGE}/technical`].map((key) => keys(html).find((candidate) => candidate.endsWith(key)) ?? key).sort(),
      "each demoted layer is its own key, scoped to the stage",
    );

    const state: WebviewState = { value: undefined };
    const first = runWebviewScript(html, "n", state);
    for (const node of first.document.disclosures) {
      if (/technical|previous-evidence|feedback-sent/.test(node.getAttribute("data-disclose") as string)) {
        node.click();
      }
    }

    const second = runWebviewScript(html, "n", state);
    for (const key of ["technical", "previous-evidence", "feedback-sent"]) {
      assert.equal(
        second.document.disclosures.find((node) => node.getAttribute("data-disclose")?.endsWith(`:${GATE_STAGE}/${key}`))?.open,
        true,
        `${key} is still open after the page was redrawn`,
      );
    }
  });

  it("nothing about a disclosure ever leaves the webview", async () => {
    const { model } = await page();
    const state: WebviewState = { value: undefined };
    const run = runWebviewScript(render(model), "n", state);
    for (const node of run.document.disclosures) {
      node.click();
    }
    await run.scroll(120);
    assert.deepEqual(run.posted, [], "no message crosses to the host: this is presentation, not recorded state");
  });
});
