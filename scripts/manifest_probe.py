#!/usr/bin/env python3
"""Probe the real engine's manifest contract, for differential testing.

The extension recomputes `agent_sparring.manifest.parse_manifest` and
`manifest_digest` in TypeScript (src/core/manifest.ts), because the digest it
produces is compared against the `plan_digest` the engine recorded for a run.
A divergence is not cosmetic: it either refuses a run's real manifest — so the
run loses its stage list, its journey and its historical membership — or
accepts one the engine never ran.

"Looks equivalent" is not a test of that, so this script makes the engine
itself answer. It reads a JSON array of vectors on stdin:

    [{"name": "...", "json": "<the manifest file's exact text>"}, ...]

and writes one result per vector to stdout:

    [{"name": "...", "accepted": true,  "digest": "<hex>"},
     {"name": "...", "accepted": false, "error": "ManifestError: ..."}, ...]

`accepted` is whether `parse_manifest` returned, and `digest` is present only
when `manifest_digest` also returned — the two are separate outcomes, because
the engine accepts values it then cannot digest (an unpaired surrogate raises
in `str.encode("utf-8")`), and the extension must not hand such a manifest an
authoritative digest.

Run it through the engine's own interpreter, with the engine importable:

    PYTHONPATH=<agent-sparring>/src python3 scripts/manifest_probe.py

The TypeScript side of the comparison, the vectors and the pinned expected
results live in src/test/manifestParity.test.ts.
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    try:
        from agent_sparring.manifest import manifest_digest, parse_manifest
    except ImportError as exc:  # pragma: no cover - reported to the caller
        json.dump({"error": f"the engine could not be imported: {exc}"}, sys.stdout)
        return 2

    vectors = json.load(sys.stdin)
    results = []
    for vector in vectors:
        name = vector["name"]
        try:
            parsed = parse_manifest(vector["json"])
        except Exception as exc:  # noqa: BLE001 - every refusal is a result
            results.append({"name": name, "accepted": False, "error": f"{type(exc).__name__}: {exc}"})
            continue
        try:
            digest = manifest_digest(parsed)
        except Exception as exc:  # noqa: BLE001 - accepted but not digestible
            results.append(
                {"name": name, "accepted": True, "error": f"{type(exc).__name__}: {exc}"}
            )
            continue
        results.append({"name": name, "accepted": True, "digest": digest})
    json.dump(results, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
