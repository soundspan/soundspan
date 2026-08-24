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
    temporary = calls[0][0]
    intermediate = temporary.with_suffix(".flac")
    assert calls == [(temporary,)]
    assert temporary.parent == expected.parent
    assert temporary.name.startswith("01. Track.")
    assert temporary.name.endswith(".tmp")
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
    temporary_paths: list[Path] = []

    def extract_flac(source: Path) -> Path:
        temporary_paths.append(source)
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
    temporary = temporary_paths[0]
    intermediate = temporary.with_suffix(".m4a")
    assert expected.read_bytes() == b"audio"
    assert Path(result["file_path"]).resolve() == expected.resolve()
    assert not planned.exists()
    assert not temporary.exists()
    assert not intermediate.exists()
    assert metadata_paths == [expected]
    assert result["relative_path"] == "Artist/Album/01. Track.m4a"
    assert result["file_size"] == len(b"audio")


def test_aac_detection_disambiguates_existing_m4a_for_different_track(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    def extract_flac(source: Path) -> Path:
        converted = source.with_suffix(".m4a")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    existing = destination / "Artist" / "Album" / "01. Track.m4a"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"different-track")
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: 700 if path == existing else None,
    )

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 8, "LOSSLESS", "ignored", destination
    )

    disambiguated = existing.with_name("01. Track [tidal-8].m4a")
    assert existing.read_bytes() == b"different-track"
    assert disambiguated.read_bytes() == b"audio"
    assert Path(result["file_path"]) == disambiguated
    assert result["relative_path"] == "Artist/Album/01. Track [tidal-8].m4a"


def test_ffmpeg_error_logs_warning_and_falls_back_to_planned_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    temporary_paths: list[Path] = []

    def extract_flac(source: Path) -> Path:
        temporary_paths.append(source)
        source.with_suffix(".tmp.flac").write_bytes(b"partial-flac")
        raise _FakeFFmpegError("ffmpeg failed")

    destination = tmp_path / "music"
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = tidal_downloads._download_track_sync(
            _FakeDownloadApi(), 3, "LOSSLESS", "ignored", destination
        )

    expected = destination / "Artist" / "Album" / "01. Track.flac"
    temporary = temporary_paths[0]
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
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: 4 if path == planned else None,
    )

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
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: 5 if path == stale_m4a else None,
    )

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 5, "LOSSLESS", "ignored", destination
    )

    assert planned.read_bytes() == b"audio"
    assert set(planned.parent.iterdir()) == {planned}
    assert Path(result["file_path"]) == planned


@pytest.mark.parametrize(
    "embedded_id",
    [pytest.param(None, id="unknown"), pytest.param(999, id="different-track")],
)
def test_codec_transition_preserves_sibling_not_owned_by_current_track(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    embedded_id: int | None,
) -> None:
    import tidal_downloads

    def extract_flac(source: Path) -> Path:
        converted = source.with_suffix(".flac")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    planned = destination / "Artist" / "Album" / "01. Track.flac"
    sibling = planned.with_suffix(".m4a")
    sibling.parent.mkdir(parents=True)
    sibling.write_bytes(b"different-track")
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: embedded_id if path == sibling else None,
    )

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 6, "LOSSLESS", "ignored", destination
    )

    assert planned.read_bytes() == b"audio"
    assert sibling.read_bytes() == b"different-track"
    assert set(planned.parent.iterdir()) == {planned, sibling}
    assert Path(result["file_path"]) == planned


def test_disambiguated_codec_switch_cleans_owned_planned_stem_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    def extract_flac(source: Path) -> Path:
        converted = source.with_suffix(".m4a")
        source.replace(converted)
        return converted

    destination = tmp_path / "music"
    planned = destination / "Artist" / "Album" / "01. Track.flac"
    occupied_m4a = planned.with_suffix(".m4a")
    planned.parent.mkdir(parents=True)
    planned.write_bytes(b"old-current-track")
    occupied_m4a.write_bytes(b"different-track")
    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: 8 if path == planned else 700 if path == occupied_m4a else None,
    )

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(), 8, "LOSSLESS", "ignored", destination
    )

    installed = occupied_m4a.with_name("01. Track [tidal-8].m4a")
    assert not planned.exists()
    assert occupied_m4a.read_bytes() == b"different-track"
    assert installed.read_bytes() == b"audio"
    assert set(installed.parent.iterdir()) == {occupied_m4a, installed}
    assert Path(result["file_path"]) == installed


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


def test_unexpected_final_move_failure_removes_all_staged_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    destination.mkdir()
    planned = destination / "Track.flac"
    temporary = destination / "Track.0123456789abcdef0123456789abcdef.tmp"
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

    assert not temporary.exists()
    assert not converted.exists()
    assert list(destination.iterdir()) == []


def test_ffmpeg_fallback_move_failure_removes_all_staged_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    destination.mkdir()
    planned = destination / "Track.flac"
    temporary = destination / "Track.0123456789abcdef0123456789abcdef.tmp"
    temporary.write_bytes(b"source-audio")
    intermediate = temporary.with_suffix(".tmp.flac")

    def extract_flac(_source: Path) -> Path:
        intermediate.write_bytes(b"partial-flac")
        raise _FakeFFmpegError("ffmpeg failed")

    def fail_move(_source: str, _destination: str) -> None:
        raise OSError("move")

    _configure_flac_download(monkeypatch, tidal_downloads, extract_flac)
    monkeypatch.setattr("tidal_downloads.shutil.move", fail_move)

    with pytest.raises(OSError, match="move"):
        tidal_downloads._finalize_flac_download(temporary, planned, destination.resolve(), 7)

    assert not temporary.exists()
    assert not intermediate.exists()
    assert list(destination.iterdir()) == []
