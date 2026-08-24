"""Behavioral coverage for TIDAL FLAC extraction and codec detection."""

from __future__ import annotations

import logging
import sys
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest


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


class _FakeFFmpegError(RuntimeError):
    """Represent the tiddl extraction failure handled by the downloader."""


def _configure_flac_download(
    monkeypatch: pytest.MonkeyPatch,
    app: Any,
    extract_flac: Callable[..., Path],
) -> None:
    """Stub download and ffmpeg modules while preserving filesystem writes."""
    download_module = types.ModuleType("tiddl.core.utils.download")
    download_module.__dict__["download"] = lambda _urls: b"audio"
    monkeypatch.setitem(sys.modules, "tiddl.core.utils.download", download_module)

    ffmpeg_module = types.ModuleType("tiddl.core.utils.ffmpeg")
    ffmpeg_module.__dict__["extract_flac"] = extract_flac
    ffmpeg_module.__dict__["FFmpegError"] = _FakeFFmpegError
    monkeypatch.setitem(sys.modules, "tiddl.core.utils.ffmpeg", ffmpeg_module)

    monkeypatch.setattr(app, "format_template", lambda **_kwargs: "Artist/Album/01. Track")
    monkeypatch.setattr(app, "parse_track_stream", lambda _stream: (["url"], ".flac"))
    monkeypatch.setattr(app, "add_track_metadata", lambda **_kwargs: None)


def test_flac_extraction_uses_one_path_and_moves_converted_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    calls: list[tuple[Path, ...]] = []

    def extract_flac(*args: Path) -> Path:
        calls.append(args)
        source = args[0]
        converted = source.with_suffix(".flac")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 1, "LOSSLESS", "ignored", destination
    )

    expected = destination / "Artist" / "Album" / "01. Track.flac"
    temporary = expected.with_suffix(".flac.tmp")
    intermediate = temporary.with_suffix(".flac")
    assert calls == [(temporary,)]
    assert expected.read_bytes() == b"audio"
    assert not temporary.exists()
    assert not intermediate.exists()
    assert Path(result["file_path"]) == expected
    assert result["relative_path"] == "Artist/Album/01. Track.flac"
    assert result["file_size"] == len(b"audio")


def test_aac_detection_uses_m4a_final_path_and_metadata_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    metadata_paths: list[Path] = []

    def extract_flac(source: Path) -> Path:
        converted = source.with_suffix(".m4a")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)
    monkeypatch.setattr(
        tidal_downloads,
        "add_track_metadata",
        lambda *, path, **_kwargs: metadata_paths.append(path),
    )

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 2, "LOSSLESS", "ignored", destination
    )

    planned = destination / "Artist" / "Album" / "01. Track.flac"
    expected = planned.with_suffix(".m4a")
    temporary = planned.with_suffix(".flac.tmp")
    intermediate = temporary.with_suffix(".m4a")
    assert expected.read_bytes() == b"audio"
    assert Path(result["file_path"]).resolve() == expected.resolve()
    assert not planned.exists()
    assert not temporary.exists()
    assert not intermediate.exists()
    assert metadata_paths == [expected]
    assert result["relative_path"] == "Artist/Album/01. Track.m4a"
    assert result["file_size"] == len(b"audio")


def test_ffmpeg_error_logs_warning_and_falls_back_to_planned_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    def extract_flac(source: Path) -> Path:
        source.with_suffix(".tmp.flac").write_bytes(b"partial-flac")
        raise _FakeFFmpegError("ffmpeg failed")

    destination = tmp_path / "music"
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = tidal_downloads._download_track_sync(
            _FakeDownloadApi(), 3, "LOSSLESS", "ignored", destination
        )

    expected = destination / "Artist" / "Album" / "01. Track.flac"
    temporary = expected.with_suffix(".flac.tmp")
    intermediate = temporary.with_suffix(".tmp.flac")
    assert expected.read_bytes() == b"audio"
    assert not temporary.exists()
    assert not intermediate.exists()
    assert Path(result["file_path"]) == expected
    assert "track 3" in caplog.text
    assert "ffmpeg failed" in caplog.text


def test_flac_to_m4a_transition_removes_stale_flac_sibling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    def extract_flac(source: Path) -> Path:
        converted = source.with_suffix(".m4a")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    planned = destination / "Artist" / "Album" / "01. Track.flac"
    planned.parent.mkdir(parents=True)
    planned.write_bytes(b"old-flac")
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 4, "LOSSLESS", "ignored", destination
    )

    expected = planned.with_suffix(".m4a")
    assert expected.read_bytes() == b"audio"
    assert set(expected.parent.iterdir()) == {expected}
    assert Path(result["file_path"]) == expected


def test_m4a_to_flac_transition_removes_stale_m4a_sibling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    def extract_flac(source: Path) -> Path:
        converted = source.with_suffix(".flac")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    planned = destination / "Artist" / "Album" / "01. Track.flac"
    stale_m4a = planned.with_suffix(".m4a")
    stale_m4a.parent.mkdir(parents=True)
    stale_m4a.write_bytes(b"old-m4a")
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 5, "LOSSLESS", "ignored", destination
    )

    assert planned.read_bytes() == b"audio"
    assert set(planned.parent.iterdir()) == {planned}
    assert Path(result["file_path"]) == planned


def test_outside_converted_path_warns_and_falls_back_without_touching_outside_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"outside-audio")

    def extract_flac(_source: Path) -> Path:
        return outside

    destination = tmp_path / "music"
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = tidal_downloads._download_track_sync(
            _FakeDownloadApi(), 6, "LOSSLESS", "ignored", destination
        )

    expected = destination / "Artist" / "Album" / "01. Track.flac"
    assert expected.read_bytes() == b"audio"
    assert outside.read_bytes() == b"outside-audio"
    assert Path(result["file_path"]) == expected
    assert "outside MUSIC_PATH" in caplog.text


def test_unexpected_final_move_failure_preserves_one_recoverable_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    destination.mkdir()
    planned = destination / "Track.flac"
    temporary = planned.with_suffix(".flac.tmp")
    temporary.write_bytes(b"source-audio")
    converted = temporary.with_suffix(".flac")

    def extract_flac(_source: Path) -> Path:
        converted.write_bytes(b"converted-audio")
        return converted

    def fail_move(_source: str, _destination: str) -> None:
        raise OSError("move")

    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)
    monkeypatch.setattr("tidal_downloads.shutil.move", fail_move)

    with pytest.raises(OSError, match="move"):
        tidal_downloads._finalize_flac_download(temporary, planned, destination.resolve(), 7)

    assert temporary.read_bytes() == b"source-audio"
    assert not converted.exists()
    assert set(destination.iterdir()) == {temporary}
