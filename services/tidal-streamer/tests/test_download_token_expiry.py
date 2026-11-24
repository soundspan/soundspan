"""Download routes report an expired TIDAL token as 401 so callers refresh."""

from __future__ import annotations

from typing import Any

import pytest
from httpx import AsyncClient

HEADERS = {"Authorization": "Bearer tok-header"}


def _api_error(status: int, sub_status: int, message: str) -> Exception:
    """Build the TIDAL API error the route catches, carrying TIDAL's codes."""
    from tiddl.core.api import ApiError

    error: Exception = ApiError(message)
    vars(error).update(status=status, sub_status=sub_status)
    return error


def _raise(error: Exception) -> Any:
    def _download(*_args: Any, **_kwargs: Any) -> Any:
        raise error

    return _download


@pytest.mark.anyio
async def test_download_track_reports_expired_token_as_401(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backend refreshes the admin token and retries only on a 401."""
    import tidal_download_routes

    expired = _api_error(401, 11003, "The token has expired. (Expired on time)")
    monkeypatch.setattr(tidal_download_routes, "_download_track_sync", _raise(expired))

    resp = await client.post("/download/track", json={"track_id": 1}, headers=HEADERS)

    assert resp.status_code == 401
    assert "expired" not in resp.text.lower()


@pytest.mark.anyio
async def test_download_track_keeps_400_for_other_api_errors(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A track TIDAL refuses for other reasons is not a credential problem."""
    import tidal_download_routes

    not_found = _api_error(404, 2001, "Track not found")
    monkeypatch.setattr(tidal_download_routes, "_download_track_sync", _raise(not_found))

    resp = await client.post("/download/track", json={"track_id": 1}, headers=HEADERS)

    assert resp.status_code == 400


@pytest.mark.anyio
async def test_download_album_reports_expired_token_as_401(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Album downloads refresh the same way as single tracks."""
    import tidal_download_routes

    expired = _api_error(401, 11003, "The token has expired. (Expired on time)")
    monkeypatch.setattr(tidal_download_routes, "_get_album_with_tracks", _raise(expired))

    resp = await client.post("/download/album", json={"album_id": 1}, headers=HEADERS)

    assert resp.status_code == 401
