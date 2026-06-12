"""Tests for /home shelf filtering and YTMusic language parameter."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Sample shelf data returned by ytmusicapi's get_home()
# ---------------------------------------------------------------------------
_SAMPLE_SHELVES = [
    {
        "title": "Quick picks",
        "contents": [
            {"title": "Random Track", "videoId": "abc", "thumbnails": [], "artists": []},
        ],
    },
    {
        "title": "Listen again",
        "contents": [
            {
                "title": "Chill Vibes",
                "playlistId": "PL1",
                "thumbnails": [{"url": "http://img/1", "width": 226}],
                "artists": [{"name": "Lo-Fi Radio"}],
            },
        ],
    },
    {
        "title": "Trending",
        "contents": [
            {
                "title": "Hot Album",
                "browseId": "BR1",
                "thumbnails": [],
                "artists": [],
                "description": "New release",
            },
        ],
    },
]


# ---------------------------------------------------------------------------
# Shelf filtering tests
# ---------------------------------------------------------------------------
class TestHomeShelfFiltering:
    """Verify that YTMUSIC_HOME_FILTERED_SHELVES removes unwanted shelves."""

    @pytest.mark.anyio
    async def test_quick_picks_filtered_by_default(self, client):
        """'Quick picks' shelf should be absent from the default response."""
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = _SAMPLE_SHELVES

        with patch("app._get_public_ytmusic", return_value=mock_yt):
            resp = await client.get("/home")

        assert resp.status_code == 200
        titles = [s["title"] for s in resp.json()]
        assert "Quick picks" not in titles
        assert "Listen again" in titles
        assert "Trending" in titles

    @pytest.mark.anyio
    async def test_filtering_is_case_insensitive(self, client):
        """Shelves with varying case should still be filtered."""
        shelves = [
            {"title": "QUICK PICKS", "contents": [{"title": "X", "videoId": "v1", "thumbnails": [], "artists": []}]},
            {"title": "Trending", "contents": [{"title": "Y", "browseId": "b1", "thumbnails": [], "artists": []}]},
        ]
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = shelves

        with patch("app._get_public_ytmusic", return_value=mock_yt):
            resp = await client.get("/home")

        assert resp.status_code == 200
        titles = [s["title"] for s in resp.json()]
        assert "QUICK PICKS" not in titles
        assert "Trending" in titles

    @pytest.mark.anyio
    async def test_custom_filtered_shelves_via_env(self, client):
        """Patching the filter set should allow custom shelf exclusion."""
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = _SAMPLE_SHELVES

        custom_filter = {"trending"}
        with (
            patch("app._get_public_ytmusic", return_value=mock_yt),
            patch("app.YTMUSIC_HOME_FILTERED_SHELVES", custom_filter),
        ):
            resp = await client.get("/home")

        assert resp.status_code == 200
        titles = [s["title"] for s in resp.json()]
        assert "Trending" not in titles
        # Quick picks should pass through now since it's not in the custom set
        assert "Quick picks" in titles

    @pytest.mark.anyio
    async def test_empty_filter_set_passes_all_shelves(self, client):
        """An empty filter set should let all shelves through."""
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = _SAMPLE_SHELVES

        with (
            patch("app._get_public_ytmusic", return_value=mock_yt),
            patch("app.YTMUSIC_HOME_FILTERED_SHELVES", set()),
        ):
            resp = await client.get("/home")

        assert resp.status_code == 200
        titles = [s["title"] for s in resp.json()]
        assert "Quick picks" in titles
        assert "Listen again" in titles
        assert "Trending" in titles


# ---------------------------------------------------------------------------
# Home item type extraction tests
# ---------------------------------------------------------------------------
class TestHomeItemTypeField:
    """Verify that item type is extracted from raw ytmusicapi responses."""

    @pytest.mark.anyio
    async def test_home_items_include_type_from_resultType(self, client):
        """Items with resultType should have a type field in the response."""
        shelves = [
            {
                "title": "Albums for you",
                "contents": [
                    {
                        "title": "Great Album",
                        "browseId": "MPREb_abc123",
                        "thumbnails": [{"url": "http://img/album", "width": 226}],
                        "artists": [{"name": "Artist X"}],
                        "resultType": "album",
                    },
                    {
                        "title": "Fun Playlist",
                        "playlistId": "RDCLAK5uy",
                        "thumbnails": [],
                        "artists": [],
                        "resultType": "playlist",
                    },
                ],
            },
        ]
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = shelves

        with (
            patch("app._get_public_ytmusic", return_value=mock_yt),
            patch("app.YTMUSIC_HOME_FILTERED_SHELVES", set()),
        ):
            resp = await client.get("/home")

        assert resp.status_code == 200
        contents = resp.json()[0]["contents"]
        assert contents[0]["type"] == "album"
        assert contents[1]["type"] == "playlist"

    @pytest.mark.anyio
    async def test_home_items_omit_type_when_missing(self, client):
        """Items without resultType/type should not have a type field."""
        shelves = [
            {
                "title": "Mixed",
                "contents": [
                    {
                        "title": "No Type Item",
                        "videoId": "vid1",
                        "thumbnails": [],
                        "artists": [],
                    },
                ],
            },
        ]
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = shelves

        with (
            patch("app._get_public_ytmusic", return_value=mock_yt),
            patch("app.YTMUSIC_HOME_FILTERED_SHELVES", set()),
        ):
            resp = await client.get("/home")

        assert resp.status_code == 200
        contents = resp.json()[0]["contents"]
        assert "type" not in contents[0]

    @pytest.mark.anyio
    async def test_home_items_use_type_field_fallback(self, client):
        """Items with 'type' instead of 'resultType' should still get type."""
        shelves = [
            {
                "title": "New releases",
                "contents": [
                    {
                        "title": "Single Release",
                        "browseId": "MPREb_xyz",
                        "thumbnails": [],
                        "artists": [],
                        "type": "Album",
                    },
                ],
            },
        ]
        mock_yt = MagicMock()
        mock_yt.get_home.return_value = shelves

        with (
            patch("app._get_public_ytmusic", return_value=mock_yt),
            patch("app.YTMUSIC_HOME_FILTERED_SHELVES", set()),
        ):
            resp = await client.get("/home")

        assert resp.status_code == 200
        contents = resp.json()[0]["contents"]
        assert contents[0]["type"] == "album"


# ---------------------------------------------------------------------------
# Browse album endpoint tests
# ---------------------------------------------------------------------------
_SAMPLE_ALBUM_RESPONSE = {
    "title": "Test Album",
    "artists": [{"name": "Test Artist", "id": "UC123"}],
    "year": "2024",
    "trackCount": 2,
    "duration": "25 minutes",
    "type": "Album",
    "thumbnails": [
        {"url": "http://img/small", "width": 120, "height": 120},
        {"url": "http://img/large", "width": 500, "height": 500},
    ],
    "description": "A great album",
    "tracks": [
        {
            "videoId": "vid1",
            "title": "Track One",
            "artists": [{"name": "Test Artist"}],
            "trackNumber": 1,
            "duration": "3:45",
            "duration_seconds": 225,
            "isExplicit": False,
            "likeStatus": None,
        },
        {
            "videoId": "vid2",
            "title": "Track Two",
            "artists": [{"name": "Test Artist"}, {"name": "Featured"}],
            "trackNumber": 2,
            "duration": "4:10",
            "duration_seconds": 250,
            "isExplicit": True,
            "likeStatus": "LIKE",
        },
    ],
}


class TestBrowseAlbumEndpoint:
    """Verify the /browse-album/{browse_id} public endpoint."""

    @pytest.mark.anyio
    async def test_browse_album_returns_formatted_data(self, client):
        """Should return formatted album data without requiring auth."""
        mock_yt = MagicMock()
        mock_yt.get_album.return_value = _SAMPLE_ALBUM_RESPONSE

        with patch("app._get_public_ytmusic", return_value=mock_yt):
            resp = await client.get("/browse-album/MPREb_test123")

        assert resp.status_code == 200
        data = resp.json()
        assert data["browseId"] == "MPREb_test123"
        assert data["title"] == "Test Album"
        assert data["artist"] == "Test Artist"
        assert data["artists"] == ["Test Artist"]
        assert data["year"] == "2024"
        assert data["trackCount"] == 2
        assert data["coverUrl"] == "http://img/large"
        assert len(data["tracks"]) == 2
        assert data["tracks"][0]["videoId"] == "vid1"
        assert data["tracks"][0]["artist"] == "Test Artist"
        assert data["tracks"][1]["artists"] == ["Test Artist", "Featured"]
        mock_yt.get_album.assert_called_once_with("MPREb_test123")

    @pytest.mark.anyio
    async def test_browse_album_not_found_returns_404(self, client):
        """Should return 404 when get_album raises a 'not found' exception."""
        mock_yt = MagicMock()
        mock_yt.get_album.side_effect = Exception("Unable to find 'contents'")

        with patch("app._get_public_ytmusic", return_value=mock_yt):
            resp = await client.get("/browse-album/MPREb_bad")

        assert resp.status_code == 404

    @pytest.mark.anyio
    async def test_browse_album_unexpected_error_returns_500(self, client):
        """Should return 500 for unexpected non-not-found errors."""
        mock_yt = MagicMock()
        mock_yt.get_album.side_effect = Exception("Connection timeout")

        with patch("app._get_public_ytmusic", return_value=mock_yt):
            resp = await client.get("/browse-album/MPREb_bad")

        assert resp.status_code == 500


# ---------------------------------------------------------------------------
# Language parameter tests
# ---------------------------------------------------------------------------
class TestYTMusicLanguageParam:
    """Verify that YTMUSIC_LANGUAGE is forwarded to YTMusic constructors."""

    def test_language_passed_to_public_ytmusic(self):
        """Public (unauthenticated) YTMusic should receive language kwarg."""
        from app import _public_ytmusic_instances

        # Clear cached instances so _get_public_ytmusic creates a new one
        _public_ytmusic_instances.clear()

        with patch("app.YTMusic") as MockYTMusic:
            MockYTMusic.return_value = MagicMock()
            from app import _get_public_ytmusic

            _get_public_ytmusic("native")

            MockYTMusic.assert_called_once()
            _, kwargs = MockYTMusic.call_args
            assert "language" in kwargs
            assert kwargs["language"] == "en"

        # Clean up
        _public_ytmusic_instances.clear()

    def test_language_passed_to_authenticated_ytmusic(self):
        """Authenticated (per-user) YTMusic should receive language kwarg."""
        import json

        from app import _ytmusic_instances

        user_id = "test-user-lang"
        _ytmusic_instances.pop(user_id, None)

        fake_oauth = json.dumps({"access_token": "fake", "token_type": "Bearer"})

        # Simulate no client_creds file — scope __truediv__ to DATA_PATH only
        creds_path = MagicMock()
        creds_path.exists.return_value = False
        mock_data_path = MagicMock()
        mock_data_path.__truediv__ = MagicMock(return_value=creds_path)

        with (
            patch("app.YTMusic") as MockYTMusic,
            patch("app._oauth_file") as mock_oauth_file,
            patch("app.DATA_PATH", mock_data_path),
        ):
            MockYTMusic.return_value = MagicMock()

            mock_path = MagicMock()
            mock_path.exists.return_value = True
            mock_path.read_text.return_value = fake_oauth
            mock_oauth_file.return_value = mock_path

            from app import _get_ytmusic

            _get_ytmusic(user_id)

            MockYTMusic.assert_called_once()
            call_args = MockYTMusic.call_args
            assert "language" in call_args.kwargs
            assert call_args.kwargs["language"] == "en"

        # Clean up
        _ytmusic_instances.pop(user_id, None)
