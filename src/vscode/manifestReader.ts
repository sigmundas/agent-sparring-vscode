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
 * ### Manifests written before binding records existed
 *
 * A manifest is only written when a run is started or resumed, and a
 * **completed** run is never resumed again. So a run that finished before
 * sidecars existed can never produce one, and requiring a sidecar took its
 * stage list, its journey and the membership of every stage it executed away
 * for good — with nothing a person could do about it, because the engine has
 * nothing left to run.
 *
 * Such a file is looked for at the names manifests were written under before
 * ({@link previousManifestFileNames}) and bound by
 * {@link bindLegacyManifest}, which proves everything the strict path proves
 * except the sidecar itself, and replaces that with "no other discovered run
 * could claim this file either". Nothing is written, so the repair is
 * idempotent, free of side effects, and cannot leave a derived file behind to
 * become an authority of its own. A file that *does* have a sidecar is bound
 * strictly, exactly as before: only its absence opens this path.
 *
 * No dependency on the vscode API.
 */

import {
  bindLegacyManifest,
  bindParsedManifest,
  bindingPathFor,
  manifestExpectationFor,
  manifestFileName,
  manifestPathFor,
  parseExecutionManifest,
  previousManifestFileNames,
  readBindingRecord,
  soleLegacyClaimant,
  type ManifestBinding,
  type ManifestBindingRecord,
  type ManifestExpectation,
  type ManifestOwner,
  type ParsedManifest,
} from "../core/manifest";
import * as path from "node:path";
import { readCached, type CachedFile } from "./fileHead";

/** What a caller must hold for the manifest of a run to be looked up and bound. */
export type ManifestRun = ManifestOwner & { state: { plan: string; currentStage: string; planDigest: string } };

/** A manifest accepted, with the file it came from and whether the strict path accepted it. */
export interface BoundManifest {
  binding: ManifestBinding;
  /** Base name of the file the answer came from, for the log and the diagnostic. */
  file: string;
  /**
   * True when the acceptance rests on the derived legacy proof rather than on
   * a sidecar. Reported rather than hidden: a person reading the log should be
   * able to see that a run's history is being attributed to a file that does
   * not say which worktree wrote it.
   */
  derived: boolean;
}

export class ManifestReader {
  /** Parsed manifest bytes by file. Never a binding: see the module header. */
  private readonly manifests = new Map<string, CachedFile<ParsedManifest>>();
  /** The same for each manifest's sidecar binding record. */
  private readonly bindings = new Map<string, CachedFile<ManifestBindingRecord>>();

  /**
   * The manifest `directory` holds for `run`, bound to that run as it is
   * recorded *now*, or the reason it cannot be.
   *
   * `peers` are the other plan runs this window has discovered. They are used
   * for one thing only — deciding whether a manifest written before sidecars
   * existed could belong to more than one of them — and never to attribute
   * anything positively.
   */
  async read(directory: string, run: ManifestRun, peers: readonly ManifestRun[] = []): Promise<ManifestBinding> {
    return (await this.readBound(directory, run, peers)).binding;
  }

  /** The same, with where the answer came from. */
  async readBound(directory: string, run: ManifestRun, peers: readonly ManifestRun[] = []): Promise<BoundManifest> {
    const expect = manifestExpectationFor(run);
    const current = manifestPathFor(directory, run);
    const parsed = await readCached(this.manifests, current, (text) => parseExecutionManifest(text));
    const binding = await readCached(this.bindings, bindingPathFor(directory, run), (text) => readBindingRecord(text));

    // A sidecar is present: the strict path is the only path. Nothing here
    // relaxes a check that can still be made.
    if (binding) {
      return { binding: bindParsedManifest(parsed, binding, expect), file: path.basename(current), derived: false };
    }

    const others = peers.filter((peer) => !sameOwner(peer, run)).map((peer) => manifestExpectationFor(peer));
    const attempts: { file: string; parsed: ParsedManifest | undefined }[] = [{ file: current, parsed }];
    for (const name of previousManifestFileNames(run.planKey, run.location.projectDir)) {
      attempts.push({ file: path.join(directory, name), parsed: await readCached(this.manifests, path.join(directory, name), (text) => parseExecutionManifest(text)) });
    }

    let best: BoundManifest | undefined;
    for (const attempt of attempts) {
      const file = path.basename(attempt.file);
      const bound = bindLegacyManifest(attempt.parsed, expect, { file, sole: soleLegacyClaimant(attempt.parsed, expect, others) });
      if (bound.ok) {
        return { binding: bound, file, derived: true };
      }
      // Report the most specific refusal, not "there is no file at the name we
      // looked at first": a plan-digest mismatch on the legacy file is the
      // useful thing to say, and an absent file is the least useful.
      if (!best || (best.binding.ok === false && best.binding.reason === "unreadable")) {
        best = { binding: bound, file, derived: false };
      }
    }
    return best ?? { binding: bindParsedManifest(parsed, binding, expect), file: manifestFileName(run.planKey, run.location.projectDir), derived: false };
  }
}

function sameOwner(a: ManifestRun, b: ManifestRun): boolean {
  return a.planKey === b.planKey && path.resolve(a.location.projectDir) === path.resolve(b.location.projectDir);
}

export type { ManifestExpectation };
