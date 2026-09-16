/**
 * Reading a plan run's execution manifest out of global storage — and the one
 * place that decides it is *that run's*.
 *
 * The split this class exists to enforce: **the bytes may be cached, the
 * conclusion may not.**
 *
 * A manifest carries every stage's brief verbatim, so it is by far the largest
 * file the Overview reads, and the Overview, the run picker and plan
 * membership all want it on every render. Parsing it repeatedly is the cost
 * worth avoiding. But the earlier cache stored the *bound stage list*, keyed on
 * the manifest's path and modification time alone — and that made it an
 * authority of its own: a manifest accepted while the run's recorded state said
 * one thing went on being accepted after that state moved, without the file
 * being touched at all. The cache key did not contain the run, so it could not
 * express the thing it was caching.
 *
 * So each file's *parse* is cached against that file's own identity (size and
 * mtime), and the binding is re-derived from the caller's `RunSnapshot` on
 * every single call. It cuts both ways, which is the test of whether the fix is
 * real: a cached manifest that no longer binds is refused now, and a cached
 * manifest that did not bind is accepted as soon as the run's recorded state
 * makes it this run's — neither requiring the file to be rewritten.
 *
 * No dependency on the vscode API.
 */

import {
  bindParsedManifest,
  bindingPathFor,
  manifestExpectationFor,
  manifestPathFor,
  parseExecutionManifest,
  readBindingRecord,
  type ManifestBinding,
  type ManifestBindingRecord,
  type ManifestOwner,
  type ParsedManifest,
} from "../core/manifest";
import { readCached, type CachedFile } from "./fileHead";

/** What a caller must hold for the manifest of a run to be looked up and bound. */
export type ManifestRun = ManifestOwner & { state: { plan: string; currentStage: string; planDigest: string } };

export class ManifestReader {
  /** Parsed manifest bytes by file. Never a binding: see the module header. */
  private readonly manifests = new Map<string, CachedFile<ParsedManifest>>();
  /** The same for each manifest's sidecar binding record. */
  private readonly bindings = new Map<string, CachedFile<ManifestBindingRecord>>();

  /**
   * The manifest `directory` holds for `run`, bound to that run as it is
   * recorded *now*, or the reason it cannot be.
   */
  async read(directory: string, run: ManifestRun): Promise<ManifestBinding> {
    const parsed = await readCached(this.manifests, manifestPathFor(directory, run), (text) => parseExecutionManifest(text));
    const binding = await readCached(this.bindings, bindingPathFor(directory, run), (text) => readBindingRecord(text));
    return bindParsedManifest(parsed, binding, manifestExpectationFor(run));
  }
}
