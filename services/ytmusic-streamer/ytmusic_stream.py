"""Stream extraction, proxying, regular-YouTube metadata, and caches."""

import asyncio
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar, cast

from common.sidecar_runtime_utils import (
    ThreadSafeRatePacer,
    build_full_proxy_response,
    build_range_proxy_response,
    env_float,
    env_int,
)
from fastapi import HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from yt_download import (
    PROXY_AUDIO_FORMAT_SELECTORS,
    YT_PLAYER_CLIENTS,
    build_playlist_entries,
    classify_youtube_url,
    derive_proxy_audio_container,
)
from yt_download import (
    extract_video_id as _extract_video_id,
)
from ytmusic_client import _get_ytmusic
from ytmusic_runtime import (
    _USER_AGENT,
    JsonObject,
    _bound_cache,
    _sanitized_http_error,
    app,
    log,
)

T = TypeVar("T")

# Default cap for regular-YouTube playlist and channel enumeration.
YT_PLAYLIST_MAX_ENTRIES = max(1, env_int("YT_PLAYLIST_MAX_ENTRIES", "200"))

# Delay range and bounded executor for yt-dlp extraction.
EXTRACT_DELAY_MIN = env_float("YTMUSIC_EXTRACT_DELAY_MIN", "0.5")
EXTRACT_DELAY_MAX = env_float("YTMUSIC_EXTRACT_DELAY_MAX", "2.0")
_extract_pacer = ThreadSafeRatePacer(EXTRACT_DELAY_MIN, EXTRACT_DELAY_MAX)
EXTRACT_TIMEOUT = env_float("YTMUSIC_EXTRACT_TIMEOUT", "60")
YTDLP_EXTRACT_CONCURRENCY = max(1, min(16, env_int("YTMUSIC_YTDLP_EXTRACT_CONCURRENCY", "4")))
_yt_dlp_extract_executor = ThreadPoolExecutor(
    max_workers=YTDLP_EXTRACT_CONCURRENCY,
    thread_name_prefix="yt-dlp-extract",
)
BROWSE_TIMEOUT = env_float("YTMUSIC_BROWSE_TIMEOUT", "30")
YTDLP_SOCKET_TIMEOUT = env_float("YTMUSIC_YTDLP_SOCKET_TIMEOUT", "20")

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ALLOWED_STREAM_QUALITIES = {"LOW", "MEDIUM", "HIGH", "LOSSLESS"}

# Stream URL cache (in-memory, URLs expire after approximately six hours).
_stream_cache: dict[str, JsonObject] = {}
_stream_cache_lock = threading.Lock()
STREAM_CACHE_TTL = 5 * 60 * 60
STREAM_CACHE_MAX = env_int("YTMUSIC_STREAM_CACHE_MAX", "1024")


def _validate_video_id(video_id: str) -> str:
    """Reject video ids that are not exactly 11 URL-safe characters."""
    if not _VIDEO_ID_RE.fullmatch(video_id or ""):
        raise HTTPException(status_code=400, detail="Invalid video_id")
    return video_id


def _validate_stream_quality(quality: str) -> str:
    """Normalize and validate a requested stream quality."""
    normalized = (quality or "").strip().upper()
    if normalized not in _ALLOWED_STREAM_QUALITIES:
        raise HTTPException(status_code=400, detail="Invalid quality")
    return normalized


def _stream_extraction_http_error(
    video_id: str, error_label: str, error: Exception
) -> HTTPException:
    """Convert an extraction failure to the existing sanitized HTTP error."""
    error_str = str(error)
    age_restricted = "Sign in to confirm your age" in error_str or (
        "age" in error_str.lower() and "confirm" in error_str.lower()
    )
    if age_restricted:
        log.error(
            "%s failed: %s",
            error_label,
            error,
            exc_info=True,  # noqa: LOG014 -- called while handling the extraction exception
        )
        return HTTPException(
            status_code=451,
            detail={
                "error": "age_restricted",
                "message": "This content requires age verification and cannot be streamed.",
                "video_id": video_id,
            },
        )
    return _sanitized_http_error(error_label, error, 502, "Failed to extract stream")


def _best_audio_stream_url(info: JsonObject) -> str | None:
    """Return the direct URL or the highest-bitrate audio-only format URL."""
    stream_url = info.get("url")
    if stream_url:
        return cast(str, stream_url)
    audio_formats = [
        item
        for item in info.get("formats", [])
        if item.get("acodec") != "none" and item.get("vcodec") in ("none", None)
    ]
    audio_formats.sort(key=lambda item: item.get("abr", 0) or 0, reverse=True)
    return audio_formats[0].get("url") if audio_formats else None


def _extract_stream_info(
    cache_key: str,
    url: str,
    ydl_opts: JsonObject,
    video_id: str,
    error_label: str,
) -> JsonObject:
    """Extract a yt-dlp audio URL through the shared paced cache workflow.

    Performs cache lookup, paced extraction, result construction, cache store,
    and sanitized error mapping for both YouTube stream paths.
    """
    import yt_dlp

    with _stream_cache_lock:
        cached = _stream_cache.get(cache_key)
    if cached and cached.get("expires_at", 0) > time.time():
        log.debug(f"Stream URL cache hit for {cache_key}")
        return cached
    _extract_pacer.wait()
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                raise ValueError("No info extracted")
            stream_url = _best_audio_stream_url(info)
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
            with _stream_cache_lock:
                _stream_cache[cache_key] = result
                expired_count = _clean_stream_cache_locked()
                _bound_cache(_stream_cache, STREAM_CACHE_MAX)
            if expired_count:
                log.debug(f"Cleaned {expired_count} expired stream cache entries")
            log.debug(
                "Extracted stream URL for %s: %s @ %skbps",
                cache_key,
                result["acodec"],
                result["abr"],
            )
            return result
    except Exception as error:
        raise _stream_extraction_http_error(video_id, error_label, error) from error


def _get_yt_stream_url_sync(video_id: str, quality: str = "HIGH") -> JsonObject:
    """Extract a cached audio stream URL for a regular YouTube video."""
    fmt = PROXY_AUDIO_FORMAT_SELECTORS.get(quality, PROXY_AUDIO_FORMAT_SELECTORS["HIGH"])
    ydl_opts = {
        "format": fmt,
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {"youtube": {"player_client": YT_PLAYER_CLIENTS}},
    }
    return _extract_stream_info(
        f"yt:{video_id}",
        f"https://www.youtube.com/watch?v={video_id}",
        ydl_opts,
        video_id,
        f"yt-dlp extraction for YT video {video_id}",
    )


def _get_stream_url_sync(user_id: str, video_id: str, quality: str = "HIGH") -> JsonObject:
    """Extract a cached audio stream URL for a YouTube Music video."""
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
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://music.youtube.com/",
        },
        "extractor_args": {"youtube": {"player_client": ["android_music"]}},
    }
    return _extract_stream_info(
        f"{user_id}:{video_id}",
        f"https://music.youtube.com/watch?v={video_id}",
        ydl_opts,
        video_id,
        f"yt-dlp extraction for {video_id}",
    )


async def _extract_yt_dlp_bounded(
    func: Callable[..., JsonObject], *args: Any, timeout_detail: str
) -> JsonObject:
    """Run sync yt-dlp work in its bounded pool with an overall deadline.

    Timed-out worker threads remain confined to the dedicated executor, and
    yt-dlp's socket_timeout bounds their network operations.
    """
    try:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(_yt_dlp_extract_executor, func, *args)
        return await asyncio.wait_for(future, timeout=EXTRACT_TIMEOUT)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail=timeout_detail) from error


async def _extract_stream_info_bounded(func: Callable[..., JsonObject], *args: Any) -> JsonObject:
    """Run a sync stream extraction through the shared yt-dlp bounds."""
    return await _extract_yt_dlp_bounded(
        func,
        *args,
        timeout_detail="Stream extraction timed out",
    )


async def _browse_public_bounded(func: Callable[..., T], *args: Any) -> T:
    """Run a sync public ytmusicapi browse call off the event loop with an overall deadline.

    asyncio.wait_for cancels the awaiting request after BROWSE_TIMEOUT seconds
    and maps it to HTTP 504. The orphaned worker thread is not force-killed,
    but the event loop and the client are unblocked.
    """
    try:
        return await asyncio.wait_for(asyncio.to_thread(func, *args), timeout=BROWSE_TIMEOUT)
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail="YouTube Music request timed out") from error


def _clean_stream_cache_locked() -> int:
    """Remove expired stream entries while the owning lock is held."""
    now = time.time()
    expired = [k for k, v in _stream_cache.items() if v.get("expires_at", 0) <= now]
    for k in expired:
        del _stream_cache[k]
    return len(expired)


def _clean_stream_cache() -> None:
    """Remove expired entries from stream cache."""
    with _stream_cache_lock:
        expired_count = _clean_stream_cache_locked()
    if expired_count:
        log.debug(f"Cleaned {expired_count} expired stream cache entries")


@app.get("/stream/{video_id}")
async def get_stream_info(
    video_id: str, user_id: str = Query(...), quality: str = "HIGH"
) -> JsonObject:
    """Get stream URL info for a video (metadata only, no proxy).

    When user_id is "__public__", skips OAuth verification.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    # Skip OAuth check for public/unauthenticated streaming
    if user_id != "__public__":
        _get_ytmusic(user_id)

    result = await _extract_stream_info_bounded(_get_stream_url_sync, user_id, video_id, quality)
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
    request: Request,
    user_id: str = Query(...),
    quality: str = "HIGH",
) -> StreamingResponse:
    """
    Proxy the audio stream from YouTube. The backend pipes this to the
    frontend player. Stream URLs are IP-locked to the server, so we
    must proxy.

    When user_id is "__public__", skips OAuth verification (yt-dlp
    extraction is unauthenticated). This enables free-tier streaming
    for users without YT Music OAuth connected.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    # Skip OAuth check for public/unauthenticated streaming
    if user_id != "__public__":
        _get_ytmusic(user_id)

    stream_info = await _extract_stream_info_bounded(
        _get_stream_url_sync, user_id, video_id, quality
    )
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

    if headers.get("Range"):
        return await build_range_proxy_response(
            stream_url, headers, content_type, _USER_AGENT, log, video_id
        )
    return build_full_proxy_response(stream_url, headers, content_type, _USER_AGENT, log, video_id)


@app.get("/yt/info")
async def yt_video_info(url: str = Query(...)) -> JsonObject:
    """
    Return metadata for a regular YouTube video.
    No authentication required — uses yt-dlp anonymous extraction.
    """
    import yt_dlp

    try:
        video_id = _extract_video_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ydl_opts = {
        # Select the exact format the /yt/ stream proxy serves at its
        # default quality so the audioFormat hint below matches the bytes
        # the player will receive.
        "format": PROXY_AUDIO_FORMAT_SELECTORS["HIGH"],
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "skip_download": True,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {
            "youtube": {
                "player_client": YT_PLAYER_CLIENTS,
            },
        },
    }

    try:

        def _extract() -> Any:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(
                    f"https://www.youtube.com/watch?v={video_id}",
                    download=False,
                )

        info = await _extract_yt_dlp_bounded(
            _extract,
            timeout_detail="YouTube extraction timed out",
        )
        if not info:
            raise HTTPException(status_code=404, detail="Video not found")

        thumbnails = info.get("thumbnails", [])
        best_thumb = thumbnails[-1]["url"] if thumbnails else None

        return {
            "videoId": info.get("id", video_id),
            "title": info.get("title", ""),
            "uploader": info.get("uploader", ""),
            "duration": info.get("duration", 0),
            "thumbnail": best_thumb,
            "uploadDate": info.get("upload_date", ""),
            # Container the /yt/ stream proxy serves — derived from the
            # same format selection (and acodec mapping) the proxy uses,
            # so the player's decode hint (webm vs mp4) always matches.
            "audioFormat": derive_proxy_audio_container(info),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"yt-dlp info extraction for {url}",
            e,
            502,
            "Failed to fetch video info",
        ) from e


@app.get("/yt/playlist-info")
async def yt_playlist_info(url: str = Query(...)) -> JsonObject:
    """
    Enumerate a YouTube playlist or channel into a bounded list of video
    entries for the bulk-download UI. No authentication required — uses
    yt-dlp anonymous flat extraction (fast: it lists entries without
    resolving each video's formats).

    Rejects single-video URLs (use /yt/info) and auto-generated radio/mix
    lists (list=RD*, which YouTube does not expose as a static set) with 422
    so the UI can explain why.
    """
    import yt_dlp

    classification = classify_youtube_url(url)
    kind = classification.get("kind")

    if kind == "mix":
        raise HTTPException(
            status_code=422,
            detail=(
                "This is an auto-generated YouTube mix/radio, which can't be "
                "downloaded as a set. Paste the individual video instead."
            ),
        )
    if kind not in ("playlist", "channel"):
        raise HTTPException(
            status_code=422,
            detail="URL is not a YouTube playlist or channel.",
        )

    enumerate_url = classification["enumerate_url"]
    # Fetch one past the cap so truncation is detectable even when yt-dlp
    # does not report a playlist_count (common for channel tabs): the extra
    # entry tips build_playlist_entries into truncated=True.
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "playlistend": YT_PLAYLIST_MAX_ENTRIES + 1,
        "socket_timeout": YTDLP_SOCKET_TIMEOUT,
        "http_headers": {
            "User-Agent": _USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
        },
        "extractor_args": {
            "youtube": {
                "player_client": YT_PLAYER_CLIENTS,
            },
        },
    }

    try:

        def _extract() -> Any:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(enumerate_url, download=False)

        info = await _extract_yt_dlp_bounded(
            _extract,
            timeout_detail="YouTube extraction timed out",
        )
        if not info:
            raise HTTPException(status_code=404, detail="Playlist or channel not found")

        summary = build_playlist_entries(info, YT_PLAYLIST_MAX_ENTRIES)
        if summary["count"] == 0:
            raise HTTPException(
                status_code=422,
                detail="No downloadable videos found in this playlist or channel.",
            )

        return {
            "kind": kind,
            "playlistId": classification.get("playlist_id"),
            "channel": classification.get("channel"),
            "sourceUrl": enumerate_url,
            **summary,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"yt-dlp playlist enumeration for {url}",
            e,
            502,
            "Failed to enumerate playlist/channel",
        ) from e


@app.get("/yt/proxy/{video_id}")
async def yt_proxy_stream(
    video_id: str,
    request: Request,
    quality: str = "HIGH",
) -> StreamingResponse:
    """
    Proxy audio stream from a regular YouTube video.
    No OAuth required — uses anonymous yt-dlp extraction.
    Same Range-request handling as the YouTube Music proxy.
    """
    video_id = _validate_video_id(video_id)
    quality = _validate_stream_quality(quality)
    stream_info = await _extract_stream_info_bounded(_get_yt_stream_url_sync, video_id, quality)
    stream_url = stream_info["url"]

    acodec = stream_info.get("acodec", "")
    if "opus" in acodec:
        content_type = "audio/webm"
    elif "mp4a" in acodec or "aac" in acodec:
        content_type = "audio/mp4"
    else:
        content_type = "audio/mp4"

    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
    }
    if request and "range" in request.headers:
        headers["Range"] = request.headers["range"]

    if headers.get("Range"):
        return await build_range_proxy_response(
            stream_url, headers, content_type, _USER_AGENT, log, video_id
        )
    return build_full_proxy_response(stream_url, headers, content_type, _USER_AGENT, log, video_id)
