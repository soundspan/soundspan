"""TIDAL stream metadata resolution and proxy delivery routes."""

import time
from collections.abc import AsyncIterator
from typing import Any, cast

import httpx
from fastapi import HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from tidal_auth import _get_user_api, _run_user_api_call
from tidal_cache import (
    _STREAM_CACHE_MAX_ENTRIES,
    STREAM_CACHE_TTL,
    _clear_stream_cache,
    _normalize_stream_quality,
    _remove_expired_stream_cache_entries,
    _stream_cache,
    _stream_cache_lock,
)
from tidal_downloads import (
    _DASH_MANIFEST_MIME_TYPE,
    _prepend_dash_init_segment,
    _resolve_dash_codec,
)
from tidal_runtime import JsonObject, _sanitized_http_error, app, log
from tiddl.core.utils import parse_track_stream

from services.common.sidecar_runtime_utils import build_stream_proxy_client

_STREAM_ERRORS = (httpx.HTTPError, httpx.StreamError, httpx.ReadError)


def _dash_audio_codec(stream: Any) -> str:
    """Resolve the established DASH codec label from a stream manifest."""
    dash_codec = _resolve_dash_codec(stream.manifest)
    dash_codec_lower = (dash_codec or "").lower()
    if dash_codec_lower == "flac":
        return "flac"
    if dash_codec_lower in ("alac", "alac "):
        return "alac"
    if dash_codec_lower.startswith("mp4a"):
        return "aac"
    return dash_codec_lower or "aac"


def _direct_stream_format(file_extension: str) -> tuple[str, str]:
    """Resolve the content type and codec label for one direct stream."""
    if file_extension == ".flac":
        return "audio/flac", "flac"
    return "audio/mp4", "aac"


def _stream_result(
    stream: Any,
    urls: list[str],
    content_type: str,
    audio_codec: str,
    normalized_quality: str,
) -> JsonObject:
    """Build the established cached stream metadata shape."""
    return {
        "url": urls[0] if urls else "",
        "urls": urls,
        "is_dash": stream.manifestMimeType == _DASH_MANIFEST_MIME_TYPE,
        "content_type": content_type,
        "acodec": audio_codec,
        "requested_quality": normalized_quality,
        "quality": stream.audioQuality,
        "bit_depth": getattr(stream, "bitDepth", None),
        "sample_rate": getattr(stream, "sampleRate", None),
        "expires_at": time.time() + STREAM_CACHE_TTL,
    }


def _get_cached_stream(cache_key: tuple[str, int, str], now: float) -> JsonObject | None:
    """Return and refresh the insertion order of one live cache entry."""
    with _stream_cache_lock:
        _remove_expired_stream_cache_entries(now)
        cached = _stream_cache.get(cache_key)
        if cached is not None:
            _stream_cache.pop(cache_key, None)
            _stream_cache[cache_key] = cached
        return cached


def _set_cached_stream(cache_key: tuple[str, int, str], result: JsonObject) -> None:
    """Insert one stream result and enforce the existing cache bound."""
    with _stream_cache_lock:
        _remove_expired_stream_cache_entries(time.time())
        _stream_cache.pop(cache_key, None)
        _stream_cache[cache_key] = result
        if len(_stream_cache) > _STREAM_CACHE_MAX_ENTRIES:
            _stream_cache.pop(next(iter(_stream_cache)), None)


def _get_stream_url_sync(user_id: str, track_id: int, quality: str = "HIGH") -> JsonObject:
    """Extract and cache stream URLs for a TIDAL track."""
    normalized_quality = _normalize_stream_quality(quality)
    cache_key = (user_id, track_id, normalized_quality)
    cached = _get_cached_stream(cache_key, time.time())
    if cached is not None:
        return cached

    api = _get_user_api(user_id)
    stream = api.get_track_stream(track_id=track_id, quality=normalized_quality)
    urls, file_extension = parse_track_stream(stream)
    if stream.manifestMimeType == _DASH_MANIFEST_MIME_TYPE:
        content_type = "audio/mp4"
        audio_codec = _dash_audio_codec(stream)
        urls = _prepend_dash_init_segment(stream, urls, track_id, warn_on_missing=False)
    else:
        content_type, audio_codec = _direct_stream_format(file_extension)

    result = _stream_result(stream, urls, content_type, audio_codec, normalized_quality)
    _set_cached_stream(cache_key, result)
    return result


async def _resolve_stream_info(
    user_id: str,
    track_id: int,
    normalized_quality: str,
    operation: str,
) -> JsonObject:
    """Resolve one stream metadata payload through the auth-refresh boundary."""
    result = await _run_user_api_call(
        user_id,
        lambda _current_api: _get_stream_url_sync(user_id, track_id, normalized_quality),
        operation=operation,
    )
    return cast(JsonObject, result)


async def _refresh_stream_info(
    user_id: str,
    track_id: int,
    normalized_quality: str,
) -> JsonObject:
    """Invalidate and resolve one stream URL after upstream auth rejection."""
    _clear_stream_cache(user_id, track_id=track_id, quality=normalized_quality)
    return await _resolve_stream_info(
        user_id,
        track_id,
        normalized_quality,
        operation=f"stream URL refresh for track {track_id}",
    )


async def _send_stream_request(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    """Open one upstream streaming response."""
    return await client.send(
        client.build_request("GET", url, headers=headers),
        stream=True,
    )


async def _open_dash_attempt(track_id: int, url: str) -> tuple[httpx.AsyncClient, httpx.Response]:
    """Open the first DASH segment and map transport failures."""
    client = build_stream_proxy_client()
    try:
        response = await _send_stream_request(client, url)
        return client, response
    except _STREAM_ERRORS as error:
        await client.aclose()
        log.error("DASH first segment request failed for track %s: %s", track_id, error)
        raise HTTPException(status_code=502, detail="Failed to fetch TIDAL DASH stream") from error


async def _close_stream_start(client: httpx.AsyncClient, response: httpx.Response) -> None:
    """Close a rejected first response and its owning client."""
    await response.aclose()
    await client.aclose()


async def _open_dash_stream_start(
    user_id: str,
    track_id: int,
    normalized_quality: str,
    all_urls: list[str],
    content_type: str,
) -> tuple[httpx.AsyncClient, httpx.Response, list[str], str]:
    """Open the first DASH segment and refresh once after a 401 or 403."""
    dash_urls = list(all_urls)
    resolved_content_type = content_type
    for attempt in range(2):
        if not dash_urls:
            raise HTTPException(status_code=404, detail="No stream URL available")
        client, response = await _open_dash_attempt(track_id, dash_urls[0])
        if attempt == 0 and response.status_code in (401, 403):
            log.warning(
                "Cached TIDAL DASH URL rejected for track %s (status=%s); refreshing once",
                track_id,
                response.status_code,
            )
            await _close_stream_start(client, response)
            refreshed = await _refresh_stream_info(user_id, track_id, normalized_quality)
            dash_urls = list(refreshed.get("urls", []))
            resolved_content_type = refreshed.get("content_type", resolved_content_type)
            continue
        if response.status_code >= 400:
            log.error(
                "DASH first segment returned HTTP %s for track %s",
                response.status_code,
                track_id,
            )
            await _close_stream_start(client, response)
            raise HTTPException(
                status_code=502,
                detail="Failed to fetch TIDAL DASH stream segment",
            )
        return client, response, dash_urls, resolved_content_type
    raise HTTPException(status_code=502, detail="Unable to refresh TIDAL stream URL")


async def _yield_response_bytes(response: httpx.Response) -> AsyncIterator[bytes]:
    """Yield one upstream response body in the established chunk size."""
    async for chunk in response.aiter_bytes(chunk_size=65536):
        yield chunk


async def _yield_later_dash_segments(
    client: httpx.AsyncClient,
    dash_urls: list[str],
    track_id: int,
) -> AsyncIterator[bytes]:
    """Fetch and concatenate DASH media segments after the first response."""
    for index, segment_url in enumerate(dash_urls[1:], start=1):
        segment_response = None
        try:
            segment_response = await _send_stream_request(client, segment_url)
            if segment_response.status_code >= 400:
                log.error(
                    "DASH segment %d/%d returned HTTP %s for track %s",
                    index,
                    len(dash_urls),
                    segment_response.status_code,
                    track_id,
                )
                return
            async for chunk in _yield_response_bytes(segment_response):
                yield chunk
        except _STREAM_ERRORS as error:
            log.warning(
                "DASH segment %d/%d fetch failed for track %s: %s",
                index,
                len(dash_urls),
                track_id,
                error,
            )
            return
        finally:
            if segment_response is not None:
                await segment_response.aclose()


async def _dash_concat_stream(
    client: httpx.AsyncClient,
    first_response: httpx.Response,
    dash_urls: list[str],
    track_id: int,
) -> AsyncIterator[bytes]:
    """Yield the first and remaining DASH segments sequentially."""
    try:
        try:
            async for chunk in _yield_response_bytes(first_response):
                yield chunk
        except _STREAM_ERRORS as error:
            log.warning("DASH first segment stream failed for track %s: %s", track_id, error)
            return
        await first_response.aclose()
        async for chunk in _yield_later_dash_segments(client, dash_urls, track_id):
            yield chunk
    finally:
        await first_response.aclose()
        await client.aclose()


async def _open_direct_attempt(
    track_id: int,
    stream_url: str,
    headers: dict[str, str],
) -> tuple[httpx.AsyncClient, httpx.Response]:
    """Open one direct upstream stream and map transport failures."""
    client = build_stream_proxy_client()
    try:
        upstream = await _send_stream_request(client, stream_url, headers)
        return client, upstream
    except _STREAM_ERRORS as error:
        await client.aclose()
        log.error(f"Upstream stream request failed for track {track_id}: {error}")
        raise HTTPException(status_code=502, detail="Failed to fetch TIDAL stream") from error


async def _open_upstream_stream(
    user_id: str,
    track_id: int,
    normalized_quality: str,
    stream_info: JsonObject,
    headers: dict[str, str],
) -> tuple[httpx.AsyncClient, httpx.Response]:
    """Open a direct stream and refresh once after a 401 or 403."""
    for attempt in range(2):
        if attempt == 1:
            refreshed = await _refresh_stream_info(user_id, track_id, normalized_quality)
            stream_url = refreshed.get("url", "")
        else:
            stream_url = stream_info.get("url", "")
        if not stream_url:
            raise HTTPException(status_code=404, detail="No stream URL available")
        client, upstream = await _open_direct_attempt(track_id, stream_url, headers)
        if attempt == 0 and upstream.status_code in (401, 403):
            log.warning(
                "Cached TIDAL stream URL rejected for track %s (status=%s); refreshing once",
                track_id,
                upstream.status_code,
            )
            await _close_stream_start(client, upstream)
            continue
        return client, upstream
    raise HTTPException(status_code=502, detail="Unable to refresh TIDAL stream URL")


def _direct_response_headers(upstream: httpx.Response, content_type: str) -> dict[str, str]:
    """Build the established direct-stream response headers."""
    response_headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache"}
    upstream_content_type = upstream.headers.get("content-type") or content_type
    if upstream_content_type:
        response_headers["Content-Type"] = upstream_content_type
    if "content-range" in upstream.headers:
        response_headers["Content-Range"] = upstream.headers["content-range"]
    return response_headers


async def _proxy_stream(
    client: httpx.AsyncClient,
    upstream: httpx.Response,
    track_id: int,
) -> AsyncIterator[bytes]:
    """Yield a direct upstream response and deterministically close resources."""
    try:
        async for chunk in _yield_response_bytes(upstream):
            yield chunk
    except _STREAM_ERRORS as error:
        log.warning(f"Upstream read error during stream for track {track_id}: {error}")
    finally:
        await upstream.aclose()
        await client.aclose()


@app.get("/user/stream-info/{track_id}")
async def user_stream_info(
    track_id: int,
    user_id: str = Query(...),
    quality: str = "HIGH",
) -> JsonObject:
    """Get stream metadata for a TIDAL track."""
    try:
        info = await _resolve_stream_info(
            user_id,
            track_id,
            quality,
            operation=f"stream info for track {track_id}",
        )
        return {
            "trackId": track_id,
            "quality": info.get("quality", ""),
            "acodec": info.get("acodec", "aac"),
            "content_type": info.get("content_type", "audio/mp4"),
            "bit_depth": info.get("bit_depth"),
            "sample_rate": info.get("sample_rate"),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise _sanitized_http_error(
            f"stream info for track {track_id}",
            error,
            500,
            "Failed to resolve stream info",
        ) from error


@app.get("/user/stream/{track_id}")
async def user_stream_proxy(
    track_id: int,
    request: Request,
    user_id: str = Query(...),
    quality: str = "HIGH",
) -> StreamingResponse:
    """Proxy an IP-locked direct or DASH TIDAL audio stream."""
    normalized_quality = _normalize_stream_quality(quality)
    stream_info = await _resolve_stream_info(
        user_id,
        track_id,
        normalized_quality,
        operation=f"stream URL fetch for track {track_id}",
    )
    all_urls: list[str] = stream_info.get("urls", [])
    if not all_urls:
        raise HTTPException(status_code=404, detail="No stream URL available")
    content_type = stream_info.get("content_type", "audio/mp4")
    is_dash = stream_info.get("is_dash", False)
    headers = {}
    range_header = request.headers.get("range") if request else None
    if range_header and not is_dash:
        headers["Range"] = range_header

    if is_dash:
        log.info(
            "Proxying DASH segmented stream for track %s (%d segments)",
            track_id,
            len(all_urls),
        )
        client, first_response, dash_urls, dash_content_type = await _open_dash_stream_start(
            user_id,
            track_id,
            normalized_quality,
            all_urls,
            content_type,
        )
        return StreamingResponse(
            _dash_concat_stream(client, first_response, dash_urls, track_id),
            media_type=dash_content_type,
            headers={"Cache-Control": "no-cache"},
        )

    client, upstream = await _open_upstream_stream(
        user_id,
        track_id,
        normalized_quality,
        stream_info,
        headers,
    )
    return StreamingResponse(
        _proxy_stream(client, upstream, track_id),
        status_code=upstream.status_code,
        headers=_direct_response_headers(upstream, content_type),
    )
