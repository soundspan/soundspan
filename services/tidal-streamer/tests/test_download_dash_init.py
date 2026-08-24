"""Behavioral coverage for DASH initialization segments in TIDAL downloads."""

from __future__ import annotations

import logging
import sys
import types
from base64 import b64encode
from pathlib import Path
from typing import Any

import pytest


class _FakeDownloadApi:
    """Provide the minimal provider behavior needed for a track download."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream

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
        return self._stream


def _build_mpd(init_url: str | None) -> str:
    """Build a minimal base64-encoded DASH MPD with an initialization URL."""
    initialization = f' initialization="{init_url}"' if init_url else ""
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet>
      <Representation codecs="mp4a.40.2" bandwidth="320000">
        <SegmentTemplate{initialization} media="https://cdn.tidal.com/$Number$.mp4" startNumber="0">
          <SegmentTimeline><S d="96256" r="1"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"""
    return b64encode(xml.encode()).decode()


def _configure_download(
    monkeypatch: pytest.MonkeyPatch,
    app: Any,
    media_bytes: dict[str, bytes],
) -> list[list[str]]:
    """Stub download dependencies and record each URL list received by tiddl."""
    received_urls: list[list[str]] = []

    def download(urls: list[str]) -> bytes:
        received_urls.append(urls)
        return b"".join(media_bytes[url] for url in urls)

    download_module = types.ModuleType("tiddl.core.utils.download")
    download_module.__dict__["download"] = download
    monkeypatch.setitem(sys.modules, "tiddl.core.utils.download", download_module)
    monkeypatch.setattr(app, "format_template", lambda **_kwargs: "Artist/Album/01. Track")
    monkeypatch.setattr(app, "add_track_metadata", lambda **_kwargs: None)
    return received_urls


def test_dash_download_prepends_init_segment_and_writes_all_bytes_in_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import tidal_downloads

    init_url = "https://cdn.tidal.com/init.mp4"
    media_urls = [
        "https://cdn.tidal.com/segment-1.mp4",
        "https://cdn.tidal.com/segment-2.mp4",
    ]
    stream = types.SimpleNamespace(
        audioQuality="HI_RES_LOSSLESS",
        manifestMimeType="application/dash+xml",
        manifest=_build_mpd(init_url),
    )
    media_bytes = {
        init_url: b"init-bytes",
        media_urls[0]: b"segment-one",
        media_urls[1]: b"segment-two",
    }
    received_urls = _configure_download(monkeypatch, tidal_downloads, media_bytes)
    monkeypatch.setattr(tidal_downloads, "parse_track_stream", lambda _stream: (media_urls, ".m4a"))

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(stream),
        1,
        "HI_RES_LOSSLESS",
        "ignored",
        tmp_path / "music",
    )

    expected_urls = [init_url, *media_urls]
    output_path = Path(result["file_path"])
    assert received_urls == [expected_urls]
    assert output_path.read_bytes() == b"init-bytessegment-onesegment-two"


def test_dash_download_deduplicates_init_url_already_in_media_urls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import tidal_downloads

    init_url = "https://cdn.tidal.com/init.mp4"
    media_url = "https://cdn.tidal.com/segment-1.mp4"
    parsed_urls = [init_url, media_url, init_url]
    stream = types.SimpleNamespace(
        audioQuality="HI_RES_LOSSLESS",
        manifestMimeType="application/dash+xml",
        manifest=_build_mpd(init_url),
    )
    media_bytes = {init_url: b"init", media_url: b"media"}
    received_urls = _configure_download(monkeypatch, tidal_downloads, media_bytes)
    monkeypatch.setattr(
        tidal_downloads, "parse_track_stream", lambda _stream: (parsed_urls, ".m4a")
    )

    tidal_downloads._download_track_sync(
        _FakeDownloadApi(stream),
        2,
        "HI_RES_LOSSLESS",
        "ignored",
        tmp_path / "music",
    )

    assert received_urls == [[init_url, media_url]]


def test_bts_download_passes_parsed_urls_through_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import tidal_downloads

    media_urls = ["https://cdn.tidal.com/track.m4a"]
    stream = types.SimpleNamespace(
        audioQuality="HIGH",
        manifestMimeType="application/vnd.tidal.bts",
        manifest="unused",
    )
    received_urls = _configure_download(
        monkeypatch,
        tidal_downloads,
        {media_urls[0]: b"track-bytes"},
    )
    monkeypatch.setattr(tidal_downloads, "parse_track_stream", lambda _stream: (media_urls, ".m4a"))

    result = tidal_downloads._download_track_sync(
        _FakeDownloadApi(stream),
        2,
        "HIGH",
        "ignored",
        tmp_path / "music",
    )

    assert received_urls == [media_urls]
    assert Path(result["file_path"]).read_bytes() == b"track-bytes"


def test_valid_dash_manifest_without_init_warns_and_downloads_media_segments(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    media_urls = [
        "https://cdn.tidal.com/0.mp4",
        "https://cdn.tidal.com/1.mp4",
        "https://cdn.tidal.com/2.mp4",
    ]
    stream = types.SimpleNamespace(
        trackId=3,
        audioQuality="HI_RES_LOSSLESS",
        manifestMimeType="application/dash+xml",
        manifest=_build_mpd(None),
    )
    received_urls = _configure_download(
        monkeypatch,
        tidal_downloads,
        {url: f"segment-{index}".encode() for index, url in enumerate(media_urls)},
    )
    monkeypatch.setattr(tidal_downloads, "parse_track_stream", lambda _stream: (media_urls, ".m4a"))

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = tidal_downloads._download_track_sync(
            _FakeDownloadApi(stream),
            3,
            "HI_RES_LOSSLESS",
            "ignored",
            tmp_path / "music",
        )

    assert received_urls == [media_urls]
    assert Path(result["file_path"]).read_bytes() == b"segment-0segment-1segment-2"
    assert "DASH init segment" in caplog.text
    assert "track 3" in caplog.text


def test_malformed_dash_manifest_warns_at_helper_boundary(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    stream = types.SimpleNamespace(
        manifestMimeType="application/dash+xml",
        manifest="not-valid-base64!!!",
    )
    urls = ["https://cdn.tidal.com/segment.mp4"]

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = tidal_downloads._prepend_dash_init_segment(stream, urls, 4)

    assert result == urls
    assert "DASH init segment" in caplog.text
    assert "track 4" in caplog.text


def test_malformed_dash_manifest_is_silent_when_warning_is_disabled(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import tidal_downloads

    stream = types.SimpleNamespace(
        manifestMimeType="application/dash+xml",
        manifest="not-valid-base64!!!",
    )
    urls = ["https://cdn.tidal.com/segment.mp4"]

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = tidal_downloads._prepend_dash_init_segment(stream, urls, 5, warn_on_missing=False)

    assert result == urls
    assert "DASH init segment" not in caplog.text


def test_streaming_path_keeps_missing_init_fallback_silent(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import app

    media_urls = ["https://cdn.tidal.com/0.mp4"]
    stream = types.SimpleNamespace(
        audioQuality="HI_RES_LOSSLESS",
        manifestMimeType="application/dash+xml",
        manifest=_build_mpd(None),
        bitDepth=24,
        sampleRate=96000,
    )
    api = types.SimpleNamespace(get_track_stream=lambda **_kwargs: stream)
    monkeypatch.setattr(app, "_get_user_api", lambda _user_id: api)
    monkeypatch.setattr(app, "parse_track_stream", lambda _stream: (media_urls, ".m4a"))
    monkeypatch.setattr(app, "_stream_cache", {})

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        result = app._get_stream_url_sync("user", 6, "HI_RES_LOSSLESS")

    assert result["urls"] == media_urls
    assert "DASH init segment" not in caplog.text
