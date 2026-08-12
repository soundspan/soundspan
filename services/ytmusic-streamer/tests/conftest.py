"""Shared fixtures for ytmusic-streamer tests."""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Literal

import pytest
from httpx import ASGITransport, AsyncClient

SERVICE_ROOT = Path(__file__).resolve().parents[1]

# Shared secret the `client` fixture presents on every request so the F31
# inbound-auth dependency lets the existing behaviour suites through. Tests
# that exercise the auth gate itself (test_internal_auth.py) build their own
# clients and manage this env var directly.
INTERNAL_API_SECRET = "test-internal-secret-value"


@pytest.fixture(autouse=True)
def internal_api_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a known INTERNAL_API_SECRET for the app under test."""
    monkeypatch.setenv("INTERNAL_API_SECRET", INTERNAL_API_SECRET)


@pytest.fixture(autouse=True)
def local_app_module() -> Iterator[None]:
    """Ensure `import app` resolves to this sidecar during the test."""
    sys.modules.pop("app", None)
    sys.path.insert(0, str(SERVICE_ROOT))
    try:
        yield
    finally:
        sys.modules.pop("app", None)
        while str(SERVICE_ROOT) in sys.path:
            sys.path.remove(str(SERVICE_ROOT))


@pytest.fixture()
def anyio_backend() -> Literal["asyncio"]:
    """Use asyncio for all async tests."""
    return "asyncio"


@pytest.fixture()
async def client() -> AsyncIterator[AsyncClient]:
    """Async HTTP client wired to the FastAPI app under test.

    Presents the internal-auth header by default so behaviour tests reach the
    handlers through the F31 `require_internal_secret` dependency.
    """
    from app import app

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"x-internal-secret": INTERNAL_API_SECRET},
    ) as ac:
        yield ac
