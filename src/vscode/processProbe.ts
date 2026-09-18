/**
 * One process-table snapshot via `ps` (POSIX only). Used solely to
 * re-establish, after a window reload, whether a runner launched before the
 * reload is still alive under its reconnected terminal's shell. On platforms
 * without `ps` the probe reports itself unsupported and callers stay at
 * "unknown" rather than guess.
 */

import { execFile } from "node:child_process";
import { parsePsOutput, type ProcessInfo } from "../core/processTree";

export function processProbeSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * All processes as pid / ppid / birth time / command line; rejects when `ps`
 * is unavailable or fails.
 *
 * The birth time (`lstart`) is asked for because a pid on its own cannot
 * identify a process — pids are reused — and the difference between "this is
 * still the process we started" and "this pid is something else now" is
 * exactly what may, or may not, release a duplicate guard. A platform whose
 * `ps` refuses `lstart` is asked again without it, and callers then treat an
 * unrecognisable live pid as unresolved rather than as a death.
 */
export function listProcesses(): Promise<ProcessInfo[]> {
  return read("pid=,ppid=,lstart=,command=").catch(() => read("pid=,ppid=,command="));
}

function read(format: string): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", format], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(parsePsOutput(stdout));
    });
  });
}
