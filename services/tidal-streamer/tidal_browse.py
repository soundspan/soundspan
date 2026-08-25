"""Authenticated and public tidalapi browse routes."""

import asyncio
import re

from fastapi import HTTPException, Query
from tidal_auth import _build_browse_session, _build_public_browse_session
from tidal_runtime import JsonObject, _sanitized_http_error, app, log
from tidal_serializers import (
    _extract_page_links,
    _serialize_mix,
    _serialize_page,
    _serialize_playlist_detail,
    _serialize_track,
)


def _is_playlist_not_found_error(error: Exception) -> bool:
    """Return whether an upstream exception clearly indicates a missing playlist."""
    if isinstance(error, HTTPException):
        return error.status_code == 404
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code == 404:
        return True
    message = str(error).lower()
    return "not found" in message or "404" in message


@app.get("/user/browse/home")
async def user_browse_home(
    user_id: str = Query(...), limit: int = Query(6), quality: str | None = Query(None)
) -> JsonObject:
    """Get personalized TIDAL home page shelves."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.home)
        shelves = _serialize_page(page)
        return {"shelves": shelves[:limit]}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL browse home for user {user_id}",
            error,
            500,
            "Failed to load TIDAL home",
        ) from error


@app.get("/user/browse/explore")
async def user_browse_explore(
    user_id: str = Query(...), limit: int = Query(6), quality: str | None = Query(None)
) -> JsonObject:
    """Get TIDAL editorial and new-release shelves."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.explore)
        shelves = _serialize_page(page)
        return {"shelves": shelves[:limit]}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL browse explore for user {user_id}",
            error,
            500,
            "Failed to load TIDAL explore",
        ) from error


async def _load_page_links(user_id: str, quality: str | None, method: str) -> list[JsonObject]:
    """Load one authenticated PageLink collection off the event loop."""
    session = await asyncio.to_thread(_build_browse_session, user_id, quality)
    page = await asyncio.to_thread(getattr(session, method))
    return _extract_page_links(page)


@app.get("/user/browse/genres")
async def user_browse_genres(
    user_id: str = Query(...), quality: str | None = Query(None)
) -> JsonObject:
    """Get TIDAL genre categories."""
    try:
        return {"genres": await _load_page_links(user_id, quality, "genres")}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL browse genres for user {user_id}",
            error,
            500,
            "Failed to load TIDAL genres",
        ) from error


@app.get("/user/browse/moods")
async def user_browse_moods(
    user_id: str = Query(...), quality: str | None = Query(None)
) -> JsonObject:
    """Get TIDAL mood categories."""
    try:
        return {"moods": await _load_page_links(user_id, quality, "moods")}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL browse moods for user {user_id}",
            error,
            500,
            "Failed to load TIDAL moods",
        ) from error


@app.get("/user/browse/mixes")
async def user_browse_mixes(
    user_id: str = Query(...), quality: str | None = Query(None)
) -> JsonObject:
    """Get personal TIDAL mixes."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.mixes)
        mixes = []
        for category in page.categories or []:
            for item in getattr(category, "items", None) or []:
                mixes.append(_serialize_mix(item))
        return {"mixes": mixes}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL browse mixes for user {user_id}",
            error,
            500,
            "Failed to load TIDAL mixes",
        ) from error


def _flatten_playlist_shelves(shelves: list[JsonObject]) -> list[JsonObject]:
    """Flatten playlist shelf entries into the established preview shape."""
    playlists = []
    for shelf in shelves:
        for item in shelf.get("contents", []):
            if item.get("playlistId"):
                playlists.append(
                    {
                        "playlistId": item["playlistId"],
                        "title": item.get("title", ""),
                        "thumbnailUrl": item.get("thumbnailUrl"),
                        "numTracks": 0,
                    }
                )
    return playlists


@app.get("/user/browse/genre-playlists")
async def user_browse_genre_playlists(
    user_id: str = Query(...),
    path: str = Query(...),
    quality: str | None = Query(None),
) -> JsonObject:
    """Get playlists for a specific genre or mood path."""
    if not re.match(r"^[a-zA-Z0-9_\-/]+$", path) or ".." in path:
        raise HTTPException(status_code=400, detail="Invalid genre path")
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(lambda: session.page.get(f"pages/{path}"))
        return {"playlists": _flatten_playlist_shelves(_serialize_page(page))}
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL browse genre playlists for user {user_id}",
            error,
            500,
            "Failed to load TIDAL genre playlists",
        ) from error


def _limit_playlist_tracks(result: JsonObject, limit: int) -> JsonObject:
    """Apply the existing optional track limit to a playlist response."""
    if limit and len(result.get("tracks", [])) > limit:
        result["tracks"] = result["tracks"][:limit]
    return result


@app.get("/browse/playlist/{playlist_uuid}")
async def browse_playlist(
    playlist_uuid: str,
    limit: int = Query(100),
    quality: str | None = Query(None),
) -> JsonObject:
    """Get public TIDAL playlist details with tracks."""
    try:
        session = _build_public_browse_session(quality)
        playlist = await asyncio.to_thread(session.playlist, playlist_uuid)
        result = await asyncio.to_thread(_serialize_playlist_detail, playlist)
        return _limit_playlist_tracks(result, limit)
    except HTTPException:
        raise
    except Exception as error:
        log.error(f"TIDAL public browse playlist {playlist_uuid} failed: {error}")
        if _is_playlist_not_found_error(error):
            raise HTTPException(status_code=404, detail="Playlist not found") from error
        raise HTTPException(status_code=502, detail="Failed to load playlist") from error


@app.get("/user/browse/playlist/{playlist_uuid}")
async def user_browse_playlist(
    playlist_uuid: str,
    user_id: str = Query(...),
    limit: int = Query(100),
    quality: str | None = Query(None),
) -> JsonObject:
    """Get authenticated TIDAL playlist details with tracks."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        playlist = await asyncio.to_thread(session.playlist, playlist_uuid)
        result = await asyncio.to_thread(_serialize_playlist_detail, playlist)
        return _limit_playlist_tracks(result, limit)
    except HTTPException:
        raise
    except Exception as error:
        log.error(f"TIDAL browse playlist {playlist_uuid} failed for user {user_id}: {error}")
        if _is_playlist_not_found_error(error):
            raise HTTPException(status_code=404, detail="Playlist not found") from error
        raise HTTPException(status_code=502, detail="Failed to load playlist") from error


@app.get("/user/browse/mix/{mix_id}")
async def user_browse_mix(
    mix_id: str,
    user_id: str = Query(...),
    quality: str | None = Query(None),
) -> JsonObject:
    """Get TIDAL mix details with tracks."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        mix = await asyncio.to_thread(session.mix, mix_id)
        tracks = await asyncio.to_thread(mix.items)
        return {
            "id": str(mix.id),
            "title": getattr(mix, "title", "") or "",
            "subTitle": getattr(mix, "sub_title", "") or "",
            "thumbnailUrl": mix.image(320) if callable(getattr(mix, "image", None)) else None,
            "trackCount": len(tracks) if tracks else 0,
            "tracks": [_serialize_track(track) for track in (tracks or [])],
        }
    except HTTPException:
        raise
    except Exception as error:
        log.error(f"TIDAL browse mix {mix_id} failed for user {user_id}: {error}")
        raise HTTPException(status_code=404, detail="Mix not found") from error
