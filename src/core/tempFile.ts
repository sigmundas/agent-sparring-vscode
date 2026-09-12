/**
 * The one place the extension writes a file: a short-lived UTF-8 file in
 * the operating system's temporary directory, handed to the engine by path
 * (`sparring new-stage … --brief-file <path>`) and removed afterwards
 * whatever the outcome. Never a path under a workspace or `.sparring`:
 * everything authoritative is written by the engine.
 *
 * No dependency on the vscode API.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Write `content` to a fresh private directory under os.tmpdir(), run `use`
 * with the file's path, then remove the directory. The temporary path is
 * never derived from the caller's input; `filename` only names the file for
 * readability in the engine's output.
 */
export async function withTemporaryFile<T>(content: string, filename: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sparring-"));
  try {
    const file = path.join(dir, filename);
    await fs.writeFile(file, content, "utf8");
    return await use(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
