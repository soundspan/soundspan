"""Future input-validation contract for stream and song routes."""

from __future__ import annotations

import types

import pytest


VALID_ID = "dQw4w9WgXcQ"


@pytest.fixture()
def stream_recorder(monkeypatch):
    """Record extraction calls while returning deterministic stream metadata."""
    import app

    calls = []
    stub = {
        "url": "http://upstream/x",
        "content_type": "m4a",
        "duration": 10,
        "title": "t",
        "artist": "a",
        "expires_at": 9999999999.0,
        "abr": 128,
        "acodec": "aac",
    }
    monkeypatch.setattr(
        app,
        "_get_stream_url_sync",
        lambda user_id, video_id, quality="HIGH": (
            calls.append((user_id, video_id, quality)) or stub
        ),
    )
    monkeypatch.setattr(
        app,
        "_get_yt_stream_url_sync",
        lambda video_id, quality="HIGH": (
            calls.append(("yt", video_id, quality)) or stub
        ),
    )
    yield calls


@pytest.mark.anyio
async def test_stream_rejects_malformed_video_id(client, stream_recorder):
    """Malformed stream IDs are rejected before extraction begins."""
    for bad in ["short", "waytoolongvideoid123", "bad.chars!!x"]:
        response = await client.get(f"/stream/{bad}?user_id=__public__")
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid video_id"
        assert stream_recorder == []


@pytest.mark.anyio
async def test_stream_accepts_valid_video_id(client, stream_recorder):
    """A valid stream ID reaches extraction with the default quality."""
    response = await client.get(f"/stream/{VALID_ID}?user_id=__public__")
    assert response.status_code == 200
    assert stream_recorder[-1] == ("__public__", VALID_ID, "HIGH")


@pytest.mark.anyio
async def test_stream_rejects_bad_quality(client, stream_recorder):
    """An unsupported stream quality is rejected before extraction."""
    response = await client.get(
        f"/stream/{VALID_ID}?user_id=__public__&quality=bogus"
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid quality"
    assert stream_recorder == []


@pytest.mark.anyio
async def test_stream_normalizes_lowercase_quality(client, stream_recorder):
    """A supported lowercase stream quality is normalized before use."""
    response = await client.get(
        f"/stream/{VALID_ID}?user_id=__public__&quality=lossless"
    )
    assert response.status_code == 200
    assert stream_recorder[-1][2] == "LOSSLESS"


@pytest.mark.anyio
async def test_proxy_rejects_malformed_video_id(client, stream_recorder):
    """The music proxy rejects a malformed ID before extraction."""
    response = await client.get("/proxy/bad.id!?user_id=__public__")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid video_id"


@pytest.mark.anyio
async def test_proxy_rejects_bad_quality(client, stream_recorder):
    """The music proxy rejects an unsupported quality before extraction."""
    response = await client.get(
        f"/proxy/{VALID_ID}?user_id=__public__&quality=ULTRA"
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid quality"


@pytest.mark.anyio
async def test_yt_proxy_rejects_malformed_video_id(client, stream_recorder):
    """The YouTube proxy rejects a malformed ID before extraction."""
    response = await client.get("/yt/proxy/nope")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid video_id"


@pytest.mark.anyio
async def test_yt_proxy_rejects_bad_quality(client, stream_recorder):
    """The YouTube proxy rejects an unsupported quality before extraction."""
    response = await client.get(f"/yt/proxy/{VALID_ID}?quality=extreme")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid quality"


@pytest.mark.anyio
async def test_song_rejects_malformed_video_id(client):
    """The song route rejects a malformed ID before metadata extraction."""
    response = await client.get("/song/tiny?user_id=__public__")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid video_id"


@pytest.mark.anyio
async def test_song_accepts_valid_video_id(client, monkeypatch):
    """The song route accepts a valid ID and returns its metadata."""
    import app

    monkeypatch.setattr(
        app,
        "_get_public_ytmusic",
        lambda strategy="native": types.SimpleNamespace(
            get_song=lambda vid: {
                "videoDetails": {
                    "videoId": vid,
                    "title": "T",
                    "author": "A",
                    "lengthSeconds": "10",
                    "thumbnail": {"thumbnails": []},
                }
            }
        ),
    )
    response = await client.get(f"/song/{VALID_ID}?user_id=__public__")
    assert response.status_code == 200
    assert response.json()["videoId"] == VALID_ID
