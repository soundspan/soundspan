"""
TIDAL Downloader & Streamer — FastAPI sidecar for soundspan.

Uses the `tiddl` Python library to authenticate, search, download,
and stream tracks/albums from TIDAL. The Node.js backend communicates
with this service over HTTP on port 8585.

Supports **per-user** streaming: each soundspan user connects their own
TIDAL account via device-code OAuth. User credentials are scoped by
user_id query parameters. Admin credentials (for downloading) remain
in SystemSettings and are passed via request headers.
"""

import asyncio
import json
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Optional, Literal

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ── tiddl core imports ──────────────────────────────────────────────
from tiddl.core.auth import AuthAPI, AuthClientError
from tiddl.core.auth.client import AuthClient
from tiddl.core.api import TidalAPI, TidalClient, ApiError
from tiddl.core.utils import get_track_stream_data, parse_track_stream
from tiddl.core.utils.format import format_template
from tiddl.core.metadata import add_track_metadata, Cover

# ── Logging ─────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG if os.getenv("DEBUG") else logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
log = logging.getLogger("tidal-downloader")

# ── FastAPI app ─────────────────────────────────────────────────────
app = FastAPI(title="soundspan TIDAL Downloader & Streamer", version="2.0.0")

# ── Paths ───────────────────────────────────────────────────────────
TIDDL_PATH = Path(os.getenv("TIDDL_PATH", "/data/.tiddl"))
MUSIC_PATH = Path(os.getenv("MUSIC_PATH", "/music"))

# ── In-memory API instance (initialised on first use) ──────────────
_tidal_api: Optional[TidalAPI] = None
_api_lock = asyncio.Lock()

# ── Per-user API instances for streaming ───────────────────────────
_user_apis: dict[str, TidalAPI] = {}
_user_api_locks: dict[str, asyncio.Lock] = {}
_user_auth_state: dict[str, dict[str, str]] = {}

# ── Stream URL cache (per-user, keyed by (user_id, track_id, quality)) ─────
_stream_cache: dict[tuple[str, int, str], dict] = {}
STREAM_CACHE_TTL = 600  # 10 minutes
STREAM_QUALITY_OPTIONS = {"LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"}


# ════════════════════════════════════════════════════════════════════
# Models
# ════════════════════════════════════════════════════════════════════

class AuthTokenRequest(BaseModel):
    """Payload for device-code token exchange polling."""
    device_code: str


class AuthTokensPayload(BaseModel):
    """Tokens + metadata provided by the Node.js backend."""
    access_token: str
    refresh_token: str
    user_id: str
    country_code: str


class SessionCheckPayload(BaseModel):
    """Payload for session verification (refresh_token not needed)."""
    access_token: str
    user_id: str
    country_code: str


class RefreshRequest(BaseModel):
    """Payload for refreshing a TIDAL access token."""
    refresh_token: str


class SearchRequest(BaseModel):
    """Payload for TIDAL catalog search queries."""
    query: str


class DownloadTrackRequest(BaseModel):
    """Payload for downloading a single TIDAL track."""
    track_id: int
    quality: Literal["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"] = "HIGH"
    output_template: str = "{album.artist}/{album.title}/{item.number:02d}. {item.title}"


class DownloadAlbumRequest(BaseModel):
    """Payload for downloading all tracks from a TIDAL album."""
    album_id: int
    quality: Literal["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"] = "HIGH"
    output_template: str = "{album.artist}/{album.title}/{item.number:02d}. {item.title}"


class UserAuthRestoreRequest(BaseModel):
    """Restore per-user OAuth credentials (sent by Node.js backend)."""
    access_token: str
    refresh_token: str
    user_id: str
    country_code: str


class BatchSearchQuery(BaseModel):
    """Single query descriptor for batch TIDAL search requests."""
    query: str
    filter: Optional[str] = None
    limit: int = 5


# ════════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════════

def _sanitize_path_component(name: str) -> str:
    """Remove or replace chars that are invalid on most filesystems."""
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    return name.strip(". ")


def _build_api(access_token: str, user_id: str, country_code: str) -> TidalAPI:
    """Create a fresh TidalAPI client from stored credentials."""
    cache_path = TIDDL_PATH / "api_cache"
    client = TidalClient(
        token=access_token,
        cache_name=str(cache_path),
        omit_cache=True,  # We always want fresh data in a service context
    )
    return TidalAPI(client, user_id=user_id, country_code=country_code)


def _download_track_sync(
    api: TidalAPI,
    track_id: int,
    quality: str,
    output_template: str,
    dest_base: Path,
) -> dict:
    """
    Download a single track synchronously.

    Returns a dict with file info on success.
    """
    # 1. Fetch track metadata
    track = api.get_track(track_id)
    album = api.get_album(track.album.id)

    # 2. Build output path from template
    relative_path = format_template(
        template=output_template,
        item=track,
        album=album,
        with_asterisk_ext=False,
    )
    # Sanitize each path component
    parts = relative_path.split("/")
    parts = [_sanitize_path_component(p) for p in parts if p]
    relative_path = "/".join(parts)

    # 3. Get stream data
    stream = api.get_track_stream(track_id=track_id, quality=quality)
    urls, file_extension = parse_track_stream(stream)

    # Download raw bytes
    from tiddl.core.utils.download import download as download_bytes
    stream_data = download_bytes(urls)

    # 4. Write to disk
    file_path = dest_base / f"{relative_path}{file_extension}"
    file_path.parent.mkdir(parents=True, exist_ok=True)

    # Write to temp file first, then move (atomic-ish)
    tmp_path = file_path.with_suffix(file_path.suffix + ".tmp")
    tmp_path.write_bytes(stream_data)

    # 5. If FLAC, ffmpeg extraction may be needed
    if file_extension == ".flac":
        try:
            from tiddl.core.utils.ffmpeg import extract_flac
            extract_flac(tmp_path, file_path)
            tmp_path.unlink(missing_ok=True)
        except Exception:
            # Fallback — just rename
            shutil.move(str(tmp_path), str(file_path))
    else:
        shutil.move(str(tmp_path), str(file_path))

    # 6. Embed metadata
    try:
        # Fetch cover
        cover = None
        if album.cover:
            cover = Cover(album.cover)

        add_track_metadata(
            path=file_path,
            track=track,
            album_artist=track.artists[0].name if track.artists else "",
            date=str(album.releaseDate.date()) if album.releaseDate else "",
            cover_data=cover.fetch_data() if cover else None,
        )
    except Exception as e:
        log.warning(f"Failed to embed metadata for track {track_id}: {e}")

    return {
        "track_id": track_id,
        "title": track.title,
        "artist": track.artists[0].name if track.artists else "Unknown",
        "album": album.title,
        "quality": stream.audioQuality,
        "file_path": str(file_path),
        "relative_path": f"{relative_path}{file_extension}",
        "file_size": file_path.stat().st_size,
    }


# ════════════════════════════════════════════════════════════════════
# Per-user streaming helpers
# ════════════════════════════════════════════════════════════════════

def _get_user_api(user_id: str) -> TidalAPI:
    """
    Get or raise for a per-user TidalAPI instance.
    The backend must call /user/auth/restore first.
    """
    api = _user_apis.get(user_id)
    if not api:
        raise HTTPException(
            status_code=401,
            detail=f"No TIDAL session for user {user_id}. Restore credentials first.",
        )
    return api


def _normalize_stream_quality(quality: Optional[str]) -> str:
    """Normalize stream quality values to supported tiddl literals."""
    normalized = (quality or "HIGH").strip().upper()
    if normalized == "MAX":
        normalized = "HI_RES_LOSSLESS"
    return normalized if normalized in STREAM_QUALITY_OPTIONS else "HIGH"


def _clear_stream_cache(
    user_id: str,
    track_id: Optional[int] = None,
    quality: Optional[str] = None,
):
    """Clear cached stream URLs for a user, optionally scoped by track/quality."""
    normalized_quality = (
        _normalize_stream_quality(quality) if quality is not None else None
    )
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


def _invalidate_user_api(user_id: str):
    """Remove a user's API instance (e.g. on logout)."""
    _user_apis.pop(user_id, None)
    _user_auth_state.pop(user_id, None)
    _clear_stream_cache(user_id)


def _get_user_lock(user_id: str) -> asyncio.Lock:
    lock = _user_api_locks.get(user_id)
    if lock is None:
        lock = asyncio.Lock()
        _user_api_locks[user_id] = lock
    return lock


def _is_token_expired_error(err: Exception) -> bool:
    """Identify TIDAL token-expiry errors (401/11003)."""
    if not isinstance(err, ApiError):
        return False

    status = getattr(err, "status", None)
    sub_status = getattr(err, "sub_status", None)
    if sub_status is None:
        sub_status = getattr(err, "subStatus", None)

    message = str(err).lower()
    return status == 401 and (
        str(sub_status) == "11003"
        or "token has expired" in message
        or "expired on time" in message
    )


async def _refresh_user_api(user_id: str) -> TidalAPI:
    """
    Refresh a user's access token using the stored refresh token and rebuild API.
    Uses a per-user lock so concurrent requests don't stampede refresh calls.
    """
    lock = _get_user_lock(user_id)

    async with lock:
        creds = _user_auth_state.get(user_id)
        if not creds or not creds.get("refresh_token"):
            raise HTTPException(
                status_code=401,
                detail=f"No refresh token available for user {user_id}",
            )

        current_api = _user_apis.get(user_id)
        if current_api is not None:
            try:
                await asyncio.to_thread(current_api.get_session)
                return current_api
            except ApiError as verify_err:
                if not _is_token_expired_error(verify_err):
                    raise

        try:
            auth_api = AuthAPI()
            auth_response = await asyncio.to_thread(
                auth_api.refresh_token, creds["refresh_token"]
            )

            new_access_token = auth_response.access_token
            new_user_id = str(auth_response.user.userId)
            new_country = auth_response.user.countryCode

            refreshed_api = _build_api(new_access_token, new_user_id, new_country)
            await asyncio.to_thread(refreshed_api.get_session)

            _user_apis[user_id] = refreshed_api
            creds["access_token"] = new_access_token
            creds["tidal_user_id"] = new_user_id
            creds["country_code"] = new_country

            # Stream URLs are tied to prior auth state; clear on refresh.
            _clear_stream_cache(user_id)

            log.info(f"Refreshed TIDAL session for user {user_id}")
            return refreshed_api
        except Exception as refresh_err:
            log.error(f"TIDAL token refresh failed for user {user_id}: {refresh_err}")
            _invalidate_user_api(user_id)
            raise HTTPException(
                status_code=401,
                detail="TIDAL session expired and token refresh failed",
            ) from refresh_err


async def _run_user_api_call(
    user_id: str,
    func: Callable[[TidalAPI], Any],
    operation: str,
) -> Any:
    """
    Run a user-scoped TIDAL API call with automatic refresh/retry once
    when access token expiry is detected.
    """
    api = _get_user_api(user_id)
    try:
        return await asyncio.to_thread(func, api)
    except ApiError as api_err:
        if not _is_token_expired_error(api_err):
            raise

        log.warning(
            f"TIDAL token expired during {operation} for user {user_id}; refreshing and retrying"
        )
        refreshed_api = await _refresh_user_api(user_id)
        return await asyncio.to_thread(func, refreshed_api)


def _get_stream_url_sync(user_id: str, track_id: int, quality: str = "HIGH") -> dict:
    """
    Extract stream URL for a TIDAL track (synchronous — run in thread).
    Uses tiddl's stream extraction. Results are cached for STREAM_CACHE_TTL.
    """
    normalized_quality = _normalize_stream_quality(quality)
    cache_key = (user_id, track_id, normalized_quality)
    cached = _stream_cache.get(cache_key)
    if cached and time.time() < cached.get("expires_at", 0):
        return cached

    api = _get_user_api(user_id)
    stream = api.get_track_stream(track_id=track_id, quality=normalized_quality)
    urls, file_extension = parse_track_stream(stream)

    # Determine codec/content type from stream info
    codec = stream.audioQuality or "AAC"
    if "FLAC" in codec.upper() or "LOSSLESS" in codec.upper():
        content_type = "audio/flac"
        acodec = "flac"
    else:
        content_type = "audio/mp4"
        acodec = "aac"

    # tiddl returns a list of URLs; for streaming we use the first
    url = urls[0] if urls else ""

    result = {
        "url": url,
        "urls": urls,
        "content_type": content_type,
        "acodec": acodec,
        "requested_quality": normalized_quality,
        "quality": stream.audioQuality,
        "bit_depth": getattr(stream, "bitDepth", None),
        "sample_rate": getattr(stream, "sampleRate", None),
        "expires_at": time.time() + STREAM_CACHE_TTL,
    }

    _stream_cache[cache_key] = result
    return result


def _clean_stream_cache():
    """Remove expired entries from the stream cache."""
    now = time.time()
    expired = [k for k, v in _stream_cache.items() if now >= v.get("expires_at", 0)]
    for k in expired:
        _stream_cache.pop(k, None)


# ════════════════════════════════════════════════════════════════════
# Routes
# ════════════════════════════════════════════════════════════════════

@app.get("/health")
async def health():
    return {"status": "ok", "service": "tidal-downloader"}

# ── Authentication ──────────────────────────────────────────────────

@app.post("/auth/device")
async def auth_device():
    """Step 1: Initiate device-code OAuth flow. Returns a verification URL."""
    try:
        auth_api = AuthAPI()
        device_auth = auth_api.get_device_auth()
        return {
            "device_code": device_auth.deviceCode,
            "user_code": device_auth.userCode,
            "verification_uri": device_auth.verificationUri,
            "verification_uri_complete": device_auth.verificationUriComplete,
            "expires_in": device_auth.expiresIn,
            "interval": device_auth.interval,
        }
    except Exception as e:
        log.error(f"Device auth failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/auth/token")
async def auth_token(req: AuthTokenRequest):
    """Step 2: Poll for token after user has authorised the device code."""
    try:
        auth_api = AuthAPI()
        auth_response = auth_api.get_auth(req.device_code)
        return {
            "access_token": auth_response.access_token,
            "refresh_token": auth_response.refresh_token,
            "token_type": auth_response.token_type,
            "expires_in": auth_response.expires_in,
            "user_id": str(auth_response.user.userId),
            "country_code": auth_response.user.countryCode,
            "username": auth_response.user.username,
        }
    except AuthClientError as e:
        # Expected while user hasn't authorised yet
        raise HTTPException(status_code=428, detail={
            "error": e.error,
            "sub_status": e.sub_status,
            "error_description": e.error_description,
        })
    except Exception as e:
        log.error(f"Token exchange failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/auth/refresh")
async def auth_refresh(req: RefreshRequest):
    """Refresh an expired access token."""
    try:
        auth_api = AuthAPI()
        auth_response = auth_api.refresh_token(req.refresh_token)
        return {
            "access_token": auth_response.access_token,
            "token_type": auth_response.token_type,
            "expires_in": auth_response.expires_in,
            "user_id": str(auth_response.user.userId),
            "country_code": auth_response.user.countryCode,
        }
    except AuthClientError as e:
        raise HTTPException(status_code=401, detail={
            "error": e.error,
            "sub_status": e.sub_status,
            "error_description": e.error_description,
        })
    except Exception as e:
        log.error(f"Token refresh failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/auth/session")
async def auth_session(tokens: SessionCheckPayload):
    """Verify that the stored tokens are still valid by calling /sessions."""
    try:
        api = _build_api(tokens.access_token, tokens.user_id, tokens.country_code)
        session = api.get_session()
        return {
            "valid": True,
            "session_id": session.sessionId,
            "user_id": session.userId,
            "country_code": session.countryCode,
        }
    except ApiError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        log.error(f"Session check failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Search ──────────────────────────────────────────────────────────

@app.post("/search")
async def search(req: SearchRequest, access_token: str = "", user_id: str = "", country_code: str = "US"):
    """Search TIDAL for tracks, albums, and artists."""
    if not access_token:
        raise HTTPException(status_code=401, detail="access_token header required")

    api = _build_api(access_token, user_id, country_code)
    try:
        results = api.get_search(req.query)
        return {
            "tracks": [
                {
                    "id": t.id,
                    "title": t.title,
                    "artist": t.artists[0].name if t.artists else "Unknown",
                    "album": {"id": t.album.id, "title": t.album.title},
                    "duration": t.duration,
                    "quality": t.audioQuality,
                    "isrc": t.isrc,
                    "explicit": t.explicit,
                }
                for t in results.tracks.items[:20]
            ],
            "albums": [
                {
                    "id": a.id,
                    "title": a.title,
                    "artist": a.artist.name if a.artist else "Unknown",
                    "numberOfTracks": a.numberOfTracks,
                    "releaseDate": str(a.releaseDate) if a.releaseDate else None,
                    "type": a.type,
                    "quality": a.audioQuality,
                    "cover": a.cover,
                }
                for a in results.albums.items[:20]
            ],
            "artists": [
                {
                    "id": a.id,
                    "name": a.name,
                    "picture": a.picture,
                }
                for a in results.artists.items[:10]
            ],
        }
    except ApiError as e:
        raise HTTPException(status_code=e.status if hasattr(e, "status") else 500, detail=str(e))


# ── Download ────────────────────────────────────────────────────────

@app.post("/download/track")
async def download_track(
    req: DownloadTrackRequest,
    access_token: str = "",
    user_id: str = "",
    country_code: str = "US",
):
    """Download a single track from TIDAL."""
    if not access_token:
        raise HTTPException(status_code=401, detail="access_token required")

    api = _build_api(access_token, user_id, country_code)

    try:
        result = await asyncio.to_thread(
            _download_track_sync,
            api=api,
            track_id=req.track_id,
            quality=req.quality,
            output_template=req.output_template,
            dest_base=MUSIC_PATH,
        )
        return result
    except ApiError as e:
        log.error(f"TIDAL API error downloading track {req.track_id}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(f"Download failed for track {req.track_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/download/album")
async def download_album(
    req: DownloadAlbumRequest,
    access_token: str = "",
    user_id: str = "",
    country_code: str = "US",
):
    """Download all tracks from a TIDAL album."""
    if not access_token:
        raise HTTPException(status_code=401, detail="access_token required")

    api = _build_api(access_token, user_id, country_code)

    try:
        album = api.get_album(req.album_id)

        # Fetch all tracks
        tracks = []
        offset = 0
        while True:
            items = api.get_album_items(req.album_id, limit=100, offset=offset)
            for album_item in items.items:
                if hasattr(album_item, "item") and hasattr(album_item.item, "isrc"):
                    tracks.append(album_item.item)
            offset += items.limit
            if offset >= items.totalNumberOfItems:
                break

        results = []
        errors = []

        for i, track in enumerate(tracks):
            # Rate-limit: wait between tracks to avoid TIDAL API bans
            if i > 0:
                delay = float(os.getenv("TIDAL_TRACK_DELAY", "3"))
                log.debug(f"Rate limit: waiting {delay}s before track {i+1}/{len(tracks)}")
                await asyncio.sleep(delay)

            try:
                result = await asyncio.to_thread(
                    _download_track_sync,
                    api=api,
                    track_id=track.id,
                    quality=req.quality,
                    output_template=req.output_template,
                    dest_base=MUSIC_PATH,
                )
                results.append(result)
            except Exception as e:
                log.error(f"Failed to download track {track.id} ({track.title}): {e}")
                errors.append({
                    "track_id": track.id,
                    "title": track.title,
                    "error": str(e),
                })

        return {
            "album_id": req.album_id,
            "album_title": album.title,
            "artist": album.artist.name if album.artist else "Unknown",
            "total_tracks": len(tracks),
            "downloaded": len(results),
            "failed": len(errors),
            "tracks": results,
            "errors": errors,
        }
    except ApiError as e:
        log.error(f"TIDAL API error downloading album {req.album_id}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(f"Album download failed for {req.album_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ════════════════════════════════════════════════════════════════════
# Per-user streaming routes
# ════════════════════════════════════════════════════════════════════

@app.get("/user/auth/status")
async def user_auth_status(user_id: str = Query(...)):
    """Check if a user has an active TIDAL session."""
    has_session = user_id in _user_apis
    return {"authenticated": has_session, "user_id": user_id}


@app.post("/user/auth/restore")
async def user_auth_restore(req: UserAuthRestoreRequest, user_id: str = Query(...)):
    """
    Restore a user's TIDAL credentials from the Node.js backend.
    Called lazily on first request that needs this user's session.
    If the access token is expired, refresh it automatically.
    """
    try:
        api = _build_api(req.access_token, req.user_id, req.country_code)
        # Verify the session is valid
        session = api.get_session()
        _user_apis[user_id] = api
        _user_auth_state[user_id] = {
            "access_token": req.access_token,
            "refresh_token": req.refresh_token,
            "tidal_user_id": req.user_id,
            "country_code": req.country_code,
        }
        log.info(f"Restored TIDAL session for user {user_id} (tidal_user={req.user_id})")
        return {
            "success": True,
            "user_id": req.user_id,
            "country_code": req.country_code,
        }
    except ApiError as e:
        # Token expired — try refreshing
        log.warning(f"TIDAL session expired for user {user_id}, attempting refresh: {e}")
        try:
            auth_api = AuthAPI()
            auth_response = auth_api.refresh_token(req.refresh_token)
            new_token = auth_response.access_token
            new_user_id = str(auth_response.user.userId)
            new_country = auth_response.user.countryCode

            # Build a new API with the refreshed token
            api = _build_api(new_token, new_user_id, new_country)
            session = api.get_session()
            _user_apis[user_id] = api
            _user_auth_state[user_id] = {
                "access_token": new_token,
                "refresh_token": req.refresh_token,
                "tidal_user_id": new_user_id,
                "country_code": new_country,
            }
            log.info(f"Refreshed and restored TIDAL session for user {user_id}")
            return {
                "success": True,
                "refreshed": True,
                "access_token": new_token,
                "user_id": new_user_id,
                "country_code": new_country,
            }
        except Exception as refresh_err:
            log.error(f"Token refresh also failed for user {user_id}: {refresh_err}")
            raise HTTPException(status_code=401, detail=f"Invalid TIDAL credentials and refresh failed: {e}")
    except Exception as e:
        log.error(f"Failed to restore TIDAL session for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/user/auth/clear")
async def user_auth_clear(user_id: str = Query(...)):
    """Clear a user's TIDAL session."""
    _invalidate_user_api(user_id)
    log.info(f"Cleared TIDAL session for user {user_id}")
    return {"success": True}


@app.post("/user/search")
async def user_search(
    req: SearchRequest,
    user_id: str = Query(...),
):
    """Search TIDAL using a user's own credentials."""
    try:
        results = await _run_user_api_call(
            user_id,
            lambda current_api: current_api.get_search(req.query),
            operation=f"search '{req.query}'",
        )
        return {
            "tracks": [
                {
                    "id": t.id,
                    "title": t.title,
                    "artist": t.artists[0].name if t.artists else "Unknown",
                    "artists": [a.name for a in t.artists] if t.artists else [],
                    "album": {"id": t.album.id, "title": t.album.title},
                    "duration": t.duration,
                    "quality": t.audioQuality,
                    "isrc": t.isrc,
                    "explicit": t.explicit,
                }
                for t in results.tracks.items[:20]
            ],
            "albums": [
                {
                    "id": a.id,
                    "title": a.title,
                    "artist": a.artist.name if a.artist else "Unknown",
                    "numberOfTracks": a.numberOfTracks,
                    "releaseDate": str(a.releaseDate) if a.releaseDate else None,
                    "type": a.type,
                    "quality": a.audioQuality,
                    "cover": a.cover,
                }
                for a in results.albums.items[:20]
            ],
            "artists": [
                {
                    "id": a.id,
                    "name": a.name,
                    "picture": a.picture,
                }
                for a in results.artists.items[:10]
            ],
        }
    except ApiError as e:
        raise HTTPException(
            status_code=getattr(e, "status", 500), detail=str(e)
        )


@app.post("/user/search/batch")
async def user_search_batch(
    queries: list[BatchSearchQuery],
    user_id: str = Query(...),
):
    """
    Batch search — run multiple search queries in one request.
    Used for gap-fill matching (find streaming versions of unowned tracks).
    """
    async def _run_one(q: BatchSearchQuery) -> dict:
        try:
            results = await _run_user_api_call(
                user_id,
                lambda current_api: current_api.get_search(q.query),
                operation=f"batch search '{q.query}'",
            )
            tracks = [
                {
                    "id": t.id,
                    "title": t.title,
                    "artist": t.artists[0].name if t.artists else "Unknown",
                    "duration": t.duration,
                    "isrc": t.isrc,
                }
                for t in results.tracks.items[: q.limit]
            ]
            return {"query": q.query, "results": tracks}
        except Exception as e:
            log.warning(f"Batch search failed for '{q.query}': {e}")
            return {"query": q.query, "results": []}

    results = await asyncio.gather(*[_run_one(q) for q in queries])
    return {"results": list(results)}


@app.get("/user/stream-info/{track_id}")
async def user_stream_info(
    track_id: int,
    user_id: str = Query(...),
    quality: str = "HIGH",
):
    """Get stream metadata for a TIDAL track (quality, codec, etc.)."""
    try:
        info = await _run_user_api_call(
            user_id,
            lambda _current_api: _get_stream_url_sync(user_id, track_id, quality),
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
    except Exception as e:
        log.error(f"Stream info failed for track {track_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/user/stream/{track_id}")
async def user_stream_proxy(
    track_id: int,
    user_id: str = Query(...),
    quality: str = "HIGH",
    request: Request = None,
):
    """
    Proxy the audio stream from TIDAL. The Node.js backend pipes this
    to the frontend player. Stream URLs are IP-locked to the server,
    so we must proxy.
    """
    normalized_quality = _normalize_stream_quality(quality)

    # Build headers for upstream request
    headers = {}
    if request and "range" in request.headers:
        headers["Range"] = request.headers["range"]

    async def _open_upstream_stream():
        """
        Open a stream from the current URL cache, and retry once with a fresh
        URL when upstream rejects the cached URL (401/403).
        """
        for attempt in range(2):
            if attempt == 1:
                _clear_stream_cache(
                    user_id,
                    track_id=track_id,
                    quality=normalized_quality,
                )

            stream_info = await _run_user_api_call(
                user_id,
                lambda _current_api: _get_stream_url_sync(
                    user_id, track_id, normalized_quality
                ),
                operation=f"stream URL fetch for track {track_id}",
            )
            stream_url = stream_info.get("url")
            if not stream_url:
                raise HTTPException(status_code=404, detail="No stream URL available")

            client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))
            try:
                upstream = await client.send(
                    client.build_request("GET", stream_url, headers=headers),
                    stream=True,
                )
            except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
                await client.aclose()
                log.error(f"Upstream stream request failed for track {track_id}: {e}")
                raise HTTPException(
                    status_code=502,
                    detail="Failed to fetch TIDAL stream",
                ) from e

            if attempt == 0 and upstream.status_code in (401, 403):
                log.warning(
                    "Cached TIDAL stream URL rejected for track %s (status=%s); refreshing once",
                    track_id,
                    upstream.status_code,
                )
                await upstream.aclose()
                await client.aclose()
                continue

            return client, upstream, stream_info

        raise HTTPException(status_code=502, detail="Unable to refresh TIDAL stream URL")

    client, upstream, stream_info = await _open_upstream_stream()

    response_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    }
    content_type = upstream.headers.get("content-type") or stream_info.get(
        "content_type", "audio/mp4"
    )
    if content_type:
        response_headers["Content-Type"] = content_type
    if "content-range" in upstream.headers:
        response_headers["Content-Range"] = upstream.headers["content-range"]

    async def proxy_stream():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=65536):
                yield chunk
        except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
            log.warning(f"Upstream read error during stream for track {track_id}: {e}")
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        proxy_stream(),
        status_code=upstream.status_code,
        headers=response_headers,
    )


@app.get("/user/track/{track_id}")
async def user_get_track(
    track_id: int,
    user_id: str = Query(...),
):
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
            "artists": [a.name for a in track.artists] if track.artists else [],
            "duration": track.duration,
            "isrc": track.isrc,
            "explicit": track.explicit,
            "album": {
                "id": track.album.id,
                "title": track.album.title,
            },
        }
    except ApiError as e:
        raise HTTPException(
            status_code=getattr(e, "status", 500), detail=str(e)
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8585)
