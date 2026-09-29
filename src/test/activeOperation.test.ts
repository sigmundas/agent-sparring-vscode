/**
 * The Overview shows the operation that is actually running.
 *
 * Observed in real use: while `prepare-plan` ran, the intake screen showed
 * `sparring approve-plan … --run run_3w_web` under "Engine command" — the
 * command the intake's next button would run, not anything executing. The
 * active operation now comes from the operation registry alone
 * (core/activeOperation.ts), and the next-action command is kept only under
 * Technical details while something else runs.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { activeOperationView, operationLiveness, operationTitle, relevantTo, settledOperationLine, workingFor, type OperationRecord } from "../core/activeOperation";
import { discoverRuns, type DiscoveredIntake } from "../core/discovery";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel } from "../core/overviewModel";

const FIXTURES = path.join(__dirname, "..", "..", "src", "test", "fixtures", "plan-intake");

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

/** A prepared, unapproved fixture intake: its next action is approve-plan. */
async function preparedIntake(): Promise<{ root: string; intake: DiscoveredIntake }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-active-op-")));
  const root = path.join(base, "app");
  await fs.mkdir(root, { recursive: true });
  await copyTree(path.join(FIXTURES, "approved"), root, base);
  const intakeRoot = path.join(root, ".sparring", "intake");
  const [intakeId] = (await fs.readdir(intakeRoot)).filter((name) => name !== "registry");
  await fs.rm(path.join(intakeRoot, intakeId, "runs"), { recursive: true });
  await fs.rm(path.join(intakeRoot, "registry"), { recursive: true });
  const location = { sparringDir: path.join(root, ".sparring"), projectDir: root, repoRoot: root, workspaceFolder: root, folderName: "app" };
  const discovery = await discoverRuns([location]);
  assert.equal(discovery.intakes?.length, 1, JSON.stringify(discovery.problems));
  return { root, intake: discovery.intakes![0] };
}

function record(over: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "operation-1",
    label: "Prepare taxonomy v3",
    subcommand: "prepare-plan",
    repoRoot: "/repo/sporely-py",
    cwd: "/repo/sporely-py",
    target: "/repo/sporely-py/docs/plans/active/2026-09-27-taxonomy-v3.md",
    submittedAtMs: 1_000_000,
    state: "running-shell",
    waitExpired: false,
    restored: false,
    shellReportedStart: true,
    terminalName: "Agent Sparring — sporely-py",
    ...over,
  };
}

describe("the active operation on the Overview", () => {
  it("a running prepare-plan is shown as active, not the historical intake's approve-plan", async () => {
    const { root, intake } = await preparedIntake();
    const approve = `sparring approve-plan ${intake.dir} --run run_3w_web`;
    const active = activeOperationView([record({ repoRoot: root, cwd: root, target: path.join(root, "docs", "plan.md") })]);
    assert.ok(active);
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined, {
      handoff: false,
      sparring: false,
      brief: false,
      plan: false,
      intakeCommand: approve,
      activeOperation: active,
    });
    assert.equal(model.activeOperation?.title, "Preparing updated intake");
    assert.deepEqual(model.activeOperation?.command, ["prepare-plan", "docs/plan.md"]);
    assert.equal(model.intake?.command, undefined, "the next action's command is not the engine command while prepare-plan runs");
    assert.equal(model.intake?.nextActionCommand, approve, "it stays inspectable");

    const html = renderOverviewHtml(model, "nonce", "csp");
    assert.doesNotMatch(html, /<summary>Engine command<\/summary>/);
    assert.match(html, /Preparing updated intake/);
    const start = html.indexOf('<section class="active-operation"');
    const banner = html.slice(start, html.indexOf("</section>", start));
    assert.match(banner, /prepare-plan/);
    assert.doesNotMatch(banner, /approve-plan/, "approve-plan never appears as the current operation");
    const technical = html.slice(html.indexOf('<details class="intake-technical">'));
    assert.match(technical, /not what is running now/);
    assert.ok(technical.includes("approve-plan"), "only under Technical details");
  });

  it("idle: no banner, and the intake's command is the engine command as before", async () => {
    const { intake } = await preparedIntake();
    const model = buildOverviewModel({ ambiguous: [], intake }, undefined, { handoff: false, sparring: false, brief: false, plan: false, intakeCommand: "sparring approve-plan x" });
    assert.equal(model.activeOperation, undefined);
    const html = renderOverviewHtml(model, "nonce", "csp");
    assert.doesNotMatch(html, /class="active-operation"/);
    assert.match(html, /<summary>Engine command<\/summary>/);
  });

  it("the elapsed time is rendered from the operation's recorded start", () => {
    const active = activeOperationView([record({ submittedAtMs: 10_000 })])!;
    assert.equal(active.startedAtMs, 10_000);
    assert.equal(workingFor(active, 10_000 + 133_000), "working for 2m 13s");
    assert.equal(workingFor(active, 10_000 + 45_000), "working for 45s");
    assert.deepEqual(active.meta, [], "provider and model are omitted when nothing reported them");
    assert.deepEqual(activeOperationView([record({ provider: "Codex", model: "gpt-6-astra" })])!.meta, ["Codex", "gpt-6-astra"]);
  });

  it("titles follow the operation kind", () => {
    assert.equal(operationTitle({ subcommand: "prepare-plan", label: "Prepare x" }), "Preparing updated intake");
    assert.equal(operationTitle({ subcommand: "approve-plan", label: "Approve Stage 3R" }), "Approving Stage 3R");
    assert.equal(operationTitle({ subcommand: "run-plan", label: "Run Stage 3R" }), "Running Stage 3R");
  });

  it("liveness states are explicit, and nothing is claimed about the model", () => {
    assert.equal(operationLiveness(record({ state: "reserved" })), "starting");
    assert.equal(operationLiveness(record({ state: "armed" })), "starting");
    assert.equal(operationLiveness(record({ state: "submitted-shell" })), "starting");
    assert.equal(operationLiveness(record({ state: "submitted-shell", waitExpired: true })), "liveness_unknown");
    assert.equal(operationLiveness(record()), "running");
    const running = activeOperationView([record()])!;
    assert.ok(running.activity.includes("Engine process running"));
    assert.ok(!running.activity.some((line) => /generat|model/i.test(line)), "the host does not know what the provider is doing");
  });

  it("after a reload an operation whose process cannot be proven alive has no working-for counter", () => {
    const restored = activeOperationView([record({ restored: true, submittedAtMs: 0 })])!;
    assert.equal(restored.liveness, "liveness_unknown");
    assert.equal(restored.startedAtMs, undefined);
    assert.equal(workingFor(restored, 18 * 60_000), undefined);
    assert.equal(restored.note, "Previous operation status unknown after reload");
    const html = renderOverviewHtml({ kind: "empty", title: "app", activeOperation: restored }, "n", "c");
    assert.match(html, /Previous operation status unknown after reload/);
    assert.doesNotMatch(html, /data-started-ms="/, "no elapsed counter is rendered");
  });

  it("a completed operation is no longer active; its outcome is a quiet last-operation line", () => {
    assert.equal(activeOperationView([]), undefined);
    const ok = settledOperationLine({ label: "p", subcommand: "prepare-plan", repoRoot: "/r", cwd: "/r", submittedAtMs: 0, endedAtMs: 266_000, exitCode: 0 })!;
    assert.equal(ok.liveness, "succeeded");
    assert.match(ok.text, /^prepare-plan succeeded at \d\d:\d\d:\d\d, after 4m 26s$/);
    assert.equal(settledOperationLine({ label: "p", subcommand: "approve-plan", repoRoot: "/r", cwd: "/r", submittedAtMs: 0, endedAtMs: 1, exitCode: 1 })!.liveness, "failed");
    const html = renderOverviewHtml({ kind: "empty", title: "app", lastOperation: ok }, "n", "c");
    assert.doesNotMatch(html, /class="active-operation"/);
    assert.match(html, /Last operation: prepare-plan succeeded/);
  });

  it("an approve-plan running from a slice's own repository is relevant to the intake on screen", () => {
    const approve = record({ subcommand: "approve-plan", repoRoot: "/repo/sporely-web", cwd: "/repo/sporely-web", target: "/repo/sporely-py/.sparring/intake/i1#run_1b_web" });
    assert.equal(relevantTo(approve, { repoRoot: "/repo/sporely-py", intakeDir: "/repo/sporely-py/.sparring/intake/i1" }), true);
    assert.equal(relevantTo(approve, { repoRoot: "/repo/sporely-py" }), false);
    assert.equal(relevantTo(record(), { repoRoot: "/repo/other" }), false);
  });
});
