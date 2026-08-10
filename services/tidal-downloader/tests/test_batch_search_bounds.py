"""Behavioral tests for TIDAL batch-search request and concurrency bounds."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest


def _search_results(query: str) -> SimpleNamespace:
    """Build the minimal provider result shape consumed by batch search."""
    track = SimpleNamespace(
        id=query,
        title=f"Result for {query}",
        artists=[SimpleNamespace(name="Test Artist")],
        duration=180,
        isrc=f"ISRC-{query}",
    )
    return SimpleNamespace(tracks=SimpleNamespace(items=[track]))


@pytest.mark.anyio
async def test_batch_search_rejects_requests_above_query_cap(client, monkeypatch):
    """Oversized batches should fail validation without invoking TIDAL."""
    import app

    calls: list[str] = []

    async def fake_run_user_api_call(*_args, **_kwargs):
        calls.append("called")
        return _search_results("unexpected")

    monkeypatch.setattr(app, "_run_user_api_call", fake_run_user_api_call)
    sensitive_query = "must-not-appear-in-validation-detail"
    queries = [
        {"query": f"{sensitive_query}-{index}"}
        for index in range(app._BATCH_SEARCH_MAX_QUERIES + 1)
    ]

    response = await client.post(
        "/user/search/batch",
        params={"user_id": "user-1"},
        json=queries,
    )

    assert response.status_code == 422
    assert calls == []
    assert sensitive_query not in response.text


@pytest.mark.anyio
async def test_batch_search_bounds_concurrency_and_preserves_order(client, monkeypatch):
    """Batch searches should limit concurrent provider calls and retain input order."""
    import app

    in_flight = 0
    max_in_flight = 0

    async def fake_run_user_api_call(_user_id, func, operation):
        assert operation.startswith("batch search")
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        try:
            for _ in range(3):
                await asyncio.sleep(0)
            api = SimpleNamespace(get_search=lambda query: _search_results(query))
            return func(api)
        finally:
            in_flight -= 1

    monkeypatch.setattr(app, "_run_user_api_call", fake_run_user_api_call)
    query_values = [f"query-{index}" for index in range(20)]

    response = await client.post(
        "/user/search/batch",
        params={"user_id": "user-1"},
        json=[{"query": query} for query in query_values],
    )

    assert response.status_code == 200
    assert max_in_flight <= app._BATCH_SEARCH_CONCURRENCY
    payload_results = response.json()["results"]
    assert [item["query"] for item in payload_results] == query_values
    assert [item["results"][0]["id"] for item in payload_results] == query_values


@pytest.mark.anyio
async def test_batch_search_returns_shaped_results_in_order(client, monkeypatch):
    """A small valid batch should retain the established response shape and order."""
    import app

    async def fake_run_user_api_call(_user_id, func, operation):
        assert operation.startswith("batch search")
        api = SimpleNamespace(get_search=lambda query: _search_results(query))
        return func(api)

    monkeypatch.setattr(app, "_run_user_api_call", fake_run_user_api_call)

    response = await client.post(
        "/user/search/batch",
        params={"user_id": "user-1"},
        json=[{"query": "first"}, {"query": "second"}],
    )

    assert response.status_code == 200
    assert response.json() == {
        "results": [
            {
                "query": "first",
                "results": [
                    {
                        "id": "first",
                        "title": "Result for first",
                        "artist": "Test Artist",
                        "duration": 180,
                        "isrc": "ISRC-first",
                    }
                ],
            },
            {
                "query": "second",
                "results": [
                    {
                        "id": "second",
                        "title": "Result for second",
                        "artist": "Test Artist",
                        "duration": 180,
                        "isrc": "ISRC-second",
                    }
                ],
            },
        ]
    }
