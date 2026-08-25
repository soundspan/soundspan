"""Administrative and per-user TIDAL catalog routes."""

import asyncio
from typing import Any

from fastapi import Depends, HTTPException, Query
from tidal_auth import _run_user_api_call, require_admin_credentials
from tidal_models import AdminCredentials, BatchSearchQuery, SearchRequest
from tidal_runtime import JsonObject, _build_api, _sanitized_http_error, app, log
from tidal_serializers import _tidal_image_url
from tiddl.core.api import ApiError

_BATCH_SEARCH_MAX_QUERIES = 50
_BATCH_SEARCH_CONCURRENCY = 5


def _serialize_admin_search(results: Any) -> JsonObject:
    """Serialize the established administrative search response shape."""
    return {
        "tracks": [
            {
                "id": track.id,
                "title": track.title,
                "artist": track.artists[0].name if track.artists else "Unknown",
                "album": {"id": track.album.id, "title": track.album.title},
                "duration": track.duration,
                "quality": track.audioQuality,
                "isrc": track.isrc,
                "explicit": track.explicit,
            }
            for track in results.tracks.items[:20]
        ],
        "albums": [
            {
                "id": album.id,
                "title": album.title,
                "artist": album.artist.name if album.artist else "Unknown",
                "numberOfTracks": album.numberOfTracks,
                "releaseDate": str(album.releaseDate) if album.releaseDate else None,
                "type": album.type,
                "quality": album.audioQuality,
                "cover": album.cover,
            }
            for album in results.albums.items[:20]
        ],
        "artists": [
            {"id": artist.id, "name": artist.name, "picture": artist.picture}
            for artist in results.artists.items[:10]
        ],
    }


def _serialize_user_search(results: Any) -> JsonObject:
    """Serialize the established per-user search response shape."""
    return {
        "tracks": [
            {
                "id": track.id,
                "title": track.title,
                "artist": track.artists[0].name if track.artists else "Unknown",
                "artists": [artist.name for artist in track.artists] if track.artists else [],
                "album": {"id": track.album.id, "title": track.album.title},
                "duration": track.duration,
                "quality": track.audioQuality,
                "isrc": track.isrc,
                "explicit": track.explicit,
            }
            for track in results.tracks.items[:20]
        ],
        "albums": [
            {
                "id": album.id,
                "title": album.title,
                "artist": album.artist.name if album.artist else "Unknown",
                "numberOfTracks": album.numberOfTracks,
                "releaseDate": str(album.releaseDate) if album.releaseDate else None,
                "type": album.type,
                "quality": album.audioQuality,
                "cover": album.cover,
            }
            for album in results.albums.items[:20]
        ],
        "artists": [
            {"id": artist.id, "name": artist.name, "picture": artist.picture}
            for artist in results.artists.items[:10]
        ],
    }


@app.post("/search")
async def search(
    req: SearchRequest,
    creds: AdminCredentials = Depends(  # noqa: B008 -- FastAPI dependency declaration
        require_admin_credentials
    ),
) -> JsonObject:
    """Search using bearer-header auth or the deprecated query fallback."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)
    try:
        results = await asyncio.to_thread(api.get_search, req.query)
        return _serialize_admin_search(results)
    except ApiError as error:
        status_code = error.status if hasattr(error, "status") else 500
        raise _sanitized_http_error(
            "TIDAL search", error, status_code, "TIDAL search failed"
        ) from error


@app.post("/user/search")
async def user_search(
    req: SearchRequest,
    user_id: str = Query(...),
) -> JsonObject:
    """Search TIDAL using a user's own credentials."""
    try:
        results = await _run_user_api_call(
            user_id,
            lambda current_api: current_api.get_search(req.query),
            operation=f"search '{req.query}'",
        )
        return _serialize_user_search(results)
    except ApiError as error:
        raise _sanitized_http_error(
            "TIDAL user search",
            error,
            getattr(error, "status", 500),
            "TIDAL search failed",
        ) from error


async def _run_batch_search_query(
    query: BatchSearchQuery,
    user_id: str,
    semaphore: asyncio.Semaphore,
) -> JsonObject:
    """Run one bounded batch query and preserve its empty-on-error contract."""
    try:
        async with semaphore:
            results = await _run_user_api_call(
                user_id,
                lambda current_api: current_api.get_search(query.query),
                operation=f"batch search '{query.query}'",
            )
        tracks = [
            {
                "id": track.id,
                "title": track.title,
                "artist": track.artists[0].name if track.artists else "Unknown",
                "duration": track.duration,
                "isrc": track.isrc,
            }
            for track in results.tracks.items[: query.limit]
        ]
        return {"query": query.query, "results": tracks}
    except Exception as error:
        log.warning(f"Batch search failed for '{query.query}': {error}")
        return {"query": query.query, "results": []}


@app.post("/user/search/batch")
async def user_search_batch(
    queries: list[BatchSearchQuery],
    user_id: str = Query(...),
) -> JsonObject:
    """Run multiple gap-fill search queries in one bounded request."""
    if len(queries) > _BATCH_SEARCH_MAX_QUERIES:
        raise HTTPException(
            status_code=422,
            detail=f"Batch search accepts at most {_BATCH_SEARCH_MAX_QUERIES} queries",
        )
    semaphore = asyncio.Semaphore(_BATCH_SEARCH_CONCURRENCY)
    results = await asyncio.gather(
        *[_run_batch_search_query(query, user_id, semaphore) for query in queries]
    )
    return {"results": list(results)}


@app.get("/user/track/{track_id}")
async def user_get_track(
    track_id: int,
    user_id: str = Query(...),
) -> JsonObject:
    """Get track metadata from TIDAL."""
    try:
        track = await _run_user_api_call(
            user_id,
            lambda current_api: current_api.get_track(track_id),
            operation=f"track lookup {track_id}",
        )
        return {
            "id": track.id,
            "title": track.title,
            "artist": track.artists[0].name if track.artists else "Unknown",
            "artists": [artist.name for artist in track.artists] if track.artists else [],
            "duration": track.duration,
            "isrc": track.isrc,
            "explicit": track.explicit,
            "thumbnailUrl": _tidal_image_url(getattr(track.album, "cover", None), 320, 320),
            "album": {"id": track.album.id, "title": track.album.title},
        }
    except ApiError as error:
        raise _sanitized_http_error(
            f"TIDAL track lookup {track_id}",
            error,
            getattr(error, "status", 500),
            "TIDAL track lookup failed",
        ) from error
