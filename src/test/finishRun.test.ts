/**
 * Merge & clean up a run in its own workspace: the engine's dry run decides,
 * the person confirms in plain words, and exactly the chosen engine command
 * is issued. Every engine answer here is a stub; nothing runs the engine or
 * Git.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildFinishRunArgs } from "../core/cli";
import { discoverRuns, selectRun } from "../core/discovery";
import { parseFinishCheck, parseFinishResult, parseIsolatedRuns, type IsolatedRun } from "../core/engineFormats";
import { checkSentence, mergeAndCleanUp, readyToMerge, type FinishChoice, type FinishNotice, type FinishPrompt, type FinishRunEffects, type FinishTarget } from "../core/finishRun";
import { renderOverviewHtml } from "../core/overviewHtml";
import { buildOverviewModel } from "../core/overviewModel";
import { FOO_PLAN_KEY, FOO_PLAN_LABEL, FOO_STAGE_IDS, Workspace, sparringMarkdown } from "./fixtures";

const KEY = "isolated-demo-0badf00d";
const ROOT = "/repo/app";
const TARGET: FinishTarget = { repoRoot: ROOT, runKey: KEY, targetBranch: "main", branch: "sparring/demo-0badf00d", planLabel: "docs/plans/demo.md" };

function check(code: string, ok: boolean, detail = `${code} detail`): { code: string; ok: boolean; detail: string } {
  return { code, ok, detail };
}

const ALL_OK = ["unmanaged", "run_not_complete", "human_gate_pending", "runner_live", "worktree_missing", "branch_mismatch", "worktree_dirty", "candidate_mismatch", "candidate_not_pushed", "branch_in_use", "target_checkout_dirty", "target_operation_in_progress", "target_advanced", "merge_conflict"].map((code) => check(code, true));

function dry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    run_key: KEY,
    managed: true,
    eligible: { merge: true, cleanup: true },
    merge_mode: "fast_forward",
    actions: ["fast-forward main to abc"],
    checks: ALL_OK,
    deleted_ignored_paths: [".sparring/runs/x/state.json", "node_modules/"],
    kept: [],
    summary: `run ${KEY} can be finished (fast_forward)`,
    ...overrides,
  };
}

const REMOTE_KEPT = [{ action: "keep_remote_branch", code: "remote_delete_unavailable", detail: "origin/sparring/demo-0badf00d: not deleted" }];

function finished(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema_version: 1, run_key: KEY, completed_steps: ["merge", "archive_state", "remove_worktree", "delete_branch", "finished"], stopped_at: null, reason: null, remaining: [], deleted_ignored_paths: [], kept: [], ...overrides });
}

/** Records every effect; `answers` are the dry runs in order, `pick` chooses by label. */
function harness(options: { answers: Record<string, unknown>[]; exitCodes?: number[]; pick?: (prompt: FinishPrompt) => string | undefined; runOutput?: string; runExit?: number }) {
  const dryRuns: string[][] = [];
  const runs: string[][] = [];
  const prompts: FinishPrompt[] = [];
  const notices: FinishNotice[] = [];
  const effects: FinishRunEffects = {
    dryRun: async (args) => {
      const index = dryRuns.length;
      dryRuns.push(args);
      const answer = options.answers[Math.min(index, options.answers.length - 1)];
      return { ok: true, exitCode: options.exitCodes?.[index] ?? ((answer.eligible as { merge: boolean }).merge ? 0 : 3), stdout: JSON.stringify(answer) };
    },
    choose: async (prompt) => {
      prompts.push(prompt);
      const label = options.pick ? options.pick(prompt) : prompt.choices[0]?.label;
      return prompt.choices.find((choice: FinishChoice) => choice.label === label);
    },
    run: async (args) => {
      runs.push(args);
      return { ok: true, exitCode: options.runExit ?? 0, output: options.runOutput ?? finished() };
    },
    notify: (notice) => {
      notices.push(notice);
    },
  };
  return { effects, dryRuns, runs, prompts, notices };
}

describe("finish-run arguments", () => {
  it("passes the optional flags only when asked", () => {
    assert.deepEqual(buildFinishRunArgs({ repoRoot: ROOT, runKey: KEY, dryRun: true }), ["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--dry-run", "--json"]);
    assert.deepEqual(buildFinishRunArgs({ repoRoot: ROOT, runKey: KEY }), ["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--json"]);
    assert.deepEqual(buildFinishRunArgs({ repoRoot: ROOT, runKey: KEY, pushTarget: true, allowMergeCommit: true }), ["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--push-target", "--allow-merge-commit", "--json"]);
  });
});

describe("finish-run JSON", () => {
  it("reads a dry run and refuses an unknown schema", () => {
    const report = parseFinishCheck(JSON.stringify(dry({ kept: REMOTE_KEPT })));
    assert.equal(report.kind, "finish");
    if (report.kind === "finish") {
      assert.equal(report.finish.mergeMode, "fast_forward");
      assert.deepEqual(report.finish.deletedIgnoredPaths, [".sparring/runs/x/state.json", "node_modules/"]);
      assert.equal(report.finish.kept[0].action, "keep_remote_branch");
    }
    assert.equal(parseFinishCheck(JSON.stringify(dry({ schema_version: 2 }))).kind, "version-mismatch");
    assert.throws(() => parseFinishCheck(JSON.stringify(dry({ merge_mode: "rebase" }))));
    assert.throws(() => parseFinishCheck(JSON.stringify(dry({ eligible: true }))));
  });

  it("reads an execution report", () => {
    const report = parseFinishResult(finished({ stopped_at: "remove_worktree", reason: "busy", remaining: ["remove_worktree", "delete_branch"] }));
    assert.equal(report.kind, "result");
    if (report.kind === "result") {
      assert.equal(report.result.stoppedAt, "remove_worktree");
      assert.deepEqual(report.result.remaining, ["remove_worktree", "delete_branch"]);
    }
  });

  it("takes a listed run's finish object, and only withholds readiness when it is unreadable", () => {
    const base = { run_key: KEY, plan_label: "docs/plans/demo.md", managed: true, worktree_path: "/repo/app-sparring-x", worktree_exists: true, branch: "b", target_branch: "main", lifecycle: "created", run_status: "complete" };
    const read = (finish: unknown): IsolatedRun => {
      const report = parseIsolatedRuns(JSON.stringify({ schema_version: 1, runs: [{ ...base, finish }] }));
      assert.equal(report.kind, "runs");
      return report.kind === "runs" ? report.runs[0] : (undefined as never);
    };
    assert.equal(readyToMerge(read(dry()).finish), true);
    assert.equal(readyToMerge(read(dry({ eligible: { merge: true, cleanup: false } })).finish), false);
    assert.equal(read({ schema_version: 9 }).finish, undefined);
    assert.equal(read({ schema_version: 1, eligible: "yes" }).finish, undefined);
    assert.equal(read(undefined).finish, undefined);
  });
});

describe("Merge & clean up", () => {
  it("eligible: the confirmation states the engine's facts, and confirming issues exactly the expected command", async () => {
    const h = harness({ answers: [dry()] });
    const outcome = await mergeAndCleanUp(TARGET, h.effects);
    assert.deepEqual(h.dryRuns, [["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--dry-run", "--json"]]);
    const prompt = h.prompts[0];
    assert.equal(prompt.kind, "confirm");
    assert.match(prompt.message, /into main/);
    assert.match(prompt.detail, /fast-forward/);
    assert.match(prompt.detail, /node_modules\//);
    assert.match(prompt.detail, /\.sparring\/runs\/x\/state\.json/);
    assert.deepEqual(prompt.choices.map((choice) => choice.label), ["Merge & clean up"], "no push choice without a remote");
    assert.deepEqual(h.runs, [["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--json"]]);
    assert.equal(outcome.kind, "finished");
    assert.equal(h.notices.at(-1)?.kind, "finished");
  });

  it("with a remote: says the remote branch is kept and offers a separate push choice", async () => {
    const plain = harness({ answers: [dry({ kept: REMOTE_KEPT })] });
    await mergeAndCleanUp(TARGET, plain.effects);
    assert.match(plain.prompts[0].detail, /remote is kept/);
    assert.deepEqual(plain.prompts[0].choices.map((choice) => choice.label), ["Merge & clean up", "Merge, push main & clean up"]);
    assert.ok(!plain.runs[0].includes("--push-target"), "push only when chosen");

    const pushed = harness({ answers: [dry({ kept: REMOTE_KEPT })], pick: () => "Merge, push main & clean up" });
    await mergeAndCleanUp(TARGET, pushed.effects);
    assert.deepEqual(pushed.runs, [["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--push-target", "--json"]]);
  });

  it("ineligible: each failing check is a human sentence, an unknown code shows the engine's detail, and nothing is issued", async () => {
    const h = harness({
      answers: [dry({ eligible: { merge: false, cleanup: false }, merge_mode: null, actions: [], checks: [check("worktree_dirty", false), check("mystery_check", false, "the engine's own words"), check("runner_live", true)] })],
    });
    const outcome = await mergeAndCleanUp(TARGET, h.effects);
    assert.equal(outcome.kind, "ineligible");
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.prompts, []);
    const notice = h.notices[0];
    assert.equal(notice.kind, "ineligible");
    if (notice.kind === "ineligible") {
      assert.deepEqual(notice.reasons, ["The run's workspace has uncommitted changes.", "the engine's own words"]);
    }
  });

  it("merge-eligible but not cleanable is not offered as Merge & clean up", async () => {
    const h = harness({ answers: [dry({ eligible: { merge: true, cleanup: false }, checks: [...ALL_OK, check("unarchived_project_state", false)] })] });
    assert.equal((await mergeAndCleanUp(TARGET, h.effects)).kind, "ineligible");
    assert.deepEqual(h.runs, []);
  });

  it("merge commit: asked separately, checked again with the flag, and --allow-merge-commit passed only when chosen", async () => {
    const refused = dry({ eligible: { merge: false, cleanup: false }, merge_mode: "merge_commit", actions: [], checks: ALL_OK.map((item) => (item.code === "target_advanced" ? check("target_advanced", false) : item)) });
    const allowed = dry({ merge_mode: "merge_commit", actions: ["merge abc into main with a merge commit"] });

    const declined = harness({ answers: [refused, allowed], pick: () => undefined });
    assert.equal((await mergeAndCleanUp(TARGET, declined.effects)).kind, "cancelled");
    assert.equal(declined.prompts[0].kind, "merge-commit");
    assert.equal(declined.dryRuns.length, 1);
    assert.deepEqual(declined.runs, []);

    const chosen = harness({ answers: [refused, allowed] });
    await mergeAndCleanUp(TARGET, chosen.effects);
    assert.deepEqual(chosen.dryRuns[1], ["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--dry-run", "--allow-merge-commit", "--json"]);
    const confirm = chosen.prompts[1];
    assert.match(confirm.detail, /new merge commit/);
    assert.equal(confirm.choices[0].label, "Merge with a merge commit & clean up");
    assert.deepEqual(chosen.runs, [["finish-run", "--repo-root", ROOT, "--run-key", KEY, "--allow-merge-commit", "--json"]]);

    const fastForward = harness({ answers: [dry()] });
    await mergeAndCleanUp(TARGET, fastForward.effects);
    assert.ok(!fastForward.dryRuns[0].includes("--allow-merge-commit") && !fastForward.runs[0].includes("--allow-merge-commit"));
  });

  it("a stopped finish shows where it stopped, why, and what remains", async () => {
    const h = harness({ answers: [dry()], runExit: 1, runOutput: `$ sparring finish-run …\n${finished({ completed_steps: ["merge", "archive_state"], stopped_at: "remove_worktree", reason: "the worktree is locked", remaining: ["remove_worktree", "delete_branch", "finished"] })}\n` });
    const outcome = await mergeAndCleanUp(TARGET, h.effects);
    assert.equal(outcome.kind, "stopped");
    const notice = h.notices.at(-1);
    assert.equal(notice?.kind, "stopped");
    if (notice?.kind === "stopped") {
      assert.equal(notice.stoppedAt, "remove_worktree");
      assert.equal(notice.reason, "the worktree is locked");
      assert.deepEqual(notice.remaining, ["remove_worktree", "delete_branch", "finished"]);
      assert.match(notice.message, /removing the workspace/);
    }
  });

  it("an unknown dry-run schema, another run's answer or an engine failure issues nothing", async () => {
    for (const answer of [dry({ schema_version: 2 }), dry({ run_key: "other" })]) {
      const h = harness({ answers: [answer] });
      assert.equal((await mergeAndCleanUp(TARGET, h.effects)).kind, "error");
      assert.deepEqual(h.runs, []);
    }
    const failed = harness({ answers: [dry()], exitCodes: [1] });
    assert.equal((await mergeAndCleanUp(TARGET, failed.effects)).kind, "error");
    assert.deepEqual(failed.runs, []);
  });

  it("names the target branch in a target check", () => {
    assert.equal(checkSentence(check("target_checkout_dirty", false), { targetBranch: "develop" }), "The checkout of develop has uncommitted changes.");
  });
});

describe("Ready to merge on the cockpit", () => {
  async function completeRun(isolatedRun: IsolatedRun | undefined) {
    const ws = await Workspace.create();
    await ws.writePlan();
    await ws.writePlanRun(FOO_PLAN_KEY, { plan: FOO_PLAN_LABEL, status: "complete", current_stage_index: 2, current_stage: FOO_STAGE_IDS[2], expected_branch: "main" });
    await ws.writeStage(FOO_STAGE_IDS[2], { status: "accepted" }, { "sparring.md": sparringMarkdown("READY", "Done.") });
    const model = buildOverviewModel(selectRun((await discoverRuns([ws.location])).runs), undefined, { handoff: false, sparring: true, brief: false, plan: true, planText: "# Foo plan\n", git: { branch: "main" }, isolatedRun }, Date.now());
    return { model, html: renderOverviewHtml(model, "n", "c") };
  }
  const listed = (finish?: Record<string, unknown>): IsolatedRun => {
    const report = parseIsolatedRuns(JSON.stringify({ schema_version: 1, runs: [{ run_key: FOO_PLAN_KEY, plan_label: FOO_PLAN_LABEL, managed: true, worktree_path: "/w", worktree_exists: true, branch: "b", target_branch: "main", lifecycle: "created", run_status: "complete", ...(finish ? { finish } : {}) }] }));
    return report.kind === "runs" ? report.runs[0] : (undefined as never);
  };

  it("offers Merge & clean up for a complete isolated run, and says Ready to merge only from the engine's dry run", async () => {
    const unchecked = await completeRun(listed());
    assert.ok(unchecked.model.finishRun);
    assert.match(unchecked.html, /data-action="mergeCleanUp"/);
    assert.doesNotMatch(unchecked.html, /Ready to merge/, "complete alone is not ready to merge");

    const refused = await completeRun(listed(dry({ eligible: { merge: false, cleanup: false } })));
    assert.doesNotMatch(refused.html, /Ready to merge/);

    const ready = await completeRun(listed(dry()));
    assert.match(ready.html, /Ready to merge/);
  });

  it("is not offered for a run in this checkout", async () => {
    const { model, html } = await completeRun(undefined);
    assert.equal(model.finishRun, undefined);
    assert.doesNotMatch(html, /mergeCleanUp/);
  });
});

describe("no Git surgery in the extension", () => {
  it("spawns no Git write command (worktree add/remove, merge, branch -d, push)", () => {
    const root = path.resolve(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "test" && entry.name !== "integration") {
            walk(full);
          }
        } else if (entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
    };
    walk(root);
    assert.ok(files.length > 20, "the extension's sources were found");
    const forbidden = [
      /["']worktree["']\s*,\s*["'](add|remove|prune|move)["']/,
      /["']branch["']\s*,\s*["']-(d|D|-delete)["']/,
      /["']git["']\s*,\s*\[[^\]]*["'](merge|push)["']/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const runsGit = /execFile(Sync)?\(\s*["']git["']|spawn(Sync)?\(\s*["']git["']|runGit\b/.test(text);
      for (const pattern of forbidden) {
        if (pattern.test(text)) {
          offenders.push(`${path.relative(root, file)}: ${pattern}`);
        }
      }
      // A file that runs git names no merge or push verb as an argument at all.
      if (runsGit && /\[\s*(["'][^"']*["']\s*,\s*)*["'](merge|push)["']/.test(text)) {
        offenders.push(`${path.relative(root, file)}: git merge/push`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("Merge & clean up issues only engine commands", async () => {
    const h = harness({ answers: [dry({ kept: REMOTE_KEPT })], pick: (prompt) => prompt.choices.at(-1)?.label });
    await mergeAndCleanUp(TARGET, h.effects);
    for (const args of [...h.dryRuns, ...h.runs]) {
      assert.equal(args[0], "finish-run");
    }
  });
});
