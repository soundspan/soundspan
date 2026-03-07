"""Shared fixtures for ytmusic-streamer tests."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient


SERVICE_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def local_app_module():
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
def anyio_backend():
    """Use asyncio for all async tests."""
    return "asyncio"


@pytest.fixture()
async def client():
    """Async HTTP client wired to the FastAPI app under test."""
    from app import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
