"""Search normalization, parsing, caching, and HTTP routes."""

import asyncio
import random
import re
import threading
import time
from typing import Any, Literal, cast

from fastapi import HTTPException, Query
from ytmusic_client import (
    SEARCH_MODE,
    _get_public_ytmusic,
    _invalidate_public_ytmusic,
    _invalidate_ytmusic,
    _is_oauth_auth_error,
    _resolve_user_search_strategy,
    _run_ytmusic_with_auth_retry,
    _ytmusic_auto_tv_fallback_users,
)
from ytmusic_models import BatchSearchQuery, BatchSearchRequest, SearchRequest
from ytmusic_runtime import JsonList, JsonObject, _bound_cache, _sanitized_http_error, app, log
from ytmusicapi import YTMusic

from services.common.sidecar_runtime_utils import env_float, env_int

# Max queries accepted in a single batch search request.
_BATCH_SEARCH_MAX_QUERIES = 50
BATCH_CONCURRENCY = env_int("YTMUSIC_BATCH_CONCURRENCY", "3")
_batch_semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)
BATCH_DELAY_MIN = env_float("YTMUSIC_BATCH_DELAY_MIN", "0.3")
BATCH_DELAY_MAX = env_float("YTMUSIC_BATCH_DELAY_MAX", "1.0")

# Search result cache (in-memory, short TTL to reduce duplicate requests).
_search_cache: dict[str, JsonObject] = {}
_search_cache_lock = threading.Lock()
SEARCH_CACHE_TTL = env_int("YTMUSIC_SEARCH_CACHE_TTL", "300")  # 5 minutes
SEARCH_CACHE_MAX = env_int("YTMUSIC_SEARCH_CACHE_MAX", "1024")


def _parse_duration_text_value(value: Any) -> int:
    """
    Parse "mm:ss" or "hh:mm:ss" duration strings to seconds.
    Returns 0 when missing/invalid.
    """
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    text = str(value or "").strip()
    if ":" not in text:
        return 0
    parts = text.split(":")
    try:
        parts_int = [int(p) for p in parts]
    except ValueError:
        return 0
    if len(parts_int) == 3:
        return parts_int[0] * 3600 + parts_int[1] * 60 + parts_int[2]
    if len(parts_int) == 2:
        return parts_int[0] * 60 + parts_int[1]
    return 0


def _normalize_native_search_item(item: object) -> JsonObject | None:
    """
    Normalize search results into the connector shim shape used by the backend.
    This accepts both native `yt.search()` items and TV-parser candidates.
    """
    if not isinstance(item, dict):
        return None

    result_type = str(item.get("resultType") or item.get("type") or "").strip()
    normalized_type = result_type.lower() if result_type else "unknown"
    video_id = item.get("videoId")

    if not video_id:
        # Keep only directly playable entries for matching.
        return None

    artists_value = item.get("artists")
    artist_names: list[str] = []
    if isinstance(artists_value, list):
        for artist in artists_value:
            if isinstance(artist, dict):
                name = str(artist.get("name") or "").strip()
                if name:
                    artist_names.append(name)
            elif isinstance(artist, str):
                name = artist.strip()
                if name:
                    artist_names.append(name)

    primary_artist = (
        artist_names[0]
        if artist_names
        else str(item.get("artist") or item.get("author") or "Unknown").strip()
    )
    if not primary_artist:
        primary_artist = "Unknown"

    album = item.get("album")
    album_name: str | None = None
    if isinstance(album, dict):
        name = str(album.get("name") or "").strip()
        album_name = name or None
    elif isinstance(album, str):
        name = album.strip()
        album_name = name or None

    duration = item.get("duration")
    duration_seconds_raw = item.get("duration_seconds")
    if not isinstance(duration_seconds_raw, int):
        duration_seconds_raw = item.get("durationSeconds")
    duration_seconds = _parse_duration_text_value(
        duration_seconds_raw if duration_seconds_raw is not None else duration
    )

    thumbnails = item.get("thumbnails")
    if not isinstance(thumbnails, list):
        thumbnails = []

    title = str(item.get("title") or "").strip() or "Unknown"
    is_explicit = item.get("isExplicit")
    return {
        "type": normalized_type,
        "videoId": str(video_id),
        "title": title,
        "artist": primary_artist,
        "artists": artist_names,
        "album": album_name,
        "duration": str(duration or ""),
        "duration_seconds": duration_seconds,
        "thumbnails": thumbnails,
        "isExplicit": bool(is_explicit) if is_explicit is not None else False,
    }


def _native_search(
    yt: YTMusic,
    query: str,
    filter: Literal["songs", "albums", "artists", "videos"] | None = None,
    limit: int = 20,
) -> JsonList:
    """Execute yt.search() and normalize results to sidecar response shape."""
    raw_items: object = yt.search(query, filter=filter, limit=limit)
    if not isinstance(raw_items, list):
        return []

    normalized: JsonList = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        mapped = _normalize_native_search_item(item)
        if mapped:
            normalized.append(mapped)
    return normalized[:limit]


def _tv_search(yt: YTMusic, query: str, filter: str | None = None, limit: int = 20) -> JsonList:
    """
    WORKAROUND(#813) — Custom search parser for the TVHTML5 client.

    The standard yt.search() cannot parse the TV response format, so we
    call yt._send_request("search", ...) directly and parse the
    TV-specific renderers ourselves.

    REVERT: delete this entire function and restore the original
    search() endpoint that calls yt.search().  See the workaround
    registry at the top of this file for full instructions.

    Returns a list of dicts with keys: type, videoId, title, artist(s),
    album, duration, duration_seconds, thumbnails, etc.
    """
    body: JsonObject = {"query": query}

    # Apply filter params (song-only search).
    # For TVHTML5 the filter encoding is the same as WEB_REMIX.
    if filter == "songs":
        body["params"] = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    elif filter == "videos":
        body["params"] = "EgWKAQIQAWoMEA4QChADEAQQCRAF"
    elif filter == "albums":
        body["params"] = "EgWKAQIYAWoMEA4QChADEAQQCRAF"
    elif filter == "artists":
        body["params"] = "EgWKAQIgAWoMEA4QChADEAQQCRAF"

    try:
        raw = yt._send_request("search", body)
    except Exception:
        raise  # let caller handle

    items: JsonList = []

    def _extract_text(obj: Any) -> str:
        """Pull text from simpleText, runs, or accessibilityData."""
        if not obj:
            return ""
        if isinstance(obj, str):
            return obj
        if "simpleText" in obj:
            return str(obj["simpleText"])
        if "runs" in obj:
            return "".join(r.get("text", "") for r in obj["runs"])
        return ""

    def _parse_duration_text(text: str) -> int:
        """Convert '3:45' or '1:02:30' to seconds."""
        parts = text.strip().split(":")
        try:
            parts_int = [int(p) for p in parts]
        except ValueError:
            return 0
        if len(parts_int) == 3:
            return parts_int[0] * 3600 + parts_int[1] * 60 + parts_int[2]
        if len(parts_int) == 2:
            return parts_int[0] * 60 + parts_int[1]
        return 0

    def _parse_duration_label(text: str) -> int:
        """
        Parse human-readable accessibility labels like:
        - "3 minutes, 45 seconds"
        - "1 hour, 2 minutes, 5 seconds"
        """
        if not text:
            return 0
        lower = text.lower()
        hours = re.search(r"(\d+)\s*hour", lower)
        minutes = re.search(r"(\d+)\s*minute", lower)
        seconds = re.search(r"(\d+)\s*second", lower)
        if not any((hours, minutes, seconds)):
            return 0
        return (
            (int(hours.group(1)) * 3600 if hours else 0)
            + (int(minutes.group(1)) * 60 if minutes else 0)
            + (int(seconds.group(1)) if seconds else 0)
        )

    def _is_metadata_noise(text: str) -> bool:
        """Detect metadata tokens that are not artist/album labels."""
        value = (text or "").strip().lower()
        if not value or value == "\u2022":
            return True
        return bool(
            re.search(
                r"\b(view|views|ago|subscriber|subscribers|episode|episodes|song|songs)\b",
                value,
            )
        )

    def _walk_renderers(node: Any, depth: int = 0) -> None:
        """Recursively walk the TV response tree and extract results."""
        if depth > 15 or len(items) >= limit:
            return
        if isinstance(node, dict):
            # ── compactVideoRenderer (common in TVHTML5 search) ──
            if "compactVideoRenderer" in node:
                r = node["compactVideoRenderer"]
                vid = r.get("videoId", "")
                if vid:
                    title_text = _extract_text(r.get("title"))
                    # Short byline text usually has "Artist · Album" or just "Artist"
                    byline = _extract_text(r.get("shortBylineText") or r.get("longBylineText"))
                    duration_text = _extract_text(r.get("lengthText"))
                    thumbs = r.get("thumbnail", {}).get("thumbnails", [])
                    items.append(
                        {
                            "type": "song",
                            "videoId": vid,
                            "title": title_text,
                            "artist": byline.split("\u00b7")[0].strip() if byline else "Unknown",
                            "artists": [byline.split("\u00b7")[0].strip()] if byline else [],
                            "album": byline.split("\u00b7")[1].strip()
                            if "\u00b7" in byline
                            else None,
                            "duration": duration_text,
                            "duration_seconds": _parse_duration_text(duration_text),
                            "thumbnails": thumbs,
                            "isExplicit": False,
                        }
                    )
                return

            # ── tileRenderer (TVHTML5 v7+) ──
            if "tileRenderer" in node:
                r = node["tileRenderer"]
                nav_ep = r.get("onSelectCommand", {}).get("watchEndpoint", {})
                vid = nav_ep.get("videoId", "")
                if not vid:
                    # Try navigation endpoint
                    nav_ep2 = r.get("navigationEndpoint", {}).get("watchEndpoint", {})
                    vid = nav_ep2.get("videoId", "")
                if vid:
                    metadata = r.get("metadata", {}).get("tileMetadataRenderer", {})
                    title_text = (
                        _extract_text(
                            r.get("header", {}).get("tileHeaderRenderer", {}).get("title")
                        )
                        or _extract_text(metadata.get("title"))
                        or _extract_text(r.get("overlayMetadata", {}).get("primaryText"))
                    )

                    # metadata lines contain artist / album / duration
                    lines = metadata.get("lines", []) if metadata else []
                    artist_name = ""
                    album_name = None
                    duration_text = ""
                    duration_seconds = 0
                    for line in lines:
                        line_renderer = line.get("lineRenderer", {})
                        line_values: list[str] = []
                        for item_entry in line_renderer.get("items", []):
                            text_obj = item_entry.get("lineItemRenderer", {}).get("text")
                            lt = _extract_text(text_obj)
                            if lt:
                                line_values.append(lt)
                                # Duration looks like 3:45
                                if re.match(r"^\d{1,2}:\d{2}(:\d{2})?$", lt):
                                    duration_text = lt
                                    duration_seconds = _parse_duration_text(lt)
                            if isinstance(text_obj, dict):
                                accessibility_label = (
                                    text_obj.get("accessibility", {})
                                    .get("accessibilityData", {})
                                    .get("label", "")
                                )
                                if accessibility_label:
                                    duration_seconds = max(
                                        duration_seconds,
                                        _parse_duration_label(accessibility_label),
                                    )

                        if not artist_name and line_values:
                            primary_values = [
                                value for value in line_values if not _is_metadata_noise(value)
                            ]
                            if primary_values:
                                artist_name = primary_values[0]
                                if len(primary_values) > 1:
                                    album_name = primary_values[1]

                    if not artist_name and title_text and " - " in title_text:
                        # Fallback for titles like "Artist - Track Name".
                        artist_name = title_text.split(" - ", 1)[0].strip()

                    if duration_seconds > 0 and not duration_text:
                        minutes = duration_seconds // 60
                        seconds = duration_seconds % 60
                        duration_text = f"{minutes}:{seconds:02d}"

                    if not title_text:
                        # Last-resort fallback to avoid empty-title candidates.
                        title_text = _extract_text(metadata.get("title")) or "Unknown"

                    if not artist_name:
                        artist_name = "Unknown"

                    items.append(
                        {
                            "type": "song",
                            "videoId": vid,
                            "title": title_text,
                            "artist": artist_name,
                            "artists": [artist_name] if artist_name != "Unknown" else [],
                            "album": album_name,
                            "duration": duration_text,
                            "duration_seconds": duration_seconds,
                            "thumbnails": (
                                r.get("contentImage", {})
                                .get("musicThumbnailRenderer", {})
                                .get("thumbnail", {})
                                .get("thumbnails", [])
                            ),
                            "isExplicit": False,
                        }
                    )
                return

            # ── musicCardShelfRenderer (top result) ──
            if "musicCardShelfRenderer" in node:
                r = node["musicCardShelfRenderer"]
                nav_ep = (
                    r.get("title", {})
                    .get("runs", [{}])[0]
                    .get("navigationEndpoint", {})
                    .get("watchEndpoint", {})
                )
                vid = nav_ep.get("videoId", "")
                if vid:
                    title_text = _extract_text(r.get("title"))
                    subtitle = _extract_text(r.get("subtitle"))
                    items.append(
                        {
                            "type": "song",
                            "videoId": vid,
                            "title": title_text,
                            "artist": subtitle.split("\u00b7")[0].strip()
                            if subtitle
                            else "Unknown",
                            "artists": [subtitle.split("\u00b7")[0].strip()] if subtitle else [],
                            "album": None,
                            "duration": "",
                            "duration_seconds": 0,
                            "thumbnails": r.get("thumbnail", {})
                            .get("musicThumbnailRenderer", {})
                            .get("thumbnail", {})
                            .get("thumbnails", []),
                            "isExplicit": False,
                        }
                    )
                # Also walk children for more results
                for child in r.get("contents", []):
                    _walk_renderers(child, depth + 1)
                return

            # ── Fallback: walk all dict values ──
            for v in node.values():
                _walk_renderers(v, depth + 1)

        elif isinstance(node, list):
            for item_node in node:
                _walk_renderers(item_node, depth + 1)

    _walk_renderers(raw)

    normalized: JsonList = []
    for item in items:
        mapped = _normalize_native_search_item(item)
        if mapped:
            normalized.append(mapped)

    log.debug(
        "TV search %r filter=%r: parsed=%s normalized=%s",
        query,
        filter,
        len(items),
        len(normalized),
    )
    return normalized[:limit]


def _search_cache_key(
    user_id: str,
    query: str,
    filter_: str | None,
    limit: int,
    strategy: Literal["tv", "native"],
) -> str:
    """Build a deterministic cache key for search results."""
    return f"{user_id}:{strategy}:{query}:{filter_ or ''}:{limit}"


def _get_cached_search(
    user_id: str,
    query: str,
    filter_: str | None,
    limit: int,
    strategy: Literal["tv", "native"],
) -> JsonList | None:
    """Return cached search results if still valid, else None."""
    key = _search_cache_key(user_id, query, filter_, limit, strategy)
    with _search_cache_lock:
        entry = _search_cache.get(key)
        if entry and entry.get("expires_at", 0) <= time.time():
            del _search_cache[key]
            entry = None
    if entry and entry.get("expires_at", 0) > time.time():
        log.debug(f"Search cache hit: {key}")
        return cast(JsonList, entry["results"])
    return None


def _set_cached_search(
    user_id: str,
    query: str,
    filter_: str | None,
    limit: int,
    strategy: Literal["tv", "native"],
    results: JsonList,
) -> None:
    """Store search results in cache with TTL."""
    key = _search_cache_key(user_id, query, filter_, limit, strategy)
    with _search_cache_lock:
        _search_cache[key] = {
            "results": results,
            "expires_at": time.time() + SEARCH_CACHE_TTL,
        }
        expired_count = _clean_search_cache_locked()
        _bound_cache(_search_cache, SEARCH_CACHE_MAX)
    if expired_count:
        log.debug(f"Cleaned {expired_count} expired search cache entries")


def _search_once(
    user_id: str,
    query: str,
    filter_: Literal["songs", "albums", "artists", "videos"] | None,
    limit: int,
    strategy: Literal["tv", "native"],
    use_unauth_client: bool = False,
) -> JsonList:
    """
    Execute one search strategy with cache lookup/store.
    """
    cached = _get_cached_search(user_id, query, filter_, limit, strategy)
    if cached is not None:
        return cached

    if use_unauth_client:
        yt = _get_public_ytmusic(strategy)
        try:
            if strategy == "native":
                items = _native_search(yt, query, filter=filter_, limit=limit)
            else:
                items = _tv_search(yt, query, filter=filter_, limit=limit)
        except Exception as first_err:
            log.warning(
                "Public %s search client failed for user=%s query=%r; rebuilding and retrying once: %s",
                strategy,
                user_id,
                query,
                first_err,
            )
            _invalidate_public_ytmusic(strategy)
            retry_client = _get_public_ytmusic(strategy)
            if strategy == "native":
                items = _native_search(retry_client, query, filter=filter_, limit=limit)
            else:
                items = _tv_search(retry_client, query, filter=filter_, limit=limit)
    else:
        if strategy == "native":
            items = _run_ytmusic_with_auth_retry(
                user_id,
                operation=f"search-native query={query!r}",
                func=lambda yt: _native_search(yt, query, filter=filter_, limit=limit),
            )
        else:
            items = _run_ytmusic_with_auth_retry(
                user_id,
                operation=f"search-tv query={query!r}",
                func=lambda yt: _tv_search(yt, query, filter=filter_, limit=limit),
            )

    _set_cached_search(user_id, query, filter_, limit, strategy, items)
    return items


def _search_with_mode_fallback(
    user_id: str,
    query: str,
    filter_: Literal["songs", "albums", "artists", "videos"] | None,
    limit: int,
    use_unauth_client: bool = False,
) -> tuple[JsonList, Literal["tv", "native"]]:
    """
    Execute search according to configured mode.
    In auto mode, try native first and fall back to tv per-user on failure.
    `use_unauth_client=True` routes search through public clients so queries do
    not use user OAuth sessions.
    """
    strategy = _resolve_user_search_strategy(user_id)
    if strategy == "tv":
        return (
            _search_once(
                user_id,
                query,
                filter_,
                limit,
                "tv",
                use_unauth_client=use_unauth_client,
            ),
            "tv",
        )

    try:
        return (
            _search_once(
                user_id,
                query,
                filter_,
                limit,
                "native",
                use_unauth_client=use_unauth_client,
            ),
            "native",
        )
    except Exception as native_err:
        # Preserve explicit native behavior unless auto fallback is enabled.
        if SEARCH_MODE != "auto" or (not use_unauth_client and _is_oauth_auth_error(native_err)):
            raise

        log.warning(
            "Native yt.search() failed for user %s; switching to TV fallback "
            "(query=%r, filter=%r, error=%s)",
            user_id,
            query,
            filter_,
            native_err,
        )
        _ytmusic_auto_tv_fallback_users.add(user_id)
        if not use_unauth_client:
            _invalidate_ytmusic(user_id)
        return (
            _search_once(
                user_id,
                query,
                filter_,
                limit,
                "tv",
                use_unauth_client=use_unauth_client,
            ),
            "tv",
        )


def _clean_search_cache_locked() -> int:
    """Remove expired search entries while the owning lock is held."""
    now = time.time()
    expired = [k for k, v in _search_cache.items() if v.get("expires_at", 0) <= now]
    for k in expired:
        del _search_cache[k]
    return len(expired)


def _clean_search_cache() -> None:
    """Remove expired entries from search cache."""
    with _search_cache_lock:
        expired_count = _clean_search_cache_locked()
    if expired_count:
        log.debug(f"Cleaned {expired_count} expired search cache entries")


@app.post("/search")
async def search(req: SearchRequest, user_id: str = Query(...)) -> JsonObject:
    """Search YouTube Music for songs, albums, or artists.

    Search uses an unauthenticated client context so user OAuth search history
    is not touched. user_id is still used for cache segmentation and pacing.

    Mode behavior is controlled by YTMUSIC_SEARCH_MODE:
      - auto (default): try native and pin user to tv fallback on failure
      - tv: force TVHTML parser path
      - native: force ytmusicapi yt.search()
    """
    try:
        items, strategy = await asyncio.to_thread(
            _search_with_mode_fallback,
            user_id,
            req.query,
            req.filter,
            req.limit,
            use_unauth_client=True,
        )
        log.debug(
            "Search: query=%r, filter=%r, limit=%s, strategy=%s, configured_mode=%s",
            req.query,
            req.filter,
            req.limit,
            strategy,
            SEARCH_MODE,
        )
        return {"results": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Search for user {user_id} query={req.query!r} filter={req.filter!r}",
            e,
            500,
            "Search failed",
        ) from e


@app.post("/search/batch")
async def search_batch(req: BatchSearchRequest, user_id: str = Query(...)) -> JsonObject:
    """Run multiple search queries with controlled concurrency.

    Uses a semaphore to limit parallel InnerTube requests (default: 3)
    and adds random delays between requests to look organic.

    Rate-pacing: requests are throttled via _batch_semaphore and
    inter-request delays instead of firing all N simultaneously.
    """
    if len(req.queries) > _BATCH_SEARCH_MAX_QUERIES:
        raise HTTPException(
            status_code=422,
            detail=f"Batch search accepts at most {_BATCH_SEARCH_MAX_QUERIES} queries",
        )

    async def _run_one(q: BatchSearchQuery) -> JsonObject:
        """Execute and sanitize one query in the batch."""
        # Check primary cache first — avoids consuming a semaphore slot.
        strategy = _resolve_user_search_strategy(user_id)
        cached = _get_cached_search(user_id, q.query, q.filter, q.limit, strategy)
        if cached is not None:
            return {"results": cached, "total": len(cached), "error": None}

        async with _batch_semaphore:
            # Random delay between requests within the batch
            delay = random.uniform(  # noqa: S311 -- request pacing jitter is not security-sensitive
                BATCH_DELAY_MIN, BATCH_DELAY_MAX
            )
            await asyncio.sleep(delay)
            try:
                items, _used_strategy = await asyncio.to_thread(
                    _search_with_mode_fallback,
                    user_id,
                    q.query,
                    q.filter,
                    q.limit,
                    True,  # use_unauth_client
                )
                return {"results": items, "total": len(items), "error": None}
            except HTTPException:
                raise
            except Exception as e:
                log.warning(f"Batch search failed for query={q.query!r}: {e}")
                return {"results": [], "total": 0, "error": "search failed"}

    log.debug(
        f"Batch search: {len(req.queries)} queries for user {user_id} "
        f"(concurrency={BATCH_CONCURRENCY})"
    )
    results = await asyncio.gather(*[_run_one(q) for q in req.queries])
    return {"results": list(results)}


@app.post("/search/debug")
async def search_debug(req: SearchRequest, user_id: str = Query(...)) -> JsonObject:
    """WORKAROUND(#813) — Return the raw TV-format response for debugging.

    This endpoint lets us inspect the actual TVHTML5 response structure
    so we can tune the _tv_search parser.  NOT called by the backend —
    only for manual troubleshooting (e.g. curl from inside the container).

    REVERT: delete this entire endpoint when #813 is fixed.
    """
    # Keep user_id in the route signature for request-shape compatibility, but
    # debug search uses the public TV client like normal search paths.
    yt = _get_public_ytmusic("tv")
    body: JsonObject = {"query": req.query}
    if req.filter == "songs":
        body["params"] = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    try:
        raw = await asyncio.to_thread(yt._send_request, "search", body)
        return {"raw": raw}
    except Exception as e:
        raise _sanitized_http_error("Debug search", e, 500, "Debug search failed") from e
