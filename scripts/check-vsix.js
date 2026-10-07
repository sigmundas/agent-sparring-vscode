#!/usr/bin/env node
// Verifies the VSIX contains exactly the distributable files: no plans,
// workflow state, agent instructions, source maps or local install script.
//
//   node scripts/check-vsix.js              # checks `vsce ls --no-dependencies`
//   node scripts/check-vsix.js <file.vsix>  # also checks the built archive
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const EXPECTED = [
  'LICENSE',
  'README.md',
  'dist/extension.js',
  'docs/Screenshot 2026-10-07 at 13.09.32.png',
  'docs/README.md',
  'docs/setup.md',
  'docs/commands.md',
  'docs/configuration.md',
  'docs/workflows.md',
  'docs/runs.md',
  'docs/state.md',
  'docs/runners.md',
  'docs/development.md',
  'icons/icon.png',
  'package.json',
].sort();

// vsce adds these packaging metadata entries outside extension/.
const ARCHIVE_METADATA = ['[Content_Types].xml', 'extension.vsixmanifest'];

// vsce renames these source files inside the archive.
const ARCHIVE_NAMES = { 'readme.md': 'README.md', 'LICENSE.txt': 'LICENSE' };

const root = path.resolve(__dirname, '..');

function compare(label, actual) {
  const sorted = [...new Set(actual)].sort();
  const missing = EXPECTED.filter((f) => !sorted.includes(f));
  const extra = sorted.filter((f) => !EXPECTED.includes(f));
  if (missing.length || extra.length) {
    console.error(`${label}: file set differs from the distribution allowlist`);
    for (const f of missing) console.error(`  missing: ${f}`);
    for (const f of extra) console.error(`  unexpected: ${f}`);
    return false;
  }
  console.log(`${label}: ${sorted.join(', ')}`);
  return true;
}

const listed = execFileSync(
  path.join(root, 'node_modules', '.bin', 'vsce'),
  ['ls', '--no-dependencies'],
  { cwd: root, encoding: 'utf8' },
).split('\n').map((l) => l.trim()).filter(Boolean);
let ok = compare('vsce ls', listed);

const vsix = process.argv[2];
if (vsix) {
  const entries = execFileSync('unzip', ['-Z1', path.resolve(vsix)], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.endsWith('/'));
  const outside = entries.filter((e) => !e.startsWith('extension/') && !ARCHIVE_METADATA.includes(e));
  for (const e of outside) console.error(`  unexpected archive entry: ${e}`);
  ok = compare('vsix', entries.filter((e) => e.startsWith('extension/')).map((e) => e.slice('extension/'.length))
    .map((e) => ARCHIVE_NAMES[e] ?? e)) && ok;
  ok = outside.length === 0 && ok;
}

process.exit(ok ? 0 : 1);
