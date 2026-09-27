/**
 * Plan intake, read-only: what the engine's `prepare-plan` / `approve-plan`
 * have written under `.sparring/intake/`, and the sealed manifest an
 * `intake-manifest` plan run executes.
 *
 * The engine owns every one of these files (intake.py, intake_approval.py)
 * and every decision about them: whether a slice may be approved, whether an
 * approval still binds what would run, whether a run may start. Nothing here
 * re-checks a seal or a digest, and nothing here writes. It reads only enough
 * to say that a newer plan intake exists, what state its files record, and —
 * for a run that already exists — which approved manifest that run executes.
 *
 * Layout (intake.py module docstring):
 *
 *     .sparring/intake/<intake id>/intake.json              the engine's record (version 2)
 *     .sparring/intake/<intake id>/interpretation.json      run slices and their stages
 *     .sparring/intake/<intake id>/report.md                what a person reviews
 *     .sparring/intake/<intake id>/runs/<run>/manifest.json envelope around an ordinary manifest
 *     .sparring/intake/<intake id>/runs/<run>/approval.json the sealed approval (version 2)
 *     .sparring/intake/registry/<run key>.json              run key → intake dir, run id
 *
 * No dependency on the vscode API.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EngineFormatError, parsePlanRunState, type PlanRunStatus } from "./engineFormats";
import { parseExecutionManifest, type ManifestStageIdentity } from "./manifest";

export const INTAKE_DIRNAME = "intake";
export const INTAKE_RECORD_FILENAME = "intake.json";
export const INTAKE_INTERPRETATION_FILENAME = "interpretation.json";
export const INTAKE_REPORT_FILENAME = "report.md";
export const INTAKE_RUNS_DIRNAME = "runs";
export const INTAKE_MANIFEST_FILENAME = "manifest.json";
export const INTAKE_APPROVAL_FILENAME = "approval.json";
export const INTAKE_REGISTRY_DIRNAME = "registry";

/** intake.py `INTAKE_VERSION`. Version 1 was unsealed and the engine refuses it. */
export const INTAKE_RECORD_VERSION = 2;
/** intake_approval.py `APPROVAL_VERSION`. Version 1 authorizes nothing. */
export const INTAKE_APPROVAL_VERSION = 2;
/** intake_approval.py `ENVELOPE_VERSION`, the value of the envelope's `intake_manifest` key. */
export const INTAKE_ENVELOPE_VERSION = 1;
/** manifest.py `INTAKE_ENVELOPE_KEY`. */
export const INTAKE_ENVELOPE_KEY = "intake_manifest";

// ---------------------------------------------------------------------------
// the engine's files
// ---------------------------------------------------------------------------

/** `intake.json`, reduced to what the extension shows. */
export interface IntakeRecord {
  intakeId: string;
  /** The source plan's repo-relative label, as a plan run of it would record. */
  planLabel: string;
  /**
   * `created_at`, when it is a timestamp with an explicit offset. Undefined
   * when it is missing or unreadable, and then nothing about this intake is
   * ordered in time — see {@link IntakeSnapshot.activityMs}.
   */
  createdAtMs?: number;
  /** Absolute path of the source Markdown plan intake read. */
  sourcePath?: string;
  /** `run_keys`, in the order the engine wrote them: run slice id → run key. */
  runKeys: { runId: string; runKey: string }[];
}

/** One stage of a run slice as the interpretation names it. Display only. */
export interface IntakeStageName {
  /** `Stage 1A` — the manifest's form, so both are said the same way. */
  label: string;
  title: string;
}

/** `approval.json`, reduced to what the extension shows and matches on. */
export interface IntakeApprovalRecord {
  runId: string;
  runKey: string;
  approvedAtMs?: number;
  stageIds: string[];
  /** `source.path`: the source plan the approved slice was built from. */
  sourcePath: string;
  expectedBranch: string;
  /** `starting_snapshot.path`: the primary worktree the slice was approved in and must run from. */
  repoRoot: string;
  /**
   * `sparring_dir`: the `.sparring` the slice's run is recorded in, which is
   * the project that runs it — not necessarily the one that prepared it.
   */
  sparringDir?: string;
}

/**
 * An engine timestamp (Python `datetime.isoformat()` of an aware datetime), or
 * undefined. A timestamp without an offset would be read in this machine's
 * local time zone, which is a guess about what the engine meant, so it is
 * refused rather than parsed.
 */
export function parseEngineTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  // Python writes microseconds; ECMAScript only promises milliseconds.
  const fraction = match[2] ? match[2].slice(0, 4) : "";
  const ms = Date.parse(`${match[1]}${fraction}${match[3]}`);
  return Number.isFinite(ms) ? ms : undefined;
}

function objectOf(text: string, what: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new EngineFormatError(`${what} is not valid JSON: ${(error as Error).message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EngineFormatError(`${what} is not a JSON object`);
  }
  return payload as Record<string, unknown>;
}

function nonEmpty(payload: Record<string, unknown>, key: string, what: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new EngineFormatError(`${what} has no valid ${JSON.stringify(key)}`);
  }
  return value;
}

export function parseIntakeRecord(text: string): IntakeRecord {
  const payload = objectOf(text, "intake record");
  if (payload["version"] !== INTAKE_RECORD_VERSION) {
    throw new EngineFormatError(`unsupported intake record version ${JSON.stringify(payload["version"])}`);
  }
  const rawKeys = payload["run_keys"];
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) {
    throw new EngineFormatError("intake record has no valid \"run_keys\"");
  }
  const runKeys: IntakeRecord["runKeys"] = [];
  for (const [runId, runKey] of Object.entries(rawKeys as Record<string, unknown>)) {
    if (typeof runKey !== "string" || !runKey) {
      throw new EngineFormatError(`intake record has no valid run key for slice ${JSON.stringify(runId)}`);
    }
    runKeys.push({ runId, runKey });
  }
  const sourcePath = payload["source_path"];
  return {
    intakeId: nonEmpty(payload, "intake_id", "intake record"),
    planLabel: nonEmpty(payload, "plan_label", "intake record"),
    createdAtMs: parseEngineTimestamp(payload["created_at"]),
    sourcePath: typeof sourcePath === "string" && sourcePath ? sourcePath : undefined,
    runKeys,
  };
}

/**
 * `interpretation.json`'s run slices, as stage names per slice id. Only the
 * names are read; everything else in it is the engine's to validate, and a
 * file it would refuse simply yields no names here.
 */
export function parseIntakeSliceStages(text: string): Map<string, IntakeStageName[]> {
  const payload = objectOf(text, "interpretation");
  const runs = payload["runs"];
  const out = new Map<string, IntakeStageName[]>();
  if (!Array.isArray(runs)) {
    return out;
  }
  for (const run of runs) {
    if (!run || typeof run !== "object" || typeof run.id !== "string" || !Array.isArray(run.stages)) {
      continue;
    }
    const stages: IntakeStageName[] = [];
    for (const stage of run.stages) {
      if (stage && typeof stage.label === "string" && stage.label.trim() && typeof stage.title === "string") {
        // intake.py approve_plan writes `"label": f"Stage {stage.label}"`.
        stages.push({ label: `Stage ${stage.label.trim()}`, title: stage.title.trim() });
      }
    }
    out.set(run.id, stages);
  }
  return out;
}

/**
 * `approval.json`, when it is a sealed (version 2) approval. An unsealed or
 * non-approving record is refused, exactly as the engine refuses it, so it
 * is never shown as an approval.
 */
export function parseIntakeApproval(text: string): IntakeApprovalRecord {
  const payload = objectOf(text, "approval");
  if (payload["version"] !== INTAKE_APPROVAL_VERSION) {
    throw new EngineFormatError(`approval has version ${JSON.stringify(payload["version"])}, which authorizes nothing`);
  }
  if (payload["decision"] !== "approved") {
    throw new EngineFormatError(`approval records decision ${JSON.stringify(payload["decision"])}, not "approved"`);
  }
  const source = payload["source"];
  const sourcePath = source && typeof source === "object" ? (source as Record<string, unknown>)["path"] : undefined;
  if (typeof sourcePath !== "string" || !sourcePath) {
    throw new EngineFormatError("approval has no valid \"source\"");
  }
  const stageIds = payload["stage_ids"];
  const starting = payload["starting_snapshot"];
  const repoRoot = starting && typeof starting === "object" ? (starting as Record<string, unknown>)["path"] : undefined;
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new EngineFormatError("approval has no valid \"starting_snapshot\"");
  }
  return {
    runId: nonEmpty(payload, "run_id", "approval"),
    runKey: nonEmpty(payload, "run_key", "approval"),
    approvedAtMs: parseEngineTimestamp(payload["approved_at"]),
    stageIds: Array.isArray(stageIds) ? stageIds.filter((id): id is string => typeof id === "string") : [],
    sourcePath,
    expectedBranch: nonEmpty(payload, "expected_branch", "approval"),
    repoRoot,
    sparringDir: typeof payload["sparring_dir"] === "string" && payload["sparring_dir"] ? (payload["sparring_dir"] as string) : undefined,
  };
}

/** A parsed intake envelope: whose slice it is, and the stages its inner manifest runs. */
export interface IntakeEnvelope {
  intakeId: string;
  runId: string;
  runKey: string;
  planLabel: string;
  stages: ManifestStageIdentity[];
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([INTAKE_ENVELOPE_KEY, "intake_id", "run_id", "run_key", "manifest"]);

/**
 * `runs/<run>/manifest.json`: the envelope intake_approval.py `envelope_text`
 * writes, with its inner manifest read under the engine's own manifest rules
 * (manifest.ts), so a manifest the engine would refuse yields no stages here.
 */
export function parseIntakeEnvelope(text: string): IntakeEnvelope {
  const payload = objectOf(text, "intake manifest");
  const keys = Object.keys(payload);
  if (keys.length !== ENVELOPE_KEYS.size || !keys.every((key) => ENVELOPE_KEYS.has(key))) {
    throw new EngineFormatError(`intake manifest has keys ${JSON.stringify(keys.sort())}, not an intake envelope's`);
  }
  if (payload[INTAKE_ENVELOPE_KEY] !== INTAKE_ENVELOPE_VERSION) {
    throw new EngineFormatError(`unsupported intake manifest version ${JSON.stringify(payload[INTAKE_ENVELOPE_KEY])}`);
  }
  const parsed = parseExecutionManifest(JSON.stringify(payload["manifest"]));
  if (!parsed) {
    throw new EngineFormatError("the intake manifest's inner manifest is not one the engine would run");
  }
  return {
    intakeId: nonEmpty(payload, "intake_id", "intake manifest"),
    runId: nonEmpty(payload, "run_id", "intake manifest"),
    runKey: nonEmpty(payload, "run_key", "intake manifest"),
    planLabel: parsed.identity.planLabel,
    stages: parsed.identity.stages,
  };
}

// ---------------------------------------------------------------------------
// an intake-manifest run's approved manifest
// ---------------------------------------------------------------------------

/** Which sealed manifest an `intake-manifest` plan run executes. */
export interface IntakeRunBinding {
  /** Absolute path of `runs/<run>/manifest.json`: what `resume-plan --manifest` is given. */
  manifestPath: string;
  intakeDir: string;
  runId: string;
  /** The source Markdown plan, as the approval recorded it. Human-readable source only. */
  sourcePath: string;
  /** The approved manifest's stages, in execution order. The authority for this run's stage list. */
  stages: ManifestStageIdentity[];
}

/**
 * Find the approved manifest of the `intake-manifest` run `runKey`, or say why
 * there is none.
 *
 * `registry/<run key>.json` names the intake directory; that directory's
 * `runs/*\/approval.json` whose `run_key` is this run's names the slice, and
 * its manifest is the file beside it. The slice directory is *found*, never
 * recomputed from the run id: the engine's slug rule is the engine's.
 *
 * The envelope's own `run_key` must be this run's. That is the whole of the
 * check: the seal (bytes, digests, repository state) is the engine's, and it
 * is re-verified by the engine on every resume.
 */
export async function resolveIntakeRun(sparringDir: string, runKey: string): Promise<IntakeRunBinding> {
  const registryPath = path.join(sparringDir, INTAKE_DIRNAME, INTAKE_REGISTRY_DIRNAME, `${runKey}.json`);
  const registry = objectOf(await readText(registryPath, "intake registry entry"), `intake registry entry ${registryPath}`);
  if (registry["run_key"] !== runKey) {
    throw new EngineFormatError(`intake registry entry ${registryPath} is for run ${JSON.stringify(registry["run_key"])}, not ${runKey}`);
  }
  const intakeDir = nonEmpty(registry, "intake_dir", `intake registry entry ${registryPath}`);
  const runsDir = path.join(intakeDir, INTAKE_RUNS_DIRNAME);
  const matches: { dir: string; approval: IntakeApprovalRecord }[] = [];
  for (const entry of await listDirs(runsDir)) {
    const dir = path.join(runsDir, entry);
    let approval: IntakeApprovalRecord;
    try {
      approval = parseIntakeApproval(await fs.readFile(path.join(dir, INTAKE_APPROVAL_FILENAME), "utf8"));
    } catch {
      continue;
    }
    if (approval.runKey === runKey) {
      matches.push({ dir, approval });
    }
  }
  if (matches.length === 0) {
    throw new EngineFormatError(`no approved run slice for run ${runKey} under ${runsDir}`);
  }
  if (matches.length > 1) {
    throw new EngineFormatError(`more than one approved run slice claims run ${runKey} under ${runsDir}`);
  }
  const [{ dir, approval }] = matches;
  const manifestPath = path.join(dir, INTAKE_MANIFEST_FILENAME);
  const envelope = parseIntakeEnvelope(await readText(manifestPath, "intake manifest"));
  if (envelope.runKey !== runKey || envelope.runId !== approval.runId) {
    throw new EngineFormatError(`intake manifest ${manifestPath} is for run ${envelope.runKey} (slice ${envelope.runId}), not this run`);
  }
  return { manifestPath, intakeDir, runId: approval.runId, sourcePath: approval.sourcePath, stages: envelope.stages };
}

// ---------------------------------------------------------------------------
// pre-run intake state
// ---------------------------------------------------------------------------

/**
 * What an intake's files record, never what it would be allowed to do.
 *
 *  - `prepared` — reviewed proposal, no sealed approval for the next slice yet.
 *  - `approved` — a slice has a sealed approval and no recorded run yet.
 *    "Approved", not "runnable": the engine re-checks the seal and the
 *    repositories when `run-plan` starts, and may refuse.
 *  - `running` — a plan run of one of its slices exists and is not complete.
 *    That run is then the authority, and the intake is not shown for it.
 *  - `complete` — every slice has a plan run that is complete.
 */
export type IntakeState = "prepared" | "approved" | "running" | "complete";

export interface IntakeSliceSnapshot {
  runId: string;
  runKey: string;
  state: IntakeState;
  approval?: IntakeApprovalRecord;
  /** The sealed manifest beside {@link approval}, when there is one. */
  manifestPath?: string;
  /** From the interpretation; empty when it could not be read. */
  stages: IntakeStageName[];
}

export interface IntakeSnapshot {
  /** Absolute `.sparring/intake/<id>` directory. */
  dir: string;
  /** The `.sparring` directory it was found in. */
  sparringDir: string;
  record: IntakeRecord;
  slices: IntakeSliceSnapshot[];
  state: IntakeState;
  /** Absolute path of `report.md`, the view a person reviews and approves from. */
  reportPath: string;
  /**
   * The latest time the engine recorded for this intake: `created_at`, or a
   * later `approved_at`. Undefined whenever `created_at` itself is missing or
   * invalid — an intake whose age cannot be read is never assumed newer than
   * anything, so it stays discoverable but is never promoted automatically.
   */
  activityMs?: number;
}

/** The status of each plan run in the same `.sparring`, by run key. */
export type PlanRunStatusByKey = ReadonlyMap<string, PlanRunStatus>;

/**
 * Read every intake under `<sparringDir>/intake/`. Unreadable intakes are
 * reported as problems rather than guessed at; the registry directory is not
 * an intake.
 */
export async function discoverIntakes(sparringDir: string, runs: PlanRunStatusByKey): Promise<{ intakes: IntakeSnapshot[]; problems: { path: string; error: string }[] }> {
  const root = path.join(sparringDir, INTAKE_DIRNAME);
  const intakes: IntakeSnapshot[] = [];
  const problems: { path: string; error: string }[] = [];
  for (const entry of (await listDirs(root)).filter((name) => name !== INTAKE_REGISTRY_DIRNAME).sort()) {
    const dir = path.join(root, entry);
    const recordPath = path.join(dir, INTAKE_RECORD_FILENAME);
    let text: string;
    try {
      text = await fs.readFile(recordPath, "utf8");
    } catch {
      continue; // being written, or not an intake: prepare-plan writes intake.json last but one
    }
    try {
      intakes.push(await snapshotIntake(dir, sparringDir, parseIntakeRecord(text), runs));
    } catch (error) {
      problems.push({ path: recordPath, error: (error as Error).message });
    }
  }
  return { intakes, problems };
}

async function snapshotIntake(dir: string, sparringDir: string, record: IntakeRecord, runs: PlanRunStatusByKey): Promise<IntakeSnapshot> {
  let names = new Map<string, IntakeStageName[]>();
  try {
    names = parseIntakeSliceStages(await fs.readFile(path.join(dir, INTAKE_INTERPRETATION_FILENAME), "utf8"));
  } catch {
    // Names are a courtesy; the record alone says what exists.
  }
  const approvals = new Map<string, { approval: IntakeApprovalRecord; manifestPath: string }>();
  const runsDir = path.join(dir, INTAKE_RUNS_DIRNAME);
  for (const entry of await listDirs(runsDir)) {
    try {
      const approval = parseIntakeApproval(await fs.readFile(path.join(runsDir, entry, INTAKE_APPROVAL_FILENAME), "utf8"));
      approvals.set(approval.runKey, { approval, manifestPath: path.join(runsDir, entry, INTAKE_MANIFEST_FILENAME) });
    } catch {
      // No approval, or one the engine would refuse: not approved.
    }
  }
  const slices: IntakeSliceSnapshot[] = [];
  for (const { runId, runKey } of record.runKeys) {
    const found = approvals.get(runKey);
    const approved = found && found.approval.runId === runId ? found : undefined;
    const status = runs.get(runKey) ?? (await recordedRunStatus([sparringDir, approved?.approval.sparringDir], runKey));
    const state: IntakeState = status === "complete" ? "complete" : status !== undefined ? "running" : approved ? "approved" : "prepared";
    slices.push({ runId, runKey, state, approval: approved?.approval, manifestPath: approved?.manifestPath, stages: names.get(runId) ?? [] });
  }
  let activityMs = record.createdAtMs;
  if (activityMs !== undefined) {
    for (const slice of slices) {
      if (slice.approval?.approvedAtMs !== undefined && slice.approval.approvedAtMs > activityMs) {
        activityMs = slice.approval.approvedAtMs;
      }
    }
  }
  return { dir, sparringDir, record, slices, state: intakeState(slices), reportPath: path.join(dir, INTAKE_REPORT_FILENAME), activityMs };
}

/**
 * The status of run `runKey` when it was not among the discovered runs: its
 * state file in this `.sparring`, or in the one the approval says runs the
 * slice (a slice may be run from a project this window has not opened).
 *
 * A state file that exists but cannot be read — a newer engine's plan input
 * kind, say — is a run that exists with an unknown status, never "no run":
 * it is answered as `running`, which keeps the slice from being shown as
 * approved-and-not-yet-run.
 */
async function recordedRunStatus(sparringDirs: readonly (string | undefined)[], runKey: string): Promise<PlanRunStatus | undefined> {
  for (const dir of new Set(sparringDirs.filter((entry): entry is string => Boolean(entry)))) {
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, "plans", `${runKey}.json`), "utf8");
    } catch {
      continue;
    }
    try {
      return parsePlanRunState(text).status;
    } catch {
      return "running";
    }
  }
  return undefined;
}

/** The intake's own state from its slices; see {@link IntakeState}. */
export function intakeState(slices: readonly IntakeSliceSnapshot[]): IntakeState {
  if (slices.length > 0 && slices.every((slice) => slice.state === "complete")) {
    return "complete";
  }
  if (slices.some((slice) => slice.state === "running")) {
    return "running";
  }
  if (slices.some((slice) => slice.state === "approved")) {
    return "approved";
  }
  return "prepared";
}

/** Whether an intake is waiting on a person or a first `run-plan`: the only states shown on their own. */
export function isPreRunIntake(intake: IntakeSnapshot): boolean {
  return intake.state === "prepared" || intake.state === "approved";
}

/** The slice an intake is waiting on: the first approved-but-not-run one, else the first prepared one. */
export function nextIntakeSlice(intake: IntakeSnapshot): IntakeSliceSnapshot | undefined {
  return intake.slices.find((slice) => slice.state === "approved") ?? intake.slices.find((slice) => slice.state === "prepared");
}

/** A person's words for an intake state. */
export function intakeStateLabel(state: IntakeState): string {
  switch (state) {
    case "prepared":
      return "Prepared — awaiting review and approval";
    case "approved":
      return "Slice approved — not yet run";
    case "running":
      return "Running";
    case "complete":
      return "Complete";
  }
}

async function readText(file: string, what: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    throw new EngineFormatError(`cannot read ${what} ${file}: ${(error as Error).message}`);
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
