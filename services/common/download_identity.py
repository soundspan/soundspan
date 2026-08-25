"""Shared bounded filename and embedded-identity collision handling."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from .download_paths import require_contained_download_path

MAX_FILENAME_BYTES = 255
MAX_COLLISION_COUNTER = 5

Identity = TypeVar("Identity", str, int)


def build_bounded_filename(stem: str, suffix: str, extension: str) -> str:
    """Build one UTF-8 filename component within the common byte limit."""
    reserved_bytes = len(f"{suffix}{extension}".encode())
    stem_budget = MAX_FILENAME_BYTES - reserved_bytes
    if stem_budget < 1:
        raise ValueError("Download filename suffix exceeds the 255-byte component limit")
    bounded_stem = stem.encode()[:stem_budget].decode(errors="ignore")
    if not bounded_stem:
        raise ValueError("Download filename has no stem within the 255-byte component limit")
    return f"{bounded_stem}{suffix}{extension}"


def build_identity_candidates(planned_path: Path, identity_token: str) -> tuple[Path, ...]:
    """Build the planned path and five byte-bounded identity alternatives."""
    candidates = [planned_path]
    for counter in range(1, MAX_COLLISION_COUNTER + 1):
        identity_suffix = (
            f" [{identity_token}]" if counter == 1 else f" [{identity_token}-{counter}]"
        )
        candidate_name = build_bounded_filename(
            planned_path.stem,
            identity_suffix,
            planned_path.suffix,
        )
        candidates.append(planned_path.with_name(candidate_name))
    return tuple(candidates)


def resolve_identity_path(
    planned_path: Path,
    destination_root: Path,
    identity_token: str,
    expected_identity: Identity,
    read_embedded_id: Callable[[Path], Identity | None],
) -> Path:
    """Reuse an identity match or return the first safe free candidate."""
    candidates = build_identity_candidates(planned_path, identity_token)
    first_free: Path | None = None
    for index, candidate in enumerate(candidates):
        contained = require_contained_download_path(candidate, destination_root)
        if not contained.exists():
            if first_free is None:
                first_free = contained
            continue
        if not contained.is_file():
            continue
        embedded_id = read_embedded_id(contained)
        if embedded_id == expected_identity:
            return contained
        if embedded_id is None and index == 0:
            return contained
    if first_free is not None:
        return first_free
    raise RuntimeError(
        f"No safe download path for identity {expected_identity}; all {len(candidates)} "
        "candidates are occupied by other or unidentified files"
    )
