/**
 * Fake `.sparring` workspaces for tests. Everything is written with the exact
 * shapes the Python engine produces (plan.py / stage.py / activity.py); no
 * provider is ever invoked.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ActivityEvent } from "../core/engineFormats";

/** Real values produced by the engine for `docs/plans/foo.md` (see plan.py: plan_key). */
export const FOO_PLAN_LABEL = "docs/plans/foo.md";
export const FOO_PLAN_KEY = "foo-1cd13d24";
export const FOO_PLAN_MARKDOWN = [
  "# Foo plan",
  "",
  "Some prose.",
  "",
  "## Stage 1 — Contract",
  "Define the contract.",
  "",
  "## Stage 2 - Schema & API",
  "Schema work.",
  "",
  "```md",
  "## Stage 9 — inside a fence, ignored",
  "```",
  "",
  "## Stage 3: Device/UI check!",
  "Manual check.",
  "",
].join("\n");
export const FOO_STAGE_IDS = [
  "foo-1cd13d24-stage-1-contract",
  "foo-1cd13d24-stage-2-schema-api",
  "foo-1cd13d24-stage-3-device-ui-check",
];

export class Workspace {
  readonly sparringDir: string;
  constructor(readonly root: string) {
    this.sparringDir = path.join(root, ".sparring");
  }

  get location() {
    return { sparringDir: this.sparringDir, repoRoot: this.root };
  }

  static async create(options: { withSpaces?: boolean; sparring?: boolean } = {}): Promise<Workspace> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-"));
    const root = options.withSpaces ? path.join(base, "my repo with spaces") : path.join(base, "repo");
    await fs.mkdir(root, { recursive: true });
    const ws = new Workspace(root);
    if (options.sparring !== false) {
      await fs.mkdir(ws.sparringDir, { recursive: true });
      await fs.writeFile(path.join(ws.sparringDir, "project.toml"), 'project = "fixture"\n\n[repo]\nroot = "."\n');
    }
    return ws;
  }

  async writePlan(label = FOO_PLAN_LABEL, markdown = FOO_PLAN_MARKDOWN): Promise<string> {
    const file = path.join(this.root, ...label.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, markdown);
    return file;
  }

  async writePlanRun(
    planKey: string,
    state: { plan: string; status: "running" | "paused" | "complete"; current_stage_index: number; current_stage: string; expected_branch?: string },
  ): Promise<string> {
    const dir = path.join(this.sparringDir, "plans");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${planKey}.json`);
    const payload = {
      current_stage: state.current_stage,
      current_stage_index: state.current_stage_index,
      expected_branch: state.expected_branch ?? "feature/x",
      plan: state.plan,
      plan_digest: "0".repeat(64),
      status: state.status,
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2) + "\n");
    return file;
  }

  stageDir(stageId: string): string {
    return path.join(this.sparringDir, "stages", stageId);
  }

  async writeStage(
    stageId: string,
    state: Partial<{ status: "working" | "frozen" | "accepted"; implementation_session_id: string | null; sparring_session_id: string | null; base_sha: string | null; candidate_sha: string | null }> = {},
    files: Partial<Record<"brief.md" | "notes.md" | "handoff.md" | "sparring.md", string>> = {},
  ): Promise<string> {
    const dir = this.stageDir(stageId);
    await fs.mkdir(dir, { recursive: true });
    const payload = {
      base_sha: null,
      candidate_sha: null,
      implementation_session_id: null,
      sparring_session_id: null,
      status: "working",
      ...state,
    };
    await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(payload, null, 2) + "\n");
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content);
    }
    return dir;
  }

  activityPath(stageId: string): string {
    return path.join(this.stageDir(stageId), "activity.jsonl");
  }

  async appendActivity(stageId: string, events: (ActivityEvent | string)[]): Promise<void> {
    const text = events.map((event) => (typeof event === "string" ? event : JSON.stringify(event) + "\n")).join("");
    await fs.appendFile(this.activityPath(stageId), text);
  }
}

let clock = Date.parse("2026-09-12T19:02:13.000Z");

/** Build an engine-shaped event with a monotonically increasing timestamp. */
export function event(actor: string, name: string, fields: Partial<ActivityEvent> = {}): ActivityEvent {
  clock += 1000;
  return { v: 1, ts: new Date(clock).toISOString().replace(/\.\d{3}Z$/, ".000Z"), actor, event: name, ...fields };
}

export function sparringMarkdown(action: string, summary: string, reason?: string): string {
  const lines = [
    "# Sparring: x",
    "",
    "## Finding / discussion",
    "",
    "Long findings that must never reach the status bar.",
    "",
    "## Routing outcome",
    "",
    `- Action: \`${action}\``,
    `- Summary: ${summary}`,
  ];
  if (reason) {
    lines.push(`- Needs-you reason: ${reason}`);
  }
  lines.push("", "## SEND BACK TO STAGE", "", "(not applicable)", "");
  return lines.join("\n");
}
