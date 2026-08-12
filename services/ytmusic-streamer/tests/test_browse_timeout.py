"""Tests for bounded public ytmusicapi browse calls."""

from __future__ import annotations

import time
import types
from typing import Any

import pytest
from httpx import AsyncClient

VIDEO_ID = "dQw4w9WgXcQ"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "method_name"),
    [
        ("/album/x", "get_album"),
        ("/artist/x", "get_artist"),
        (f"/song/{VIDEO_ID}", "get_song"),
    ],
)
async def test_slow_public_browse_returns_504(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, path: Any, method_name: str
) -> None:
    """A stalled public metadata browse should return HTTP 504."""
    import app

    def slow_browse(_identifier: Any) -> Any:
        time.sleep(0.5)
        return {}

    public_client = types.SimpleNamespace(**{method_name: slow_browse})
    monkeypatch.setattr(app, "BROWSE_TIMEOUT", 0.05)
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get(f"{path}?user_id=__public__")

    assert response.status_code == 504
    assert response.json()["error"] == "YouTube Music request timed out"


@pytest.mark.anyio
async def test_fast_public_album_browse_preserves_response_shape(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fast public album browse should retain the existing success response."""
    import app

    public_client = types.SimpleNamespace(
        get_album=lambda browse_id: {
            "title": "t",
            "artists": [],
            "thumbnails": [],
            "tracks": [],
        }
    )
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/album/x?user_id=__public__")

    assert response.status_code == 200
    assert response.json() == {
        "browseId": "x",
        "title": "t",
        "artist": "Unknown",
        "artists": [],
        "year": None,
        "trackCount": None,
        "duration": None,
        "type": "Album",
        "thumbnails": [],
        "coverUrl": None,
        "tracks": [],
        "description": None,
    }
