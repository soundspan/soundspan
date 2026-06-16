"""
Endpoint tests for GET /yt/playlist-info (bulk-download enumeration).

The pure classification/parsing logic is covered in test_yt.py; these tests
exercise the FastAPI handler: it rejects single videos and auto-generated
mixes (422) and assembles the enumerated entries for real playlists. yt-dlp
is mocked so the tests do no network I/O.
"""

from unittest.mock import patch

import pytest


def _fake_youtube_dl(flat_info):
    """A yt_dlp.YoutubeDL stand-in whose extract_info returns flat_info."""

    class _FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def extract_info(self, url, download=False):
            return flat_info

    return _FakeYDL


@pytest.mark.anyio
async def test_playlist_info_enumerates_real_playlist(client):
    flat = {
        "title": "My Set",
        "channel": "DJ",
        "playlist_count": 2,
        "entries": [
            {"id": "aaaaaaaaaaa", "title": "One", "channel": "DJ", "duration": 100},
            {"id": "bbbbbbbbbbb", "title": "Two", "channel": "DJ", "duration": 200},
        ],
    }
    with patch("yt_dlp.YoutubeDL", _fake_youtube_dl(flat)):
        resp = await client.get(
            "/yt/playlist-info",
            params={
                "url": "https://www.youtube.com/playlist?list=PL-abcDEF12345"
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "playlist"
    assert body["playlistId"] == "PL-abcDEF12345"
    assert body["title"] == "My Set"
    assert body["count"] == 2
    assert body["truncated"] is False
    assert [e["videoId"] for e in body["entries"]] == [
        "aaaaaaaaaaa",
        "bbbbbbbbbbb",
    ]


@pytest.mark.anyio
async def test_playlist_info_rejects_radio_mix(client):
    resp = await client.get(
        "/yt/playlist-info",
        params={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ"
        },
    )
    assert resp.status_code == 422
    assert "mix" in resp.json()["detail"].lower()


@pytest.mark.anyio
async def test_playlist_info_rejects_single_video(client):
    resp = await client.get(
        "/yt/playlist-info",
        params={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_playlist_info_422_when_no_entries(client):
    flat = {"title": "Empty", "entries": []}
    with patch("yt_dlp.YoutubeDL", _fake_youtube_dl(flat)):
        resp = await client.get(
            "/yt/playlist-info",
            params={
                "url": "https://www.youtube.com/playlist?list=PL-emptyXYZ12"
            },
        )
    assert resp.status_code == 422
