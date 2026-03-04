"""Tests for TIDAL browse endpoints (tidalapi-based).

These tests cover the browse serialization helpers and HTTP endpoints
that use tidalapi.Session for browsing TIDAL's catalog. All tests are
written against the intended API contract and should FAIL until the
corresponding implementation is added to app.py.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


# ═══════════════════════════════════════════════════════════════════════
# Mock factory helpers
# ═══════════════════════════════════════════════════════════════════════

def _make_mock_track(
    *,
    track_id: int = 100,
    name: str = "Test Track",
    artist_name: str = "Test Artist",
    album_name: str = "Test Album",
    duration: int = 210,
    isrc: str = "USRC12300001",
) -> MagicMock:
    """Build a mock tidalapi Track object."""
    track = MagicMock()
    track.id = track_id
    track.name = name
    track.duration = duration
    track.isrc = isrc

    artist = MagicMock()
    artist.name = artist_name
    track.artist = artist
    track.artists = [artist]

    album = MagicMock()
    album.name = album_name
    track.album = album

    return track


def _make_mock_playlist(
    *,
    uuid: str = "aaaa-bbbb-cccc-dddd",
    name: str = "My Playlist",
    image_id: str = "ab67616d-0000-b273-1234567890ab",
    num_tracks: int = 25,
    tracks: list | None = None,
) -> object:
    """Build a mock tidalapi Playlist object."""
    playlist = type("Playlist", (), {})()
    playlist.id = uuid
    playlist.name = name
    playlist.num_tracks = num_tracks
    playlist.image = MagicMock(
        return_value=(
            f"https://resources.tidal.com/images/"
            f"{image_id.replace('-', '/')}/320x320.jpg"
        )
    )
    playlist.tracks = MagicMock(return_value=tracks or [])
    return playlist


def _make_mock_mix(
    *,
    mix_id: str = "mix-001",
    title: str = "Daily Discovery",
    sub_title: str = "For You",
    image_id: str = "ab67616d-0000-b273-1234567890ab",
) -> object:
    """Build a mock tidalapi Mix object."""
    mix = type("Mix", (), {})()
    mix.id = mix_id
    mix.title = title
    mix.sub_title = sub_title
    mix.image = MagicMock(
        return_value=(
            f"https://resources.tidal.com/images/"
            f"{image_id.replace('-', '/')}/320x320.jpg"
        )
    )
    mix.items = MagicMock(return_value=[_make_mock_track()])
    return mix


def _make_mock_category(
    *,
    title: str = "Shelf Title",
    items: list | None = None,
) -> MagicMock:
    """Build a mock tidalapi PageCategory (shelf)."""
    cat = MagicMock()
    cat.title = title
    cat.items = items or []
    return cat


def _make_mock_page(categories: list | None = None) -> MagicMock:
    """Build a mock tidalapi Page object with categories."""
    page = MagicMock()
    page.categories = categories or []
    return page


def _make_mock_genre(
    *,
    name: str = "Pop",
    path: str = "pop",
    image: str = "img-pop",
) -> MagicMock:
    """Build a mock tidalapi Genre object."""
    genre = MagicMock()
    genre.name = name
    genre.path = path
    genre.api_path = path
    genre.image = image
    genre.has_playlists = True
    return genre


# ═══════════════════════════════════════════════════════════════════════
# 1. _tidal_image_url serialization
# ═══════════════════════════════════════════════════════════════════════

class TestTidalImageUrl:
    """Verify UUID-to-URL conversion for TIDAL image resources."""

    def test_basic_uuid_conversion(self):
        """Dashes in the image UUID should be replaced with slashes."""
        from app import _tidal_image_url

        result = _tidal_image_url(
            "ab67616d-0000-b273-1234567890ab", w=480, h=480
        )
        assert result == (
            "https://resources.tidal.com/images/"
            "ab67616d/0000/b273/1234567890ab/480x480.jpg"
        )

    def test_different_dimensions(self):
        """Different width/height should be reflected in the URL."""
        from app import _tidal_image_url

        result = _tidal_image_url(
            "ab67616d-0000-b273-1234567890ab", w=1280, h=1280
        )
        assert result == (
            "https://resources.tidal.com/images/"
            "ab67616d/0000/b273/1234567890ab/1280x1280.jpg"
        )

    def test_rectangular_dimensions(self):
        """Non-square dimensions should be supported."""
        from app import _tidal_image_url

        result = _tidal_image_url(
            "ab67616d-0000-b273-1234567890ab", w=640, h=480
        )
        assert result == (
            "https://resources.tidal.com/images/"
            "ab67616d/0000/b273/1234567890ab/640x480.jpg"
        )

    def test_none_image_id_returns_none(self):
        """A None image UUID should return None (no crash)."""
        from app import _tidal_image_url

        result = _tidal_image_url(None, w=480, h=480)
        assert result is None

    def test_empty_string_image_id_returns_none(self):
        """An empty string image UUID should return None."""
        from app import _tidal_image_url

        result = _tidal_image_url("", w=480, h=480)
        assert result is None


# ═══════════════════════════════════════════════════════════════════════
# 2. _serialize_page
# ═══════════════════════════════════════════════════════════════════════

class TestSerializePage:
    """Verify that a tidalapi Page is serialized to shelf format."""

    def test_page_with_categories_returns_shelves(self):
        """Each Page category should become a shelf dict."""
        from app import _serialize_page

        playlist = _make_mock_playlist()
        cat = _make_mock_category(title="Top Playlists", items=[playlist])
        page = _make_mock_page(categories=[cat])

        result = _serialize_page(page)

        assert isinstance(result, list)
        assert len(result) == 1
        assert result[0]["title"] == "Top Playlists"
        assert isinstance(result[0]["contents"], list)
        assert len(result[0]["contents"]) >= 1

    def test_empty_page_returns_empty_list(self):
        """A page with no categories should produce an empty list."""
        from app import _serialize_page

        page = _make_mock_page(categories=[])
        result = _serialize_page(page)
        assert result == []

    def test_multiple_categories_serialized(self):
        """Multiple categories should produce multiple shelves."""
        from app import _serialize_page

        playlist_a = _make_mock_playlist(name="Playlist A")
        playlist_b = _make_mock_playlist(name="Playlist B")
        cat_a = _make_mock_category(title="Shelf A", items=[playlist_a])
        cat_b = _make_mock_category(title="Shelf B", items=[playlist_b])
        page = _make_mock_page(categories=[cat_a, cat_b])

        result = _serialize_page(page)

        assert len(result) == 2
        assert result[0]["title"] == "Shelf A"
        assert result[1]["title"] == "Shelf B"

    def test_category_with_mixed_item_types(self):
        """Categories may contain playlists, mixes, albums — all should serialize."""
        from app import _serialize_page

        playlist = _make_mock_playlist(name="PL")
        mix = _make_mock_mix(title="Mix One")
        cat = _make_mock_category(title="Mixed Shelf", items=[playlist, mix])
        page = _make_mock_page(categories=[cat])

        result = _serialize_page(page)

        assert len(result) == 1
        assert len(result[0]["contents"]) == 2


# ═══════════════════════════════════════════════════════════════════════
# 3. _serialize_mix
# ═══════════════════════════════════════════════════════════════════════

class TestSerializeMix:
    """Verify mix serialization."""

    def test_mix_fields(self):
        """All expected fields should be present in the serialized mix."""
        from app import _serialize_mix

        mix = _make_mock_mix(
            mix_id="mix-42",
            title="Chill Vibes",
            sub_title="Wind down",
        )

        result = _serialize_mix(mix)

        assert result["mixId"] == "mix-42"
        assert result["title"] == "Chill Vibes"
        assert result["subTitle"] == "Wind down"
        assert "thumbnailUrl" in result
        assert isinstance(result["thumbnailUrl"], str)

    def test_mix_image_calls_image_method(self):
        """The serializer should call mix.image() to get the URL."""
        from app import _serialize_mix

        mix = _make_mock_mix()
        _serialize_mix(mix)

        mix.image.assert_called()


# ═══════════════════════════════════════════════════════════════════════
# 4. _serialize_playlist_preview
# ═══════════════════════════════════════════════════════════════════════

class TestSerializePlaylistPreview:
    """Verify playlist preview serialization (list views)."""

    def test_preview_fields(self):
        """Preview should include uuid, name, image, and num_tracks."""
        from app import _serialize_playlist_preview

        playlist = _make_mock_playlist(
            uuid="1111-2222-3333-4444",
            name="Workout Mix",
            num_tracks=50,
        )

        result = _serialize_playlist_preview(playlist)

        assert result["playlistId"] == "1111-2222-3333-4444"
        assert result["title"] == "Workout Mix"
        assert result["numTracks"] == 50
        assert "thumbnailUrl" in result

    def test_preview_does_not_include_tracks(self):
        """Preview should not contain a full track listing."""
        from app import _serialize_playlist_preview

        playlist = _make_mock_playlist()
        result = _serialize_playlist_preview(playlist)

        assert "tracks" not in result


# ═══════════════════════════════════════════════════════════════════════
# 5. _serialize_playlist_detail
# ═══════════════════════════════════════════════════════════════════════

class TestSerializePlaylistDetail:
    """Verify detailed playlist serialization (with tracks)."""

    def test_detail_includes_tracks(self):
        """Detail should include the full track list."""
        from app import _serialize_playlist_detail

        tracks = [
            _make_mock_track(
                track_id=1,
                name="Song A",
                artist_name="Artist A",
                album_name="Album A",
                duration=200,
                isrc="USRC10000001",
            ),
            _make_mock_track(
                track_id=2,
                name="Song B",
                artist_name="Artist B",
                album_name="Album B",
                duration=180,
                isrc="USRC10000002",
            ),
        ]
        playlist = _make_mock_playlist(
            uuid="detail-uuid",
            name="Full Playlist",
            num_tracks=2,
            tracks=tracks,
        )

        result = _serialize_playlist_detail(playlist)

        assert result["id"] == "detail-uuid"
        assert result["title"] == "Full Playlist"
        assert result["trackCount"] == 2
        assert len(result["tracks"]) == 2

        track_a = result["tracks"][0]
        assert track_a["trackId"] == 1
        assert track_a["title"] == "Song A"
        assert track_a["artist"] == "Artist A"
        assert track_a["album"] == "Album A"
        assert track_a["duration"] == 200
        assert track_a["isrc"] == "USRC10000001"

    def test_detail_empty_tracks(self):
        """A playlist with no tracks should have an empty tracks list."""
        from app import _serialize_playlist_detail

        playlist = _make_mock_playlist(
            uuid="empty-uuid",
            name="Empty PL",
            num_tracks=0,
            tracks=[],
        )

        result = _serialize_playlist_detail(playlist)

        assert result["tracks"] == []
        assert result["trackCount"] == 0


# ═══════════════════════════════════════════════════════════════════════
# 6. _serialize_genre
# ═══════════════════════════════════════════════════════════════════════

class TestSerializeGenre:
    """Verify genre serialization."""

    def test_genre_fields(self):
        """Serialized genre should include name, path, and image."""
        from app import _serialize_genre

        genre = _make_mock_genre(name="Rock", path="rock", image="img-rock")
        result = _serialize_genre(genre)

        assert result["name"] == "Rock"
        assert result["path"] == "rock"
        assert "imageUrl" in result


# ═══════════════════════════════════════════════════════════════════════
# 7. _build_browse_session
# ═══════════════════════════════════════════════════════════════════════

class TestBuildBrowseSession:
    """Verify that _build_browse_session constructs a tidalapi.Session."""

    def test_builds_session_from_stored_credentials(self):
        """Should create a tidalapi.Session using _user_auth_state creds."""
        from app import _build_browse_session, _user_auth_state

        _user_auth_state["test-user"] = {
            "access_token": "tok-123",
            "refresh_token": "ref-456",
            "tidal_user_id": "tidal-789",
            "country_code": "US",
        }

        with patch("app.tidalapi") as mock_tidalapi:
            mock_session = MagicMock()
            mock_tidalapi.Session.return_value = mock_session
            mock_tidalapi.Config.return_value = MagicMock()

            session = _build_browse_session("test-user")

            assert session is mock_session

        # Clean up
        _user_auth_state.pop("test-user", None)

    def test_raises_401_when_no_credentials(self):
        """Should raise HTTPException(401) when user has no stored creds."""
        from app import _build_browse_session, _user_auth_state

        _user_auth_state.pop("no-such-user", None)

        with pytest.raises(Exception) as exc_info:
            _build_browse_session("no-such-user")

        # Should be an HTTPException with 401 status
        assert exc_info.value.status_code == 401

    def test_caches_session_on_second_call(self):
        """Second call for same user should return cached session."""
        from app import (
            _browse_sessions,
            _build_browse_session,
            _user_auth_state,
        )

        _user_auth_state["cache-user"] = {
            "access_token": "tok-abc",
            "refresh_token": "ref-def",
            "tidal_user_id": "tidal-ghi",
            "country_code": "NO",
        }
        _browse_sessions.pop("cache-user", None)

        with patch("app.tidalapi") as mock_tidalapi:
            mock_session = MagicMock()
            mock_tidalapi.Session.return_value = mock_session
            mock_tidalapi.Config.return_value = MagicMock()

            first = _build_browse_session("cache-user")
            second = _build_browse_session("cache-user")

            assert first is second
            # Session constructor should only be called once (cached)
            assert mock_tidalapi.Session.call_count == 1

        # Clean up
        _user_auth_state.pop("cache-user", None)
        _browse_sessions.pop("cache-user", None)


# ═══════════════════════════════════════════════════════════════════════
# 8. Browse endpoint HTTP tests
# ═══════════════════════════════════════════════════════════════════════

class TestBrowseHomeEndpoint:
    """Tests for GET /user/browse/home."""

    @pytest.mark.anyio
    async def test_returns_401_when_no_session(self, client):
        """Should return 401 when the user has no TIDAL browse session."""
        from app import _browse_sessions, _user_auth_state

        _user_auth_state.pop("test", None)
        _browse_sessions.pop("test", None)

        resp = await client.get("/user/browse/home", params={"user_id": "test"})
        assert resp.status_code == 401

    @pytest.mark.anyio
    async def test_returns_200_with_shelves(self, client):
        """Should return 200 with shelf data when session exists."""
        playlist = _make_mock_playlist(name="Trending Playlist")
        cat = _make_mock_category(title="Trending", items=[playlist])
        mock_page = _make_mock_page(categories=[cat])

        mock_session = MagicMock()
        mock_session.home.return_value = mock_page

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/home", params={"user_id": "test"}
            )

        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        assert "shelves" in data
        assert len(data["shelves"]) == 1
        assert data["shelves"][0]["title"] == "Trending"


class TestBrowseExploreEndpoint:
    """Tests for GET /user/browse/explore."""

    @pytest.mark.anyio
    async def test_returns_200_with_shelves(self, client):
        """Should return 200 with explore shelves."""
        playlist = _make_mock_playlist(name="New Releases")
        cat = _make_mock_category(title="New Releases", items=[playlist])
        mock_page = _make_mock_page(categories=[cat])

        mock_session = MagicMock()
        mock_session.explore.return_value = mock_page

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/explore", params={"user_id": "test"}
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "shelves" in data
        assert len(data["shelves"]) >= 1
        assert data["shelves"][0]["title"] == "New Releases"


class TestBrowseGenresEndpoint:
    """Tests for GET /user/browse/genres."""

    @pytest.mark.anyio
    async def test_returns_200_with_genres(self, client):
        """Should return 200 with a list of genres."""
        mock_page = _make_mock_page(
            categories=[
                _make_mock_category(
                    title="Genres",
                    items=[
                        _make_mock_genre(name="Pop", path="pop"),
                        _make_mock_genre(name="Rock", path="rock"),
                    ],
                )
            ]
        )

        mock_session = MagicMock()
        mock_session.genres.return_value = mock_page

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/genres", params={"user_id": "test"}
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "genres" in data
        assert len(data["genres"]) == 2
        assert data["genres"][0]["name"] == "Pop"
        assert data["genres"][1]["name"] == "Rock"


class TestBrowseMoodsEndpoint:
    """Tests for GET /user/browse/moods."""

    @pytest.mark.anyio
    async def test_returns_200_with_moods(self, client):
        """Should return 200 with a list of moods."""
        mock_page = _make_mock_page(
            categories=[
                _make_mock_category(
                    title="Moods",
                    items=[
                        _make_mock_genre(name="Chill", path="chill"),
                        _make_mock_genre(name="Party", path="party"),
                    ],
                )
            ]
        )

        mock_session = MagicMock()
        mock_session.moods.return_value = mock_page

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/moods", params={"user_id": "test"}
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "moods" in data
        assert len(data["moods"]) == 2
        assert data["moods"][0]["name"] == "Chill"


class TestBrowseMixesEndpoint:
    """Tests for GET /user/browse/mixes."""

    @pytest.mark.anyio
    async def test_returns_200_with_mixes(self, client):
        """Should return 200 with a list of mixes."""
        mock_page = _make_mock_page(
            categories=[
                _make_mock_category(
                    title="Mixes",
                    items=[
                        _make_mock_mix(mix_id="mix-1", title="Daily Mix 1"),
                        _make_mock_mix(mix_id="mix-2", title="Daily Mix 2"),
                    ],
                )
            ]
        )

        mock_session = MagicMock()
        mock_session.mixes.return_value = mock_page

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/mixes", params={"user_id": "test"}
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "mixes" in data
        assert len(data["mixes"]) == 2
        assert data["mixes"][0]["mixId"] == "mix-1"
        assert data["mixes"][0]["title"] == "Daily Mix 1"


class TestBrowseGenrePlaylistsEndpoint:
    """Tests for GET /user/browse/genre-playlists."""

    @pytest.mark.anyio
    async def test_returns_200_with_playlists(self, client):
        """Should return 200 with genre-specific playlists."""
        playlist_a = _make_mock_playlist(uuid="pl-1", name="Pop Hits")
        playlist_b = _make_mock_playlist(uuid="pl-2", name="Pop Rising")
        cat = _make_mock_category(title="Pop Playlists", items=[playlist_a, playlist_b])
        mock_page = _make_mock_page(categories=[cat])

        mock_session = MagicMock()
        mock_session.page.get.return_value = mock_page

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/genre-playlists",
                params={"user_id": "test", "path": "Pop"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "playlists" in data
        assert len(data["playlists"]) >= 1

    @pytest.mark.anyio
    async def test_requires_path_parameter(self, client):
        """Should return 422 when path query parameter is missing."""
        mock_session = MagicMock()

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/genre-playlists",
                params={"user_id": "test"},
            )

        assert resp.status_code == 422


class TestBrowsePlaylistDetailEndpoint:
    """Tests for GET /user/browse/playlist/{uuid}."""

    @pytest.mark.anyio
    async def test_returns_200_with_playlist_detail(self, client):
        """Should return 200 with full playlist detail including tracks."""
        tracks = [
            _make_mock_track(track_id=1, name="Track 1"),
            _make_mock_track(track_id=2, name="Track 2"),
        ]
        playlist = _make_mock_playlist(
            uuid="detail-uuid-123",
            name="Full Detail PL",
            num_tracks=2,
            tracks=tracks,
        )

        mock_session = MagicMock()
        mock_session.playlist.return_value = playlist

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/playlist/detail-uuid-123",
                params={"user_id": "test"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "detail-uuid-123"
        assert data["title"] == "Full Detail PL"
        assert len(data["tracks"]) == 2
        assert data["tracks"][0]["title"] == "Track 1"

    @pytest.mark.anyio
    async def test_returns_404_when_playlist_not_found(self, client):
        """Should return 404 when tidalapi cannot find the playlist."""
        mock_session = MagicMock()
        mock_session.playlist.side_effect = Exception("Not found")

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/playlist/nonexistent-uuid",
                params={"user_id": "test"},
            )

        assert resp.status_code == 404

    @pytest.mark.anyio
    async def test_returns_502_when_user_playlist_lookup_fails_with_transport_error(self, client):
        """Transport/runtime failures should surface as 502 for retryability."""
        mock_session = MagicMock()
        mock_session.playlist.side_effect = RuntimeError("transport timeout")

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/playlist/detail-uuid-123",
                params={"user_id": "test"},
            )

        assert resp.status_code == 502
        assert resp.json()["detail"] == "Failed to load playlist"


class TestPublicBrowsePlaylistDetailEndpoint:
    """Tests for GET /browse/playlist/{uuid}."""

    @pytest.mark.anyio
    async def test_returns_200_with_playlist_detail(self, client):
        """Should return 200 with full public playlist detail including tracks."""
        tracks = [
            _make_mock_track(track_id=1, name="Track 1"),
            _make_mock_track(track_id=2, name="Track 2"),
        ]
        playlist = _make_mock_playlist(
            uuid="detail-uuid-123",
            name="Full Detail PL",
            num_tracks=2,
            tracks=tracks,
        )

        mock_session = MagicMock()
        mock_session.playlist.return_value = playlist

        with patch("app._build_public_browse_session", return_value=mock_session):
            resp = await client.get("/browse/playlist/detail-uuid-123")

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "detail-uuid-123"
        assert data["title"] == "Full Detail PL"
        assert len(data["tracks"]) == 2
        assert data["tracks"][0]["title"] == "Track 1"

    @pytest.mark.anyio
    async def test_returns_404_when_playlist_not_found(self, client):
        """Should return 404 when public browse cannot find the playlist."""
        mock_session = MagicMock()
        mock_session.playlist.side_effect = Exception("Not found")

        with patch("app._build_public_browse_session", return_value=mock_session):
            resp = await client.get("/browse/playlist/nonexistent-uuid")

        assert resp.status_code == 404

    @pytest.mark.anyio
    async def test_returns_502_for_public_playlist_upstream_transport_errors(self, client):
        """Transport/runtime errors should not be collapsed to not-found responses."""
        mock_session = MagicMock()
        mock_session.playlist.side_effect = RuntimeError("upstream timeout")

        with patch("app._build_public_browse_session", return_value=mock_session):
            resp = await client.get("/browse/playlist/detail-uuid-123")

        assert resp.status_code == 502
        assert resp.json()["detail"] == "Failed to load playlist"


class TestBrowseMixDetailEndpoint:
    """Tests for GET /user/browse/mix/{mix_id}."""

    @pytest.mark.anyio
    async def test_returns_200_with_mix_detail(self, client):
        """Should return 200 with mix metadata and tracks."""
        tracks = [
            _make_mock_track(track_id=10, name="Mix Track A"),
            _make_mock_track(track_id=20, name="Mix Track B"),
        ]
        mix = _make_mock_mix(
            mix_id="mix-detail-1",
            title="My Daily Mix",
            sub_title="Just for you",
        )
        mix.items.return_value = tracks

        mock_session = MagicMock()
        mock_session.mix.return_value = mix

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/mix/mix-detail-1",
                params={"user_id": "test"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "mix-detail-1"
        assert data["title"] == "My Daily Mix"
        assert data["subTitle"] == "Just for you"
        assert len(data["tracks"]) == 2
        assert data["tracks"][0]["title"] == "Mix Track A"

    @pytest.mark.anyio
    async def test_returns_404_when_mix_not_found(self, client):
        """Should return 404 when tidalapi cannot find the mix."""
        mock_session = MagicMock()
        mock_session.mix.side_effect = Exception("Not found")

        with patch("app._build_browse_session", return_value=mock_session):
            resp = await client.get(
                "/user/browse/mix/nonexistent-mix",
                params={"user_id": "test"},
            )

        assert resp.status_code == 404
