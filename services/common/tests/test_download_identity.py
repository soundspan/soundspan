"""Behavioral coverage for shared sidecar download identity allocation."""

from pathlib import Path

import pytest
from common.download_identity import (
    MAX_COLLISION_COUNTER,
    MAX_FILENAME_BYTES,
    build_bounded_filename,
    build_identity_candidates,
    resolve_identity_path,
)


def test_bounded_filename_preserves_suffix_and_valid_utf8() -> None:
    """Truncate a multibyte stem without splitting its final code point."""
    filename = build_bounded_filename("é" * 130, " [identity-5]", ".flac")

    assert len(filename.encode()) <= MAX_FILENAME_BYTES
    assert filename.endswith(" [identity-5].flac")
    assert filename.encode().decode() == filename


@pytest.mark.parametrize(
    ("stem", "suffix", "extension", "message"),
    [
        ("track", "x" * 255, ".flac", "suffix exceeds"),
        ("é", "x" * 250, ".m4a", "no stem"),
    ],
)
def test_bounded_filename_rejects_names_without_a_stem_budget(
    stem: str,
    suffix: str,
    extension: str,
    message: str,
) -> None:
    """Reject reserved components that leave no complete stem character."""
    with pytest.raises(ValueError, match=message):
        build_bounded_filename(stem, suffix, extension)


def test_identity_candidates_use_one_bounded_sequence(tmp_path: Path) -> None:
    """Build the planned path followed by the five numbered alternatives."""
    planned = tmp_path / "Track.flac"

    candidates = build_identity_candidates(planned, "tidal-8")

    assert candidates == (
        planned,
        tmp_path / "Track [tidal-8].flac",
        tmp_path / "Track [tidal-8-2].flac",
        tmp_path / "Track [tidal-8-3].flac",
        tmp_path / "Track [tidal-8-4].flac",
        tmp_path / "Track [tidal-8-5].flac",
    )
    assert len(candidates) == MAX_COLLISION_COUNTER + 1


def test_resolver_prefers_matching_identity_after_an_earlier_free_path(
    tmp_path: Path,
) -> None:
    """Scan beyond the first gap so a prior identity-owned file is reused."""
    planned = tmp_path / "Track.flac"
    matching = tmp_path / "Track [video-2].flac"
    matching.write_bytes(b"existing")

    resolved = resolve_identity_path(
        planned,
        tmp_path,
        "video-2",
        "video-2",
        lambda path: "video-2" if path == matching else None,
    )

    assert resolved == matching


def test_resolver_ignores_directories_and_returns_first_free_file_path(
    tmp_path: Path,
) -> None:
    """Never treat an occupied directory as a reusable legacy audio file."""
    planned = tmp_path / "Track.flac"
    planned.mkdir()
    reader_calls: list[Path] = []

    resolved = resolve_identity_path(
        planned,
        tmp_path,
        "tidal-8",
        8,
        lambda path: reader_calls.append(path),
    )

    assert resolved == tmp_path / "Track [tidal-8].flac"
    assert reader_calls == []


def test_resolver_returns_planned_unidentified_legacy_file(tmp_path: Path) -> None:
    """Preserve the established planned-path compatibility rule."""
    planned = tmp_path / "Track.flac"
    planned.write_bytes(b"legacy")

    resolved = resolve_identity_path(
        planned,
        tmp_path,
        "tidal-8",
        8,
        lambda _path: None,
    )

    assert resolved == planned


def test_resolver_raises_when_every_candidate_is_taken(tmp_path: Path) -> None:
    """Fail closed after the complete bounded candidate sequence is occupied."""
    planned = tmp_path / "Track.flac"
    candidates = build_identity_candidates(planned, "tidal-8")
    for candidate in candidates:
        candidate.write_bytes(b"foreign")

    with pytest.raises(RuntimeError, match=r"identity 8.*6 candidates"):
        resolve_identity_path(
            planned,
            tmp_path,
            "tidal-8",
            8,
            lambda _path: 999,
        )
