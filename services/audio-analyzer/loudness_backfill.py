"""Sequential persistence flow for loudness-only analyzer queue jobs."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal, Protocol, TypedDict

from loudness import (
    ALBUM_LOUDNESS_ROLLUP_SQL,
    LoudnessMeasurement,
    measure_loudness,
)

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("LoudnessBackfill")

LOUDNESS_ATTEMPT_KEY_PREFIX = "audio:analysis:loudness:attempts:"
LOUDNESS_OUTCOME_KEY_PREFIX = "audio:analysis:loudness:outcomes:"
LOUDNESS_BACKFILL_MAX_FAILURES = 3
MAX_LOUDNESS_ATTEMPT_KEY_BYTES = 160

LoudnessBackfillOutcome = Literal[
    "measured_success",
    "transient_failure",
    "permanently_skipped",
]
JobResult = Literal["already_measured", "measured", "failed"]

_SELECT_TRACK_LOUDNESS_SQL = """
    SELECT "loudnessLufs"
    FROM "Track"
    WHERE id = %s
"""

_SAVE_TRACK_LOUDNESS_SQL = """
    UPDATE "Track"
    SET "loudnessLufs" = %s,
        "truePeakDb" = %s
    WHERE id = %s
    AND "loudnessLufs" IS NULL
    RETURNING id
"""


class AnalysisQueueJob(TypedDict, total=False):
    """Fields accepted from one audio-analysis Redis payload."""

    trackId: str
    filePath: str
    duration: int
    loudnessOnly: bool
    loudnessAttemptKey: str


class LoudnessBackfillBookkeeping(Protocol):
    """Durable attempt and outcome operations required by backfill jobs."""

    def clear_failures(self, attempt_key: str) -> None:
        """Clear failures after the content revision is measured or stale."""

    def increment_failures(self, attempt_key: str) -> int:
        """Increment and return consecutive failures for one content revision."""

    def increment_outcome(self, outcome: LoudnessBackfillOutcome) -> None:
        """Increment one durable bounded outcome counter."""


class RedisBookkeepingClient(Protocol):
    """Redis counter operations required by loudness backfill bookkeeping."""

    def delete(self, key: str) -> object:
        """Delete one failure counter."""

    def incr(self, key: str) -> object:
        """Increment and return one counter."""


class RedisLoudnessBackfillBookkeeping:
    """Persist loudness failure budgets and bounded outcomes in Redis."""

    def __init__(self, redis_client: RedisBookkeepingClient) -> None:
        self.redis = redis_client

    def clear_failures(self, attempt_key: str) -> None:
        """Clear the loudness failure budget for one measured content revision."""
        self.redis.delete(attempt_key)

    def increment_failures(self, attempt_key: str) -> int:
        """Increment one content revision's durable loudness failure count."""
        attempts = self.redis.incr(attempt_key)
        if isinstance(attempts, bool) or not isinstance(attempts, int):
            raise RuntimeError("Redis returned an invalid loudness failure count")
        if attempts < 1:
            raise RuntimeError("Redis returned a non-positive loudness failure count")
        return attempts

    def increment_outcome(self, outcome: LoudnessBackfillOutcome) -> None:
        """Increment one durable loudness backfill outcome counter."""
        self.redis.incr(f"{LOUDNESS_OUTCOME_KEY_PREFIX}{outcome}")


class Cursor(Protocol):
    """Database cursor operations required by loudness persistence."""

    def execute(self, sql: str, params: object = None) -> None:
        """Execute one parameterized statement."""

    def fetchone(self) -> Mapping[str, Any] | None:
        """Return one result row when present."""

    def close(self) -> None:
        """Close the cursor."""


class Database(Protocol):
    """Transaction operations required by loudness persistence."""

    def get_cursor(self) -> Cursor:
        """Return a database cursor."""

    def commit(self) -> None:
        """Commit the current transaction."""

    def rollback(self) -> None:
        """Roll back the current transaction."""


ReleaseReservations = Callable[[list[tuple[str, str]]], None]
ResolvePath = Callable[[str], str | None]
MeasureLoudness = Callable[[str, int], LoudnessMeasurement | None]
PathExists = Callable[[str], bool]
PathSize = Callable[[str], int]


def partition_analysis_jobs(
    jobs: Sequence[AnalysisQueueJob],
) -> tuple[list[tuple[str, str]], list[AnalysisQueueJob]]:
    """Partition queue payloads into normal ML and loudness-only work."""
    normal: list[tuple[str, str]] = []
    loudness_only: list[AnalysisQueueJob] = []
    for job in jobs:
        if job.get("loudnessOnly") is True:
            loudness_only.append(job)
        else:
            normal.append((job["trackId"], job.get("filePath", "")))
    return normal, loudness_only


def _already_measured(database: Database, track_id: str) -> bool:
    """Close the read transaction and report whether work should be skipped."""
    cursor = database.get_cursor()
    try:
        cursor.execute(_SELECT_TRACK_LOUDNESS_SQL, (track_id,))
        row = cursor.fetchone()
        database.commit()
        return row is None or row.get("loudnessLufs") is not None
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _resolve_eligible_path(
    file_path: str,
    resolve_path: ResolvePath,
    max_file_size_mb: int,
    path_exists: PathExists,
    path_size: PathSize,
) -> str | None:
    """Apply containment, existence, and configured file-size guards."""
    resolved_path = resolve_path(file_path)
    if resolved_path is None or not path_exists(resolved_path):
        return None
    if max_file_size_mb <= 0:
        return resolved_path
    file_size_mb = path_size(resolved_path) / (1024 * 1024)
    return resolved_path if file_size_mb <= max_file_size_mb else None


def _persist_measurement(
    database: Database,
    track_id: str,
    measurement: LoudnessMeasurement,
) -> bool:
    """Save a raced-safe track measurement and its album rollup."""
    cursor = database.get_cursor()
    try:
        cursor.execute(
            _SAVE_TRACK_LOUDNESS_SQL,
            (measurement["loudnessLufs"], measurement["truePeakDb"], track_id),
        )
        updated = cursor.fetchone()
        if updated is not None:
            cursor.execute(ALBUM_LOUDNESS_ROLLUP_SQL, (track_id,))
        database.commit()
        return updated is not None
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _process_job(
    job: AnalysisQueueJob,
    database: Database,
    resolve_path: ResolvePath,
    max_file_size_mb: int,
    timeout_seconds: int,
    measure: MeasureLoudness,
    path_exists: PathExists,
    path_size: PathSize,
) -> JobResult:
    """Measure and persist one eligible loudness-only queue job."""
    track_id = job["trackId"]
    file_path = job.get("filePath", "")
    if _already_measured(database, track_id):
        return "already_measured"
    resolved_path = _resolve_eligible_path(
        file_path,
        resolve_path,
        max_file_size_mb,
        path_exists,
        path_size,
    )
    if resolved_path is None:
        logger.warning("Skipping ineligible loudness backfill file for track %s", track_id)
        return "failed"
    measurement = measure(resolved_path, timeout_seconds)
    if measurement is None:
        logger.warning("Loudness backfill measurement failed for track %s", track_id)
        return "failed"
    persisted = _persist_measurement(database, track_id, measurement)
    return "measured" if persisted else "already_measured"


def _validated_attempt_key(job: AnalysisQueueJob) -> str | None:
    """Return a bounded producer-owned attempt key from an internal queue job."""
    attempt_key = job.get("loudnessAttemptKey")
    if not isinstance(attempt_key, str):
        return None
    if not attempt_key.startswith(LOUDNESS_ATTEMPT_KEY_PREFIX):
        return None
    if len(attempt_key.encode("utf-8")) > MAX_LOUDNESS_ATTEMPT_KEY_BYTES:
        return None
    return attempt_key


def _record_job_result(
    job: AnalysisQueueJob,
    result: JobResult,
    bookkeeping: LoudnessBackfillBookkeeping,
) -> None:
    """Persist the bounded attempt transition and its final outcome."""
    attempt_key = _validated_attempt_key(job)
    track_id = job["trackId"]
    if attempt_key is None:
        logger.warning("Permanently skipping loudness backfill with invalid attempt key")
        bookkeeping.increment_outcome("permanently_skipped")
        return
    if result == "already_measured":
        bookkeeping.clear_failures(attempt_key)
        return
    if result == "measured":
        bookkeeping.clear_failures(attempt_key)
        bookkeeping.increment_outcome("measured_success")
        return

    attempts = bookkeeping.increment_failures(attempt_key)
    if attempts >= LOUDNESS_BACKFILL_MAX_FAILURES:
        logger.warning(
            "Permanently skipping loudness backfill for track %s after %s failures",
            track_id,
            attempts,
        )
        bookkeeping.increment_outcome("permanently_skipped")
        return
    bookkeeping.increment_outcome("transient_failure")


def process_loudness_backfill_jobs(
    jobs: Sequence[AnalysisQueueJob],
    *,
    database: Database,
    release_reservations: ReleaseReservations,
    resolve_path: ResolvePath,
    max_file_size_mb: int,
    timeout_seconds: int,
    bookkeeping: LoudnessBackfillBookkeeping,
    measure: MeasureLoudness = measure_loudness,
    path_exists: PathExists = os.path.exists,
    path_size: PathSize = os.path.getsize,
) -> None:
    """Process loudness-only jobs sequentially and always release reservations."""
    for job in jobs:
        track = (job["trackId"], job.get("filePath", ""))
        result: JobResult
        try:
            result = _process_job(
                job,
                database,
                resolve_path,
                max_file_size_mb,
                timeout_seconds,
                measure,
                path_exists,
                path_size,
            )
        except Exception as error:
            logger.warning(
                "Loudness backfill failed for track %s: %s",
                track[0],
                type(error).__name__,
            )
            result = "failed"
        try:
            _record_job_result(job, result, bookkeeping)
        except Exception as error:
            logger.warning(
                "Failed to persist loudness backfill bookkeeping for track %s: %s",
                track[0],
                type(error).__name__,
            )
        finally:
            release_reservations([track])
