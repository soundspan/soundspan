"""Contain queued audio paths beneath the configured music library."""

from __future__ import annotations

import os


def resolve_music_path(music_path: str, file_path: str) -> str | None:
    """Resolve one relative queue path beneath the configured music library."""
    if not isinstance(file_path, str) or "\x00" in file_path:
        return None

    normalized_path = file_path.replace("\\", "/")
    if os.path.isabs(normalized_path):
        return None
    if any(segment in {".", ".."} for segment in normalized_path.split("/")):
        return None

    try:
        music_root = os.path.realpath(music_path)
        resolved_path = os.path.realpath(os.path.join(music_root, normalized_path))
        if os.path.commonpath((music_root, resolved_path)) != music_root:
            return None
    except (OSError, ValueError):
        return None
    return resolved_path
