"""Behavioral coverage for loudness-only queue jobs."""

from __future__ import annotations

import json
from collections.abc import Callable
from types import ModuleType
from typing import Any

import loudness_backfill
from conftest import FakeDatabaseConnection, FakeRedis
from loudness import ALBUM_LOUDNESS_ROLLUP_SQL


def _job(track_id: str, loudness_only: bool = True) -> dict[str, Any]:
    """Build one analyzer queue payload."""
    return {
        "trackId": track_id,
        "filePath": f"Artist/{track_id}.flac",
        "duration": 180,
        "loudnessOnly": loudness_only,
    }


def _release_recorder() -> tuple[
    list[list[tuple[str, str]]],
    Callable[[list[tuple[str, str]]], None],
]:
    """Record batches passed to the analyzer's reservation-release seam."""
    releases: list[list[tuple[str, str]]] = []

    def release(tracks: list[tuple[str, str]]) -> None:
        releases.append(tracks)

    return releases, release


def test_partition_analysis_jobs_separates_loudness_only_from_normal_work() -> None:
    """Keep loudness-only payloads out of the ML process-pool batch."""
    normal, loudness_only = loudness_backfill.partition_analysis_jobs(
        [_job("normal", False), _job("backfill"), _job("legacy", False)]
    )

    assert normal == [
        ("normal", "Artist/normal.flac"),
        ("legacy", "Artist/legacy.flac"),
    ]
    assert loudness_only == [_job("backfill")]


def test_loudness_job_persists_only_measurements_and_album_rollup() -> None:
    """Write only loudness columns, then recompute the album in one transaction."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}], [{"id": "track-1"}]])
    releases, release = _release_recorder()

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-1")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-1.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        measure=lambda _path, _timeout: {
            "loudnessLufs": -18.2,
            "truePeakDb": -1.1,
        },
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert len(database.cursor.executions) == 3
    select_sql, select_params = database.cursor.executions[0]
    update_sql, update_params = database.cursor.executions[1]
    rollup_sql, rollup_params = database.cursor.executions[2]
    assert 'SELECT "loudnessLufs"' in select_sql
    assert select_params == ("track-1",)
    assert 'SET "loudnessLufs" = %s,' in update_sql
    assert '"truePeakDb" = %s' in update_sql
    assert '"loudnessLufs" IS NULL' in update_sql
    assert update_params == (-18.2, -1.1, "track-1")
    forbidden_columns = (
        "analysisStatus",
        "analysisVersion",
        "analyzedAt",
        "analysisError",
        "analysisStartedAt",
    )
    assert all(column not in update_sql for column in forbidden_columns)
    assert rollup_sql == ALBUM_LOUDNESS_ROLLUP_SQL
    assert rollup_params == ("track-1",)
    assert database.commit_calls == 2
    assert database.rollback_calls == 0
    assert releases == [[("track-1", "Artist/track-1.flac")]]


def test_loudness_job_releases_reservation_after_measurement_failure() -> None:
    """Leave loudness null and release admission when ffmpeg cannot measure."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}]])
    releases, release = _release_recorder()

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-failed")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-failed.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        measure=lambda _path, _timeout: None,
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert len(database.cursor.executions) == 1
    assert database.rollback_calls == 0
    assert releases == [[("track-failed", "Artist/track-failed.flac")]]


def test_loudness_job_releases_reservation_after_unexpected_failure() -> None:
    """Contain one job failure and continue releasing its reservation."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}]])
    releases, release = _release_recorder()

    def fail_measurement(_path: str, _timeout: int) -> None:
        raise RuntimeError("ffmpeg wrapper failed")

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-error")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-error.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        measure=fail_measurement,
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert releases == [[("track-error", "Artist/track-error.flac")]]


def test_already_measured_track_skips_ffmpeg_and_update() -> None:
    """Avoid racing a completed inline re-analysis measurement."""
    database = FakeDatabaseConnection([[{"loudnessLufs": -17.0}]])
    releases, release = _release_recorder()
    measure_calls: list[str] = []

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-measured")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-measured.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        measure=lambda path, _timeout: measure_calls.append(path),
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert measure_calls == []
    assert len(database.cursor.executions) == 1
    assert database.commit_calls == 1
    assert releases == [[("track-measured", "Artist/track-measured.flac")]]


class _QueueRedis(FakeRedis):
    """Provide one blocking job followed by an empty non-blocking drain."""

    def __init__(self, payload: dict[str, Any]) -> None:
        super().__init__()
        self.payload = json.dumps(payload)

    def brpop(self, _queue: str, timeout: int) -> tuple[str, str]:
        assert timeout > 0
        return ("audio:analysis:queue", self.payload)

    def lpop(self, _queue: str) -> None:
        return None


def test_loudness_only_batch_works_without_loading_models(
    loaded_analyzer: ModuleType,
    monkeypatch: Any,
) -> None:
    """Handle a loudness-only batch without creating the ML process pool."""
    worker = object.__new__(loaded_analyzer.AnalysisWorker)
    worker.redis = _QueueRedis(_job("track-idle"))
    worker.db = FakeDatabaseConnection()
    worker.executor = None
    worker.pool_active = False
    handled: list[list[dict[str, Any]]] = []
    monkeypatch.setattr(
        loaded_analyzer,
        "process_loudness_backfill_jobs",
        lambda jobs, **_kwargs: handled.append(jobs),
    )
    worker._process_tracks_parallel = lambda _tracks: (_ for _ in ()).throw(
        AssertionError("ML processing must stay idle")
    )

    assert worker.process_batch_parallel() is True
    assert handled == [[_job("track-idle")]]
    assert worker.executor is None
    assert worker.pool_active is False
