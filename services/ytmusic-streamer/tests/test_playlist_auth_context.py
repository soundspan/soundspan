"""Regression tests for /playlist auth-context handling."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException


@pytest.mark.anyio
async def test_playlist_uses_user_context_when_user_id_provided(client):
    """Owned/private playlists must be fetched with the caller's OAuth context."""
    playlist_payload = {
        "title": "Owned Playlist",
        "description": "Private list",
        "trackCount": 1,
        "thumbnails": [],
        "tracks": [
            {
                "videoId": "vid-owned-1",
                "title": "Owned Song",
                "artists": [{"name": "Owner Artist"}],
                "album": {"name": "Owner Album"},
                "duration": "3:21",
                "thumbnails": [],
            }
        ],
    }

    with patch(
        "app._run_ytmusic_with_auth_retry", return_value=playlist_payload
    ) as auth_retry:
        response = await client.get("/playlist/PLowned123", params={"user_id": "user-1"})

    assert response.status_code == 200
    assert auth_retry.call_count == 1
    assert auth_retry.call_args.args[0] == "user-1"
    body = response.json()
    assert body["title"] == "Owned Playlist"
    assert body["tracks"][0]["videoId"] == "vid-owned-1"


@pytest.mark.anyio
async def test_playlist_falls_back_to_public_when_authenticated_fetch_fails(client):
    """If authenticated browse fails, playlist fetch should retry via public client."""
    public_yt = MagicMock()
    public_yt.get_playlist.return_value = {
        "title": "Public Playlist",
        "description": "",
        "trackCount": 1,
        "thumbnails": [],
        "tracks": [
            {
                "videoId": "vid-public-1",
                "title": "Public Song",
                "artists": [{"name": "Public Artist"}],
                "album": {"name": "Public Album"},
                "duration": "2:58",
                "thumbnails": [],
            }
        ],
    }

    with (
        patch(
            "app._run_ytmusic_with_auth_retry",
            side_effect=RuntimeError("oauth expired"),
        ) as auth_retry,
        patch("app._get_public_ytmusic", return_value=public_yt) as public_getter,
    ):
        response = await client.get("/playlist/PLfallback123", params={"user_id": "user-1"})

    assert response.status_code == 200
    assert auth_retry.call_count == 1
    assert auth_retry.call_args.args[0] == "user-1"
    public_getter.assert_called_once_with("native")
    body = response.json()
    assert body["title"] == "Public Playlist"
    assert body["tracks"][0]["videoId"] == "vid-public-1"


@pytest.mark.anyio
async def test_playlist_returns_401_when_auth_is_invalid_and_public_fallback_also_fails(
    client,
):
    """Preserve actionable OAuth errors for owned/private playlists."""
    public_yt = MagicMock()
    public_yt.get_playlist.side_effect = RuntimeError("public lookup failed")

    with (
        patch(
            "app._run_ytmusic_with_auth_retry",
            side_effect=HTTPException(status_code=401, detail="OAuth credentials invalid"),
        ),
        patch("app._get_public_ytmusic", return_value=public_yt),
    ):
        response = await client.get("/playlist/PLprivate123", params={"user_id": "user-1"})

    assert response.status_code == 401
    assert response.json()["detail"] == "OAuth credentials invalid"


@pytest.mark.anyio
async def test_playlist_preserves_non_401_auth_http_errors_when_public_fallback_fails(
    client,
):
    """Authenticated HTTP errors should remain actionable (not collapsed to 500)."""
    public_yt = MagicMock()
    public_yt.get_playlist.side_effect = RuntimeError("public lookup failed")

    with (
        patch(
            "app._run_ytmusic_with_auth_retry",
            side_effect=HTTPException(status_code=403, detail="OAuth lacks required scope"),
        ),
        patch("app._get_public_ytmusic", return_value=public_yt),
    ):
        response = await client.get("/playlist/PLprivate403", params={"user_id": "user-1"})

    assert response.status_code == 403
    assert response.json()["detail"] == "OAuth lacks required scope"
