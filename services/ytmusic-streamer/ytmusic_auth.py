"""Per-user OAuth credential and device-code HTTP routes."""

import asyncio
import json
from typing import Any, cast

from fastapi import HTTPException, Query, Request
from ytmusic_client import (
    _clear_user_search_fallback,
    _client_creds_file,
    _get_ytmusic,
    _invalidate_ytmusic,
    _oauth_file,
    _unlink_if_exists,
    _write_private_file,
)
from ytmusic_models import DeviceCodePollRequest, DeviceCodeRequest
from ytmusic_runtime import DATA_PATH, JsonObject, _sanitized_http_error, app, log
from ytmusicapi import OAuthCredentials


@app.get("/auth/status")
async def auth_status(user_id: str = Query(...)) -> JsonObject:
    """Check if a specific user has valid OAuth credentials."""
    oauth_path = _oauth_file(user_id)

    if not oauth_path.exists():
        return {"authenticated": False, "reason": "No OAuth credentials found"}

    try:
        _get_ytmusic(user_id)
        return {"authenticated": True}
    except Exception as e:
        log.exception(
            "Stored credentials failed to load for user %s: %s",
            user_id,
            e,
        )
        return {
            "authenticated": False,
            "reason": "Stored credentials failed to load",
        }


@app.post("/auth/restore")
async def auth_restore(req: Request, user_id: str = Query(...)) -> JsonObject:
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

    await asyncio.to_thread(DATA_PATH.mkdir, parents=True, exist_ok=True)
    await asyncio.to_thread(_write_private_file, _oauth_file(user_id), oauth_json)

    # Save client credentials if provided
    client_id = body.get("client_id")
    client_secret = body.get("client_secret")
    if client_id and client_secret:
        creds_path = _client_creds_file(user_id)
        await asyncio.to_thread(
            _write_private_file,
            creds_path,
            json.dumps(
                {
                    "client_id": client_id,
                    "client_secret": client_secret,
                }
            ),
        )

    _invalidate_ytmusic(user_id)
    _clear_user_search_fallback(user_id)
    log.info(f"OAuth credentials restored for user {user_id}")
    return {"status": "ok", "message": "OAuth credentials restored"}


@app.post("/auth/clear")
async def auth_clear(user_id: str = Query(...)) -> JsonObject:
    """Remove stored OAuth credentials for a specific user."""
    _invalidate_ytmusic(user_id)
    _clear_user_search_fallback(user_id)
    oauth_path = _oauth_file(user_id)
    await asyncio.to_thread(_unlink_if_exists, oauth_path)
    creds_path = _client_creds_file(user_id)
    await asyncio.to_thread(_unlink_if_exists, creds_path)
    log.info(f"OAuth credentials cleared for user {user_id}")
    return {"status": "ok", "message": "OAuth credentials removed"}


@app.post("/auth/device-code")
async def auth_device_code(req: DeviceCodeRequest) -> JsonObject:
    """
    Initiate the Google OAuth device code flow.
    Returns a user_code and verification_url for the user to visit.
    """
    try:
        oauth_creds = OAuthCredentials(
            client_id=req.client_id,
            client_secret=req.client_secret,
        )
        code = await asyncio.to_thread(oauth_creds.get_code)
        log.info(f"Device code flow initiated, user_code: {code.get('user_code')}")
        return {
            "device_code": code["device_code"],
            "user_code": code["user_code"],
            "verification_url": code["verification_url"],
            "expires_in": code.get("expires_in", 1800),
            "interval": code.get("interval", 5),
        }
    except Exception as e:
        raise _sanitized_http_error(
            "Device code initiation",
            e,
            500,
            "Failed to initiate device code flow",
        ) from e


@app.post("/auth/device-code/poll")
async def auth_device_code_poll(
    req: DeviceCodePollRequest, user_id: str = Query(...)
) -> JsonObject:
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
        token = cast(
            dict[str, Any], await asyncio.to_thread(oauth_creds.token_from_code, req.device_code)
        )

        # Check if we got an error (authorization_pending, slow_down, etc.)
        if "error" in token:
            error = token["error"]
            if error in ("authorization_pending", "slow_down"):
                return {"status": "pending", "error": error}
            friendly = ERROR_MESSAGES.get(
                error, f"Authorization failed ({error}). Please try again."
            )
            log.error(f"Device code poll error: {error}")
            return {"status": "error", "error": friendly}

        # Success — we have a token. Save it for this user.
        await asyncio.to_thread(DATA_PATH.mkdir, parents=True, exist_ok=True)
        token_json = json.dumps(dict(token), indent=True)
        await asyncio.to_thread(_write_private_file, _oauth_file(user_id), token_json)

        # Save client credentials alongside so _get_ytmusic can use them
        creds_path = _client_creds_file(user_id)
        await asyncio.to_thread(
            _write_private_file,
            creds_path,
            json.dumps(
                {
                    "client_id": req.client_id,
                    "client_secret": req.client_secret,
                }
            ),
        )

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

        raise _sanitized_http_error(
            f"Device code poll for user {user_id}",
            e,
            500,
            "Failed to poll device code",
        ) from e
