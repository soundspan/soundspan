"""Behavioral coverage for the split sidecar module boundaries."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient


def test_entrypoint_assembles_routes_from_each_boundary_module() -> None:
    """The entrypoint exposes one app assembled from every route boundary."""
    import app
    import ytmusic_auth
    import ytmusic_browse
    import ytmusic_downloads
    import ytmusic_library
    import ytmusic_lifecycle
    import ytmusic_search
    import ytmusic_stream

    expected_modules = {
        "/health": ytmusic_lifecycle.__name__,
        "/auth/status": ytmusic_auth.__name__,
        "/search": ytmusic_search.__name__,
        "/album/{browse_id}": ytmusic_library.__name__,
        "/stream/{video_id}": ytmusic_stream.__name__,
        "/yt/download": ytmusic_downloads.__name__,
        "/home": ytmusic_browse.__name__,
    }
    endpoints = {
        route.path: route.endpoint for route in app.app.routes if isinstance(route, APIRoute)
    }

    assert all(endpoints[path].__module__ == module for path, module in expected_modules.items())


@pytest.mark.anyio
async def test_entrypoint_routes_preserve_cross_module_overrides(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Overrides on the entrypoint reach handlers owned by split modules."""
    import app

    async def no_download(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "_search_with_mode_fallback", lambda *_args, **_kwargs: ([], "native"))
    monkeypatch.setattr(app, "_run_yt_download_job", no_download)
    monkeypatch.setattr(app, "YT_DOWNLOAD_DIR", str(tmp_path))
    app._yt_download_jobs.clear()

    search_response = await client.post("/search?user_id=boundary", json={"query": "x"})
    download_response = await client.post(
        "/yt/download",
        json={"video_id": "boundary001", "format": "mp3", "quality": "HIGH"},
    )

    assert search_response.status_code == 200
    assert search_response.json() == {"results": [], "total": 0}
    assert download_response.status_code == 200
    assert download_response.json()["status"] == "queued"
