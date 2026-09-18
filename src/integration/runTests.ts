/**
 * Launches a real VS Code (via @vscode/test-electron) on a multi-root
 * workspace built on the fly with the exact shape reported from the field:
 *
 *   window.code-workspace
 *   ├── sporely/                              (legacy .sparring: no stages, plus a nested project)
 *   │   └── nested-repo/.sparring/stages/...  (NOT a workspace folder)
 *   └── sporely-py-reported-statistics/
 *       ├── project.toml
 *       └── .sparring/stages/<3 stages>/state.json   (no plans/, no .sparring/project.toml)
 *
 * The assertions live in ./suite.ts and run inside the extension host.
 */

import { runTests } from "@vscode/test-electron";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  const extensionTestsPath = path.resolve(__dirname, "suite");
  const fixture = await buildFixture();
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [fixture.workspaceFile, "--disable-extensions", "--disable-workspace-trust"],
      extensionTestsEnv: { AGENT_SPARRING_FIXTURE: fixture.root, AGENT_SPARRING_IT_ONLY: process.env.AGENT_SPARRING_IT_ONLY ?? "" },
    });
  } catch (error) {
    console.error("integration test failed", error);
    process.exit(1);
  }
}

async function buildFixture(): Promise<{ root: string; workspaceFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-it-"));
  const sporely = path.join(root, "sporely");
  const reported = path.join(root, "sporely-py-reported-statistics");

  // folder 0: a legacy .sparring without stages/plans and a nested engine project
  await fs.mkdir(path.join(sporely, ".sparring", "handoffs"), { recursive: true });
  await writeStage(path.join(sporely, "nested-repo"), "stage-nested-only", "working");

  // folder 1: the reported repository
  await fs.mkdir(reported, { recursive: true });
  await fs.writeFile(path.join(reported, "project.toml"), 'project = "sporely-py"\n\n[repo]\nroot = "."\n');
  await writeStage(reported, "stage-reported-statistics-contract", "accepted");
  const barrier = await writeStage(reported, "stage-reported-statistics-local-schema-barrier", "accepted");
  await fs.writeFile(path.join(barrier, "activity.jsonl"), '{"v":1,"ts":"2026-09-11T19:00:00.000Z","actor":"stage","event":"stage.created"}\n');
  await fs.writeFile(path.join(barrier, "brief.md"), "# Brief\n");
  await fs.writeFile(path.join(barrier, "handoff.md"), "# Handoff\n");
  await fs.writeFile(path.join(barrier, "sparring.md"), "# Sparring\n");
  await writeStage(reported, "stage-reported-statistics-typed-parser", "working");
  // Two stages whose independent review passed (READY recorded in
  // sparring.md): Accept stage runs freeze then accept against the fake.
  for (const name of ["stage-review-complete", "stage-review-complete-dirty"]) {
    const dir = await writeStage(reported, name, "working");
    await fs.writeFile(path.join(dir, "sparring.md"), "# Sparring\n\n## Routing outcome\n\n- Action: `READY`\n- Summary: Looks complete\n");
  }
  // A stage whose telemetry ends in an unmatched turn.started, as Ctrl-C or a
  // reload leaves it: the reloaded extension must not call this Running.
  const stale = await writeStage(reported, "stage-stale-turn", "working");
  await fs.writeFile(
    path.join(stale, "activity.jsonl"),
    '{"v":1,"ts":"2026-09-11T19:00:00.000Z","actor":"loop","event":"loop.started"}\n{"v":1,"ts":"2026-09-11T19:00:01.000Z","actor":"stage","event":"turn.started","provider":"claude-cli"}\n',
  );
  // readGitBranch only needs .git/HEAD; no git binary is required for the branch the launch passes.
  await fs.mkdir(path.join(reported, ".git"), { recursive: true });
  await fs.writeFile(path.join(reported, ".git", "HEAD"), "ref: refs/heads/feature/reported-statistics\n");

  // A fake `sparring`. run-loop: writes loop.started + turn.started for the
  // stage (and deliberately never turn.finished), then sleeps and exits as
  // instructed by <repo>/.sparring/fake-runner.conf; SIGINT ends it with 130.
  // new-stage: creates the stage directory with state.json and a template
  // brief.md like Stage.create (no --repo-root: it works from cwd), or with
  // --brief-file that file's content verbatim as brief.md (read first: a
  // missing file refuses before creating anything), or refuses an existing
  // directory with the engine's wording.
  // freeze-candidate / accept-candidate: rewrite state.json like the engine
  // (FROZEN with a candidate, then ACCEPTED), or refuse with the engine's own
  // stderr wording when the conf sets freeze_refusal / accept_refusal. Every
  // subcommand is appended to .sparring/fake-calls.log.
  const fake = path.join(root, "bin", "sparring");
  await fs.mkdir(path.dirname(fake), { recursive: true });
  await fs.writeFile(
    fake,
    [
      "#!/bin/sh",
      "# Every call records its own argv, unambiguously and before anything is",
      "# shifted away, next to the fixture root: the launch tests assert on the",
      "# exact executable and the exact arguments the process was given.",
      'argv_log="$(dirname "$0")/../fake-argv.log"',
      'printf \'[%s]\\n\' "$0" > "$argv_log"',
      'for a in "$@"; do printf \'<%s>\\n\' "$a" >> "$argv_log"; done',
      '# A reader can only trust the log once this last line is there.',
      'printf \'[end]\\n\' >> "$argv_log"',
      'sub="$1"',
      'stage="$2"',
      'shift 2; root=; brief_file=; brief_flag=',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    --repo-root) root="$2"; shift 2 ;;',
      '    --brief-file) brief_file="$2"; brief_flag=" --brief-file"; shift 2 ;;',
      '    *) shift ;;',
      "  esac",
      "done",
      '[ -n "$root" ] || root="$PWD"',
      'conf="$root/.sparring/fake-runner.conf"',
      "sleep_for=3; exit_with=0; freeze_refusal=; accept_refusal=; resume_exit=0; resume_output=",
      '[ -f "$conf" ] && . "$conf"',
      'dir="$root/.sparring/stages/$stage"',
      'echo "$sub $stage$brief_flag" >> "$root/.sparring/fake-calls.log"',
      'sha="c0ffee0000000000000000000000000000000000"',
      'if [ "$sub" = "new-stage" ]; then',
      '  if [ -n "$brief_file" ] && [ ! -r "$brief_file" ]; then echo "could not create stage: could not read --brief-file \'$brief_file\': No such file" >&2; exit 1; fi',
      '  if [ -d "$dir" ]; then echo "could not create stage: stage \'$stage\' already exists at $dir" >&2; exit 1; fi',
      '  mkdir -p "$dir"',
      '  printf \'{"base_sha": null, "candidate_sha": null, "implementation_session_id": null, "sparring_session_id": null, "status": "working"}\\n\' > "$dir/state.json"',
      '  if [ -n "$brief_file" ]; then cat "$brief_file" > "$dir/brief.md"; else',
      '    printf \'# Stage brief: %s\\n\\n## Goal\\n\\n(Describe the bounded goal for this stage.)\\n\' "$stage" > "$dir/brief.md"',
      "  fi",
      '  echo "created stage \'$stage\' at $dir"; exit 0',
      "fi",
      'if [ "$sub" = "resume-plan" ]; then',
      '  echo "fake sparring: resume-plan"',
      '  [ -n "$resume_output" ] && echo "$resume_output" >&2',
      '  exit "$resume_exit"',
      "fi",
      'if [ "$sub" = "freeze-candidate" ]; then',
      '  if [ -n "$freeze_refusal" ]; then echo "could not freeze candidate: $freeze_refusal" >&2; exit 1; fi',
      '  printf \'{"base_sha": null, "candidate_sha": "%s", "implementation_session_id": null, "sparring_session_id": null, "status": "frozen"}\\n\' "$sha" > "$dir/state.json"',
      '  echo "frozen candidate: $sha"; exit 0',
      "fi",
      'if [ "$sub" = "accept-candidate" ]; then',
      '  if [ -n "$accept_refusal" ]; then echo "could not accept candidate: $accept_refusal" >&2; exit 1; fi',
      '  printf \'{"base_sha": null, "candidate_sha": "%s", "implementation_session_id": null, "sparring_session_id": null, "status": "accepted"}\\n\' "$sha" > "$dir/state.json"',
      '  echo "accepted candidate: $sha"; exit 0',
      "fi",
      '# The fake engine writes its telemetry with the second it is in, plus',
      '# .999: POSIX `date` has no sub-second field, and a *truncated* timestamp',
      '# is a turn that appears to have begun up to a second before the runner',
      '# that wrote it. The extension discards such a turn on purpose — a turn',
      '# older than the runner cannot be that runner\'s, and the engine\'s',
      '# worktree lock means it is a leftover (core/liveness.ts) — so the section',
      '# that waits for `turnActive` while the runner runs passed only when the',
      '# launch happened to land in the previous whole second. Rounding up keeps',
      '# the one ordering the fixture must not misrepresent: the turn started',
      '# after the runner did. The real engine writes microseconds.',
      'now=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)',
      "printf '{\"v\":1,\"ts\":\"%s\",\"actor\":\"loop\",\"event\":\"loop.started\"}\\n' \"$now\" >> \"$dir/activity.jsonl\"",
      "printf '{\"v\":1,\"ts\":\"%s\",\"actor\":\"stage\",\"event\":\"turn.started\",\"provider\":\"claude-cli\",\"session_id\":\"fake\"}\\n' \"$now\" >> \"$dir/activity.jsonl\"",
      "trap 'exit 130' INT TERM",
      'echo "fake sparring: $*"',
      'i=0; while [ "$i" -lt "$sleep_for" ]; do sleep 1; i=$((i+1)); done',
      'exit "$exit_with"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  // A second worktree of the same repository, with the same plan document at
  // the same *repo-relative* path — which is what makes both produce the same
  // plan key, and is the whole reason declarations have to be scoped by
  // worktree. Deliberately not a workspace folder and with no `.sparring`, so
  // discovery is untouched: it exists to be the checkout a declaration made
  // next door must not reach.
  const uiCleanup = path.join(root, "sporely-py-ui-cleanup");
  await fs.mkdir(path.join(uiCleanup, "plans"), { recursive: true });
  await fs.mkdir(path.join(uiCleanup, ".git"), { recursive: true });
  await fs.writeFile(path.join(uiCleanup, ".git", "HEAD"), "ref: refs/heads/feature/ui-cleanup\n");

  // The fake's directory is put on the *integrated shell's* PATH only (never
  // on the extension host's), so the bare-`sparring` scenario exercises the
  // real situation: the shell finds it, the extension process cannot.
  const shellPath = `${path.dirname(fake)}:\${env:PATH}`;
  const workspaceFile = path.join(root, "window.code-workspace");
  await fs.writeFile(
    workspaceFile,
    JSON.stringify(
      {
        folders: [{ path: "sporely" }, { path: "sporely-py-reported-statistics" }],
        settings: {
          "agentSparring.executable": fake,
          "terminal.integrated.shellIntegration.enabled": true,
          "terminal.integrated.enablePersistentSessions": true,
          "terminal.integrated.env.osx": { PATH: shellPath },
          "terminal.integrated.env.linux": { PATH: shellPath },
        },
      },
      null,
      2,
    ),
  );
  return { root, workspaceFile };
}

async function writeStage(repo: string, stageId: string, status: string): Promise<string> {
  const dir = path.join(repo, ".sparring", "stages", stageId);
  await fs.mkdir(dir, { recursive: true });
  const state = { base_sha: null, candidate_sha: status === "accepted" ? "c".repeat(40) : null, implementation_session_id: null, sparring_session_id: null, status };
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
  return dir;
}

void main();
