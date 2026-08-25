"""Concurrent measurement and ordered persistence for loudness-only queue jobs."""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from hashlib import sha256
from typing import Any, Literal, NamedTuple, Protocol, TypedDict

from loudness import (
    ALBUM_LOUDNESS_LOCK_SQL,
    ALBUM_LOUDNESS_ROLLUP_SQL,
    LoudnessMeasurement,
    LoudnessMeasurementResult,
    measure_loudness_for_backfill,
)

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("LoudnessBackfill")

LOUDNESS_ATTEMPT_KEY_PREFIX = "audio:analysis:loudness:attempts:"
LOUDNESS_OUTCOME_KEY_PREFIX = "audio:analysis:loudness:outcomes:"
LOUDNESS_BACKFILL_MAX_FAILURES = 3
LOUDNESS_ATTEMPT_TTL_SECONDS = 30 * 24 * 60 * 60
LOUDNESS_TRANSIENT_COOLDOWN_SECONDS = 24 * 60 * 60
PERMANENT_FAILURE_MARKER = "permanent"
_PRODUCER_ATTEMPT_KEY_SUFFIX = re.compile(r"[0-9a-f]{64}")

_INCREMENT_FAILURES_SCRIPT = """
local attempts = redis.call("INCR", KEYS[1])
local ttl = tonumber(ARGV[2])
if attempts >= tonumber(ARGV[1]) then
    ttl = tonumber(ARGV[3])
end
redis.call("EXPIRE", KEYS[1], ttl)
return attempts
"""

LoudnessBackfillOutcome = Literal[
    "measured_success",
    "transient_failure",
    "permanently_skipped",
]
JobResult = Literal[
    "already_measured",
    "measured",
    "permanent_failure",
    "transient_failure",
]

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

    def park_permanently(self, attempt_key: str) -> None:
        """Park one permanent content failure until its revision key changes."""

    def increment_outcome(self, outcome: LoudnessBackfillOutcome) -> None:
        """Increment one durable bounded outcome counter."""


class RedisBookkeepingClient(Protocol):
    """Redis counter operations required by loudness backfill bookkeeping."""

    def delete(self, key: str) -> object:
        """Delete one failure counter."""

    def incr(self, key: str) -> object:
        """Increment and return one counter."""

    def set(self, key: str, value: str, *, ex: int) -> object:
        """Set a bounded marker with an expiry."""

    def register_script(self, script: str) -> Callable[..., object]:
        """Register one Lua script with transparent EVAL fallback."""


class RedisLoudnessBackfillBookkeeping:
    """Persist loudness failure budgets and bounded outcomes in Redis."""

    def __init__(self, redis_client: RedisBookkeepingClient) -> None:
        self.redis = redis_client
        self.increment_failures_script = redis_client.register_script(_INCREMENT_FAILURES_SCRIPT)

    def clear_failures(self, attempt_key: str) -> None:
        """Clear the loudness failure budget for one measured content revision."""
        self.redis.delete(attempt_key)

    def increment_failures(self, attempt_key: str) -> int:
        """Increment one content revision's durable loudness failure count."""
        attempts = self.increment_failures_script(
            keys=[attempt_key],
            args=[
                LOUDNESS_BACKFILL_MAX_FAILURES,
                LOUDNESS_ATTEMPT_TTL_SECONDS,
                LOUDNESS_TRANSIENT_COOLDOWN_SECONDS,
            ],
        )
        if isinstance(attempts, bool) or not isinstance(attempts, int):
            raise RuntimeError("Redis returned an invalid loudness failure count")
        if attempts < 1:
            raise RuntimeError("Redis returned a non-positive loudness failure count")
        return attempts

    def park_permanently(self, attempt_key: str) -> None:
        """Persist a renewable marker for one permanent content failure."""
        self.redis.set(
            attempt_key,
            PERMANENT_FAILURE_MARKER,
            ex=LOUDNESS_ATTEMPT_TTL_SECONDS,
        )

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
MeasureLoudness = Callable[[str, int], LoudnessMeasurementResult]
PathExists = Callable[[str], bool]
PathSize = Callable[[str], int]


class _ScheduledJob(NamedTuple):
    """Keep one input-ordered job beside its immediate or future result."""

    job: AnalysisQueueJob
    track: tuple[str, str]
    immediate_result: JobResult | None
    measurement_future: Future[LoudnessMeasurementResult] | None


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
) -> tuple[str | None, JobResult | None]:
    """Apply containment, existence, and configured file-size guards."""
    resolved_path = resolve_path(file_path)
    if resolved_path is None:
        return None, "permanent_failure"
    if not path_exists(resolved_path):
        return None, "transient_failure"
    if max_file_size_mb <= 0:
        return resolved_path, None
    file_size_mb = path_size(resolved_path) / (1024 * 1024)
    if file_size_mb > max_file_size_mb:
        return None, "permanent_failure"
    return resolved_path, None


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
            cursor.execute(ALBUM_LOUDNESS_LOCK_SQL, (track_id,))
            cursor.execute(ALBUM_LOUDNESS_ROLLUP_SQL, (track_id,))
        database.commit()
        return updated is not None
    except Exception:
        database.rollback()
        raise
    finally:
        cursor.close()


def _complete_measurement(
    measurement_result: LoudnessMeasurementResult,
    database: Database,
    track_id: str,
) -> JobResult:
    """Convert one completed measurement into a coordinator-owned database result."""
    measurement = measurement_result["measurement"]
    if measurement is None:
        logger.warning("Loudness backfill measurement failed for track %s", track_id)
        failure = measurement_result["failure"]
        return "permanent_failure" if failure == "permanent" else "transient_failure"
    persisted = _persist_measurement(database, track_id, measurement)
    return "measured" if persisted else "already_measured"


def _schedule_job(
    job: AnalysisQueueJob,
    *,
    database: Database,
    resolve_path: ResolvePath,
    max_file_size_mb: int,
    timeout_seconds: int,
    measure: MeasureLoudness,
    path_exists: PathExists,
    path_size: PathSize,
    executor: ThreadPoolExecutor,
) -> _ScheduledJob:
    """Validate one job on the coordinator and schedule only its measurement."""
    track = (job["trackId"], job.get("filePath", ""))
    try:
        if _already_measured(database, track[0]):
            return _ScheduledJob(job, track, "already_measured", None)
        resolved_path, path_failure = _resolve_eligible_path(
            track[1], resolve_path, max_file_size_mb, path_exists, path_size
        )
        if resolved_path is None:
            logger.warning("Skipping ineligible loudness backfill file for track %s", track[0])
            return _ScheduledJob(job, track, path_failure or "transient_failure", None)
        future = executor.submit(measure, resolved_path, timeout_seconds)
        return _ScheduledJob(job, track, None, future)
    except Exception as error:
        logger.warning(
            "Loudness backfill failed for track %s: %s",
            track[0],
            type(error).__name__,
        )
        return _ScheduledJob(job, track, "transient_failure", None)


def _legacy_attempt_key(track_id: str) -> str:
    """Return a bounded track-scoped attempt key for a legacy queue job."""
    # Producer keys reset per file revision. This transitional fallback intentionally
    # shares one failure budget across every legacy revision of the same track.
    digest = sha256(track_id.encode()).hexdigest()
    return f"{LOUDNESS_ATTEMPT_KEY_PREFIX}legacy:{digest}"


def _attempt_key_for_job(job: AnalysisQueueJob) -> str:
    """Return a validated producer key or a bounded compatibility fallback."""
    attempt_key = job.get("loudnessAttemptKey")
    if isinstance(attempt_key, str) and attempt_key.startswith(LOUDNESS_ATTEMPT_KEY_PREFIX):
        suffix = attempt_key[len(LOUDNESS_ATTEMPT_KEY_PREFIX) :]
        if _PRODUCER_ATTEMPT_KEY_SUFFIX.fullmatch(suffix) is not None:
            return attempt_key
    track_id = job["trackId"]
    if "loudnessAttemptKey" in job:
        logger.warning(
            "Using legacy fallback attempt key for loudness track %s "
            "after an invalid producer attempt key",
            track_id,
        )
    return _legacy_attempt_key(track_id)


def _record_job_result(
    job: AnalysisQueueJob,
    result: JobResult,
    bookkeeping: LoudnessBackfillBookkeeping,
) -> None:
    """Persist the bounded attempt transition and its final outcome."""
    attempt_key = _attempt_key_for_job(job)
    track_id = job["trackId"]
    if result == "already_measured":
        bookkeeping.clear_failures(attempt_key)
        return
    if result == "measured":
        bookkeeping.clear_failures(attempt_key)
        bookkeeping.increment_outcome("measured_success")
        return

    if result == "permanent_failure":
        logger.warning(
            "Permanently skipping loudness backfill for track %s after a content failure",
            track_id,
        )
        bookkeeping.park_permanently(attempt_key)
        bookkeeping.increment_outcome("permanently_skipped")
        return

    bookkeeping.increment_failures(attempt_key)
    bookkeeping.increment_outcome("transient_failure")


def _settle_scheduled_job(
    scheduled: _ScheduledJob,
    database: Database,
    bookkeeping: LoudnessBackfillBookkeeping,
    release_reservations: ReleaseReservations,
) -> None:
    """Settle one scheduled job on the coordinator and release its reservation."""
    result = scheduled.immediate_result
    try:
        if scheduled.measurement_future is not None:
            measurement_result = scheduled.measurement_future.result()
            result = _complete_measurement(measurement_result, database, scheduled.track[0])
        if result is None:
            raise RuntimeError("Loudness job completed without a result")
    except Exception as error:
        logger.warning(
            "Loudness backfill failed for track %s: %s",
            scheduled.track[0],
            type(error).__name__,
        )
        result = "transient_failure"
    try:
        _record_job_result(scheduled.job, result, bookkeeping)
    except Exception as error:
        logger.warning(
            "Failed to persist loudness backfill bookkeeping for track %s: %s",
            scheduled.track[0],
            type(error).__name__,
        )
    finally:
        release_reservations([scheduled.track])


def process_loudness_backfill_jobs(
    jobs: Sequence[AnalysisQueueJob],
    *,
    database: Database,
    release_reservations: ReleaseReservations,
    resolve_path: ResolvePath,
    max_file_size_mb: int,
    timeout_seconds: int,
    bookkeeping: LoudnessBackfillBookkeeping,
    measure: MeasureLoudness = measure_loudness_for_backfill,
    path_exists: PathExists = os.path.exists,
    path_size: PathSize = os.path.getsize,
) -> None:
    """Measure jobs in a bounded pool and coordinate persistence in input order."""
    legacy_fallback_jobs = sum("loudnessAttemptKey" not in job for job in jobs)
    if not jobs:
        return
    worker_count = min(4, len(jobs))
    with ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix="loudness-backfill",
    ) as executor:
        scheduled_jobs = [
            _schedule_job(
                job,
                database=database,
                resolve_path=resolve_path,
                max_file_size_mb=max_file_size_mb,
                timeout_seconds=timeout_seconds,
                measure=measure,
                path_exists=path_exists,
                path_size=path_size,
                executor=executor,
            )
            for job in jobs
        ]
        for scheduled in scheduled_jobs:
            _settle_scheduled_job(scheduled, database, bookkeeping, release_reservations)
    if legacy_fallback_jobs > 0:
        logger.info(
            "Using legacy fallback attempt keys for %d loudness jobs without a producer key",
            legacy_fallback_jobs,
        )
