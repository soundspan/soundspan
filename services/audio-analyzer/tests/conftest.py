"""Shared dependency stubs and fakes for audio-analyzer tests."""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


class Json:
    """Minimal psycopg2.extras.Json passthrough used during module loading."""

    def __init__(self, value: Any) -> None:
        self.value = value


class RealDictCursor:
    """Placeholder cursor factory used by the analyzer's type annotations."""


class FakeCursor:
    """Record SQL and return programmable result sets at the database boundary."""

    def __init__(
        self,
        results: list[list[dict[str, Any]]] | None = None,
        fail_on_execute: int | None = None,
    ) -> None:
        self.executions: list[tuple[str, Any]] = []
        self.results = list(results or [])
        self.fail_on_execute = fail_on_execute
        self.closed = False

    def execute(self, sql: str, params: Any = None) -> None:
        """Record one execution and optionally raise a programmed error."""
        self.executions.append((sql, params))
        if self.fail_on_execute == len(self.executions):
            raise RuntimeError("programmed database error")

    def fetchall(self) -> list[dict[str, Any]]:
        """Return the next programmed result set."""
        return self.results.pop(0) if self.results else []

    def fetchone(self) -> dict[str, Any] | None:
        """Return the first row from the next programmed result set."""
        rows = self.fetchall()
        return rows[0] if rows else None

    def close(self) -> None:
        """Record deterministic cursor cleanup."""
        self.closed = True


class FakeDatabaseConnection:
    """Expose recording transaction operations used by analyzer worker methods."""

    def __init__(
        self,
        results: list[list[dict[str, Any]]] | None = None,
        fail_on_execute: int | None = None,
    ) -> None:
        self.cursor = FakeCursor(results, fail_on_execute)
        self.get_cursor_calls = 0
        self.commit_calls = 0
        self.rollback_calls = 0

    def get_cursor(self) -> FakeCursor:
        """Return the recording cursor."""
        self.get_cursor_calls += 1
        return self.cursor

    def commit(self) -> None:
        """Record a transaction commit."""
        self.commit_calls += 1

    def rollback(self) -> None:
        """Record a transaction rollback."""
        self.rollback_calls += 1


class FakePipeline:
    """Record Redis queue pushes and pipeline execution."""

    def __init__(self) -> None:
        self.pushes: list[tuple[str, str]] = []
        self.deletes: list[str] = []
        self.execute_calls = 0

    def rpush(self, queue: str, payload: str) -> None:
        """Record one queued payload."""
        self.pushes.append((queue, payload))

    def delete(self, key: str) -> None:
        """Record one reservation deletion."""
        self.deletes.append(key)

    def execute(self) -> None:
        """Record pipeline execution."""
        self.execute_calls += 1


class FakeRedis:
    """Provide a recording pipeline without making network calls."""

    def __init__(self) -> None:
        self.queue_pipeline = FakePipeline()
        self.pipeline_calls = 0

    def pipeline(self) -> FakePipeline:
        """Return the recording pipeline."""
        self.pipeline_calls += 1
        return self.queue_pipeline


@pytest.fixture(scope="module")
def loaded_analyzer() -> Iterator[ModuleType]:
    """Load analyzer.py with lightweight Redis and psycopg2 stubs."""
    monkeypatch = pytest.MonkeyPatch()

    redis_stub = ModuleType("redis")

    class Redis:
        """Prevent accidental Redis connections from unit tests."""

        @staticmethod
        def from_url(*args: Any, **kwargs: Any) -> None:
            """Reject attempts to construct a real Redis client."""
            raise AssertionError("Redis must not be created by these unit tests")

    redis_stub.Redis = Redis  # type: ignore[attr-defined]

    psycopg2_stub = ModuleType("psycopg2")
    extras_stub = ModuleType("psycopg2.extras")

    def connect(*args: Any, **kwargs: Any) -> None:
        """Reject attempts to construct a real PostgreSQL connection."""
        raise AssertionError("PostgreSQL must not be created by these unit tests")

    psycopg2_stub.connect = connect  # type: ignore[attr-defined]
    psycopg2_stub.extras = extras_stub  # type: ignore[attr-defined]
    extras_stub.RealDictCursor = RealDictCursor  # type: ignore[attr-defined]
    extras_stub.Json = Json  # type: ignore[attr-defined]

    monkeypatch.delenv("NUM_WORKERS", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://stubbed-audio-analyzer")
    monkeypatch.delitem(sys.modules, "tensorflow", raising=False)
    monkeypatch.setitem(sys.modules, "redis", redis_stub)
    monkeypatch.setitem(sys.modules, "psycopg2", psycopg2_stub)
    monkeypatch.setitem(sys.modules, "psycopg2.extras", extras_stub)

    spec = importlib.util.spec_from_file_location("audio_analyzer_behavior_module", ANALYZER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    yield module
    monkeypatch.undo()
