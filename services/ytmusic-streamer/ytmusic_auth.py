"""Per-user OAuth credential and device-code HTTP routes."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
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

CREDENTIAL_MUTATION_SETTLEMENT_TIMEOUT_SECONDS = 30.0
_CREDENTIAL_MUTATION_CANCELLATION_LIMIT = 64
_CREDENTIAL_MUTATION_ERROR_DETAIL = "Credential update temporarily unavailable"
_retained_credential_mutation_tasks: set[asyncio.Task[None]] = set()
_retained_credential_mutation_contexts: dict[asyncio.Task[None], tuple[str, int]] = {}
_late_credential_mutation_tasks: set[asyncio.Task[None]] = set()


class _CredentialMutationSettlementTimeout(TimeoutError):
    """Identify a retained mutation task that did not settle within its bound."""

    def __init__(self, task: asyncio.Task[None]) -> None:
        super().__init__(
            "Credential mutation did not settle within "
            f"{CREDENTIAL_MUTATION_SETTLEMENT_TIMEOUT_SECONDS:g} seconds"
        )
        self.task = task


def _invalidate_credential_clients(user_id: str) -> None:
    """Invalidate in-memory clients tied to one credential version."""
    _invalidate_ytmusic(user_id)
    _clear_user_search_fallback(user_id)


def _write_credential_files(
    user_id: str,
    oauth_json: str,
    client_id: str | None,
    client_secret: str | None,
) -> None:
    """Write one complete credential replacement from a worker thread."""
    DATA_PATH.mkdir(parents=True, exist_ok=True)
    _write_private_file(_oauth_file(user_id), oauth_json)
    if client_id and client_secret:
        _write_private_file(
            _client_creds_file(user_id),
            json.dumps({"client_id": client_id, "client_secret": client_secret}),
        )


def _clear_credential_files(user_id: str) -> None:
    """Remove both credential files from one worker thread."""
    _unlink_if_exists(_oauth_file(user_id))
    _unlink_if_exists(_client_creds_file(user_id))


async def _await_credential_filesystem_mutation(
    mutation: Callable[..., None],
    *args: Any,
    user_id: str,
    generation: int,
) -> None:
    """Retain a filesystem mutation task until it settles through cancellation."""
    task = asyncio.create_task(asyncio.to_thread(mutation, *args))
    _retain_credential_mutation_task(task, (user_id, generation))
    await _await_retained_task(task, "Credential filesystem mutation failed during cancellation")


def _consume_retained_credential_mutation_task(task: asyncio.Task[None]) -> None:
    """Release and observe one retained task after late settlement."""
    _retained_credential_mutation_tasks.discard(task)
    context = _retained_credential_mutation_contexts.pop(task, None)
    settled_late = task in _late_credential_mutation_tasks
    _late_credential_mutation_tasks.discard(task)
    if task.cancelled():
        return
    error = task.exception()
    if not settled_late or context is None:
        return
    user_id, generation = context
    if error is None:
        log.debug(
            "Credential filesystem mutation for user %s generation %d settled after timeout",
            user_id,
            generation,
        )
        return
    log.warning(
        "Credential filesystem mutation for user %s generation %d failed after timeout: %s",
        user_id,
        generation,
        error,
    )


def _retain_credential_mutation_task(
    task: asyncio.Task[None], context: tuple[str, int] | None = None
) -> None:
    """Keep one mutation task alive and guarantee exception retrieval."""
    _retained_credential_mutation_tasks.add(task)
    if context is not None:
        _retained_credential_mutation_contexts[task] = context
    task.add_done_callback(_consume_retained_credential_mutation_task)


def _retained_task_settlement_timeout(
    task: asyncio.Task[None],
) -> _CredentialMutationSettlementTimeout:
    """Mark one retained task as abandoned before reporting its deadline."""
    _late_credential_mutation_tasks.add(task)
    return _CredentialMutationSettlementTimeout(task)


async def _wait_for_retained_task(
    task: asyncio.Task[None],
) -> asyncio.CancelledError | None:
    """Wait through bounded cancellation until settlement or the deadline."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + CREDENTIAL_MUTATION_SETTLEMENT_TIMEOUT_SECONDS
    cancellation: asyncio.CancelledError | None = None
    for _ in range(_CREDENTIAL_MUTATION_CANCELLATION_LIMIT):
        if task.done():
            break
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise _retained_task_settlement_timeout(task)
        try:
            completed, _pending = await asyncio.wait((task,), timeout=remaining)
        except asyncio.CancelledError as error:
            if cancellation is None:
                cancellation = error
        else:
            if task not in completed:
                raise _retained_task_settlement_timeout(task)
            break
    if not task.done():
        raise _retained_task_settlement_timeout(task)
    return cancellation


async def _await_retained_task(task: asyncio.Task[None], cancellation_failure: str) -> None:
    """Supervise one pre-retained request task through cancellation."""
    cancellation = await _wait_for_retained_task(task)
    try:
        task.result()
    except Exception:
        if cancellation is None:
            raise
        log.exception(cancellation_failure)
    if cancellation is not None:
        raise cancellation


def _settle_abandoned_mutation_after_task(
    task: asyncio.Task[None], user_id: str, token: int
) -> None:
    """Run the full credential finalizer after an indeterminate worker settles."""

    def finalize_completed_mutation(_completed_task: asyncio.Task[None]) -> None:
        finalizer = asyncio.create_task(_finalize_credential_mutation(user_id, token))
        _retain_credential_mutation_task(finalizer)

    task.add_done_callback(finalize_completed_mutation)


async def _finalize_credential_mutation(user_id: str, token: int) -> None:
    """Invalidate all credential caches and finish one mutation fence."""
    from ytmusic_library import finish_library_credential_mutation

    try:
        _invalidate_credential_clients(user_id)
    finally:
        await finish_library_credential_mutation(user_id, token)


@asynccontextmanager
async def _credential_mutation(user_id: str) -> AsyncIterator[int]:
    """Fence a credential mutation and sweep all old in-memory state."""
    from ytmusic_library import begin_library_credential_mutation

    token = await begin_library_credential_mutation(user_id)
    indeterminate = False
    try:
        _invalidate_credential_clients(user_id)
        yield token
    except _CredentialMutationSettlementTimeout as error:
        indeterminate = True
        _settle_abandoned_mutation_after_task(error.task, user_id, token)
        raise _sanitized_http_error(
            f"Credential filesystem mutation for user {user_id}",
            error,
            503,
            _CREDENTIAL_MUTATION_ERROR_DETAIL,
        ) from error
    finally:
        if indeterminate:
            _invalidate_credential_clients(user_id)
        else:
            finalizer = asyncio.create_task(_finalize_credential_mutation(user_id, token))
            _retain_credential_mutation_task(finalizer)
            try:
                await _await_retained_task(
                    finalizer,
                    "Credential mutation final sweep failed during cancellation",
                )
            except _CredentialMutationSettlementTimeout as error:
                raise _sanitized_http_error(
                    f"Credential mutation final sweep for user {user_id}",
                    error,
                    503,
                    _CREDENTIAL_MUTATION_ERROR_DETAIL,
                ) from error


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

    client_id = body.get("client_id")
    client_secret = body.get("client_secret")
    async with _credential_mutation(user_id) as generation:
        await _await_credential_filesystem_mutation(
            _write_credential_files,
            user_id,
            oauth_json,
            client_id,
            client_secret,
            user_id=user_id,
            generation=generation,
        )

    log.info(f"OAuth credentials restored for user {user_id}")
    return {"status": "ok", "message": "OAuth credentials restored"}


@app.post("/auth/clear")
async def auth_clear(user_id: str = Query(...)) -> JsonObject:
    """Remove stored OAuth credentials for a specific user."""
    async with _credential_mutation(user_id) as generation:
        await _await_credential_filesystem_mutation(
            _clear_credential_files,
            user_id,
            user_id=user_id,
            generation=generation,
        )

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
        token_json = json.dumps(dict(token), indent=True)
        async with _credential_mutation(user_id) as generation:
            await _await_credential_filesystem_mutation(
                _write_credential_files,
                user_id,
                token_json,
                req.client_id,
                req.client_secret,
                user_id=user_id,
                generation=generation,
            )

        log.info(f"Device code flow completed for user {user_id}")

        return {
            "status": "success",
            "oauth_json": token_json,
        }
    except HTTPException:
        raise
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
