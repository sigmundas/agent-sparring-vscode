/**
 * `sparring start-plan`: the engine's one-command start of a human plan
 * (agent-sparring docs/intake.md, "One-command start").
 *
 * The extension is a presenter here. It runs `start-plan --json` with the
 * person's inputs, shows the status exactly as the engine reported it, and
 * reruns the *same* command with the person's `--answer`s, or with
 * `--confirm <token>` when the person presses Start. It never answers a
 * decision, never mints or reuses a token, and never decides readiness: the
 * engine recomputes the token from disk on confirm and refuses any
 * difference.
 *
 * No dependency on the vscode API.
 */

import { buildRunPlanArgs } from "./cli";
import type { ManifestGate } from "./manifest";

/** `plan_start.STATUS_VERSION`. A status of another version is not read. */
export const START_PLAN_STATUS_VERSION = 1;

export type StartPlanState = "refused" | "needs_decision" | "ready";

export interface StartPlanDecisionOption {
  id: string;
  label: string;
  consequence: string;
}

export interface StartPlanDecision {
  id: string;
  question: string;
  why: string;
  options: StartPlanDecisionOption[];
  stages: string[];
  finding: string;
}

export interface StartPlanFinding {
  code: string;
  severity: string;
  disposition: string;
  origin: string;
  message: string;
  stages: string[];
}

export interface StartPlanStage {
  /** Null on the direct route: the run mints it. */
  stageId: string | null;
  label: string;
  title: string;
  mode: string;
  /** The human plan's stage label the node maps to. */
  planStageLabel?: string;
  gatesBefore: ManifestGate[];
}

export interface StartPlanSlice {
  runId: string | null;
  runKey: string | null;
  manifestVersion: number | null;
  stages: StartPlanStage[];
  completionGates: ManifestGate[];
}

export interface StartPlanIntake {
  id: string;
  directory: string;
  /** The `report.md` to link as preparation details. */
  report: string;
  mode?: string;
  reused: boolean;
  /** Decision id → option id, as the engine recorded them. */
  answers: Record<string, string>;
}

/** The `--json` status, as the engine reported it. */
export interface StartPlanStatus {
  status: StartPlanState;
  route: "direct" | "intake" | null;
  plan: { path: string; label: string };
  expectedBranch: string;
  /** The options besides models that change what runs, as the engine resolved them. */
  execution?: Record<string, string | number | boolean | null>;
  intake?: StartPlanIntake;
  slice?: StartPlanSlice;
  laterSlices: { runId: string; primaryRepository: string; stages: string[] }[];
  decisions: StartPlanDecision[];
  findings: StartPlanFinding[];
  /** Only when `ready`. */
  confirmToken?: string;
  /** Only when `refused`: the engine's own words. */
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== undefined) : [];
}

function gates(value: unknown): ManifestGate[] {
  return list(value).map((gate) => ({ id: text(gate["id"]), title: text(gate["title"]), kind: text(gate["kind"]), reason: text(gate["reason"]) }));
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * The engine's `start-plan --json` output, or undefined when it is not a
 * status this version reads (another schema version, not JSON, or a
 * missing `status`). Undefined is never read as any state: the caller shows
 * what the engine printed instead.
 */
export function parseStartPlanStatus(stdout: string): StartPlanStatus | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const payload = record(raw);
  if (!payload || payload["schema_version"] !== START_PLAN_STATUS_VERSION) {
    return undefined;
  }
  const status = payload["status"];
  if (status !== "refused" && status !== "needs_decision" && status !== "ready") {
    return undefined;
  }
  const route = payload["route"] === "direct" || payload["route"] === "intake" ? payload["route"] : null;
  const plan = record(payload["plan"]) ?? {};
  const intake = record(payload["intake"]);
  const slice = record(payload["slice"]);
  const execution = record(payload["execution"]);
  const answers: Record<string, string> = {};
  for (const [id, option] of Object.entries(record(intake?.["answers"]) ?? {})) {
    if (typeof option === "string") {
      answers[id] = option;
    }
  }
  const token = payload["confirm_token"];
  const error = payload["error"];
  return {
    status,
    route,
    plan: { path: text(plan["path"]), label: text(plan["label"]) },
    expectedBranch: text(payload["expected_branch"]),
    ...(execution ? { execution: execution as StartPlanStatus["execution"] } : {}),
    ...(intake
      ? {
          intake: {
            id: text(intake["id"]),
            directory: text(intake["directory"]),
            report: text(intake["report"]),
            ...(typeof intake["mode"] === "string" ? { mode: intake["mode"] } : {}),
            reused: intake["reused"] === true,
            answers,
          },
        }
      : {}),
    ...(slice
      ? {
          slice: {
            runId: nullableText(slice["run_id"]),
            runKey: nullableText(slice["run_key"]),
            manifestVersion: typeof slice["manifest_version"] === "number" ? slice["manifest_version"] : null,
            stages: list(slice["stages"]).map((stage) => ({
              stageId: nullableText(stage["stage_id"]),
              label: text(stage["label"]),
              title: text(stage["title"]),
              mode: text(stage["mode"]) || "implementation",
              ...(typeof stage["plan_stage_label"] === "string" && stage["plan_stage_label"] ? { planStageLabel: stage["plan_stage_label"] } : {}),
              gatesBefore: gates(stage["gates_before"]),
            })),
            completionGates: gates(slice["completion_gates"]),
          },
        }
      : {}),
    laterSlices: list(payload["later_slices"]).map((later) => ({ runId: text(later["run_id"]), primaryRepository: text(later["primary_repository"]), stages: strings(later["stages"]) })),
    decisions: list(payload["decisions"]).map((decision) => ({
      id: text(decision["id"]),
      question: text(decision["question"]),
      why: text(decision["why"]),
      options: list(decision["options"]).map((option) => ({ id: text(option["id"]), label: text(option["label"]), consequence: text(option["consequence"]) })),
      stages: strings(decision["stages"]),
      finding: text(decision["finding"]),
    })),
    findings: list(payload["findings"]).map((finding) => ({
      code: text(finding["code"]),
      severity: text(finding["severity"]),
      disposition: text(finding["disposition"]),
      origin: text(finding["origin"]),
      message: text(finding["message"]),
      stages: strings(finding["stages"]),
    })),
    ...(status === "ready" && typeof token === "string" && token ? { confirmToken: token } : {}),
    ...(typeof error === "string" && error ? { error } : {}),
  };
}

export interface StartPlanInvocation {
  planPath: string;
  repoRoot: string;
  expectedBranch: string;
  sparringDir?: string;
  /** Decision id → option id, every one a person chose (or the engine recorded). */
  answers?: Record<string, string>;
  allowPushForRun?: boolean;
}

/**
 * `sparring [--sparring-dir DIR] start-plan PLAN --repo-root ROOT
 * --expected-branch BRANCH [--answer ID=OPTION …] (--json | --confirm TOKEN)
 * [--allow-push-for-run]`.
 *
 * The evaluation and the confirmation are the same command apart from
 * `--json`/`--confirm`, because the engine's token covers every other input
 * and any difference is refused. Boolean flags come last so a command-line
 * reader that assumes every option takes a value still finds the plan.
 */
export function buildStartPlanArgs(invocation: StartPlanInvocation & ({ json: true } | { confirm: string })): string[] {
  // `run-plan`'s argument shape: global flags, subcommand, plan, --repo-root, --expected-branch.
  const base = buildRunPlanArgs({ planPath: invocation.planPath, repoRoot: invocation.repoRoot, expectedBranch: invocation.expectedBranch, sparringDir: invocation.sparringDir });
  const at = base.indexOf("run-plan");
  base[at] = "start-plan";
  for (const id of Object.keys(invocation.answers ?? {}).sort()) {
    base.push("--answer", `${id}=${invocation.answers![id]}`);
  }
  if ("confirm" in invocation) {
    base.push("--confirm", invocation.confirm);
  } else {
    base.push("--json");
  }
  if (invocation.allowPushForRun) {
    base.push("--allow-push-for-run");
  }
  return base;
}

export type StartPlanSupport = "supported" | "missing" | "unknown";

/**
 * Whether the installed engine has `start-plan`, from what `sparring
 * start-plan --help` printed. A probe, never an authority: an engine that
 * printed nothing is "unknown"; one whose argument parser rejected the
 * subcommand is "missing"; one whose help lists `--confirm` is "supported".
 */
export function startPlanSupportFrom(output: string, failed: boolean): StartPlanSupport {
  if (!output.trim()) {
    return "unknown";
  }
  if (output.includes("start-plan") && output.includes("--confirm")) {
    return "supported";
  }
  if (/invalid choice: '?start-plan'?/.test(output)) {
    return "missing";
  }
  return /usage/i.test(output) && !failed ? "missing" : "unknown";
}
