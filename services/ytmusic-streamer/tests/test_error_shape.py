"""HTTP error response-shape contract tests."""

from __future__ import annotations

import pytest
from fastapi import HTTPException


VALID_ID = "dQw4w9WgXcQ"


@pytest.mark.anyio
async def test_http_exception_uses_error_key(client):
    """String HTTPException details are exposed through the error key."""
    response = await client.get("/stream/bad?user_id=u1")

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid video_id"}
    assert "detail" not in response.json()


@pytest.mark.anyio
async def test_unhandled_exception_returns_sanitized_error(client, monkeypatch):
    """Unhandled exceptions return a generic body without leaking details."""
    import app

    def raise_unhandled(*_args, **_kwargs):
        raise Exception("SECRET-LEAK-XYZ")

    monkeypatch.setattr(app, "_get_stream_url_sync", raise_unhandled)
    client._transport.raise_app_exceptions = False

    response = await client.get(f"/stream/{VALID_ID}?user_id=__public__")

    assert response.status_code == 500
    assert response.json() == {"error": "Internal Server Error"}
    assert "SECRET-LEAK-XYZ" not in response.text


@pytest.mark.anyio
async def test_nested_http_exception_detail_is_preserved(client, monkeypatch):
    """Structured HTTPException details retain their top-level fields."""
    import app

    def raise_age_restricted(*_args, **_kwargs):
        raise HTTPException(
            status_code=451,
            detail={
                "error": "age_restricted",
                "message": "m",
                "video_id": "v",
            },
        )

    monkeypatch.setattr(app, "_get_stream_url_sync", raise_age_restricted)

    response = await client.get(f"/stream/{VALID_ID}?user_id=__public__")

    assert response.status_code == 451
    assert response.json()["error"] == "age_restricted"
    assert response.json()["message"] == "m"
