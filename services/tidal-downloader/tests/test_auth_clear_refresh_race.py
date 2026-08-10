"""Regression tests for logout racing a TIDAL token refresh."""

from __future__ import annotations

import asyncio
import types

import pytest
from fastapi import HTTPException


@pytest.fixture(autouse=True)
def clear_user_auth_state(local_app_module):
    """Prevent per-user auth state from leaking between race tests."""
    import app

    app._user_apis.clear()
    app._user_api_locks.clear()
    app._user_auth_state.clear()
    try:
        yield
    finally:
        app._user_apis.clear()
        app._user_api_locks.clear()
        app._user_auth_state.clear()


def _park_refresh_in_to_thread(monkeypatch, app):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def fake_to_thread(func, *args, **kwargs):
        entered.set()
        await release.wait()
        return func(*args, **kwargs)

    monkeypatch.setattr(app.asyncio, "to_thread", fake_to_thread)
    return entered, release


def _seed_refresh(monkeypatch, app):
    credentials = {
        "access_token": "old-access",
        "refresh_token": "refresh-token",
        "tidal_user_id": "tidal-user",
        "country_code": "US",
    }
    refreshed_api = types.SimpleNamespace(get_session=lambda: None)
    auth_response = types.SimpleNamespace(
        access_token="new-access",
        user=types.SimpleNamespace(userId="tidal-user", countryCode="US"),
    )
    auth_api = types.SimpleNamespace(refresh_token=lambda _token: auth_response)

    app._user_auth_state["u1"] = credentials
    monkeypatch.setattr(app, "AuthAPI", lambda: auth_api)
    monkeypatch.setattr(app, "_build_api", lambda *_args: refreshed_api)
    return refreshed_api


@pytest.mark.anyio
async def test_auth_clear_waits_for_refresh_and_remains_authoritative(monkeypatch, client):
    import app

    refreshed_api = _seed_refresh(monkeypatch, app)
    entered, release = _park_refresh_in_to_thread(monkeypatch, app)
    original_get_user_lock = app._get_user_lock
    lock_requests = 0
    clear_requested_lock = asyncio.Event()

    def observe_user_lock_request(user_id):
        nonlocal lock_requests
        lock_requests += 1
        if lock_requests == 2:
            clear_requested_lock.set()
        return original_get_user_lock(user_id)

    monkeypatch.setattr(app, "_get_user_lock", observe_user_lock_request)

    refresh_task = asyncio.create_task(app._refresh_user_api("u1"))
    await entered.wait()
    clear_task = asyncio.create_task(client.post("/user/auth/clear?user_id=u1"))
    async with asyncio.timeout(1):
        await clear_requested_lock.wait()
    await asyncio.sleep(0)

    assert not clear_task.done()

    release.set()
    assert await refresh_task is refreshed_api
    clear_response = await clear_task

    assert clear_response.status_code == 200
    assert "u1" not in app._user_apis
    assert "u1" not in app._user_auth_state
    status_response = await client.get("/user/auth/status?user_id=u1")
    assert status_response.status_code == 200
    assert status_response.json()["authenticated"] is False


@pytest.mark.anyio
async def test_refresh_does_not_restore_directly_cleared_session(monkeypatch):
    import app

    _seed_refresh(monkeypatch, app)
    entered, release = _park_refresh_in_to_thread(monkeypatch, app)

    refresh_task = asyncio.create_task(app._refresh_user_api("u1"))
    await entered.wait()
    app._invalidate_user_api("u1")
    release.set()

    with pytest.raises(HTTPException) as exc_info:
        await refresh_task

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "TIDAL session was cleared during token refresh"
    assert "u1" not in app._user_apis
    assert "u1" not in app._user_auth_state
