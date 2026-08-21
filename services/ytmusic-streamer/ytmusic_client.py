"""YouTube Music client construction, credentials, and auth retry policy."""

import json
import os
import threading
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any, Literal

import requests
from common.sidecar_runtime_utils import validate_user_id
from fastapi import HTTPException
from ytmusic_runtime import DATA_PATH, log
from ytmusicapi import OAuthCredentials, YTMusic

SEARCH_MODE = (os.getenv("YTMUSIC_SEARCH_MODE", "auto") or "auto").strip().lower()
if SEARCH_MODE not in {"tv", "native", "auto"}:
    log.warning(
        "Invalid YTMUSIC_SEARCH_MODE=%r (expected tv|native|auto); defaulting to auto",
        SEARCH_MODE,
    )
    SEARCH_MODE = "auto"

# BCP-47 language code forwarded to all YTMusic() constructors.
YTMUSIC_LANGUAGE = (os.getenv("YTMUSIC_LANGUAGE", "en") or "en").strip()
TV_CLIENT_NAME = "TVHTML5"
TV_CLIENT_VERSION = "7.20250101.00.00"
# Keep transport work inside the sidecar's default 30-second browse and shutdown budgets.
YTMUSIC_REQUEST_TIMEOUT_SECONDS = 25.0

# Per-user authenticated clients are used for user-private operations.
_ytmusic_instances: dict[str, YTMusic] = {}
_ytmusic_instances_lock = threading.Lock()
_ytmusic_auto_tv_fallback_users: set[str] = set()
# Public unauthenticated clients are used for search and matching.
_public_ytmusic_instances: dict[Literal["tv", "native"], YTMusic] = {}
_public_ytmusic_lock = threading.Lock()


def _build_ytmusic_requests_session() -> requests.Session:
    """Create a pooled ytmusicapi transport with a bounded request timeout."""
    session = requests.Session()
    session.request = partial(  # type: ignore[method-assign]
        session.request,
        timeout=YTMUSIC_REQUEST_TIMEOUT_SECONDS,
    )
    return session


def _write_private_file(path: Path, content: str) -> None:
    """Write credentials with owner-only permissions, tightening existing files."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(content)
    os.chmod(path, 0o600)


def _unlink_if_exists(path: Path) -> None:
    """Remove a credential file if present (blocking; call via asyncio.to_thread)."""
    if path.exists():
        path.unlink()


def _oauth_file(user_id: str) -> Path:
    """Return the OAuth JSON path for a given user."""
    validate_user_id(user_id)
    return DATA_PATH / f"oauth_{user_id}.json"


def _client_creds_file(user_id: str) -> Path:
    """Return the OAuth client-credentials JSON path for a given user."""
    validate_user_id(user_id)
    return DATA_PATH / f"client_creds_{user_id}.json"


def _clear_user_search_fallback(user_id: str) -> None:
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


def _apply_tv_client_context(yt: YTMusic) -> None:
    """Apply TVHTML5 client context required by the custom TV search parser."""
    yt.context["context"]["client"]["clientName"] = TV_CLIENT_NAME
    yt.context["context"]["client"]["clientVersion"] = TV_CLIENT_VERSION
    yt.params = "?alt=json"  # TV client must NOT send the API key


def _get_public_ytmusic(strategy: Literal["tv", "native"]) -> YTMusic:
    """
    Get or create an unauthenticated YTMusic instance for public search.
    """
    with _public_ytmusic_lock:
        existing = _public_ytmusic_instances.get(strategy)
    if existing:
        return existing

    yt = YTMusic(
        language=YTMUSIC_LANGUAGE,
        requests_session=_build_ytmusic_requests_session(),
    )
    if strategy == "tv":
        _apply_tv_client_context(yt)
    with _public_ytmusic_lock:
        _public_ytmusic_instances[strategy] = yt
    return yt


def _invalidate_public_ytmusic(strategy: Literal["tv", "native"]) -> None:
    """Force re-creation of a public search client on next use."""
    with _public_ytmusic_lock:
        _public_ytmusic_instances.pop(strategy, None)


def _get_ytmusic(user_id: str) -> YTMusic:
    """Get or create an authenticated YTMusic instance for a specific user."""
    with _ytmusic_instances_lock:
        existing = _ytmusic_instances.get(user_id)
    if existing:
        return existing

    oauth_path = _oauth_file(user_id)
    if oauth_path.exists():
        try:
            # Read the oauth JSON to check if it has custom client credentials
            json.loads(oauth_path.read_text())

            # Build OAuthCredentials if client_id/client_secret are stored alongside
            request_session = _build_ytmusic_requests_session()
            oauth_creds = None
            creds_path = _client_creds_file(user_id)
            if creds_path.exists():
                creds_data = json.loads(creds_path.read_text())
                oauth_creds = OAuthCredentials(
                    client_id=creds_data["client_id"],
                    client_secret=creds_data["client_secret"],
                    session=request_session,
                )

            if oauth_creds:
                yt = YTMusic(
                    str(oauth_path),
                    oauth_credentials=oauth_creds,
                    language=YTMUSIC_LANGUAGE,
                    requests_session=request_session,
                )
            else:
                yt = YTMusic(
                    str(oauth_path),
                    language=YTMUSIC_LANGUAGE,
                    requests_session=request_session,
                )

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

            with _ytmusic_instances_lock:
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


def _invalidate_ytmusic(user_id: str) -> None:
    """Force re-creation of a user's YTMusic instance on next use."""
    with _ytmusic_instances_lock:
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
