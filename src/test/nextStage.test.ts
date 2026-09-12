import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildNewStageArgs } from "../core/cli";
import { runIdFor } from "../core/discovery";
import { STAGE_ID_RE, createStage, explainNewStageFailure, proposeNextStage } from "../core/nextStage";
import { buildStageIndex, parsePlanHeadings } from "../core/planAssociation";
import { Workspace } from "./fixtures";

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
  it("mirrors cli.py: `[--sparring-dir DIR] new-stage STAGE`, no --repo-root, unquoted", () => {
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r", sparringDir: "/r/.sparring" }), ["new-stage", "stage-3c-cloud"]);
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r" }), ["new-stage", "stage-3c-cloud"]);
    assert.deepEqual(buildNewStageArgs({ stageId: "stage-3c-cloud", repoRoot: "/r", sparringDir: "/r/pkg/.sparring" }), ["--sparring-dir", "/r/pkg/.sparring", "new-stage", "stage-3c-cloud"]);
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

  it("no production source writes stage state: creation is the engine's, through the configured executable", async () => {
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
          if (/\b(writeFile|writeFileSync|mkdir|mkdirSync|appendFile|appendFileSync|open\([^)]*"[wa]"\))\b/.test(text)) {
            offenders.push(path.relative(src, full));
          }
        }
      }
    }
    await walk(src);
    assert.deepEqual(offenders, [], "the extension never writes under .sparring (or anywhere): state.json, brief.md and the stage directory come from `sparring new-stage`");
    const commands = await fs.readFile(path.join(src, "vscode", "commands.ts"), "utf8");
    assert.match(commands, /configured: configuredExecutable\(\), args, cwd: location\.repoRoot, name: `New stage/, "new-stage runs through the shared agentSparring.executable setting like every other command");
  });
});
