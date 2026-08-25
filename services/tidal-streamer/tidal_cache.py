"""Bounded stream URL cache and application-owned cleanup lifecycle."""

import asyncio
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from tidal_runtime import JsonObject

_stream_cache: dict[tuple[str, int, str], JsonObject] = {}
_stream_cache_lock = threading.Lock()
STREAM_CACHE_TTL = 600
_STREAM_CACHE_MAX_ENTRIES = 1000
_STREAM_CACHE_CLEANUP_INTERVAL_SECONDS = 60
STREAM_QUALITY_OPTIONS = {"LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"}


def _normalize_stream_quality(quality: str | None) -> str:
    """Normalize stream quality values to supported tiddl literals."""
    normalized = (quality or "HIGH").strip().upper()
    if normalized == "MAX":
        normalized = "HI_RES_LOSSLESS"
    return normalized if normalized in STREAM_QUALITY_OPTIONS else "HIGH"


def _clear_stream_cache(
    user_id: str,
    track_id: int | None = None,
    quality: str | None = None,
) -> None:
    """Clear cached stream URLs for a user, optionally scoped by track and quality."""
    normalized_quality = _normalize_stream_quality(quality) if quality is not None else None
    with _stream_cache_lock:
        keys_to_remove = []
        for cache_user_id, cache_track_id, cache_quality in _stream_cache:
            if cache_user_id != user_id:
                continue
            if track_id is not None and cache_track_id != track_id:
                continue
            if normalized_quality is not None and cache_quality != normalized_quality:
                continue
            keys_to_remove.append((cache_user_id, cache_track_id, cache_quality))

        for key in keys_to_remove:
            _stream_cache.pop(key, None)


def _remove_expired_stream_cache_entries(now: float) -> None:
    """Remove expired entries while the caller holds the stream-cache lock."""
    expired = [key for key, value in _stream_cache.items() if now >= value.get("expires_at", 0)]
    for key in expired:
        _stream_cache.pop(key, None)


def _clean_stream_cache() -> None:
    """Remove expired entries from the stream cache."""
    with _stream_cache_lock:
        _remove_expired_stream_cache_entries(time.time())


async def _run_stream_cache_cleanup() -> None:
    """Remove expired stream manifests at a fixed interval until shutdown."""
    while True:
        await asyncio.sleep(_STREAM_CACHE_CLEANUP_INTERVAL_SECONDS)
        _clean_stream_cache()


@asynccontextmanager
async def _app_lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Own and stop the stream-cache maintenance task with the application."""
    cleanup_task = asyncio.create_task(
        _run_stream_cache_cleanup(),
        name="tidal-stream-cache-cleanup",
    )
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task
