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
  /**
   * Which plan input this run executes. The engine refuses to resume a run
   * from a different kind of input, so a run started from a manifest must
   * be continued with `--manifest`, never with the plan's own path. Absent
   * from state written before manifests existed, and read as `markdown`.
   */
  source: PlanRunSource;
}

export type PlanRunSource = "markdown" | "manifest";

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
  const rawSource = payload["source"];
  const source: PlanRunSource = rawSource === "manifest" ? "manifest" : "markdown";
  return { plan, planDigest, expectedBranch, currentStageIndex, currentStage, status: status as PlanRunStatus, source };
}

// ---------------------------------------------------------------------------
// .sparring/stages/<id>/state.json  (stage.py: StageState)
// ---------------------------------------------------------------------------

export type StageStatus = "working" | "frozen" | "accepted";

/**
 * One repository of a cross-repository stage's candidate set, as the engine
 * records it (stage.py: `CandidateRepository`). `candidateSha` is null until
 * the freeze boundary resolves and pins that repository's reviewed commit;
 * acceptance then re-verifies every pin.
 */
export interface StateRepository {
  name: string;
  path: string;
  branch: string;
  candidateSha: string | null;
}

export interface StageState {
  status: StageStatus;
  implementationSessionId: string | null;
  sparringSessionId: string | null;
  baseSha: string | null;
  candidateSha: string | null;
  /** Declared sibling repositories; empty for the ordinary single-repository stage. */
  repositories: StateRepository[];
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
    repositories: stateRepositories(payload["repositories"]),
  };
}

/**
 * The recorded candidate set. A stage written before the field existed omits
 * it entirely, so absence means "one repository", not an error; an entry
 * missing a name, path or branch is dropped rather than half-shown, because
 * the Overview may only state what the engine actually recorded.
 */
function stateRepositories(raw: unknown): StateRepository[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: StateRepository[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
    const repoPath = typeof entry["path"] === "string" ? entry["path"].trim() : "";
    const branch = typeof entry["branch"] === "string" ? entry["branch"].trim() : "";
    const sha = typeof entry["candidate_sha"] === "string" ? entry["candidate_sha"].trim() : "";
    if (name && repoPath && branch) {
      out.push({ name, path: repoPath, branch, candidateSha: sha || null });
    }
  }
  return out;
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
// handoff.md git context (handoff.py: render_handoff)
// ---------------------------------------------------------------------------

/**
 * The branch recorded in a stage's `handoff.md` (`## Git context` → ``- Branch:
 * `feature/x` ``, handoff.py). That is the branch the stage's last handoff was
 * generated on: the only place a standalone stage's branch is written down,
 * since state.json records none. Undefined when the file has no such line.
 */
export function parseHandoffBranch(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Git context");
  if (start < 0) {
    return undefined;
  }
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,2}\s/.test(lines[index])) {
      break;
    }
    const match = /^-\s+Branch:\s*`?([^`\s][^`]*?)`?\s*$/.exec(lines[index]);
    if (match) {
      const branch = match[1].trim();
      return branch && branch !== "not recorded" ? branch : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// sparring.md routing outcome (sparring_exchange.py: render_sparring)
// ---------------------------------------------------------------------------

export type RoutingAction = "SEND_BACK" | "READY" | "NEEDS_YOU" | "ESCALATE";

const ROUTING_ACTIONS: ReadonlySet<string> = new Set(["SEND_BACK", "READY", "NEEDS_YOU", "ESCALATE"]);

/**
 * One thing a human must finish before the stage can be READY
 * (human_gate.py: HumanCheck). `id` is stable across sparring turns, so a
 * recorded Pass/Fail/Blocked survives the reviewer restating its gate.
 */
export interface HumanGateCheck {
  id: string;
  instruction: string;
  passCriteria: string;
  /** Where the full test is defined, when the reviewer said. */
  source?: string;
}

/** The structured NEEDS_YOU gate (human_gate.py: HumanGate). */
export interface HumanGate {
  /** `DEVICE_MANUAL_CHECK`, `PRODUCT_PREFERENCE`, … */
  category: string;
  title: string;
  checks: HumanGateCheck[];
}

/**
 * The marker sparring_exchange.py writes immediately before the gate's
 * canonical JSON block. An HTML comment, so it is invisible when the file
 * is rendered, and versioned so a later shape is detectable rather than
 * silently misparsed.
 */
export const HUMAN_GATE_MARKER = "<!-- human-gate:v1 -->";

export interface SparringOutcome {
  action: RoutingAction;
  summary: string;
  needsYouReason?: string;
  /** The body of the engine-rendered `## Deferred` section (the sparrer's deferred / human-gated items), when present and non-empty. */
  deferred?: string;
  /**
   * The body of the engine-rendered `## Finding / discussion` section
   * (sparring_exchange.py: render_sparring) — the reviewer's own findings, in
   * their own words. It is the reviewer's written output, never a provider
   * prompt or a transcript, and it is carried verbatim wherever it is shown.
   */
  findings?: string;
  /**
   * The structured human gate, when the recorded verdict carries one. This
   * is the only trustworthy list of what a human must do: everything else in
   * sparring.md is prose, and prose was previously mined for checks, which
   * cannot tell a blocking device test from a deployment step mentioned in
   * the same paragraph. Absent for results recorded before the engine had
   * structured gates.
   */
  humanGate?: HumanGate;
}

/**
 * The gate's canonical JSON, from the fenced block that follows
 * {@link HUMAN_GATE_MARKER}. Undefined when there is no marker, no fence
 * after it, or the block is not a well-formed gate — a reader of a recorded
 * file never throws, and a caller falls back to treating the result as
 * unstructured rather than inventing checks.
 */
export function parseHumanGate(markdown: string): HumanGate | undefined {
  const at = markdown.indexOf(HUMAN_GATE_MARKER);
  if (at < 0) {
    return undefined;
  }
  const after = markdown.slice(at + HUMAN_GATE_MARKER.length);
  const fence = /^[^\S\n]*```[^\n]*\n([\s\S]*?)\n[^\S\n]*```/m.exec(after);
  if (!fence) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fence[1]);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const category = typeof raw["category"] === "string" ? raw["category"].trim() : "";
  const title = typeof raw["title"] === "string" ? raw["title"].trim() : "";
  const rawChecks = raw["checks"];
  if (!category || !title || !Array.isArray(rawChecks) || rawChecks.length === 0) {
    return undefined;
  }
  const checks: HumanGateCheck[] = [];
  for (const entry of rawChecks) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    const instruction = typeof entry["instruction"] === "string" ? entry["instruction"].trim() : "";
    const passCriteria = typeof entry["pass_criteria"] === "string" ? entry["pass_criteria"].trim() : "";
    if (!id || !instruction || !passCriteria || checks.some((check) => check.id === id)) {
      return undefined;
    }
    const source = typeof entry["source"] === "string" && entry["source"].trim() ? entry["source"].trim() : undefined;
    checks.push({ id, instruction, passCriteria, source });
  }
  return { category, title, checks };
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
  return {
    action: action as RoutingAction,
    summary,
    needsYouReason,
    deferred: sectionBody(lines, "## Deferred"),
    findings: sectionBody(lines, SPARRING_FINDINGS_HEADING),
    humanGate: action === "NEEDS_YOU" ? parseHumanGate(markdown) : undefined,
  };
}

/** The reviewer's findings section of sparring.md (sparring_exchange.py: render_sparring). */
export const SPARRING_FINDINGS_HEADING = "## Finding / discussion";

/**
 * The stage agent's own account of the candidate: the `## Claims` body of
 * handoff.md (handoff.py: render_thin_handoff). It is the last thing the
 * implementing agent wrote down about what it did, so it is what a reader of
 * the review needs in order to know what is being reviewed. Undefined when the
 * file has no such section or the engine wrote its `(not recorded)` placeholder.
 *
 * Nothing else of handoff.md is read here. The embedded diff of a
 * self-contained packet, the changed-file list and the test/build evidence are
 * all deliberately left alone: they are transcripts and payloads, not a summary.
 */
export function parseHandoffClaims(markdown: string): string | undefined {
  return sectionBody(markdown.split(/\r?\n/), "## Claims");
}

/** The trimmed prose under a `##` heading of sparring.md, up to the next `#`/`##` heading; undefined when absent, empty or the template's `(none)`. */
function sectionBody(lines: string[], heading: string): string | undefined {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return undefined;
  }
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,2}\s/.test(lines[index])) {
      break;
    }
    body.push(lines[index]);
  }
  const text = body.join("\n").trim();
  return !text || /^\((?:none|not applicable|none recorded|not recorded)\)$/i.test(text) ? undefined : text;
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
