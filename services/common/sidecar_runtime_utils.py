"""Shared runtime helpers for Python sidecar services."""

from __future__ import annotations

import hmac
import logging
import os
import random
import re
import threading
import time
from collections.abc import AsyncIterator

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

from . import environment as _environment

DEFAULT_STREAM_CONNECT_TIMEOUT = 30.0
DEFAULT_STREAM_READ_TIMEOUT = 300.0
_KNOWN_DEFAULT_SECRET = "soundspan-internal-secret-change-me"  # noqa: S105 -- known insecure sentinel rejected at runtime

# Prisma cuids (the only user_id the backend ever sends) are alphanumeric;
# this also rejects any `/`, `.`, or `%` that could escape DATA_PATH.
_USER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
_POOL_FULL_WARNING = "Connection pool is full, discarding connection"
_POOL_WARNING_SUPPRESSION_SECONDS = 300
_POOL_WARNING_REPLACEMENT = (
    "urllib3 connection pool saturated; suppressing repeated pool-full "
    "warnings for 300s. Increase upstream pool size if this persists."
)


class _ThrottlePoolFullWarning(logging.Filter):
    """Throttle noisy urllib3 pool-full warnings while preserving signal."""

    def __init__(self) -> None:
        super().__init__()
        # None = never emitted. A 0.0 sentinel would wrongly suppress the
        # FIRST warning on hosts whose monotonic clock is younger than the
        # suppression window (fresh VMs boot with time.monotonic() < 300s).
        self._last_emit_at: float | None = None

    def filter(self, record: logging.LogRecord) -> bool:
        """Rewrite the first pool-full warning and suppress repeats for five minutes."""
        message = record.getMessage()
        if _POOL_FULL_WARNING not in message:
            return True

        now = time.monotonic()
        if (
            self._last_emit_at is not None
            and (now - self._last_emit_at) < _POOL_WARNING_SUPPRESSION_SECONDS
        ):
            return False

        self._last_emit_at = now
        record.msg = _POOL_WARNING_REPLACEMENT
        record.args = ()
        return True


def install_urllib3_pool_warning_throttle() -> None:
    """Install the shared five-minute urllib3 pool-full warning throttle.

    Idempotent: module reimports (test harnesses reload consumer modules in
    one process) must not stack duplicate filters on the shared logger.
    """
    pool_logger = logging.getLogger("urllib3.connectionpool")
    if any(isinstance(f, _ThrottlePoolFullWarning) for f in pool_logger.filters):
        return
    pool_logger.addFilter(_ThrottlePoolFullWarning())


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
            gap = random.uniform(self._min, self._max)  # noqa: S311 -- pacing jitter is not security-sensitive
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
        # Starlette annotates detail narrowly, while FastAPI accepts JSON objects.
        detail: object = exc.detail
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
            exc_info=True,  # noqa: LOG014 -- registered handler always runs with an active exception
        )
        return JSONResponse(
            {"error": "Internal Server Error"},
            status_code=500,
        )


def sanitized_http_error(
    logger: logging.Logger,
    operation: str,
    exc: Exception,
    status: int,
    detail: str,
) -> HTTPException:
    """Log full exception detail and return a generic client-facing error."""
    logger.error(
        "%s failed: %s",
        operation,
        exc,
        exc_info=True,  # noqa: LOG014 -- callers invoke this from active exception handlers
    )
    return HTTPException(status_code=status, detail=detail)


def require_internal_secret(request: Request) -> None:
    """FastAPI dependency: authenticate machine-to-machine sidecar calls.

    The ``/health`` path is exempt for local and orchestrator probes. Every
    other request fails closed with 403 when ``INTERNAL_API_SECRET`` is unset,
    empty, set to the published default, or different from the constant-time
    ``x-internal-secret`` header comparison.
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


def env_int(name: str, default: int | str) -> int:
    """Parse an integer environment value through the lightweight shared boundary."""
    return _environment.env_int(name, default)


def env_float(name: str, default: float | int | str) -> float:
    """Parse a float environment value through the lightweight shared boundary."""
    return _environment.env_float(name, default)


def stream_proxy_timeout() -> httpx.Timeout:
    """Return the default timeout for sidecar upstream stream requests."""
    return httpx.Timeout(
        DEFAULT_STREAM_CONNECT_TIMEOUT,
        read=DEFAULT_STREAM_READ_TIMEOUT,
    )


def build_stream_proxy_client(user_agent: str | None = None) -> httpx.AsyncClient:
    """Build an AsyncClient with sidecar stream timeout defaults."""
    if user_agent is None:
        return httpx.AsyncClient(timeout=stream_proxy_timeout(), follow_redirects=True)
    return httpx.AsyncClient(
        timeout=stream_proxy_timeout(),
        follow_redirects=True,
        headers={"User-Agent": user_agent},
    )


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

    async def range_stream() -> AsyncIterator[bytes]:
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

    async def stream_audio() -> AsyncIterator[bytes]:
        async with build_stream_proxy_client(user_agent=user_agent) as client:
            try:
                async with client.stream("GET", stream_url, headers=request_headers) as response:
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
