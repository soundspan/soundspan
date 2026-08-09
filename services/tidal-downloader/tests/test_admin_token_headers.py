"""Future admin endpoint contract for TIDAL credentials in request headers."""

from __future__ import annotations

import logging
import types

import pytest


def _stub_api() -> types.SimpleNamespace:
    """Return the minimal TIDAL API surface exercised by these tests."""
    return types.SimpleNamespace(
        get_search=lambda q: types.SimpleNamespace(
            tracks=types.SimpleNamespace(items=[]),
            albums=types.SimpleNamespace(items=[]),
            artists=types.SimpleNamespace(items=[]),
        ),
        get_album=lambda album_id: types.SimpleNamespace(
            title="Album",
            artist=types.SimpleNamespace(name="Artist"),
            cover=None,
        ),
        get_album_items=lambda album_id, limit=100, offset=0: types.SimpleNamespace(
            items=[], limit=100, totalNumberOfItems=0
        ),
    )


@pytest.fixture()
def api_recorder(monkeypatch):
    """Record credentials passed to the TIDAL API factory and stub downloads."""
    import app

    calls = []
    monkeypatch.setattr(
        app,
        "_build_api",
        lambda access_token, user_id, country_code: (
            calls.append((access_token, user_id, country_code)) or _stub_api()
        ),
    )
    monkeypatch.setattr(
        app,
        "_download_track_sync",
        lambda **kwargs: {
            "track_id": 1,
            "title": "t",
            "artist": "a",
            "album": "al",
            "quality": "HIGH",
            "file_path": "/x",
            "relative_path": "x",
            "file_size": 1,
        },
    )
    yield calls


@pytest.mark.anyio
async def test_search_accepts_bearer_header(client, api_recorder):
    """Search accepts a bearer token and optional TIDAL identity headers."""
    resp = await client.post(
        "/search",
        json={"query": "q"},
        headers={
            "Authorization": "Bearer tok-header",
            "x-tidal-user-id": "u1",
            "x-tidal-country-code": "DE",
        },
    )

    assert resp.status_code == 200
    assert api_recorder[-1] == ("tok-header", "u1", "DE")


@pytest.mark.anyio
async def test_search_legacy_query_params_warn_deprecated(
    client, api_recorder, caplog
):
    """Legacy search credential query parameters work with a warning."""
    with caplog.at_level(logging.WARNING):
        resp = await client.post(
            "/search?access_token=tok-q&user_id=u2&country_code=FR",
            json={"query": "q"},
        )

    assert resp.status_code == 200
    assert api_recorder[-1] == ("tok-q", "u2", "FR")
    assert "deprecated" in caplog.text.lower()


@pytest.mark.anyio
async def test_search_header_wins_over_query(client, api_recorder):
    """Search header credentials take precedence over legacy query values."""
    resp = await client.post(
        "/search?access_token=tok-q&user_id=u-query&country_code=FR",
        json={"query": "q"},
        headers={
            "Authorization": "Bearer tok-header",
            "x-tidal-user-id": "u-header",
            "x-tidal-country-code": "DE",
        },
    )

    assert resp.status_code == 200
    assert api_recorder[-1] == ("tok-header", "u-header", "DE")


@pytest.mark.anyio
async def test_search_missing_token_rejected(client, api_recorder):
    """Search rejects requests that provide no token in either location."""
    resp = await client.post("/search", json={"query": "q"})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "access_token required"


@pytest.mark.anyio
async def test_download_track_accepts_bearer_header(client, api_recorder):
    """Track download accepts a bearer token header."""
    resp = await client.post(
        "/download/track",
        json={"track_id": 1},
        headers={"Authorization": "Bearer tok-header"},
    )

    assert resp.status_code == 200
    assert api_recorder[-1][0] == "tok-header"


@pytest.mark.anyio
async def test_download_track_missing_token_rejected(client, api_recorder):
    """Track download rejects requests with no token."""
    resp = await client.post("/download/track", json={"track_id": 1})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "access_token required"


@pytest.mark.anyio
async def test_download_album_accepts_bearer_header(client, api_recorder):
    """Album download accepts a bearer token header."""
    resp = await client.post(
        "/download/album",
        json={"album_id": 2},
        headers={"Authorization": "Bearer tok-header"},
    )

    assert resp.status_code == 200
    assert resp.json()["downloaded"] == 0
    assert api_recorder[-1][0] == "tok-header"


@pytest.mark.anyio
async def test_download_album_missing_token_rejected(client, api_recorder):
    """Album download rejects requests with no token."""
    resp = await client.post("/download/album", json={"album_id": 2})

    assert resp.status_code == 401
    assert resp.json()["detail"] == "access_token required"
