/**
 * Bounded reads of the beginning of a file, shared by the surfaces that
 * display recorded artifacts. Every read is capped: the Overview and the run
 * picker render on a timer, and a stage's own files are written by the engine
 * and can be arbitrarily large.
 */

import * as fs from "node:fs/promises";

/** A manifest carries every stage's brief verbatim, so it is the largest file read; only its stage identities are used. */
export const MANIFEST_READ_LIMIT = 4 * 1024 * 1024;

/** The beginning of a text file, or undefined when it does not exist / cannot be read. */
export async function readHead(file: string, limit: number): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
