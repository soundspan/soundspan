"""Future contract for sanitizing internal errors in HTTP responses."""

from __future__ import annotations

import logging
import types
from typing import Any

import pytest
from httpx import AsyncClient

MARKER = "sekrit-token-abc123"


@pytest.mark.anyio
async def test_auth_device_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Device-auth failures are logged without exposing internal details."""
    import app

    class FailingAuthAPI:
        def get_device_auth(self) -> Any:
            raise Exception(MARKER)

    monkeypatch.setattr(app, "AuthAPI", FailingAuthAPI)

    with caplog.at_level(logging.ERROR, logger="tidal-streamer"):
        resp = await client.post("/auth/device")

    assert resp.status_code == 500
    assert MARKER not in resp.text
    assert MARKER in caplog.text


@pytest.mark.anyio
async def test_auth_session_api_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Session API errors are logged without exposing internal details."""
    import app

    def _raise_api_error(*_args: Any, **_kwargs: Any) -> Any:
        raise app.ApiError(MARKER)

    monkeypatch.setattr(app, "_build_api", _raise_api_error)

    with caplog.at_level(logging.ERROR, logger="tidal-streamer"):
        resp = await client.post(
            "/auth/session",
            json={"access_token": "a", "user_id": "u", "country_code": "US"},
        )

    assert resp.status_code == 401
    assert MARKER not in resp.text
    assert MARKER in caplog.text


@pytest.mark.anyio
async def test_search_api_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Search API errors are logged without exposing internal details."""
    import app

    def _raise_api_error(_query: Any) -> Any:
        raise app.ApiError(MARKER)

    monkeypatch.setattr(
        app,
        "_build_api",
        lambda *_args, **_kwargs: types.SimpleNamespace(get_search=_raise_api_error),
    )

    with caplog.at_level(logging.ERROR, logger="tidal-streamer"):
        resp = await client.post(
            "/search?access_token=t&user_id=u&country_code=US",
            json={"query": "q"},
        )

    assert resp.status_code == 500
    assert MARKER not in resp.text
    assert MARKER in caplog.text


@pytest.mark.anyio
async def test_user_auth_restore_failure_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Credential restore failures expose neither session nor refresh details."""
    import app

    def _raise_api_error() -> Any:
        raise app.ApiError(MARKER)

    class FailingAuthAPI:
        def refresh_token(self, _refresh_token: Any) -> Any:
            raise Exception("refresh-marker-xyz")

    monkeypatch.setattr(
        app,
        "_build_api",
        lambda *_args, **_kwargs: types.SimpleNamespace(get_session=_raise_api_error),
    )
    monkeypatch.setattr(app, "AuthAPI", FailingAuthAPI)

    with caplog.at_level(logging.WARNING, logger="tidal-streamer"):
        resp = await client.post(
            "/user/auth/restore?user_id=u1",
            json={
                "access_token": "a",
                "refresh_token": "r",
                "user_id": "tu",
                "country_code": "US",
            },
        )

    assert resp.status_code == 401
    assert MARKER not in resp.text
    assert "refresh-marker-xyz" not in resp.text
    assert MARKER in caplog.text


@pytest.mark.anyio
async def test_browse_home_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Browse-home failures are logged without exposing internal details."""
    import app

    def _boom() -> Any:
        raise Exception(MARKER)

    monkeypatch.setattr(
        app,
        "_build_browse_session",
        lambda user_id, quality=None: types.SimpleNamespace(home=_boom),
    )

    with caplog.at_level(logging.ERROR, logger="tidal-streamer"):
        resp = await client.get("/user/browse/home?user_id=u1")

    assert resp.status_code == 500
    assert MARKER not in resp.text
    assert MARKER in caplog.text


@pytest.mark.anyio
async def test_download_album_per_track_error_sanitized(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Per-track album failures are logged without exposing internal details."""
    import app

    api = types.SimpleNamespace(
        get_album=lambda album_id: types.SimpleNamespace(
            title="Album",
            artist=types.SimpleNamespace(name="Artist"),
            cover=None,
        ),
        get_album_items=lambda album_id, limit=100, offset=0: types.SimpleNamespace(
            items=[types.SimpleNamespace(item=types.SimpleNamespace(isrc="x", id=11, title="T"))],
            limit=100,
            totalNumberOfItems=1,
        ),
    )

    def _raise_download_error(**_kwargs: Any) -> Any:
        raise Exception(MARKER)

    monkeypatch.setattr(app, "_build_api", lambda *_args, **_kwargs: api)
    monkeypatch.setattr(app, "_download_track_sync", _raise_download_error)

    with caplog.at_level(logging.ERROR, logger="tidal-streamer"):
        resp = await client.post(
            "/download/album?access_token=t&user_id=u",
            json={"album_id": 2},
        )

    assert resp.status_code == 200
    assert MARKER not in resp.json()["errors"][0]["error"]
    assert MARKER in caplog.text
