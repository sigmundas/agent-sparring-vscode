/**
 * Fake `.sparring` workspaces for tests. Everything is written with the exact
 * shapes the Python engine produces (plan.py / stage.py / activity.py); no
 * provider is ever invoked.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isInsidePath, samePath, type PlanRunSnapshot, type RunSnapshot, type SparringLocation, type StageOwnership } from "../core/discovery";
import type { GitWorkTreeProbe } from "../core/launchRepositories";
import type { ActivityEvent } from "../core/engineFormats";
import { BINDING_VERSION, bindManifest, bindingPathFor, manifestExpectationFor, manifestPathFor, parseExecutionManifest, renderBindingRecord, type ManifestStageIdentity } from "../core/manifest";
import { resolveMemberships, stageOwnership, type PlanMembership } from "../core/planMembership";

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

const PROJECT_TOML = 'project = "fixture"\n\n[repo]\nroot = "."\n';

export interface WorkspaceOptions {
  withSpaces?: boolean;
  /** false: create the folder without any `.sparring`. */
  sparring?: boolean;
  name?: string;
  /**
   * Where project.toml is written: inside `.sparring` (the engine's place,
   * default), at the repository root only (`root`), or nowhere (`none`).
   */
  config?: "sparring" | "root" | "none";
}

export class Workspace {
  readonly sparringDir: string;
  constructor(readonly root: string) {
    this.sparringDir = path.join(root, ".sparring");
  }

  get location(): SparringLocation {
    return { sparringDir: this.sparringDir, projectDir: this.root, repoRoot: this.root, workspaceFolder: this.root, folderName: path.basename(this.root) };
  }

  static async create(options: WorkspaceOptions = {}): Promise<Workspace> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-vscode-"));
    return Workspace.createAt(path.join(base, options.name ?? (options.withSpaces ? "my repo with spaces" : "repo")), options);
  }

  /**
   * A project checked out inside another directory (a git worktree under a
   * parent folder, a monorepo package): what the Explorer shows as a child
   * node of a workspace folder, not a workspace folder itself.
   */
  static async createNested(parent: string, relativePath: string, options: Omit<WorkspaceOptions, "name" | "withSpaces"> = {}): Promise<Workspace> {
    return Workspace.createAt(path.join(parent, ...relativePath.split("/")), options);
  }

  private static async createAt(root: string, options: WorkspaceOptions): Promise<Workspace> {
    await fs.mkdir(root, { recursive: true });
    const ws = new Workspace(root);
    if (options.sparring !== false) {
      await fs.mkdir(ws.sparringDir, { recursive: true });
      if (options.config !== "none" && options.config !== "root") {
        await fs.writeFile(path.join(ws.sparringDir, "project.toml"), PROJECT_TOML);
      }
    }
    if (options.config === "root") {
      await fs.writeFile(path.join(root, "project.toml"), PROJECT_TOML);
    }
    return ws;
  }

  /** Create the .sparring directory later, as a run started from a terminal would. */
  async createSparring(): Promise<void> {
    await fs.mkdir(this.sparringDir, { recursive: true });
  }

  async writePlan(label = FOO_PLAN_LABEL, markdown = FOO_PLAN_MARKDOWN): Promise<string> {
    const file = path.join(this.root, ...label.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, markdown);
    return file;
  }

  async writePlanRun(
    planKey: string,
    state: {
      plan: string;
      status: "running" | "paused" | "complete";
      current_stage_index: number;
      current_stage: string;
      expected_branch?: string;
      source?: "markdown" | "manifest";
      /** The engine's typed pause (plan.py: `PlanRunState.awaiting`), verbatim. */
      awaiting?: Record<string, unknown> | null;
      /** The recorded push permission (push_gate.py: `PushAuthorization`), verbatim. */
      push_authorization?: Record<string, unknown> | null;
    },
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
      ...(state.source ? { source: state.source } : {}),
      // Written only when the caller says so, including as an explicit null:
      // a run recorded before push authorization existed has neither key at
      // all, and that case has to be reproducible here.
      ...(state.awaiting !== undefined ? { awaiting: state.awaiting } : {}),
      ...(state.push_authorization !== undefined ? { push_authorization: state.push_authorization } : {}),
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

/**
 * A launchability probe for tests that are not about launchability: every
 * directory is inside a git repository.
 *
 * Temporary fixture directories are not git repositories, so without this
 * every candidate would be refused as a launch target and a test about, say,
 * which nested root owns a file would be testing the wrong thing. A test that
 * *is* about launchability passes {@link gitWorkTreesIn} or the real
 * on-disk probe instead.
 */
export const everywhereIsAGitRepo: GitWorkTreeProbe = async () => true;

/** A probe that says yes only at or below the given roots — a stand-in for the real `.git` layout. */
export function gitWorkTreesIn(...roots: string[]): GitWorkTreeProbe {
  return async (dir) => roots.some((root) => samePath(root, dir) || isInsidePath(dir, root));
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

/**
 * The Overview as a non-expert reads it: tooltips (`title="…"`), the
 * metadata footer and the collapsed "Show technical details" block are the
 * advanced surfaces where the engine's own words are allowed; everything
 * else must use the human vocabulary.
 */
export function normalUi(html: string): string {
  return html
    .replace(/title="[^"]*"/g, "")
    .replace(/<dl class="facts">[\s\S]*?<\/dl>/g, "")
    .replace(/<details class="tech">[\s\S]*?<\/details>/g, "");
}

/**
 * The execution manifests the extension keeps in global storage, as tests
 * need them.
 *
 * Files are written to, and read from, the same paths the extension uses
 * (`manifestPathFor` / `bindingPathFor`) and are accepted only through the
 * same binding rules (`bindManifest`). A test therefore cannot accept a
 * manifest the extension itself would refuse, which is the whole point: these
 * files decide which historical stage belongs to which plan run.
 *
 * Writing one models the whole sequence the extension and the engine perform
 * together: the manifest is written, the sidecar says which worktree it was
 * written for, and the engine then records that manifest's executable digest
 * as the run's `plan_digest`. `bind: false` performs only the first two — a
 * file overwritten behind a recorded run's back, which is exactly the shape of
 * attack the binding exists to refuse.
 */
export interface ManifestWriteOptions {
  /** Fields to replace in the manifest payload. */
  overrides?: Record<string, unknown>;
  /** false: write the files without the engine recording this manifest's digest for the run. */
  bind?: boolean;
  /** Write at another run's paths, forcing the file-name collision the project scope is meant to avoid. */
  at?: PlanRunSnapshot;
  /** Claim another project directory in the binding record. */
  projectDir?: string;
}

export class ManifestStore {
  private constructor(readonly dir: string) {}

  static async create(): Promise<ManifestStore> {
    return new ManifestStore(await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-manifests-")));
  }

  /** The manifest of `run`, written where the extension would write it, with its binding record. */
  async write(run: PlanRunSnapshot, stages: readonly ManifestStageIdentity[], options: ManifestWriteOptions = {}): Promise<string> {
    const at = options.at ?? run;
    const file = manifestPathFor(this.dir, at);
    const text =
      JSON.stringify(
        {
          version: 1,
          plan_label: run.state.plan,
          source_digest: "sha256:" + "0".repeat(64),
          stages: stages.map((stage) => ({ stage_id: stage.stageId, label: stage.label, title: stage.title, brief: `# ${stage.title}\n` })),
          ...options.overrides,
        },
        null,
        2,
      ) + "\n";
    await fs.writeFile(file, text);

    const parsed = parseExecutionManifest(text);
    await fs.writeFile(
      bindingPathFor(this.dir, at),
      renderBindingRecord({
        version: BINDING_VERSION,
        manifestFile: path.basename(file),
        manifestDigest: parsed?.digest ?? "unreadable",
        planKey: run.planKey,
        planLabel: parsed?.identity.planLabel ?? run.state.plan,
        projectDir: path.resolve(options.projectDir ?? run.location.projectDir),
      }),
    );
    if (options.bind !== false && parsed) {
      await recordPlanDigest(run, parsed.digest);
    }
    return file;
  }

  /** A manifest at an arbitrary path — for the legacy, unscoped name, and for files that must be refused. */
  async writeAt(file: string, payload: unknown): Promise<string> {
    await fs.writeFile(file, JSON.stringify(payload, null, 2) + "\n");
    return file;
  }

  fileFor(run: PlanRunSnapshot): string {
    return manifestPathFor(this.dir, run);
  }

  bindingFor(run: PlanRunSnapshot): string {
    return bindingPathFor(this.dir, run);
  }

  /** The reader the controller passes to `resolveMemberships`, with the same validation. */
  readonly stagesOf = async (run: PlanRunSnapshot): Promise<ManifestStageIdentity[] | undefined> => {
    if (run.state.source !== "manifest") {
      return undefined;
    }
    const bound = bindManifest(await readOptional(manifestPathFor(this.dir, run)), await readOptional(bindingPathFor(this.dir, run)), manifestExpectationFor(run));
    return bound.ok ? bound.identity.stages : undefined;
  };
}

/**
 * What the engine does after a manifest is handed to it: record that
 * manifest's executable digest as the run's identity, both on disk and in the
 * snapshot already in memory.
 */
export async function recordPlanDigest(run: PlanRunSnapshot, digest: string): Promise<void> {
  run.state.planDigest = digest;
  const text = await readOptional(run.statePath);
  if (text !== undefined) {
    await fs.writeFile(run.statePath, JSON.stringify({ ...JSON.parse(text), plan_digest: digest }, null, 2) + "\n");
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Recorded membership for a discovery, resolved exactly as the extension resolves it. */
export async function membershipsOf(runs: readonly RunSnapshot[], store: ManifestStore): Promise<Map<string, PlanMembership>> {
  return resolveMemberships(runs, store.stagesOf);
}

/** …and the ownership edges `selectRun` takes. */
export async function ownershipOf(runs: readonly RunSnapshot[], store: ManifestStore): Promise<StageOwnership> {
  return stageOwnership(await membershipsOf(runs, store));
}
