"""Shared runtime helpers for Python sidecar services."""

from __future__ import annotations

import os
from typing import Optional

import httpx

DEFAULT_STREAM_CONNECT_TIMEOUT = 30.0
DEFAULT_STREAM_READ_TIMEOUT = 300.0


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
    client_kwargs = {"timeout": stream_proxy_timeout()}
    if user_agent is not None:
        client_kwargs["headers"] = {"User-Agent": user_agent}
    return httpx.AsyncClient(**client_kwargs)
