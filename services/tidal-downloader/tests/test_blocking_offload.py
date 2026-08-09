"""Tests that blocking TIDAL auth/search calls run off the event-loop thread."""

from __future__ import annotations

import threading
import types

import pytest


def _fake_user() -> types.SimpleNamespace:
    """Minimal TIDAL user object returned by auth responses."""
    return types.SimpleNamespace(userId=42, countryCode="US", username="tester")


@pytest.mark.anyio
async def test_device_auth_offloaded_to_worker_thread(client, monkeypatch):
    """Device-auth initiation should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAuthAPI:
        def get_device_auth(self):
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
async def test_token_exchange_offloaded_to_worker_thread(client, monkeypatch):
    """Token exchange should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAuthAPI:
        def get_auth(self, device_code):
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
async def test_token_refresh_offloaded_to_worker_thread(client, monkeypatch):
    """Token refresh should execute in an asyncio worker thread."""
    import app

    captured = {}

    class FakeAuthAPI:
        def refresh_token(self, refresh_token):
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
async def test_search_offloaded_to_worker_thread(client, monkeypatch):
    """Admin search should execute in an asyncio worker thread."""
    import app

    captured = {}

    def _empty_results():
        return types.SimpleNamespace(
            tracks=types.SimpleNamespace(items=[]),
            albums=types.SimpleNamespace(items=[]),
            artists=types.SimpleNamespace(items=[]),
        )

    def fake_get_search(query):
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


def _session_obj() -> types.SimpleNamespace:
    """Minimal TIDAL session object returned by get_session()."""
    return types.SimpleNamespace(sessionId="s", userId=42, countryCode="US")


@pytest.mark.anyio
async def test_auth_session_offloaded_to_worker_thread(client, monkeypatch):
    """Admin session verification should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fake_get_session():
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
async def test_user_auth_restore_session_offloaded_to_worker_thread(client, monkeypatch):
    """Per-user session restore should verify the session off the event loop."""
    import app

    captured = {}

    def fake_get_session():
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
async def test_user_auth_restore_refresh_offloaded_to_worker_thread(client, monkeypatch):
    """Expired-token refresh + re-verify should both run off the event loop."""
    import app

    captured = {}

    class FakeAuthAPI:
        def refresh_token(self, refresh_token):
            captured["refresh"] = threading.current_thread().name
            return types.SimpleNamespace(access_token="at2", user=_fake_user())

    def expired_get_session():
        raise app.ApiError("expired")

    def refreshed_get_session():
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
