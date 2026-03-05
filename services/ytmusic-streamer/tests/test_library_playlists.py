"""Tests for /library/playlists endpoint."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Sample data returned by ytmusicapi's get_library_playlists()
# ---------------------------------------------------------------------------
_SAMPLE_PLAYLISTS = [
    {
        "playlistId": "RDTMAK5uy_abc123",
        "title": "My Supermix",
        "thumbnails": [
            {"url": "http://img/small", "width": 120},
            {"url": "http://img/large", "width": 226},
        ],
        "count": "50+ songs",
        "description": "A mix of everything you love",
        "author": [{"name": "YouTube Music"}],
    },
    {
        "playlistId": "RDEM_fresh456",
        "title": "Fresh finds, old favorites",
        "thumbnails": [{"url": "http://img/fresh", "width": 226}],
        "count": "50+ songs",
        "description": "Rediscover old gems alongside new picks",
        "author": [{"name": "YouTube Music"}],
    },
    {
        "playlistId": "PLuserlist789",
        "title": "My Custom Playlist",
        "thumbnails": [{"url": "http://img/custom", "width": 226}],
        "count": "12 songs",
        "description": "",
        "author": [{"name": "Josh"}],
    },
    {
        "playlistId": "LM",
        "title": "Liked Music",
        "thumbnails": [],
        "count": "200 songs",
        "description": "All your liked songs",
        "author": [{"name": "YouTube Music"}],
    },
    {
        "playlistId": "SE",
        "title": "Episodes for Later",
        "thumbnails": [],
        "count": "5 episodes",
        "description": "",
        "author": [{"name": "YouTube Music"}],
    },
]


class TestLibraryPlaylists:
    """Verify /library/playlists returns user's library playlists."""

    @pytest.mark.anyio
    async def test_returns_playlists_for_authenticated_user(self, client):
        """Should return formatted playlist data for an authenticated user."""
        mock_run = MagicMock(side_effect=lambda uid, operation, func: func(MagicMock(
            get_library_playlists=MagicMock(return_value=_SAMPLE_PLAYLISTS)
        )))

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            resp = await client.get("/library/playlists", params={"user_id": "user-1"})

        assert resp.status_code == 200
        data = resp.json()
        assert "playlists" in data
        assert data["total"] == len(_SAMPLE_PLAYLISTS)
        # Verify shape of first item
        first = data["playlists"][0]
        assert first["playlistId"] == "RDTMAK5uy_abc123"
        assert first["title"] == "My Supermix"
        assert first["thumbnails"] == _SAMPLE_PLAYLISTS[0]["thumbnails"]
        assert first["description"] == "A mix of everything you love"

    @pytest.mark.anyio
    async def test_returns_401_when_no_oauth(self, client):
        """Should return 401 when user has no OAuth credentials."""
        from fastapi import HTTPException

        def raise_401(uid, operation, func):
            raise HTTPException(status_code=401, detail="No OAuth credentials")

        with patch("app._run_ytmusic_with_auth_retry", side_effect=raise_401):
            resp = await client.get("/library/playlists", params={"user_id": "no-auth-user"})

        assert resp.status_code == 401

    @pytest.mark.anyio
    async def test_requires_user_id_parameter(self, client):
        """Should return 422 when user_id is missing."""
        resp = await client.get("/library/playlists")
        assert resp.status_code == 422

    @pytest.mark.anyio
    async def test_passes_limit_to_ytmusicapi(self, client):
        """Should forward the limit parameter to get_library_playlists."""
        captured_calls = []

        def capture_run(uid, operation, func):
            mock_yt = MagicMock()
            mock_yt.get_library_playlists.return_value = []
            result = func(mock_yt)
            captured_calls.append(mock_yt.get_library_playlists.call_args)
            return result

        with patch("app._run_ytmusic_with_auth_retry", side_effect=capture_run):
            resp = await client.get("/library/playlists", params={"user_id": "user-1", "limit": 10})

        assert resp.status_code == 200
        assert captured_calls[0] == ((10,),) or captured_calls[0].kwargs.get("limit") == 10

    @pytest.mark.anyio
    async def test_mixes_only_filter(self, client):
        """When mixes_only=true, should filter to auto-generated playlists only."""
        mock_run = MagicMock(side_effect=lambda uid, operation, func: func(MagicMock(
            get_library_playlists=MagicMock(return_value=_SAMPLE_PLAYLISTS)
        )))

        with patch("app._run_ytmusic_with_auth_retry", mock_run):
            resp = await client.get(
                "/library/playlists",
                params={"user_id": "user-1", "mixes_only": "true"},
            )

        assert resp.status_code == 200
        data = resp.json()
        # Should exclude user-created playlists and special IDs (LM, SE)
        titles = [p["title"] for p in data["playlists"]]
        assert "My Supermix" in titles
        assert "Fresh finds, old favorites" in titles
        assert "My Custom Playlist" not in titles
        assert "Liked Music" not in titles
        assert "Episodes for Later" not in titles
