"""Contain queued audio paths beneath the configured music library."""

from __future__ import annotations

from services.common.music_path import resolve_contained_music_path


def resolve_music_path(music_path: str, file_path: str) -> str | None:
    """Resolve one relative queue path beneath the configured music library."""
    return resolve_contained_music_path(music_path, file_path)
