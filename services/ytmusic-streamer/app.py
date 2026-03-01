"""
YouTube Music Streamer — FastAPI sidecar for soundspan.

Uses `ytmusicapi` for search/browse/library and `yt-dlp` for audio stream
URL extraction. Streams audio by proxying from YouTube's CDN — no files
are saved to disk.

Supports **per-user** OAuth credentials: each soundspan user connects their
own YouTube Music account. Credentials are stored as individual files
(`oauth_{user_id}.json`) and each user gets a separate YTMusic instance.

The Node.js backend communicates with this service over HTTP on port 8586,
passing `user_id` as a query parameter for per-user credential scoping on
user-private operations and per-user cache segmentation for public search.
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional, Literal, cast

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from ytmusicapi import YTMusic, OAuthCredentials

SERVICES_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICES_ROOT) not in sys.path:
    sys.path.append(str(SERVICES_ROOT))

from common.logging_utils import configure_service_logger
from common.sidecar_runtime_utils import (
    build_stream_proxy_client,
    env_float,
    env_int,
)

# ════════════════════════════════════════════════════════════════════
# WORKAROUND REGISTRY — ytmusicapi issue #813  (OAuth + WEB_REMIX broken)
# ════════════════════════════════════════════════════════════════════
#
# Since ~Aug 29 2025, Google's InnerTube API rejects ALL requests that
# combine an OAuth token with the WEB_REMIX client context (HTTP 400
# "Request contains an invalid argument"). This is tracked upstream at:
#
#   https://github.com/sigma67/ytmusicapi/issues/813
#
# Our workaround can switch the client context to TVHTML5 v7, which
# Google accepts with OAuth tokens. However the TVHTML5 client returns
# a different response format (TV renderers) that ytmusicapi's built-in
# parsers cannot handle, so we also implement a custom search parser
# (_tv_search). Runtime selection is controlled via YTMUSIC_SEARCH_MODE.
#
# ── PIECES OF THIS WORKAROUND (search for "WORKAROUND(#813)") ──────
#
#   1. _get_ytmusic()
#      In TV strategy, overrides yt.context clientName/clientVersion
#      to TVHTML5 and strips the API key from yt.params.
#
#   2. _tv_search()    — lines ~224-410
#      Entire function. Custom parser that calls yt._send_request()
#      directly and walks compactVideoRenderer / tileRenderer /
#      musicCardShelfRenderer trees to extract search results.
#
#   3. search()
#      Uses strategy-based search helper. TV strategy calls _tv_search();
#      native strategy calls yt.search().
#
#   4. search_debug()  — lines ~610-625
#      Debug endpoint for inspecting raw TV responses. Can be deleted.
#
# ── HOW TO REVERT WHEN UPSTREAM IS FIXED ───────────────────────────
#
#   1. Update ytmusicapi to the fixed version in requirements.txt.
#
#   2. In _get_ytmusic(): delete the 5 lines between the
#      "WORKAROUND(#813)" comment markers (the context override and
#      params reassignment). The YTMusic instance will then keep its
#      default WEB_REMIX context.
#
#   3. In search(): replace the call to _tv_search() with the
#      original yt.search() call and its result-mapping logic.
#      The original search handler is preserved in git history;
#      see the commit that introduced this workaround.
#
#   4. Delete the _tv_search() function entirely.
#
#   5. Delete the /search/debug endpoint (optional, was only for
#      troubleshooting the TV response format).
#
#   6. Verify that yt.search("test", filter="songs") returns results
#      without HTTP 400.
#
# ════════════════════════════════════════════════════════════════════

# ── Logging ─────────────────────────────────────────────────────────
log = configure_service_logger("ytmusic-streamer")

# ── FastAPI app ─────────────────────────────────────────────────────
app = FastAPI(title="soundspan YouTube Music Streamer", version="1.0.0")

# ── Paths ───────────────────────────────────────────────────────────
DATA_PATH = Path(os.getenv("DATA_PATH", "/data"))

# ════════════════════════════════════════════════════════════════════
# Rate-pacing & request safety configuration
# ════════════════════════════════════════════════════════════════════
# These settings control how we pace requests to YouTube's APIs,
# keeping usage respectful and within reasonable limits.
# Tune them via environment variables to balance speed vs. safety.

# Max concurrent InnerTube search requests in a batch (default: 3).
# Prevents firing 50 simultaneous requests that look bot-like.
BATCH_CONCURRENCY = env_int("YTMUSIC_BATCH_CONCURRENCY", "3")
_batch_semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)

# Delay range (seconds) between search requests within a batch.
# A random value in [min, max] is chosen to look organic.
BATCH_DELAY_MIN = env_float("YTMUSIC_BATCH_DELAY_MIN", "0.3")
BATCH_DELAY_MAX = env_float("YTMUSIC_BATCH_DELAY_MAX", "1.0")

# Delay range (seconds) between yt-dlp extractions.
EXTRACT_DELAY_MIN = env_float("YTMUSIC_EXTRACT_DELAY_MIN", "0.5")
EXTRACT_DELAY_MAX = env_float("YTMUSIC_EXTRACT_DELAY_MAX", "2.0")
_extract_lock = asyncio.Lock()   # Serialize yt-dlp extractions
_last_extract_time: float = 0.0  # Timestamp of last extraction

# Search result cache (in-memory, short TTL to reduce duplicate requests)
_search_cache: dict[str, dict] = {}
SEARCH_CACHE_TTL = env_int("YTMUSIC_SEARCH_CACHE_TTL", "300")  # 5 minutes
SEARCH_MODE = (os.getenv("YTMUSIC_SEARCH_MODE", "auto") or "auto").strip().lower()
if SEARCH_MODE not in {"tv", "native", "auto"}:
    log.warning(
        "Invalid YTMUSIC_SEARCH_MODE=%r (expected tv|native|auto); defaulting to auto",
        SEARCH_MODE,
    )
    SEARCH_MODE = "auto"

# Realistic browser User-Agent for yt-dlp and httpx proxy requests
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

import random

# ── Stream URL cache (in-memory, URLs expire after ~6h) ────────────
# Keys are "{user_id}:{video_id}" to isolate per-user sessions
_stream_cache: dict[str, dict] = {}
STREAM_CACHE_TTL = 5 * 60 * 60  # 5 hours (YouTube URLs expire at ~6h)
TV_CLIENT_NAME = "TVHTML5"
TV_CLIENT_VERSION = "7.20250101.00.00"

# ── YTMusic instances ────────────────────────────────────────────────
# Per-user authenticated clients are used for user-private operations
# (library, stream auth checks, browse calls).
_ytmusic_instances: dict[str, YTMusic] = {}
_ytmusic_lock = asyncio.Lock()
_ytmusic_auto_tv_fallback_users: set[str] = set()
# Public unauthenticated clients are used for search/matching so queries do not
# run under a user's OAuth session.
_public_ytmusic_instances: dict[Literal["tv", "native"], YTMusic] = {}


# ════════════════════════════════════════════════════════════════════
# Models
# ════════════════════════════════════════════════════════════════════

class OAuthTokenPayload(BaseModel):
    """OAuth tokens stored by the backend."""
    oauth_json: str  # Full JSON string from ytmusicapi OAuth


class DeviceCodeRequest(BaseModel):
    """Request to initiate device code flow."""
    client_id: str
    client_secret: str


class DeviceCodePollRequest(BaseModel):
    """Request to poll for device code completion."""
    client_id: str
    client_secret: str
    device_code: str


class SearchRequest(BaseModel):
    """Payload for single-query YouTube Music search requests."""
    query: str
    filter: Optional[Literal["songs", "albums", "artists", "videos"]] = None
    limit: int = 20


class BatchSearchQuery(BaseModel):
    """A single query within a batch search request."""
    query: str
    filter: Optional[Literal["songs", "albums", "artists", "videos"]] = None
    limit: int = 5  # Lower default for batch — we only need top results


class BatchSearchRequest(BaseModel):
    """Batch of search queries to execute concurrently."""
    queries: list[BatchSearchQuery]


# ════════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════════

def _oauth_file(user_id: str) -> Path:
    """Return the OAuth JSON path for a given user."""
    return DATA_PATH / f"oauth_{user_id}.json"


def _clear_user_search_fallback(user_id: str):
    """Clear per-user auto-fallback state so native search can be retried."""
    _ytmusic_auto_tv_fallback_users.discard(user_id)


def _resolve_user_search_strategy(user_id: str) -> Literal["tv", "native"]:
    """
    Resolve the active search strategy for a user.
    - tv:     always use TVHTML parser path
    - native: always use ytmusicapi yt.search()
    - auto:   start native; pin user to tv after native failure
    """
    if SEARCH_MODE == "tv":
        return "tv"
    if SEARCH_MODE == "native":
        return "native"
    if user_id in _ytmusic_auto_tv_fallback_users:
        return "tv"
    return "native"


def _apply_tv_client_context(yt: YTMusic):
    """Apply TVHTML5 client context required by the custom TV search parser."""
    yt.context["context"]["client"]["clientName"] = TV_CLIENT_NAME
    yt.context["context"]["client"]["clientVersion"] = TV_CLIENT_VERSION
    yt.params = "?alt=json"  # TV client must NOT send the API key


def _get_public_ytmusic(strategy: Literal["tv", "native"]) -> YTMusic:
    """
    Get or create an unauthenticated YTMusic instance for public search.
    """
    existing = _public_ytmusic_instances.get(strategy)
    if existing:
        return existing

    yt = YTMusic()
    if strategy == "tv":
        _apply_tv_client_context(yt)
    _public_ytmusic_instances[strategy] = yt
    return yt


def _invalidate_public_ytmusic(strategy: Literal["tv", "native"]):
    """Force re-creation of a public search client on next use."""
    _public_ytmusic_instances.pop(strategy, None)


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


def _normalize_native_search_item(item: dict) -> Optional[dict]:
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
    album_name: Optional[str] = None
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
    filter: Optional[str] = None,
    limit: int = 20,
) -> list[dict]:
    """Execute yt.search() and normalize results to sidecar response shape."""
    raw_items = yt.search(query, filter=filter, limit=limit)
    if not isinstance(raw_items, list):
        return []

    normalized: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        mapped = _normalize_native_search_item(item)
        if mapped:
            normalized.append(mapped)
    return normalized[:limit]


def _get_ytmusic(user_id: str) -> YTMusic:
    """Get or create an authenticated YTMusic instance for a specific user."""
    if user_id in _ytmusic_instances:
        return _ytmusic_instances[user_id]

    oauth_path = _oauth_file(user_id)
    if oauth_path.exists():
        try:
            # Read the oauth JSON to check if it has custom client credentials
            oauth_data = json.loads(oauth_path.read_text())

            # Build OAuthCredentials if client_id/client_secret are stored alongside
            oauth_creds = None
            creds_path = DATA_PATH / f"client_creds_{user_id}.json"
            if creds_path.exists():
                creds_data = json.loads(creds_path.read_text())
                oauth_creds = OAuthCredentials(
                    client_id=creds_data["client_id"],
                    client_secret=creds_data["client_secret"],
                )

            if oauth_creds:
                yt = YTMusic(str(oauth_path), oauth_credentials=oauth_creds)
            else:
                yt = YTMusic(str(oauth_path))

            client_mode = _resolve_user_search_strategy(user_id)
            if client_mode == "tv":
                # ── WORKAROUND(#813) START ──────────────────────────────
                # Google broke OAuth + WEB_REMIX since ~Aug 29 2025.
                # Switching the client context to TVHTML5 v7 makes OAuth
                # requests succeed. The response format is different (TV
                # renderers instead of musicShelfRenderer), so we use a
                # custom search parser (_tv_search) below.
                #
                # Original values (set by ytmusicapi's initialize_context()):
                #   clientName    = "WEB_REMIX"
                #   clientVersion = "1.yyyymmdd.xx.xx"  (auto-detected)
                #   yt.params     = "?alt=json&key=<INNERTUBE_API_KEY>"
                _apply_tv_client_context(yt)
                # ── WORKAROUND(#813) END ────────────────────────────────

            _ytmusic_instances[user_id] = yt
            log.info(
                "Loaded YTMusic for user %s (search_strategy=%s, configured_mode=%s)",
                user_id,
                client_mode,
                SEARCH_MODE,
            )
            return yt
        except Exception as e:
            log.error(f"Failed to load OAuth for user {user_id}: {e}")
            raise HTTPException(
                status_code=401,
                detail="OAuth credentials invalid. Please re-authenticate.",
            )

    raise HTTPException(
        status_code=401,
        detail="Not authenticated. Please set up OAuth first.",
    )


def _invalidate_ytmusic(user_id: str):
    """Force re-creation of a user's YTMusic instance on next use."""
    _ytmusic_instances.pop(user_id, None)


def _is_oauth_auth_error(err: Exception) -> bool:
    """Best-effort detection for OAuth expiry/revocation/auth failures."""
    if isinstance(err, HTTPException):
        return err.status_code == 401

    response = getattr(err, "response", None)
    response_status = getattr(response, "status_code", None)
    if response_status in (401, 403):
        return True

    status_code = getattr(err, "status_code", None)
    if status_code in (401, 403):
        return True

    message = str(err).lower()
    markers = (
        "invalid_grant",
        "expired_token",
        "token has expired",
        "authentication",
        "not authenticated",
        "oauth",
        "login required",
        "unauthorized",
        "forbidden",
        "invalid credentials",
        "refresh token",
        "access token",
    )
    return any(marker in message for marker in markers)


def _run_ytmusic_with_auth_retry(
    user_id: str,
    operation: str,
    func: Callable[[YTMusic], Any],
) -> Any:
    """
    Execute a YTMusic call with one invalidate/reload retry on auth errors.
    """
    yt = _get_ytmusic(user_id)

    try:
        return func(yt)
    except Exception as first_err:
        # In auto mode, transparently migrate users to TV strategy when the
        # known #813 invalid-argument failure appears on non-search calls.
        if (
            SEARCH_MODE == "auto"
            and user_id not in _ytmusic_auto_tv_fallback_users
            and _is_issue_813_invalid_argument_error(first_err)
        ):
            log.warning(
                "Detected ytmusicapi #813 signature during %s for user %s; "
                "switching this user to TV fallback and retrying once.",
                operation,
                user_id,
            )
            _ytmusic_auto_tv_fallback_users.add(user_id)
            _invalidate_ytmusic(user_id)
            try:
                fallback_client = _get_ytmusic(user_id)
                return func(fallback_client)
            except HTTPException as retry_http:
                if retry_http.status_code == 401:
                    raise HTTPException(
                        status_code=401,
                        detail="OAuth credentials expired or invalid. Please re-authenticate.",
                    )
                raise
            except Exception as retry_err:
                if _is_oauth_auth_error(retry_err):
                    _invalidate_ytmusic(user_id)
                    raise HTTPException(
                        status_code=401,
                        detail="OAuth credentials expired or invalid. Please re-authenticate.",
                    )
                raise

        if not _is_oauth_auth_error(first_err):
            raise

        log.warning(
            f"OAuth issue during {operation} for user {user_id}; reloading credentials and retrying once: {first_err}"
        )
        _invalidate_ytmusic(user_id)

        try:
            refreshed = _get_ytmusic(user_id)
            return func(refreshed)
        except HTTPException as retry_http:
            if retry_http.status_code == 401:
                raise HTTPException(
                    status_code=401,
                    detail="OAuth credentials expired or invalid. Please re-authenticate.",
                )
            raise
        except Exception as retry_err:
            if _is_oauth_auth_error(retry_err):
                _invalidate_ytmusic(user_id)
                raise HTTPException(
                    status_code=401,
                    detail="OAuth credentials expired or invalid. Please re-authenticate.",
                )
            raise


def _is_issue_813_invalid_argument_error(err: Exception) -> bool:
    """Detect the OAuth + WEB_REMIX invalid-argument failure signature."""
    response = getattr(err, "response", None)
    response_status = getattr(response, "status_code", None)
    response_text = ""
    if response is not None:
        response_text = str(getattr(response, "text", "") or "")

    message = f"{err} {response_text}".lower()
    if response_status != 400:
        return False
    markers = (
        "request contains an invalid argument",
        "invalid argument",
        "invalid_argument",
        "badrequest",
    )
    return any(marker in message for marker in markers)


def _get_stream_url_sync(user_id: str, video_id: str, quality: str = "HIGH") -> dict:
    """
    Use yt-dlp to extract audio stream URL for a YouTube Music video.
    Returns dict with url, format, duration, expires_at.

    Rate-pacing measures:
    - Realistic browser User-Agent in HTTP headers
    - sleep_interval between yt-dlp requests
    - Extraction serialized via _extract_lock with random inter-request delay
    """
    import yt_dlp

    cache_key = f"{user_id}:{video_id}"

    # Check cache first
    cached = _stream_cache.get(cache_key)
    if cached and cached.get("expires_at", 0) > time.time():
        log.debug(f"Stream URL cache hit for {cache_key}")
        return cached

    # Enforce inter-extraction delay to avoid rapid-fire requests
    global _last_extract_time
    now = time.time()
    elapsed = now - _last_extract_time
    min_gap = random.uniform(EXTRACT_DELAY_MIN, EXTRACT_DELAY_MAX)
    if elapsed < min_gap:
        sleep_time = min_gap - elapsed
        log.debug(f"Throttling yt-dlp extraction by {sleep_time:.2f}s")
        time.sleep(sleep_time)
    _last_extract_time = time.time()

    # Map quality to yt-dlp format selection
    format_map = {
        "LOW": "ba[abr<=64]/worstaudio/ba",
        "MEDIUM": "ba[abr<=128]/ba[abr<=192]/ba",
        "HIGH": "ba[abr<=256]/ba",
        "LOSSLESS": "ba/bestaudio",
    }
    fmt = format_map.get(quality, format_map["HIGH"])

    ydl_opts = {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        # ── Request safety ───────────────────────────────────────────
        # Realistic browser headers so yt-dlp requests look like a
        # normal Chrome session rather than a scripted extractor.
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://music.youtube.com/",
        },
        # Use the Android client for extraction — it exposes direct
        # audio URLs more reliably and is less aggressively throttled.
        "extractor_args": {
            "youtube": {
                "player_client": ["android_music"],
            },
        },
    }

    url = f"https://music.youtube.com/watch?v={video_id}"

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            if not info:
                raise ValueError("No info extracted")

            stream_url = info.get("url")
            if not stream_url:
                # Try to find audio format in formats list
                formats = info.get("formats", [])
                audio_formats = [
                    f for f in formats
                    if f.get("acodec") != "none" and f.get("vcodec") in ("none", None)
                ]
                if audio_formats:
                    audio_formats.sort(key=lambda f: f.get("abr", 0) or 0, reverse=True)
                    stream_url = audio_formats[0].get("url")

            if not stream_url:
                raise ValueError("No audio stream URL found")

            result = {
                "url": stream_url,
                "content_type": info.get("audio_ext", "m4a"),
                "duration": info.get("duration", 0),
                "title": info.get("title", ""),
                "artist": info.get("artist") or info.get("uploader", ""),
                "expires_at": time.time() + STREAM_CACHE_TTL,
                "abr": info.get("abr", 0),
                "acodec": info.get("acodec", ""),
            }

            _stream_cache[cache_key] = result
            log.debug(f"Extracted stream URL for {cache_key}: {result['acodec']} @ {result['abr']}kbps")
            return result

    except Exception as e:
        error_str = str(e)
        log.error(f"yt-dlp extraction failed for {video_id}: {error_str}")

        # Detect age-restricted content
        if "Sign in to confirm your age" in error_str or "age" in error_str.lower() and "confirm" in error_str.lower():
            raise HTTPException(
                status_code=451,
                detail={
                    "error": "age_restricted",
                    "message": "This content requires age verification and cannot be streamed.",
                    "video_id": video_id,
                }
            )

        raise HTTPException(status_code=502, detail=f"Failed to extract stream: {error_str}")


def _tv_search(yt: YTMusic, query: str, filter: Optional[str] = None, limit: int = 20) -> list[dict]:
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
    body: dict = {"query": query}

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

    items: list[dict] = []

    def _extract_text(obj) -> str:
        """Pull text from simpleText, runs, or accessibilityData."""
        if not obj:
            return ""
        if isinstance(obj, str):
            return obj
        if "simpleText" in obj:
            return obj["simpleText"]
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

    def _walk_renderers(node, depth=0):
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
                    items.append({
                        "type": "song",
                        "videoId": vid,
                        "title": title_text,
                        "artist": byline.split("\u00b7")[0].strip() if byline else "Unknown",
                        "artists": [byline.split("\u00b7")[0].strip()] if byline else [],
                        "album": byline.split("\u00b7")[1].strip() if "\u00b7" in byline else None,
                        "duration": duration_text,
                        "duration_seconds": _parse_duration_text(duration_text),
                        "thumbnails": thumbs,
                        "isExplicit": False,
                    })
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
                        _extract_text(r.get("header", {}).get("tileHeaderRenderer", {}).get("title"))
                        or _extract_text(metadata.get("title"))
                        or _extract_text(
                            r.get("overlayMetadata", {})
                            .get("primaryText")
                        )
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
                            text_obj = (
                                item_entry.get("lineItemRenderer", {}).get("text")
                            )
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

                    items.append({
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
                    })
                return

            # ── musicCardShelfRenderer (top result) ──
            if "musicCardShelfRenderer" in node:
                r = node["musicCardShelfRenderer"]
                nav_ep = (r.get("title", {}).get("runs", [{}])[0].get("navigationEndpoint", {})
                          .get("watchEndpoint", {}))
                vid = nav_ep.get("videoId", "")
                if vid:
                    title_text = _extract_text(r.get("title"))
                    subtitle = _extract_text(r.get("subtitle"))
                    items.append({
                        "type": "song",
                        "videoId": vid,
                        "title": title_text,
                        "artist": subtitle.split("\u00b7")[0].strip() if subtitle else "Unknown",
                        "artists": [subtitle.split("\u00b7")[0].strip()] if subtitle else [],
                        "album": None,
                        "duration": "",
                        "duration_seconds": 0,
                        "thumbnails": r.get("thumbnail", {}).get("musicThumbnailRenderer", {}).get("thumbnail", {}).get("thumbnails", []),
                        "isExplicit": False,
                    })
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

    normalized: list[dict] = []
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


def _clean_stream_cache():
    """Remove expired entries from stream cache."""
    now = time.time()
    expired = [k for k, v in _stream_cache.items() if v.get("expires_at", 0) <= now]
    for k in expired:
        del _stream_cache[k]
    if expired:
        log.debug(f"Cleaned {len(expired)} expired stream cache entries")


def _search_cache_key(
    user_id: str,
    query: str,
    filter_: Optional[str],
    limit: int,
    strategy: Literal["tv", "native"],
) -> str:
    """Build a deterministic cache key for search results."""
    return f"{user_id}:{strategy}:{query}:{filter_ or ''}:{limit}"


def _get_cached_search(
    user_id: str,
    query: str,
    filter_: Optional[str],
    limit: int,
    strategy: Literal["tv", "native"],
) -> Optional[list]:
    """Return cached search results if still valid, else None."""
    key = _search_cache_key(user_id, query, filter_, limit, strategy)
    entry = _search_cache.get(key)
    if entry and entry.get("expires_at", 0) > time.time():
        log.debug(f"Search cache hit: {key}")
        return entry["results"]
    if entry:
        del _search_cache[key]
    return None


def _set_cached_search(
    user_id: str,
    query: str,
    filter_: Optional[str],
    limit: int,
    strategy: Literal["tv", "native"],
    results: list,
):
    """Store search results in cache with TTL."""
    key = _search_cache_key(user_id, query, filter_, limit, strategy)
    _search_cache[key] = {
        "results": results,
        "expires_at": time.time() + SEARCH_CACHE_TTL,
    }


def _search_once(
    user_id: str,
    query: str,
    filter_: Optional[str],
    limit: int,
    strategy: Literal["tv", "native"],
    use_unauth_client: bool = False,
) -> list[dict]:
    """
    Execute one search strategy with cache lookup/store.
    """
    cached = _get_cached_search(user_id, query, filter_, limit, strategy)
    if cached is not None:
        return cast(list[dict], cached)

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
                items = _native_search(
                    retry_client, query, filter=filter_, limit=limit
                )
            else:
                items = _tv_search(
                    retry_client, query, filter=filter_, limit=limit
                )
    else:
        if strategy == "native":
            items = _run_ytmusic_with_auth_retry(
                user_id,
                operation=f"search-native query={query!r}",
                func=lambda yt: _native_search(
                    yt, query, filter=filter_, limit=limit
                ),
            )
        else:
            items = _run_ytmusic_with_auth_retry(
                user_id,
                operation=f"search-tv query={query!r}",
                func=lambda yt: _tv_search(
                    yt, query, filter=filter_, limit=limit
                ),
            )

    _set_cached_search(user_id, query, filter_, limit, strategy, items)
    return items


def _search_with_mode_fallback(
    user_id: str,
    query: str,
    filter_: Optional[str],
    limit: int,
    use_unauth_client: bool = False,
) -> tuple[list[dict], Literal["tv", "native"]]:
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
        if SEARCH_MODE != "auto" or (
            not use_unauth_client and _is_oauth_auth_error(native_err)
        ):
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


def _clean_search_cache():
    """Remove expired entries from search cache."""
    now = time.time()
    expired = [k for k, v in _search_cache.items() if v.get("expires_at", 0) <= now]
    for k in expired:
        del _search_cache[k]
    if expired:
        log.debug(f"Cleaned {len(expired)} expired search cache entries")


# ════════════════════════════════════════════════════════════════════
# Routes
# ════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    # Count how many users have OAuth files
    oauth_files = list(DATA_PATH.glob("oauth_*.json"))
    return {
        "status": "ok",
        "service": "ytmusic-streamer",
        "authenticated_users": len(oauth_files),
        "search_mode": SEARCH_MODE,
        "auto_tv_fallback_users": len(_ytmusic_auto_tv_fallback_users),
    }


# ── OAuth Authentication (per-user) ────────────────────────────────

@app.get("/auth/status")
async def auth_status(user_id: str = Query(...)):
    """Check if a specific user has valid OAuth credentials."""
    oauth_path = _oauth_file(user_id)

    if not oauth_path.exists():
        return {"authenticated": False, "reason": "No OAuth credentials found"}

    try:
        _get_ytmusic(user_id)
        return {"authenticated": True}
    except Exception as e:
        return {"authenticated": False, "reason": str(e)}


@app.post("/auth/restore")
async def auth_restore(req: Request, user_id: str = Query(...)):
    """
    Restore OAuth credentials for a user from the backend database.
    The backend sends the decrypted OAuth JSON which is written as
    the user's credential file so that ytmusicapi can use it.
    Optionally accepts client_id/client_secret for OAuthCredentials.
    """
    body = await req.json()
    oauth_json = body.get("oauth_json")
    if not oauth_json:
        raise HTTPException(status_code=400, detail="oauth_json is required")

    try:
        json.loads(oauth_json)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON in oauth_json")

    DATA_PATH.mkdir(parents=True, exist_ok=True)
    _oauth_file(user_id).write_text(oauth_json)

    # Save client credentials if provided
    client_id = body.get("client_id")
    client_secret = body.get("client_secret")
    if client_id and client_secret:
        creds_path = DATA_PATH / f"client_creds_{user_id}.json"
        creds_path.write_text(json.dumps({
            "client_id": client_id,
            "client_secret": client_secret,
        }))

    _invalidate_ytmusic(user_id)
    _clear_user_search_fallback(user_id)
    log.info(f"OAuth credentials restored for user {user_id}")
    return {"status": "ok", "message": "OAuth credentials restored"}


@app.post("/auth/clear")
async def auth_clear(user_id: str = Query(...)):
    """Remove stored OAuth credentials for a specific user."""
    _invalidate_ytmusic(user_id)
    _clear_user_search_fallback(user_id)
    oauth_path = _oauth_file(user_id)
    if oauth_path.exists():
        oauth_path.unlink()
    creds_path = DATA_PATH / f"client_creds_{user_id}.json"
    if creds_path.exists():
        creds_path.unlink()
    log.info(f"OAuth credentials cleared for user {user_id}")
    return {"status": "ok", "message": "OAuth credentials removed"}


# ── OAuth Device Code Flow ──────────────────────────────────────────

@app.post("/auth/device-code")
async def auth_device_code(req: DeviceCodeRequest):
    """
    Initiate the Google OAuth device code flow.
    Returns a user_code and verification_url for the user to visit.
    """
    try:
        oauth_creds = OAuthCredentials(
            client_id=req.client_id,
            client_secret=req.client_secret,
        )
        code = oauth_creds.get_code()
        log.info(f"Device code flow initiated, user_code: {code.get('user_code')}")
        return {
            "device_code": code["device_code"],
            "user_code": code["user_code"],
            "verification_url": code["verification_url"],
            "expires_in": code.get("expires_in", 1800),
            "interval": code.get("interval", 5),
        }
    except Exception as e:
        log.error(f"Device code initiation failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to initiate device code flow: {str(e)}",
        )


@app.post("/auth/device-code/poll")
async def auth_device_code_poll(req: DeviceCodePollRequest, user_id: str = Query(...)):
    """
    Poll for device code authorization completion.
    Returns the OAuth token JSON when the user completes authorization,
    or a pending status if still waiting.
    """
    # User-friendly error descriptions
    ERROR_MESSAGES = {
        "invalid_grant": "The sign-in code has expired or was already used. Please start over.",
        "expired_token": "The sign-in code has expired. Please start over.",
        "access_denied": "Access was denied. Please try again and click 'Allow' on the Google page.",
        "invalid_client": "OAuth client credentials are invalid. Please ask your admin to check the Client ID and Secret.",
    }

    try:
        oauth_creds = OAuthCredentials(
            client_id=req.client_id,
            client_secret=req.client_secret,
        )
        token = oauth_creds.token_from_code(req.device_code)

        # Check if we got an error (authorization_pending, slow_down, etc.)
        if "error" in token:
            error = token["error"]
            if error in ("authorization_pending", "slow_down"):
                return {"status": "pending", "error": error}
            else:
                friendly = ERROR_MESSAGES.get(error, f"Authorization failed ({error}). Please try again.")
                log.error(f"Device code poll error: {error}")
                return {"status": "error", "error": friendly}

        # Success — we have a token. Save it for this user.
        DATA_PATH.mkdir(parents=True, exist_ok=True)
        token_json = json.dumps(dict(token), indent=True)
        _oauth_file(user_id).write_text(token_json)

        # Save client credentials alongside so _get_ytmusic can use them
        creds_path = DATA_PATH / f"client_creds_{user_id}.json"
        creds_path.write_text(json.dumps({
            "client_id": req.client_id,
            "client_secret": req.client_secret,
        }))

        _invalidate_ytmusic(user_id)
        _clear_user_search_fallback(user_id)
        log.info(f"Device code flow completed for user {user_id}")

        return {
            "status": "success",
            "oauth_json": token_json,
        }
    except Exception as e:
        error_str = str(e).lower()
        # ytmusicapi raises exceptions for pending states too
        if "authorization_pending" in error_str:
            return {"status": "pending", "error": "authorization_pending"}

        # Check for known error types in exception messages
        for error_key, friendly_msg in ERROR_MESSAGES.items():
            if error_key in error_str:
                log.warning(f"Device code poll error for user {user_id}: {error_key}")
                return {"status": "error", "error": friendly_msg}

        log.error(f"Device code poll failed for user {user_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to poll device code: {str(e)}",
        )


# ── Search ──────────────────────────────────────────────────────────

@app.post("/search")
async def search(req: SearchRequest, user_id: str = Query(...)):
    """Search YouTube Music for songs, albums, or artists.

    Search uses an unauthenticated client context so user OAuth search history
    is not touched. user_id is still used for cache segmentation and pacing.

    Mode behavior is controlled by YTMUSIC_SEARCH_MODE:
      - auto (default): try native and pin user to tv fallback on failure
      - tv: force TVHTML parser path
      - native: force ytmusicapi yt.search()
    """
    try:
        items, strategy = _search_with_mode_fallback(
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
        log.error(f"Search failed for user {user_id} query={req.query!r} filter={req.filter!r}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/batch")
async def search_batch(req: BatchSearchRequest, user_id: str = Query(...)):
    """Run multiple search queries with controlled concurrency.

    Uses a semaphore to limit parallel InnerTube requests (default: 3)
    and adds random delays between requests to look organic.

    Rate-pacing: requests are throttled via _batch_semaphore and
    inter-request delays instead of firing all N simultaneously.
    """
    async def _run_one(q: BatchSearchQuery) -> dict:
        # Check primary cache first — avoids consuming a semaphore slot.
        strategy = _resolve_user_search_strategy(user_id)
        cached = _get_cached_search(user_id, q.query, q.filter, q.limit, strategy)
        if cached is not None:
            return {"results": cached, "total": len(cached), "error": None}

        async with _batch_semaphore:
            # Random delay between requests within the batch
            delay = random.uniform(BATCH_DELAY_MIN, BATCH_DELAY_MAX)
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
                return {"results": [], "total": 0, "error": str(e)}

    log.debug(f"Batch search: {len(req.queries)} queries for user {user_id} "
              f"(concurrency={BATCH_CONCURRENCY})")
    results = await asyncio.gather(*[_run_one(q) for q in req.queries])
    return {"results": list(results)}


@app.post("/search/debug")
async def search_debug(req: SearchRequest, user_id: str = Query(...)):
    """WORKAROUND(#813) — Return the raw TV-format response for debugging.

    This endpoint lets us inspect the actual TVHTML5 response structure
    so we can tune the _tv_search parser.  NOT called by the backend —
    only for manual troubleshooting (e.g. curl from inside the container).

    REVERT: delete this entire endpoint when #813 is fixed.
    """
    # Keep user_id in the route signature for request-shape compatibility, but
    # debug search uses the public TV client like normal search paths.
    yt = _get_public_ytmusic("tv")
    body: dict = {"query": req.query}
    if req.filter == "songs":
        body["params"] = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    try:
        raw = yt._send_request("search", body)
        return {"raw": raw}
    except Exception as e:
        log.error(f"Debug search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/album/{browse_id}")
async def get_album(browse_id: str, user_id: str = Query(...)):
    """Get album details and track listing from YouTube Music."""
    try:
        album = _run_ytmusic_with_auth_retry(
            user_id,
            operation=f"get_album({browse_id})",
            func=lambda yt: yt.get_album(browse_id),
        )

        tracks = []
        for t in album.get("tracks", []):
            artists = t.get("artists", [])
            tracks.append({
                "videoId": t.get("videoId"),
                "title": t.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "artists": [a.get("name") for a in artists],
                "trackNumber": t.get("trackNumber"),
                "duration": t.get("duration"),
                "duration_seconds": t.get("duration_seconds"),
                "isExplicit": t.get("isExplicit", False),
                "likeStatus": t.get("likeStatus"),
            })

        thumbnails = album.get("thumbnails", [])
        return {
            "browseId": browse_id,
            "title": album.get("title"),
            "artist": album.get("artists", [{}])[0].get("name") if album.get("artists") else "Unknown",
            "artists": [a.get("name") for a in album.get("artists", [])],
            "year": album.get("year"),
            "trackCount": album.get("trackCount"),
            "duration": album.get("duration"),
            "type": album.get("type", "Album"),
            "thumbnails": thumbnails,
            "coverUrl": thumbnails[-1].get("url") if thumbnails else None,
            "tracks": tracks,
            "description": album.get("description"),
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Get album failed for {browse_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/artist/{channel_id}")
async def get_artist(channel_id: str, user_id: str = Query(...)):
    """Get artist details from YouTube Music."""
    try:
        artist = _run_ytmusic_with_auth_retry(
            user_id,
            operation=f"get_artist({channel_id})",
            func=lambda yt: yt.get_artist(channel_id),
        )

        songs = []
        for s in (artist.get("songs", {}).get("results", []))[:10]:
            artists = s.get("artists", [])
            songs.append({
                "videoId": s.get("videoId"),
                "title": s.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "album": s.get("album", {}).get("name") if s.get("album") else None,
                "duration": s.get("duration"),
            })

        albums = []
        for a in (artist.get("albums", {}).get("results", []))[:20]:
            albums.append({
                "browseId": a.get("browseId"),
                "title": a.get("title"),
                "year": a.get("year"),
                "type": a.get("type", "Album"),
                "thumbnails": a.get("thumbnails", []),
            })

        thumbnails = artist.get("thumbnails", [])
        return {
            "channelId": channel_id,
            "name": artist.get("name"),
            "description": artist.get("description"),
            "thumbnails": thumbnails,
            "subscribers": artist.get("subscribers"),
            "songs": songs,
            "albums": albums,
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Get artist failed for {channel_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/song/{video_id}")
async def get_song(video_id: str, user_id: str = Query(...)):
    """Get song metadata from YouTube Music."""
    try:
        song = _run_ytmusic_with_auth_retry(
            user_id,
            operation=f"get_song({video_id})",
            func=lambda yt: yt.get_song(video_id),
        )
        video_details = song.get("videoDetails", {})

        return {
            "videoId": video_details.get("videoId"),
            "title": video_details.get("title"),
            "artist": video_details.get("author"),
            "duration": int(video_details.get("lengthSeconds", 0)),
            "thumbnails": video_details.get("thumbnail", {}).get("thumbnails", []),
            "isOwner": video_details.get("isOwnerViewing", False),
            "viewCount": video_details.get("viewCount"),
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Get song failed for {video_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Streaming ───────────────────────────────────────────────────────

@app.get("/stream/{video_id}")
async def get_stream_info(video_id: str, user_id: str = Query(...), quality: str = "HIGH"):
    """Get stream URL info for a video (metadata only, no proxy).

    When user_id is "__public__", skips OAuth verification.
    """
    # Skip OAuth check for public/unauthenticated streaming
    if user_id != "__public__":
        _get_ytmusic(user_id)

    result = await asyncio.to_thread(_get_stream_url_sync, user_id, video_id, quality)
    return {
        "videoId": video_id,
        "url": result["url"],
        "content_type": result["content_type"],
        "duration": result["duration"],
        "abr": result.get("abr", 0),
        "acodec": result.get("acodec", ""),
        "expires_at": result["expires_at"],
    }


@app.get("/proxy/{video_id}")
async def proxy_stream(
    video_id: str,
    user_id: str = Query(...),
    quality: str = "HIGH",
    request: Request = None,
):
    """
    Proxy the audio stream from YouTube. The backend pipes this to the
    frontend player. Stream URLs are IP-locked to the server, so we
    must proxy.

    When user_id is "__public__", skips OAuth verification (yt-dlp
    extraction is unauthenticated). This enables free-tier streaming
    for users without YT Music OAuth connected.
    """
    # Skip OAuth check for public/unauthenticated streaming
    if user_id != "__public__":
        _get_ytmusic(user_id)

    stream_info = await asyncio.to_thread(_get_stream_url_sync, user_id, video_id, quality)
    stream_url = stream_info["url"]

    # Determine content type for the response
    acodec = stream_info.get("acodec", "")
    if "opus" in acodec:
        content_type = "audio/webm"
    elif "mp4a" in acodec or "aac" in acodec:
        content_type = "audio/mp4"
    else:
        content_type = "audio/mp4"

    # Build headers for upstream request — use realistic browser headers
    # so CDN requests look like a normal Chrome session.
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://music.youtube.com/",
        "Origin": "https://music.youtube.com",
    }
    if request and "range" in request.headers:
        headers["Range"] = request.headers["range"]

    async def stream_audio():
        async with build_stream_proxy_client(user_agent=_USER_AGENT) as client:
            try:
                async with client.stream("GET", stream_url, headers=headers) as response:
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        yield chunk
            except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
                log.error(f"Upstream stream error for {video_id}: {e}")
                # Don't re-raise — just end the stream gracefully so the
                # browser audio element can retry with a new Range request.
                return

    # For range requests, fetch upstream first to get headers
    if headers.get("Range"):
        # IMPORTANT: Do NOT use `async with` for the client here.
        # The client must stay alive for the entire duration of the stream,
        # not just until the StreamingResponse object is created.  If we
        # used `async with`, the `return` would exit the context manager,
        # closing the client/connection before Starlette ever iterates
        # the generator — causing an immediate ReadError on every request.
        client = build_stream_proxy_client(user_agent=_USER_AGENT)
        upstream = await client.send(
            client.build_request("GET", stream_url, headers=headers),
            stream=True,
        )
        response_headers = {
            "Content-Type": content_type,
            "Accept-Ranges": "bytes",
        }
        if "content-range" in upstream.headers:
            response_headers["Content-Range"] = upstream.headers["content-range"]
        # NOTE: We intentionally do NOT forward Content-Length here.
        # If the upstream drops mid-stream (ReadError), h11 enforces the
        # declared length and raises "Too little data for declared
        # Content-Length", crashing the ASGI app.  By omitting it,
        # Starlette uses chunked transfer encoding, which allows the
        # stream to end cleanly on error and lets the browser retry
        # with a new Range request.

        async def range_stream():
            try:
                async for chunk in upstream.aiter_bytes(chunk_size=65536):
                    yield chunk
            except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
                log.warning(f"Upstream read error during range stream for {video_id}: {e}")
                # End the stream gracefully — the browser will retry
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(
            range_stream(),
            status_code=upstream.status_code,
            headers=response_headers,
        )

    return StreamingResponse(
        stream_audio(),
        media_type=content_type,
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        },
    )


# ── Library ─────────────────────────────────────────────────────────

@app.get("/library/songs")
async def library_songs(user_id: str = Query(...), limit: int = 100, order: str = "recently_added"):
    """Get user's liked/library songs from YouTube Music."""
    try:
        songs = _run_ytmusic_with_auth_retry(
            user_id,
            operation=f"get_library_songs(limit={limit}, order={order})",
            func=lambda yt: yt.get_library_songs(limit=limit, order=order),
        )
        items = []
        for s in songs:
            artists = s.get("artists", [])
            album = s.get("album", {}) or {}
            items.append({
                "videoId": s.get("videoId"),
                "title": s.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "artists": [a.get("name") for a in artists],
                "album": album.get("name") if album else None,
                "duration": s.get("duration"),
                "duration_seconds": s.get("duration_seconds"),
                "thumbnails": s.get("thumbnails", []),
            })
        return {"songs": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Get library songs failed for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/library/albums")
async def library_albums(user_id: str = Query(...), limit: int = 100, order: str = "recently_added"):
    """Get user's saved albums from YouTube Music."""
    try:
        albums = _run_ytmusic_with_auth_retry(
            user_id,
            operation=f"get_library_albums(limit={limit}, order={order})",
            func=lambda yt: yt.get_library_albums(limit=limit, order=order),
        )
        items = []
        for a in albums:
            artists = a.get("artists", [])
            items.append({
                "browseId": a.get("browseId"),
                "title": a.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "artists": [a_name.get("name") for a_name in artists],
                "year": a.get("year"),
                "thumbnails": a.get("thumbnails", []),
                "type": a.get("type", "Album"),
            })
        return {"albums": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Get library albums failed for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Cleanup ─────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    log.info("YouTube Music Streamer starting up (multi-user mode)")
    log.info(
        f"Rate-pacing config: batch_concurrency={BATCH_CONCURRENCY}, "
        f"batch_delay={BATCH_DELAY_MIN}-{BATCH_DELAY_MAX}s, "
        f"extract_delay={EXTRACT_DELAY_MIN}-{EXTRACT_DELAY_MAX}s, "
        f"search_cache_ttl={SEARCH_CACHE_TTL}s, "
        f"search_mode={SEARCH_MODE}"
    )

    # Ensure data directory exists and is writable
    DATA_PATH.mkdir(parents=True, exist_ok=True)
    test_file = DATA_PATH / ".write_test"
    try:
        test_file.write_text("ok")
        test_file.unlink()
    except PermissionError:
        log.error(
            f"DATA_PATH ({DATA_PATH}) is not writable! "
            "OAuth credentials cannot be saved. "
            "If using Docker, try removing and recreating the ytmusic_data volume: "
            "docker volume rm soundspan_ytmusic_data"
        )

    oauth_files = list(DATA_PATH.glob("oauth_*.json"))
    if oauth_files:
        log.info(f"Found {len(oauth_files)} user OAuth credential file(s)")
    else:
        log.info("No OAuth credentials found — users need to authenticate via settings")


# ── Browse (unauthenticated) ────────────────────────────────────────

@app.get("/charts")
async def get_charts(country: str = "US"):
    """Get YT Music charts (top songs, trending, etc.)."""
    try:
        yt = _get_public_ytmusic("native")
        charts = yt.get_charts(country=country)

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
        log.error(f"Charts fetch failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/moods-and-genres")
async def get_moods_and_genres():
    """Get YT Music mood/genre categories."""
    try:
        yt = _get_public_ytmusic("native")
        categories = yt.get_mood_categories()

        result = []
        for cat_title, cat_items in categories.items():
            entries = []
            for item in cat_items:
                entries.append({
                    "title": item.get("title", ""),
                    "params": item.get("params", ""),
                })
            result.append({"title": cat_title, "items": entries})
        return result
    except Exception as e:
        log.error(f"Moods/genres fetch failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/playlist/{playlist_id}")
async def get_playlist(playlist_id: str, limit: int = 100):
    """Get a public YT Music playlist with track details."""
    try:
        yt = _get_public_ytmusic("native")
        playlist = yt.get_playlist(playlist_id, limit=limit)

        tracks = []
        for t in playlist.get("tracks", []):
            artists = t.get("artists", [])
            album = t.get("album", {}) or {}
            tracks.append({
                "videoId": t.get("videoId"),
                "title": t.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "artists": [a.get("name") for a in artists if a.get("name")],
                "album": album.get("name", ""),
                "duration": _parse_duration(t.get("duration", "")),
                "thumbnailUrl": _best_thumbnail(t.get("thumbnails", [])),
            })

        return {
            "id": playlist_id,
            "title": playlist.get("title", ""),
            "description": playlist.get("description", ""),
            "trackCount": playlist.get("trackCount", len(tracks)),
            "thumbnailUrl": _best_thumbnail(playlist.get("thumbnails", [])),
            "tracks": tracks,
        }
    except Exception as e:
        log.error(f"Playlist fetch failed for {playlist_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _best_thumbnail(thumbnails: list) -> Optional[str]:
    """Pick the best available thumbnail URL."""
    if not thumbnails:
        return None
    # Prefer medium/large resolution
    for t in reversed(thumbnails):
        if isinstance(t, dict) and t.get("url"):
            return t["url"]
    return thumbnails[0].get("url") if isinstance(thumbnails[0], dict) else None


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


@app.on_event("shutdown")
async def shutdown():
    _clean_stream_cache()
    _clean_search_cache()
    _ytmusic_instances.clear()
    log.info("YouTube Music Streamer shutting down")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8586)
