/**
 * Parsers for the on-disk formats written by the Python engine
 * (`agent_sparring` at main f7740e7). Nothing here is invented: every field
 * mirrors `plan.py` (PlanRunState), `stage.py` (StageState) and
 * `activity.py` (event envelope + OPTIONAL_FIELDS).
 *
 * This module has no dependency on the vscode API.
 */

export class EngineFormatError extends Error {}

// ---------------------------------------------------------------------------
// .sparring/plans/<plan key>.json  (plan.py: PlanRunState)
// ---------------------------------------------------------------------------

export type PlanRunStatus = "running" | "paused" | "complete";

export interface PlanRunState {
  /** Plan label: repo-relative POSIX path, or an absolute path (plan.py: plan_label). */
  plan: string;
  planDigest: string;
  expectedBranch: string;
  /** 0-based index into the plan's parsed stages. */
  currentStageIndex: number;
  /** Stage id of the current stage (`<plan key>-stage-<n>-<slug>`). */
  currentStage: string;
  status: PlanRunStatus;
}

const PLAN_RUN_STATUSES: ReadonlySet<string> = new Set(["running", "paused", "complete"]);

export function parsePlanRunState(text: string): PlanRunState {
  const payload = parseJsonObject(text, "plan-run state");
  const plan = requireString(payload, "plan");
  const planDigest = requireString(payload, "plan_digest");
  const expectedBranch = requireString(payload, "expected_branch");
  const currentStage = requireString(payload, "current_stage");
  const status = requireString(payload, "status");
  if (!PLAN_RUN_STATUSES.has(status)) {
    throw new EngineFormatError(`unknown plan-run status ${JSON.stringify(status)}`);
  }
  const rawIndex = payload["current_stage_index"];
  const currentStageIndex = typeof rawIndex === "number" ? rawIndex : Number(rawIndex);
  if (!Number.isInteger(currentStageIndex) || currentStageIndex < 0) {
    throw new EngineFormatError("current_stage_index must be a non-negative integer");
  }
  return { plan, planDigest, expectedBranch, currentStageIndex, currentStage, status: status as PlanRunStatus };
}

// ---------------------------------------------------------------------------
// .sparring/stages/<id>/state.json  (stage.py: StageState)
// ---------------------------------------------------------------------------

export type StageStatus = "working" | "frozen" | "accepted";

export interface StageState {
  status: StageStatus;
  implementationSessionId: string | null;
  sparringSessionId: string | null;
  baseSha: string | null;
  candidateSha: string | null;
}

const STAGE_STATUSES: ReadonlySet<string> = new Set(["working", "frozen", "accepted"]);

export function parseStageState(text: string): StageState {
  const payload = parseJsonObject(text, "state.json");
  const status = payload["status"] === undefined ? "working" : String(payload["status"]);
  if (!STAGE_STATUSES.has(status)) {
    throw new EngineFormatError(`unknown stage status ${JSON.stringify(status)}`);
  }
  return {
    status: status as StageStatus,
    implementationSessionId: optionalString(payload, "implementation_session_id"),
    sparringSessionId: optionalString(payload, "sparring_session_id"),
    baseSha: optionalString(payload, "base_sha"),
    candidateSha: optionalString(payload, "candidate_sha"),
  };
}

// ---------------------------------------------------------------------------
// .sparring/stages/<id>/activity.jsonl  (activity.py, schema version 1)
// ---------------------------------------------------------------------------

export type ActivityActor = "stage" | "sparrer" | "loop" | "gate" | "plan";

/** The closed envelope + optional field set from activity.py. */
export interface ActivityEvent {
  v: number;
  ts: string;
  actor: ActivityActor | string;
  event: string;
  provider?: string;
  session_id?: string;
  model?: string;
  summary?: string;
  action?: string;
  cycle?: number;
  sha?: string;
  tool?: string;
  path?: string;
  kind?: string;
  exit_code?: number;
  resumed?: boolean;
  parent_id?: string;
  tool_use_id?: string;
}

const ACTIVITY_OPTIONAL_FIELDS = [
  "provider",
  "session_id",
  "model",
  "summary",
  "action",
  "cycle",
  "sha",
  "tool",
  "path",
  "kind",
  "exit_code",
  "resumed",
  "parent_id",
  "tool_use_id",
] as const;

/**
 * Parse one JSONL line. Returns undefined for blank, malformed or
 * non-conforming lines; a reader of telemetry never throws on it.
 */
export function parseActivityLine(line: string): ActivityEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const { v, ts, actor, event } = raw;
  if (typeof ts !== "string" || typeof actor !== "string" || typeof event !== "string") {
    return undefined;
  }
  const out: ActivityEvent = { v: typeof v === "number" ? v : 1, ts, actor, event };
  for (const key of ACTIVITY_OPTIONAL_FIELDS) {
    const value = raw[key];
    if (value !== undefined && value !== null) {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan Markdown stage headings (plan.py: parse_plan, _slug, _stage_id_for)
// ---------------------------------------------------------------------------

export interface PlanStageHeading {
  number: number;
  title: string;
  stageId: string;
}

const STAGE_PREFIX_RE = /^##\s+stage\b/i;
const STAGE_HEADING_RE = /^##\s+stage\s+(\d+)\s*[—–:-]\s*(\S.*?)\s*$/i;
const FENCE_RE = /^\s*(```|~~~)/;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Mirrors plan.py `_stage_id_for`: `<plan key>-stage-<n>-<slug>`, clamped to 128 chars. */
export function stageIdFor(planKey: string | undefined, number: number, title: string): string {
  let base = `stage-${number}`;
  if (planKey) {
    base = `${planKey}-${base}`;
  }
  const slug = slugify(title);
  if (!slug) {
    return base;
  }
  return `${base}-${slug}`.slice(0, 128).replace(/-+$/, "");
}

/**
 * Extract the `## Stage <n> — <title>` headings from a plan, in document
 * order, ignoring fenced code blocks, exactly like the engine. Throws
 * EngineFormatError on the same malformations the engine refuses
 * (non-conforming `## Stage` heading, numbering not 1..N). A plan with no
 * stage headings returns an empty array rather than throwing, so a caller
 * can use this both for validation and for "is this a plan document?".
 */
export function parsePlanStages(markdown: string, planKey?: string): PlanStageHeading[] {
  const stages: PlanStageHeading[] = [];
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !STAGE_PREFIX_RE.test(line)) {
      continue;
    }
    const match = STAGE_HEADING_RE.exec(line);
    if (!match) {
      throw new EngineFormatError(
        `line ${index + 1} looks like a stage heading but does not follow '## Stage <n> — <title>'`,
      );
    }
    const number = Number(match[1]);
    const title = match[2];
    const expected = stages.length + 1;
    if (number !== expected) {
      throw new EngineFormatError(
        `stage numbering must be 1..N in document order; found 'Stage ${number}' where 'Stage ${expected}' was expected`,
      );
    }
    stages.push({ number, title, stageId: stageIdFor(planKey, number, title) });
  }
  return stages;
}

// ---------------------------------------------------------------------------
// sparring.md routing outcome (sparring_exchange.py: render_sparring)
// ---------------------------------------------------------------------------

export type RoutingAction = "SEND_BACK" | "READY" | "NEEDS_YOU" | "ESCALATE";

const ROUTING_ACTIONS: ReadonlySet<string> = new Set(["SEND_BACK", "READY", "NEEDS_YOU", "ESCALATE"]);

export interface SparringOutcome {
  action: RoutingAction;
  summary: string;
  needsYouReason?: string;
}

/**
 * Read the `## Routing outcome` bullets the engine renders into
 * sparring.md. Returns undefined for a template/untouched file or anything
 * without a recognizable `- Action: \`X\`` line. The summary is the engine's
 * own one-liner (the sparrer's routing summary), never the findings body.
 */
export function parseSparringOutcome(markdown: string): SparringOutcome | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Routing outcome");
  if (start < 0) {
    return undefined;
  }
  let action: string | undefined;
  let summary = "";
  let needsYouReason: string | undefined;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^#{1,2}\s/.test(line)) {
      break;
    }
    const actionMatch = /^-\s+Action:\s*`?([A-Z_]+)`?\s*$/.exec(line);
    if (actionMatch) {
      action = actionMatch[1];
      continue;
    }
    const summaryMatch = /^-\s+Summary:\s*(.*)$/.exec(line);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
      continue;
    }
    const reasonMatch = /^-\s+Needs-you reason:\s*(.*)$/.exec(line);
    if (reasonMatch) {
      needsYouReason = reasonMatch[1].trim();
    }
  }
  if (!action || !ROUTING_ACTIONS.has(action)) {
    return undefined;
  }
  return { action: action as RoutingAction, summary, needsYouReason };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EngineFormatError(`malformed ${what}: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new EngineFormatError(`${what} must be a JSON object`);
  }
  return raw;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new EngineFormatError(`field ${JSON.stringify(key)} must be a string`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new EngineFormatError(`field ${JSON.stringify(key)} must be a string or null`);
  }
  return value;
}
