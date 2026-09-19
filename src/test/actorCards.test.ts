/**
 * The actor cards as the configuration surface.
 *
 * There used to be two descriptions of the same two agents on this screen: a
 * card per actor, and below it an "Agents" panel repeating both roles with
 * their provider, model and effort. One of the two was always going to be
 * the one somebody read by mistake. The cards are now the only place, and
 * these tests pin what that means.
 *
 * The property under test is still the negative one the configuration code
 * has always had: every value a control offers has to have come out of the
 * engine's JSON. Moving the controls into the cards must not turn any of
 * them into a list this extension maintains.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PROVIDER_DEFAULT_LABEL, parseEngineConfig, type EffectiveConfig } from "../core/effectiveConfig";
import { discoverRuns, selectRun, type RunSelection } from "../core/discovery";
import { isAgentConfigMessage, renderOverviewHtml } from "../core/overviewHtml";
import { APPLIES_NEXT_TURN, buildOverviewModel, type CapturedPrompt, type OverviewArtifacts } from "../core/overviewModel";
import { foldEvents } from "../core/liveState";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, event } from "./fixtures";
import { elementFrom, runWebviewScript } from "./webviewShim";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const CONFIG_PATH = "/repo/.sparring/project.toml";

/**
 * One `show-config --json` payload. Deliberately unfamiliar values — a level
 * called `brisk`, a model nobody ships — so a test that passes can only be
 * passing because the value travelled from this JSON to the control.
 */
function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    config_path: CONFIG_PATH,
    config_exists: true,
    project: "demo",
    error: null,
    stage: {
      role: "stage",
      provider: "claude-cli",
      provider_display_name: "Claude",
      provider_source: "project",
      model: "opus",
      model_source: "project",
      effort: "high",
      effort_source: "project",
      effort_supported: true,
      effort_levels: ["low", "medium", "high", "brisk"],
    },
    sparring: {
      role: "sparring",
      provider: "codex-cli",
      provider_display_name: "Codex",
      provider_source: "project",
      model: "gpt-5.6-terra",
      model_source: "project",
      effort: null,
      effort_source: "provider-default",
      effort_supported: true,
      effort_levels: ["minimal", "glacial"],
    },
    ...overrides,
  });
}

function parsed(overrides: Record<string, unknown> = {}): EffectiveConfig {
  const value = parseEngineConfig(report(overrides));
  assert.ok(value, "the fixture must parse");
  return { kind: "report", report: value };
}

/** A capture in the shape the engine writes, so the card offers its disclosure. */
function captured(stageId: string): CapturedPrompt {
  const text = "## Stage brief\n\nDo the bounded thing.\n";
  return {
    entry: {
      seq: 1,
      ts: "2026-09-18T11:09:04.976Z",
      role: "stage",
      stageId,
      turnKind: "original",
      resumed: false,
      file: "0001-stage-original.md",
      chars: text.length,
      sections: [{ heading: "Stage brief", origin: "file", source: `stages/${stageId}/brief.md`, start: 0, end: text.length - 1 }],
    },
    text,
  };
}

async function planSelection(): Promise<RunSelection> {
  const ws = await Workspace.create();
  await ws.writePlan();
  await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "running", current_stage_index: 0, current_stage: FOO_STAGE_IDS[0] });
  await ws.writeStage(FOO_STAGE_IDS[0], { status: "working", implementation_session_id: "82ab12345678", sparring_session_id: "019d" });
  return selectRun((await discoverRuns([ws.location])).runs);
}

function artifacts(agentConfig: EffectiveConfig | undefined, capturedPrompts?: CapturedPrompt[]): OverviewArtifacts {
  return { handoff: false, sparring: false, brief: false, plan: false, agentConfig, capturedPrompts };
}

/** The markup of one actor card, so "inside the card" is a claim about the document. */
function card(html: string, role: "Stage agent" | "Sparrer"): string {
  const section = /<section class="actors">([\s\S]*?)<\/section>/.exec(html)?.[1];
  assert.ok(section, "the page has an actors section");
  // Every card comes before every instructions panel, so the cards end where
  // the first panel begins. That ordering is the layout: it is what keeps a
  // card in its row when the other actor's instructions are opened.
  const cards = section.split('<div class="instrpanel')[0];
  const pieces = cards.split('<div class="card actor ').filter((piece) => piece.trim() !== "");
  const found = pieces.find((piece) => piece.includes(`>${role}</div>`));
  assert.ok(found, `a card headed ${role}`);
  return found;
}

/** One instructions panel, which lives after the cards rather than in one. */
function panel(html: string, role: "stage" | "sparrer"): string {
  const section = /<section class="actors">([\s\S]*?)<\/section>/.exec(html)?.[1];
  assert.ok(section, "the page has an actors section");
  const pieces = section.split('<div class="instrpanel ').slice(1);
  const found = pieces.find((piece) => piece.includes(`data-instrpanel="${role}"`));
  assert.ok(found, `an instructions panel for ${role}`);
  return found;
}

describe("each actor card is its own configuration surface", () => {
  it("1+2+3. leads with the role, in that role's colour, and names the provider underneath it", async () => {
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW), "n", "c");

    const stage = card(html, "Stage agent");
    const sparrer = card(html, "Sparrer");
    assert.match(stage, /<div class="rolename claude">Stage agent<\/div><div class="provider muted">Claude<\/div>/);
    assert.match(sparrer, /<div class="rolename codex">Sparrer<\/div><div class="provider muted">Codex<\/div>/);
    // The role comes first in the document, and the provider is not the heading.
    assert.ok(stage.indexOf("Stage agent") < stage.indexOf("Claude"), "role before provider");
    assert.ok(!html.includes("Claude (Stage agent)") && !html.includes("Codex (Sparrer)"), "the provider never headlines the card");
  });

  it("4+5. puts each role's model and effort inside that role's own card", async () => {
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW), "n", "c");

    const stage = card(html, "Stage agent");
    assert.match(stage, /Model<\/span><span class="agentconfig-fixed"[^>]*>opus<\/span>/);
    assert.match(stage, /data-role="stage"[^>]*data-field="effort"/);
    assert.doesNotMatch(stage, /data-role="sparring"/, "the stage card configures the stage role only");

    const sparrer = card(html, "Sparrer");
    assert.match(sparrer, /Model<\/span><span class="agentconfig-fixed"[^>]*>gpt-5\.6-terra<\/span>/);
    assert.match(sparrer, /data-role="sparring"[^>]*data-field="effort"/);
    assert.doesNotMatch(sparrer, /data-role="stage"/);

    // And exactly once each: a second copy anywhere is the duplication this
    // layout exists to remove.
    for (const role of ["stage", "sparring"]) {
      assert.equal(
        (html.match(new RegExp(`data-role="${role}" data-scope="[^"]*" data-field="effort"`, "g")) ?? []).length,
        1,
        `one ${role} effort control on the page`,
      );
    }
    for (const model of ["opus", "gpt-5.6-terra"]) {
      assert.equal((html.match(new RegExp(`>${model.replace(".", "\\.")}</span>`, "g")) ?? []).length, 1, `${model} is stated once`);
    }
  });

  it("6. has no separate Agents panel left to disagree with the cards", async () => {
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW), "n", "c");

    assert.ok(!html.includes('class="agentconfig"'), "the panel is gone");
    assert.ok(!/<h3[^>]*>(<svg[^>]*>[\s\S]*?<\/svg>)?Agents<\/h3>/.test(html), "and so is its heading");
  });

  it("7. reports a model the extension never heard of, and offers no control to pick one", async () => {
    const exotic = parsed({
      stage: { ...JSON.parse(report()).stage, model: "some-model-2031-preview" },
      sparring: { ...JSON.parse(report()).sparring, model: null },
    });
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(exotic), NOW), "n", "c");

    const stage = card(html, "Stage agent");
    assert.match(stage, /<span class="agentconfig-fixed"[^>]*>some-model-2031-preview<\/span>/, "whatever the engine resolved, stated verbatim");
    assert.doesNotMatch(stage, /<select[^>]*data-field="model"/, "a closed list would reject a model that exists");
    assert.doesNotMatch(stage, /<input[^>]*data-field="model"/, "and a field would be a box that only finds out on the next turn");

    // No override is the words for that, quietly, and never a model name.
    const sparrer = card(html, "Sparrer");
    assert.match(sparrer, new RegExp(`<span class="agentconfig-fixed novalue"[^>]*>${PROVIDER_DEFAULT_LABEL}</span>`));
    assert.match(sparrer, /title="[^"]*project\.toml[^"]*"/, "and says where a model would be pinned");
  });

  it("8. builds every effort option from the engine's own levels, default first", async () => {
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW), "n", "c");

    const stage = /<select data-role="stage"[^>]*data-field="effort"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    assert.deepEqual(
      [...stage.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]),
      ["", "low", "medium", "high", "brisk"],
      "the engine's levels, verbatim, behind the provider default",
    );
    assert.match(stage, new RegExp(`<option value=""[^>]*>${PROVIDER_DEFAULT_LABEL}</option>`));

    const sparrer = /<select data-role="sparring"[^>]*data-field="effort"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    assert.deepEqual(
      [...sparrer.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]),
      ["", "minimal", "glacial"],
    );
  });

  it("9. still offers Settings, once, and it is the project's own file", async () => {
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(parsed()), NOW), "n", "c");

    assert.equal((html.match(/data-action="openSettings"/g) ?? []).length, 1, "one shared action, not one per card");
    assert.match(html, /data-action="openSettings" title="[^"]*project\.toml/);
    // Beside the cards, not inside one of them.
    assert.doesNotMatch(card(html, "Stage agent"), /data-action="openSettings"/);
    assert.ok(html.indexOf('<section class="actors">') < html.indexOf('data-action="openSettings"'));
  });

  it("10. says what each actor is doing, in the card's top corner on the role's own line", async () => {
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const model = buildOverviewModel(await planSelection(), live, artifacts(parsed()), Date.parse(live.lastEventTs!) + 1000);
    const html = renderOverviewHtml(model, "n", "c");

    assert.equal(model.stageAgent?.activity, "Working");
    // Inside the identity row, after the role and provider: that is what puts
    // it in the corner beside the role rather than under the controls.
    assert.match(
      card(html, "Stage agent"),
      /<div class="rolename claude">Stage agent<\/div><div class="provider muted">Claude<\/div><\/div><span class="statepill working[^"]*"><svg[^>]*>.*?<\/svg><span>Working\??[^<]*<\/span><\/span><\/div>/,
      "the state is the last thing in the header row",
    );
    assert.match(card(html, "Sparrer"), /<span class="statepill waiting">/);

    // Nothing has confirmed this runner, so the word carries the question and
    // the pill stays short: the age of an unconfirmed turn is a note, not the
    // duration of a state.
    assert.match(card(html, "Stage agent"), /<span>Working\?<\/span>/);
    assert.match(card(html, "Stage agent"), /<div class="statenote">turn observed [^<]*ago · runner status unknown<\/div>/);
  });

  it("10b. the session and thread ids are not repeated on the card; the footer carries them", async () => {
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const model = buildOverviewModel(await planSelection(), live, artifacts(parsed()), Date.parse(live.lastEventTs!) + 1000);
    const html = renderOverviewHtml(model, "n", "c");

    assert.doesNotMatch(html, /class="session muted"/, "the card does not carry a shorter copy of it");
    // The same ids, longer, under a label that says which is which.
    assert.match(html, /<dt>Stage session<\/dt><dd>82ab12345678<\/dd>/);
    assert.match(html, /<dt>Sparring thread<\/dt><dd>019d<\/dd>/);
  });

  it("10c. keeps a caveat about the state, on its own row under the header", async () => {
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const stale = Date.parse(live.lastEventTs!) + 40 * 60 * 1000;
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), live, artifacts(parsed()), stale), "n", "c");

    const stage = card(html, "Stage agent");
    assert.match(stage, /<span class="statepill working[^"]*">/, "the state stays the headline");
    assert.match(stage, /<div class="statenote">[^<]*no meaningful activity for [^<]*<\/div>/, "and the caveat is quieter, below it");
    // Outside the header row, or the longest caveat would size the header and
    // push the role name onto two lines.
    assert.match(stage, /<\/span><\/div><div class="statenote">/);
  });

  it("11. keeps Show instructions on the card, opening a panel that is keyed so it survives a rerender", async () => {
    const selection = await planSelection();
    const model = buildOverviewModel(selection, undefined, artifacts(parsed(), [captured(FOO_STAGE_IDS[0])]), NOW);
    const html = renderOverviewHtml(model, "n", "c");

    // The toggle is in the card and the panel is not: a card that grew would
    // push the other actor's card out of the row they share.
    assert.match(
      card(html, "Stage agent"),
      /<button type="button" class="showinstr" data-instr="stage" aria-controls="instr-stage" aria-expanded="false" data-show="Show instructions" data-hide="Hide instructions">Show instructions<\/button>/,
      "the control says what pressing it will do, and carries the word for the other state",
    );
    assert.doesNotMatch(card(html, "Stage agent"), /class="instructions"/, "what the toggle opens is not inside the card");
    assert.match(panel(html, "stage"), /id="instr-stage" data-instrpanel="stage" data-disclose="[^"]*\/stage\/instructions" hidden/);
    assert.match(panel(html, "stage"), /class="instructions"/, "and it is the panel that holds them");

    const first = runWebviewScript(html);
    const disclosure = first.document.disclosures.find((node) => (node.getAttribute("data-disclose") ?? "").endsWith("/stage/instructions"));
    assert.ok(disclosure, "the instructions disclosure is keyed by role, not by position");
    assert.equal(disclosure.open, false, "closed until somebody opens it");
    // Clicks the card's button, which is the only way the page opens it.
    disclosure.click();
    assert.equal(disclosure.open, true);
    assert.equal(first.document.toggles[0]?.getAttribute("aria-expanded"), "true", "and the card's toggle says so");
    assert.equal(first.document.toggles[0]?.textContent, "Hide instructions", "and now offers to put them away again");

    // Pressing it again closes them: the toggle is the only control, so if
    // it did not close them nothing would.
    disclosure.click();
    assert.equal(disclosure.open, false);
    assert.equal(first.document.toggles[0]?.textContent, "Show instructions");
    disclosure.click();

    // The host rerenders during a live run by replacing the whole document.
    const second = runWebviewScript(renderOverviewHtml(model, "n", "c"), "n", first.state);
    const again = second.document.disclosures.find((node) => node.getAttribute("data-disclose") === disclosure.getAttribute("data-disclose"));
    assert.equal(again?.open, true, "what the person opened is still open after the rerender");
    assert.equal(second.document.toggles[0]?.getAttribute("aria-expanded"), "true", "and the restored panel's toggle agrees with it");
  });

  it("11b. is a tab strip: opening one actor's instructions closes the other's", async () => {
    const selection = await planSelection();
    const captures = [captured(FOO_STAGE_IDS[0]), { ...captured(FOO_STAGE_IDS[0]), entry: { ...captured(FOO_STAGE_IDS[0]).entry, seq: 2, role: "sparrer" as const } }];
    const html = renderOverviewHtml(buildOverviewModel(selection, undefined, artifacts(parsed(), captures), NOW), "n", "c");

    const run = runWebviewScript(html);
    const sparrer = run.document.disclosures.find((node) => (node.getAttribute("data-disclose") ?? "").endsWith("/sparrer/instructions"));
    const stage = run.document.disclosures.find((node) => (node.getAttribute("data-disclose") ?? "").endsWith("/stage/instructions"));
    assert.ok(sparrer && stage, "both actors have one");

    sparrer.click();
    assert.deepEqual([stage.open, sparrer.open], [false, true], "only the one that was asked for");
    stage.click();
    assert.deepEqual([stage.open, sparrer.open], [true, false], "opening one closes the other: only one is ever open");
    assert.deepEqual(
      run.document.toggles.map((toggle) => toggle.textContent),
      ["Hide instructions", "Show instructions"],
      "and each card's control says what it will do next",
    );
    stage.click();
    assert.deepEqual([stage.open, sparrer.open], [false, false], "pressing the open one closes it and leaves none open");

    // A store written before the panels were exclusive can name both. The
    // page must not come back in a state its own controls cannot produce.
    const both = { value: { disclosures: { [stage.getAttribute("data-disclose") as string]: true, [sparrer.getAttribute("data-disclose") as string]: true } } };
    const reopened = runWebviewScript(html, "n", both);
    const restored = reopened.document.disclosures.filter((node) => (node.getAttribute("data-instrpanel") ?? "") !== "" && node.open);
    assert.equal(restored.length, 1, "at most one instructions panel is restored");
  });

  it("12. a change during a live run goes out on the existing set-config wire, for the next turn", async () => {
    const live = foldEvents([event("stage", "turn.started", { provider: "claude-cli" })]);
    const model = buildOverviewModel(await planSelection(), live, artifacts(parsed()), Date.parse(live.lastEventTs!) + 1000);
    assert.equal(model.agentConfig?.activeRunNote, APPLIES_NEXT_TURN, "said as a fact about when it lands");
    const html = renderOverviewHtml(model, "n", "c");
    assert.match(html, /next agent turn/);

    const effort = elementFrom(html, "select", /<select data-role="stage"[^>]*data-field="effort"[^>]*>/, "the stage effort dropdown");
    effort.value = "brisk";
    const { document, posted } = runWebviewScript(html);
    document.dispatch("change", effort);

    assert.deepEqual(posted, [{ type: "agentConfig", role: "stage", field: "effort", value: "brisk", scope: CONFIG_PATH }]);
    assert.equal(isAgentConfigMessage(posted[0]), true, "and the host accepts what the card sent");

    // And the model cannot be put on the wire from the page at all: it is
    // read-only text, so there is no element carrying the field to post.
    assert.doesNotMatch(html, /data-field="model"/);
  });

  it("13. adds no provider, model or effort table to the extension's source", async () => {
    // The whole point of reading `show-config --json`. Any of these spelled
    // in shipped code is a second copy of a provider capability, free to
    // diverge from the engine's.
    const root = path.join(__dirname, "..", "..", "src");
    const offenders: string[] = [];
    for (const file of await sources(root)) {
      if (file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}integration${path.sep}`)) {
        continue;
      }
      const code = (await fs.readFile(file, "utf8"))
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
        .join("\n");
      if (/\bxhigh\b|\bultra\b|\bopus\b|\bsonnet\b|\bgpt-/i.test(code)) {
        offenders.push(path.relative(root, file));
      }
    }
    assert.deepEqual(offenders, [], "models and effort levels come from the engine, never from extension source");
  });
});

describe("the cards before anything is running", () => {
  it("are the same two cards, with the settings and nothing invented around them", () => {
    const model = buildOverviewModel(
      { ambiguous: [], scope: { repoRoot: "/work/fresh", name: "fresh" } },
      undefined,
      artifacts(parsed({ config_exists: false })),
      NOW,
    );
    assert.equal(model.kind, "empty");
    assert.equal(model.stageAgent?.role, "Stage agent");
    assert.equal(model.stageAgent?.provider, "Claude", "named by the engine, not by a table here");
    assert.equal(model.sparrer?.provider, "Codex");
    assert.equal(model.stageAgent?.activity, undefined, "there is no stage, so there is nothing to report");
    assert.equal(model.sparrer?.sessionLabel, undefined);

    const html = renderOverviewHtml(model, "n", "c");
    assert.match(card(html, "Stage agent"), /Model<\/span><span class="agentconfig-fixed/);
    assert.match(card(html, "Sparrer"), /data-role="sparring"[^>]*data-field="effort"/);
    assert.doesNotMatch(html, /class="statepill/, "no Working/Idle word for a run that does not exist");
    assert.doesNotMatch(html, /class="statenote/);
    assert.match(html, /data-action="openSettings"/);
    assert.match(html, /No project.toml yet/);
  });

  it("withhold the controls, and say why, when the engine could not resolve the configuration", async () => {
    const broken = parsed({ error: "[agents.stage] has unknown field(s) 'efort'", stage: undefined, sparring: undefined });
    const html = renderOverviewHtml(buildOverviewModel(await planSelection(), undefined, artifacts(broken), NOW), "n", "c");

    assert.match(html, /unknown field\(s\) &#39;efort&#39;/);
    assert.doesNotMatch(html, /data-field="model"/, "no control prefilled with a guess");
    assert.match(html, /data-action="openSettings"/, "which is exactly when the file is wanted");
  });
});

/** Every .ts file under a directory, recursively. */
async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sources(full)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}
