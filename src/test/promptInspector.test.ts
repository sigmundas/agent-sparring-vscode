import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPromptView,
  latestCapture,
  parseCaptureIndex,
  type CaptureEntry,
} from "../core/promptInspector";

/**
 * A captured prompt in the shape the engine writes, built here so the spans
 * are real offsets into real text rather than numbers chosen to match an
 * assertion.
 */
function capture(sections: { heading: string; source?: string; text: string }[]): {
  prompt: string;
  line: string;
} {
  const prompt = sections.map((section) => section.text).join("\n\n") + "\n";
  let cursor = 0;
  const recorded = sections.map((section, index) => {
    if (index) {
      cursor += 2;
    }
    const start = cursor;
    cursor += section.text.length;
    return {
      heading: section.heading,
      origin: section.source ? "file" : "engine",
      source: section.source ?? null,
      start,
      end: cursor,
    };
  });
  const line = JSON.stringify({
    v: 1,
    seq: 1,
    ts: "2026-09-15T11:09:04.976Z",
    role: "stage",
    stage_id: "stage-5",
    turn_kind: "original",
    resumed: false,
    expected_branch: "feature/x",
    file: "0001-stage-original.md",
    chars: prompt.length,
    sections: recorded,
  });
  return { prompt, line };
}

const BRIEF = "## Stage brief\n\nA fresh top-level reviewer verifies the frozen SHAs.";
const SCOPE = "## Scope reminder\n\nStay within this stage's bounded goal above.";

describe("parseCaptureIndex", () => {
  it("reads the engine's own field names", () => {
    const { line } = capture([{ heading: "Stage brief", source: "stages/stage-5/brief.md", text: BRIEF }]);
    const entries = parseCaptureIndex(line + "\n");

    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "stage");
    assert.equal(entries[0].turnKind, "original");
    assert.equal(entries[0].expectedBranch, "feature/x");
    assert.equal(entries[0].sections[0].source, "stages/stage-5/brief.md");
  });

  it("drops a malformed line without losing the rest", () => {
    const { line } = capture([{ heading: "Stage brief", text: BRIEF }]);
    const entries = parseCaptureIndex(["{not json", "", line, '{"role":"nobody"}'].join("\n"));

    assert.equal(entries.length, 1);
    assert.equal(entries[0].seq, 1);
  });

  it("is empty when there is no index at all", () => {
    assert.deepEqual(parseCaptureIndex(undefined), []);
  });
});

describe("latestCapture", () => {
  it("takes the highest sequence for the role, not the last line", () => {
    const entries: CaptureEntry[] = [
      { seq: 3, ts: "", role: "stage", stageId: "s", turnKind: "resume", resumed: true, file: "3.md", chars: 0, sections: [] },
      { seq: 4, ts: "", role: "sparrer", stageId: "s", turnKind: "resume", resumed: true, file: "4.md", chars: 0, sections: [] },
      { seq: 1, ts: "", role: "stage", stageId: "s", turnKind: "original", resumed: false, file: "1.md", chars: 0, sections: [] },
    ];

    assert.equal(latestCapture(entries, "stage")?.seq, 3);
    assert.equal(latestCapture(entries, "sparrer")?.seq, 4);
  });

  it("has nothing for a role that has not run", () => {
    assert.equal(latestCapture([], "sparrer"), undefined);
  });
});

describe("buildPromptView", () => {
  it("slices the captured prompt rather than re-parsing it", () => {
    const { prompt, line } = capture([
      { heading: "Stage brief", source: "stages/stage-5/brief.md", text: BRIEF },
      { heading: "Scope reminder", text: SCOPE },
    ]);
    const view = buildPromptView(parseCaptureIndex(line)[0], prompt, { live: true });

    assert.equal(view.sections.length, 2);
    assert.equal(view.sections[0].text, BRIEF);
    assert.equal(view.sections[1].text, SCOPE);
    assert.equal(view.exact, prompt);
  });

  it("keeps the engine's provenance for each section", () => {
    const { prompt, line } = capture([
      { heading: "Stage brief", source: "stages/stage-5/brief.md", text: BRIEF },
      { heading: "Scope reminder", text: SCOPE },
    ]);
    const view = buildPromptView(parseCaptureIndex(line)[0], prompt, { live: true });

    assert.equal(view.sections[0].origin, "file");
    assert.equal(view.sections[0].source, "stages/stage-5/brief.md");
    assert.equal(view.sections[1].origin, "engine");
    assert.equal(view.sections[1].source, undefined);
  });

  it("names the role and the turn before anything else", () => {
    const { prompt, line } = capture([{ heading: "Stage brief", text: BRIEF }]);
    const view = buildPromptView(parseCaptureIndex(line)[0], prompt, { live: true });

    assert.equal(view.turn, "Implementation turn");
    assert.equal(view.detail, "first turn of this stage");
    assert.equal(view.branch, "feature/x");
  });

  it("shows an unrecognised turn kind as the engine's own word", () => {
    const { prompt, line } = capture([{ heading: "Stage brief", text: BRIEF }]);
    const entry = { ...parseCaptureIndex(line)[0], turnKind: "some_future_kind" };
    const view = buildPromptView(entry, prompt, { live: false });

    assert.equal(view.detail, "engine turn kind: some_future_kind");
  });

  it("refuses to section a prompt whose length no longer matches the index", () => {
    const { prompt, line } = capture([
      { heading: "Stage brief", source: "stages/stage-5/brief.md", text: BRIEF },
      { heading: "Scope reminder", text: SCOPE },
    ]);
    const view = buildPromptView(parseCaptureIndex(line)[0], prompt + "tampered", { live: false });

    assert.deepEqual(view.sections, []);
    assert.match(view.sectionsUnavailable ?? "", /no longer matches/);
    // The file itself is still true, so it is still shown.
    assert.equal(view.exact, prompt + "tampered");
  });

  it("refuses spans that fall outside the captured prompt", () => {
    const { prompt, line } = capture([{ heading: "Stage brief", text: BRIEF }]);
    const entry = parseCaptureIndex(line)[0];
    const view = buildPromptView(
      { ...entry, chars: prompt.length, sections: [{ heading: "Stage brief", origin: "engine", start: 0, end: prompt.length + 10 }] },
      prompt,
      { live: false },
    );

    assert.deepEqual(view.sections, []);
    assert.match(view.sectionsUnavailable ?? "", /outside the captured prompt/);
  });
});

describe("the Stage 5 case", () => {
  it("makes an implementation framing visible next to a review goal", () => {
    /**
     * The concrete thing this feature exists for: a stage whose brief asks
     * for an independent review, captured on a turn whose framing is the
     * engine's ordinary implementation instruction. Nothing here infers a
     * mismatch — the view just puts the two next to each other, labelled
     * with where each came from, which is what made it findable by hand.
     */
    const { prompt, line } = capture([
      { heading: "Stage brief", source: "stages/stage-5/brief.md", text: BRIEF },
      { heading: "Self-check", text: "## Self-check\n\nBefore finishing this turn, inspect your own implementation for:" },
      { heading: "Scope reminder", text: SCOPE },
    ]);
    const view = buildPromptView(parseCaptureIndex(line)[0], prompt, { live: true });

    assert.equal(view.turn, "Implementation turn");
    const goal = view.sections.find((section) => section.heading === "Stage brief");
    const framing = view.sections.filter((section) => section.origin === "engine");
    assert.match(goal?.text ?? "", /fresh top-level reviewer/);
    assert.equal(goal?.source, "stages/stage-5/brief.md");
    assert.equal(framing.length, 2);
    assert.match(framing[0].text, /your own implementation/);
  });
});
