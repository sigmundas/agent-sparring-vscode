import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as os from "node:os";
import { parseBriefStageMarkers } from "../core/brief";
import { buildNewStageArgs } from "../core/cli";
import { runIdFor } from "../core/discovery";
import { STAGE_ID_RE, createStage, explainNewStageFailure, extractPlanSection, proposeNextStage, renderNextStageBrief } from "../core/nextStage";
import { buildStageIndex, locateStage, parsePlanHeadings } from "../core/planAssociation";
import { withTemporaryFile } from "../core/tempFile";
import { Workspace } from "./fixtures";

/** A plan with a historical Stage 3C handoff before the canonical definition, and a Stage 3D after it. */
const RANGE_PLAN = [
  "# Range semantics",
  "",
  "## Stage 3B — Barrier",
  "",
  "The barrier.",
  "",
  "## Stage 3C handoff — 2026-09-01",
  "",
  "What was done for 3C last time (historical, not the definition).",
  "",
  "## Stage 3C — Cloud schema and synchronization",
  "",
  "Cloud side: schema «ø/æ/å» 🚀.",
  "",
  "### Goal",
  "",
  "- table `reported_statistics`",
  "",
  "```md",
  "## Stage 3D — inside a fence, not a boundary",
  "```",
  "",
  "### Out of scope",
  "",
  "Nothing about the client.",
  "",
  "",
  "## Stage 3D — Client sync",
  "",
  "Client side.",
  "",
].join("\n");

const EXPECTED_3C_SECTION = [
  "## Stage 3C — Cloud schema and synchronization",
  "",
  "Cloud side: schema «ø/æ/å» 🚀.",
  "",
  "### Goal",
  "",
  "- table `reported_statistics`",
  "",
  "```md",
  "## Stage 3D — inside a fence, not a boundary",
  "```",
  "",
  "### Out of scope",
  "",
  "Nothing about the client.",
  "",
].join("\n");

describe("the brief is the plan's own section", () => {
  it("extracts the canonical Stage 3C section verbatim and stops before Stage 3D", () => {
    const index = buildStageIndex(parsePlanHeadings(RANGE_PLAN));
    const next = index.find((entry) => entry.label === "3C")!;
    assert.equal(next.canonical?.line, 11, "the canonical section is the definition, not the earlier handoff");
    assert.equal(extractPlanSection(RANGE_PLAN, next.canonical!.line), EXPECTED_3C_SECTION);
  });

  it("a historical Stage 3C handoff is never the brief when a canonical definition exists", () => {
    const headings = parsePlanHeadings(RANGE_PLAN);
    const position = locateStage(headings, { stageId: "stage-3b-barrier", manual: { label: "3B", title: "Barrier" } });
    assert.equal(position?.next.state, "found");
    const proposal = proposeNextStage(position!.next.state === "found" ? position!.next.stage : (undefined as never))!;
    assert.equal(proposal.stageId, "stage-3c-cloud-schema-and-synchronization");
    const rendered = renderNextStageBrief(RANGE_PLAN, proposal, "range.md");
    assert.ok(rendered.ok);
    assert.equal(rendered.section, EXPECTED_3C_SECTION);
    assert.ok(!rendered.brief.includes("handoff"), "the historical section is not part of the brief");
    assert.ok(!rendered.brief.includes("Client side"), "the later stage is not part of the brief");
    assert.equal(rendered.brief, `# Stage brief: stage-3c-cloud-schema-and-synchronization\n\nStage 3C from plan \`range.md\`. Implement only this section; the other stages are separate.\n\n${EXPECTED_3C_SECTION}`);
  });

  it("a section ends at the next heading of the same or a higher level, keeping its own subsections", () => {
    const md = "# Plan\n\n## Stage 1 — A\n\nbody\n\n### Sub\n\nmore\n\n# Appendix\n\nno\n";
    assert.equal(extractPlanSection(md, 3), "## Stage 1 — A\n\nbody\n\n### Sub\n\nmore\n");
    assert.equal(extractPlanSection(md, 11), "# Appendix\n\nno\n");
    assert.equal(extractPlanSection(md, 1), "# Plan\n\n## Stage 1 — A\n\nbody\n\n### Sub\n\nmore\n", "a level-1 section ends at the next level-1 heading");
    assert.equal(extractPlanSection(md, 5), undefined, "not a heading");
    assert.equal(extractPlanSection(md, 99), undefined);
  });

  it("does not paraphrase and does not embellish: a heading-only section is refused, not filled in", () => {
    const md = "## Stage 3B — Barrier\n\nx\n\n## Stage 3C — Empty\n\n## Stage 3D — Next\n\ny\n";
    const index = buildStageIndex(parsePlanHeadings(md));
    const proposal = proposeNextStage(index.find((entry) => entry.label === "3C")!)!;
    const rendered = renderNextStageBrief(md, proposal, "p.md");
    assert.equal(rendered.ok, false);
    assert.match(rendered.ok ? "" : rendered.message, /has a heading but no content/);
    const moved = renderNextStageBrief("# something else entirely\n", proposal, "p.md");
    assert.equal(moved.ok, false);
    assert.match(moved.ok ? "" : moved.message, /no longer has a heading at line 5/);
  });

  it("the brief names its own stage so the new stage matches the plan by brief alone", () => {
    const index = buildStageIndex(parsePlanHeadings(RANGE_PLAN));
    const proposal = proposeNextStage(index.find((entry) => entry.label === "3C")!)!;
    const rendered = renderNextStageBrief(RANGE_PLAN, proposal, "range.md");
    assert.ok(rendered.ok);
    assert.equal(parseBriefStageMarkers(rendered.brief).current, "3C");
  });
});

describe("proposing the next stage from the plan", () => {
  it("derives `stage-<label>-<slug>` from the canonical section, valid for the engine", () => {
    const index = buildStageIndex(parsePlanHeadings("## Stage 3B — Barrier\n\n## Stage 3C — Cloud schema/RPC & sync transport!\n\nCloud side.\n"));
    const proposal = proposeNextStage(index[1]);
    assert.deepEqual(proposal, { stageId: "stage-3c-cloud-schema-rpc-sync-transport", label: "3C", title: "Cloud schema/RPC & sync transport!", display: "Stage 3C — Cloud schema/RPC & sync transport!", line: 3 });
    assert.match(proposal!.stageId, STAGE_ID_RE);
    assert.ok(proposal!.stageId.length <= 128);
  });

  it("refuses without a clear definition: ambiguous, or only a historical mention", () => {
    const ambiguous = buildStageIndex(parsePlanHeadings("## Stage 3C — One\n## Stage 3C — Two\n"));
    assert.equal(proposeNextStage(ambiguous[0]), undefined);
    const historical = buildStageIndex(parsePlanHeadings("## Stage 4 handoff — 2026-01-01\n"));
    assert.equal(proposeNextStage(historical[0]), undefined);
  });

  it("clamps very long titles to the engine's 128-character limit", () => {
    const index = buildStageIndex(parsePlanHeadings(`## Stage 3C — ${"word ".repeat(60)}\n`));
    const proposal = proposeNextStage(index[0]);
    assert.ok(proposal && proposal.stageId.length <= 128 && STAGE_ID_RE.test(proposal.stageId) && !proposal.stageId.endsWith("-"));
  });
});

describe("new-stage is the engine's own lifecycle", () => {
  it("mirrors cli.py: `[--sparring-dir DIR] new-stage STAGE [--brief-file PATH]`, no --repo-root, unquoted", () => {
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r", sparringDir: "/r/.sparring" }), ["new-stage", "stage-3c-cloud"]);
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r" }), ["new-stage", "stage-3c-cloud"]);
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r", sparringDir: "/r/pkg/.sparring" }), ["--sparring-dir", "/r/pkg/.sparring", "new-stage", "stage-3c-cloud"]);
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r", briefFile: "/tmp/agent-sparring-x/stage-3c-cloud.md" }), ["new-stage", "stage-3c-cloud", "--brief-file", "/tmp/agent-sparring-x/stage-3c-cloud.md"]);
  });

  it("the brief reaches new-stage as a temporary file outside the workspace, removed afterwards", async () => {
    const calls: string[][] = [];
    let seen: { file: string; content: string } | undefined;
    const result = await withTemporaryFile("# Stage brief: stage-3c-cloud\n\nCloud side «ø» 🚀.\n", "stage-3c-cloud.md", (briefFile) =>
      createStage(
        async (args) => {
          calls.push(args);
          seen = { file: briefFile, content: await fs.readFile(briefFile, "utf8") };
          return { exitCode: 0, output: "created stage 'stage-3c-cloud' at /r/.sparring/stages/stage-3c-cloud\n" };
        },
        { stageId: "stage-3c-cloud", repoRoot: "/r", sparringDir: "/r/.sparring", briefFile },
      ),
    );
    assert.deepEqual(result, { ok: true, stageId: "stage-3c-cloud" });
    assert.ok(seen);
    assert.deepEqual(calls, [["new-stage", "stage-3c-cloud", "--brief-file", seen.file]]);
    assert.equal(seen.content, "# Stage brief: stage-3c-cloud\n\nCloud side «ø» 🚀.\n", "written verbatim");
    assert.ok(seen.file.startsWith(path.join(os.tmpdir())) || seen.file.startsWith(await fs.realpath(os.tmpdir())), `under the OS temporary directory, not the workspace: ${seen.file}`);
    assert.ok(!seen.file.includes(".sparring"));
    await assert.rejects(fs.access(seen.file), "the temporary file is removed after the engine ran");
    await assert.rejects(fs.access(path.dirname(seen.file)), "and so is its private directory");
  });

  it("removes the temporary file even when the engine fails, and translates the engine's brief-file refusal", async () => {
    let file = "";
    const failed = await withTemporaryFile("x\n", "s.md", (briefFile) => {
      file = briefFile;
      return createStage(async () => ({ exitCode: 1, output: "could not create stage: could not read --brief-file '/tmp/x': [Errno 2] No such file\n" }), { stageId: "s", repoRoot: "/r", briefFile });
    });
    assert.deepEqual(failed.ok ? undefined : failed.message, "The engine could not read the brief it was given; no stage was created.");
    await assert.rejects(fs.access(file));
    const old = explainNewStageFailure({ exitCode: 2, output: "usage: sparring new-stage [-h] [--exist-ok] stage_id\nsparring new-stage: error: unrecognized arguments: --brief-file /tmp/x\n" });
    assert.match(old.message, /older than the extension expects.*--brief-file/);
  });

  it("runs exactly one engine command and reads its outcome; refusals are translated", async () => {
    const calls: string[][] = [];
    const ok = await createStage(
      async (args) => {
        calls.push(args);
        return { exitCode: 0, output: "created stage 'stage-3c-cloud' at /r/.sparring/stages/stage-3c-cloud\n" };
      },
      { stageId: "stage-3c-cloud", repoRoot: "/r" },
    );
    assert.deepEqual(ok, { ok: true, stageId: "stage-3c-cloud" });
    assert.deepEqual(calls, [["new-stage", "stage-3c-cloud"]]);
    const exists = await createStage(async () => ({ exitCode: 1, output: "could not create stage: stage 'stage-3c-cloud' already exists at /r/.sparring/stages/stage-3c-cloud\n" }), { stageId: "stage-3c-cloud", repoRoot: "/r" });
    assert.deepEqual(exists.ok ? undefined : [exists.message, exists.alreadyExists], ["A stage with this id already exists.", true]);
    assert.equal(explainNewStageFailure({ exitCode: 127, output: "" }, "darwin").commandNotFound, true);
    assert.equal(explainNewStageFailure({ exitCode: undefined, output: "" }).message, "The new-stage command did not finish (it was interrupted or its terminal closed). No stage was created.");
    assert.equal(explainNewStageFailure({ exitCode: 1, output: "could not create stage: invalid stage id 'a/b': must match …\n" }).message, "The engine refused the proposed stage id.");
    assert.equal(explainNewStageFailure({ exitCode: 1, output: "could not create stage: disk full\n" }).message, "The stage could not be created: disk full");
  });

  it("the new stage's run id follows the repository identity, so nested and multi-root projects stay apart", async () => {
    const parent = await Workspace.create({ sparring: false, name: "sporely" });
    const nested = await Workspace.createNested(parent.root, "sporely-py-reported-statistics");
    const other = await Workspace.create({ name: "other" });
    const inNested = runIdFor(nested.location, "stage", "stage-3c-cloud");
    assert.ok(inNested.startsWith(`${nested.root}|`));
    assert.notEqual(inNested, runIdFor({ ...nested.location, projectDir: parent.root }, "stage", "stage-3c-cloud"));
    assert.notEqual(inNested, runIdFor(other.location, "stage", "stage-3c-cloud"));
  });

  it("no production source writes stage state: the only file writer is the temporary brief under os.tmpdir(), never .sparring", async () => {
    const src = path.resolve(__dirname, "..", "..", "src");
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test" && entry.name !== "integration") {
            await walk(full);
          }
        } else if (entry.name.endsWith(".ts")) {
          const text = await fs.readFile(full, "utf8");
          if (/\b(writeFile|writeFileSync|mkdir|mkdirSync|mkdtemp|appendFile|appendFileSync|open\([^)]*"[wa]"\))\b/.test(text)) {
            offenders.push(path.relative(src, full));
          }
        }
      }
    }
    await walk(src);
    assert.deepEqual(offenders, ["core/tempFile.ts", "vscode/commands.ts"], "state.json, brief.md and the stage directory come from `sparring new-stage`; the extension writes only the temporary brief it hands the engine and, on Submit evidence, a stage's notes.md ## Human evidence prose");
    const commandWrites = (await fs.readFile(path.join(src, "vscode", "commands.ts"), "utf8")).match(/\bfs\.writeFile\([^\n]*/g) ?? [];
    assert.deepEqual(
      commandWrites.map((call) => /\(([^,]+),/.exec(call)?.[1]),
      ["notesPath", "handoffPath"],
      "the only workspace files the extension writes are the stage's notes.md (the engine's own '## Human evidence' append) and the same entry in handoff.md, which is what the reviewer's prompt reads",
    );
    const temp = await fs.readFile(path.join(src, "core", "tempFile.ts"), "utf8");
    assert.match(temp, /mkdtemp\(path\.join\(os\.tmpdir\(\)/, "the temporary file lives under the OS temporary directory");
    assert.ok(!/\.sparring["'/]|sparringDir|repoRoot|workspace/.test(temp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "and its location is never derived from the workspace or .sparring");
    const commands = await fs.readFile(path.join(src, "vscode", "commands.ts"), "utf8");
    assert.match(commands, /configured: configuredExecutable\(\), args, cwd: location\.repoRoot, name: `New stage/, "new-stage runs through the shared agentSparring.executable setting like every other command");
    assert.match(commands, /withTemporaryFile\(rendered\.brief/, "the rendered plan section is what the engine is given");
    assert.ok(!/launchStageLoop\([^)]*\)[\s\S]{0,400}return \{ ok: true, stageId: proposal\.stageId/.test(commands), "Start next stage never launches the loop: Run stage is the user's own next step");
  });
});

describe("the Overview after Start next stage", () => {
  it("shows the created stage as Ready to start with Run stage primary, placed in the plan by the carried-over match", async () => {
    const { discoverRuns, selectRun } = await import("../core/discovery");
    const { buildOverviewModel } = await import("../core/overviewModel");
    const { renderOverviewHtml } = await import("../core/overviewHtml");
    const ws = await Workspace.create();
    const planFile = path.join(ws.root, "docs", "range.md");
    await fs.mkdir(path.dirname(planFile), { recursive: true });
    await fs.writeFile(planFile, RANGE_PLAN);
    const index = buildStageIndex(parsePlanHeadings(RANGE_PLAN));
    const proposal = proposeNextStage(index.find((entry) => entry.label === "3C")!)!;
    const rendered = renderNextStageBrief(RANGE_PLAN, proposal, "range.md");
    assert.ok(rendered.ok);
    // What the engine writes for `new-stage <id> --brief-file`: state.json as Stage.create, brief.md as given.
    await ws.writeStage(proposal.stageId, { status: "working" }, { "brief.md": rendered.brief });
    const selection = selectRun((await discoverRuns([ws.location])).runs);
    const artifacts = { handoff: false, sparring: false, brief: true, plan: false, briefText: rendered.brief, associatedPlan: { path: planFile, exists: true, text: RANGE_PLAN, manualMatch: { label: proposal.label, title: proposal.title } } };
    const model = buildOverviewModel(selection, undefined, artifacts, Date.parse("2026-09-12T19:00:00.000Z"));
    assert.equal(model.runKind, "Standalone stage");
    assert.equal(model.stageId, "stage-3c-cloud-schema-and-synchronization");
    assert.equal(model.stageStatus, "Ready to start");
    assert.deepEqual(model.status, { label: "Ready to start", tone: "info" });
    assert.equal(model.stageLine, "Ready to start. Run stage begins implementation.");
    assert.deepEqual(model.stageAction, { kind: "run", label: "Run stage", primary: true });
    assert.equal(model.whatsNext, undefined, "not accepted: nothing to start next yet");
    assert.equal(model.plan?.current, "Stage 3C — Cloud schema and synchronization");
    assert.equal(model.plan?.matched, "manual");
    assert.equal(model.plan?.next?.display, "Stage 3D — Client sync");
    assert.match(renderOverviewHtml(model, "n", "c"), /<button type="button" class="primary" data-action="runStage"/);

    // Without the manual match the brief's own header still places the stage.
    const byBrief = buildOverviewModel(selection, undefined, { ...artifacts, associatedPlan: { path: planFile, exists: true, text: RANGE_PLAN } }, Date.parse("2026-09-12T19:00:00.000Z"));
    assert.equal(byBrief.plan?.current, "Stage 3C — Cloud schema and synchronization");
    assert.equal(byBrief.plan?.matched, "id", "the id slug equals the canonical title");
  });

  it("Ready to start is claimed only while nothing has run: a session id or a recorded outcome ends it", async () => {
    const { discoverRuns, selectRun } = await import("../core/discovery");
    const { buildOverviewModel } = await import("../core/overviewModel");
    const { sparringMarkdown } = await import("./fixtures");
    const artifacts = { handoff: false, sparring: true, brief: false, plan: false };
    const ws = await Workspace.create();
    await ws.writeStage("stage-x", { status: "working", implementation_session_id: "82ab" });
    const resumed = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, 0);
    assert.equal(resumed.stageStatus, "Working");
    assert.equal(resumed.stageAction?.label, "Resume stage");
    await ws.writeStage("stage-x", { status: "working" }, { "sparring.md": sparringMarkdown("SEND_BACK", "fix") });
    const sentBack = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, artifacts, 0);
    assert.notEqual(sentBack.stageStatus, "Ready to start");
  });
});
