"""Thread-safety regression tests for the per-user stream URL cache."""

from __future__ import annotations

import asyncio
import threading
import types

import pytest


def _assert_lock_held(lock: threading.Lock) -> None:
    acquired = lock.acquire(blocking=False)
    if acquired:
        lock.release()
    assert not acquired, "stream cache operation ran without mutual exclusion"


def _assert_lock_available(lock: threading.Lock, operation: str) -> None:
    acquired = lock.acquire(blocking=False)
    assert acquired, f"lock held across blocking {operation}"
    lock.release()


class _IterationLockCheckingDict(dict):
    def __init__(self, values, lock: threading.Lock) -> None:
        super().__init__(values)
        self._lock = lock

    def __iter__(self):
        _assert_lock_held(self._lock)
        return super().__iter__()

    def items(self):
        _assert_lock_held(self._lock)
        return super().items()


class _AccessLockCheckingDict(dict):
    def __init__(self, lock: threading.Lock) -> None:
        super().__init__()
        self._lock = lock

    def get(self, key, default=None):
        _assert_lock_held(self._lock)
        return super().get(key, default)

    def __setitem__(self, key, value) -> None:
        _assert_lock_held(self._lock)
        super().__setitem__(key, value)


def test_clear_stream_cache_holds_lock_and_preserves_other_users(monkeypatch):
    import app

    lock = threading.Lock()
    cache = _IterationLockCheckingDict(
        {
            ("target", 1, "HIGH"): {"expires_at": 100},
            ("target", 2, "LOSSLESS"): {"expires_at": 100},
            ("other", 1, "HIGH"): {"expires_at": 100},
        },
        lock,
    )
    monkeypatch.setattr(app, "_stream_cache_lock", lock, raising=False)
    monkeypatch.setattr(app, "_stream_cache", cache)

    app._clear_stream_cache("target")

    assert cache == {("other", 1, "HIGH"): {"expires_at": 100}}


def test_clean_stream_cache_holds_lock_and_removes_only_expired(monkeypatch):
    import app

    lock = threading.Lock()
    cache = _IterationLockCheckingDict(
        {
            ("user", 1, "HIGH"): {"expires_at": 99},
            ("user", 2, "HIGH"): {"expires_at": 101},
        },
        lock,
    )
    monkeypatch.setattr(app, "_stream_cache_lock", lock, raising=False)
    monkeypatch.setattr(app, "_stream_cache", cache)
    monkeypatch.setattr(app.time, "time", lambda: 100)

    app._clean_stream_cache()

    assert cache == {("user", 2, "HIGH"): {"expires_at": 101}}


def test_stream_cache_access_lock_excludes_only_dictionary_operations(monkeypatch):
    import app

    lock = threading.Lock()
    cache = _AccessLockCheckingDict(lock)

    def assert_provider_call_is_unlocked(**_kwargs):
        _assert_lock_available(lock, "TIDAL API call")
        return types.SimpleNamespace(
            manifestMimeType="application/vnd.tidal.bts",
            audioQuality="HIGH",
            bitDepth=None,
            sampleRate=None,
        )

    def assert_parser_call_is_unlocked(_stream):
        _assert_lock_available(lock, "stream parser call")
        return ["url"], ".flac"

    monkeypatch.setattr(app, "_stream_cache_lock", lock, raising=False)
    monkeypatch.setattr(app, "_stream_cache", cache)
    monkeypatch.setattr(
        app,
        "_user_apis",
        {"user": types.SimpleNamespace(get_track_stream=assert_provider_call_is_unlocked)},
    )
    monkeypatch.setattr(app, "parse_track_stream", assert_parser_call_is_unlocked)

    result = app._get_stream_url_sync("user", 1)

    assert result["url"] == "url"
    assert cache[("user", 1, "HIGH")] is result


def _stream_api(url_by_track: dict[int, str]):
    """Build a provider double that returns a distinct URL per track."""

    def get_track_stream(*, track_id: int, quality: str):
        return types.SimpleNamespace(
            manifestMimeType="application/vnd.tidal.bts",
            audioQuality=quality,
            bitDepth=None,
            sampleRate=None,
            url=url_by_track[track_id],
        )

    return types.SimpleNamespace(get_track_stream=get_track_stream)


def _configure_stream_loading(monkeypatch, app, cache, urls: dict[int, str]) -> None:
    """Install deterministic cache and provider state for stream lookups."""
    monkeypatch.setattr(app, "_stream_cache", cache)
    monkeypatch.setattr(app, "_user_apis", {"user": _stream_api(urls)})
    monkeypatch.setattr(app, "parse_track_stream", lambda stream: ([stream.url], ".flac"))


def test_stream_lookup_removes_expired_entries(monkeypatch):
    import app

    cache = {
        ("expired-user", 9, "HIGH"): {"expires_at": 99},
        ("user", 2, "HIGH"): {"url": "fresh", "expires_at": 101},
    }
    _configure_stream_loading(monkeypatch, app, cache, {1: "loaded"})
    monkeypatch.setattr(app.time, "time", lambda: 100)

    result = app._get_stream_url_sync("user", 1)

    assert result["url"] == "loaded"
    assert ("expired-user", 9, "HIGH") not in cache
    assert ("user", 2, "HIGH") in cache


def test_stream_cache_is_bounded_and_evicts_least_recently_used(monkeypatch):
    import app

    cache = {
        ("user", 1, "HIGH"): {"url": "one", "expires_at": 200},
        ("user", 2, "HIGH"): {"url": "two", "expires_at": 200},
    }
    _configure_stream_loading(monkeypatch, app, cache, {3: "three"})
    monkeypatch.setattr(app, "_STREAM_CACHE_MAX_ENTRIES", 2, raising=False)
    monkeypatch.setattr(app.time, "time", lambda: 100)

    assert app._get_stream_url_sync("user", 1)["url"] == "one"
    assert app._get_stream_url_sync("user", 3)["url"] == "three"

    assert list(cache) == [("user", 1, "HIGH"), ("user", 3, "HIGH")]


def test_stream_insertion_prefers_expired_eviction(monkeypatch):
    import app

    cache = {
        ("user", 1, "HIGH"): {"url": "fresh", "expires_at": 200},
        ("other", 2, "HIGH"): {"url": "expired", "expires_at": 99},
    }
    _configure_stream_loading(monkeypatch, app, cache, {3: "three"})
    monkeypatch.setattr(app, "_STREAM_CACHE_MAX_ENTRIES", 2, raising=False)
    monkeypatch.setattr(app.time, "time", lambda: 100)

    app._get_stream_url_sync("user", 3)

    assert list(cache) == [("user", 1, "HIGH"), ("user", 3, "HIGH")]


@pytest.mark.anyio
async def test_stream_cache_cleanup_loop_runs_periodically(monkeypatch):
    import app

    cleanup_calls = []
    sleep_calls = []

    async def one_interval_then_cancel(delay: float) -> None:
        sleep_calls.append(delay)
        if len(sleep_calls) > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(app.asyncio, "sleep", one_interval_then_cancel)
    monkeypatch.setattr(app, "_clean_stream_cache", lambda: cleanup_calls.append(True))

    with pytest.raises(asyncio.CancelledError):
        await app._run_stream_cache_cleanup()

    assert sleep_calls == [app._STREAM_CACHE_CLEANUP_INTERVAL_SECONDS] * 2
    assert cleanup_calls == [True]


@pytest.mark.anyio
async def test_app_lifespan_owns_stream_cache_cleanup_task(monkeypatch):
    import app

    started = asyncio.Event()
    stopped = asyncio.Event()

    async def cleanup_until_cancelled() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(app, "_run_stream_cache_cleanup", cleanup_until_cancelled)

    async with app._app_lifespan(app.app):
        await started.wait()

    assert stopped.is_set()
