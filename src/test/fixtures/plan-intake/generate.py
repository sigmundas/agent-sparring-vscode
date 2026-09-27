"""Regenerate the plan-intake fixtures from the engine itself.

Run from an agent-sparring engine checkout whose prepare-plan records the
display metadata (`findings`, `approval_requirements` in intake.json) --
feature/intake-display-metadata, or later:

    .venv/bin/python <this file> <output dir>

It drives the engine's own prepare-plan -> approve-plan -> run-plan path with
the engine test suite's scripted providers (no real provider, no network),
and copies what the engine wrote. Absolute paths are replaced by `__ROOT__`,
which the tests substitute with a temporary directory. Digests inside the
copied files then no longer match their paths; that is fine, because the
extension never re-checks a seal -- the engine does.

Two snapshots of the same intake (plan labels Stage 0 / 1A / 1B):

- `approved/`: slice `app` approved, nothing run yet.
- `ran/`: slice `app` run to completion by run-plan; slice `web` unapproved.
"""

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "tests"))

import test_intake_sealing as sealing  # noqa: E402


def copy(case: "sealing._Sealed", dest: Path) -> None:
    roots = {str(case.root), str(case.root.resolve())}
    for relative in (".sparring/intake", ".sparring/plans", "docs/plan.md"):
        source = case.repo / relative
        if not source.exists():
            continue
        files = [source] if source.is_file() else [p for p in source.rglob("*") if p.is_file()]
        # Briefs, the provider prompt and the source snapshot are not read by the extension.
        files = [f for f in files if "briefs" not in f.parts and f.name not in ("prompt.md", "source.md")]
        for file in files:
            target = dest / file.relative_to(case.repo)
            target.parent.mkdir(parents=True, exist_ok=True)
            text = file.read_text(encoding="utf-8")
            for root in sorted(roots, key=len, reverse=True):
                text = text.replace(root, "__ROOT__")
            target.write_text(text, encoding="utf-8")


class Generate(sealing._Sealed):
    def runTest(self):  # noqa: N802 - unittest protocol
        pass


def main(out: Path) -> None:
    case = Generate()
    case.setUp()
    try:
        _, approval = case.prepared_and_approved()
        copy(case, out / "approved")
        result, _ = case.run_app(approval)
        assert result.status is sealing.PlanRunStatus.COMPLETE, result.status
        copy(case, out / "ran")
    finally:
        case.tearDown()


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
