"""Thread-safety regression tests for the per-user stream URL cache."""

from __future__ import annotations

import threading
import types


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
