"""HTTP error response-shape contract tests."""

from __future__ import annotations

import pytest


@pytest.mark.anyio
async def test_http_exception_uses_error_key(client):
    """String HTTPException details are exposed through the error key."""
    response = await client.post("/search", json={"query": "q"})

    assert response.status_code == 401
    assert response.json() == {"error": "access_token required"}
    assert "detail" not in response.json()
