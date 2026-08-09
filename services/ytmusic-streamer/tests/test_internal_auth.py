"""Inbound internal-secret auth + user_id path-traversal defense (F31).

These construct their own clients (no default auth header) so they can
exercise the missing/wrong/unset-secret branches directly, independent of the
shared ``client`` fixture that carries the header for the rest of the suite.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

SECRET = "test-internal-secret-value"


def _client(headers: dict[str, str] | None = None) -> AsyncClient:
    from app import app

    transport = ASGITransport(app=app)
    return AsyncClient(
        transport=transport, base_url="http://test", headers=headers or {}
    )


@pytest.mark.anyio
async def test_health_reachable_without_secret(monkeypatch):
    """k8s probes and the backend health check hit /health with no secret."""
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client() as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["service"] == "ytmusic-streamer"


@pytest.mark.anyio
async def test_missing_secret_rejected(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client() as client:
        resp = await client.get("/auth/status", params={"user_id": "user-1"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_wrong_secret_rejected(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client({"x-internal-secret": "not-the-secret"}) as client:
        resp = await client.get("/auth/status", params={"user_id": "user-1"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_unset_secret_fails_closed(monkeypatch):
    """An unset INTERNAL_API_SECRET must reject, not allow-all."""
    monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    async with _client({"x-internal-secret": SECRET}) as client:
        resp = await client.get("/auth/status", params={"user_id": "user-1"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_known_default_secret_rejected(monkeypatch):
    """The repo-published default secret must be treated as unconfigured."""
    known_default = "soundspan-internal-secret-change-me"
    monkeypatch.setenv("INTERNAL_API_SECRET", known_default)
    async with _client({"x-internal-secret": known_default}) as client:
        resp = await client.get("/auth/status", params={"user_id": "user-1"})
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_valid_secret_passes(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client({"x-internal-secret": SECRET}) as client:
        resp = await client.get("/auth/status", params={"user_id": "user-1"})
    assert resp.status_code == 200
    assert resp.json() == {
        "authenticated": False,
        "reason": "No OAuth credentials found",
    }


@pytest.mark.anyio
@pytest.mark.parametrize(
    "bad_id",
    ["../../etc/cron.d/x", "..%2F..%2Fetc", "a/b", "foo.bar", "with space", "x" * 65],
)
async def test_traversal_user_id_rejected_before_file_op(monkeypatch, bad_id):
    """A traversal user_id is 400-rejected before any filesystem access."""
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client({"x-internal-secret": SECRET}) as client:
        resp = await client.get("/auth/status", params={"user_id": bad_id})
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_traversal_user_id_rejected_on_clear(monkeypatch):
    """/auth/clear (which unlinks files) also rejects traversal ids."""
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client({"x-internal-secret": SECRET}) as client:
        resp = await client.post(
            "/auth/clear", params={"user_id": "../../etc/passwd"}
        )
    assert resp.status_code == 400


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["/openapi.json", "/docs", "/redoc"])
async def test_schema_docs_routes_disabled(monkeypatch, path):
    """The docs/openapi routes are add_route()-registered, so app-level
    dependencies never cover them — they must be disabled outright. 404 (route
    absent), NOT 403: no route exists for the auth dependency to attach to."""
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    async with _client() as client:
        resp = await client.get(path)
    assert resp.status_code == 404
