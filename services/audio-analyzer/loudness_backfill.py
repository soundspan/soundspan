"""Sequential persistence flow for loudness-only analyzer queue jobs."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol, TypedDict

from loudness import (
    ALBUM_LOUDNESS_ROLLUP_SQL,
    LoudnessMeasurement,
    measure_loudness,
)

from services.common.logging_utils import configure_service_logger

logger = configure_service_logger("audio-analyzer").getChild("LoudnessBackfill")

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
) -> None:
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
) -> None:
    """Measure and persist one eligible loudness-only queue job."""
    track_id = job["trackId"]
    file_path = job.get("filePath", "")
    if _already_measured(database, track_id):
        return
    resolved_path = _resolve_eligible_path(
        file_path,
        resolve_path,
        max_file_size_mb,
        path_exists,
        path_size,
    )
    if resolved_path is None:
        logger.warning("Skipping ineligible loudness backfill file for track %s", track_id)
        return
    measurement = measure(resolved_path, timeout_seconds)
    if measurement is None:
        logger.warning("Loudness backfill measurement failed for track %s", track_id)
        return
    _persist_measurement(database, track_id, measurement)


def process_loudness_backfill_jobs(
    jobs: Sequence[AnalysisQueueJob],
    *,
    database: Database,
    release_reservations: ReleaseReservations,
    resolve_path: ResolvePath,
    max_file_size_mb: int,
    timeout_seconds: int,
    measure: MeasureLoudness = measure_loudness,
    path_exists: PathExists = os.path.exists,
    path_size: PathSize = os.path.getsize,
) -> None:
    """Process loudness-only jobs sequentially and always release reservations."""
    for job in jobs:
        track = (job["trackId"], job.get("filePath", ""))
        try:
            _process_job(
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
        finally:
            release_reservations([track])
