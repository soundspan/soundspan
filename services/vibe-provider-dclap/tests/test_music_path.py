"""Behavioral tests for DCLAP music-library path containment."""

from __future__ import annotations

from pathlib import Path

import music_path
import pytest


@pytest.mark.parametrize(
    "track_ref",
    [
        "../outside.flac",
        "artist/../outside.flac",
        "artist/./track.flac",
        "/etc/passwd",
        "bad\x00.flac",
    ],
)
def test_resolve_music_path_rejects_unsafe_refs(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    track_ref: str,
) -> None:
    """Reject NUL, absolute, and explicit dot-segment paths."""
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))

    assert music_path.resolve_music_path(track_ref) is None


def test_resolve_music_path_rejects_symlink_escape(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Reject a relative path whose real target escapes the music root."""
    music_root = tmp_path / "music"
    outside_root = tmp_path / "outside"
    music_root.mkdir()
    outside_root.mkdir()
    (outside_root / "track.flac").touch()
    (music_root / "linked").symlink_to(outside_root, target_is_directory=True)
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(music_root))

    assert music_path.resolve_music_path("linked/track.flac") is None


def test_resolve_music_path_returns_real_in_library_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Return the canonical path for a safe relative library reference."""
    track = tmp_path / "artist" / "track.flac"
    track.parent.mkdir()
    track.touch()
    monkeypatch.setattr(music_path, "MUSIC_PATH", str(tmp_path))

    assert music_path.resolve_music_path("artist/track.flac") == str(track.resolve())
