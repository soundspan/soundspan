"""Tests that blocking TIDAL auth/search calls run off the event-loop thread."""

from __future__ import annotations

import threading
import types
from typing import Any

import pytest
from httpx import AsyncClient


def _fake_user() -> types.SimpleNamespace:
    """Minimal TIDAL user object returned by auth responses."""
    return types.SimpleNamespace(userId=42, countryCode="US", username="tester")


@pytest.mark.anyio
async def test_device_auth_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Device-auth initiation should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAuthAPI:
        def get_device_auth(self) -> Any:
            captured["t"] = threading.current_thread().name
            return types.SimpleNamespace(
                deviceCode="dc",
                userCode="uc",
                verificationUri="https://example.test/verify",
                verificationUriComplete="https://example.test/verify?uc",
                expiresIn=300,
                interval=5,
            )

    monkeypatch.setattr(app, "AuthAPI", FakeAuthAPI)

    response = await client.post("/auth/device")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_token_exchange_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Token exchange should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAuthAPI:
        def get_auth(self, device_code: Any) -> Any:
            captured["t"] = threading.current_thread().name
            return types.SimpleNamespace(
                access_token="at",
                refresh_token="rt",
                token_type="Bearer",
                expires_in=3600,
                user=_fake_user(),
            )

    monkeypatch.setattr(app, "AuthAPI", FakeAuthAPI)

    response = await client.post("/auth/token", json={"device_code": "dc"})

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_token_refresh_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Token refresh should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAuthAPI:
        def refresh_token(self, refresh_token: Any) -> Any:
            captured["t"] = threading.current_thread().name
            return types.SimpleNamespace(
                access_token="at2",
                token_type="Bearer",
                expires_in=3600,
                user=_fake_user(),
            )

    monkeypatch.setattr(app, "AuthAPI", FakeAuthAPI)

    response = await client.post("/auth/refresh", json={"refresh_token": "rt"})

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_search_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Admin search should execute in an asyncio worker thread."""
    import app

    captured = {}

    def _empty_results() -> Any:
        return types.SimpleNamespace(
            tracks=types.SimpleNamespace(items=[]),
            albums=types.SimpleNamespace(items=[]),
            artists=types.SimpleNamespace(items=[]),
        )

    def fake_get_search(query: Any) -> Any:
        captured["t"] = threading.current_thread().name
        return _empty_results()

    monkeypatch.setattr(
        app,
        "_build_api",
        lambda *_args, **_kwargs: types.SimpleNamespace(get_search=fake_get_search),
    )

    response = await client.post(
        "/search",
        json={"query": "q"},
        headers={"Authorization": "Bearer tok-header", "x-tidal-user-id": "u1"},
    )

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_download_album_metadata_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Album metadata and pagination should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAPI:
        def get_album(self, album_id: Any) -> Any:
            captured["album"] = threading.current_thread().name
            return types.SimpleNamespace(
                title="A",
                artist=types.SimpleNamespace(name="X"),
            )

        def get_album_items(self, album_id: Any, limit: Any = 100, offset: Any = 0) -> Any:
            captured["items"] = threading.current_thread().name
            return types.SimpleNamespace(items=[], totalNumberOfItems=0)

    monkeypatch.setattr(app, "_build_api", lambda *_args, **_kwargs: FakeAPI())

    response = await client.post(
        "/download/album",
        json={"album_id": 1},
        headers={"Authorization": "Bearer tok-header", "x-tidal-user-id": "u1"},
    )

    assert response.status_code == 200
    assert captured["album"] != "MainThread"
    assert captured["items"] != "MainThread"


def _fake_browse_session(endpoint: str) -> types.SimpleNamespace:
    """Build the minimal fake session required by one browse endpoint."""
    empty_page = types.SimpleNamespace(categories=[])
    if endpoint.endswith("/home"):
        return types.SimpleNamespace(home=lambda: empty_page)
    if endpoint.endswith("/explore"):
        return types.SimpleNamespace(explore=lambda: empty_page)
    if endpoint.endswith("/genres"):
        return types.SimpleNamespace(genres=lambda: empty_page)
    if endpoint.endswith("/moods"):
        return types.SimpleNamespace(moods=lambda: empty_page)
    if endpoint.endswith("/mixes"):
        return types.SimpleNamespace(mixes=lambda: empty_page)
    if endpoint.endswith("/genre-playlists"):
        return types.SimpleNamespace(page=types.SimpleNamespace(get=lambda _path: empty_page))
    if "/playlist/" in endpoint:
        playlist = types.SimpleNamespace(id="p1", name="P", num_tracks=0, tracks=list)
        return types.SimpleNamespace(playlist=lambda _uuid: playlist)
    mix = types.SimpleNamespace(id="m1", title="M", sub_title="", items=list)
    return types.SimpleNamespace(mix=lambda _mix_id: mix)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("endpoint", "params"),
    [
        ("/user/browse/home", {}),
        ("/user/browse/explore", {}),
        ("/user/browse/genres", {}),
        ("/user/browse/moods", {}),
        ("/user/browse/mixes", {}),
        ("/user/browse/genre-playlists", {"path": "Pop"}),
        ("/user/browse/playlist/p1", {}),
        ("/user/browse/mix/m1", {}),
    ],
)
async def test_browse_session_build_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, endpoint: str, params: Any
) -> None:
    """Each authenticated browse endpoint should build its session in a worker thread."""
    import app

    captured = {}

    def fake_build_browse_session(user_id: Any, quality: Any) -> Any:
        captured["t"] = threading.current_thread().name
        return _fake_browse_session(endpoint)

    monkeypatch.setattr(app, "_build_browse_session", fake_build_browse_session)

    response = await client.get(endpoint, params={"user_id": "u1", **params})

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


def _session_obj() -> types.SimpleNamespace:
    """Minimal TIDAL session object returned by get_session()."""
    return types.SimpleNamespace(sessionId="s", userId=42, countryCode="US")


@pytest.mark.anyio
async def test_auth_session_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Admin session verification should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fake_get_session() -> Any:
        captured["t"] = threading.current_thread().name
        return _session_obj()

    monkeypatch.setattr(
        app,
        "_build_api",
        lambda *_args, **_kwargs: types.SimpleNamespace(get_session=fake_get_session),
    )

    response = await client.post(
        "/auth/session",
        json={"access_token": "at", "user_id": "42", "country_code": "US"},
    )

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_user_auth_restore_session_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Per-user session restore should verify the session off the event loop."""
    import app

    captured = {}

    def fake_get_session() -> Any:
        captured["t"] = threading.current_thread().name
        return _session_obj()

    monkeypatch.setattr(
        app,
        "_build_api",
        lambda *_args, **_kwargs: types.SimpleNamespace(get_session=fake_get_session),
    )

    response = await client.post(
        "/user/auth/restore",
        params={"user_id": "ss-user-1"},
        json={
            "access_token": "at",
            "refresh_token": "rt",
            "user_id": "42",
            "country_code": "US",
        },
    )

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_user_auth_restore_refresh_offloaded_to_worker_thread(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Expired-token refresh + re-verify should both run off the event loop."""
    import app

    captured = {}

    class FakeAuthAPI:
        def refresh_token(self, refresh_token: Any) -> Any:
            captured["refresh"] = threading.current_thread().name
            return types.SimpleNamespace(access_token="at2", user=_fake_user())

    def expired_get_session() -> Any:
        raise app.ApiError("expired")

    def refreshed_get_session() -> Any:
        captured["session"] = threading.current_thread().name
        return _session_obj()

    apis = [
        types.SimpleNamespace(get_session=expired_get_session),
        types.SimpleNamespace(get_session=refreshed_get_session),
    ]

    monkeypatch.setattr(app, "_build_api", lambda *_a, **_k: apis.pop(0))
    monkeypatch.setattr(app, "AuthAPI", FakeAuthAPI)

    response = await client.post(
        "/user/auth/restore",
        params={"user_id": "ss-user-2"},
        json={
            "access_token": "at",
            "refresh_token": "rt",
            "user_id": "42",
            "country_code": "US",
        },
    )

    assert response.status_code == 200
    assert captured["refresh"] != "MainThread"
    assert captured["session"] != "MainThread"
