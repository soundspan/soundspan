"""Behavioral coverage for analyzer PostgreSQL connection recovery."""

from __future__ import annotations

from collections.abc import Callable
from types import ModuleType
from typing import Any

import pytest


class FakeConnection:
    """Expose programmable psycopg2 connection operations."""

    def __init__(
        self,
        cursor_results: list[object] | None = None,
        *,
        closed: bool = False,
        commit_error: Exception | None = None,
        rollback_error: Exception | None = None,
        encoding_error: Exception | None = None,
    ) -> None:
        self.closed = closed
        self.autocommit = True
        self.cursor_results = list(cursor_results or [])
        self.commit_error = commit_error
        self.rollback_error = rollback_error
        self.encoding_error = encoding_error
        self.client_encodings: list[str] = []
        self.cursor_calls = 0
        self.commit_calls = 0
        self.rollback_calls = 0
        self.close_calls = 0

    def set_client_encoding(self, encoding: str) -> None:
        """Record client setup and raise its programmed failure."""
        self.client_encodings.append(encoding)
        if self.encoding_error is not None:
            raise self.encoding_error

    def cursor(self, *, cursor_factory: object) -> object:
        """Return or raise the next programmed cursor result."""
        assert cursor_factory is not None
        self.cursor_calls += 1
        result = self.cursor_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def commit(self) -> None:
        """Record a commit and raise its programmed failure."""
        self.commit_calls += 1
        if self.commit_error is not None:
            raise self.commit_error

    def rollback(self) -> None:
        """Record a rollback and raise its programmed failure."""
        self.rollback_calls += 1
        if self.rollback_error is not None:
            raise self.rollback_error

    def close(self) -> None:
        """Record closure and mark the connection closed."""
        self.close_calls += 1
        self.closed = True


def _replace_connection_on_connect(
    database: Any,
    connections: list[FakeConnection],
    calls: list[None],
) -> Callable[[], None]:
    """Return a connect replacement that installs one programmed connection."""

    def connect() -> None:
        calls.append(None)
        database.conn = connections.pop(0)

    return connect


def test_get_cursor_reconnects_when_connection_is_closed(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replace a server-closed connection before requesting a cursor."""
    expected_cursor = object()
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = FakeConnection(closed=True)
    connect_calls: list[None] = []
    monkeypatch.setattr(
        database,
        "connect",
        _replace_connection_on_connect(
            database,
            [FakeConnection([expected_cursor])],
            connect_calls,
        ),
    )

    cursor = database.get_cursor()

    assert cursor is expected_cursor
    assert len(connect_calls) == 1


def test_connect_does_not_publish_connection_when_client_setup_fails(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Close a partially configured connection without publishing it."""
    connection = FakeConnection(encoding_error=RuntimeError("encoding setup failed"))
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    monkeypatch.setattr(
        loaded_analyzer.psycopg2,
        "connect",
        lambda *_args, **_kwargs: connection,
    )

    with pytest.raises(RuntimeError, match="encoding setup failed"):
        database.connect()

    assert database.conn is None
    assert connection.client_encodings == ["UTF8"]
    assert connection.close_calls == 1


def test_get_cursor_reconnects_once_after_interface_error(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retry cursor creation once on a transient connection failure."""
    expected_cursor = object()
    initial = FakeConnection([loaded_analyzer.psycopg2.InterfaceError("closed")])
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = initial
    connect_calls: list[None] = []
    monkeypatch.setattr(
        database,
        "connect",
        _replace_connection_on_connect(
            database,
            [FakeConnection([expected_cursor])],
            connect_calls,
        ),
    )

    cursor = database.get_cursor()

    assert cursor is expected_cursor
    assert initial.close_calls == 1
    assert len(connect_calls) == 1


def test_get_cursor_propagates_after_one_failed_retry(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bound cursor recovery to one reconnect attempt."""
    error_type = loaded_analyzer.psycopg2.OperationalError
    initial = FakeConnection([error_type("first failure")])
    replacement = FakeConnection([error_type("retry failure")])
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = initial
    connect_calls: list[None] = []
    monkeypatch.setattr(
        database,
        "connect",
        _replace_connection_on_connect(database, [replacement], connect_calls),
    )

    with pytest.raises(error_type, match="retry failure"):
        database.get_cursor()

    assert initial.cursor_calls == 1
    assert replacement.cursor_calls == 1
    assert len(connect_calls) == 1


def test_rollback_clears_a_closed_connection_without_raising(
    loaded_analyzer: ModuleType,
) -> None:
    """Drop a dead connection without creating a secondary rollback error."""
    connection = FakeConnection(closed=True)
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = connection

    database.rollback()

    assert connection.rollback_calls == 0
    assert database.conn is None


def test_rollback_connection_error_is_suppressed_and_clears_connection(
    loaded_analyzer: ModuleType,
) -> None:
    """Suppress rollback connection failures so callers retain the first error."""
    connection = FakeConnection(
        rollback_error=loaded_analyzer.psycopg2.InterfaceError("closed during rollback")
    )
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = connection

    database.rollback()

    assert connection.rollback_calls == 1
    assert connection.close_calls == 1
    assert database.conn is None


def test_commit_connection_error_propagates_without_retry(
    loaded_analyzer: ModuleType,
) -> None:
    """Surface an ambiguous commit failure and reset only future work."""
    error_type = loaded_analyzer.psycopg2.OperationalError
    connection = FakeConnection(commit_error=error_type("commit lost connection"))
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = connection

    with pytest.raises(error_type, match="commit lost connection"):
        database.commit()

    assert connection.commit_calls == 1
    assert connection.close_calls == 1
    assert database.conn is None


def test_commit_without_connection_raises_interface_error(
    loaded_analyzer: ModuleType,
) -> None:
    """Reject a commit when no transaction-owning connection exists."""
    database = loaded_analyzer.DatabaseConnection("postgresql://test")

    with pytest.raises(loaded_analyzer.psycopg2.InterfaceError, match="commit"):
        database.commit()


def test_commit_with_closed_connection_raises_interface_error(
    loaded_analyzer: ModuleType,
) -> None:
    """Reject a commit after the transaction-owning connection has closed."""
    connection = FakeConnection(closed=True)
    database = loaded_analyzer.DatabaseConnection("postgresql://test")
    database.conn = connection

    with pytest.raises(loaded_analyzer.psycopg2.InterfaceError, match="commit"):
        database.commit()

    assert connection.commit_calls == 0
    assert database.conn is None


@pytest.mark.parametrize("error_name", ["InterfaceError", "OperationalError"])
def test_connection_error_classification_accepts_psycopg2_disconnects(
    loaded_analyzer: ModuleType,
    error_name: str,
) -> None:
    """Classify both psycopg2 connection-failure families for fast recovery."""
    error_type = getattr(loaded_analyzer.psycopg2, error_name)

    assert loaded_analyzer._is_connection_error(error_type("database unavailable")) is True


def test_connection_error_classification_rejects_other_failures(
    loaded_analyzer: ModuleType,
) -> None:
    """Keep the existing five-error threshold for non-database failures."""
    assert loaded_analyzer._is_connection_error(RuntimeError("analysis failed")) is False


def test_worker_connection_error_invokes_recovery_before_loop_sleep(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Run recovery immediately when the worker sees a database disconnect."""
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.consecutive_empty = 0
    events: list[tuple[str, int | None]] = []
    monkeypatch.setattr(worker, "_recover_worker", lambda: events.append(("recover", None)))
    monkeypatch.setattr(
        loaded_analyzer.time,
        "sleep",
        lambda seconds: events.append(("sleep", seconds)),
    )
    monkeypatch.setattr(loaded_analyzer.traceback, "print_exc", lambda: None)

    worker._handle_worker_error(loaded_analyzer.psycopg2.InterfaceError("closed"))

    assert events == [("recover", None), ("sleep", loaded_analyzer.BRPOP_TIMEOUT)]
    assert worker.consecutive_empty == 0


def test_worker_other_errors_keep_five_error_recovery_threshold(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Delay recovery for an ordinary worker failure until its fifth occurrence."""
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.consecutive_empty = 3
    recoveries: list[None] = []
    monkeypatch.setattr(worker, "_recover_worker", lambda: recoveries.append(None))
    monkeypatch.setattr(loaded_analyzer.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(loaded_analyzer.traceback, "print_exc", lambda: None)

    worker._handle_worker_error(RuntimeError("analysis failed"))
    assert recoveries == []
    assert worker.consecutive_empty == 4

    worker._handle_worker_error(RuntimeError("analysis failed again"))
    assert recoveries == [None]
    assert worker.consecutive_empty == 0
