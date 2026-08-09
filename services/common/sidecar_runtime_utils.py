"""Shared runtime helpers for Python sidecar services."""

from __future__ import annotations

import hmac
import logging
import os
import random
import re
import threading
import time
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

DEFAULT_STREAM_CONNECT_TIMEOUT = 30.0
DEFAULT_STREAM_READ_TIMEOUT = 300.0
_KNOWN_DEFAULT_SECRET = "soundspan-internal-secret-change-me"

# Prisma cuids (the only user_id the backend ever sends) are alphanumeric;
# this also rejects any `/`, `.`, or `%` that could escape DATA_PATH.
_USER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


class ThreadSafeRatePacer:
    """Serialize rate-limited work across threads with a randomized minimum gap.

    ``wait()`` blocks the calling thread until at least a random delay in
    ``[min_delay, max_delay]`` has elapsed since the previously reserved slot,
    then reserves the next slot. State is guarded by a ``threading.Lock``
    because asyncio locks are not thread-safe. Monotonic time prevents wall-
    clock jumps from distorting pacing. Returns the seconds slept.
    """

    def __init__(self, min_delay: float, max_delay: float) -> None:
        self._min = float(min_delay)
        self._max = float(max_delay)
        if not 0 <= self._min <= self._max:
            raise ValueError("rate-pacing delays must satisfy 0 <= min <= max")
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def wait(self) -> float:
        """Wait for and reserve the next rate-limited work slot."""
        with self._lock:
            now = time.monotonic()
            gap = random.uniform(self._min, self._max)
            start_at = max(self._next_allowed, now)
            self._next_allowed = start_at + gap
            sleep_for = start_at - now
        if sleep_for > 0:
            time.sleep(sleep_for)
        return sleep_for


def register_error_handlers(app: FastAPI, logger: logging.Logger) -> None:
    """Register consistent, sanitized JSON error responses for a sidecar app."""

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(
        _request: Request,
        exc: StarletteHTTPException,
    ) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, dict):
            body = detail
        elif isinstance(detail, str):
            body = {"error": detail}
        else:
            body = {"error": str(detail)}
        return JSONResponse(
            body,
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request,
        _exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(
            {"error": "Invalid request parameters"},
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def handle_unhandled_error(
        request: Request,
        exc: Exception,
    ) -> JSONResponse:
        logger.error(
            "Unhandled error on %s %s: %s",
            request.method,
            request.url.path,
            exc,
            exc_info=True,
        )
        return JSONResponse(
            {"error": "Internal Server Error"},
            status_code=500,
        )


def require_internal_secret(request: Request) -> None:
    """FastAPI dependency: authenticate machine-to-machine sidecar calls.

    Mirrors the backend's ``middleware/internalAuth.ts`` guard (F30): the
    ``/health`` path is exempt (k8s probes + the backend's own sidecar health
    checks call it without the secret), and the guard **fails closed** — if
    ``INTERNAL_API_SECRET`` is unset, empty, or equal to the repo-published
    default every non-health request is rejected with 403 rather than allowed
    through. The ``x-internal-secret`` header is compared in constant time via
    ``hmac.compare_digest``.
    """
    if request.url.path == "/health":
        return

    expected = os.getenv("INTERNAL_API_SECRET")
    if not expected or expected == _KNOWN_DEFAULT_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")

    provided = request.headers.get("x-internal-secret")
    if not isinstance(provided, str) or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Forbidden")


def validate_user_id(user_id: str) -> None:
    """Reject a ``user_id`` that is not a safe path/cache-key token.

    Raises ``HTTPException(400)`` for anything outside ``[A-Za-z0-9_-]{1,64}``
    so a value like ``../../etc/x`` can never be interpolated into a filesystem
    path (path traversal). Legit backend traffic (Prisma cuids) always passes.
    """
    if not _USER_ID_RE.fullmatch(user_id or ""):
        raise HTTPException(status_code=400, detail="Invalid user_id")


def env_int(name: str, default: str) -> int:
    """Parse an integer env var using a string default value."""
    return int(os.getenv(name, default))


def env_float(name: str, default: str) -> float:
    """Parse a float env var using a string default value."""
    return float(os.getenv(name, default))


def stream_proxy_timeout() -> httpx.Timeout:
    """Return the default timeout for sidecar upstream stream requests."""
    return httpx.Timeout(
        DEFAULT_STREAM_CONNECT_TIMEOUT,
        read=DEFAULT_STREAM_READ_TIMEOUT,
    )


def build_stream_proxy_client(user_agent: Optional[str] = None) -> httpx.AsyncClient:
    """Build an AsyncClient with sidecar stream timeout defaults."""
    client_kwargs = {"timeout": stream_proxy_timeout(), "follow_redirects": True}
    if user_agent is not None:
        client_kwargs["headers"] = {"User-Agent": user_agent}
    return httpx.AsyncClient(**client_kwargs)


async def build_range_proxy_response(
    stream_url: str,
    request_headers: dict[str, str],
    content_type: str,
    user_agent: str,
    logger: logging.Logger,
    log_context: str,
) -> StreamingResponse:
    """Proxy a Range request to an upstream CDN as a streaming response.

    Own the httpx client for the full stream. If the initial send fails, close
    the client before re-raising. Content-Length is intentionally not forwarded
    to avoid h11 declared-length errors on mid-stream drops. The upstream and
    client are closed in a finally block on every streaming path.
    """
    client = build_stream_proxy_client(user_agent=user_agent)
    try:
        upstream = await client.send(
            client.build_request("GET", stream_url, headers=request_headers),
            stream=True,
        )
    except Exception:
        await client.aclose()
        raise

    response_headers = {"Content-Type": content_type, "Accept-Ranges": "bytes"}
    if "content-range" in upstream.headers:
        response_headers["Content-Range"] = upstream.headers["content-range"]

    async def range_stream():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=65536):
                yield chunk
        except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as exc:
            logger.warning(
                "Upstream read error during range stream for %s: %s",
                log_context,
                exc,
            )
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        range_stream(),
        status_code=upstream.status_code,
        headers=response_headers,
    )


def build_full_proxy_response(
    stream_url: str,
    request_headers: dict[str, str],
    content_type: str,
    user_agent: str,
    logger: logging.Logger,
    log_context: str,
) -> StreamingResponse:
    """Proxy a non-range GET to an upstream CDN as a streaming response.

    The client closes when iteration ends. Upstream errors are logged and end
    the stream gracefully.
    """

    async def stream_audio():
        async with build_stream_proxy_client(user_agent=user_agent) as client:
            try:
                async with client.stream(
                    "GET", stream_url, headers=request_headers
                ) as response:
                    async for chunk in response.aiter_bytes(chunk_size=65536):
                        yield chunk
            except (httpx.HTTPError, httpx.StreamError, httpx.ReadError) as exc:
                logger.error("Upstream stream error for %s: %s", log_context, exc)
                return

    return StreamingResponse(
        stream_audio(),
        media_type=content_type,
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )
