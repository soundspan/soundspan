"""Behavioral tests for CLAP analyzer PostgreSQL transaction hygiene."""

import importlib.util
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ANALYZER_PATH = Path(__file__).resolve().parents[1] / "analyzer.py"


class RealDictCursor:
    """Placeholder cursor factory used by the analyzer import."""


class ResponseError(Exception):
    """Placeholder Redis response error used by handler exception clauses."""


class FakeRedisClient:
    """Placeholder client returned by the recording Redis constructor."""


class FakeCursor:
    """Model the transaction effects of a psycopg2 cursor."""

    def __init__(self, conn: "FakeConnection", cursor_factory: Any = None):
        self.conn = conn
        self.cursor_factory = cursor_factory
        self.closed = False
        self.executions: list[tuple[str, Any]] = []

    def execute(self, query: str, params: Any = None) -> None:
        self.executions.append((query, params))
        if not self.conn.autocommit:
            self.conn.in_transaction = True
        if self.conn.execute_error and self.conn.execute_error in query:
            raise RuntimeError("injected execute failure")

    def fetchone(self) -> dict[str, Any]:
        return self.conn.fetchone_result

    def close(self) -> None:
        self.closed = True


class FakeConnection:
    """Model the psycopg2 connection state relevant to this regression."""

    def __init__(self, fetchone_result: dict[str, Any] | None = None):
        self.autocommit = False
        self.in_transaction = False
        self.commit_calls = 0
        self.rollback_calls = 0
        self.close_calls = 0
        self.client_encodings: list[str] = []
        self.cursors: list[FakeCursor] = []
        self.fetchone_result = fetchone_result or {}
        self.execute_error: str | None = None

    def set_client_encoding(self, encoding: str) -> None:
        self.client_encodings.append(encoding)

    def cursor(self, cursor_factory: Any = None) -> FakeCursor:
        cursor = FakeCursor(self, cursor_factory)
        self.cursors.append(cursor)
        return cursor

    def commit(self) -> None:
        self.commit_calls += 1
        self.in_transaction = False

    def rollback(self) -> None:
        self.rollback_calls += 1
        self.in_transaction = False

    def close(self) -> None:
        self.close_calls += 1


def _stub_torch() -> ModuleType:
    """Build the minimal CPU-only torch module used during import."""
    torch_stub = ModuleType("torch")

    class Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    torch_stub.set_num_threads = lambda _count: None  # type: ignore[attr-defined]
    torch_stub.cuda = Cuda()  # type: ignore[attr-defined]
    torch_stub.device = lambda name: name  # type: ignore[attr-defined]
    return torch_stub


def _stub_redis() -> tuple[ModuleType, ModuleType]:
    """Build the Redis modules required during import."""
    redis_stub = ModuleType("redis")
    exceptions_stub = ModuleType("redis.exceptions")
    redis_stub.from_url = lambda *_args, **_kwargs: FakeRedisClient()  # type: ignore[attr-defined]
    redis_stub.exceptions = exceptions_stub  # type: ignore[attr-defined]
    exceptions_stub.ResponseError = ResponseError  # type: ignore[attr-defined]
    return redis_stub, exceptions_stub


def _stub_psycopg2() -> tuple[ModuleType, ModuleType]:
    """Build psycopg2 modules with a fail-closed connector."""
    psycopg2_stub = ModuleType("psycopg2")
    extras_stub = ModuleType("psycopg2.extras")

    def connect(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("stubbed PostgreSQL connection")

    psycopg2_stub.connect = connect  # type: ignore[attr-defined]
    psycopg2_stub.Error = Exception  # type: ignore[attr-defined]
    psycopg2_stub.extras = extras_stub  # type: ignore[attr-defined]
    extras_stub.RealDictCursor = RealDictCursor  # type: ignore[attr-defined]
    return psycopg2_stub, extras_stub


def _stub_pgvector() -> tuple[ModuleType, ModuleType]:
    """Build pgvector modules with a no-op registration hook."""
    pgvector_stub = ModuleType("pgvector")
    psycopg2_stub = ModuleType("pgvector.psycopg2")
    psycopg2_stub.register_vector = lambda _conn: None  # type: ignore[attr-defined]
    pgvector_stub.psycopg2 = psycopg2_stub  # type: ignore[attr-defined]
    return pgvector_stub, psycopg2_stub


def _stub_requests() -> ModuleType:
    """Build the requests module required during import."""
    requests_stub = ModuleType("requests")
    requests_stub.post = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    return requests_stub


@pytest.fixture(scope="module")
def loaded_analyzer() -> Iterator[ModuleType]:
    """Load analyzer.py once with hand-rolled dependency stubs."""
    monkeypatch = pytest.MonkeyPatch()
    redis_stub, redis_exceptions_stub = _stub_redis()
    psycopg2_stub, extras_stub = _stub_psycopg2()
    pgvector_stub, pgvector_psycopg2_stub = _stub_pgvector()

    monkeypatch.setitem(sys.modules, "torch", _stub_torch())
    monkeypatch.setitem(sys.modules, "redis", redis_stub)
    monkeypatch.setitem(sys.modules, "redis.exceptions", redis_exceptions_stub)
    monkeypatch.setitem(sys.modules, "psycopg2", psycopg2_stub)
    monkeypatch.setitem(sys.modules, "psycopg2.extras", extras_stub)
    monkeypatch.setitem(sys.modules, "pgvector", pgvector_stub)
    monkeypatch.setitem(sys.modules, "pgvector.psycopg2", pgvector_psycopg2_stub)
    monkeypatch.setitem(sys.modules, "librosa", ModuleType("librosa"))
    monkeypatch.setitem(sys.modules, "requests", _stub_requests())

    spec = importlib.util.spec_from_file_location("clap_transaction_hygiene_module", ANALYZER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    yield module
    monkeypatch.undo()


def _connect_database(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    conn: FakeConnection,
) -> Any:
    """Connect a database wrapper to a fake psycopg2 connection."""
    monkeypatch.setattr(module.psycopg2, "connect", lambda *_args, **_kwargs: conn)

    def register_vector(fake_conn: FakeConnection) -> None:
        cursor = fake_conn.cursor()
        cursor.execute("SELECT typname, oid FROM pg_type")
        cursor.close()

    monkeypatch.setattr(module, "register_vector", register_vector)
    database = module.DatabaseConnection("postgresql://test")
    database.connect()
    return database


def test_connect_registration_does_not_open_transaction(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = FakeConnection()

    _connect_database(loaded_analyzer, monkeypatch, conn)

    assert conn.autocommit is True
    assert conn.in_transaction is False
    assert conn.client_encodings == ["UTF8"]
    assert conn.cursors[0].executions == [("SELECT typname, oid FROM pg_type", None)]
    assert conn.cursors[0].closed is True


def test_is_connected_does_not_open_transaction(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = FakeConnection()
    database = _connect_database(loaded_analyzer, monkeypatch, conn)

    connected = database.is_connected()

    assert connected is True
    assert conn.in_transaction is False
    assert conn.cursors[-1].executions == [("SELECT 1", None)]
    assert conn.cursors[-1].closed is True


def test_empty_work_poll_does_not_open_transaction(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = FakeConnection({"cnt": 2})
    database = _connect_database(loaded_analyzer, monkeypatch, conn)
    unload_calls: list[bool] = []

    class FakeAnalyzer:
        def unload_model(self) -> None:
            unload_calls.append(True)

    class FakeQueueClient:
        def llen(self, queue_name: str) -> int:
            assert queue_name == loaded_analyzer.ANALYSIS_QUEUE
            return 0

    loaded_analyzer._check_for_completed_work(FakeAnalyzer(), database, FakeQueueClient())

    idle_cursor = conn.cursors[-1]
    assert 'SELECT COUNT(*) as cnt FROM "Track"' in idle_cursor.executions[0][0]
    assert idle_cursor.closed is True
    assert conn.in_transaction is False
    assert unload_calls == []


def test_worker_update_succeeds_under_autocommit_and_rolls_back_failure(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = FakeConnection()
    database = _connect_database(loaded_analyzer, monkeypatch, conn)
    worker = loaded_analyzer.Worker(1, None, threading.Event())
    worker.db = database

    worker._update_track_status("track-1", "processing")

    update_cursor = conn.cursors[-1]
    assert 'UPDATE "Track"' in update_cursor.executions[0][0]
    assert update_cursor.executions[0][1][0] == "processing"
    assert update_cursor.executions[0][1][2] == "track-1"
    assert conn.commit_calls == 1
    assert conn.rollback_calls == 0
    assert conn.in_transaction is False
    assert update_cursor.closed is True

    conn.execute_error = 'UPDATE "Track"'
    worker._update_track_status("track-1", "failed")

    assert conn.commit_calls == 1
    assert conn.rollback_calls == 1
    assert conn.in_transaction is False
    assert conn.cursors[-1].closed is True
