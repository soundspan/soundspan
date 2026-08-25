"""Resolve provider track references inside the configured music library."""

from __future__ import annotations

import os

from services.common.music_path import resolve_contained_music_path

MUSIC_PATH = os.getenv("MUSIC_PATH", "/music")


def resolve_music_path(track_ref: str) -> str | None:
    """Resolve a relative track reference beneath the real music root."""
    return resolve_contained_music_path(MUSIC_PATH, track_ref)
