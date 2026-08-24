"""Behavioral coverage for TIDAL download filename collision handling."""

from __future__ import annotations

import logging
import sys
import threading
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest


class _FakeDownloadApi:
    """Provide track-specific titles and the minimal download API surface."""

    def __init__(self, titles: dict[int, str], *, cover: str | None = None) -> None:
        self._titles = titles
        self._cover = cover

    def get_track(self, track_id: int) -> Any:
        return types.SimpleNamespace(
            id=track_id,
            title=self._titles[track_id],
            album=types.SimpleNamespace(id=22),
            artists=[types.SimpleNamespace(name="Artist")],
        )

    def get_album(self, _album_id: int) -> Any:
        return types.SimpleNamespace(title="Album", cover=self._cover, releaseDate=None)

    def get_track_stream(self, *, track_id: int, quality: str) -> Any:
        return types.SimpleNamespace(audioQuality=quality, track_id=track_id)


class _TaggedAudio:
    """Expose path-keyed fake Mutagen tags through the mapping API."""

    def __init__(self, path: Path, tags: dict[Path, dict[str, list[str]]]) -> None:
        if path.read_bytes() == b"corrupted":
            raise ValueError("corrupted audio")
        self._tags = tags.get(path, {})

    def get(self, key: str) -> list[str] | None:
        return self._tags.get(key)


def _configure_download(
    monkeypatch: pytest.MonkeyPatch,
    tidal_downloads: Any,
    payload_for_track: Callable[[int], bytes],
) -> dict[Path, dict[str, list[str]]]:
    """Install deterministic provider, metadata, and Mutagen seams."""
    download_module = types.ModuleType("tiddl.core.utils.download")
    download_module.__dict__["download"] = lambda urls: payload_for_track(int(urls[0]))
    monkeypatch.setitem(sys.modules, "tiddl.core.utils.download", download_module)
    monkeypatch.setattr(
        tidal_downloads,
        "format_template",
        lambda **kwargs: f"Artist/Album/{kwargs['item'].title}",
    )
    monkeypatch.setattr(
        tidal_downloads,
        "parse_track_stream",
        lambda stream: ([str(stream.track_id)], ".m4a"),
    )

    tags: dict[Path, dict[str, list[str]]] = {}

    def add_metadata(*, path: Path, comment: str, **_kwargs: Any) -> None:
        tags[path] = {"comment": [comment]}

    monkeypatch.setattr(tidal_downloads, "add_track_metadata", add_metadata)
    monkeypatch.setattr(tidal_downloads, "EasyMP4", lambda path: _TaggedAudio(path, tags))
    monkeypatch.setattr(tidal_downloads, "FLAC", lambda path: _TaggedAudio(path, tags))
    return tags


def test_distinct_tracks_with_colliding_names_are_both_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    _configure_download(monkeypatch, tidal_downloads, lambda track_id: f"audio-{track_id}".encode())
    api = _FakeDownloadApi({101: "Intro: Part 1", 202: "Intro? Part 1"})
    destination = tmp_path / "music"

    first = tidal_downloads._download_track_sync(api, 101, "HIGH", "ignored", destination)
    second = tidal_downloads._download_track_sync(api, 202, "HIGH", "ignored", destination)

    first_path = destination / "Artist" / "Album" / "Intro_ Part 1.m4a"
    second_path = destination / "Artist" / "Album" / "Intro_ Part 1 [tidal-202].m4a"
    assert first_path.read_bytes() == b"audio-101"
    assert second_path.read_bytes() == b"audio-202"
    assert tidal_downloads._read_embedded_tidal_id(first_path) == 101
    assert tidal_downloads._read_embedded_tidal_id(second_path) == 202
    assert Path(first["file_path"]) == first_path
    assert Path(second["file_path"]) == second_path
    assert second["relative_path"] == "Artist/Album/Intro_ Part 1 [tidal-202].m4a"


def test_redownload_of_same_track_overwrites_without_suffix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    payloads = iter((b"old-audio", b"refreshed-audio"))
    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: next(payloads))
    api = _FakeDownloadApi({303: "Track"})
    destination = tmp_path / "music"

    tidal_downloads._download_track_sync(api, 303, "HIGH", "ignored", destination)
    result = tidal_downloads._download_track_sync(api, 303, "HIGH", "ignored", destination)

    expected = destination / "Artist" / "Album" / "Track.m4a"
    assert expected.read_bytes() == b"refreshed-audio"
    assert list(expected.parent.glob("Track*.m4a")) == [expected]
    assert Path(result["file_path"]) == expected
    assert tidal_downloads._read_embedded_tidal_id(expected) == 303


def test_legacy_file_without_identity_is_refreshed_at_planned_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: b"new-audio")
    destination = tmp_path / "music"
    existing = destination / "Artist" / "Album" / "Track.m4a"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"unidentified-audio")

    with caplog.at_level(logging.DEBUG, logger="tidal-streamer"):
        result = tidal_downloads._download_track_sync(
            _FakeDownloadApi({404: "Track"}), 404, "HIGH", "ignored", destination
        )

    assert existing.read_bytes() == b"new-audio"
    assert list(existing.parent.glob("Track*.m4a")) == [existing]
    assert Path(result["file_path"]) == existing
    assert tidal_downloads._read_embedded_tidal_id(existing) == 404
    assert "Refreshing unidentified legacy file at planned path" in caplog.text


def test_allocator_skips_planned_and_suffixed_paths_owned_by_other_tracks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    planned = tmp_path / "Track.m4a"
    suffixed = tmp_path / "Track [tidal-8].m4a"
    expected = tmp_path / "Track [tidal-8-2].m4a"
    planned.write_bytes(b"track-one")
    suffixed.write_bytes(b"track-two")
    embedded_ids = {planned: 1, suffixed: 2}
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: embedded_ids.get(path),
    )

    resolved = tidal_downloads._resolve_final_download_path(planned, tmp_path.resolve(), 8)

    assert resolved == expected
    assert planned.read_bytes() == b"track-one"
    assert suffixed.read_bytes() == b"track-two"


def test_allocator_raises_when_every_bounded_candidate_is_occupied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    planned = tmp_path / "Track.m4a"
    candidates = [
        planned,
        tmp_path / "Track [tidal-8].m4a",
        *(tmp_path / f"Track [tidal-8-{counter}].m4a" for counter in range(2, 6)),
    ]
    for candidate in candidates:
        candidate.write_bytes(b"occupied")
    embedded_ids = {candidate: index for index, candidate in enumerate(candidates, start=20)}
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: embedded_ids.get(path),
    )

    with pytest.raises(RuntimeError, match=r"track 8.*6 candidates"):
        tidal_downloads._resolve_final_download_path(planned, tmp_path.resolve(), 8)


def test_download_allocator_exhaustion_removes_uuid_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    destination = tmp_path / "music"
    parent = destination / "Artist" / "Album"
    parent.mkdir(parents=True)
    planned = parent / "Track.m4a"
    candidates = tidal_downloads._build_download_candidates(planned, 8)
    for candidate in candidates:
        candidate.write_bytes(b"occupied")
    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: b"new-audio")
    monkeypatch.setattr(tidal_downloads, "_read_embedded_tidal_id", lambda _path: 999)

    with pytest.raises(RuntimeError, match=r"track 8.*6 candidates"):
        tidal_downloads._download_track_sync(
            _FakeDownloadApi({8: "Track"}), 8, "HIGH", "ignored", destination
        )

    assert list(parent.glob("*.tmp")) == []
    assert {path.read_bytes() for path in candidates} == {b"occupied"}


def test_allocator_reuses_same_track_at_suffixed_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    planned = tmp_path / "Track.m4a"
    suffixed = tmp_path / "Track [tidal-8].m4a"
    planned.write_bytes(b"other-track")
    suffixed.write_bytes(b"old-current-track")
    embedded_ids = {planned: 7, suffixed: 8}
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: embedded_ids.get(path),
    )

    resolved = tidal_downloads._resolve_final_download_path(planned, tmp_path.resolve(), 8)

    assert resolved == suffixed


def test_allocator_skips_unidentified_suffixed_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    planned = tmp_path / "Track.m4a"
    suffixed = tmp_path / "Track [tidal-8].m4a"
    expected = tmp_path / "Track [tidal-8-2].m4a"
    planned.write_bytes(b"other-track")
    suffixed.write_bytes(b"legacy-suffixed-file")
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: 7 if path == planned else None,
    )

    resolved = tidal_downloads._resolve_final_download_path(planned, tmp_path.resolve(), 8)

    assert resolved == expected
    assert planned.read_bytes() == b"other-track"
    assert suffixed.read_bytes() == b"legacy-suffixed-file"


def test_allocator_truncates_utf8_stem_for_maximum_counter_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    stem = ("é" * 120) + ("a" * 10)
    planned = tmp_path / f"{stem}.m4a"
    planned.write_bytes(b"occupied")
    occupied = [planned]
    for counter in range(1, 5):
        identity_suffix = " [tidal-8]" if counter == 1 else f" [tidal-8-{counter}]"
        stem_budget = 255 - len(f"{identity_suffix}.m4a".encode())
        bounded_stem = stem.encode()[:stem_budget].decode(errors="ignore")
        candidate = tmp_path / f"{bounded_stem}{identity_suffix}.m4a"
        candidate.write_bytes(b"occupied")
        occupied.append(candidate)
    monkeypatch.setattr(
        tidal_downloads,
        "_read_embedded_tidal_id",
        lambda path: 99 if path in occupied else None,
    )

    resolved = tidal_downloads._resolve_final_download_path(planned, tmp_path.resolve(), 8)

    assert resolved.name.endswith(" [tidal-8-5].m4a")
    assert len(resolved.name.encode()) <= 255
    assert resolved.name.encode().decode() == resolved.name


def test_concurrent_colliding_downloads_use_unique_temps_and_preserve_both_tracks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    _configure_download(monkeypatch, tidal_downloads, lambda track_id: f"audio-{track_id}".encode())
    api = _FakeDownloadApi({101: "Track", 202: "Track"})
    destination = tmp_path / "music"
    write_barrier = threading.Barrier(2)
    original_write_bytes = Path.write_bytes
    temporary_paths: list[Path] = []
    failures: list[BaseException] = []

    def synchronized_write(path: Path, payload: bytes) -> int:
        written = original_write_bytes(path, payload)
        if path.suffix == ".tmp":
            temporary_paths.append(path)
            write_barrier.wait(timeout=5)
        return written

    def download(track_id: int) -> None:
        try:
            tidal_downloads._download_track_sync(api, track_id, "HIGH", "ignored", destination)
        except BaseException as error:
            failures.append(error)

    monkeypatch.setattr(Path, "write_bytes", synchronized_write)
    threads = [
        threading.Thread(target=download, args=(track_id,), daemon=True) for track_id in (101, 202)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert all(not thread.is_alive() for thread in threads)
    assert failures == []
    assert len(temporary_paths) == 2
    assert len({path.name for path in temporary_paths}) == 2
    installed = sorted((destination / "Artist" / "Album").glob("Track*.m4a"))
    assert len(installed) == 2
    assert {tidal_downloads._read_embedded_tidal_id(path) for path in installed} == {101, 202}
    for path in installed:
        embedded_id = tidal_downloads._read_embedded_tidal_id(path)
        assert path.read_bytes() == f"audio-{embedded_id}".encode()


def test_partial_temp_write_failure_removes_uuid_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: b"audio")
    destination = tmp_path / "music"
    original_write_bytes = Path.write_bytes
    temporary_paths: list[Path] = []

    def fail_after_partial_write(path: Path, payload: bytes) -> int:
        if path.suffix != ".tmp":
            return original_write_bytes(path, payload)
        temporary_paths.append(path)
        original_write_bytes(path, payload[:2])
        raise OSError("partial write")

    monkeypatch.setattr(Path, "write_bytes", fail_after_partial_write)

    with pytest.raises(OSError, match="partial write"):
        tidal_downloads._download_track_sync(
            _FakeDownloadApi({8: "Track"}), 8, "HIGH", "ignored", destination
        )

    assert len(temporary_paths) == 1
    assert not temporary_paths[0].exists()


def test_non_flac_move_failure_removes_uuid_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    fixed_uuid = "0123456789abcdef0123456789abcdef"
    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: b"audio")
    monkeypatch.setattr(
        tidal_downloads,
        "uuid4",
        lambda: types.SimpleNamespace(hex=fixed_uuid),
    )

    def fail_move(_source: str, _destination: str) -> None:
        raise OSError("move")

    monkeypatch.setattr("tidal_downloads.shutil.move", fail_move)
    destination = tmp_path / "music"
    temporary = destination / "Artist" / "Album" / f"Track.{fixed_uuid}.tmp"

    with pytest.raises(OSError, match="move"):
        tidal_downloads._download_track_sync(
            _FakeDownloadApi({8: "Track"}), 8, "HIGH", "ignored", destination
        )

    assert not temporary.exists()


def test_cover_fetch_runs_before_install_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    cover_lock_states: list[bool] = []
    embedded_covers: list[bytes | None] = []
    api = _FakeDownloadApi({8: "Track"}, cover="cover-id")
    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: b"audio")

    def fetch_cover() -> bytes:
        cover_lock_states.append(tidal_downloads._DOWNLOAD_INSTALL_LOCK.locked())
        return b"cover"

    monkeypatch.setattr(
        tidal_downloads,
        "Cover",
        lambda _cover_id: types.SimpleNamespace(fetch_data=fetch_cover),
    )
    monkeypatch.setattr(
        tidal_downloads,
        "add_track_metadata",
        lambda *, cover_data, **_kwargs: embedded_covers.append(cover_data),
    )

    tidal_downloads._download_track_sync(api, 8, "HIGH", "ignored", tmp_path / "music")

    assert cover_lock_states == [False]
    assert embedded_covers == [b"cover"]


def test_temp_name_uses_full_uuid4_hex_and_33_byte_infix_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    fixed_uuid = "0123456789abcdef0123456789abcdef"
    stem = "a" * 218
    monkeypatch.setattr(
        tidal_downloads,
        "uuid4",
        lambda: types.SimpleNamespace(hex=fixed_uuid),
    )

    _relative, _planned, temporary = tidal_downloads._build_download_file_path(
        Path(stem), ".m4a", tmp_path
    )

    assert temporary.name == f"{stem}.{fixed_uuid}.tmp"
    assert len(temporary.name.encode()) == 255


@pytest.mark.parametrize(
    ("filename", "payload", "tags"),
    [
        pytest.param("broken.flac", b"corrupted", {}, id="corrupted"),
        pytest.param("track.mp3", b"audio", {}, id="unsupported-suffix"),
        pytest.param("untagged.m4a", b"audio", {}, id="absent-tag"),
        pytest.param(
            "malformed.m4a",
            b"audio",
            {"comment": ["not-a-tidal-id"]},
            id="unparseable-tag",
        ),
    ],
)
def test_embedded_tidal_id_reader_returns_none_for_unreadable_inputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    filename: str,
    payload: bytes,
    tags: dict[str, list[str]],
) -> None:
    import tidal_downloads

    path = tmp_path / filename
    path.write_bytes(payload)
    tags_by_path = {path: tags}
    monkeypatch.setattr(tidal_downloads, "EasyMP4", lambda item: _TaggedAudio(item, tags_by_path))
    monkeypatch.setattr(tidal_downloads, "FLAC", lambda item: _TaggedAudio(item, tags_by_path))

    assert tidal_downloads._read_embedded_tidal_id(path) is None


@pytest.mark.parametrize(
    ("filename", "tag_key"),
    [
        pytest.param("track.flac", "COMMENT", id="flac-vorbis-comment"),
        pytest.param("track.m4a", "comment", id="easy-mp4-comment"),
    ],
)
def test_embedded_tidal_id_reader_uses_tiddl_comment_keys(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    filename: str,
    tag_key: str,
) -> None:
    import tidal_downloads

    path = tmp_path / filename
    path.write_bytes(b"audio")
    tags_by_path = {path: {tag_key: ["tidal:606"]}}
    monkeypatch.setattr(tidal_downloads, "EasyMP4", lambda item: _TaggedAudio(item, tags_by_path))
    monkeypatch.setattr(tidal_downloads, "FLAC", lambda item: _TaggedAudio(item, tags_by_path))

    assert tidal_downloads._read_embedded_tidal_id(path) == 606


def test_metadata_embed_receives_tidal_identity_comment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tidal_downloads

    comments: list[str] = []
    _configure_download(monkeypatch, tidal_downloads, lambda _track_id: b"audio")
    monkeypatch.setattr(
        tidal_downloads,
        "add_track_metadata",
        lambda *, comment, **_kwargs: comments.append(comment),
    )

    tidal_downloads._download_track_sync(
        _FakeDownloadApi({505: "Track"}), 505, "HIGH", "ignored", tmp_path / "music"
    )

    assert comments == ["tidal:505"]
