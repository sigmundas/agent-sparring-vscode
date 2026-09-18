/**
 * Regenerate src/test/manifestParityPins.ts from a live engine.
 *
 *     npm run compile-tests
 *     AGENT_SPARRING_SRC=<agent-sparring>/src \
 *     PYTHON=<interpreter> \
 *     node scripts/generate-manifest-pins.js
 *
 * The pins are the engine's own answers for src/test/manifestVectors.ts, so
 * nothing in this repository encodes a hand-written belief about Python's
 * behaviour. Run this when the engine's manifest contract changes on purpose;
 * the resulting diff is the review of that change. `npm test` checks the
 * TypeScript reimplementation against the pins with no Python present, and
 * manifestParity.test.ts re-checks the pins against the engine whenever one is
 * importable — so drift on either side fails a test instead of going unnoticed.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { MANIFEST_VECTORS } = require("../out/test/manifestVectors.js");

const engineSrc = process.env.AGENT_SPARRING_SRC;
const python = process.env.PYTHON ?? "python3";
if (!engineSrc) {
  console.error("AGENT_SPARRING_SRC must point at the engine's src/ directory (the one containing agent_sparring/).");
  process.exit(2);
}

const probe = path.join(__dirname, "manifest_probe.py");
const input = JSON.stringify(MANIFEST_VECTORS.map((vector) => ({ name: vector.name, json: vector.json })));
const stdout = execFileSync(python, [probe], { input, env: { ...process.env, PYTHONPATH: engineSrc }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const results = JSON.parse(stdout);
if (!Array.isArray(results)) {
  console.error(`the probe did not return results: ${stdout}`);
  process.exit(2);
}

const version = execFileSync("git", ["-C", path.dirname(engineSrc), "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const header = `/**
 * The engine's own answers for src/test/manifestVectors.ts. **Generated** —
 * do not edit by hand; run scripts/generate-manifest-pins.js against a live
 * engine instead, and review the diff.
 *
 * Engine: agent-sparring ${version}
 * Interpreter: ${execFileSync(python, ["-c", "import sys; print(sys.version.split()[0])"], { encoding: "utf8" }).trim()}
 */

import type { ManifestVectorResult } from "./manifestVectors";

export const MANIFEST_PARITY_PINS: ManifestVectorResult[] = ${JSON.stringify(results, null, 2)};
`;

const out = path.join(__dirname, "..", "src", "test", "manifestParityPins.ts");
fs.writeFileSync(out, header, "utf8");
console.log(`wrote ${results.length} pins to ${path.relative(process.cwd(), out)}`);
