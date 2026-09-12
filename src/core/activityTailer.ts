/**
 * Incremental reader for one append-only `activity.jsonl`.
 *
 * - `poll()` reads only the bytes appended since the last poll.
 * - A trailing partial line (no newline yet) is buffered, not parsed, until
 *   the rest arrives; UTF-8 sequences split across polls are handled by a
 *   StringDecoder.
 * - Truncation, a smaller file, or a different inode (deleted and
 *   recreated) resets the reader to offset 0 and reports `reset: true`.
 * - A missing file is not an error: the reader idles at offset 0 until the
 *   file appears (again).
 *
 * No dependency on the vscode API; the caller decides when to poll
 * (filesystem watcher, timer, or both).
 */

import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { parseActivityLine, type ActivityEvent } from "./engineFormats";

export interface TailResult {
  events: ActivityEvent[];
  /** True when the file vanished or was truncated/recreated since the last poll. */
  reset: boolean;
  /** True when the file currently exists. */
  exists: boolean;
  /** Number of non-blank lines that were not valid events. */
  malformed: number;
}

const READ_CHUNK = 64 * 1024;

export class ActivityTailer {
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  private inode: bigint | undefined;
  private seenExists = false;

  constructor(public readonly path: string) {}

  /** Forget everything; the next poll re-reads the file from the start. */
  reset(): void {
    this.offset = 0;
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
    this.inode = undefined;
    this.seenExists = false;
  }

  async poll(): Promise<TailResult> {
    let stat;
    try {
      stat = await fs.stat(this.path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const hadData = this.seenExists;
        this.reset();
        return { events: [], reset: hadData, exists: false, malformed: 0 };
      }
      throw error;
    }

    let reset = false;
    const size = Number(stat.size);
    const recreated = this.inode !== undefined && stat.ino !== this.inode;
    if (recreated || size < this.offset) {
      this.reset();
      reset = true;
    }
    this.inode = stat.ino;
    this.seenExists = true;

    if (size === this.offset) {
      return { events: [], reset, exists: true, malformed: 0 };
    }

    const handle = await fs.open(this.path, "r");
    let text = "";
    try {
      const buffer = Buffer.alloc(READ_CHUNK);
      while (this.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK, size - this.offset), this.offset);
        if (bytesRead === 0) {
          break;
        }
        this.offset += bytesRead;
        text += this.decoder.write(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }

    const combined = this.partial + text;
    const lines = combined.split("\n");
    this.partial = lines.pop() ?? "";

    const events: ActivityEvent[] = [];
    let malformed = 0;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const event = parseActivityLine(line);
      if (event) {
        events.push(event);
      } else {
        malformed++;
      }
    }
    return { events, reset, exists: true, malformed };
  }
}
