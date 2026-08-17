"""Embedding-space identity tests for the DCLAP provider."""

from __future__ import annotations

import hashlib

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
