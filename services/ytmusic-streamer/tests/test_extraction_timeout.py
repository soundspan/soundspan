"""Tests for bounded yt-dlp stream extraction."""

from __future__ import annotations

import inspect
import time

import pytest


VIDEO_ID = "dQw4w9WgXcQ"


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
    assert all(
        opts["socket_timeout"] == app.YTDLP_SOCKET_TIMEOUT for opts in captured
    )


def test_download_sync_split():
    """The download hot path and its extracted helpers stay below 60 lines."""
    import app

    split_functions = (
        app._update_yt_download_progress,
        app._build_yt_download_opts,
        app._complete_yt_download,
        app._yt_download_sync,
    )

    assert all(
        len(inspect.getsource(function).splitlines()) < 60
        for function in split_functions
    )
