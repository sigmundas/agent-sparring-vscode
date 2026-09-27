# Plan intake: `docs/plan.md`

- Mode: **faithful**
- Verdict: **executable_with_recommendations**
- Source digest: `740e5f11746f2c5541efbe88b198ee5023fe1ac34f1e5e7ce63e42c6f32ec200` (36 lines; snapshot in `source.md`)
- Approval: no blocking findings

Two run slices separated by the production release.

## Findings

- **info** `stale_baseline_fact` [agent] (stages 0): counts should be recomputed

## Run slices

Each run slice becomes one manifest, run in its primary repository on one expected branch. Slices are approved and started separately, in order.

### Run slice `app` — primary `app`

- Expected branch: `feature/widgets` (checked out when intake inspected it)
- Run key: `app-run-0001`
- Gates a person confirms at approval: none
- Earlier run slices that must be approved and complete first: none
- Why this slice: app-only stages

| # | Label | Title | Mode | Siblings | Depends on | Source lines | Context | Brief |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | Audit | implementation | — | — | 12–16 | status, principles | `briefs/app/01-0.md` |
| 2 | 1A | App change | implementation | — | 0 | 18–22 | principles | `briefs/app/02-1a.md` |

### Run slice `web` — primary `web`

- Expected branch: `feature/web` (checked out when intake inspected it)
- Run key: `web-run-0002`
- Gates a person confirms at approval: `release`
- Earlier run slices that must be approved and complete first: `app`
- Why this slice: web-only, after the release

| # | Label | Title | Mode | Siblings | Depends on | Source lines | Context | Brief |
|---|---|---|---|---|---|---|---|---|
| 1 | 1B | Web repair | implementation | — | 1A | 24–28 | principles | `briefs/web/01-1b.md` |

- Stage 1B:
  - Intake scoping: Implementation and dry run only; the production run is gate `repair-run`.

## Gates and deferred actions

- `release` (production) — Production release activation. After: 1A; blocks: 1B; lines 30–32. 1B needs the active release

## Context blocks

- `status` — Status (lines 1–3); used by 0. authorization
- `principles` — Principles (lines 5–8); used by 0, 1A, 1B. invariants

## Excluded text

- lines 34–36: references

## Source coverage

18 substantive lines; all accounted for.

## Repositories inspected

Approval refuses if any of these has moved to another branch or commit, except to a commit an earlier run slice of this intake was accepted at.
- `app`: `__ROOT__/app` on `feature/widgets` at `2c2ea6ed9080`
- `web`: `__ROOT__/web` on `feature/web` at `130d797c307f`

## Proposed amendment

None.

## Next step

- From the `app` project: `sparring approve-plan __ROOT__/app/.sparring/intake/plan-61bf2008-20260927T204930Z-faithful-fb55 --run app`
- From the `web` project, once `app` completed (confirm each gate only once it is actually satisfied): `sparring approve-plan __ROOT__/app/.sparring/intake/plan-61bf2008-20260927T204930Z-faithful-fb55 --run web --confirm-prerequisite release`
