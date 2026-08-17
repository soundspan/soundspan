"""Resolve provider track references inside the configured music library."""

from __future__ import annotations

import os

MUSIC_PATH = os.getenv("MUSIC_PATH", "/music")


def resolve_music_path(track_ref: str) -> str | None:
    """Resolve a relative track reference beneath the real music root."""
    if not isinstance(track_ref, str) or "\x00" in track_ref:
        return None

    normalized_path = track_ref.replace("\\", "/")
    if os.path.isabs(normalized_path):
        return None
    if any(segment in {".", ".."} for segment in normalized_path.split("/")):
        return None

    try:
        music_root = os.path.realpath(MUSIC_PATH)
        resolved_path = os.path.realpath(os.path.join(music_root, normalized_path))
        if os.path.commonpath((music_root, resolved_path)) != music_root:
            return None
    except (OSError, ValueError):
        return None
    return resolved_path
