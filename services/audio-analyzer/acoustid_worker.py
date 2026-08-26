"""Independently scheduled AcoustID lookup worker lifecycle."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Protocol

from acoustid_backfill import AcoustIDBackfill, Database

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("AcoustIDWorker")

WORKER_STOP_JOIN_TIMEOUT_SECONDS = 15.0

DEFAULT_LOOKUP_CADENCE_SECONDS = 30.0


class _Database(Database, Protocol):
    """Describe the independently owned database connection lifecycle."""

    def connect(self) -> None: ...

    def close(self) -> None: ...


class _Backfill(Protocol):
    """Describe one deployment-locked lookup pass."""

    def run_once(self, stop_requested: Callable[[], bool]) -> bool: ...


DatabaseFactory = Callable[[str], _Database]
BackfillFactory = Callable[[_Database, str], _Backfill]


def _create_database(database_url: str) -> _Database:
    """Construct the runtime database lazily for dependency-light unit tests."""
    from database_connection import DatabaseConnection

    return DatabaseConnection(database_url)


class AcoustIDLookupWorker:
    """Run lookup passes away from the synchronous track-analysis loop."""

    def __init__(
        self,
        database_url: str,
        api_key: str,
        *,
        database_factory: DatabaseFactory = _create_database,
        backfill_factory: BackfillFactory = AcoustIDBackfill,
        cadence_seconds: float = DEFAULT_LOOKUP_CADENCE_SECONDS,
    ) -> None:
        self._database_url = database_url
        self._api_key = api_key
        self._database_factory = database_factory
        self._backfill_factory = backfill_factory
        self._cadence_seconds = max(1.0, cadence_seconds)
        self._stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        """Start one owned lookup thread when AcoustID is configured."""
        if not self._api_key or (self.thread is not None and self.thread.is_alive()):
            return
        self._stop_event.clear()
        self.thread = threading.Thread(
            target=self._run,
            name="acoustid-lookup",
            daemon=True,
        )
        self.thread.start()

    def stop(self) -> None:
        """Signal shutdown and wait briefly for the lookup thread to close."""
        self._stop_event.set()
        if self.thread is not None:
            # The stop signal and bounded join preserve graceful shutdown. A daemon
            # fallback is safe because stale claims recover after 15 minutes and
            # success/failure writes use compare-and-set guards against stale state.
            self.thread.join(timeout=WORKER_STOP_JOIN_TIMEOUT_SECONDS)
            if self.thread.is_alive():
                logger.warning(
                    "AcoustID lookup thread did not stop within %ss",
                    WORKER_STOP_JOIN_TIMEOUT_SECONDS,
                )

    def _run(self) -> None:
        """Own a database session and retry lookup passes at a fixed cadence."""
        database = self._database_factory(self._database_url)
        try:
            database.connect()
            backfill = self._backfill_factory(database, self._api_key)
            while not self._stop_event.is_set():
                try:
                    backfill.run_once(self._stop_event.is_set)
                except Exception:
                    logger.exception("AcoustID lookup pass failed")
                if self._stop_event.wait(self._cadence_seconds):
                    return
        finally:
            database.close()
