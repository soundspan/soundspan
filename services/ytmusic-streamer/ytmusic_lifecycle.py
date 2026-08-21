"""Health and process lifecycle routes for the assembled sidecar."""

from ytmusic_browse import YTMUSIC_HOME_FILTERED_SHELVES
from ytmusic_client import (
    SEARCH_MODE,
    YTMUSIC_LANGUAGE,
    _ytmusic_auto_tv_fallback_users,
    _ytmusic_instances,
    _ytmusic_instances_lock,
)
from ytmusic_library import shutdown_library_playlist_provider
from ytmusic_runtime import DATA_PATH, JsonObject, app, log
from ytmusic_search import (
    BATCH_CONCURRENCY,
    BATCH_DELAY_MAX,
    BATCH_DELAY_MIN,
    SEARCH_CACHE_TTL,
    _clean_search_cache,
)
from ytmusic_stream import EXTRACT_DELAY_MAX, EXTRACT_DELAY_MIN, _clean_stream_cache


@app.get("/health")
async def health() -> JsonObject:
    # Count how many users have OAuth files
    oauth_files = list(DATA_PATH.glob("oauth_*.json"))
    return {
        "status": "ok",
        "service": "ytmusic-streamer",
        "authenticated_users": len(oauth_files),
        "search_mode": SEARCH_MODE,
        "auto_tv_fallback_users": len(_ytmusic_auto_tv_fallback_users),
    }


@app.on_event("startup")
async def startup() -> None:
    log.info("YouTube Music Streamer starting up (multi-user mode)")
    log.info(
        f"Rate-pacing config: batch_concurrency={BATCH_CONCURRENCY}, "
        f"batch_delay={BATCH_DELAY_MIN}-{BATCH_DELAY_MAX}s, "
        f"extract_delay={EXTRACT_DELAY_MIN}-{EXTRACT_DELAY_MAX}s, "
        f"search_cache_ttl={SEARCH_CACHE_TTL}s, "
        f"search_mode={SEARCH_MODE}"
    )
    log.info(
        f"Browse config: language={YTMUSIC_LANGUAGE}, "
        f"home_filtered_shelves={YTMUSIC_HOME_FILTERED_SHELVES or '(none)'}"
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


@app.on_event("shutdown")
async def shutdown() -> None:
    await shutdown_library_playlist_provider()
    _clean_stream_cache()
    _clean_search_cache()
    with _ytmusic_instances_lock:
        _ytmusic_instances.clear()
    log.info("YouTube Music Streamer shutting down")
