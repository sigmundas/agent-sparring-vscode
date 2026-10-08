/**
 * Launches a real VS Code on one git repository whose agent run lives in a
 * sibling worktree that is NOT part of the workspace, and runs
 * ./worktreeRunsSuite.ts inside it: the run must be found through
 * `git worktree list`, shown in the Runs view, never selected on its own,
 * and — opened through a symlink to the repository, as git never reports it
 * — not have the workspace's own directory rediscovered as a second,
 * external project. It runs the standard manifest, with no proposed API
 * enabled.
 *
 * A fake `sparring` answers for the engine: `runs --json` names the sibling
 * as the run's own workspace, `finish-run --dry-run --json` says it can be
 * fast-forwarded and cleaned up, and `finish-run` and `run-plan` only record
 * their argv (one line per call in `fake-calls.log`). Nothing is merged,
 * removed or started: the suite asserts what the extension asked for.
 */

import { runTests } from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PLAN = "# Tidy the cockpit\n\n## Stage 1 — Header\nbody\n\n## Stage 2 — Cards\nbody\n";

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("VSCODE_")) {
      delete process.env[name];
    }
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-worktrees-")));
  const app = path.join(base, "app");
  const sibling = path.join(base, "app-agent-run");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", app]);
  await fs.writeFile(path.join(app, "README.md"), "app\n");
  git(app, "add", "README.md");
  git(app, "commit", "-q", "-m", "init");
  await fs.mkdir(path.join(app, ".sparring"), { recursive: true });
  git(app, "worktree", "add", "-q", "-b", "sparring/tidy", sibling);
  await fs.mkdir(path.join(sibling, "docs", "plans"), { recursive: true });
  await fs.writeFile(path.join(sibling, "docs", "plans", "tidy.md"), PLAN);
  await fs.mkdir(path.join(sibling, ".sparring", "plans"), { recursive: true });
  await fs.writeFile(
    path.join(sibling, ".sparring", "plans", "tidy-1.json"),
    JSON.stringify({ plan: "docs/plans/tidy.md", run: "tidy-1", status: "running", current_stage_index: 1, current_stage: "tidy-1-stage-2-cards", expected_branch: "sparring/tidy", plan_digest: "0".repeat(64) }, null, 2),
  );
  const stage = path.join(sibling, ".sparring", "stages", "tidy-1-stage-2-cards");
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, "state.json"), JSON.stringify({ status: "working", run: "tidy-1", next_turn: "sparring", base_sha: null, candidate_sha: null, implementation_session_id: null, sparring_session_id: null }, null, 2));
  const fake = path.join(base, "bin", "sparring");
  await fs.mkdir(path.dirname(fake), { recursive: true });
  await fs.writeFile(fake, fakeEngine(base, sibling), { mode: 0o755 });
  // The same engine with start-plan, under its own path so its capability
  // probe starts cold: Prepare intake runs against this one.
  const withStartPlan = path.join(base, "bin", "sparring-start-plan");
  await fs.writeFile(withStartPlan, `#!/bin/sh\nSTART_PLAN=1 exec '${fake}' "$@"\n`, { mode: 0o755 });
  await fs.mkdir(path.join(app, ".vscode"), { recursive: true });
  // manual: Run Plan launches run-plan itself instead of building a manifest first.
  await fs.writeFile(path.join(app, ".vscode", "settings.json"), JSON.stringify({ "agentSparring.executable": fake, "agentSparring.planContinuation": "manual" }, null, 2));
  await fs.writeFile(path.join(app, "docs-plan.md"), PLAN);
  // Planning input: prose with no stage sections, for Make Plan….
  await fs.writeFile(path.join(app, "ideas.md"), "# Cloud sync extraction and orchestration\n\nSome thoughts, no stages yet.\n");
  await fs.writeFile(path.join(app, "more-ideas.md"), "# More ideas\n\nStill no stages.\n");
  // Lettered stages: the engine reads them only through the extension's manifest.
  await fs.writeFile(path.join(app, "lettered.md"), "# Lettered\n\n## Stage 1A — Foundation\nbody\n\n## Stage 1B — Polish\nbody\n");
  // The window opens the repository through this alias; git lists it by its real path.
  const alias = path.join(base, "app-alias");
  await fs.symlink(app, alias, "dir");
  process.env.AGENT_SPARRING_TEST_SIBLING = sibling;
  const userData = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "as-ud-"));
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, "..", ".."),
      extensionTestsPath: path.resolve(__dirname, "worktreeRunsSuite"),
      extensionTestsEnv: { AGENT_SPARRING_TEST_SIBLING: sibling, AGENT_SPARRING_TEST_CALLS: path.join(base, "fake-calls.log"), AGENT_SPARRING_TEST_START_PLAN: withStartPlan, AGENT_SPARRING_TEST_SLOW_HELP: path.join(base, "slow-help") },
      // A user-data directory of its own, short enough for VS Code's IPC socket
      // path (macOS caps it at 103 characters) wherever this repository is.
      launchArgs: [alias, "--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${userData}`],
    });
  } catch (error) {
    console.error("worktree runs integration test failed", error);
    process.exit(1);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  }
}

/**
 * The fake engine. Every call appends `<argv>` to fake-calls.log, so the
 * suite reads exactly what was invoked, in order. Probes it does not answer
 * (`--help`, `show-config`, …) fail quietly, as an older engine would.
 */
function fakeEngine(base: string, sibling: string): string {
  const run = { managed: true, run_key: "tidy-1", plan_label: "docs/plans/tidy.md", worktree_path: sibling, worktree_exists: true, branch: "sparring/tidy", target_branch: "main", lifecycle: "created", run_status: "running" };
  const check = {
    schema_version: 1,
    run_key: "tidy-1",
    eligible: { merge: true, cleanup: true },
    merge_mode: "fast_forward",
    actions: ["fast-forward main to c0ffee0", "archive .sparring state", "remove worktree", "delete branch sparring/tidy"],
    checks: [{ code: "run_not_complete", ok: true, detail: "all stages accepted" }],
    deleted_ignored_paths: ["node_modules/"],
    kept: [],
    summary: "eligible",
  };
  const result = { schema_version: 1, run_key: "tidy-1", completed_steps: ["checks", "merge", "archive_state", "remove_worktree", "delete_branch"], stopped_at: null, reason: null, remaining: [], deleted_ignored_paths: ["node_modules/"], kept: [] };
  const startPlanStatus = { schema_version: 1, status: "needs_decision", route: "intake", plan: { path: "ideas.md", label: "ideas.md" }, expected_branch: "feature/intake", execution: {}, intake: null, slice: null, later_slices: [], decisions: [], findings: [], confirm_token: null, error: null };
  const q = (value: unknown) => `'${JSON.stringify(value)}'`;
  return [
    "#!/bin/sh",
    `echo "$*" >> '${path.join(base, "fake-calls.log")}'`,
    'case "$1" in',
    `  runs) printf '%s\\n' ${q({ schema_version: 1, runs: [run] })}; exit 0 ;;`,
    '  finish-run)',
    '    case " $* " in',
    `      *" --dry-run "*) printf '%s\\n' ${q(check)} ;;`,
    `      *) printf '%s\\n' ${q(result)} ;;`,
    "    esac",
    "    exit 0 ;;",
    "  run-plan) echo 'fake sparring: run-plan recorded'; exit 0 ;;",
    // The engine's reading of a plan: runnable only with stage sections; a
    // lettered plan only as a manifest.
    '  check-plan)',
    '    case " $* " in',
    `      *" --manifest "*) printf '%s\\n' ${q({ valid: true, kind: "manifest", label: "plan", stages: [], error: null })}; exit 0 ;;`,
    "    esac",
    '    if grep -q "^## Stage 1A" "$2"; then',
    `      printf '%s\\n' ${q({ valid: false, error: "Stage 1A: lettered stage numbers are not read from Markdown" })}; exit 1`,
    "    fi",
    '    if grep -q "^## Stage" "$2"; then',
    `      printf '%s\\n' ${q({ valid: true, kind: "markdown", label: "plan", stages: [], error: null })}; exit 0`,
    "    fi",
    `    printf '%s\\n' ${q({ valid: false, error: "no ## Stage <n> — <title> sections" })}; exit 1 ;;`,
    // start-plan exists only for the START_PLAN copy; its help can be slowed down.
    '  start-plan)',
    '    if [ -n "$START_PLAN" ]; then',
    '      case " $* " in',
    `        *" --help "*) if [ -f '${path.join(base, "slow-help")}' ]; then sleep 3; fi; echo 'usage: sparring start-plan PLAN --expected-branch BRANCH [--confirm TOKEN] [--json]'; exit 0 ;;`,
    "      esac",
    `      printf '%s\\n' ${q(startPlanStatus)}; exit 0`,
    "    fi ;;",
    "esac",
    "exit 2",
    "",
  ].join("\n");
}

void main();
