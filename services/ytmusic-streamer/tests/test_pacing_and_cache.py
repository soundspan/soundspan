"""Thread-safe pacing and bounded-cache tests for ytmusic-streamer."""

from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest


SERVICES_ROOT = Path(__file__).resolve().parents[2]
if str(SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICES_ROOT))

from common.sidecar_runtime_utils import ThreadSafeRatePacer  # noqa: E402


def test_pacer_is_thread_safe_and_serializes():
    pacer = ThreadSafeRatePacer(0.02, 0.02)
    started_at = time.monotonic()

    def wait_and_record(_index: int) -> float:
        pacer.wait()
        return time.monotonic()

    with ThreadPoolExecutor(max_workers=8) as executor:
        completion_times = sorted(executor.map(wait_and_record, range(8)))

    spacings = [
        later - earlier
        for earlier, later in zip(completion_times, completion_times[1:])
    ]
    assert all(spacing >= 0.015 for spacing in spacings)
    assert completion_times[-1] - started_at >= 7 * 0.02 * 0.8


def test_pacer_rejects_bad_bounds():
    with pytest.raises(ValueError):
        ThreadSafeRatePacer(1.0, 0.5)


def test_stream_cache_is_bounded(monkeypatch):
    import app

    monkeypatch.setattr(app, "STREAM_CACHE_MAX", 3)
    app._stream_cache.clear()
    for index in range(5):
        app._stream_cache[f"stream-{index}"] = {"expires_at": float("inf")}

    app._bound_cache(app._stream_cache, app.STREAM_CACHE_MAX)

    assert len(app._stream_cache) == 3
    assert list(app._stream_cache) == ["stream-2", "stream-3", "stream-4"]


def test_search_cache_cleanup_and_bound(monkeypatch):
    import app

    monkeypatch.setattr(app, "SEARCH_CACHE_MAX", 2)
    app._search_cache.clear()
    for query in ("q1", "q2", "q3"):
        app._set_cached_search(
            "u", query, None, 5, "native", [{"videoId": "a"}]
        )

    assert len(app._search_cache) <= 2


def test_dead_lock_removed():
    import app

    assert not hasattr(app, "_extract_lock")
    assert not hasattr(app, "_last_extract_time")
    assert isinstance(app._extract_pacer, ThreadSafeRatePacer)
