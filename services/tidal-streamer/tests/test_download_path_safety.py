"""Behavioral coverage for TIDAL download destination containment."""

from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient


class _FakeDownloadApi:
    """Provide the minimal provider behavior needed for a track download."""

    def get_track(self, track_id: int) -> Any:
        return types.SimpleNamespace(
            id=track_id,
            title="Track",
            album=types.SimpleNamespace(id=22),
            artists=[types.SimpleNamespace(name="Artist")],
        )

    def get_album(self, _album_id: int) -> Any:
        return types.SimpleNamespace(title="Album", cover=None, releaseDate=None)

    def get_track_stream(self, *, track_id: int, quality: str) -> Any:
        return types.SimpleNamespace(audioQuality=quality)


def _configure_download(
    monkeypatch: pytest.MonkeyPatch, app: Any, rendered_path: str, payload: bytes = b"audio"
) -> None:
    """Stub provider helpers while preserving real filesystem writes."""
    download_module = types.ModuleType("tiddl.core.utils.download")
    download_module.__dict__["download"] = lambda _urls: payload
    monkeypatch.setitem(sys.modules, "tiddl.core.utils.download", download_module)
    monkeypatch.setattr(app, "format_template", lambda **_kwargs: rendered_path)
    monkeypatch.setattr(app, "parse_track_stream", lambda _stream: (["url"], ".m4a"))
    monkeypatch.setattr(app, "add_track_metadata", lambda **_kwargs: None)


def test_download_rejects_absolute_rendered_template(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    outside_stem = tmp_path / "outside" / "track"
    _configure_download(monkeypatch, tidal_downloads, outside_stem.as_posix())

    with pytest.raises(ValueError, match="output template path"):
        tidal_downloads._download_track_sync(_FakeDownloadApi(), 1, "HIGH", "ignored", destination)

    assert not outside_stem.with_suffix(".m4a").exists()


def test_download_rejects_symlink_escape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    outside = tmp_path / "outside"
    destination.mkdir()
    outside.mkdir()
    (destination / "linked").symlink_to(outside, target_is_directory=True)
    _configure_download(monkeypatch, tidal_downloads, "linked/track")

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        tidal_downloads._download_track_sync(_FakeDownloadApi(), 1, "HIGH", "ignored", destination)

    assert not (outside / "track.m4a").exists()


def test_download_rejects_temporary_file_symlink_escape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    target_parent = destination / "Artist" / "Album"
    outside_file = tmp_path / "outside.m4a.tmp"
    target_parent.mkdir(parents=True)
    outside_file.write_bytes(b"unchanged")
    (target_parent / "01. Track.m4a.tmp").symlink_to(outside_file)
    _configure_download(monkeypatch, tidal_downloads, "Artist/Album/01. Track", b"replacement")

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        tidal_downloads._download_track_sync(_FakeDownloadApi(), 1, "HIGH", "ignored", destination)

    assert outside_file.read_bytes() == b"unchanged"


def test_download_writes_valid_rendered_template_beneath_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    _configure_download(monkeypatch, tidal_downloads, "Artist/Album/01. Track")

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 1, "HIGH", "ignored", destination
    )

    expected = destination / "Artist" / "Album" / "01. Track.m4a"
    assert expected.read_bytes() == b"audio"
    assert Path(result["file_path"]) == expected
    assert result["relative_path"] == "Artist/Album/01. Track.m4a"


@pytest.mark.anyio
async def test_download_route_sanitizes_component_that_becomes_empty(
    client: AsyncClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app
    import tidal_downloads

    destination = tmp_path / "music"
    outside_stem = tmp_path / "outside" / "escaped"
    rendered_path = f"..{outside_stem.as_posix()}"
    _configure_download(monkeypatch, tidal_downloads, rendered_path)
    monkeypatch.setattr(app, "MUSIC_PATH", destination)
    monkeypatch.setattr(app, "_build_api", lambda *_args: _FakeDownloadApi())

    response = await client.post(
        "/download/track",
        headers={"Authorization": "Bearer token"},
        json={"track_id": 1, "output_template": "malicious"},
    )

    assert response.status_code == 500
    assert response.json()["error"] == "Download failed"
    assert str(outside_stem) not in response.text
    assert not outside_stem.with_suffix(".m4a").exists()
