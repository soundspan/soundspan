"""Behavioral coverage for the split TIDAL sidecar module boundaries."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.routing import APIRoute
from httpx import AsyncClient


def test_entrypoint_assembles_routes_from_each_boundary_module() -> None:
    """The entrypoint exposes one app assembled from every route boundary."""
    import app
    import tidal_auth
    import tidal_browse
    import tidal_download_routes
    import tidal_lifecycle
    import tidal_search
    import tidal_stream

    expected_modules = {
        "/health": tidal_lifecycle.__name__,
        "/auth/device": tidal_auth.__name__,
        "/user/auth/status": tidal_auth.__name__,
        "/search": tidal_search.__name__,
        "/user/search": tidal_search.__name__,
        "/download/track": tidal_download_routes.__name__,
        "/user/stream/{track_id}": tidal_stream.__name__,
        "/user/browse/home": tidal_browse.__name__,
    }
    endpoints = {
        route.path: route.endpoint for route in app.app.routes if isinstance(route, APIRoute)
    }

    assert all(endpoints[path].__module__ == module for path, module in expected_modules.items())


@pytest.mark.anyio
async def test_entrypoint_routes_preserve_cross_module_overrides(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Overrides on the entrypoint reach handlers owned by split modules."""
    import app

    async def fake_user_api_call(*_args: Any, **_kwargs: Any) -> Any:
        class Results:
            tracks = type("Items", (), {"items": []})()
            albums = type("Items", (), {"items": []})()
            artists = type("Items", (), {"items": []})()

        return Results()

    monkeypatch.setattr(app, "_run_user_api_call", fake_user_api_call)

    response = await client.post("/user/search?user_id=boundary", json={"query": "x"})

    assert response.status_code == 200
    assert response.json() == {"tracks": [], "albums": [], "artists": []}
