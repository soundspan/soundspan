"""Shared music-library path containment for Python sidecars."""

from __future__ import annotations

import os


def resolve_contained_music_path(music_root: str, relative: str) -> str | None:
    """Resolve one relative path beneath a configured music-library root."""
    if not isinstance(relative, str) or "\x00" in relative:
        return None

    normalized_path = relative.replace("\\", "/")
    if os.path.isabs(normalized_path):
        return None
    if any(segment in {".", ".."} for segment in normalized_path.split("/")):
        return None

    try:
        resolved_root = os.path.realpath(music_root)
        resolved_path = os.path.realpath(os.path.join(resolved_root, normalized_path))
        if os.path.commonpath((resolved_root, resolved_path)) != resolved_root:
            return None
    except (OSError, ValueError):
        return None
    return resolved_path
