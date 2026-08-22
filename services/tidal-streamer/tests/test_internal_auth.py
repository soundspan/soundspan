"""Inbound internal-secret auth for the tidal-streamer sidecar (F31).

These construct their own clients (no default auth header) so they can
exercise the missing/wrong/unset-secret branches directly, independent of the
shared ``client`` fixture that carries the header for the rest of the suite.

Note: tidal's ``user_id`` is only ever an in-memory dict key (never a
filesystem path), so — unlike ytmusic — there is no path-traversal check here.
"""

from __future__ import annotations

from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

SECRET = "test-internal-secret-value"


def _client(headers: dict[str, str] | None = None) -> AsyncClient:
    from app import app

    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test", headers=headers or {})


@pytest.mark.anyio
async def test_health_reachable_without_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    """k8s probes and the backend health check hit /health with no secret."""
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client() as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["service"] == "tidal-streamer"


@pytest.mark.anyio
async def test_missing_secret_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client() as client:
        resp = await client.get("/user/auth/status", params={"user_id": "test"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_wrong_secret_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client({"x-internal-secret": "not-the-secret"}) as client:
        resp = await client.get("/user/auth/status", params={"user_id": "test"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_unset_secret_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unset INTERNAL_API_SECRET must reject, not allow-all."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    async with _client({"x-internal-secret": SECRET}) as client:
        resp = await client.get("/user/auth/status", params={"user_id": "test"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_known_default_secret_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """The repo-published default secret must be treated as unconfigured."""
    known_default = "soundspan-internal-secret-change-me"
    monkeypatch.setenv("INTERNAL_API_SECRET", known_default)
    async with _client({"x-internal-secret": known_default}) as client:
        resp = await client.get("/user/auth/status", params={"user_id": "test"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_valid_secret_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client({"x-internal-secret": SECRET}) as client:
        resp = await client.get("/user/auth/status", params={"user_id": "test"})
    assert resp.status_code == 200
    assert resp.json() == {"authenticated": False, "user_id": "test"}


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
async def test_schema_docs_routes_disabled(monkeypatch: pytest.MonkeyPatch, path: Any) -> None:
    """The docs/openapi routes are add_route()-registered, so app-level
    dependencies never cover them — they must be disabled outright. 404 (route
    absent), NOT 403: no route exists for the auth dependency to attach to."""
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client() as client:
        resp = await client.get(path)
    assert resp.status_code == 404
