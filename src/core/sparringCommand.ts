/**
 * Recognise `sparring run-loop / run-sparring / run-plan / resume-plan`
 * invocations seen as
 * terminal command lines (VS Code shell integration reports the text the
 * user typed) and tie them to a discovered run in the right repository.
 *
 * Mirrors cli.py's parser surface: a global `--sparring-dir`, then the
 * subcommand, one positional (stage id or plan path) and value-taking
 * options such as `--repo-root`, `--expected-branch`, `--stage-provider`.
 * The plan run id is computed the way plan.py does (`plan_label` +
 * `plan_key`) so a run-plan typed in a terminal matches the run state file
 * the engine will write.
 *
 * No dependency on the vscode API.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import { runIdFor, type RunSnapshot, type SparringLocation } from "./discovery";

export type SparringSubcommand = "run-loop" | "run-sparring" | "run-plan" | "resume-plan";

export interface ParsedSparringCommand {
  subcommand: SparringSubcommand;
  /** Stage id for run-loop / run-sparring. */
  stageId?: string;
  /** Plan path as typed for run-plan / resume-plan. */
  planPath?: string;
  /** Execution manifest as typed (`--manifest`), in place of a plan path. */
  manifest?: string;
  repoRoot?: string;
  sparringDir?: string;
  expectedBranch?: string;
}

const SUBCOMMANDS: ReadonlySet<string> = new Set<SparringSubcommand>(["run-loop", "run-sparring", "run-plan", "resume-plan"]);
/** Executable names that stand for the engine CLI, with any directory and Windows extension stripped. */
const EXECUTABLE_NAMES: ReadonlySet<string> = new Set(["sparring"]);

/**
 * Split a shell command line into words the way a POSIX shell would for the
 * common cases: whitespace separates, single quotes are literal, double
 * quotes and backslashes escape. Good enough for typed commands; nothing
 * here executes anything.
 */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
      } else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
        current += line[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        tokens.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      // Only the first simple command is considered.
      break;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parse a command line into a sparring invocation, or undefined when it is
 * not one. Leading environment assignments and wrappers (`uv run`, `poetry
 * run`, `python -m agent_sparring.cli`) are tolerated by scanning for the
 * executable word; the subcommand must be one of the three loop commands.
 */
export function parseSparringCommand(commandLine: string): ParsedSparringCommand | undefined {
  const tokens = tokenizeCommandLine(commandLine);
  const start = executableIndex(tokens);
  if (start === undefined) {
    return undefined;
  }
  const args = tokens.slice(start + 1);
  let sparringDir: string | undefined;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const [flag, inline] = splitFlag(args[i]);
    if (flag === "--sparring-dir") {
      sparringDir = inline ?? args[i + 1];
      i += inline === undefined ? 2 : 1;
      continue;
    }
    return undefined; // unknown global flag: not a shape we understand
  }
  const subcommand = args[i];
  if (!subcommand || !SUBCOMMANDS.has(subcommand)) {
    return undefined;
  }
  const parsed: ParsedSparringCommand = { subcommand: subcommand as SparringSubcommand, sparringDir };
  const positionals: string[] = [];
  for (i += 1; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      const [flag, inline] = splitFlag(token);
      const value = inline ?? args[i + 1];
      if (inline === undefined) {
        i += 1; // every loop option in cli.py takes a value
      }
      switch (flag) {
        case "--repo-root":
          parsed.repoRoot = value;
          break;
        case "--expected-branch":
          parsed.expectedBranch = value;
          break;
        case "--manifest":
          parsed.manifest = value;
          break;
        default:
          break;
      }
      continue;
    }
    positionals.push(token);
  }
  if (parsed.subcommand === "run-loop" || parsed.subcommand === "run-sparring") {
    if (positionals.length === 0) {
      return undefined;
    }
    parsed.stageId = positionals[0];
    return parsed;
  }
  // A plan command names its plan positionally or as --manifest; exactly one.
  if (positionals.length > 0) {
    parsed.planPath = positionals[0];
  }
  if (!parsed.planPath && !parsed.manifest) {
    return undefined;
  }
  return parsed;
}

/**
 * Index of the token that stands for the engine CLI: the command word
 * itself, after any `NAME=value` assignments and the usual Python launch
 * wrappers. `echo sparring run-loop …` or a pipeline into sparring is not
 * an invocation.
 */
function executableIndex(tokens: string[]): number | undefined {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1; // environment assignment
      continue;
    }
    if (EXECUTABLE_NAMES.has(executableName(token))) {
      return i;
    }
    const name = executableName(token);
    if ((name === "uv" || name === "poetry" || name === "pipx" || name === "pdm" || name === "hatch") && tokens[i + 1] === "run") {
      i += 2;
      continue;
    }
    if (name === "uvx") {
      i += 1;
      continue;
    }
    if (/^python(\d(\.\d+)?)?$/.test(name) || name === "py") {
      if (tokens[i + 1] === "-m" && /^agent_sparring(\.cli)?$/.test(tokens[i + 2] ?? "")) {
        return i + 2;
      }
      if (EXECUTABLE_NAMES.has(executableName(tokens[i + 1] ?? ""))) {
        return i + 1; // how `ps` shows a console script: interpreter + script path
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

function splitFlag(token: string): [string, string | undefined] {
  const eq = token.indexOf("=");
  return eq > 0 ? [token.slice(0, eq), token.slice(eq + 1)] : [token, undefined];
}

function executableName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// matching to a discovered run
// ---------------------------------------------------------------------------

/** plan.py: plan_label — repo-relative POSIX path when inside the repository, else the absolute path. */
export function planLabel(planPath: string, repoRoot: string): string {
  const resolved = path.resolve(planPath);
  const relative = path.relative(path.resolve(repoRoot), resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return resolved.split(path.sep).join("/");
}

/** plan.py: plan_key — slugged stem (≤32 chars) plus the first 8 hex digits of SHA-256(label). */
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

export interface MatchedExecution {
  location: SparringLocation;
  runId: string;
  kind: SparringSubcommand;
  stageId?: string;
  /** Absolute plan path for plan commands. */
  planPath?: string;
}

/**
 * Which discovered project a parsed command targets and the run id it will
 * write to. `cwd` is the terminal's working directory when the command ran;
 * relative `--repo-root`, `--sparring-dir` and plan paths resolve against
 * it, exactly as the engine resolves them. Nested projects are matched by
 * their own repository root, never by the enclosing workspace folder.
 */
export function matchSparringCommand(parsed: ParsedSparringCommand, cwd: string | undefined, locations: SparringLocation[]): MatchedExecution | undefined {
  const base = cwd ?? undefined;
  const resolve = (value: string | undefined) => (value === undefined ? undefined : base ? path.resolve(base, value) : path.isAbsolute(value) ? path.resolve(value) : undefined);

  const explicitRoot = resolve(parsed.repoRoot);
  const explicitDir = resolve(parsed.sparringDir);
  let location: SparringLocation | undefined;
  if (explicitDir) {
    location = locations.find((candidate) => same(candidate.sparringDir, explicitDir));
  }
  if (!location && explicitRoot) {
    location = locations.find((candidate) => same(candidate.repoRoot, explicitRoot));
  }
  if (!location && !explicitDir && !explicitRoot && base) {
    // The engine's default is `.sparring` under the cwd.
    location = locations.find((candidate) => same(candidate.sparringDir, path.join(base, ".sparring"))) ?? deepestContaining(locations, base);
  }
  if (!location) {
    return undefined;
  }
  if (parsed.subcommand === "run-loop") {
    if (!parsed.stageId) {
      return undefined;
    }
    return { location, runId: runIdFor(location, "stage", parsed.stageId), kind: parsed.subcommand, stageId: parsed.stageId };
  }
  const planPath = resolve(parsed.planPath);
  if (!planPath) {
    // A `--manifest` invocation names the plan inside the manifest file, so
    // its run id cannot be derived from the command line alone. The
    // extension's own launches pass their run id explicitly; a manifest run
    // typed by hand in a terminal is simply not tied to a discovered run,
    // rather than tied to the wrong one.
    return undefined;
  }
  const key = planKey(planLabel(planPath, location.repoRoot));
  return { location, runId: runIdFor(location, "plan", key), kind: parsed.subcommand, planPath };
}

/** The run id a run-plan / resume-plan launched by the extension itself will write to. */
export function planRunId(location: SparringLocation, planPath: string): string {
  return runIdFor(location, "plan", planKey(planLabel(planPath, location.repoRoot)));
}

function same(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function deepestContaining(locations: SparringLocation[], dir: string): SparringLocation | undefined {
  return locations
    .filter((location) => {
      const relative = path.relative(path.resolve(location.repoRoot), path.resolve(dir));
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .sort((a, b) => path.resolve(b.repoRoot).length - path.resolve(a.repoRoot).length)[0];
}

/** Whether a process command line is the runner for `match` (used by the post-reload process probe). */
export function commandLineRuns(commandLine: string, match: { kind: SparringSubcommand; stageId?: string; planPath?: string; manifest?: string }): boolean {
  const parsed = parseSparringCommand(commandLine);
  if (!parsed || parsed.subcommand !== match.kind) {
    return false;
  }
  if (match.kind === "run-loop" || match.kind === "run-sparring") {
    return parsed.stageId === match.stageId;
  }
  if (match.manifest) {
    return Boolean(parsed.manifest && path.basename(parsed.manifest) === path.basename(match.manifest));
  }
  return Boolean(parsed.planPath && match.planPath && path.basename(parsed.planPath) === path.basename(match.planPath));
}

export type { RunSnapshot };
