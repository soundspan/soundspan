"""Claim-based, resumable AcoustID lookup processing."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Protocol

from acoustid_lookup import AcoustIDCandidate, AcoustIDClient, AcoustIDLookupError

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("AcoustIDBackfill")

DEFAULT_LOOKUP_BATCH_SIZE = 10
MAX_LOOKUP_BATCHES_PER_PASS = 1000
MAX_LOOKUP_RETRIES = 3
STALE_LOOKUP_MINUTES = 15
LOOKUP_OWNER_KEY = "soundspan:acoustid-lookup"


def _never_stop() -> bool:
    """Provide the default continuation signal for synchronous callers."""
    return False


ACQUIRE_LOOKUP_OWNER_SQL = """
    SELECT
        pg_try_advisory_lock(hashtextextended(%s, 0)) AS acquired,
        pg_backend_pid() AS backend_pid
"""

CURRENT_BACKEND_PID_SQL = "SELECT pg_backend_pid() AS backend_pid"

RELEASE_LOOKUP_OWNER_SQL = """
    SELECT pg_advisory_unlock(hashtextextended(%s, 0)) AS released
"""

CLAIM_LOOKUPS_SQL = """
    SELECT "trackId", fingerprint, duration
    FROM "TrackFingerprint"
    WHERE (
        "lookupStatus" = 'pending'
        OR (
            "lookupStatus" = 'processing'
            AND "lookupStartedAt" < NOW() - (%s * INTERVAL '1 minute')
        )
    )
    AND "lookupRetryCount" < %s
    ORDER BY "fingerprintedAt" ASC
    LIMIT %s
    FOR UPDATE SKIP LOCKED
"""

MARK_CLAIMED_SQL = """
    UPDATE "TrackFingerprint"
    SET "lookupStatus" = 'processing',
        "lookupStartedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "trackId" = ANY(%s)
    AND "lookupStatus" IN ('pending', 'processing')
    RETURNING "trackId"
"""

SAVE_LOOKUP_SQL = """
    UPDATE "TrackFingerprint"
    SET "recordingMbid" = %s,
        "releaseGroupMbid" = %s,
        score = %s,
        "lookupStatus" = 'completed',
        "lookupStartedAt" = NULL,
        "lookupError" = NULL,
        "lookedUpAt" = NOW(),
        "updatedAt" = NOW()
    WHERE "trackId" = %s
      AND fingerprint = %s
      AND "lookupStatus" = 'processing'
    RETURNING "trackId"
"""

SAVE_LOOKUP_FAILURE_SQL = """
    UPDATE "TrackFingerprint"
    SET "lookupStatus" = CASE
            WHEN "lookupRetryCount" + 1 >= 3 THEN 'failed'
            ELSE 'pending'
        END,
        "lookupRetryCount" = "lookupRetryCount" + 1,
        "lookupStartedAt" = NULL,
        "lookupError" = %s,
        "updatedAt" = NOW()
    WHERE "trackId" = %s
      AND fingerprint = %s
      AND "lookupStatus" = 'processing'
    RETURNING "trackId"
"""


class _Cursor(Protocol):
    """Describe cursor operations used by lookup claims."""

    def execute(self, query: object, params: object = None) -> None: ...

    def fetchall(self) -> list[Mapping[str, Any]]: ...

    def fetchone(self) -> Mapping[str, Any] | None: ...

    def close(self) -> None: ...


class Database(Protocol):
    """Describe transaction operations used by lookup processing."""

    def get_cursor(self) -> _Cursor: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...


class LookupClient(Protocol):
    """Describe the AcoustID client seam used by the claim processor."""

    def lookup(self, fingerprint: str, duration: int) -> AcoustIDCandidate | None: ...


def _acquire_lookup_owner(database: Database) -> int | None:
    """Acquire the deployment-wide lock and return its owning backend PID."""
    cursor = database.get_cursor()
    try:
        cursor.execute(ACQUIRE_LOOKUP_OWNER_SQL, (LOOKUP_OWNER_KEY,))
        row = cursor.fetchone()
        if row is None or row.get("acquired") is not True:
            database.commit()
            return None
        backend_pid = row.get("backend_pid")
        if not isinstance(backend_pid, int):
            raise RuntimeError("AcoustID lookup owner query returned no backend PID")
        return backend_pid
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _current_backend_pid(database: Database) -> int:
    """Return the current PostgreSQL session identifier."""
    cursor = database.get_cursor()
    try:
        cursor.execute(CURRENT_BACKEND_PID_SQL)
        row = cursor.fetchone()
        backend_pid = row.get("backend_pid") if row is not None else None
        if not isinstance(backend_pid, int):
            raise RuntimeError("AcoustID lookup session query returned no backend PID")
        return backend_pid
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _release_lookup_owner(database: Database) -> None:
    """Release the deployment-wide lookup owner after every batch outcome."""
    cursor = database.get_cursor()
    try:
        cursor.execute(RELEASE_LOOKUP_OWNER_SQL, (LOOKUP_OWNER_KEY,))
        database.commit()
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def lookup_result_values(
    track_id: str,
    fingerprint: str,
    candidate: AcoustIDCandidate | None,
) -> tuple[str | float | None, ...]:
    """Build positional values for one completed lookup."""
    if candidate is None:
        return (None, None, None, track_id, fingerprint)
    return (
        candidate["recordingMbid"],
        candidate["releaseGroupMbid"],
        candidate["score"],
        track_id,
        fingerprint,
    )


def _claim_batch(database: Database, batch_size: int) -> list[Mapping[str, Any]]:
    """Atomically claim one bounded batch and return rows retained by the update."""
    cursor = database.get_cursor()
    try:
        cursor.execute(
            CLAIM_LOOKUPS_SQL,
            (STALE_LOOKUP_MINUTES, MAX_LOOKUP_RETRIES, batch_size),
        )
        rows = cursor.fetchall()
        if not rows:
            database.commit()
            return []
        track_ids = [row["trackId"] for row in rows]
        cursor.execute(MARK_CLAIMED_SQL, (track_ids,))
        claimed_ids = {row["trackId"] for row in cursor.fetchall()}
        database.commit()
        return [row for row in rows if row["trackId"] in claimed_ids]
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _save_completed(
    database: Database,
    track_id: str,
    fingerprint: str,
    candidate: AcoustIDCandidate | None,
) -> bool:
    """Persist one completed lookup in its own bounded transaction."""
    cursor = database.get_cursor()
    try:
        cursor.execute(SAVE_LOOKUP_SQL, lookup_result_values(track_id, fingerprint, candidate))
        saved = cursor.fetchone() is not None
        database.commit()
        return saved
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _save_failure(database: Database, track_id: str, fingerprint: str, error: Exception) -> bool:
    """Release one failed claim for a bounded future retry."""
    cursor = database.get_cursor()
    try:
        cursor.execute(SAVE_LOOKUP_FAILURE_SQL, (type(error).__name__, track_id, fingerprint))
        saved = cursor.fetchone() is not None
        database.commit()
        return saved
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


class AcoustIDBackfill:
    """Claim and process persisted fingerprints when an API key is configured."""

    def __init__(
        self,
        database: Database,
        api_key: str,
        *,
        client: LookupClient | None = None,
        batch_size: int = DEFAULT_LOOKUP_BATCH_SIZE,
    ) -> None:
        self._database = database
        self._enabled = bool(api_key)
        self._client = client or (AcoustIDClient(api_key) if api_key else None)
        self._batch_size = max(1, min(100, batch_size))

    def run_once(self, stop_requested: Callable[[], bool] = _never_stop) -> bool:
        """Drain one bounded lookup pass under a deployment-wide owner lock."""
        if not self._enabled:
            return False
        if self._client is None:
            raise RuntimeError("enabled AcoustID backfill requires a lookup client")
        owner_pid = _acquire_lookup_owner(self._database)
        if owner_pid is None:
            return False
        ownership_lost = False
        try:
            found_work, ownership_lost = self._run_owned_pass(owner_pid, stop_requested)
            return found_work
        finally:
            # A reconnected session never owned the lock (Postgres released
            # it with the old session), so unlocking there would only raise
            # a server-side warning about releasing an un-owned lock.
            if not ownership_lost:
                _release_lookup_owner(self._database)

    def _run_owned_pass(
        self, owner_pid: int, stop_requested: Callable[[], bool]
    ) -> tuple[bool, bool]:
        """Process bounded batches; returns (found_work, ownership_lost)."""
        found_work = False
        for _ in range(MAX_LOOKUP_BATCHES_PER_PASS):
            if stop_requested():
                return found_work, False
            current_pid = _current_backend_pid(self._database)
            if current_pid != owner_pid:
                logger.warning(
                    "AcoustID lookup owner session changed from backend PID %s to %s; "
                    "aborting pass",
                    owner_pid,
                    current_pid,
                )
                return found_work, True
            rows = _claim_batch(self._database, self._batch_size)
            if not rows:
                return found_work, False
            found_work = True
            completed, failed = self._process_rows(rows, stop_requested)
            logger.info(
                "AcoustID lookup batch complete: %s claimed, %s completed, %s failed",
                len(rows),
                completed,
                failed,
            )
        logger.warning(
            "AcoustID lookup pass reached its %s-batch limit", MAX_LOOKUP_BATCHES_PER_PASS
        )
        return found_work, False

    def _process_rows(
        self,
        rows: list[Mapping[str, Any]],
        stop_requested: Callable[[], bool] = _never_stop,
    ) -> tuple[int, int]:
        """Look up and persist one bounded claimed batch."""
        if self._client is None:
            raise RuntimeError("enabled AcoustID backfill requires a lookup client")
        completed = 0
        failed = 0
        for row in rows:
            # Shutdown must not wait out the rest of the batch; unprocessed
            # claims recover via the stale-claim sweep.
            if stop_requested():
                break
            track_id = str(row["trackId"])
            fingerprint = str(row["fingerprint"])
            try:
                candidate = self._client.lookup(fingerprint, int(row["duration"]))
                if _save_completed(self._database, track_id, fingerprint, candidate):
                    completed += 1
            except AcoustIDLookupError as error:
                if _save_failure(self._database, track_id, fingerprint, error):
                    failed += 1
        return completed, failed
