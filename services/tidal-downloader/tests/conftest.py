"""Shared fixtures for tidal-downloader tests."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient


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
