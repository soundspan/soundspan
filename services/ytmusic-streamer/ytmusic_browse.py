"""Public browse normalization and HTTP routes."""

import asyncio
import os

from fastapi import HTTPException, Query
from ytmusic_client import (
    _get_public_ytmusic,
    _get_ytmusic,
    _oauth_file,
    _run_ytmusic_with_auth_retry,
)
from ytmusic_library import _format_album_response
from ytmusic_runtime import JsonList, JsonObject, _sanitized_http_error, app, log
from ytmusicapi import YTMusic

# Comma-separated shelf titles excluded from /home responses.
_raw_filtered = os.getenv("YTMUSIC_HOME_FILTERED_SHELVES", "Quick picks") or ""
YTMUSIC_HOME_FILTERED_SHELVES: set[str] = {
    s.strip().lower() for s in _raw_filtered.split(",") if s.strip()
}


def _get_browse_ytmusic(user_id: str | None = None) -> YTMusic:
    """Get a YTMusic instance for browse — authenticated if user has OAuth, else public."""
    if user_id and _oauth_file(user_id).exists():
        try:
            return _get_ytmusic(user_id)
        except Exception:
            log.warning(
                "Failed to get authenticated YTMusic for user=%s, falling back to public", user_id
            )
    return _get_public_ytmusic("native")


@app.get("/charts")
async def get_charts(country: str = "US", user_id: str | None = Query(None)) -> JsonObject:
    """Get YT Music charts (top songs, trending, etc.).

    Always uses a public (unauthenticated) YTMusic instance because
    YouTube's browse API rejects chart requests from OAuth sessions
    with HTTP 400.
    """
    try:
        charts = await asyncio.to_thread(
            lambda: _get_public_ytmusic("native").get_charts(country=country)
        )

        result = {}
        # Extract top songs/videos if present
        for section_key in ("songs", "videos", "trending", "artists"):
            section = charts.get(section_key)
            if section and isinstance(section, dict) and "items" in section:
                items = []
                for item in section["items"][:20]:
                    artists = item.get("artists", [])
                    entry = {
                        "videoId": item.get("videoId"),
                        "title": item.get("title"),
                        "artist": artists[0].get("name") if artists else "Unknown",
                        "thumbnailUrl": _best_thumbnail(item.get("thumbnails", [])),
                    }
                    if item.get("album"):
                        entry["album"] = item["album"].get("name", "")
                    items.append(entry)
                result[section_key] = items
        return result
    except Exception as e:
        raise _sanitized_http_error("Charts fetch", e, 500, "Failed to load charts") from e


@app.get("/moods-and-genres")
async def get_moods_and_genres(user_id: str | None = Query(None)) -> JsonList:
    """Get YT Music mood/genre categories.

    Always uses a public (unauthenticated) YTMusic instance because
    YouTube's browse API rejects mood/genre requests from OAuth
    sessions with HTTP 400.
    """
    try:
        categories = await asyncio.to_thread(
            lambda: _get_public_ytmusic("native").get_mood_categories()
        )

        result = []
        for cat_title, cat_items in categories.items():
            entries = []
            for item in cat_items:
                entries.append(
                    {
                        "title": item.get("title", ""),
                        "params": item.get("params", ""),
                    }
                )
            result.append({"title": cat_title, "items": entries})
        return result
    except Exception as e:
        raise _sanitized_http_error(
            "Moods and genres fetch",
            e,
            500,
            "Failed to load moods and genres",
        ) from e


@app.get("/home")
async def get_home(
    limit: int = Query(6, ge=1, le=20), user_id: str | None = Query(None)
) -> JsonList:
    """Get YT Music home page shelves (featured/curated content).

    Always uses a public (unauthenticated) YTMusic instance because
    YouTube's browse API rejects home requests from OAuth sessions
    with HTTP 400.
    """
    try:
        home = await asyncio.to_thread(lambda: _get_public_ytmusic("native").get_home(limit=limit))

        shelves = []
        for raw_shelf in home:
            shelf: object = raw_shelf
            if not isinstance(shelf, dict):
                continue
            title = shelf.get("title", "")
            if (
                YTMUSIC_HOME_FILTERED_SHELVES
                and title.strip().lower() in YTMUSIC_HOME_FILTERED_SHELVES
            ):
                log.debug("Filtered shelf from /home response: %r", title)
                continue
            contents = []
            for item in shelf.get("contents", []):
                if not isinstance(item, dict):
                    continue
                entry = {
                    "title": item.get("title", ""),
                    "thumbnailUrl": _best_thumbnail(item.get("thumbnails", [])),
                    "subtitle": "",
                }
                # Resolve subtitle from artists or description
                artists = item.get("artists", [])
                if artists:
                    names = [a.get("name", "") if isinstance(a, dict) else str(a) for a in artists]
                    entry["subtitle"] = ", ".join(n for n in names if n)
                elif item.get("description"):
                    entry["subtitle"] = item["description"]

                # Extract item type (album, playlist, song, artist, video)
                raw_type = str(item.get("resultType") or item.get("type") or "").strip().lower()
                if raw_type:
                    entry["type"] = raw_type

                if item.get("playlistId"):
                    entry["playlistId"] = item["playlistId"]
                if item.get("videoId"):
                    entry["videoId"] = item["videoId"]
                if item.get("browseId"):
                    entry["browseId"] = item["browseId"]

                contents.append(entry)

            if contents:
                shelves.append({"title": title, "contents": contents})

        return shelves
    except Exception as e:
        raise _sanitized_http_error("Home fetch", e, 500, "Failed to load home") from e


@app.get("/browse-album/{browse_id}")
async def get_browse_album(browse_id: str) -> JsonObject:
    """Get album details from YouTube Music (unauthenticated, public browse)."""
    try:
        album = await asyncio.to_thread(lambda: _get_public_ytmusic("native").get_album(browse_id))
        return _format_album_response(browse_id, album)
    except HTTPException:
        raise
    except Exception as e:
        error_str = str(e).lower()
        if "not found" in error_str or "unable to find" in error_str:
            raise HTTPException(status_code=404, detail=f"Album not found: {browse_id}")
        raise _sanitized_http_error(
            f"Browse album fetch for {browse_id}",
            e,
            500,
            "Failed to load album",
        ) from e


@app.get("/mood-playlists")
async def get_mood_playlists(
    params: str = Query(..., min_length=1, max_length=512), user_id: str | None = Query(None)
) -> JsonList:
    """Get playlists for a specific mood/genre category.

    Uses a custom browse implementation instead of ytmusicapi's
    ``get_mood_playlists`` to handle renderer types that the library
    does not support (``musicResponsiveListItemRenderer`` for songs,
    ``musicTwoRowItemRenderer`` items without a navigation endpoint for
    music videos/singles).
    """
    try:
        params = params.strip()
        if not params:
            raise HTTPException(status_code=400, detail="params must be a non-empty string")

        playlists = await asyncio.to_thread(
            lambda: _fetch_mood_playlists(_get_public_ytmusic("native"), params)
        )

        result = []
        for item in playlists:
            # parse_playlist may return author as a list of
            # {"name": str, "id": str|None} dicts; flatten to a string.
            raw_author = item.get("author", "")
            if isinstance(raw_author, list):
                raw_author = (
                    ", ".join(a.get("name", "") for a in raw_author if isinstance(a, dict))
                    if raw_author
                    else ""
                )
            elif not isinstance(raw_author, str):
                raw_author = str(raw_author)
            entry = {
                "playlistId": item.get("playlistId", "") or "",
                "title": item.get("title", "") or "",
                "thumbnailUrl": _best_thumbnail(item.get("thumbnails", [])),
                "author": raw_author,
            }
            result.append(entry)

        return result
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            "Mood playlists fetch",
            e,
            500,
            "Failed to load mood playlists",
        ) from e


@app.get("/playlist/{playlist_id}")
async def get_playlist(
    playlist_id: str,
    limit: int = 100,
    user_id: str | None = Query(None),
) -> JsonObject:
    """Get a YT Music playlist with track details.

    When ``user_id`` is provided, prefers authenticated browse context and
    falls back to public browse if authenticated fetch fails.
    """
    auth_error: Exception | None = None
    try:
        if user_id and user_id != "__public__":
            try:
                playlist = await asyncio.to_thread(
                    _run_ytmusic_with_auth_retry,
                    user_id,
                    operation=f"get_playlist({playlist_id})",
                    func=lambda yt: yt.get_playlist(playlist_id, limit=limit),
                )
            except Exception as auth_err:
                auth_error = auth_err
                log.warning(
                    "Authenticated playlist fetch failed for user=%s, retrying public browse: %s",
                    user_id,
                    auth_err,
                )
                yt = _get_public_ytmusic("native")
                playlist = await asyncio.to_thread(yt.get_playlist, playlist_id, limit=limit)
        else:
            yt = _get_public_ytmusic("native")
            playlist = await asyncio.to_thread(yt.get_playlist, playlist_id, limit=limit)

        tracks = []
        for t in playlist.get("tracks", []):
            raw_artists = t.get("artists") or []
            artists = raw_artists if isinstance(raw_artists, list) else []
            album = t.get("album", {}) or {}
            first_artist = artists[0] if artists else None
            artist_name = (
                first_artist.get("name", "Unknown")
                if isinstance(first_artist, dict)
                else str(first_artist)
                if first_artist
                else "Unknown"
            )
            tracks.append(
                {
                    "videoId": t.get("videoId"),
                    "title": t.get("title"),
                    "artist": artist_name,
                    "artists": [
                        a.get("name") if isinstance(a, dict) else str(a)
                        for a in artists
                        if (a.get("name") if isinstance(a, dict) else a)
                    ],
                    "album": album.get("name", "") if isinstance(album, dict) else str(album),
                    "duration": _parse_duration(t.get("duration", "")),
                    "thumbnailUrl": _best_thumbnail(t.get("thumbnails", [])),
                }
            )

        return {
            "id": playlist_id,
            "title": playlist.get("title", ""),
            "description": playlist.get("description", ""),
            "trackCount": playlist.get("trackCount", len(tracks)),
            "thumbnailUrl": _best_thumbnail(playlist.get("thumbnails", [])),
            "tracks": tracks,
        }
    except HTTPException:
        raise
    except Exception as e:
        if isinstance(auth_error, HTTPException):
            raise auth_error
        raise _sanitized_http_error(
            f"Playlist fetch for {playlist_id}",
            e,
            500,
            "Failed to load playlist",
        ) from e


def _fetch_mood_playlists(yt: YTMusic, params: str) -> JsonList:
    """Robustly fetch mood/genre playlists via the browse API.

    ``ytmusicapi.get_mood_playlists`` crashes on categories whose first
    carousel contains songs (``musicResponsiveListItemRenderer``) or
    videos without a browse endpoint.  This helper re-implements the
    browse call with per-item error handling so those sections are
    silently skipped instead of taking down the whole request.
    """
    from ytmusicapi.navigation import (
        CAROUSEL_CONTENTS,
        GRID_ITEMS,
        SECTION_LIST,
        SINGLE_COLUMN_TAB,
        nav,
    )
    from ytmusicapi.parsers._utils import MTRIR
    from ytmusicapi.parsers.browsing import parse_playlist

    response = yt._send_request(
        "browse",
        {"browseId": "FEmusic_moods_and_genres_category", "params": params},
    )
    playlists: JsonList = []
    for section in nav(response, SINGLE_COLUMN_TAB + SECTION_LIST):
        path: list[str] = []
        if "gridRenderer" in section:
            path = list(GRID_ITEMS)
        elif "musicCarouselShelfRenderer" in section:
            path = list(CAROUSEL_CONTENTS)
        elif "musicImmersiveCarouselShelfRenderer" in section:
            path = ["musicImmersiveCarouselShelfRenderer", "contents"]
        if not path:
            continue
        results = nav(section, path)
        for result in results:
            if MTRIR not in result:
                # Skip non-playlist renderers (e.g. songs)
                continue
            try:
                playlists.append(parse_playlist(result[MTRIR]))
            except Exception:  # noqa: S112 -- malformed third-party playlist items are intentionally skipped
                # Skip items that lack required fields (e.g. music videos
                # without a browse navigation endpoint)
                continue
    return playlists


def _best_thumbnail(thumbnails: JsonList) -> str | None:
    """Pick the best available thumbnail URL."""
    if not thumbnails:
        return None
    # Prefer medium/large resolution
    for t in reversed(thumbnails):
        url = t.get("url")
        if isinstance(url, str) and url:
            return url
    first_url = thumbnails[0].get("url")
    return first_url if isinstance(first_url, str) else None


def _parse_duration(duration_str: str) -> int:
    """Parse duration string like '3:45' into seconds."""
    if not duration_str:
        return 0
    parts = duration_str.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except (ValueError, IndexError):
        pass
    return 0
