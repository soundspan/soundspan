"""Behavioral coverage for TIDAL ALBUMARTIST metadata resolution."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


def test_album_primary_artist_wins_over_track_lead_artist() -> None:
    import tidal_downloads

    album = SimpleNamespace(artist=SimpleNamespace(name="Drake"), artists=[])
    track = SimpleNamespace(artists=[SimpleNamespace(name="Future")])

    assert tidal_downloads._resolve_album_artist(album, track) == "Drake"


def test_album_artists_fallback_is_used_without_primary_artist() -> None:
    import tidal_downloads

    album = SimpleNamespace(
        artist=None,
        artists=[SimpleNamespace(name="Drake")],
    )
    track = SimpleNamespace(artists=[SimpleNamespace(name="Future")])

    assert tidal_downloads._resolve_album_artist(album, track) == "Drake"


def test_track_lead_artist_is_used_without_album_artists() -> None:
    import tidal_downloads

    album = SimpleNamespace(artist=None, artists=[])
    track = SimpleNamespace(artists=[SimpleNamespace(name="Future")])

    assert tidal_downloads._resolve_album_artist(album, track) == "Future"


def test_empty_artist_shapes_resolve_to_empty_string() -> None:
    import tidal_downloads

    album = SimpleNamespace(artist=None, artists=[])
    track = SimpleNamespace(artists=[])

    assert tidal_downloads._resolve_album_artist(album, track) == ""


def test_missing_album_artist_attributes_fall_through_without_error() -> None:
    import tidal_downloads

    album = SimpleNamespace()
    track = SimpleNamespace(artists=[SimpleNamespace(name="Future")])

    assert tidal_downloads._resolve_album_artist(album, track) == "Future"


def test_metadata_embed_uses_album_artist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import tidal_downloads

    captured: dict[str, Any] = {}

    def capture_metadata(**metadata: Any) -> None:
        captured.update(metadata)

    monkeypatch.setattr(tidal_downloads, "add_track_metadata", capture_metadata)
    album = SimpleNamespace(
        artist=SimpleNamespace(name="Drake"),
        artists=[SimpleNamespace(name="Drake")],
        releaseDate=None,
    )
    track = SimpleNamespace(artists=[SimpleNamespace(name="Future")])

    tidal_downloads._embed_download_metadata(tmp_path / "D4L.flac", track, album, 9, None)

    assert captured["album_artist"] == "Drake"
