"""Regression tests for the retired DASH streaming runtime surface."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ENTRYPOINT = REPO_ROOT / "frontend/docker-entrypoint.sh"
DOCKERFILE = REPO_ROOT / "Dockerfile"
COMPOSE_FILES = (
    REPO_ROOT / "docker-compose.yml",
    REPO_ROOT / "docker-compose.aio.yml",
)
DEPLOYMENT_FILES = (
    *COMPOSE_FILES,
    REPO_ROOT / ".env.example",
    REPO_ROOT / "charts/soundspan/values.yaml",
)
CHANGELOG = REPO_ROOT / "CHANGELOG.md"


def _heredoc(dockerfile: str, target: str) -> str:
    """Return the body of a single-quoted Dockerfile heredoc for target."""
    marker = f"RUN cat > {target} << 'EOF'\n"
    start = dockerfile.index(marker) + len(marker)
    end = dockerfile.index("\nEOF", start)
    return dockerfile[start:end]


def _engine_case(script: str) -> str:
    """Return the runtime engine-mode case block."""
    case_start = script.index('case "$ENGINE_MODE" in')
    case_end = script.index("\nesac", case_start)
    return script[case_start:case_end]


def _entrypoint_scripts() -> tuple[str, str]:
    """Return the split and AIO runtime entrypoint scripts."""
    frontend = FRONTEND_ENTRYPOINT.read_text(encoding="utf-8")
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    return frontend, _heredoc(dockerfile, "/app/start.sh")


def test_entrypoints_reject_removed_videojs_mode() -> None:
    """Neither runtime selector may retain an accepted videojs case arm."""
    accepted_arm = re.compile(
        r"(?m)^\s*[^#\n]*[\"']?videojs[\"']?[^\n]*\)\s*$"
    )

    for script in _entrypoint_scripts():
        assert accepted_arm.search(_engine_case(script)) is None


def test_entrypoints_accept_native_and_howler_modes() -> None:
    """Both supported playback engines must remain accepted."""
    for script in _entrypoint_scripts():
        engine_case = _engine_case(script)
        assert re.search(r'(?m)^\s*""\|"howler"\|"native"\)\s*$', engine_case)


def test_entrypoints_keep_invalid_value_fallback() -> None:
    """Unknown engine values must warn and clear the selector to native."""
    for script in _entrypoint_scripts():
        engine_case = _engine_case(script)
        fallback_start = engine_case.index("*)")
        fallback_end = engine_case.index(";;", fallback_start)
        fallback = engine_case[fallback_start:fallback_end].lower()

        assert "warn" in fallback
        assert 'engine_mode=""' in fallback
        assert "native|howler" in fallback


def test_removed_runtime_settings_are_absent_from_deployment_surfaces() -> None:
    """Retired runtime settings must be ignored by every deployment surface."""
    frontend, aio_start = _entrypoint_scripts()
    surfaces = {
        "frontend/docker-entrypoint.sh": frontend,
        "Dockerfile:/app/start.sh": aio_start,
        **{
            str(path.relative_to(REPO_ROOT)): path.read_text(encoding="utf-8")
            for path in DEPLOYMENT_FILES
        },
    }

    for name, content in surfaces.items():
        assert "SEGMENTED_" not in content, name


def test_unreleased_changelog_announces_streaming_removal() -> None:
    """The Unreleased changelog must announce the removed runtime surface."""
    changelog = CHANGELOG.read_text(encoding="utf-8")
    unreleased_start = changelog.index("## [Unreleased]")
    next_release = changelog.index("\n## [", unreleased_start + 1)
    unreleased = changelog[unreleased_start:next_release].lower()

    assert "### removed" in unreleased
    assert "segmented/dash streaming" in unreleased
    assert "soundspan_transcode_cache_requests_total" in unreleased
