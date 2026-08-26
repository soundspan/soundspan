"""Behavioral coverage for the independently scheduled AcoustID worker."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

import acoustid_worker
import pytest


class _Database:
    """Record lookup-thread connection ownership."""

    def __init__(self) -> None:
        self.connected = threading.Event()
        self.closed = threading.Event()

    def connect(self) -> None:
        self.connected.set()

    def close(self) -> None:
        self.closed.set()


class _Backfill:
    """Block one lookup pass until the test permits clean shutdown."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def run_once(self, _stop_requested: Callable[[], bool]) -> bool:
        self.started.set()
        self.release.wait()
        return True


def test_lookup_worker_runs_off_analysis_thread_and_closes_its_database() -> None:
    """Start lookup independently and join it cleanly during shutdown."""
    database = _Database()
    backfill = _Backfill()
    worker = acoustid_worker.AcoustIDLookupWorker(
        "postgresql://database",
        "configured",
        database_factory=lambda _url: database,
        backfill_factory=lambda _database, _key: backfill,
        cadence_seconds=60,
    )

    worker.start()

    assert database.connected.wait(timeout=1)
    assert backfill.started.wait(timeout=1)
    assert threading.current_thread() is not worker.thread

    backfill.release.set()
    worker.stop()

    assert database.closed.is_set()
    assert worker.thread is not None
    assert not worker.thread.is_alive()


def test_lookup_worker_shutdown_is_bounded_when_lookup_thread_is_wedged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep process shutdown bounded when a database operation never returns."""
    database = _Database()
    backfill = _Backfill()
    worker = acoustid_worker.AcoustIDLookupWorker(
        "postgresql://database",
        "configured",
        database_factory=lambda _url: database,
        backfill_factory=lambda _database, _key: backfill,
        cadence_seconds=60,
    )
    monkeypatch.setattr(acoustid_worker, "WORKER_STOP_JOIN_TIMEOUT_SECONDS", 0.01)

    worker.start()
    assert backfill.started.wait(timeout=1)
    assert worker.thread is not None

    started_at = time.monotonic()
    worker.stop()
    elapsed = time.monotonic() - started_at

    assert elapsed < 0.5
    assert worker.thread.daemon is True
    assert worker.thread.is_alive()

    backfill.release.set()
    worker.thread.join(timeout=1)
    assert not worker.thread.is_alive()
