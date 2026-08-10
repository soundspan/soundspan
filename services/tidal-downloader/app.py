"""
TIDAL Downloader & Streamer — FastAPI sidecar for soundspan.

Uses the `tiddl` Python library to authenticate, search, download,
and stream tracks/albums from TIDAL. The Node.js backend communicates
with this service over HTTP on port 8585.

Supports **per-user** streaming: each soundspan user connects their own
TIDAL account via device-code OAuth. User credentials are scoped by
user_id query parameters. Admin credentials (for downloading) remain
in SystemSettings and use an Authorization: Bearer header, with deprecated
query-parameter support retained for one release.
"""

import asyncio
import logging
import os
import shutil
import sys
import threading
import time
from base64 import b64decode
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, NamedTuple
from xml.etree.ElementTree import fromstring as xml_fromstring

import httpx
import tidalapi
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

SERVICES_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICES_ROOT) not in sys.path:
    sys.path.append(str(SERVICES_ROOT))

from common.logging_utils import configure_service_logger
from common.sidecar_runtime_utils import (
    build_stream_proxy_client,
    env_float,
    register_error_handlers,
    require_internal_secret,
)
from tiddl.core.api import ApiError, TidalAPI, TidalClient

# ── tiddl core imports ──────────────────────────────────────────────
from tiddl.core.auth import AuthAPI, AuthClientError
from tiddl.core.metadata import Cover, add_track_metadata
from tiddl.core.utils import parse_track_stream
from tiddl.core.utils.format import format_template

# ── Logging ─────────────────────────────────────────────────────────
log = configure_service_logger("tidal-downloader")


class _ThrottlePoolFullWarning(logging.Filter):
    """Throttle noisy urllib3 pool-full warnings while preserving signal."""

    _SUPPRESSION_WINDOW_SECONDS = 300

    def __init__(self) -> None:
        super().__init__()
        self._last_emit_at = 0.0

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "Connection pool is full, discarding connection" not in message:
            return True

        now = time.monotonic()
        if (now - self._last_emit_at) < self._SUPPRESSION_WINDOW_SECONDS:
            return False

        self._last_emit_at = now
        record.msg = (
            "urllib3 connection pool saturated; suppressing repeated pool-full "
            "warnings for 300s. Increase upstream pool size if this persists."
        )
        record.args = ()
        return True


logging.getLogger("urllib3.connectionpool").addFilter(_ThrottlePoolFullWarning())

# ── FastAPI app ─────────────────────────────────────────────────────
app = FastAPI(
    title="soundspan TIDAL Downloader & Streamer",
    version="2.0.0",
    dependencies=[Depends(require_internal_secret)],
    # The docs/openapi routes are registered via add_route(), which app-level
    # dependencies do NOT cover — left on they'd disclose the full API schema
    # unauthenticated. Internal M2M service, no docs consumer: disable them.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
register_error_handlers(app, log)

# ── Paths ───────────────────────────────────────────────────────────
TIDDL_PATH = Path(os.getenv("TIDDL_PATH", "/data/.tiddl"))
MUSIC_PATH = Path(os.getenv("MUSIC_PATH", "/music"))

# ── Per-user API instances for streaming ───────────────────────────
_user_apis: dict[str, TidalAPI] = {}
_user_api_locks: dict[str, asyncio.Lock] = {}
_user_auth_state: dict[str, dict[str, str]] = {}
_user_auth_state_lock = threading.Lock()

# ── Stream URL cache (per-user, keyed by (user_id, track_id, quality)) ─────
_stream_cache: dict[tuple[str, int, str], dict] = {}
_stream_cache_lock = threading.Lock()
STREAM_CACHE_TTL = 600  # 10 minutes
STREAM_QUALITY_OPTIONS = {"LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"}

# ── tidalapi ↔ tiddl quality mapping ──────────────────────────────
# tiddl uses raw strings: "LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"
# tidalapi uses enum members with different names:
#   Quality.low_96k     = "LOW"
#   Quality.low_320k    = "HIGH"
#   Quality.high_lossless = "LOSSLESS"
#   Quality.hi_res_lossless = "HI_RES_LOSSLESS"
TIDDL_TO_TIDALAPI_QUALITY: dict[str, tidalapi.Quality] = {
    "LOW": tidalapi.Quality.low_96k,
    "HIGH": tidalapi.Quality.low_320k,
    "LOSSLESS": tidalapi.Quality.high_lossless,
    "HI_RES_LOSSLESS": tidalapi.Quality.hi_res_lossless,
}
TIDALAPI_DEFAULT_QUALITY = tidalapi.Quality.high_lossless

# ── Per-user tidalapi browse sessions ─────────────────────────────
# Keyed by "user_id:quality" so changing quality creates a new session.
_browse_sessions: dict[str, tidalapi.Session] = {}
_browse_sessions_lock = threading.Lock()
_BROWSE_SESSION_MAX = 50
_public_browse_sessions: dict[str, tidalapi.Session] = {}
_public_browse_sessions_lock = threading.Lock()
_PUBLIC_BROWSE_SESSION_MAX = 8
_BATCH_SEARCH_MAX_QUERIES = 50
_BATCH_SEARCH_CONCURRENCY = 5


def _build_browse_session(user_id: str, quality: str | None = None) -> tidalapi.Session:
    """Get or create a tidalapi Session for browse endpoints.

    quality: tiddl-style quality string (LOW/HIGH/LOSSLESS/HI_RES_LOSSLESS).
             Falls back to TIDALAPI_DEFAULT_QUALITY if omitted or unrecognised.
    """
    normalized = _normalize_stream_quality(quality) if quality else None
    api_quality = TIDDL_TO_TIDALAPI_QUALITY.get(normalized or "", TIDALAPI_DEFAULT_QUALITY)
    cache_key = f"{user_id}:{api_quality.value}"

    with _browse_sessions_lock:
        cached = _browse_sessions.get(cache_key)
    if cached is not None:
        return cached

    with _user_auth_state_lock:
        creds = _user_auth_state.get(user_id)
        creds_snapshot = dict(creds) if creds else None
    if not creds_snapshot:
        raise HTTPException(
            status_code=401,
            detail=f"No TIDAL session for user {user_id}. Restore credentials first.",
        )

    session = tidalapi.Session(tidalapi.Config(quality=api_quality))
    session.load_oauth_session(
        token_type="Bearer",  # noqa: S106 -- OAuth token scheme, not a credential
        access_token=creds_snapshot["access_token"],
        refresh_token=creds_snapshot.get("refresh_token"),
        expiry_time=None,
    )
    with _browse_sessions_lock:
        # Evict oldest entries if cache is full
        while len(_browse_sessions) >= _BROWSE_SESSION_MAX:
            oldest_key = next(iter(_browse_sessions))
            _browse_sessions.pop(oldest_key, None)
        _browse_sessions[cache_key] = session
    return session


def _build_public_browse_session(quality: str | None = None) -> tidalapi.Session:
    """Get or create an unauthenticated tidalapi Session for public browse."""
    normalized = _normalize_stream_quality(quality) if quality else None
    api_quality = TIDDL_TO_TIDALAPI_QUALITY.get(normalized or "", TIDALAPI_DEFAULT_QUALITY)
    cache_key = api_quality.value

    with _public_browse_sessions_lock:
        cached = _public_browse_sessions.get(cache_key)
    if cached is not None:
        return cached

    session = tidalapi.Session(tidalapi.Config(quality=api_quality))
    with _public_browse_sessions_lock:
        while len(_public_browse_sessions) >= _PUBLIC_BROWSE_SESSION_MAX:
            oldest_key = next(iter(_public_browse_sessions))
            _public_browse_sessions.pop(oldest_key, None)
        _public_browse_sessions[cache_key] = session
    return session


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
    filter: str | None = None
    limit: int = 5


class AdminCredentials(NamedTuple):
    """Admin TIDAL credentials extracted from an incoming request."""

    access_token: str
    user_id: str
    country_code: str


# ════════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════════


def _parse_bearer_token(authorization: str | None) -> str | None:
    """Return a nonempty bearer token from an Authorization header."""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def require_admin_credentials(
    authorization: str | None = Header(None),
    x_tidal_user_id: str | None = Header(None),
    x_tidal_country_code: str | None = Header(None),
    access_token: str = Query(""),
    user_id: str = Query(""),
    country_code: str = Query("US"),
) -> AdminCredentials:
    """Resolve admin credentials from headers or the deprecated query fallback."""
    bearer_token = _parse_bearer_token(authorization)
    if bearer_token is not None:
        resolved_user_id = x_tidal_user_id if x_tidal_user_id is not None else user_id
        resolved_country = (
            x_tidal_country_code if x_tidal_country_code is not None else country_code
        )
        return AdminCredentials(bearer_token, resolved_user_id, resolved_country)

    if not access_token:
        raise HTTPException(status_code=401, detail="access_token required")
    log.warning(
        "access_token via query string is deprecated; send Authorization: "
        "Bearer — query support will be removed next release"
    )
    return AdminCredentials(access_token, user_id, country_code)


def _sanitized_http_error(
    operation: str,
    exc: Exception,
    status_code: int,
    detail: str,
) -> HTTPException:
    """Log full exception detail; return a generic client-facing HTTPException."""
    log.error(
        "%s failed: %s",
        operation,
        exc,
        exc_info=True,  # noqa: LOG014 -- callers invoke this helper from active exception handlers
    )
    return HTTPException(status_code=status_code, detail=detail)


def _sanitize_path_component(name: str) -> str:
    """Remove or replace chars that are invalid on most filesystems."""
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    return name.strip(". ")


def _is_playlist_not_found_error(error: Exception) -> bool:
    """Return True when an upstream exception clearly indicates missing playlist."""
    if isinstance(error, HTTPException):
        return error.status_code == 404
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code == 404:
        return True
    message = str(error).lower()
    return "not found" in message or "404" in message


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
):
    """Clear cached stream URLs for a user, optionally scoped by track/quality."""
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


def _invalidate_user_api(user_id: str):
    """Remove a user's API instance (e.g. on logout)."""
    _user_apis.pop(user_id, None)
    with _user_auth_state_lock:
        _user_auth_state.pop(user_id, None)
    # Clear all browse sessions for this user (keyed as "user_id:quality")
    with _browse_sessions_lock:
        for key in [k for k in _browse_sessions if k.startswith(f"{user_id}:")]:
            _browse_sessions.pop(key, None)
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
        str(sub_status) == "11003" or "token has expired" in message or "expired on time" in message
    )


def _clear_refreshed_session_caches(user_id: str) -> None:
    """Clear caches tied to the credentials replaced by a refresh."""
    _clear_stream_cache(user_id)
    with _browse_sessions_lock:
        for key in [k for k in _browse_sessions if k.startswith(f"{user_id}:")]:
            _browse_sessions.pop(key, None)


def _commit_refreshed_session(
    user_id: str,
    creds: dict[str, str],
    refreshed_api: TidalAPI,
    access_token: str,
    tidal_user_id: str,
    country_code: str,
) -> TidalAPI | None:
    """Commit a refresh only while its captured credentials remain current."""
    with _user_auth_state_lock:
        if _user_auth_state.get(user_id) is not creds:
            return _user_apis.get(user_id)

        creds["access_token"] = access_token
        creds["tidal_user_id"] = tidal_user_id
        creds["country_code"] = country_code
        _user_apis[user_id] = refreshed_api
        return refreshed_api


async def _refresh_user_api(user_id: str) -> TidalAPI:
    """Refresh a user's token under a per-user lock to prevent stampedes."""
    lock = _get_user_lock(user_id)

    async with lock:
        with _user_auth_state_lock:
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
            auth_response = await asyncio.to_thread(auth_api.refresh_token, creds["refresh_token"])

            new_access_token = auth_response.access_token
            new_user_id = str(auth_response.user.userId)
            new_country = auth_response.user.countryCode

            refreshed_api = _build_api(new_access_token, new_user_id, new_country)
            await asyncio.to_thread(refreshed_api.get_session)
        except Exception as refresh_err:
            log.error(f"TIDAL token refresh failed for user {user_id}: {refresh_err}")
            _invalidate_user_api(user_id)
            raise HTTPException(
                status_code=401,
                detail="TIDAL session expired and token refresh failed",
            ) from refresh_err

        committed_api = _commit_refreshed_session(
            user_id,
            creds,
            refreshed_api,
            new_access_token,
            new_user_id,
            new_country,
        )
        if committed_api is None:
            raise HTTPException(
                status_code=401,
                detail="TIDAL session was cleared during token refresh",
            )
        if committed_api is not refreshed_api:
            return committed_api

        _clear_refreshed_session_caches(user_id)
        log.info(f"Refreshed TIDAL session for user {user_id}")
        return refreshed_api


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


# Maximum decoded manifest size we're willing to parse (1 MiB).
_MAX_MANIFEST_BYTES = 1 * 1024 * 1024

_DASH_NS = "{urn:mpeg:dash:schema:mpd:2011}"


def _parse_dash_mpd(manifest_b64: str):
    """Decode and parse a base64-encoded DASH MPD manifest.

    Returns the parsed ElementTree root, or ``None`` if the manifest is
    invalid, oversized, or unparseable.  Enforces a size cap to prevent
    resource abuse from unexpectedly large upstream payloads.
    """
    try:
        raw = b64decode(manifest_b64)
        if len(raw) > _MAX_MANIFEST_BYTES:
            log.warning("DASH manifest exceeds size cap (%d bytes)", len(raw))
            return None
        return xml_fromstring(raw.decode())  # noqa: S314 -- input is size-bounded and only queried, not expanded
    except Exception as exc:
        log.debug("Failed to parse DASH MPD manifest: %s", exc)
        return None


def _find_segment_template(tree):
    """Locate the SegmentTemplate element in a DASH MPD.

    DASH allows SegmentTemplate at either the Representation level or the
    AdaptationSet level.  Try Representation first (most common), then fall
    back to AdaptationSet.
    """
    ns = _DASH_NS
    seg_tpl = tree.find(f"{ns}Period/{ns}AdaptationSet/{ns}Representation/{ns}SegmentTemplate")
    if seg_tpl is None:
        seg_tpl = tree.find(f"{ns}Period/{ns}AdaptationSet/{ns}SegmentTemplate")
    return seg_tpl


def _extract_dash_init_url(manifest_b64: str) -> str | None:
    """Extract the initialization segment URL from a DASH MPD manifest.

    tiddl's ``parse_manifest_XML`` only returns media segment URLs but omits
    the init segment whose moov atom carries total-duration metadata.  Without
    it the ``<audio>`` element cannot determine the full track length, causing
    the seek bar to show only a single-fragment duration (~4 s).
    """
    tree = _parse_dash_mpd(manifest_b64)
    if tree is None:
        return None
    seg_tpl = _find_segment_template(tree)
    if seg_tpl is not None:
        return seg_tpl.get("initialization")
    return None


def _resolve_dash_codec(manifest_b64: str) -> str | None:
    """Read the ``codecs`` attribute from the DASH MPD Representation element.

    Returns the raw codec string (e.g. ``"flac"``, ``"mp4a.40.2"``) so the
    caller can report the true codec instead of guessing from the file
    extension.
    """
    tree = _parse_dash_mpd(manifest_b64)
    if tree is None:
        return None
    ns = _DASH_NS
    rep = tree.find(f"{ns}Period/{ns}AdaptationSet/{ns}Representation")
    if rep is not None:
        return rep.get("codecs")
    return None


def _get_stream_url_sync(user_id: str, track_id: int, quality: str = "HIGH") -> dict:
    """
    Extract stream URL for a TIDAL track (synchronous — run in thread).
    Uses tiddl's stream extraction. Results are cached for STREAM_CACHE_TTL.
    """
    normalized_quality = _normalize_stream_quality(quality)
    cache_key = (user_id, track_id, normalized_quality)
    with _stream_cache_lock:
        cached = _stream_cache.get(cache_key)
    if cached and time.time() < cached.get("expires_at", 0):
        return cached

    api = _get_user_api(user_id)
    stream = api.get_track_stream(track_id=track_id, quality=normalized_quality)
    urls, file_extension = parse_track_stream(stream)

    # DASH manifests (HI_RES_LOSSLESS) produce multiple segment URLs.
    # BTS manifests (LOW/HIGH/LOSSLESS) produce a single direct URL.
    is_dash = stream.manifestMimeType == "application/dash+xml"

    if is_dash:
        # ── DASH (HI_RES_LOSSLESS): fMP4 container with FLAC, ALAC, or AAC ──
        # The container is always MP4 but the inner codec varies.
        # Read the real codec from the MPD Representation element.
        dash_codec = _resolve_dash_codec(stream.manifest)
        dash_codec_lower = (dash_codec or "").lower()
        if dash_codec_lower == "flac":
            acodec = "flac"
        elif dash_codec_lower in ("alac", "alac "):
            acodec = "alac"
        elif dash_codec_lower.startswith("mp4a"):
            acodec = "aac"
        else:
            # Unknown codec — report raw value so the quality badge is honest
            acodec = dash_codec_lower or "aac"
        content_type = "audio/mp4"

        # Prepend the initialization segment (moov atom with duration
        # metadata) so the <audio> element knows the full track length
        # and seeking works correctly.
        init_url = _extract_dash_init_url(stream.manifest)
        if init_url:
            urls = [init_url, *urls]
            log.info(
                "Prepended DASH init segment for track %s (%d total segments)",
                track_id,
                len(urls),
            )
    else:
        # ── BTS single-URL (LOW/HIGH/LOSSLESS) ──
        if file_extension == ".flac":
            content_type = "audio/flac"
            acodec = "flac"
        else:
            content_type = "audio/mp4"
            acodec = "aac"

    url = urls[0] if urls else ""

    result = {
        "url": url,
        "urls": urls,
        "is_dash": is_dash,
        "content_type": content_type,
        "acodec": acodec,
        "requested_quality": normalized_quality,
        "quality": stream.audioQuality,
        "bit_depth": getattr(stream, "bitDepth", None),
        "sample_rate": getattr(stream, "sampleRate", None),
        "expires_at": time.time() + STREAM_CACHE_TTL,
    }

    with _stream_cache_lock:
        _stream_cache[cache_key] = result
    return result


def _clean_stream_cache():
    """Remove expired entries from the stream cache."""
    now = time.time()
    with _stream_cache_lock:
        expired = [k for k, v in _stream_cache.items() if now >= v.get("expires_at", 0)]
        for k in expired:
            _stream_cache.pop(k, None)


# ════════════════════════════════════════════════════════════════════
# Browse serialization helpers
# ════════════════════════════════════════════════════════════════════


def _tidal_image_url(image_id, w=480, h=480):
    """Convert a TIDAL image UUID to a resources.tidal.com URL."""
    if not image_id:
        return None
    uuid_path = image_id.replace("-", "/")
    return f"https://resources.tidal.com/images/{uuid_path}/{w}x{h}.jpg"


def _serialize_page_item(item):
    """Serialize a single item from a tidalapi PageCategory."""
    result = {"title": getattr(item, "name", None) or getattr(item, "title", None) or ""}

    # Determine type and IDs
    type_name = type(item).__name__.lower()
    if hasattr(item, "id"):
        if "playlist" in type_name:
            result["type"] = "playlist"
            result["playlistId"] = str(item.id)
        elif "mix" in type_name:
            result["type"] = "mix"
            result["mixId"] = str(item.id)
        elif "album" in type_name:
            result["type"] = "album"
            result["albumId"] = str(item.id)
        else:
            result["type"] = type_name

    # Image - try .image() method first, then .image property, then _image attribute
    thumb = None
    if callable(getattr(item, "image", None)):
        try:
            thumb = item.image(320)
        except Exception as e:
            log.debug("Failed to extract page item thumbnail: %s", e)
    if not thumb and hasattr(item, "image") and isinstance(item.image, str):
        thumb = _tidal_image_url(item.image, 320, 320)
    result["thumbnailUrl"] = thumb

    # Subtitle
    result["subtitle"] = (
        getattr(item, "sub_title", None) or getattr(item, "description", None) or ""
    )

    return result


def _serialize_page(page):
    """Serialize a tidalapi Page to shelf format.

    Categories whose items cannot be serialized into playable shelf
    entries (e.g. genre/mood navigation links) are omitted so the
    frontend never receives empty rows.
    """
    shelves = []
    for cat in page.categories or []:
        items_list = getattr(cat, "items", None) or []
        serialized_items = [
            si
            for si in (_serialize_page_item(item) for item in items_list)
            if si.get("playlistId") or si.get("mixId") or si.get("albumId")
        ]
        # Skip categories that produced no actionable items
        if not serialized_items:
            continue
        shelves.append(
            {
                "title": getattr(cat, "title", "") or "",
                "contents": serialized_items,
            }
        )
    return shelves


def _extract_page_links(page) -> list[dict]:
    """Extract individual PageLink items from a genre/mood Page.

    tidalapi returns Page objects whose categories are PageLinks containers,
    each holding a list of PageLink items with .title, .api_path, .image_id.
    """
    results = []
    for cat in page.categories or []:
        items = getattr(cat, "items", None) or []
        for item in items:
            results.append(_serialize_genre(item))
    return results


def _serialize_genre(genre):
    """Serialize a tidalapi genre/mood PageLink or category to dict."""
    img = None
    # PageLink objects store image as .image_id (UUID string)
    image_id = getattr(genre, "image_id", None)
    if image_id and isinstance(image_id, str):
        img = _tidal_image_url(image_id, 320, 320)
    # Fallback: older-style objects with .image property/method
    if not img and hasattr(genre, "image") and genre.image:
        if callable(genre.image):
            try:
                img = genre.image(320)
            except Exception as e:
                log.debug("Failed to extract genre image: %s", e)
        elif isinstance(genre.image, str):
            img = _tidal_image_url(genre.image, 320, 320)

    # PageLink uses .api_path; older objects may use .path
    path = getattr(genre, "api_path", "") or getattr(genre, "path", "") or ""
    # Strip leading "pages/" — the genre-playlists endpoint adds it back
    if path.startswith("pages/"):
        path = path[len("pages/") :]

    return {
        "name": getattr(genre, "name", "") or getattr(genre, "title", "") or "",
        "path": path,
        "hasPlaylists": bool(getattr(genre, "has_playlists", True)),
        "imageUrl": img,
    }


def _serialize_mix(mix):
    """Serialize a tidalapi Mix to dict."""
    img = None
    if callable(getattr(mix, "image", None)):
        try:
            img = mix.image(320)
        except Exception as e:
            log.debug("Failed to extract mix thumbnail: %s", e)
    return {
        "mixId": str(getattr(mix, "id", "")),
        "title": getattr(mix, "title", "") or "",
        "subTitle": getattr(mix, "sub_title", "") or "",
        "thumbnailUrl": img,
    }


def _serialize_track(track):
    """Serialize a tidalapi Track to dict."""
    artist = track.artist if hasattr(track, "artist") else None
    artist_name = getattr(artist, "name", "Unknown") if artist else "Unknown"
    artists = (
        [getattr(a, "name", "") for a in (track.artists or [])]
        if hasattr(track, "artists") and track.artists
        else [artist_name]
    )
    album = track.album if hasattr(track, "album") else None
    album_name = getattr(album, "name", "") if album else ""

    thumb = None
    if album and callable(getattr(album, "image", None)):
        try:
            thumb = album.image(320)
        except Exception as e:
            log.debug("Failed to extract track album art: %s", e)
    return {
        "trackId": track.id,
        "title": getattr(track, "name", "") or "",
        "artist": artist_name,
        "artists": artists,
        "album": album_name,
        "duration": getattr(track, "duration", 0) or 0,
        "isrc": getattr(track, "isrc", None),
        "thumbnailUrl": thumb,
    }


def _serialize_playlist_preview(playlist):
    """Serialize a tidalapi Playlist to a preview dict (no tracks)."""
    img = None
    if callable(getattr(playlist, "image", None)):
        try:
            img = playlist.image(320)
        except Exception as e:
            log.debug("Failed to extract playlist preview image: %s", e)
    return {
        "playlistId": str(getattr(playlist, "id", "")),
        "title": getattr(playlist, "name", "") or "",
        "numTracks": getattr(playlist, "num_tracks", 0) or 0,
        "thumbnailUrl": img,
    }


def _serialize_playlist_detail(playlist):
    """Serialize a tidalapi Playlist to a detail dict with tracks."""
    img = None
    if callable(getattr(playlist, "image", None)):
        try:
            img = playlist.image(320)
        except Exception as e:
            log.debug("Failed to extract playlist detail image: %s", e)
    tracks_list = playlist.tracks() if callable(getattr(playlist, "tracks", None)) else []
    return {
        "id": str(getattr(playlist, "id", "")),
        "title": getattr(playlist, "name", "") or "",
        "trackCount": getattr(playlist, "num_tracks", 0) or 0,
        "thumbnailUrl": img,
        "tracks": [_serialize_track(t) for t in tracks_list],
    }


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
        device_auth = await asyncio.to_thread(auth_api.get_device_auth)
        return {
            "device_code": device_auth.deviceCode,
            "user_code": device_auth.userCode,
            "verification_uri": device_auth.verificationUri,
            "verification_uri_complete": device_auth.verificationUriComplete,
            "expires_in": device_auth.expiresIn,
            "interval": device_auth.interval,
        }
    except Exception as e:
        raise _sanitized_http_error(
            "device auth",
            e,
            500,
            "Failed to initiate TIDAL device authorization",
        ) from e


@app.post("/auth/token")
async def auth_token(req: AuthTokenRequest):
    """Step 2: Poll for token after user has authorised the device code."""
    try:
        auth_api = AuthAPI()
        auth_response = await asyncio.to_thread(auth_api.get_auth, req.device_code)
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
        raise HTTPException(
            status_code=428,
            detail={
                "error": e.error,
                "sub_status": e.sub_status,
                "error_description": e.error_description,
            },
        )
    except Exception as e:
        raise _sanitized_http_error(
            "TIDAL token exchange", e, 500, "TIDAL token exchange failed"
        ) from e


@app.post("/auth/refresh")
async def auth_refresh(req: RefreshRequest):
    """Refresh an expired access token."""
    try:
        auth_api = AuthAPI()
        auth_response = await asyncio.to_thread(auth_api.refresh_token, req.refresh_token)
        return {
            "access_token": auth_response.access_token,
            "token_type": auth_response.token_type,
            "expires_in": auth_response.expires_in,
            "user_id": str(auth_response.user.userId),
            "country_code": auth_response.user.countryCode,
        }
    except AuthClientError as e:
        raise HTTPException(
            status_code=401,
            detail={
                "error": e.error,
                "sub_status": e.sub_status,
                "error_description": e.error_description,
            },
        )
    except Exception as e:
        raise _sanitized_http_error(
            "TIDAL token refresh", e, 500, "TIDAL token refresh failed"
        ) from e


@app.post("/auth/session")
async def auth_session(tokens: SessionCheckPayload):
    """Verify that the stored tokens are still valid by calling /sessions."""
    try:
        api = _build_api(tokens.access_token, tokens.user_id, tokens.country_code)
        session = await asyncio.to_thread(api.get_session)
        return {
            "valid": True,
            "session_id": session.sessionId,
            "user_id": session.userId,
            "country_code": session.countryCode,
        }
    except ApiError as e:
        raise _sanitized_http_error(
            "TIDAL session validation", e, 401, "TIDAL session invalid"
        ) from e
    except Exception as e:
        raise _sanitized_http_error(
            "TIDAL session check", e, 500, "TIDAL session check failed"
        ) from e


# ── Search ──────────────────────────────────────────────────────────


@app.post("/search")
async def search(
    req: SearchRequest,
    creds: AdminCredentials = Depends(require_admin_credentials),
):
    """Search using bearer-header auth or the one-release query fallback."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)
    try:
        results = await asyncio.to_thread(api.get_search, req.query)
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
        status_code = e.status if hasattr(e, "status") else 500
        raise _sanitized_http_error("TIDAL search", e, status_code, "TIDAL search failed") from e


# ── Download ────────────────────────────────────────────────────────

_ALBUM_PAGE_HARD_CAP = 1000


def _get_album_tracks(api: TidalAPI, album_id: int) -> list[Any]:
    """Fetch downloadable album tracks with bounded offset pagination."""
    assert album_id is not None  # noqa: S101 -- internal typed invariant before paginated API calls

    tracks = []
    offset = 0
    page_size = 100
    for _ in range(_ALBUM_PAGE_HARD_CAP):
        items = api.get_album_items(album_id, limit=page_size, offset=offset)
        page = list(getattr(items, "items", None) or [])
        for album_item in page:
            if hasattr(album_item, "item") and hasattr(album_item.item, "isrc"):
                tracks.append(album_item.item)
        if not page:
            break
        offset += len(page)
        total = getattr(items, "totalNumberOfItems", 0) or 0
        if offset >= total:
            break
    return tracks


def _get_album_with_tracks(api: TidalAPI, album_id: int) -> tuple[Any, list[Any]]:
    """Fetch album metadata and its paginated tracks synchronously."""
    album = api.get_album(album_id)
    tracks = _get_album_tracks(api, album_id)
    return album, tracks


async def _download_album_tracks(
    api: TidalAPI,
    tracks: list[Any],
    req: DownloadAlbumRequest,
) -> tuple[list[dict], list[dict]]:
    """Download album tracks sequentially and return successes and failures."""
    results = []
    errors = []
    for index, track in enumerate(tracks):
        if index > 0:
            delay = env_float("TIDAL_TRACK_DELAY", "3")
            log.debug(
                "Rate limit: waiting %ss before track %s/%s",
                delay,
                index + 1,
                len(tracks),
            )
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
            log.error("Failed to download track %s (%s): %s", track.id, track.title, e)
            errors.append(
                {
                    "track_id": track.id,
                    "title": track.title,
                    "error": "Download failed",
                }
            )
    return results, errors


@app.post("/download/track")
async def download_track(
    req: DownloadTrackRequest,
    creds: AdminCredentials = Depends(require_admin_credentials),
):
    """Download using bearer-header auth or the one-release query fallback."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)

    try:
        return await asyncio.to_thread(
            _download_track_sync,
            api=api,
            track_id=req.track_id,
            quality=req.quality,
            output_template=req.output_template,
            dest_base=MUSIC_PATH,
        )
    except ApiError as e:
        raise _sanitized_http_error(
            f"TIDAL API download for track {req.track_id}",
            e,
            400,
            "TIDAL API error",
        ) from e
    except Exception as e:
        raise _sanitized_http_error(
            f"download for track {req.track_id}", e, 500, "Download failed"
        ) from e


@app.post("/download/album")
async def download_album(
    req: DownloadAlbumRequest,
    creds: AdminCredentials = Depends(require_admin_credentials),
):
    """Download using bearer-header auth or the one-release query fallback."""
    api = _build_api(creds.access_token, creds.user_id, creds.country_code)
    try:
        album, tracks = await asyncio.to_thread(_get_album_with_tracks, api, req.album_id)
        results, errors = await _download_album_tracks(api, tracks, req)
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
        raise _sanitized_http_error(
            f"TIDAL API download for album {req.album_id}",
            e,
            400,
            "TIDAL API error",
        ) from e
    except Exception as e:
        raise _sanitized_http_error(
            f"download for album {req.album_id}", e, 500, "Download failed"
        ) from e


# ════════════════════════════════════════════════════════════════════
# Per-user streaming routes
# ════════════════════════════════════════════════════════════════════


def _store_user_session(
    soundspan_user_id: str,
    api: TidalAPI,
    access_token: str,
    refresh_token: str,
    tidal_user_id: str,
    country_code: str,
) -> None:
    """Store a verified per-user API and invalidate stale browse sessions."""
    _user_apis[soundspan_user_id] = api
    with _user_auth_state_lock:
        _user_auth_state[soundspan_user_id] = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "tidal_user_id": tidal_user_id,
            "country_code": country_code,
        }
    with _browse_sessions_lock:
        for key in [key for key in _browse_sessions if key.startswith(f"{soundspan_user_id}:")]:
            _browse_sessions.pop(key, None)


async def _refresh_and_restore_user(
    req: UserAuthRestoreRequest,
    soundspan_user_id: str,
) -> dict:
    """Refresh expired TIDAL credentials and restore the per-user session."""
    auth_api = AuthAPI()
    auth_response = await asyncio.to_thread(auth_api.refresh_token, req.refresh_token)
    new_token = auth_response.access_token
    new_user_id = str(auth_response.user.userId)
    new_country = auth_response.user.countryCode
    api = _build_api(new_token, new_user_id, new_country)
    await asyncio.to_thread(api.get_session)
    _store_user_session(
        soundspan_user_id,
        api,
        new_token,
        req.refresh_token,
        new_user_id,
        new_country,
    )
    log.info("Refreshed and restored TIDAL session for user %s", soundspan_user_id)
    return {
        "success": True,
        "refreshed": True,
        "access_token": new_token,
        "user_id": new_user_id,
        "country_code": new_country,
    }


@app.get("/user/auth/status")
async def user_auth_status(user_id: str = Query(...)):
    """Check if a user has an active TIDAL session."""
    has_session = user_id in _user_apis
    return {"authenticated": has_session, "user_id": user_id}


@app.post("/user/auth/restore")
async def user_auth_restore(req: UserAuthRestoreRequest, user_id: str = Query(...)):
    """Restore a user's credentials, refreshing an expired token if needed."""
    try:
        api = _build_api(req.access_token, req.user_id, req.country_code)
        await asyncio.to_thread(api.get_session)
        _store_user_session(
            user_id,
            api,
            req.access_token,
            req.refresh_token,
            req.user_id,
            req.country_code,
        )
        log.info(f"Restored TIDAL session for user {user_id} (tidal_user={req.user_id})")
        return {
            "success": True,
            "user_id": req.user_id,
            "country_code": req.country_code,
        }
    except ApiError as e:
        log.warning(f"TIDAL session expired for user {user_id}, attempting refresh: {e}")
        try:
            return await _refresh_and_restore_user(req, user_id)
        except Exception as refresh_err:
            log.error(f"Token refresh also failed for user {user_id}: {refresh_err}")
            raise HTTPException(
                status_code=401,
                detail="Invalid TIDAL credentials and refresh failed",
            ) from refresh_err
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL session restore for user {user_id}",
            e,
            500,
            "Failed to restore TIDAL session",
        ) from e


@app.post("/user/auth/clear")
async def user_auth_clear(user_id: str = Query(...)):
    """Clear a user's TIDAL session."""
    async with _get_user_lock(user_id):
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
        raise _sanitized_http_error(
            "TIDAL user search",
            e,
            getattr(e, "status", 500),
            "TIDAL search failed",
        ) from e


@app.post("/user/search/batch")
async def user_search_batch(
    queries: list[BatchSearchQuery],
    user_id: str = Query(...),
):
    """
    Batch search — run multiple search queries in one request.
    Used for gap-fill matching (find streaming versions of unowned tracks).
    """
    if len(queries) > _BATCH_SEARCH_MAX_QUERIES:
        raise HTTPException(
            status_code=422,
            detail=f"Batch search accepts at most {_BATCH_SEARCH_MAX_QUERIES} queries",
        )

    semaphore = asyncio.Semaphore(_BATCH_SEARCH_CONCURRENCY)

    async def _run_one(q: BatchSearchQuery) -> dict:
        try:
            async with semaphore:
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
        raise _sanitized_http_error(
            f"stream info for track {track_id}",
            e,
            500,
            "Failed to resolve stream info",
        ) from e


@app.get("/user/stream/{track_id}")
async def user_stream_proxy(
    track_id: int,
    user_id: str = Query(...),
    quality: str = "HIGH",
    request: Request = None,  # type: ignore[assignment]  # FastAPI injects Request despite the sentinel default
):
    """
    Proxy the audio stream from TIDAL. The Node.js backend pipes this
    to the frontend player. Stream URLs are IP-locked to the server,
    so we must proxy.
    """
    normalized_quality = _normalize_stream_quality(quality)

    # Resolve stream info (may come from cache)
    stream_info = await _run_user_api_call(
        user_id,
        lambda _current_api: _get_stream_url_sync(user_id, track_id, normalized_quality),
        operation=f"stream URL fetch for track {track_id}",
    )

    is_dash = stream_info.get("is_dash", False)
    all_urls: list[str] = stream_info.get("urls", [])
    content_type = stream_info.get("content_type", "audio/mp4")

    if not all_urls:
        raise HTTPException(status_code=404, detail="No stream URL available")

    # Build headers for upstream request
    headers = {}
    range_header = request.headers.get("range") if request else None
    if range_header and not is_dash:
        headers["Range"] = range_header

    if is_dash:
        # ── DASH segmented delivery (HI_RES_LOSSLESS) ────────────────
        # TIDAL delivers hi-res lossless as fMP4 DASH segments.
        # Concatenate all segments (init + media) into a single stream
        # so the frontend receives a playable fMP4 byte stream.
        log.info(
            "Proxying DASH segmented stream for track %s (%d segments)",
            track_id,
            len(all_urls),
        )

        async def _open_dash_stream_start():
            """Open the first DASH segment and retry once after cache refresh on 401/403."""
            dash_urls = list(all_urls)
            resolved_content_type = content_type
            for attempt in range(2):
                if not dash_urls:
                    raise HTTPException(status_code=404, detail="No stream URL available")

                client = build_stream_proxy_client()
                try:
                    first_response = await client.send(
                        client.build_request("GET", dash_urls[0]),
                        stream=True,
                    )
                except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
                    await client.aclose()
                    log.error(
                        "DASH first segment request failed for track %s: %s",
                        track_id,
                        e,
                    )
                    raise HTTPException(
                        status_code=502,
                        detail="Failed to fetch TIDAL DASH stream",
                    ) from e

                if attempt == 0 and first_response.status_code in (401, 403):
                    log.warning(
                        "Cached TIDAL DASH URL rejected for track %s (status=%s); refreshing once",
                        track_id,
                        first_response.status_code,
                    )
                    await first_response.aclose()
                    await client.aclose()
                    _clear_stream_cache(
                        user_id,
                        track_id=track_id,
                        quality=normalized_quality,
                    )
                    refreshed = await _run_user_api_call(
                        user_id,
                        lambda _current_api: _get_stream_url_sync(
                            user_id, track_id, normalized_quality
                        ),
                        operation=f"stream URL refresh for track {track_id}",
                    )
                    dash_urls = list(refreshed.get("urls", []))
                    resolved_content_type = refreshed.get("content_type", resolved_content_type)
                    continue

                if first_response.status_code >= 400:
                    log.error(
                        "DASH first segment returned HTTP %s for track %s",
                        first_response.status_code,
                        track_id,
                    )
                    await first_response.aclose()
                    await client.aclose()
                    raise HTTPException(
                        status_code=502,
                        detail="Failed to fetch TIDAL DASH stream segment",
                    )

                return client, first_response, dash_urls, resolved_content_type

            raise HTTPException(status_code=502, detail="Unable to refresh TIDAL stream URL")

        (
            client,
            first_segment_response,
            dash_urls,
            dash_content_type,
        ) = await _open_dash_stream_start()

        async def dash_concat_stream():
            """Fetch each DASH segment sequentially and yield bytes."""
            try:
                try:
                    async for chunk in first_segment_response.aiter_bytes(chunk_size=65536):
                        yield chunk
                except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
                    log.warning(
                        "DASH first segment stream failed for track %s: %s",
                        track_id,
                        e,
                    )
                    return
                await first_segment_response.aclose()

                for idx, segment_url in enumerate(dash_urls[1:], start=1):
                    seg_resp = None
                    try:
                        seg_resp = await client.send(
                            client.build_request("GET", segment_url),
                            stream=True,
                        )
                        if seg_resp.status_code >= 400:
                            log.error(
                                "DASH segment %d/%d returned HTTP %s for track %s",
                                idx,
                                len(dash_urls),
                                seg_resp.status_code,
                                track_id,
                            )
                            return
                        async for chunk in seg_resp.aiter_bytes(chunk_size=65536):
                            yield chunk
                    except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as e:
                        log.warning(
                            "DASH segment %d/%d fetch failed for track %s: %s",
                            idx,
                            len(dash_urls),
                            track_id,
                            e,
                        )
                        return
                    finally:
                        if seg_resp is not None:
                            await seg_resp.aclose()
            finally:
                await first_segment_response.aclose()
                await client.aclose()

        return StreamingResponse(
            dash_concat_stream(),
            media_type=dash_content_type,
            headers={
                "Cache-Control": "no-cache",
            },
        )

    # ── BTS single-URL delivery (LOW/HIGH/LOSSLESS) ──────────────
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
                refreshed = await _run_user_api_call(
                    user_id,
                    lambda _current_api: _get_stream_url_sync(
                        user_id, track_id, normalized_quality
                    ),
                    operation=f"stream URL refresh for track {track_id}",
                )
                stream_url = refreshed.get("url", "")
            else:
                stream_url = stream_info.get("url", "")

            if not stream_url:
                raise HTTPException(status_code=404, detail="No stream URL available")

            client = build_stream_proxy_client()
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

            return client, upstream

        raise HTTPException(status_code=502, detail="Unable to refresh TIDAL stream URL")

    client, upstream = await _open_upstream_stream()

    response_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
    }
    upstream_content_type = upstream.headers.get("content-type") or content_type
    if upstream_content_type:
        response_headers["Content-Type"] = upstream_content_type
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
        raise _sanitized_http_error(
            f"TIDAL track lookup {track_id}",
            e,
            getattr(e, "status", 500),
            "TIDAL track lookup failed",
        ) from e


# ── Browse (tidalapi) ──────────────────────────────────────────────


@app.get("/user/browse/home")
async def user_browse_home(
    user_id: str = Query(...), limit: int = Query(6), quality: str | None = Query(None)
):
    """Get personalized TIDAL home page shelves."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.home)
        shelves = _serialize_page(page)
        return {"shelves": shelves[:limit]}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL browse home for user {user_id}",
            e,
            500,
            "Failed to load TIDAL home",
        ) from e


@app.get("/user/browse/explore")
async def user_browse_explore(
    user_id: str = Query(...), limit: int = Query(6), quality: str | None = Query(None)
):
    """Get TIDAL editorial/new releases shelves."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.explore)
        shelves = _serialize_page(page)
        return {"shelves": shelves[:limit]}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL browse explore for user {user_id}",
            e,
            500,
            "Failed to load TIDAL explore",
        ) from e


@app.get("/user/browse/genres")
async def user_browse_genres(user_id: str = Query(...), quality: str | None = Query(None)):
    """Get TIDAL genre categories."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.genres)
        genres = _extract_page_links(page)
        return {"genres": genres}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL browse genres for user {user_id}",
            e,
            500,
            "Failed to load TIDAL genres",
        ) from e


@app.get("/user/browse/moods")
async def user_browse_moods(user_id: str = Query(...), quality: str | None = Query(None)):
    """Get TIDAL mood categories."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.moods)
        moods = _extract_page_links(page)
        return {"moods": moods}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL browse moods for user {user_id}",
            e,
            500,
            "Failed to load TIDAL moods",
        ) from e


@app.get("/user/browse/mixes")
async def user_browse_mixes(user_id: str = Query(...), quality: str | None = Query(None)):
    """Get personal TIDAL mixes (daily discovery, etc.)."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(session.mixes)
        mixes = []
        for cat in page.categories or []:
            for item in getattr(cat, "items", None) or []:
                mixes.append(_serialize_mix(item))
        return {"mixes": mixes}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL browse mixes for user {user_id}",
            e,
            500,
            "Failed to load TIDAL mixes",
        ) from e


@app.get("/user/browse/genre-playlists")
async def user_browse_genre_playlists(
    user_id: str = Query(...),
    path: str = Query(...),
    quality: str | None = Query(None),
):
    """Get playlists for a specific genre/mood path."""
    # Sanitize path to prevent directory traversal / injection
    import re

    if not re.match(r"^[a-zA-Z0-9_\-/]+$", path) or ".." in path:
        raise HTTPException(status_code=400, detail="Invalid genre path")
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        page = await asyncio.to_thread(lambda: session.page.get(f"pages/{path}"))
        shelves = _serialize_page(page)
        # Flatten all shelf contents into a single playlist list
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
        return {"playlists": playlists}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"TIDAL browse genre playlists for user {user_id}",
            e,
            500,
            "Failed to load TIDAL genre playlists",
        ) from e


@app.get("/browse/playlist/{playlist_uuid}")
async def browse_playlist(
    playlist_uuid: str,
    limit: int = Query(100),
    quality: str | None = Query(None),
):
    """Get public TIDAL playlist details with tracks."""
    try:
        session = _build_public_browse_session(quality)
        playlist = await asyncio.to_thread(session.playlist, playlist_uuid)
        result = await asyncio.to_thread(_serialize_playlist_detail, playlist)
        if limit and len(result.get("tracks", [])) > limit:
            result["tracks"] = result["tracks"][:limit]
        return result
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"TIDAL public browse playlist {playlist_uuid} failed: {e}")
        if _is_playlist_not_found_error(e):
            raise HTTPException(status_code=404, detail="Playlist not found")
        raise HTTPException(status_code=502, detail="Failed to load playlist")


@app.get("/user/browse/playlist/{playlist_uuid}")
async def user_browse_playlist(
    playlist_uuid: str,
    user_id: str = Query(...),
    limit: int = Query(100),
    quality: str | None = Query(None),
):
    """Get TIDAL playlist details with tracks."""
    try:
        session = await asyncio.to_thread(_build_browse_session, user_id, quality)
        playlist = await asyncio.to_thread(session.playlist, playlist_uuid)
        result = await asyncio.to_thread(_serialize_playlist_detail, playlist)
        if limit and len(result.get("tracks", [])) > limit:
            result["tracks"] = result["tracks"][:limit]
        return result
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"TIDAL browse playlist {playlist_uuid} failed for user {user_id}: {e}")
        if _is_playlist_not_found_error(e):
            raise HTTPException(status_code=404, detail="Playlist not found")
        raise HTTPException(status_code=502, detail="Failed to load playlist")


@app.get("/user/browse/mix/{mix_id}")
async def user_browse_mix(
    mix_id: str,
    user_id: str = Query(...),
    quality: str | None = Query(None),
):
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
            "tracks": [_serialize_track(t) for t in (tracks or [])],
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"TIDAL browse mix {mix_id} failed for user {user_id}: {e}")
        raise HTTPException(status_code=404, detail="Mix not found")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8585)  # noqa: S104 -- container service must accept pod traffic
