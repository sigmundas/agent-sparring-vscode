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
}

/** Parse `ps -axo pid=,ppid=,command=` output; malformed lines are skipped. */
export function parsePsOutput(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
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
