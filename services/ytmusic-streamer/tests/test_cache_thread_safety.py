"""Thread-safety regressions for ytmusic-streamer module caches."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest


def test_cross_thread_cache_locks_exist() -> None:
    import app

    lock_type = type(threading.Lock())
    locks = (
        app._stream_cache_lock,
        app._search_cache_lock,
        app._public_ytmusic_lock,
        app._ytmusic_instances_lock,
    )

    assert all(isinstance(lock, lock_type) for lock in locks)
    assert not hasattr(app, "_ytmusic_lock")


@pytest.mark.parametrize(
    ("cache_name", "lock_name", "cleaner_name"),
    (
        ("_stream_cache", "_stream_cache_lock", "_clean_stream_cache"),
        ("_search_cache", "_search_cache_lock", "_clean_search_cache"),
    ),
)
def test_cache_cleanup_waits_for_owning_lock(
    cache_name: Any, lock_name: Any, cleaner_name: Any
) -> None:
    import app

    cache = getattr(app, cache_name)
    lock = getattr(app, lock_name)
    cleaner = getattr(app, cleaner_name)
    expired_key = "expired"
    with lock:
        cache.clear()
        cache[expired_key] = {"expires_at": time.time() - 1}
        worker = threading.Thread(target=cleaner)
        worker.start()
        worker.join(timeout=0.5)
        assert worker.is_alive()
        assert expired_key in cache

    worker.join(timeout=5)
    assert not worker.is_alive()
    assert expired_key not in cache


def test_search_cache_concurrent_access_is_safe() -> None:
    import app

    def exercise_cache(worker_id: int) -> None:
        for iteration in range(200):
            query = f"query-{worker_id}-{iteration}"
            result = {"query": query}
            app._set_cached_search(str(worker_id), query, None, 5, "native", [result])
            assert app._get_cached_search(str(worker_id), query, None, 5, "native") == [result]
            with app._search_cache_lock:
                app._search_cache[f"expired-{worker_id}-{iteration}"] = {
                    "expires_at": time.time() - 1,
                    "results": [],
                }
            app._clean_search_cache()

    with app._search_cache_lock:
        app._search_cache.clear()
    try:
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(exercise_cache, worker_id) for worker_id in range(4)]
            for future in futures:
                future.result(timeout=30)
    finally:
        with app._search_cache_lock:
            app._search_cache.clear()


def test_stream_cache_concurrent_access_is_safe() -> None:
    import app

    def exercise_cache(worker_id: int) -> None:
        for iteration in range(200):
            expires_at = time.time() + 60 if iteration % 2 else time.time() - 1
            with app._stream_cache_lock:
                app._stream_cache[f"stream-{worker_id}-{iteration}"] = {"expires_at": expires_at}
                app._bound_cache(app._stream_cache, app.STREAM_CACHE_MAX)
            app._clean_stream_cache()

    with app._stream_cache_lock:
        app._stream_cache.clear()
    try:
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(exercise_cache, worker_id) for worker_id in range(4)]
            for future in futures:
                future.result(timeout=30)
    finally:
        with app._stream_cache_lock:
            app._stream_cache.clear()
