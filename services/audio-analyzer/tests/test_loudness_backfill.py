"""Behavioral coverage for loudness-only queue jobs."""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from types import ModuleType
from typing import Any

import loudness_backfill
import pytest
from conftest import FakeDatabaseConnection, FakeRedis
from loudness import ALBUM_LOUDNESS_ROLLUP_SQL


class _Bookkeeping:
    """Apply per-revision attempts and outcome counters in memory."""

    def __init__(self) -> None:
        self.attempts: dict[str, int] = {}
        self.outcomes: list[str] = []

    def clear_failures(self, attempt_key: str) -> None:
        """Clear the current content revision's failures."""
        self.attempts.pop(attempt_key, None)

    def increment_failures(self, attempt_key: str) -> int:
        """Increment and return the current content revision's failures."""
        attempts = self.attempts.get(attempt_key, 0) + 1
        self.attempts[attempt_key] = attempts
        return attempts

    def increment_outcome(self, outcome: str) -> None:
        """Record one bounded analyzer outcome."""
        self.outcomes.append(outcome)


class _BookkeepingRedis:
    """Apply Redis bookkeeping commands to an in-memory keyspace."""

    def __init__(self) -> None:
        self.values: dict[str, int] = {}

    def delete(self, key: str) -> int:
        """Delete one counter and return whether it existed."""
        return int(self.values.pop(key, None) is not None)

    def incr(self, key: str) -> int:
        """Increment and return one counter."""
        value = self.values.get(key, 0) + 1
        self.values[key] = value
        return value


class _ApplyingBackfillCursor:
    """Apply loudness-only persistence to an in-memory catalog."""

    def __init__(self, database: _ApplyingBackfillDatabase) -> None:
        self.database = database
        self.next_row: dict[str, Any] | None = None

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        assert params is not None
        self.next_row = None
        if sql == loudness_backfill._SELECT_TRACK_LOUDNESS_SQL:
            track = self.database.tracks.get(params[0])
            self.next_row = None if track is None else {"loudnessLufs": track["loudnessLufs"]}
            return
        if sql == loudness_backfill._SAVE_TRACK_LOUDNESS_SQL:
            track = self.database.tracks.get(params[2])
            if track is not None and track["loudnessLufs"] is None:
                track["loudnessLufs"] = params[0]
                track["truePeakDb"] = params[1]
                self.next_row = {"id": params[2]}
            return
        if sql == ALBUM_LOUDNESS_ROLLUP_SQL:
            self.database.roll_up_album(params[0])
            return
        raise AssertionError("unexpected loudness backfill operation")

    def fetchone(self) -> dict[str, Any] | None:
        """Return the row produced by the preceding operation."""
        return self.next_row

    def close(self) -> None:
        """Close the in-memory cursor."""


class _ApplyingBackfillDatabase:
    """Model track loudness writes and active-sibling album aggregation."""

    def __init__(self) -> None:
        self.tracks: dict[str, dict[str, Any]] = {}
        self.albums: dict[str, dict[str, float | None]] = {}
        self.cursor = _ApplyingBackfillCursor(self)
        self.commit_calls = 0
        self.rollback_calls = 0

    def get_cursor(self) -> _ApplyingBackfillCursor:
        """Return the state-applying cursor."""
        return self.cursor

    def commit(self) -> None:
        """Record a successful transaction."""
        self.commit_calls += 1

    def rollback(self) -> None:
        """Record a failed transaction."""
        self.rollback_calls += 1

    def roll_up_album(self, saved_track_id: str) -> None:
        """Recalculate an album from active measured siblings."""
        album_id = self.tracks[saved_track_id]["albumId"]
        siblings = [
            track
            for track in self.tracks.values()
            if track["albumId"] == album_id
            and track["removedAt"] is None
            and track["loudnessLufs"] is not None
            and track["duration"] > 0
        ]
        album = self.albums[album_id]
        if not siblings:
            album.update(albumLoudnessLufs=None, albumTruePeakDb=None)
            return
        duration = sum(track["duration"] for track in siblings)
        power = sum(track["duration"] * 10 ** (track["loudnessLufs"] / 10) for track in siblings)
        album["albumLoudnessLufs"] = 10 * math.log10(power / duration)
        album["albumTruePeakDb"] = max(
            track["truePeakDb"] for track in siblings if track["truePeakDb"] is not None
        )


def _job(track_id: str, loudness_only: bool = True) -> dict[str, Any]:
    """Build one analyzer queue payload."""
    return {
        "trackId": track_id,
        "filePath": f"Artist/{track_id}.flac",
        "duration": 180,
        "loudnessOnly": loudness_only,
        "loudnessAttemptKey": f"audio:analysis:loudness:attempts:{track_id}",
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


def test_redis_bookkeeping_persists_failures_and_outcomes() -> None:
    """Keep durable failure and outcome counters behind the backfill seam."""
    redis = _BookkeepingRedis()
    bookkeeping = loudness_backfill.RedisLoudnessBackfillBookkeeping(redis)
    attempt_key = "audio:analysis:loudness:attempts:revision"

    assert bookkeeping.increment_failures(attempt_key) == 1
    assert bookkeeping.increment_failures(attempt_key) == 2
    bookkeeping.increment_outcome("transient_failure")
    bookkeeping.clear_failures(attempt_key)

    assert attempt_key not in redis.values
    assert redis.values["audio:analysis:loudness:outcomes:transient_failure"] == 1


@pytest.mark.parametrize("invalid_count", [True, 0, -1, "1"])
def test_redis_bookkeeping_rejects_invalid_failure_counts(invalid_count: object) -> None:
    """Reject malformed Redis counter responses before using retry state."""

    class InvalidRedis(_BookkeepingRedis):
        def incr(self, _key: str) -> object:
            return invalid_count

    bookkeeping = loudness_backfill.RedisLoudnessBackfillBookkeeping(InvalidRedis())

    with pytest.raises(RuntimeError, match=r"invalid|non-positive"):
        bookkeeping.increment_failures("audio:analysis:loudness:attempts:revision")


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
    """Persist a measurement and aggregate only eligible album siblings."""
    database = _ApplyingBackfillDatabase()
    database.tracks = {
        "track-1": {
            "albumId": "album-1",
            "duration": 180,
            "removedAt": None,
            "loudnessLufs": None,
            "truePeakDb": None,
        },
        "removed": {
            "albumId": "album-1",
            "duration": 180,
            "removedAt": object(),
            "loudnessLufs": -4.0,
            "truePeakDb": 4.0,
        },
    }
    database.albums = {"album-1": {"albumLoudnessLufs": -4.0, "albumTruePeakDb": 4.0}}
    bookkeeping = _Bookkeeping()
    releases, release = _release_recorder()

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-1")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-1.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        bookkeeping=bookkeeping,
        measure=lambda _path, _timeout: {
            "loudnessLufs": -18.2,
            "truePeakDb": -1.1,
        },
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert database.tracks["track-1"]["loudnessLufs"] == -18.2
    assert database.tracks["track-1"]["truePeakDb"] == -1.1
    assert database.albums["album-1"] == {
        "albumLoudnessLufs": -18.2,
        "albumTruePeakDb": -1.1,
    }
    assert database.commit_calls == 2
    assert database.rollback_calls == 0
    assert bookkeeping.outcomes == ["measured_success"]
    assert releases == [[("track-1", "Artist/track-1.flac")]]


def test_loudness_job_releases_reservation_after_measurement_failure() -> None:
    """Leave loudness null and release admission when ffmpeg cannot measure."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}]])
    bookkeeping = _Bookkeeping()
    releases, release = _release_recorder()

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-failed")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-failed.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        bookkeeping=bookkeeping,
        measure=lambda _path, _timeout: None,
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert len(database.cursor.executions) == 1
    assert database.rollback_calls == 0
    assert bookkeeping.attempts[_job("track-failed")["loudnessAttemptKey"]] == 1
    assert bookkeeping.outcomes == ["transient_failure"]
    assert releases == [[("track-failed", "Artist/track-failed.flac")]]


def test_loudness_job_releases_reservation_after_unexpected_failure() -> None:
    """Contain one job failure and continue releasing its reservation."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}]])
    bookkeeping = _Bookkeeping()
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
        bookkeeping=bookkeeping,
        measure=fail_measurement,
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert releases == [[("track-error", "Artist/track-error.flac")]]
    assert bookkeeping.outcomes == ["transient_failure"]


def test_third_consecutive_failure_is_permanently_skipped() -> None:
    """Stop classifying a content revision as transient after three failures."""
    database = FakeDatabaseConnection(
        [[{"loudnessLufs": None}], [{"loudnessLufs": None}], [{"loudnessLufs": None}]]
    )
    bookkeeping = _Bookkeeping()
    _releases, release = _release_recorder()

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-failed"), _job("track-failed"), _job("track-failed")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-failed.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        bookkeeping=bookkeeping,
        measure=lambda _path, _timeout: None,
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert bookkeeping.outcomes == [
        "transient_failure",
        "transient_failure",
        "permanently_skipped",
    ]


def test_already_measured_track_skips_ffmpeg_and_update() -> None:
    """Avoid racing a completed inline re-analysis measurement."""
    database = FakeDatabaseConnection([[{"loudnessLufs": -17.0}]])
    bookkeeping = _Bookkeeping()
    releases, release = _release_recorder()
    measure_calls: list[str] = []

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("track-measured")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/Artist/track-measured.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        bookkeeping=bookkeeping,
        measure=lambda path, _timeout: measure_calls.append(path),
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert measure_calls == []
    assert len(database.cursor.executions) == 1
    assert database.commit_calls == 1
    assert bookkeeping.attempts == {}
    assert bookkeeping.outcomes == []
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
