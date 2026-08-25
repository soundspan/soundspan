"""Authentication routes and per-user TIDAL session state."""

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from fastapi import Header, HTTPException, Query
from tidal_cache import _clear_stream_cache, _normalize_stream_quality
from tidal_models import (
    AdminCredentials,
    AuthTokenRequest,
    RefreshRequest,
    SessionCheckPayload,
    UserAuthRestoreRequest,
)
from tidal_runtime import (
    JsonObject,
    TidalAPIProtocol,
    _build_api,
    _sanitized_http_error,
    app,
    log,
)
from tidalapi.media import Quality
from tidalapi.session import Config, Session
from tiddl.core.api import ApiError
from tiddl.core.auth import AuthAPI, AuthClientError

_user_apis: dict[str, TidalAPIProtocol] = {}
_user_api_locks: dict[str, asyncio.Lock] = {}
_user_auth_state: dict[str, dict[str, str]] = {}
_user_auth_state_lock = threading.Lock()

TIDDL_TO_TIDALAPI_QUALITY: dict[str, Quality] = {
    "LOW": Quality.low_96k,
    "HIGH": Quality.low_320k,
    "LOSSLESS": Quality.high_lossless,
    "HI_RES_LOSSLESS": Quality.hi_res_lossless,
}
TIDALAPI_DEFAULT_QUALITY = Quality.high_lossless

_browse_sessions: dict[str, Session] = {}
_browse_sessions_lock = threading.Lock()
_BROWSE_SESSION_MAX = 50
_public_browse_sessions: dict[str, Session] = {}
_public_browse_sessions_lock = threading.Lock()
_PUBLIC_BROWSE_SESSION_MAX = 8


def _build_browse_session(user_id: str, quality: str | None = None) -> Session:
    """Get or create an authenticated tidalapi browse session."""
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

    session = Session(Config(quality=api_quality))
    session.load_oauth_session(
        token_type="Bearer",  # noqa: S106 -- OAuth token scheme, not a credential
        access_token=creds_snapshot["access_token"],
        refresh_token=creds_snapshot.get("refresh_token"),
        expiry_time=None,
    )
    with _browse_sessions_lock:
        while len(_browse_sessions) >= _BROWSE_SESSION_MAX:
            _browse_sessions.pop(next(iter(_browse_sessions)), None)
        _browse_sessions[cache_key] = session
    return session


def _build_public_browse_session(quality: str | None = None) -> Session:
    """Get or create an unauthenticated tidalapi browse session."""
    normalized = _normalize_stream_quality(quality) if quality else None
    api_quality = TIDDL_TO_TIDALAPI_QUALITY.get(normalized or "", TIDALAPI_DEFAULT_QUALITY)
    cache_key = api_quality.value
    with _public_browse_sessions_lock:
        cached = _public_browse_sessions.get(cache_key)
    if cached is not None:
        return cached

    session = Session(Config(quality=api_quality))
    with _public_browse_sessions_lock:
        while len(_public_browse_sessions) >= _PUBLIC_BROWSE_SESSION_MAX:
            _public_browse_sessions.pop(next(iter(_public_browse_sessions)), None)
        _public_browse_sessions[cache_key] = session
    return session


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


def _get_user_api(user_id: str) -> TidalAPIProtocol:
    """Get or raise for a per-user TidalAPI instance."""
    api = _user_apis.get(user_id)
    if not api:
        raise HTTPException(
            status_code=401,
            detail=f"No TIDAL session for user {user_id}. Restore credentials first.",
        )
    return api


def _invalidate_browse_sessions(user_id: str) -> None:
    """Remove browse sessions tied to one soundspan user."""
    with _browse_sessions_lock:
        for key in [key for key in _browse_sessions if key.startswith(f"{user_id}:")]:
            _browse_sessions.pop(key, None)


def _invalidate_user_api(user_id: str) -> None:
    """Remove a user's API instance and all credential-bound caches."""
    _user_apis.pop(user_id, None)
    with _user_auth_state_lock:
        _user_auth_state.pop(user_id, None)
    _invalidate_browse_sessions(user_id)
    _clear_stream_cache(user_id)


def _get_user_lock(user_id: str) -> asyncio.Lock:
    """Return the event-loop lock that serializes one user's auth changes."""
    lock = _user_api_locks.get(user_id)
    if lock is None:
        lock = asyncio.Lock()
        _user_api_locks[user_id] = lock
    return lock


def _is_token_expired_error(error: Exception) -> bool:
    """Identify TIDAL token-expiry errors."""
    if not isinstance(error, ApiError):
        return False
    status = getattr(error, "status", None)
    sub_status = getattr(error, "sub_status", None)
    if sub_status is None:
        sub_status = getattr(error, "subStatus", None)
    message = str(error).lower()
    return status == 401 and (
        str(sub_status) == "11003" or "token has expired" in message or "expired on time" in message
    )


def _commit_refreshed_session(
    user_id: str,
    creds: dict[str, str],
    refreshed_api: TidalAPIProtocol,
    access_token: str,
    tidal_user_id: str,
    country_code: str,
) -> TidalAPIProtocol | None:
    """Commit a refresh only while its captured credentials remain current."""
    with _user_auth_state_lock:
        if _user_auth_state.get(user_id) is not creds:
            return _user_apis.get(user_id)
        creds["access_token"] = access_token
        creds["tidal_user_id"] = tidal_user_id
        creds["country_code"] = country_code
        _user_apis[user_id] = refreshed_api
        return refreshed_api


async def _refresh_user_api(user_id: str) -> TidalAPIProtocol:
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
            except ApiError as verify_error:
                if not _is_token_expired_error(verify_error):
                    raise

        try:
            auth_api = AuthAPI()
            auth_response = await asyncio.to_thread(auth_api.refresh_token, creds["refresh_token"])
            new_access_token = auth_response.access_token
            new_user_id = str(auth_response.user.userId)
            new_country = auth_response.user.countryCode
            refreshed_api = _build_api(new_access_token, new_user_id, new_country)
            await asyncio.to_thread(refreshed_api.get_session)
        except Exception as refresh_error:
            log.error(f"TIDAL token refresh failed for user {user_id}: {refresh_error}")
            _invalidate_user_api(user_id)
            raise HTTPException(
                status_code=401,
                detail="TIDAL session expired and token refresh failed",
            ) from refresh_error

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
        _clear_stream_cache(user_id)
        _invalidate_browse_sessions(user_id)
        log.info(f"Refreshed TIDAL session for user {user_id}")
        return refreshed_api


async def _run_user_api_call(
    user_id: str,
    func: Callable[[TidalAPIProtocol], Any],
    operation: str,
) -> Any:
    """Run a user-scoped API call and retry once after token refresh."""
    api = _get_user_api(user_id)
    try:
        return await asyncio.to_thread(func, api)
    except ApiError as api_error:
        if not _is_token_expired_error(api_error):
            raise
        log.warning(
            f"TIDAL token expired during {operation} for user {user_id}; refreshing and retrying"
        )
        refreshed_api = await _refresh_user_api(user_id)
        return await asyncio.to_thread(func, refreshed_api)


def _store_user_session(
    soundspan_user_id: str,
    api: TidalAPIProtocol,
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
    _invalidate_browse_sessions(soundspan_user_id)


async def _refresh_and_restore_user(
    req: UserAuthRestoreRequest,
    soundspan_user_id: str,
) -> JsonObject:
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


@app.post("/auth/device")
async def auth_device() -> JsonObject:
    """Initiate device-code OAuth authorization."""
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
    except Exception as error:
        raise _sanitized_http_error(
            "device auth",
            error,
            500,
            "Failed to initiate TIDAL device authorization",
        ) from error


@app.post("/auth/token")
async def auth_token(req: AuthTokenRequest) -> JsonObject:
    """Poll for a token after device authorization."""
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
    except AuthClientError as error:
        raise HTTPException(
            status_code=428,
            detail={
                "error": error.error,
                "sub_status": error.sub_status,
                "error_description": error.error_description,
            },
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            "TIDAL token exchange", error, 500, "TIDAL token exchange failed"
        ) from error


@app.post("/auth/refresh")
async def auth_refresh(req: RefreshRequest) -> JsonObject:
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
    except AuthClientError as error:
        raise HTTPException(
            status_code=401,
            detail={
                "error": error.error,
                "sub_status": error.sub_status,
                "error_description": error.error_description,
            },
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            "TIDAL token refresh", error, 500, "TIDAL token refresh failed"
        ) from error


@app.post("/auth/session")
async def auth_session(tokens: SessionCheckPayload) -> JsonObject:
    """Verify that stored tokens remain valid."""
    try:
        api = _build_api(tokens.access_token, tokens.user_id, tokens.country_code)
        session = await asyncio.to_thread(api.get_session)
        return {
            "valid": True,
            "session_id": session.sessionId,
            "user_id": session.userId,
            "country_code": session.countryCode,
        }
    except ApiError as error:
        raise _sanitized_http_error(
            "TIDAL session validation", error, 401, "TIDAL session invalid"
        ) from error
    except Exception as error:
        raise _sanitized_http_error(
            "TIDAL session check", error, 500, "TIDAL session check failed"
        ) from error


@app.get("/user/auth/status")
async def user_auth_status(user_id: str = Query(...)) -> JsonObject:
    """Check whether a user has an active TIDAL session."""
    return {"authenticated": user_id in _user_apis, "user_id": user_id}


@app.post("/user/auth/restore")
async def user_auth_restore(req: UserAuthRestoreRequest, user_id: str = Query(...)) -> JsonObject:
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
    except ApiError as error:
        log.warning(f"TIDAL session expired for user {user_id}, attempting refresh: {error}")
        try:
            return await _refresh_and_restore_user(req, user_id)
        except Exception as refresh_error:
            log.error(f"Token refresh also failed for user {user_id}: {refresh_error}")
            raise HTTPException(
                status_code=401,
                detail="Invalid TIDAL credentials and refresh failed",
            ) from refresh_error
    except Exception as error:
        raise _sanitized_http_error(
            f"TIDAL session restore for user {user_id}",
            error,
            500,
            "Failed to restore TIDAL session",
        ) from error


@app.post("/user/auth/clear")
async def user_auth_clear(user_id: str = Query(...)) -> JsonObject:
    """Clear a user's TIDAL session."""
    async with _get_user_lock(user_id):
        _invalidate_user_api(user_id)
    log.info(f"Cleared TIDAL session for user {user_id}")
    return {"success": True}
