"""Embedding-space identity tests for the DCLAP provider."""

from __future__ import annotations

import hashlib
import importlib
import logging

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


def test_max_audio_seconds_is_an_immutable_thirty_minute_contract() -> None:
    """Keep the undeclared de-facto preprocessing cap pinned to 1,800 seconds."""
    assert settings.MAX_AUDIO_SECONDS == 1800
    assert "maxAudioSeconds" not in settings.EMBEDDING_PREPROCESSING
    assert "max_audio_seconds" not in settings.EMBEDDING_PREPROCESSING


def test_max_audio_seconds_ignores_leftover_environment_override(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Ignore and warn about a leftover override without changing space behavior."""
    with monkeypatch.context() as env:
        env.setenv("DCLAP_MAX_AUDIO_SECONDS", "600")
        with caplog.at_level(logging.WARNING, logger="vibe-provider-dclap"):
            reloaded = importlib.reload(settings)

        assert reloaded.MAX_AUDIO_SECONDS == 1800
        assert "DCLAP_MAX_AUDIO_SECONDS is ignored" in caplog.text
    importlib.reload(settings)
