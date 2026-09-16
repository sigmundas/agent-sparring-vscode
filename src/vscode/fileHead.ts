/**
 * Bounded reads of the beginning of a file, shared by the surfaces that
 * display recorded artifacts. Every read is capped: the Overview and the run
 * picker render on a timer, and a stage's own files are written by the engine
 * and can be arbitrarily large.
 */

import * as fs from "node:fs/promises";

/** A manifest carries every stage's brief verbatim, so it is the largest file read; only its stage identities are used. */
export const MANIFEST_READ_LIMIT = 4 * 1024 * 1024;

/**
 * One file's parsed content, remembered against the identity of the bytes it
 * came from.
 *
 * Deliberately only the parse. Whether that content *means* anything for a
 * particular run is a conclusion about two things — the file and the run's
 * recorded state — and a cache keyed on the file alone cannot express it, so
 * caching such a conclusion here would let a stale one outlive the state that
 * justified it. Callers cache the bytes and re-derive the meaning.
 */
export interface CachedFile<T> {
  mtimeMs: number;
  size: number;
  parsed: T | undefined;
}

/**
 * Parse a file through `parse`, reusing the previous parse while the file's
 * size and modification time are unchanged. A file that has gone away drops
 * out of the cache and yields undefined.
 */
export async function readCached<T>(cache: Map<string, CachedFile<T>>, file: string, parse: (text: string | undefined) => T | undefined, limit = MANIFEST_READ_LIMIT): Promise<T | undefined> {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = await fs.stat(file);
  } catch {
    cache.delete(file);
    return undefined;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.parsed;
  }
  const parsed = parse(await readHead(file, limit));
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return parsed;
}

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
