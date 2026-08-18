"""Embedding-space identity tests for the DCLAP provider."""

from __future__ import annotations

import hashlib
import importlib

import pytest
import settings


def test_checkpoint_hash_combines_all_pinned_model_artifacts() -> None:
    """Derive the published space identity from audio, weights, and text artifacts."""
    components = (
        settings.DCLAP_AUDIO_SHELL_HASH,
        settings.DCLAP_WEIGHTS_HASH,
        settings.DCLAP_TEXT_TOWER_HASH,
    )
    derived = hashlib.sha256(":".join(components).encode()).hexdigest()

    assert derived == settings.EMBEDDING_CHECKPOINT_HASH


def test_max_audio_seconds_defaults_to_thirty_minutes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Use a safe decode cap when no deployment override is present."""
    with monkeypatch.context() as env:
        env.delenv("DCLAP_MAX_AUDIO_SECONDS", raising=False)
        reloaded = importlib.reload(settings)

        assert reloaded.MAX_AUDIO_SECONDS == 1800
    importlib.reload(settings)


def test_max_audio_seconds_respects_valid_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Use a deployment override inside the supported range."""
    with monkeypatch.context() as env:
        env.setenv("DCLAP_MAX_AUDIO_SECONDS", "600")
        reloaded = importlib.reload(settings)

        assert reloaded.MAX_AUDIO_SECONDS == 600
    importlib.reload(settings)


@pytest.mark.parametrize(
    ("configured", "expected"),
    [("59", 60), ("7201", 7200), ("not-an-integer", 1800)],
)
def test_max_audio_seconds_falls_back_within_supported_bounds(
    monkeypatch: pytest.MonkeyPatch,
    configured: str,
    expected: int,
) -> None:
    """Clamp numeric limits and recover to the default from malformed input."""
    with monkeypatch.context() as env:
        env.setenv("DCLAP_MAX_AUDIO_SECONDS", configured)
        reloaded = importlib.reload(settings)

        assert expected == reloaded.MAX_AUDIO_SECONDS
    importlib.reload(settings)
