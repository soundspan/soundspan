"""Tests for bounded yt-dlp stream extraction."""

from __future__ import annotations

import asyncio
import inspect
import threading
import time

import pytest

VIDEO_ID = "dQw4w9WgXcQ"
PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL-abcDEF12345"
METADATA_EXTRACTION_CASES = (
    (
        f"/yt/info?url=https://www.youtube.com/watch?v={VIDEO_ID}",
        {"id": VIDEO_ID, "title": "video"},
    ),
    (
        f"/yt/playlist-info?url={PLAYLIST_URL}",
        {
            "title": "playlist",
            "entries": [{"id": VIDEO_ID, "title": "video"}],
        },
    ),
)


def _youtube_dl_returning(info, *, started=None, release=None, captured=None):
    """Build a controllable yt-dlp fake for endpoint-level extraction tests."""

    class FakeYoutubeDL:
        def __init__(self, options):
            if captured is not None:
                captured.append(options)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return False

        def extract_info(self, url, download=False):
            if started is not None:
                started.set()
            if release is not None:
                release.wait(timeout=1)
            return info

    return FakeYoutubeDL


def _blocking_youtube_dl(state, state_lock, at_limit, release, concurrency_limit):
    """Build a yt-dlp fake that records and blocks concurrent extraction."""

    class BlockingYoutubeDL:
        def __init__(self, options):
            self.options = options

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return False

        def extract_info(self, url, download=False):
            with state_lock:
                state["active"] += 1
                state["started"] += 1
                state["max_active"] = max(state["max_active"], state["active"])
                if state["active"] == concurrency_limit:
                    at_limit.set()
            try:
                release.wait(timeout=2)
                return {"id": VIDEO_ID, "title": "video"}
            finally:
                with state_lock:
                    state["active"] -= 1

    return BlockingYoutubeDL


@pytest.mark.anyio
async def test_slow_extraction_returns_504(client, monkeypatch):
    """A stalled YouTube Music extraction should return HTTP 504."""
    import app

    monkeypatch.setattr(app, "EXTRACT_TIMEOUT", 0.05)
    monkeypatch.setattr(
        app,
        "_get_stream_url_sync",
        lambda *args: (time.sleep(0.5), {})[1],
    )

    response = await client.get(f"/stream/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 504
    assert response.json()["error"] == "Stream extraction timed out"


@pytest.mark.anyio
async def test_yt_proxy_slow_extraction_returns_504(client, monkeypatch):
    """A stalled regular YouTube extraction should return HTTP 504."""
    import app

    monkeypatch.setattr(app, "EXTRACT_TIMEOUT", 0.05)
    monkeypatch.setattr(
        app,
        "_get_yt_stream_url_sync",
        lambda *args: (time.sleep(0.5), {})[1],
    )

    response = await client.get(f"/yt/proxy/{VIDEO_ID}")

    assert response.status_code == 504
    assert response.json()["error"] == "Stream extraction timed out"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "info"),
    METADATA_EXTRACTION_CASES,
    ids=("video-info", "playlist-info"),
)
async def test_slow_metadata_extraction_returns_504(client, monkeypatch, path, info):
    """A stalled metadata extraction should return a sanitized HTTP 504."""
    import app
    import yt_dlp

    started = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(app, "EXTRACT_TIMEOUT", 0.05)
    monkeypatch.setattr(
        yt_dlp,
        "YoutubeDL",
        _youtube_dl_returning(info, started=started, release=release),
    )

    try:
        response = await client.get(path)
    finally:
        release.set()

    assert started.is_set()
    assert response.status_code == 504
    assert response.json()["error"] == "YouTube extraction timed out"


@pytest.mark.anyio
async def test_fast_extraction_unaffected(client, monkeypatch):
    """A fast extraction should retain the existing success response."""
    import app

    monkeypatch.setattr(
        app,
        "_get_stream_url_sync",
        lambda *args: {
            "url": "http://cdn/x",
            "content_type": "m4a",
            "duration": 1,
            "title": "t",
            "artist": "a",
            "expires_at": 9e9,
            "abr": 128,
            "acodec": "mp4a.40.2",
        },
    )

    response = await client.get(f"/stream/{VIDEO_ID}?user_id=__public__")

    assert response.status_code == 200
    assert response.json()["url"] == "http://cdn/x"


def test_ydl_opts_include_socket_timeout(monkeypatch):
    """Both stream extractors should bound yt-dlp socket operations."""
    import app

    captured = []

    def fake_extract(cache_key, url, ydl_opts, video_id, error_label):
        captured.append(ydl_opts)
        return {"url": "http://cdn/x"}

    monkeypatch.setattr(app, "_extract_stream_info", fake_extract)

    app._get_stream_url_sync("u", VIDEO_ID, "HIGH")
    app._get_yt_stream_url_sync(VIDEO_ID, "HIGH")

    assert len(captured) == 2
    assert all(opts["socket_timeout"] == app.YTDLP_SOCKET_TIMEOUT for opts in captured)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "info"),
    METADATA_EXTRACTION_CASES,
    ids=("video-info", "playlist-info"),
)
async def test_metadata_extraction_configures_socket_timeout(client, monkeypatch, path, info):
    """Metadata endpoints should bound each yt-dlp socket operation."""
    import app
    import yt_dlp

    captured = []
    monkeypatch.setattr(
        yt_dlp,
        "YoutubeDL",
        _youtube_dl_returning(info, captured=captured),
    )

    response = await client.get(path)

    assert response.status_code == 200
    assert len(captured) == 1
    assert captured[0]["socket_timeout"] == app.YTDLP_SOCKET_TIMEOUT


@pytest.mark.anyio
async def test_metadata_extraction_concurrency_is_bounded(client, monkeypatch):
    """Concurrent metadata work should not exceed the configured worker bound."""
    import app
    import yt_dlp

    at_limit = threading.Event()
    release = threading.Event()
    state_lock = threading.Lock()
    state = {"active": 0, "started": 0, "max_active": 0}

    monkeypatch.setattr(app, "EXTRACT_TIMEOUT", 5)
    monkeypatch.setattr(
        yt_dlp,
        "YoutubeDL",
        _blocking_youtube_dl(
            state,
            state_lock,
            at_limit,
            release,
            app.YTDLP_EXTRACT_CONCURRENCY,
        ),
    )
    request_count = app.YTDLP_EXTRACT_CONCURRENCY + 1
    path = f"/yt/info?url=https://www.youtube.com/watch?v={VIDEO_ID}"
    tasks = [asyncio.create_task(client.get(path)) for _ in range(request_count)]

    try:
        reached_limit = await asyncio.to_thread(at_limit.wait, 2)
        with state_lock:
            started_at_limit = state["started"]
            active_at_limit = state["active"]
        release.set()
        responses = await asyncio.gather(*tasks)
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)

    assert reached_limit
    assert started_at_limit == app.YTDLP_EXTRACT_CONCURRENCY
    assert active_at_limit == app.YTDLP_EXTRACT_CONCURRENCY
    assert state["max_active"] == app.YTDLP_EXTRACT_CONCURRENCY
    assert state["started"] == request_count
    assert all(response.status_code == 200 for response in responses)


def test_download_sync_split():
    """The download hot path and its extracted helpers stay below 60 lines."""
    import app

    split_functions = (
        app._update_yt_download_progress,
        app._build_yt_download_opts,
        app._complete_yt_download,
        app._yt_download_sync,
    )

    assert all(len(inspect.getsource(function).splitlines()) < 60 for function in split_functions)
