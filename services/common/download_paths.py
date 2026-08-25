"""Shared sanitization and containment for sidecar download paths."""

from __future__ import annotations

from pathlib import Path


def sanitize_path_component(name: str) -> str:
    """Replace filesystem-reserved characters and trim unsafe suffixes."""
    for character in '<>:"/\\|?*':
        name = name.replace(character, "_")
    return name.strip(". ")


def sanitize_download_relative_path(rendered_path: str) -> Path:
    """Validate and sanitize every component of a relative download path."""
    sanitized_parts: list[str] = []
    for component in rendered_path.split("/"):
        sanitized = sanitize_path_component(component)
        if not sanitized or sanitized in {".", ".."} or Path(sanitized).is_absolute():
            raise ValueError("Invalid output template path component")
        sanitized_parts.append(sanitized)
    return Path(*sanitized_parts)


def require_contained_download_path(path: Path, destination_root: Path) -> Path:
    """Resolve a path and reject targets outside the resolved destination root."""
    resolved_path = path.resolve()
    try:
        resolved_path.relative_to(destination_root.resolve())
    except ValueError:
        raise ValueError("Download path resolves outside MUSIC_PATH") from None
    return resolved_path
