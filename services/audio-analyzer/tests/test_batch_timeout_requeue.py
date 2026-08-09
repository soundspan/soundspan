"""Red-phase contracts for audio analyzer batch-timeout reliability."""

from concurrent.futures import Future
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType
from typing import Any, Iterator

import pytest


ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"


class Json:
    """Minimal psycopg2.extras.Json passthrough used during module loading."""

    def __init__(self, value: Any) -> None:
        self.value = value


class RealDictCursor:
    """Placeholder cursor factory used by the analyzer's type annotations."""


class FakeCursor:
    """Record SQL and provide programmable database results."""

    def __init__(self, rows: list[dict[str, str]] | None = None) -> None:
        self.executions: list[tuple[str, Any]] = []
        self.rows = rows or []

    def execute(self, sql: str, params: Any = None) -> None:
        self.executions.append((sql, params))

    def fetchall(self) -> list[dict[str, str]]:
        return self.rows

    def fetchone(self) -> dict[str, str] | None:
        return self.rows[0] if self.rows else None

    def close(self) -> None:
        pass


class FakeDatabaseConnection:
    """Expose the database operations used by timeout recovery paths."""

    def __init__(self, rows: list[dict[str, str]] | None = None) -> None:
        self.cursor = FakeCursor(rows)

    def get_cursor(self) -> FakeCursor:
        return self.cursor

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


class FakePipeline:
    """Record queue pushes made by retry recovery."""

    def __init__(self) -> None:
        self.pushes: list[tuple[str, str]] = []
        self.executed = False

    def rpush(self, queue: str, payload: str) -> None:
        self.pushes.append((queue, payload))

    def execute(self) -> None:
        self.executed = True


class FakeRedis:
    """Provide a recording pipeline without making network calls."""

    def __init__(self) -> None:
        self.queue_pipeline = FakePipeline()

    def pipeline(self) -> FakePipeline:
        return self.queue_pipeline


@pytest.fixture(scope="module")
def loaded_analyzer() -> Iterator[tuple[ModuleType, list[tuple[Any, ...]]]]:
    """Load analyzer.py once with hand-rolled Redis and psycopg2 stubs."""
    monkeypatch = pytest.MonkeyPatch()
    connect_calls: list[tuple[Any, ...]] = []

    redis_stub = ModuleType("redis")

    class Redis:
        @staticmethod
        def from_url(*args: Any, **kwargs: Any) -> None:
            raise AssertionError("Redis must not be created by these unit tests")

    redis_stub.Redis = Redis  # type: ignore[attr-defined]

    psycopg2_stub = ModuleType("psycopg2")
    extras_stub = ModuleType("psycopg2.extras")

    def connect(*args: Any, **kwargs: Any) -> None:
        connect_calls.append((*args, kwargs))
        raise RuntimeError("stubbed PostgreSQL connection")

    psycopg2_stub.connect = connect  # type: ignore[attr-defined]
    psycopg2_stub.extras = extras_stub  # type: ignore[attr-defined]
    extras_stub.RealDictCursor = RealDictCursor  # type: ignore[attr-defined]
    extras_stub.Json = Json  # type: ignore[attr-defined]

    monkeypatch.delenv("NUM_WORKERS", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://stubbed-audio-analyzer")
    monkeypatch.setitem(sys.modules, "redis", redis_stub)
    monkeypatch.setitem(sys.modules, "psycopg2", psycopg2_stub)
    monkeypatch.setitem(sys.modules, "psycopg2.extras", extras_stub)

    spec = importlib.util.spec_from_file_location(
        "audio_analyzer_module",
        ANALYZER_PATH,
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    yield module, connect_calls
    monkeypatch.undo()


def test_module_import_does_not_query_database_and_uses_default_workers(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, connect_calls = loaded_analyzer

    assert connect_calls == []
    assert module.NUM_WORKERS == 2


def test_partition_unfinished_tracks_classifies_each_future_state(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
) -> None:
    module, _ = loaded_analyzer
    finalized = Future()
    finalized.set_result(("finalized", "/finalized.flac", {}))
    completed = Future()
    completed.set_result(("completed", "/completed.flac", {}))
    pending = Future()
    running = Future()
    assert running.set_running_or_notify_cancel() is True
    futures_map = {
        finalized: ("finalized", "/finalized.flac"),
        completed: ("completed", "/completed.flac"),
        pending: ("pending", "/pending.flac"),
        running: ("running", "/running.flac"),
    }

    completed_unconsumed, never_started, attempted = (
        module.partition_unfinished_tracks(futures_map, {"finalized"})
    )

    assert completed_unconsumed == [("completed", "/completed.flac")]
    assert never_started == [("pending", "/pending.flac")]
    assert attempted == [("running", "/running.flac")]
    assert pending.cancelled() is True


def test_handle_batch_timeout_drains_requeues_and_fails_by_attempt_state(
    loaded_analyzer: tuple[ModuleType, list[tuple[Any, ...]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module, _ = loaded_analyzer
    success_features = {"bpm": 120.0}
    permanent_features = {"_error": "unsupported audio", "_permanent": True}
    finalized = Future()
    finalized.set_result(("finalized", "/finalized.flac", success_features))
    successful = Future()
    successful.set_result(("successful", "/successful.flac", success_features))
    permanent = Future()
    permanent.set_result(("permanent", "/permanent.flac", permanent_features))
    pending = Future()
    running = Future()
    assert running.set_running_or_notify_cancel() is True
    futures_map = {
        finalized: ("finalized", "/finalized.flac"),
        successful: ("successful", "/successful.flac"),
        permanent: ("permanent", "/permanent.flac"),
        pending: ("pending", "/pending.flac"),
        running: ("running", "/running.flac"),
    }
    worker = object.__new__(module.AnalysisWorker)
    worker.db = FakeDatabaseConnection([{"id": "pending"}])
    worker.redis = FakeRedis()
    saved_results: list[tuple[str, str, dict[str, Any]]] = []
    saved_failures: list[tuple[str, str, bool]] = []
    requeues: list[tuple[list[tuple[str, str]], str]] = []

    monkeypatch.setattr(worker, "_save_results", lambda *args: saved_results.append(args))
    monkeypatch.setattr(
        worker,
        "_save_failed",
        lambda track_id, error, permanent=False: saved_failures.append(
            (track_id, error, permanent)
        ),
    )
    monkeypatch.setattr(
        worker,
        "_requeue_tracks_for_retry",
        lambda tracks, reason: requeues.append((tracks, reason)),
    )

    counts = worker._handle_batch_timeout(futures_map, {"finalized"})

    assert counts == (1, 1, 1, 1)
    assert saved_results == [
        ("successful", "/successful.flac", success_features),
    ]
    assert ("permanent", "unsupported audio", True) in saved_failures
    running_failure = next(call for call in saved_failures if call[0] == "running")
    assert "batch timeout" in running_failure[1].lower()
    assert running_failure[2] is False
    assert len(requeues) == 1
    assert requeues[0][0] == [("pending", "/pending.flac")]
    assert "batch timeout" in requeues[0][1].lower()
    assert pending.cancelled() is True


def test_analyzer_source_does_not_use_deprecated_datetime_utcnow() -> None:
    source = ANALYZER_PATH.read_text(encoding="utf-8")

    assert "datetime.utcnow" not in source
    assert "utcnow()" not in source
