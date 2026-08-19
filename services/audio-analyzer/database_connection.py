"""Self-healing PostgreSQL connection manager for the audio analyzer."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Protocol

import psycopg2
from psycopg2.extras import RealDictCursor

logger = logging.getLogger("audio-analyzer")


class _DatabaseCursor(Protocol):
    """Describe cursor operations used by analyzer persistence."""

    def execute(self, query: object, params: object = None) -> None: ...

    def fetchone(self) -> Mapping[str, Any] | None: ...

    def fetchall(self) -> list[Mapping[str, Any]]: ...

    def close(self) -> None: ...


class _PostgresConnection(Protocol):
    """Describe the psycopg2 connection surface owned by this manager."""

    closed: int
    autocommit: bool

    def set_client_encoding(self, encoding: str) -> None: ...

    def cursor(self, *, cursor_factory: object) -> _DatabaseCursor: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def close(self) -> None: ...


class DatabaseConnection:
    """Own one analyzer PostgreSQL connection and bounded cursor recovery."""

    def __init__(self, url: str) -> None:
        """Store the connection URL and initialize disconnected state."""
        self.url = url
        self.conn: _PostgresConnection | None = None

    def connect(self) -> None:
        """Establish a database connection with explicit UTF-8 encoding."""
        if not self.url:
            raise ValueError("DATABASE_URL not set")
        connection = psycopg2.connect(self.url, options="-c client_encoding=UTF8")
        try:
            connection.set_client_encoding("UTF8")
            connection.autocommit = False
        except Exception:
            try:
                connection.close()
            except Exception:
                logger.debug(
                    "Ignoring error while closing an uninitialized PostgreSQL connection",
                    exc_info=True,
                )
            raise
        self.conn = connection
        logger.info("Connected to PostgreSQL with UTF-8 encoding")

    def get_cursor(self) -> _DatabaseCursor:
        """Return a dictionary cursor, reconnecting once after connection loss."""
        if self.conn is None or self.conn.closed:
            self.connect()
        connection = self._require_connection()
        try:
            return connection.cursor(cursor_factory=RealDictCursor)
        except (psycopg2.InterfaceError, psycopg2.OperationalError):
            self._discard_connection()
            self.connect()
            return self._require_connection().cursor(cursor_factory=RealDictCursor)

    def commit(self) -> None:
        """Commit once, resetting future work after a connection failure."""
        connection = self.conn
        if connection is None:
            raise psycopg2.InterfaceError("Cannot commit without a PostgreSQL connection")
        if connection.closed:
            self.conn = None
            raise psycopg2.InterfaceError("Cannot commit a closed PostgreSQL connection")
        try:
            connection.commit()
        except (psycopg2.InterfaceError, psycopg2.OperationalError):
            self._discard_connection()
            raise

    def rollback(self) -> None:
        """Roll back when possible without masking an earlier connection error."""
        if self.conn is None:
            return
        if self.conn.closed:
            self.conn = None
            return
        try:
            connection = self.conn
            connection.rollback()
        except (psycopg2.InterfaceError, psycopg2.OperationalError):
            self._discard_connection()

    def close(self) -> None:
        """Close and detach the current connection."""
        connection = self.conn
        self.conn = None
        if connection is not None:
            connection.close()

    def _discard_connection(self) -> None:
        """Detach a failed connection while suppressing defensive-close errors."""
        connection = self.conn
        self.conn = None
        if connection is None:
            return
        try:
            connection.close()
        except Exception:
            logger.debug("Ignoring error while discarding PostgreSQL connection", exc_info=True)

    def _require_connection(self) -> _PostgresConnection:
        """Return the established connection or fail on a broken connect contract."""
        if self.conn is None:
            raise RuntimeError("PostgreSQL connect returned without a connection")
        return self.conn
