"""Tests that blocking YTMusic calls run outside the event-loop thread."""

from __future__ import annotations

import threading
import types

import pytest


@pytest.mark.anyio
async def test_search_offloaded_to_worker_thread(client, monkeypatch):
    """Search work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fake(*args, **kwargs):
        captured["t"] = threading.current_thread().name
        return [], "native"

    monkeypatch.setattr(app, "_search_with_mode_fallback", fake)

    response = await client.post("/search?user_id=u1", json={"query": "x"})

    assert response.status_code == 200
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_library_songs_offloaded_to_worker_thread(client, monkeypatch):
    """Library-song work should execute in an asyncio worker thread."""
    import app

    captured = {}

    def fake(user_id, operation, func):
        captured["t"] = threading.current_thread().name
        return []

    monkeypatch.setattr(app, "_run_ytmusic_with_auth_retry", fake)

    response = await client.get("/library/songs?user_id=u1")

    assert response.status_code == 200
    assert response.json() == {"songs": [], "total": 0}
    assert captured["t"] != "MainThread"


@pytest.mark.anyio
async def test_charts_offloaded_to_worker_thread(client, monkeypatch):
    """Charts work should execute in an asyncio worker thread."""
    import app

    captured = {}
    public_client = types.SimpleNamespace(
        get_charts=lambda country: (
            captured.__setitem__("t", threading.current_thread().name) or {}
        )
    )
    monkeypatch.setattr(app, "_get_public_ytmusic", lambda strategy: public_client)

    response = await client.get("/charts?country=US")

    assert response.status_code == 200
    assert captured["t"] != "MainThread"
