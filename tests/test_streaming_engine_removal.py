"""Regression tests for the retired DASH streaming runtime surface."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ENTRYPOINT = REPO_ROOT / "frontend/docker-entrypoint.sh"
DOCKERFILE = REPO_ROOT / "Dockerfile"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
ENGINE_ASSIGNMENT = 'ENGINE_MODE="${STREAMING_ENGINE_MODE:-}"'
SHELL_SURFACES = ("frontend", "aio")


def _heredoc(dockerfile: str, target: str) -> str:
    """Return the body of a single-quoted Dockerfile heredoc for target."""
    marker = f"RUN cat > {target} << 'EOF'\n"
    start = dockerfile.index(marker) + len(marker)
    end = dockerfile.index("\nEOF", start)
    return dockerfile[start:end]


def _runtime_config_block(script: str, end_marker: str) -> str:
    """Return the executable runtime-configuration section."""
    start = script.index(ENGINE_ASSIGNMENT)
    end = script.index(end_marker, start)
    return script[start:end]


def _entrypoint_config(surface: str) -> str:
    """Return one real entrypoint's executable runtime configuration."""
    if surface == "frontend":
        script = FRONTEND_ENTRYPOINT.read_text(encoding="utf-8")
        return _runtime_config_block(script, "# Execute the main command")
    if surface == "aio":
        dockerfile = DOCKERFILE.read_text(encoding="utf-8")
        script = _heredoc(dockerfile, "/app/start.sh")
        return _runtime_config_block(script, 'echo "Starting soundspan..."')
    raise ValueError(f"Unknown shell surface: {surface}")


def _run_runtime_config(
    surface: str,
    engine_mode: str,
    extra_environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Execute one real runtime-configuration section in Bash."""
    environment = {
        **os.environ,
        "STREAMING_ENGINE_MODE": engine_mode,
        **(extra_environment or {}),
    }
    script = _entrypoint_config(surface)
    probe = f'{script}\nprintf \'__EFFECTIVE_MODE__=%s\\n\' "$STREAMING_ENGINE_MODE"\n'
    return subprocess.run(
        ["bash", "-c", probe],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )


@pytest.mark.parametrize("surface", SHELL_SURFACES)
@pytest.mark.parametrize(
    ("engine_mode", "effective_mode", "warns"),
    (
        pytest.param("videojs", "", True, id="removed-videojs"),
        pytest.param("tauri-native", "", True, id="removed-tauri-native"),
        pytest.param("howler", "howler", False, id="supported-howler"),
        pytest.param("native", "native", False, id="supported-native"),
    ),
)
def test_entrypoints_normalize_engine_modes(
    surface: str, engine_mode: str, effective_mode: str, warns: bool
) -> None:
    """Runtime selectors must reject removed modes and preserve supported modes."""
    result = _run_runtime_config(surface, engine_mode)

    assert result.returncode == 0, result.stderr
    assert f"__EFFECTIVE_MODE__={effective_mode}\n" in result.stdout
    warning = f"Invalid STREAMING_ENGINE_MODE '{engine_mode}'"
    assert (warning in result.stdout) is warns
    if warns:
        assert "native (primary default)" in result.stdout


@pytest.mark.parametrize("surface", SHELL_SURFACES)
@pytest.mark.parametrize(
    ("variable_name", "value"),
    (
        ("SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS", "1"),
        ("SEGMENTED_SESSION_PREWARM_ENABLED", "invalid"),
        ("LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED", "invalid"),
        ("SEGMENTED_STREAMING_TRACE_LOGS", "true"),
    ),
)
def test_entrypoints_ignore_removed_runtime_settings(
    surface: str, variable_name: str, value: str
) -> None:
    """Removed segmented settings must not affect shell runtime configuration."""
    result = _run_runtime_config(surface, "native", {variable_name: value})

    assert result.returncode == 0, result.stderr
    assert "__EFFECTIVE_MODE__=native\n" in result.stdout
    assert variable_name not in result.stdout
    assert result.stderr == ""


def test_unreleased_changelog_announces_streaming_removal() -> None:
    """The Unreleased changelog must announce the removed runtime surface."""
    changelog = CHANGELOG.read_text(encoding="utf-8")
    unreleased_start = changelog.index("## [Unreleased]")
    next_release = changelog.index("\n## [", unreleased_start + 1)
    unreleased = changelog[unreleased_start:next_release].lower()

    assert "### removed" in unreleased
    assert "segmented/dash streaming" in unreleased
    assert "soundspan_transcode_cache_requests_total" in unreleased
