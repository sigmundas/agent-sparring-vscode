/**
 * Pure helpers over a process-table snapshot (`ps -axo pid=,ppid=,command=`
 * on POSIX). Used after a window reload to re-establish whether a runner
 * launched before the reload is still alive under its reconnected terminal's
 * shell. Nothing here runs a process; the vscode layer supplies the rows.
 *
 * No dependency on the vscode API.
 */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  /**
   * When this process was born, exactly as `ps -o lstart=` printed it (`Thu
   * Sep 18 11:12:13 2026`), when the probe was able to ask for it.
   *
   * This is the *generation* of the pid: pids are reused, and a recorded pid
   * that is still in the table may be a different process entirely. A start
   * time that differs from the one recorded when the operation was seen alive
   * is therefore positive evidence that the recorded process is gone —
   * whereas a command line that merely cannot be recognised is no evidence at
   * all. Absent when the platform's `ps` would not print it, in which case a
   * live pid with an unrecognisable command line stays unresolved.
   */
  started?: string;
}

/**
 * Parse `ps -axo pid=,ppid=,lstart=,command=` output, or the same without
 * `lstart=`; malformed lines are skipped.
 *
 * Both shapes are accepted from one parser because the probe asks for the
 * start time first and falls back to the narrower format when a platform's
 * `ps` refuses it (processProbe.ts). A line is read as carrying a start time
 * only when the third field really is a `ps` date, so a command line can
 * never be mistaken for one.
 */
export function parsePsOutput(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const dated = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (dated) {
      rows.push({ pid: Number(dated[1]), ppid: Number(dated[2]), started: dated[3].replace(/\s+/g, " ").trim(), command: dated[4].trim() });
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
    }
  }
  return rows;
}

/** Every process below `rootPid` (children, grandchildren, …), excluding the root itself. */
export function descendantsOf(processes: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const process of processes) {
    const siblings = byParent.get(process.ppid);
    if (siblings) {
      siblings.push(process);
    } else {
      byParent.set(process.ppid, [process]);
    }
  }
  const out: ProcessInfo[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of byParent.get(parent) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        out.push(child);
        queue.push(child.pid);
      }
    }
  }
  return out;
}

/** The first descendant of `rootPid` whose command line satisfies `matches`. */
export function findDescendant(processes: ProcessInfo[], rootPid: number, matches: (commandLine: string) => boolean): ProcessInfo | undefined {
  return descendantsOf(processes, rootPid).find((process) => matches(process.command));
}

/**
 * The first process at or below `rootPid` whose command line satisfies
 * `matches`.
 *
 * `findDescendant` excludes the root, which is right for a shell hosting a
 * runner: the shell is not the engine. It is wrong for a dedicated terminal,
 * whose own process *is* the engine — there the root is the only process that
 * can ever match, and excluding it made a live dedicated runner look dead.
 */
export function findSelfOrDescendant(processes: ProcessInfo[], rootPid: number, matches: (commandLine: string) => boolean): ProcessInfo | undefined {
  const self = processes.find((process) => process.pid === rootPid);
  if (self && matches(self.command)) {
    return self;
  }
  return findDescendant(processes, rootPid, matches);
}

/** Whether a pid is in the snapshot at all. */
export function processExists(processes: ProcessInfo[], pid: number): boolean {
  return processes.some((process) => process.pid === pid);
}

/**
 * What a recorded pid, plus the generation fingerprint recorded with it, can
 * prove about the process that was started.
 *
 *  - `gone`: the pid is not in the table at all, or it is in the table with a
 *    demonstrably different birth time. Either way the recorded process has
 *    ended; this is the only positive death evidence a process table gives.
 *  - `alive`: the pid is there and its birth time is the recorded one, so it
 *    is the same process.
 *  - `unknown`: the pid is there but nothing recorded can distinguish it from
 *    a reused pid — no fingerprint was captured, or this platform's `ps` does
 *    not print one. A guard is kept in this case, never released.
 */
export function processGenerationVerdict(processes: ProcessInfo[], pid: number, generation: string | undefined): "gone" | "alive" | "unknown" {
  const found = processes.find((process) => process.pid === pid);
  if (!found) {
    return "gone";
  }
  if (generation === undefined || found.started === undefined) {
    return "unknown";
  }
  return found.started === generation ? "alive" : "gone";
}
