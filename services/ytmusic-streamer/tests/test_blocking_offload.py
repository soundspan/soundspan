"""Tests that blocking YTMusic calls run outside the event-loop thread."""

from __future__ import annotations

import threading
import types

import pytest


@pytest.mark.anyio
async def test_search_offloaded_to_worker_thread(client, monkeypatch):
    """Search work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fake(*args, **kwargs):
        captured["t"] = threading.current_thread().name
        return [], "native"

    monkeypatch.setattr(app, "_search_with_mode_fallback", fake)

    response = await client.post("/search?user_id=u1", json={"query": "x"})

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_library_songs_offloaded_to_worker_thread(client, monkeypatch):
    """Library-song work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fake(user_id, operation, func):
        captured["t"] = threading.current_thread().name
        return []

    monkeypatch.setattr(app, "_run_ytmusic_with_auth_retry", fake)

    response = await client.get("/library/songs?user_id=u1")

    assert response.status_code == 200
    assert response.json() == {"songs": [], "total": 0}
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_charts_offloaded_to_worker_thread(client, monkeypatch):
    """Charts work should execute in an asyncio worker thread."""
    import app

    captured = {}
    public_client = types.SimpleNamespace(
        get_charts=lambda country: captured.__setitem__("t", threading.current_thread().name) or {}
    )
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/charts?country=US")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_public_album_offloaded_to_worker_thread(client, monkeypatch):
    """Public album work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def get_album(browse_id):
        captured["t"] = threading.current_thread().name
        return {"title": "t", "artists": [], "thumbnails": [], "tracks": []}

    public_client = types.SimpleNamespace(get_album=get_album)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/album/x?user_id=__public__")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_public_artist_offloaded_to_worker_thread(client, monkeypatch):
    """Public artist work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def get_artist(channel_id):
        captured["t"] = threading.current_thread().name
        return {"name": "a"}

    public_client = types.SimpleNamespace(get_artist=get_artist)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/artist/x?user_id=__public__")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_public_song_offloaded_to_worker_thread(client, monkeypatch):
    """Public song work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def get_song(video_id):
        captured["t"] = threading.current_thread().name
        return {"videoDetails": {"videoId": video_id, "lengthSeconds": "1"}}

    public_client = types.SimpleNamespace(get_song=get_song)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/song/dQw4w9WgXcQ?user_id=__public__")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_public_playlist_offloaded_to_worker_thread(client, monkeypatch):
    """Public playlist work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def get_playlist(playlist_id, limit):
        captured["t"] = threading.current_thread().name
        return {"id": playlist_id, "title": "t", "tracks": []}

    public_client = types.SimpleNamespace(get_playlist=get_playlist)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/playlist/x")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_playlist_auth_fallback_offloaded_to_worker_thread(client, monkeypatch):
    """Public playlist fallback work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fail_authenticated_fetch(*args, **kwargs):
        raise RuntimeError("authenticated fetch failed")

    def get_playlist(playlist_id, limit):
        captured["t"] = threading.current_thread().name
        return {"id": playlist_id, "title": "t", "tracks": []}

    public_client = types.SimpleNamespace(get_playlist=get_playlist)
    monkeypatch.setattr(app, "_run_ytmusic_with_auth_retry", fail_authenticated_fetch)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/playlist/x?user_id=u1")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_debug_search_offloaded_to_worker_thread(client, monkeypatch):
    """Debug-search work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def send_request(endpoint, body):
        captured["t"] = threading.current_thread().name
        return {}

    public_client = types.SimpleNamespace(_send_request=send_request)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.post("/search/debug?user_id=u1", json={"query": "x"})

    assert response.status_code == 200
    assert response.json() == {"raw": {}}
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_device_code_offloaded_to_worker_thread(client, monkeypatch):
    """OAuth device-code initiation should run in an asyncio worker thread."""
    import app

    captured = {}

    class FakeOAuthCredentials:
        def __init__(self, *args, **kwargs):
            pass

        def get_code(self):
            captured["t"] = threading.current_thread().name
            return {
                "device_code": "dc",
                "user_code": "uc",
                "verification_url": "https://example.test/verify",
                "expires_in": 1800,
                "interval": 5,
            }

    monkeypatch.setattr(app, "OAuthCredentials", FakeOAuthCredentials)

    response = await client.post(
        "/auth/device-code",
        json={"client_id": "cid", "client_secret": "secret"},
    )

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_device_code_poll_offloaded_to_worker_thread(client, monkeypatch):
    """OAuth device-code polling should run in an asyncio worker thread."""
    import app

    captured = {}

    class FakeOAuthCredentials:
        def __init__(self, *args, **kwargs):
            pass

        def token_from_code(self, device_code):
            captured["t"] = threading.current_thread().name
            # Pending short-circuits before any file writes.
            return {"error": "authorization_pending"}

    monkeypatch.setattr(app, "OAuthCredentials", FakeOAuthCredentials)

    response = await client.post(
        "/auth/device-code/poll?user_id=u1",
        json={"client_id": "cid", "client_secret": "secret", "device_code": "dc"},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "pending", "error": "authorization_pending"}
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_auth_restore_offloaded_to_worker_thread(client, monkeypatch, tmp_path):
    """Credential restoration writes should execute in an asyncio worker thread."""
    import app

    captured = []
    original_write = app._write_private_file

    def recording_write(path, content):
        captured.append(threading.current_thread().name)
        original_write(path, content)

    monkeypatch.setattr(app, "DATA_PATH", tmp_path)
    monkeypatch.setattr(app, "_write_private_file", recording_write)

    response = await client.post(
        "/auth/restore?user_id=u1",
        json={
            "oauth_json": '{"token": "value"}',
            "client_id": "cid",
            "client_secret": "secret",
        },
    )

    assert response.status_code == 200
    assert app._oauth_file("u1").exists()
    assert app._client_creds_file("u1").exists()
    assert captured
    assert all(thread_name != "MainThread" for thread_name in captured)


@pytest.mark.anyio
async def test_auth_clear_offloaded_to_worker_thread(client, monkeypatch, tmp_path):
    """Credential removal should execute in an asyncio worker thread."""
    import app

    monkeypatch.setattr(app, "DATA_PATH", tmp_path)
    oauth_path = app._oauth_file("u1")
    creds_path = app._client_creds_file("u1")
    oauth_path.write_text("{}")
    creds_path.write_text("{}")

    captured = []
    original_unlink = app._unlink_if_exists

    def recording_unlink(path):
        captured.append(threading.current_thread().name)
        original_unlink(path)

    monkeypatch.setattr(app, "_unlink_if_exists", recording_unlink)

    response = await client.post("/auth/clear?user_id=u1")

    assert response.status_code == 200
    assert not oauth_path.exists()
    assert not creds_path.exists()
    assert captured
    assert all(thread_name != "MainThread" for thread_name in captured)


@pytest.mark.anyio
async def test_device_code_poll_success_write_offloaded_to_worker_thread(
    client, monkeypatch, tmp_path
):
    """Successful device polling writes should execute in an asyncio worker thread."""
    import app

    class SuccessfulOAuthCredentials:
        """Return a deterministic successful device-code token."""

        def __init__(self, client_id, client_secret):
            pass

        def token_from_code(self, device_code):
            return {"access_token": "at", "refresh_token": "rt"}

    captured = []
    original_write = app._write_private_file

    def recording_write(path, content):
        captured.append(threading.current_thread().name)
        original_write(path, content)

    monkeypatch.setattr(app, "DATA_PATH", tmp_path)
    monkeypatch.setattr(app, "OAuthCredentials", SuccessfulOAuthCredentials)
    monkeypatch.setattr(app, "_write_private_file", recording_write)

    response = await client.post(
        "/auth/device-code/poll?user_id=u1",
        json={"client_id": "cid", "client_secret": "secret", "device_code": "dc"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert app._oauth_file("u1").exists()
    assert app._client_creds_file("u1").exists()
    assert captured
    assert all(thread_name != "MainThread" for thread_name in captured)
