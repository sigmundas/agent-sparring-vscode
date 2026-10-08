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

import * as crypto from "node:crypto";
import * as path from "node:path";

export type PlanRunStatus = "running" | "paused" | "complete";

export interface PlanRunState {
  /** Plan label: repo-relative POSIX path, or an absolute path (plan.py: plan_label). */
  plan: string;
  /**
   * This run instance's own key (plan.py: `PlanRunState.run`) — which
   * *execution* of `plan` this is. Null for a run recorded before run
   * instances existed; `runKeyOf` reads that as the plan's key, which is the
   * key such a run's stages already record.
   */
  run: string | null;
  planDigest: string;
  expectedBranch: string;
  /** 0-based index into the plan's parsed stages. */
  currentStageIndex: number;
  /** Stage id of the current stage (`<run key>-stage-<n>-<slug>`). */
  currentStage: string;
  status: PlanRunStatus;
  /**
   * Which plan input this run executes. The engine refuses to resume a run
   * from a different kind of input, so a run started from a manifest must
   * be continued with `--manifest`, never with the plan's own path. Absent
   * from state written before manifests existed, and read as `markdown`.
   */
  source: PlanRunSource;
  /**
   * The typed reason this run is stopped, when the reason is one the runner
   * itself recorded rather than a reviewer's verdict (plan.py:
   * `PlanRunState.awaiting`, push_gate.py: `PushRequired`). Today there is
   * one kind, and the whole point of it being typed is that a consumer
   * switches on `kind` instead of reading prose: a run waiting for
   * permission to push is not a run waiting for a manual test, and the
   * difference used to be invisible. Absent for every run recorded before
   * the engine had it, and absent whenever the run is not stopped on such a
   * reason.
   */
  awaiting?: PushAuthorizationRequired | DeferredVerificationRequired;
  /**
   * What a person has allowed this run to push, and for exactly what
   * (push_gate.py: `PushAuthorization`). Absent — including for every run
   * recorded before push authorization existed — means no authorization at
   * all, which is the engine's default and is never inferred otherwise.
   */
  pushAuthorization?: PushAuthorizationState;
  /**
   * Human verification the reviewers deferred rather than stopped for
   * (`plan.py`: `PlanRunState.deferred_human_checks`, `deferred_gate.py`).
   *
   * This is the engine's durable ledger, and it is the only place these
   * live: a stage's `sparring.md` is rewritten by every SEND_BACK cycle, and
   * an obligation deliberately outlives the stage that raised it. Empty for
   * every run recorded before deferral existed — which is also the right
   * reading of "this run owes nothing".
   */
  deferredHumanChecks: DeferredObligation[];
  /**
   * Why the engine stopped on a provider rather than on a verdict
   * (`provider_pause`). Descriptive only: absent on older engines and
   * whenever the run is not stopped on such a reason, and never inferred
   * from activity or output.
   */
  providerPause?: ProviderPause;
}

/** The roles a provider pause or a session history names. */
export type SessionRole = "stage" | "sparring";

/** `provider_pause` of the plan-run state, verbatim. */
export interface ProviderPause {
  kind: "session-unresumable" | "provider-unavailable";
  role: SessionRole;
  stageId: string;
  /** False: the role has no conversation to replace, so only a retry is offered. */
  hasSession: boolean;
  recordedAt: string | null;
}

/** `provider_pause`, or undefined when absent or not a shape this extension knows. */
function parseProviderPause(raw: unknown): ProviderPause | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const kind = raw["kind"];
  const role = raw["role"];
  const stageId = raw["stage_id"];
  if ((kind !== "session-unresumable" && kind !== "provider-unavailable") || (role !== "stage" && role !== "sparring") || typeof stageId !== "string" || !stageId) {
    return undefined;
  }
  return { kind, role, stageId, hasSession: raw["has_session"] === true, recordedAt: typeof raw["recorded_at"] === "string" ? raw["recorded_at"] : null };
}

/** `deferred_gate.py`: the one outcome vocabulary, shared with human gates. */
export type DeferredCheckOutcome = "pass" | "fail" | "blocked";

/** One person's recorded answer to one deferred check (`deferred_gate.py`: `CheckResult`). */
export interface DeferredCheckResult {
  checkId: string;
  outcome: DeferredCheckOutcome;
  note?: string;
}

/**
 * One obligation in the run's ledger: what a reviewer deferred, why, and
 * where it came from (`deferred_gate.py`: `DeferredObligation`).
 *
 * `stageId` and the gate's `instanceId` are the provenance. An obligation
 * raised by stage 2 and answered after stage 7 is still stage 2's, and the
 * asking it belongs to is still the one the reviewer minted it under — which
 * is what keeps an answer to an earlier asking from satisfying a later one.
 */
export interface DeferredObligation {
  /** The stage whose review raised it. */
  stageId: string;
  gate: HumanGate;
  /** Why the reviewer judged continuing first to be low risk. Required by the engine. */
  rationale: string;
  /** `before_plan_completion` today; a stored value, so a later checkpoint is a value and not a format. */
  checkpoint: string;
  /** A later reviewer decided this can wait no longer. Same asking, due sooner. */
  promoted: boolean;
  results: DeferredCheckResult[];
}

/** The engine's own derivation (`DeferredObligation.status`), repeated here rather than stored. */
export function obligationResolved(obligation: DeferredObligation): boolean {
  return obligation.gate.checks.every(
    (check) => obligation.results.find((result) => result.checkId === check.id)?.outcome === "pass",
  );
}

/** Did somebody record a Fail against this obligation? Then the plan cannot finish on it. */
export function obligationFailed(obligation: DeferredObligation): boolean {
  return obligation.results.some((result) => result.outcome === "fail");
}

/** `deferred_gate.py`: the typed reason a run stops for verification already owed. */
export const DEFERRED_VERIFICATION_REQUIRED = "deferred_verification_required";

/**
 * A run stopped because a person owes it verification an earlier reviewer
 * deferred (`deferred_gate.py`: `DeferredVerificationRequired`).
 *
 * It names only the askings; the obligations themselves are in
 * {@link PlanRunState.deferredHumanChecks}, which is the one authority for
 * their content. `reason` says which checkpoint stopped the run —
 * `plan_completion` for the ordinary end-of-plan checkpoint,
 * `promoted` for an obligation a later reviewer said could not wait,
 * `before_stage` for a plan-declared gate between two stages. Only
 * `plan_completion` ends the plan when answered; after the others the
 * engine resumes and the next stage's agents run.
 */
export interface DeferredVerificationRequired {
  kind: typeof DEFERRED_VERIFICATION_REQUIRED;
  reason: "plan_completion" | "promoted" | "before_stage";
  instanceIds: string[];
}

/**
 * plan_model.py `PlanSource.kind`: which plan input a run executes.
 *
 * `intake-manifest` is intake_approval.py `SOURCE_KIND`: an approved plan-intake
 * slice, whose sealed manifest lives under `.sparring/intake/<id>/runs/<run>/`
 * and whose stages come from that manifest, never from the source Markdown.
 */
export type PlanRunSource = "markdown" | "manifest" | "intake-manifest";

const PLAN_RUN_SOURCES: ReadonlySet<string> = new Set<PlanRunSource>(["markdown", "manifest", "intake-manifest"]);

/** push_gate.py: the one typed reason a managed run stops on today. */
export const PUSH_AUTHORIZATION_REQUIRED = "push_authorization_required";

/**
 * A verified candidate the engine will not push without being told to.
 *
 * Every field comes from the engine's own record of the pause, so a
 * consumer can name the exact commit and the exact remote branch without
 * running git and without parsing a sentence.
 */
export interface PushAuthorizationRequired {
  kind: typeof PUSH_AUTHORIZATION_REQUIRED;
  stageId: string;
  /** The full 40-character commit id the reviewer said READY over. */
  candidateSha: string;
  /** The local branch the run was started for. */
  branch: string;
  remote: string;
  remoteBranch: string;
  /** Git's own account of why the commit is not on the remote yet; diagnostic. */
  detail?: string;
}

/** `candidate`: one commit of one stage. `run`: this run's later verified candidates. */
export type PushAuthorizationScope = "candidate" | "run";

export interface PushAuthorizationState {
  scope: PushAuthorizationScope;
  /** The worktree the permission was granted in, resolved. */
  repoRoot: string;
  branch: string;
  remote: string;
  remoteBranch: string;
  /** Candidate scope only. */
  stageId?: string;
  candidateSha?: string;
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
  // Absent is the engine's own reading of state written before manifests
  // existed (plan.py: `source: str = "markdown"`). Any other value is a plan
  // input this extension does not know, and treating it as Markdown would
  // resume the run from the wrong input, so it is refused like an unknown
  // status.
  const rawSource = payload["source"] ?? "markdown";
  if (typeof rawSource !== "string" || !PLAN_RUN_SOURCES.has(rawSource)) {
    throw new EngineFormatError(`unsupported plan input kind ${JSON.stringify(rawSource)}; this version of the extension does not know how to continue it`);
  }
  const source = rawSource as PlanRunSource;
  return {
    plan,
    run: optionalString(payload, "run"),
    planDigest,
    expectedBranch,
    currentStageIndex,
    currentStage,
    status: status as PlanRunStatus,
    source,
    awaiting: parseAwaiting(payload["awaiting"]),
    pushAuthorization: parsePushAuthorization(payload["push_authorization"]),
    deferredHumanChecks: parseDeferredObligations(payload["deferred_human_checks"]),
    providerPause: parseProviderPause(payload["provider_pause"]),
  };
}

/**
 * The obligation ledger, or an empty one.
 *
 * An entry that cannot be read as a whole obligation is dropped rather than
 * half-shown, exactly as a malformed candidate repository is: the panel may
 * only state what the engine actually recorded, and half an obligation would
 * ask a person to answer a question nobody can see. Absence of the field is
 * not an error — it is every run written before deferral existed.
 */
function parseDeferredObligations(raw: unknown): DeferredObligation[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: DeferredObligation[] = [];
  for (const value of raw) {
    if (!isRecord(value)) {
      continue;
    }
    const stageId = text(value, "stage_id");
    const gate = parseGateObject(value["gate"]);
    const rationale = text(value, "rationale");
    // An obligation with no engine-minted asking cannot be answered, and an
    // obligation with no rationale is not one the engine would have written.
    if (!stageId || !gate || !gate.instanceId || !rationale) {
      continue;
    }
    out.push({
      stageId,
      gate,
      rationale,
      checkpoint: text(value, "checkpoint") ?? "before_plan_completion",
      promoted: value["promoted"] === true,
      results: parseDeferredResults(value["results"]),
    });
  }
  return out;
}

function parseDeferredResults(raw: unknown): DeferredCheckResult[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: DeferredCheckResult[] = [];
  for (const value of raw) {
    if (!isRecord(value)) {
      continue;
    }
    const checkId = text(value, "check_id");
    const outcome = value["outcome"];
    if (!checkId || (outcome !== "pass" && outcome !== "fail" && outcome !== "blocked")) {
      continue;
    }
    out.push({ checkId, outcome, note: text(value, "note") });
  }
  return out;
}

/**
 * The typed pause, or undefined.
 *
 * Undefined for absent, for a kind this version does not know, and for a
 * record missing any field it would have to be rendered from. That is
 * deliberate: half a push request is not a push request, and presenting one
 * without the commit it is about would ask a person to authorize they know
 * not what. An unknown kind is a newer engine, and the honest answer to it
 * is to fall back to the ordinary presentation rather than to guess.
 */
function parseAwaiting(raw: unknown): PushAuthorizationRequired | DeferredVerificationRequired | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw["kind"] === DEFERRED_VERIFICATION_REQUIRED) {
    const ids = Array.isArray(raw["instance_ids"]) ? raw["instance_ids"].filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
    if (ids.length === 0) {
      return undefined; // a checkpoint that names no asking is not one
    }
    // The engine writes `plan_completion` when it records no reason. Any
    // other value is a checkpoint after which the run goes on, and reading
    // it as completion would promise a person the plan ends when answering
    // in fact starts more implementation.
    const given = raw["reason"];
    const reason = given === undefined || given === null || given === "" || given === "plan_completion" ? "plan_completion" : given === "promoted" ? "promoted" : "before_stage";
    return { kind: DEFERRED_VERIFICATION_REQUIRED, reason, instanceIds: ids };
  }
  if (raw["kind"] !== PUSH_AUTHORIZATION_REQUIRED) {
    return undefined;
  }
  const stageId = text(raw, "stage_id");
  const candidateSha = text(raw, "candidate_sha");
  const branch = text(raw, "branch");
  const remote = text(raw, "remote");
  const remoteBranch = text(raw, "remote_branch");
  if (!stageId || !candidateSha || !branch || !remote || !remoteBranch) {
    return undefined;
  }
  return { kind: PUSH_AUTHORIZATION_REQUIRED, stageId, candidateSha, branch, remote, remoteBranch, detail: text(raw, "detail") };
}

/** The recorded permission, or undefined — which means no permission, never an error. */
function parsePushAuthorization(raw: unknown): PushAuthorizationState | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const scope = raw["scope"];
  if (scope !== "candidate" && scope !== "run") {
    return undefined;
  }
  const repoRoot = text(raw, "repo_root");
  const branch = text(raw, "branch");
  const remote = text(raw, "remote");
  const remoteBranch = text(raw, "remote_branch");
  if (!repoRoot || !branch || !remote || !remoteBranch) {
    return undefined;
  }
  const stageId = text(raw, "stage_id");
  const candidateSha = text(raw, "candidate_sha");
  if (scope === "candidate" && (!stageId || !candidateSha)) {
    return undefined; // a one-candidate permission that names no candidate is not one
  }
  return { scope, repoRoot, branch, remote, remoteBranch, stageId, candidateSha };
}

function text(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  /**
   * The key of the managed **run instance** that owns this stage instance
   * (stage.py: `StageState.run`), or null when no run has claimed it — a
   * hand-driven standalone stage, or one written before the engine recorded
   * ownership. This is the authoritative answer to "whose stage is this",
   * and the only thing that may decide it: two runs in one worktree can
   * generate the same stage id, so the name never settles it.
   *
   * A run instance, not a plan document: the same document can be executed
   * twice, and the second run's stages are its own. A file carrying the
   * older `plan` spelling held a plan key, which named that document's only
   * execution, and is read here as that legacy run.
   */
  run: string | null;
  /**
   * What each role runs with for this stage's whole life (stage.py
   * `StageState.agents`), written by the engine before the stage's first
   * provider turn and reused by every later turn. `null` when absent: the
   * stage has not pinned anything yet. Data to display only.
   */
  agents: Record<string, StageAgentPin> | null;
  /**
   * Each role's conversation history (`sessions`), oldest first. `null` on
   * an engine that does not record it, which hides every fresh-session
   * control. Descriptive only.
   */
  sessions: Record<string, StageSession[]> | null;
  /** Which actor the engine runs next (`next_turn`), when it says. Never chosen here. */
  nextTurn: string | null;
}

/** One conversation of one role (`sessions[role][i]`). */
export interface StageSession {
  generation: number;
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string | null;
  startReason: string | null;
  endedAt: string | null;
  endReason: string | null;
}

/** `sessions`, tolerantly: a malformed entry is dropped, a non-object is no history. */
function stageSessions(raw: unknown): Record<string, StageSession[]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
  const out: Record<string, StageSession[]> = {};
  for (const [role, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const entries: StageSession[] = [];
    for (const value of list) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const generation = entry["generation"];
      if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
        continue;
      }
      const agent = entry["agent"] && typeof entry["agent"] === "object" ? (entry["agent"] as Record<string, unknown>) : {};
      entries.push({
        generation,
        sessionId: text(entry["session_id"]),
        provider: text(agent["provider"]),
        model: text(agent["model"]),
        effort: text(agent["effort"]),
        startedAt: text(entry["started_at"]),
        startReason: text(entry["start_reason"]),
        endedAt: text(entry["ended_at"]),
        endReason: text(entry["end_reason"]),
      });
    }
    out[role] = entries;
  }
  return out;
}

/** One role's pinned configuration for one stage (stage.py `PinnedAgent`). */
export interface StageAgentPin {
  provider: string;
  model: string | null;
  modelSource: string | null;
  effort: string | null;
  effortSource: string | null;
}

/**
 * The `agents` pin, tolerantly: anything that is not an object is no pin,
 * and an entry without a provider is dropped rather than half-shown.
 */
function stageAgents(raw: unknown): Record<string, StageAgentPin> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
  const out: Record<string, StageAgentPin> = {};
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const provider = text(entry["provider"]);
    if (!provider) {
      continue;
    }
    out[role] = { provider, model: text(entry["model"]), modelSource: text(entry["model_source"]), effort: text(entry["effort"]), effortSource: text(entry["effort_source"]) };
  }
  return Object.keys(out).length > 0 ? out : null;
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
    // Either spelling: `run` is the owner, and a file written under the
    // older `plan` key recorded a plan key, which named that document's one
    // execution. Reading it as the owning run is what it meant.
    run: optionalString(payload, "run") ?? optionalString(payload, "plan"),
    agents: stageAgents(payload["agents"]),
    sessions: stageSessions(payload["sessions"]),
    nextTurn: optionalString(payload, "next_turn"),
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
  /**
   * What the provider said about its own budget, on `provider.usage`
   * (activity.py). Every one is optional and every one is a quotation:
   * Codex states all of them, the Claude CLI states only the token counts.
   *
   * `undefined` means the provider did not say, and it must not be read as
   * zero. Nothing here may be filled in from a model name — a context
   * window guessed that way is an invention with a measurement's
   * authority.
   */
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** How full the window is now, as against `total_tokens`, which only grows. */
  context_used_tokens?: number;
  context_window?: number;
  rate_limit_percent?: number;
  rate_limit_window_minutes?: number;
  rate_limit_secondary_percent?: number;
  rate_limit_secondary_window_minutes?: number;
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
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "context_used_tokens",
  "context_window",
  "rate_limit_percent",
  "rate_limit_window_minutes",
  "rate_limit_secondary_percent",
  "rate_limit_secondary_window_minutes",
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
  /**
   * What the plan calls the stage, when a manifest named it (`Stage 1A`).
   * Absent for headings parsed from Markdown, whose name is `Stage <number>`.
   */
  label?: string;
}

/**
 * plan.py `plan_key`: the plan *document*'s identity — slugged stem (<=32
 * chars) plus the first 8 hex digits of SHA-256(label).
 *
 * A document's identity, not a run's. It groups what belongs to the plan
 * across executions (the declarations a person made about its stages, its
 * runs in the cockpit's history), while one execution is identified by a run
 * key — see plan.py `new_run_key` and `PlanRunSnapshot.runKey`.
 */
export function planKey(label: string): string {
  const digest = crypto.createHash("sha256").update(label, "utf8").digest("hex").slice(0, 8);
  const stem = path.posix.basename(label).replace(/\.[^.]*$/, "");
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug ? `${slug}-${digest}` : digest;
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

/**
 * Mirrors plan.py `_stage_id_for`: `<run key>-stage-<n>-<slug>`, clamped to
 * 128 chars. The namespace is the owning *run instance*'s key, since one plan
 * document may have been executed more than once and each execution has its
 * own stages.
 */
export function stageIdFor(runKey: string | undefined, number: number, title: string): string {
  let base = `stage-${number}`;
  if (runKey) {
    base = `${runKey}-${base}`;
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
export function parsePlanStages(markdown: string, runKey?: string): PlanStageHeading[] {
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
    stages.push({ number, title, stageId: stageIdFor(runKey, number, title) });
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
  /**
   * Which *asking* of this gate the file records (human_gate.py:
   * `instance_id`, minted by the engine in `record_sparring`).
   *
   * A check's `id` says what question it is; this says which turn asked it.
   * A reviewer re-issues a check under the same id precisely when the
   * recorded answer was not enough — "a Pass alone does not identify which
   * option you chose" — and a recorded answer belongs to one asking rather
   * than to the id forever. Absent for a gate recorded before the engine
   * minted these, which is the one case where attribution cannot be proven.
   */
  instanceId?: string;
}

/**
 * The marker sparring_exchange.py writes immediately before the gate's
 * canonical JSON block. An HTML comment, so it is invisible when the file
 * is rendered, and versioned so a later shape is detectable rather than
 * silently misparsed.
 */
export const HUMAN_GATE_MARKER = "<!-- human-gate:v1 -->";

/**
 * The marker before a *deferred* gate's canonical JSON
 * (`deferred_gate.py`: `DEFERRED_GATE_MARKER`). A different marker, not a
 * flag inside the same block, so a consumer can never read one for the
 * other: the whole point of the distinction is that a deferred gate does
 * *not* stop the stage.
 */
export const DEFERRED_GATE_MARKER = "<!-- deferred-human-gate:v1 -->";

/**
 * A gate a READY verdict deferred: the same checks, plus why continuing
 * first is low risk and by when the answer is owed.
 */
export interface DeferredHumanGate {
  gate: HumanGate;
  rationale: string;
  /** `before_plan_completion` today. */
  checkpoint: string;
}

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
  /**
   * The verification this READY verdict deferred, when it deferred any.
   *
   * Its presence is the difference between "the reviewer accepted this
   * stage" and "the reviewer accepted this stage and a person still owes it
   * a check" — and the panel must say the second one without ever saying
   * the stage is waiting, because it is not. The durable record is the
   * plan-run state's ledger; this is what the stage's own review said.
   */
  deferredHumanGate?: DeferredHumanGate;
}

/**
 * The gate's canonical JSON, from the fenced block that follows
 * {@link HUMAN_GATE_MARKER}. Undefined when there is no marker, no fence
 * after it, or the block is not a well-formed gate — a reader of a recorded
 * file never throws, and a caller falls back to treating the result as
 * unstructured rather than inventing checks.
 */
export function parseHumanGate(markdown: string): HumanGate | undefined {
  return parseGateObject(markedJson(markdown, HUMAN_GATE_MARKER));
}

/**
 * The deferred gate a READY verdict recorded, from the block that follows
 * {@link DEFERRED_GATE_MARKER} (`deferred_gate.py`, rendered by
 * `sparring_exchange.py`).
 *
 * The same two-layer shape as the immediate gate, plus the reviewer's
 * rationale and the checkpoint. A gate without a rationale is not read at
 * all: the engine refuses to mint one, so a block missing it is not
 * something this version should present as a reviewer's decision.
 */
export function parseDeferredHumanGate(markdown: string): DeferredHumanGate | undefined {
  const raw = markedJson(markdown, DEFERRED_GATE_MARKER);
  const gate = parseGateObject(raw);
  const rationale = isRecord(raw) && typeof raw["rationale"] === "string" ? raw["rationale"].trim() : "";
  if (!gate || !rationale) {
    return undefined;
  }
  const checkpoint = isRecord(raw) && typeof raw["checkpoint"] === "string" && raw["checkpoint"].trim() ? raw["checkpoint"].trim() : "before_plan_completion";
  return { gate, rationale, checkpoint };
}

/** The first ```` ```json ```` block after `marker`, parsed; undefined for anything else. */
function markedJson(markdown: string, marker: string): unknown {
  const at = markdown.indexOf(marker);
  if (at < 0) {
    return undefined;
  }
  const after = markdown.slice(at + marker.length);
  const fence = /^[^\S\n]*```[^\n]*\n([\s\S]*?)\n[^\S\n]*```/m.exec(after);
  if (!fence) {
    return undefined;
  }
  try {
    return JSON.parse(fence[1]);
  } catch {
    return undefined;
  }
}

/**
 * A gate's own fields, from an already-parsed object. Shared by the
 * immediate gate in sparring.md, the deferred gate beside it, and the
 * obligations in the plan-run state, so all three read the same shape the
 * same way and cannot drift apart.
 */
function parseGateObject(raw: unknown): HumanGate | undefined {
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
  // A malformed instance is read as *absent*, never as a made-up value and
  // never as a reason to discard the gate: "which asking this is" is
  // unknown, which the caller already has a conservative answer for, whereas
  // dropping the gate would hide the checks a person has to do.
  const rawInstance = raw["instance_id"];
  const instanceId = typeof rawInstance === "string" && GATE_INSTANCE_ID_RE.test(rawInstance.trim()) ? rawInstance.trim() : undefined;
  return { category, title, checks, instanceId };
}

/** The engine's own shape for a gate instance id (human_gate.py: `_INSTANCE_ID_RE`). */
const GATE_INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    deferredHumanGate: action === "READY" ? parseDeferredHumanGate(markdown) : undefined,
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

// ---------------------------------------------------------------------------
// `sparring runs --json`  (managed_finish.py: runs_report; reference.md
// "Managed-run JSON"). The engine calls these *managed* runs; the extension
// already says "managed run" for every engine-driven plan run, so here they
// are *isolated* runs: a plan run in a worktree the engine created for it.
// ---------------------------------------------------------------------------

/** The only `runs --json` schema this extension reads. */
export const ISOLATED_RUNS_SCHEMA_VERSION = 1;

export type IsolatedRunLifecycle = "creating" | "creation_failed" | "created" | "merged" | "worktree_removed" | "finished";

const ISOLATED_RUN_LIFECYCLES: ReadonlySet<string> = new Set<IsolatedRunLifecycle>(["creating", "creation_failed", "created", "merged", "worktree_removed", "finished"]);

/**
 * One engine-recorded run in its own worktree. The record is the only link
 * between a run key and a worktree: nothing else (a folder name, a branch
 * name, `git worktree list`) makes a worktree a run's.
 */
export interface IsolatedRun {
  runKey: string;
  planLabel: string;
  /** Absolute, from the engine's record. */
  worktreePath: string;
  worktreeExists: boolean;
  branch: string;
  targetBranch: string;
  lifecycle: IsolatedRunLifecycle;
  /** The run state's status, or `missing` / `unreadable`; presentation reads the run state itself. */
  runStatus: string;
  /**
   * The engine's own finish dry run for the run's state as listed, when it
   * gave one this version reads. The only source of "Ready to merge".
   */
  finish?: FinishCheck;
  /** Why an embedded finish object was not read (schema mismatch, another run's, malformed); reported, never guessed at. */
  finishProblem?: string;
  /** When the extension received {@link finish} from the engine; stamped by the reader, not the engine. */
  finishCheckedAtMs?: number;
}

export type IsolatedRunsReport = { kind: "runs"; runs: IsolatedRun[] } | { kind: "version-mismatch"; version: unknown };

/**
 * Parse `sparring runs --json`. An unknown `schema_version` is a mismatch
 * between engine and extension, reported as such and never guessed at; a
 * known version with a malformed body throws {@link EngineFormatError}.
 */
export function parseIsolatedRuns(text: string): IsolatedRunsReport {
  const payload = parseJsonObject(text, "runs report");
  if (payload["schema_version"] !== ISOLATED_RUNS_SCHEMA_VERSION) {
    return { kind: "version-mismatch", version: payload["schema_version"] };
  }
  const runs = payload["runs"];
  if (!Array.isArray(runs)) {
    throw new EngineFormatError('field "runs" must be a list');
  }
  return {
    kind: "runs",
    runs: runs.map((raw): IsolatedRun => {
      if (!isRecord(raw)) {
        throw new EngineFormatError("each run must be a JSON object");
      }
      if (raw["managed"] !== true) {
        throw new EngineFormatError('field "managed" must be true');
      }
      const lifecycle = requireString(raw, "lifecycle");
      if (!ISOLATED_RUN_LIFECYCLES.has(lifecycle)) {
        throw new EngineFormatError(`unknown managed-run lifecycle ${JSON.stringify(lifecycle)}`);
      }
      const worktreePath = requireString(raw, "worktree_path");
      if (!path.isAbsolute(worktreePath)) {
        throw new EngineFormatError('field "worktree_path" must be absolute');
      }
      if (typeof raw["worktree_exists"] !== "boolean") {
        throw new EngineFormatError('field "worktree_exists" must be a boolean');
      }
      return {
        runKey: requireString(raw, "run_key"),
        planLabel: requireString(raw, "plan_label"),
        worktreePath,
        worktreeExists: raw["worktree_exists"],
        branch: requireString(raw, "branch"),
        targetBranch: requireString(raw, "target_branch"),
        lifecycle: lifecycle as IsolatedRunLifecycle,
        runStatus: requireString(raw, "run_status"),
        ...listedFinish(raw["finish"], requireString(raw, "run_key")),
      };
    }),
  };
}

/**
 * A run's embedded `finish` object, read as strictly as a dry run's own
 * output — but a missing, unknown-version or malformed one only withholds
 * "Ready to merge"; it never hides the run.
 */
function listedFinish(raw: unknown, runKey: string): { finish?: FinishCheck; finishProblem?: string } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (!isRecord(raw)) {
    return { finishProblem: 'field "finish" must be a JSON object' };
  }
  try {
    const report = finishCheckFrom(raw);
    if (report.kind === "version-mismatch") {
      return { finishProblem: `engine/extension mismatch: the finish check reported schema_version ${JSON.stringify(report.version)}, and this extension reads only ${FINISH_RUN_SCHEMA_VERSION}` };
    }
    if (report.finish.runKey !== runKey) {
      return { finishProblem: `the finish check is for run ${report.finish.runKey}, not ${runKey}` };
    }
    return { finish: report.finish };
  } catch (error) {
    return { finishProblem: `the finish check could not be read: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// `sparring finish-run --json`  (managed_finish.py; reference.md
// "Managed-run JSON"). The dry run says whether, and how, a run in its own
// workspace can be merged and cleaned up; execution says how far it got.
// ---------------------------------------------------------------------------

/** The only `finish-run --json` schema this extension reads. */
export const FINISH_RUN_SCHEMA_VERSION = 1;

export type FinishMergeMode = "already_merged" | "fast_forward" | "merge_commit";

const FINISH_MERGE_MODES: ReadonlySet<string> = new Set<FinishMergeMode>(["already_merged", "fast_forward", "merge_commit"]);

export interface FinishCheckItem {
  code: string;
  ok: boolean;
  detail: string;
}

export interface FinishKept {
  action: string;
  code: string;
  detail: string;
}

/** `finish-run --dry-run --json`: the engine's verdict; nothing here is decided by the extension. */
export interface FinishCheck {
  runKey: string;
  eligible: { merge: boolean; cleanup: boolean };
  mergeMode: FinishMergeMode | null;
  actions: string[];
  checks: FinishCheckItem[];
  deletedIgnoredPaths: string[];
  kept: FinishKept[];
  summary: string;
}

/** `finish-run --json` (execution). `stoppedAt` null means every planned step completed. */
export interface FinishResult {
  runKey: string;
  completedSteps: string[];
  stoppedAt: string | null;
  reason: string | null;
  remaining: string[];
  deletedIgnoredPaths: string[];
  kept: FinishKept[];
}

export type FinishCheckReport = { kind: "finish"; finish: FinishCheck } | { kind: "version-mismatch"; version: unknown };
export type FinishResultReport = { kind: "result"; result: FinishResult } | { kind: "version-mismatch"; version: unknown };

/** Parse `finish-run --dry-run --json`. Unknown version: a mismatch, never guessed at. */
export function parseFinishCheck(text: string): FinishCheckReport {
  return finishCheckFrom(parseJsonObject(text, "finish-run dry run"));
}

function finishCheckFrom(payload: Record<string, unknown>): FinishCheckReport {
  if (payload["schema_version"] !== FINISH_RUN_SCHEMA_VERSION) {
    return { kind: "version-mismatch", version: payload["schema_version"] };
  }
  const eligible = payload["eligible"];
  if (!isRecord(eligible) || typeof eligible["merge"] !== "boolean" || typeof eligible["cleanup"] !== "boolean") {
    throw new EngineFormatError('field "eligible" must be {"merge": bool, "cleanup": bool}');
  }
  const mode = payload["merge_mode"];
  if (mode !== null && mode !== undefined && (typeof mode !== "string" || !FINISH_MERGE_MODES.has(mode))) {
    throw new EngineFormatError(`unknown merge_mode ${JSON.stringify(mode)}`);
  }
  const checks = requireList(payload, "checks").map((raw): FinishCheckItem => {
    if (!isRecord(raw) || typeof raw["ok"] !== "boolean") {
      throw new EngineFormatError('each check must be {"code", "ok", "detail"}');
    }
    return { code: requireString(raw, "code"), ok: raw["ok"], detail: requireString(raw, "detail") };
  });
  return {
    kind: "finish",
    finish: {
      runKey: requireString(payload, "run_key"),
      eligible: { merge: eligible["merge"], cleanup: eligible["cleanup"] },
      mergeMode: (mode ?? null) as FinishMergeMode | null,
      actions: requireStringList(payload, "actions"),
      checks,
      deletedIgnoredPaths: requireStringList(payload, "deleted_ignored_paths"),
      kept: requireKept(payload),
      summary: requireString(payload, "summary"),
    },
  };
}

/** Parse `finish-run --json` (execution). */
export function parseFinishResult(text: string): FinishResultReport {
  const payload = parseJsonObject(text, "finish-run report");
  if (payload["schema_version"] !== FINISH_RUN_SCHEMA_VERSION) {
    return { kind: "version-mismatch", version: payload["schema_version"] };
  }
  return {
    kind: "result",
    result: {
      runKey: requireString(payload, "run_key"),
      completedSteps: requireStringList(payload, "completed_steps"),
      stoppedAt: optionalString(payload, "stopped_at"),
      reason: optionalString(payload, "reason"),
      remaining: requireStringList(payload, "remaining"),
      deletedIgnoredPaths: requireStringList(payload, "deleted_ignored_paths"),
      kept: requireKept(payload),
    },
  };
}

function requireList(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new EngineFormatError(`field ${JSON.stringify(key)} must be a list`);
  }
  return value;
}

function requireStringList(payload: Record<string, unknown>, key: string): string[] {
  return requireList(payload, key).map((item) => {
    if (typeof item !== "string") {
      throw new EngineFormatError(`field ${JSON.stringify(key)} must be a list of strings`);
    }
    return item;
  });
}

function requireKept(payload: Record<string, unknown>): FinishKept[] {
  return requireList(payload, "kept").map((raw) => {
    if (!isRecord(raw)) {
      throw new EngineFormatError('each "kept" entry must be a JSON object');
    }
    return { action: requireString(raw, "action"), code: requireString(raw, "code"), detail: requireString(raw, "detail") };
  });
}
