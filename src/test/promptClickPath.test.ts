/**
 * The whole wire behind the prompt inspector's two controls.
 *
 * Both of them live inside a `<summary>`, which is the interesting part: a
 * click there toggles the disclosure by default, so "Open brief.md" and
 * "Copy prompt" can look perfectly correct in the markup while doing
 * nothing but collapsing the section they sit in. That is invisible in a
 * rendered snapshot, so these tests drive the markup the renderer actually
 * emits through the script the document actually ships, and hand what it
 * posts to the host's own parser.
 *
 * The boundary this cannot cross is VS Code's `postMessage`; everything
 * either side of it is the shipped code.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverRuns, selectRun } from "../core/discovery";
import { isCopyPromptMessage, isOpenPromptSourceMessage, renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel, type CapturedPrompt, type OverviewArtifacts } from "../core/overviewModel";
import { Workspace } from "./fixtures";
import { elementFrom, runWebviewScript } from "./webviewShim";

const NOW = Date.parse("2026-09-15T13:20:00.000Z");
const STAGE = "stage-5-independent-final-review-and-activation-decision";

const BRIEF_SECTION = "## Stage brief\n\nA fresh top-level reviewer verifies frozen candidate SHAs.";
const SCOPE_SECTION = "## Scope reminder\n\nStay within this stage's bounded goal above. Do not expand scope.";

/** A capture in exactly the shape the engine writes, with real offsets. */
function captured(): CapturedPrompt {
  const text = `${BRIEF_SECTION}\n\n${SCOPE_SECTION}\n`;
  return {
    entry: {
      seq: 1,
      ts: "2026-09-15T11:09:04.976Z",
      role: "stage",
      stageId: STAGE,
      turnKind: "original",
      resumed: false,
      expectedBranch: "feature/reported-statistics-contract",
      file: "0001-stage-original.md",
      chars: text.length,
      sections: [
        { heading: "Stage brief", origin: "file", source: `stages/${STAGE}/brief.md`, start: 0, end: BRIEF_SECTION.length },
        { heading: "Scope reminder", origin: "engine", start: BRIEF_SECTION.length + 2, end: BRIEF_SECTION.length + 2 + SCOPE_SECTION.length },
      ],
    },
    text,
  };
}

/** `capturedPrompts` is passed through as given — `undefined` means the engine captured nothing. */
async function inspector(capturedPrompts: CapturedPrompt[] | undefined) {
  const ws = await Workspace.create();
  await ws.writeStage(STAGE, { status: "working", implementation_session_id: "impl-1" });
  const selection = selectRun((await discoverRuns([ws.location])).runs);
  const artifacts: OverviewArtifacts = { handoff: false, sparring: false, brief: false, plan: false, capturedPrompts };
  const model = buildOverviewModel(selection, undefined, artifacts, NOW);
  return { model, html: renderOverviewHtml(model, "n", "c") };
}

describe("opening the file a prompt section came from", () => {
  it("travels markup → shipped listener → message → host parser, without toggling the section", async () => {
    const { html } = await inspector([captured()]);

    const button = elementFrom(html, "button", /<button class="linkish" data-openprompt="[^"]*"[^>]*>/, "the section's source button");
    const { document, posted } = runWebviewScript(html);
    const result = document.dispatch("click", button);

    assert.deepEqual(posted, [{ type: "openPromptSource", source: `stages/${STAGE}/brief.md` }]);
    // The shipped script guards the <summary>'s default toggle. A real
    // browser would not toggle for a button anyway (the integration suite
    // checks the behaviour a person sees); this pins the guard itself,
    // which is what keeps that true if the control stops being a button.
    assert.equal(result.defaultPrevented, true, "the listener suppresses the summary's default activation");
    assert.equal(isOpenPromptSourceMessage(posted[0]), true, "the host accepts what the page sent");
  });

  it("refuses a source that tries to leave the sparring directory", () => {
    for (const source of ["../../../etc/passwd", "/etc/passwd", "C:\\secrets", "stages/../../out", ""]) {
      assert.equal(isOpenPromptSourceMessage({ type: "openPromptSource", source }), false, source);
    }
  });
});

describe("copying the exact prompt", () => {
  it("travels the same path and names the role it was clicked on", async () => {
    const { html, model } = await inspector([captured()]);

    const button = elementFrom(html, "button", /<button class="quiet" data-copyprompt="[^"]*">/, "the copy button");
    const { document, posted } = runWebviewScript(html);
    document.dispatch("click", button);

    assert.deepEqual(posted, [{ type: "copyPrompt", role: "stage" }]);
    assert.equal(isCopyPromptMessage(posted[0]), true);
    // What the host would put on the clipboard is the captured text itself.
    assert.equal(model.stageAgent?.prompt?.exact, captured().text);
  });
});

describe("what the card shows", () => {
  it("puts the role and turn kind before the prompt body", async () => {
    const { model, html } = await inspector([captured()]);

    assert.equal(model.stageAgent?.prompt?.turn, "Implementation turn");
    assert.equal(model.stageAgent?.prompt?.detail, "first turn of this stage");
    const turnline = /<div class="turnline">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    assert.match(turnline, /Implementation turn/);
    assert.match(turnline, /first turn of this stage/);
    assert.match(turnline, /feature\/reported-statistics-contract/);
    // And it comes before any section body in the document.
    assert.ok(html.indexOf('class="turnline"') < html.indexOf('class="prompttext"'));
  });

  it("distinguishes the plan's words from Agent Sparring's own", async () => {
    const { html } = await inspector([captured()]);

    assert.match(html, /data-openprompt="stages\/[^"]*brief\.md"[^>]*>brief\.md</);
    assert.match(html, /<span class="sechead">Scope reminder<\/span><span class="secsrc muted">Agent Sparring<\/span>/);
  });

  it("escapes the prompt instead of rendering it", async () => {
    const injected = "## Stage brief\n\n<script>alert(1)</script> & <b>bold</b>";
    const text = `${injected}\n`;
    const capture: CapturedPrompt = {
      entry: { seq: 1, ts: "", role: "stage", stageId: STAGE, turnKind: "original", resumed: false, file: "0001-stage-original.md", chars: text.length, sections: [{ heading: "Stage brief", origin: "file", source: `stages/${STAGE}/brief.md`, start: 0, end: injected.length }] },
      text,
    };
    const { html } = await inspector([capture]);

    assert.ok(!html.includes("<script>alert(1)</script>"), "no markup from the prompt reaches the document");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  });

  it("stays a plain card when the engine has captured nothing", async () => {
    const { model, html } = await inspector(undefined);

    assert.equal(model.stageAgent?.prompt, undefined);
    assert.ok(!html.includes("Show instructions"), "no disclosure that would open on nothing");
    assert.match(html, /<div class="card actor">/);
  });
});
