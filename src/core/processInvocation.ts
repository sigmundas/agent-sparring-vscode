/**
 * Recognising a process this extension spawned from *the invocation it was
 * actually given*.
 *
 * A short engine command is not a loop command, and its command line cannot
 * be parsed for a project and a target: `sparring new-stage stage-5` takes no
 * `--repo-root` at all and identifies its repository by the working directory
 * it was spawned in. An earlier version of the reconciliation demanded the
 * repository root, the subcommand and the stage id as substrings of the
 * command line, and so declared a live `new-stage` gone the moment it looked
 * for a `--repo-root` that had never been passed.
 *
 * So what is recorded, and what is compared, is the invocation: the
 * executable word this extension resolved and the exact argument array it
 * handed to `execFile`. Nothing is inferred from the semantics of those
 * arguments, and nothing is matched by substring — a substring says only that
 * one string contains another, which is neither the same command nor a
 * different one.
 *
 * The predicate answers exactly one question:
 *
 *     "can I positively attribute this process to that invocation?"
 *
 * `false` means "I cannot attribute it", which is not "the operation ended".
 * Callers must read it that way: an unrecognisable live pid stays guarded.
 *
 * No dependency on the vscode API.
 */

import * as path from "node:path";
import { tokenizeCommandLine } from "./sparringCommand";

/** Exactly what was spawned: the executable word and the argument array, verbatim. */
export interface RecordedInvocation {
  /** The executable as this extension resolved it: a full path, or a bare name. */
  word: string;
  /** The arguments as they were passed, in order, unquoted. */
  args: string[];
  /** The working directory it was spawned in, which is how several subcommands identify their project. */
  cwd?: string;
}

/**
 * Whether `commandLine` is positively the recorded invocation.
 *
 * The rule is an exact argument identity: some token in the command line
 * stands for the recorded executable, and every token after it equals the
 * recorded arguments, in order, one for one. A token stands for the executable
 * when it is that exact string or when its file name is — a console script may
 * be reported by `ps` with the interpreter's own spelling of its path, and a
 * wrapper may prepend words — but that alone is never enough: the whole
 * argument vector must match as well.
 */
export function commandLineIsInvocation(commandLine: string, invocation: RecordedInvocation): boolean {
  if (!invocation.word) {
    return false;
  }
  const tokens = tokenizeCommandLine(commandLine);
  for (let i = 0; i < tokens.length; i++) {
    if (!sameExecutable(tokens[i], invocation.word)) {
      continue;
    }
    const rest = tokens.slice(i + 1);
    if (rest.length === invocation.args.length && rest.every((token, at) => token === invocation.args[at])) {
      return true;
    }
  }
  return false;
}

function sameExecutable(token: string, word: string): boolean {
  if (token === word) {
    return true;
  }
  if (path.isAbsolute(token) && path.isAbsolute(word)) {
    return path.resolve(token) === path.resolve(word);
  }
  return basename(token) === basename(word);
}

function basename(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}
