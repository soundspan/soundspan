"""Shared runtime helpers for Python sidecar services."""

from __future__ import annotations

import hmac
import os
import re
from typing import Optional

import httpx
from fastapi import HTTPException, Request

DEFAULT_STREAM_CONNECT_TIMEOUT = 30.0
DEFAULT_STREAM_READ_TIMEOUT = 300.0

# Prisma cuids (the only user_id the backend ever sends) are alphanumeric;
# this also rejects any `/`, `.`, or `%` that could escape DATA_PATH.
_USER_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


def require_internal_secret(request: Request) -> None:
    """FastAPI dependency: authenticate machine-to-machine sidecar calls.

    Mirrors the backend's ``middleware/internalAuth.ts`` guard (F30): the
    ``/health`` path is exempt (k8s probes + the backend's own sidecar health
    checks call it without the secret), and the guard **fails closed** — if
    ``INTERNAL_API_SECRET`` is unset/empty every non-health request is rejected
    with 403 rather than allowed through. The ``x-internal-secret`` header is
    compared in constant time via ``hmac.compare_digest``.
    """
    if request.url.path == "/health":
        return

    expected = os.getenv("INTERNAL_API_SECRET")
    if not expected:
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
