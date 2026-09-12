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

/** All processes as pid / ppid / command line; rejects when `ps` is unavailable or fails. */
export function listProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(parsePsOutput(stdout));
    });
  });
}
