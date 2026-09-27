# Widget overhaul

Status: planned. No stage may touch production without its own go-ahead.

## Principles

- Widget identity never changes.
- Names are display metadata, never identity.

---

## Stage 0 — Audit

Repos: app. Measure the widget population.

Acceptance: counts reproduce from a clean checkout.

## Stage 1A — App change

Repos: app. Emit reviewed widget records.

Acceptance: tests pass; no identity changes.

## Stage 1B — Web repair

Repos: web. Repair historical rows once the release is active.

Acceptance: idempotent; dry run matches the run.

## Release

Activate the release in production after Stage 1A, with explicit go-ahead.

## References

- docs/widgets.md
