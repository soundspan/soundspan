"""Regression tests for the segmented-streaming deprecation contract."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ENTRYPOINT = REPO_ROOT / "frontend/docker-entrypoint.sh"
DOCKERFILE = REPO_ROOT / "Dockerfile"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"


def _heredoc(dockerfile: str, target: str) -> str:
    """Return the body of a single-quoted Dockerfile heredoc for target."""
    marker = f"RUN cat > {target} << 'EOF'\n"
    start = dockerfile.index(marker) + len(marker)
    end = dockerfile.index("\nEOF", start)
    return dockerfile[start:end]


def _assert_videojs_deprecation_warning(script: str) -> None:
    """Assert that one warning line identifies videojs as deprecated."""
    warning_lines = (
        line.lower()
        for line in script.splitlines()
        if "warn" in line.lower()
    )

    assert any(
        "videojs" in line and "deprecated" in line for line in warning_lines
    )


def _assert_videojs_remains_accepted(script: str) -> None:
    """Assert that the engine-mode case still has an accepted videojs arm."""
    case_start = script.index('case "$ENGINE_MODE" in')
    case_end = script.index("\nesac", case_start)
    case_block = script[case_start:case_end]

    assert re.search(r"(?m)^\s*[^#\n]*[\"']?videojs[\"']?[^\n]*\)\s*$", case_block)


def test_frontend_entrypoint_warns_for_deprecated_videojs_mode() -> None:
    """The split frontend startup must warn when videojs is selected."""
    entrypoint = FRONTEND_ENTRYPOINT.read_text(encoding="utf-8")

    _assert_videojs_deprecation_warning(entrypoint)


def test_aio_entrypoint_warns_for_deprecated_videojs_mode() -> None:
    """The AIO startup must warn when videojs is selected."""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    _assert_videojs_deprecation_warning(start_script)


def test_videojs_remains_accepted_by_both_entrypoints() -> None:
    """Phase one must not remove videojs from either accepted-values arm."""
    entrypoint = FRONTEND_ENTRYPOINT.read_text(encoding="utf-8")
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    start_script = _heredoc(dockerfile, "/app/start.sh")

    _assert_videojs_remains_accepted(entrypoint)
    _assert_videojs_remains_accepted(start_script)


def test_unreleased_changelog_deprecates_videojs_mode() -> None:
    """The Unreleased changelog must announce the videojs deprecation."""
    changelog = CHANGELOG.read_text(encoding="utf-8")
    unreleased_start = changelog.index("## [Unreleased]")
    next_release = changelog.index("\n## [", unreleased_start + 1)
    unreleased = changelog[unreleased_start:next_release].lower()

    assert "streaming_engine_mode=videojs" in unreleased
    assert "deprecated" in unreleased
