/**
 * The engine's own answers for src/test/manifestVectors.ts. **Generated** —
 * do not edit by hand; run scripts/generate-manifest-pins.js against a live
 * engine instead, and review the diff.
 *
 * Engine: agent-sparring c42c7ec
 * Interpreter: 3.14.3
 */

import type { ManifestVectorResult } from "./manifestVectors";

export const MANIFEST_PARITY_PINS: ManifestVectorResult[] = [
  {
    "name": "baseline",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "title-ascii-space",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "title-newlines-and-tabs",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "title-u0085",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "title-u00a0",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "title-ufeff",
    "accepted": true,
    "digest": "8461bb01b997a200aaf2a70d31698ab6ea6192d02b20a99c330600080ed55080"
  },
  {
    "name": "title-u001c-separators",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "title-only-u0085",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 field 'title' must be a non-empty string"
  },
  {
    "name": "title-only-ufeff",
    "accepted": true,
    "digest": "3391bca2ab1667771a88118ee632fa92279b63f2de6fa899c3e6ae6bfa527362"
  },
  {
    "name": "plan-label-u0085",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "source-digest-ufeff",
    "accepted": true,
    "digest": "a1067bcf0bc5ba13b912f8e10b75235fdedfc075b2e234abd0fa560dacb17b99"
  },
  {
    "name": "stage-id-ufeff",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: invalid stage id 'stage-1-contract\\ufeff': must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
  },
  {
    "name": "stage-id-u0085",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "brief-verbatim-whitespace",
    "accepted": true,
    "digest": "46b731f32b1749685b87fc1877f9613863962f537cc39707ce935c2083224f76"
  },
  {
    "name": "brief-only-u0085",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 (stage-1-contract) must carry a non-empty 'brief'; a stage with nothing to implement from is not executable"
  },
  {
    "name": "brief-only-ufeff",
    "accepted": true,
    "digest": "f09ca6c09dade537b5b305653102ae3edb3255511a56a9c6f465c2f736089b59"
  },
  {
    "name": "non-ascii",
    "accepted": true,
    "digest": "85d932bcb18935e18bd2e8f9aae9b5100f511cf0b67d3e3c9f1c65c76489edb0"
  },
  {
    "name": "astral-pair",
    "accepted": true,
    "digest": "3fd8858d439de68d535b08739560bb4b7a5f4369c6e456c7ed17bd71c105cee0"
  },
  {
    "name": "lone-high-surrogate",
    "accepted": true,
    "error": "UnicodeEncodeError: 'utf-8' codec can't encode character '\\ud800' in position 9: surrogates not allowed"
  },
  {
    "name": "lone-low-surrogate-in-brief",
    "accepted": true,
    "error": "UnicodeEncodeError: 'utf-8' codec can't encode character '\\udc00' in position 3: surrogates not allowed"
  },
  {
    "name": "version-true",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "version-false",
    "accepted": false,
    "error": "ManifestError: unsupported manifest version False; this engine reads version 1"
  },
  {
    "name": "version-float-one",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "version-string-one",
    "accepted": false,
    "error": "ManifestError: unsupported manifest version '1'; this engine reads version 1"
  },
  {
    "name": "version-zero",
    "accepted": false,
    "error": "ManifestError: unsupported manifest version 0; this engine reads version 1"
  },
  {
    "name": "version-two",
    "accepted": false,
    "error": "ManifestError: unsupported manifest version 2; this engine reads version 1"
  },
  {
    "name": "version-null",
    "accepted": false,
    "error": "ManifestError: unsupported manifest version None; this engine reads version 1"
  },
  {
    "name": "version-absent",
    "accepted": false,
    "error": "ManifestError: unsupported manifest version None; this engine reads version 1"
  },
  {
    "name": "mode-absent",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "mode-null",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "mode-explicit-implementation",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "mode-independent-review",
    "accepted": true,
    "digest": "6c5cdfb8da4772e6aa3c4e7d140daf2961c9df7a83ec31d2e45373eb19ff1fb2"
  },
  {
    "name": "mode-padded",
    "accepted": true,
    "digest": "6c5cdfb8da4772e6aa3c4e7d140daf2961c9df7a83ec31d2e45373eb19ff1fb2"
  },
  {
    "name": "mode-u0085-padded",
    "accepted": true,
    "digest": "6c5cdfb8da4772e6aa3c4e7d140daf2961c9df7a83ec31d2e45373eb19ff1fb2"
  },
  {
    "name": "mode-unknown",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 (stage-1-contract): unknown stage mode 'review'; expected one of: implementation, independent_review"
  },
  {
    "name": "mode-not-a-string",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 (stage-1-contract): 'mode' must be a string or null, got 1"
  },
  {
    "name": "repositories-one",
    "accepted": true,
    "digest": "e305fa2deaf34f9bacdd549438d4525cb5246a0b157e42b7acf107f8ce9a03fd"
  },
  {
    "name": "repositories-sha-empty-string",
    "accepted": true,
    "digest": "e305fa2deaf34f9bacdd549438d4525cb5246a0b157e42b7acf107f8ce9a03fd"
  },
  {
    "name": "repositories-sha-absent",
    "accepted": true,
    "digest": "e305fa2deaf34f9bacdd549438d4525cb5246a0b157e42b7acf107f8ce9a03fd"
  },
  {
    "name": "repositories-verbatim-padding",
    "accepted": true,
    "digest": "fb81e944acd44bd7c3d764c5862eea8fe256628370449199b052d6976e0aa85d"
  },
  {
    "name": "repositories-name-only-ufeff",
    "accepted": true,
    "digest": "8acf0bd705711b29be00836d981212e9af89381d388cb97a5b724ae694b6635b"
  },
  {
    "name": "repositories-name-only-u0085",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: repository entry field 'name' must be a non-empty string"
  },
  {
    "name": "repositories-duplicate-names",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: repository names must be unique, got ['a', 'a']"
  },
  {
    "name": "repositories-order",
    "accepted": true,
    "digest": "687c4a7f2ff973b6599575c89e0a514a4b39135a37e5ef3edf9761eb8506a9cd"
  },
  {
    "name": "repositories-null",
    "accepted": true,
    "digest": "5c8f282a473eb91f97908110caef7941ce40255500c348b07a1d06a39ac131b2"
  },
  {
    "name": "repositories-not-an-array",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: 'repositories' must be an array or null"
  },
  {
    "name": "repositories-sha-number",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: repository entry field 'candidate_sha' must be a string or null"
  },
  {
    "name": "unknown-top-level-key",
    "accepted": false,
    "error": "ManifestError: manifest carries unknown field(s) ['extra']; refusing to half-read a manifest written against a different contract"
  },
  {
    "name": "unknown-stage-key",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 carries unknown field(s) ['extra']; refusing to half-read a manifest written against a different contract"
  },
  {
    "name": "unknown-repository-key",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 repository carries unknown field(s) ['extra']; refusing to half-read a manifest written against a different contract"
  },
  {
    "name": "stages-empty",
    "accepted": false,
    "error": "ManifestError: a manifest must declare a non-empty 'stages' array"
  },
  {
    "name": "stages-not-an-array",
    "accepted": false,
    "error": "ManifestError: a manifest must declare a non-empty 'stages' array"
  },
  {
    "name": "not-an-object",
    "accepted": false,
    "error": "ManifestError: a manifest must be a JSON object"
  },
  {
    "name": "not-json",
    "accepted": false,
    "error": "ManifestError: manifest is not valid JSON: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"
  },
  {
    "name": "stage-order",
    "accepted": true,
    "digest": "d5ce9f14f597dae956c62641c985400020bb1b7de36959e4c7ddd7ae2e9b4f46"
  },
  {
    "name": "duplicate-stage-ids",
    "accepted": false,
    "error": "ManifestError: manifest stage ids must be unique; repeated: ['stage-1-contract']"
  },
  {
    "name": "stage-id-with-slash",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: invalid stage id 'a/b': must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
  },
  {
    "name": "stage-id-dotdot",
    "accepted": false,
    "error": "ManifestError: manifest stage 1: invalid stage id '..': must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
  },
  {
    "name": "label-empty",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 field 'label' must be a non-empty string"
  },
  {
    "name": "brief-missing",
    "accepted": false,
    "error": "ManifestError: manifest stage 1 (stage-1-contract) must carry a non-empty 'brief'; a stage with nothing to implement from is not executable"
  }
];
