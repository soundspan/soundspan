"""Behavioral coverage for YouTube Music album filename collisions."""

from __future__ import annotations

import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, ClassVar

import pytest


class _FakeYoutubeDL:
    """Write deterministic audio bytes to the configured yt-dlp output path."""

    output_paths: ClassVar[list[Path]] = []

    def __init__(self, options: dict[str, Any]) -> None:
        self._options = options

    def __enter__(self) -> _FakeYoutubeDL:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
        assert download is True
        video_id = url.rsplit("=", maxsplit=1)[-1]
        output_path = Path(str(self._options["outtmpl"]).replace("%(ext)s", "mp3"))
        output_path.write_bytes(f"audio:{video_id}".encode())
        self.output_paths.append(output_path)
        return {"id": video_id}


class _WriteThenRaiseYoutubeDL(_FakeYoutubeDL):
    """Create owned yt-dlp artifacts before simulating extraction failure."""

    def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
        super().extract_info(url, download=download)
        output_template = str(self._options["outtmpl"])
        Path(output_template.replace("%(ext)s", "webm")).write_bytes(b"source")
        Path(output_template.replace("%(ext)s", "webm.part")).write_bytes(b"partial")
        Path(output_template.replace("%(ext)s", "webp")).write_bytes(b"thumbnail")
        raise RuntimeError("simulated extraction failure")


class _WriteThenReturnNoInfoYoutubeDL(_FakeYoutubeDL):
    """Create the expected temp output before returning no extraction info."""

    def extract_info(self, url: str, *, download: bool) -> dict[str, str]:
        super().extract_info(url, download=download)
        return {}


class _NoWaitPacer:
    """Avoid provider pacing in deterministic local download tests."""

    def wait(self) -> float:
        return 0.0


def _fake_embedded_video_id(path: Path) -> str | None:
    """Read the test identity appended by the fake ffmpeg tagger."""
    try:
        marker = path.read_bytes().rsplit(b"|ytmusic:", maxsplit=1)
    except OSError:
        return None
    return marker[1].decode() if len(marker) == 2 else None


def _fake_stamp_audio_tags(filepath: str, tags: dict[str, str], _logger: object) -> None:
    """Represent ffmpeg identity stamping without invoking a process."""
    path = Path(filepath)
    path.write_bytes(path.read_bytes() + b"|" + tags["comment"].encode())


def _configure_fake_download(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Install deterministic yt-dlp, pacing, stamping, and reading seams."""
    import app
    import yt_dlp

    _FakeYoutubeDL.output_paths = []
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYoutubeDL)
    monkeypatch.setattr(app, "_extract_pacer", _NoWaitPacer())
    monkeypatch.setattr(app, "_stamp_audio_tags", _fake_stamp_audio_tags)
    monkeypatch.setattr(app, "_read_embedded_video_id", _fake_embedded_video_id)
    return app


def _download_track(app: Any, music_path: Path, video_id: str) -> str:
    """Download one colliding fixture track through the production orchestration."""
    result = app._download_album_track_sync(
        job={"cancel_requested": False},
        track={
            "videoId": video_id,
            "title": "Intro: Part 1",
            "trackNumber": 1,
            "artists": ["Artist"],
        },
        index=1,
        album_title="Album",
        album_artist="Artist",
        year="2024",
        audio_format="mp3",
        quality="HIGH",
        music_path=music_path,
    )
    assert isinstance(result, str)
    return result


def test_distinct_videos_with_colliding_names_are_both_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _configure_fake_download(monkeypatch)

    first_result = _download_track(app, tmp_path, "video000001")
    second_result = _download_track(app, tmp_path, "video000002")

    first = tmp_path / "Artist" / "Album" / "01. Intro_ Part 1.mp3"
    second = tmp_path / "Artist" / "Album" / "01. Intro_ Part 1 [video000002].mp3"
    assert Path(first_result) == first
    assert Path(second_result) == second
    assert first.is_file()
    assert second.is_file()
    assert app._read_embedded_video_id(first) == "video000001"
    assert app._read_embedded_video_id(second) == "video000002"


def test_resume_of_same_embedded_video_id_skips_redownload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _configure_fake_download(monkeypatch)

    first_result = _download_track(app, tmp_path, "video000001")
    second_result = _download_track(app, tmp_path, "video000001")

    assert second_result == first_result
    assert len(_FakeYoutubeDL.output_paths) == 1


def test_gap_before_same_id_candidate_resumes_without_downloading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _configure_fake_download(monkeypatch)
    resumed = tmp_path / "Artist" / "Album" / "01. Intro_ Part 1 [video000001].mp3"
    resumed.parent.mkdir(parents=True)
    resumed.write_bytes(b"audio|ytmusic:video000001")

    result = _download_track(app, tmp_path, "video000001")

    assert Path(result) == resumed
    assert _FakeYoutubeDL.output_paths == []


def test_concurrent_colliding_downloads_use_unique_temps_and_preserve_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _configure_fake_download(monkeypatch)
    extraction_barrier = threading.Barrier(2)
    extract_info = _FakeYoutubeDL.extract_info

    def synchronized_extract(
        downloader: _FakeYoutubeDL, url: str, *, download: bool
    ) -> dict[str, str]:
        result = extract_info(downloader, url, download=download)
        extraction_barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(_FakeYoutubeDL, "extract_info", synchronized_extract)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(_download_track, app, tmp_path, video_id)
            for video_id in ("video000001", "video000002")
        ]
        results = [Path(future.result(timeout=10)) for future in futures]

    assert len(set(_FakeYoutubeDL.output_paths)) == 2
    assert len(set(results)) == 2
    assert {app._read_embedded_video_id(path) for path in results} == {
        "video000001",
        "video000002",
    }


def test_resolver_advances_past_foreign_planned_and_suffixed_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    planned = tmp_path / "Track.mp3"
    suffixed = tmp_path / "Track [video000008].mp3"
    planned.write_bytes(b"first")
    suffixed.write_bytes(b"second")
    identities = {planned: "video000001", suffixed: "video000002"}
    monkeypatch.setattr(app, "_read_embedded_video_id", identities.get)

    resolved = app._resolve_album_track_path(planned, tmp_path, "video000008")

    assert resolved == tmp_path / "Track [video000008-2].mp3"


def test_resolver_advances_past_unknown_identity_at_suffixed_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    planned = tmp_path / "Track.mp3"
    suffixed = tmp_path / "Track [video000008].mp3"
    planned.write_bytes(b"first")
    suffixed.write_bytes(b"legacy-suffix")
    monkeypatch.setattr(
        app,
        "_read_embedded_video_id",
        lambda path: "video000001" if path == planned else None,
    )

    resolved = app._resolve_album_track_path(planned, tmp_path, "video000008")

    assert resolved == tmp_path / "Track [video000008-2].mp3"


def test_resolver_returns_same_id_at_suffixed_candidate_after_free_gap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    planned = tmp_path / "Track.mp3"
    same_id = tmp_path / "Track [video000008].mp3"
    same_id.write_bytes(b"existing")
    monkeypatch.setattr(
        app,
        "_read_embedded_video_id",
        lambda path: "video000008" if path == same_id else None,
    )

    resolved = app._resolve_album_track_path(planned, tmp_path, "video000008")

    assert resolved == same_id


def test_resolver_raises_when_all_bounded_candidates_are_foreign(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app
    from yt_download import _build_album_track_candidates

    planned = tmp_path / "Track.mp3"
    candidates = _build_album_track_candidates(planned, "video000008")
    for candidate in candidates:
        candidate.write_bytes(b"occupied")
    monkeypatch.setattr(app, "_read_embedded_video_id", lambda _path: "another0001")

    with pytest.raises(RuntimeError, match=r"video000008.*6 candidates"):
        app._resolve_album_track_path(planned, tmp_path, "video000008")


def test_resolver_rejects_suffixed_symlink_escape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app

    music = tmp_path / "music"
    outside = tmp_path / "outside"
    music.mkdir()
    outside.mkdir()
    planned = music / "Track.mp3"
    planned.write_bytes(b"foreign")
    (music / "Track [video000008].mp3").symlink_to(outside / "escaped.mp3")
    monkeypatch.setattr(app, "_read_embedded_video_id", lambda _path: "another0001")

    with pytest.raises(ValueError, match="outside MUSIC_PATH"):
        app._resolve_album_track_path(planned, music, "video000008")


@pytest.mark.parametrize("suffix", [".mp3", ".opus", ".ogg", ".flac", ".m4a"])
def test_embedded_video_id_reader_returns_none_for_missing_and_corrupt_files(
    tmp_path: Path, suffix: str
) -> None:
    from yt_download import _read_embedded_video_id

    missing = tmp_path / f"missing{suffix}"
    corrupt = tmp_path / f"corrupt{suffix}"
    corrupt.write_bytes(b"not audio")

    assert _read_embedded_video_id(missing) is None
    assert _read_embedded_video_id(corrupt) is None


@pytest.mark.parametrize(("suffix", "reader_name"), [(".opus", "OggOpus"), (".flac", "FLAC")])
def test_vorbis_identity_reader_checks_comment_after_foreign_description(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suffix: str,
    reader_name: str,
) -> None:
    import yt_download

    tags = {"description": ["foreign yt-dlp description"], "comment": ["ytmusic:video000001"]}
    monkeypatch.setattr(yt_download, reader_name, lambda _path: tags)

    assert yt_download._read_embedded_video_id(tmp_path / f"track{suffix}") == "video000001"


@pytest.mark.parametrize(
    ("suffix", "uses_stream_identity"),
    [
        pytest.param(".mp3", False, id="mp3-global"),
        pytest.param(".m4a", False, id="m4a-global"),
        pytest.param(".flac", False, id="flac-global"),
        pytest.param(".opus", True, id="opus-stream"),
        pytest.param(".ogg", True, id="ogg-stream"),
    ],
)
def test_tag_rewrite_command_scopes_identity_for_container(
    suffix: str, uses_stream_identity: bool
) -> None:
    from yt_download import build_tag_rewrite_command

    command = build_tag_rewrite_command(
        f"source{suffix}", {"comment": "ytmusic:video000001"}, f"tagged{suffix}"
    )

    assert command[10:12] == ["-metadata", "comment=ytmusic:video000001"]
    stream_comment = ["-metadata:s:a:0", "comment=ytmusic:video000001"]
    stream_description = ["-metadata:s:a:0", "description="]
    if uses_stream_identity:
        assert stream_comment == command[12:14]
        assert stream_description == command[14:16]
    else:
        assert "-metadata:s:a:0" not in command


@pytest.mark.parametrize(
    ("suffix", "codec", "sample_rate"),
    [
        pytest.param(".mp3", "libmp3lame", "44100", id="mp3-txxx-comment"),
        pytest.param(".opus", "libopus", "48000", id="opus-description"),
        pytest.param(".flac", "flac", "44100", id="flac-description"),
        pytest.param(".m4a", "aac", "44100", id="m4a-copyright-comment"),
    ],
)
def test_ffmpeg_identity_tag_round_trip_per_supported_container(
    tmp_path: Path, suffix: str, codec: str, sample_rate: str
) -> None:
    from yt_download import _read_embedded_video_id, build_tag_rewrite_command

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg is not installed")
    source = tmp_path / f"source{suffix}"
    tagged = tmp_path / f"tagged{suffix}"
    generate = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r={sample_rate}:cl=mono",
        "-t",
        "0.05",
        "-c:a",
        codec,
    ]
    metadata_scope = "-metadata:s:a:0" if suffix == ".opus" else "-metadata"
    generate += [
        metadata_scope,
        "description=foreign yt-dlp description",
        metadata_scope,
        "comment=foreign yt-dlp comment",
        str(source),
    ]
    subprocess.run(generate, check=True, timeout=10)  # noqa: S603 -- resolved ffmpeg binary
    rewrite = build_tag_rewrite_command(
        str(source), {"comment": "ytmusic:video000001"}, str(tagged)
    )
    rewrite[0] = ffmpeg

    subprocess.run(rewrite, check=True, timeout=10)  # noqa: S603 -- resolved ffmpeg binary

    assert _read_embedded_video_id(tagged) == "video000001"


@pytest.mark.parametrize(
    "downloader_type",
    [_WriteThenRaiseYoutubeDL, _WriteThenReturnNoInfoYoutubeDL],
    ids=["extract-raises", "no-info"],
)
def test_unsuccessful_extraction_removes_owned_temp_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    downloader_type: type[_FakeYoutubeDL],
) -> None:
    app = _configure_fake_download(monkeypatch)
    import yt_dlp

    monkeypatch.setattr(yt_dlp, "YoutubeDL", downloader_type)

    with pytest.raises((RuntimeError, ValueError)):
        _download_track(app, tmp_path, "video000001")

    assert [path for path in tmp_path.rglob("*") if path.is_file()] == []


def test_tag_stamp_failure_removes_temp_and_installs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _configure_fake_download(monkeypatch)

    def fail_stamp(_filepath: str, _tags: dict[str, str], _logger: object) -> None:
        raise RuntimeError("simulated ffmpeg failure")

    monkeypatch.setattr(app, "_stamp_audio_tags", fail_stamp)

    with pytest.raises(RuntimeError, match="simulated ffmpeg failure"):
        _download_track(app, tmp_path, "video000001")

    assert [path for path in tmp_path.rglob("*") if path.is_file()] == []
