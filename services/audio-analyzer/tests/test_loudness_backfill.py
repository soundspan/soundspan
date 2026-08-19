"""Behavioral coverage for loudness-only queue jobs."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from types import ModuleType
from typing import Any

import loudness_backfill
import pytest
from conftest import FakeDatabaseConnection, FakeRedis


class _Bookkeeping:
    """Apply per-revision attempts and outcome counters in memory."""

    def __init__(self) -> None:
        self.attempts: dict[str, int] = {}
        self.outcomes: list[str] = []
        self.permanent: set[str] = set()
        self.cooldowns: list[str] = []

    def clear_failures(self, attempt_key: str) -> None:
        """Clear the current content revision's failures."""
        self.attempts.pop(attempt_key, None)

    def increment_failures(self, attempt_key: str) -> int:
        """Increment and return the current content revision's failures."""
        attempts = self.attempts.get(attempt_key, 0) + 1
        self.attempts[attempt_key] = attempts
        if attempts >= loudness_backfill.LOUDNESS_BACKFILL_MAX_FAILURES:
            self.cooldowns.append(attempt_key)
        return attempts

    def increment_outcome(self, outcome: str) -> None:
        """Record one bounded analyzer outcome."""
        self.outcomes.append(outcome)

    def park_permanently(self, attempt_key: str) -> None:
        """Record one permanently parked revision."""
        self.permanent.add(attempt_key)


class _BookkeepingRedis:
    """Apply Redis bookkeeping commands to an in-memory keyspace."""

    def __init__(self) -> None:
        self.values: dict[str, int | str] = {}
        self.expirations: dict[str, int] = {}
        self.registered_scripts: list[str] = []

    def register_script(self, script: str) -> Callable[..., int]:
        """Register an atomic failure transition script."""
        self.registered_scripts.append(script)

        def execute(*, keys: list[str], args: list[int]) -> int:
            key = keys[0]
            current = self.values.get(key, 0)
            assert isinstance(current, int)
            value = current + 1
            ttl = args[2] if value >= args[0] else args[1]
            self.values[key] = value
            self.expirations[key] = ttl
            return value

        return execute

    def delete(self, key: str) -> int:
        """Delete one counter and return whether it existed."""
        return int(self.values.pop(key, None) is not None)

    def incr(self, key: str) -> int:
        """Increment and return one counter."""
        current = self.values.get(key, 0)
        assert isinstance(current, int)
        value = current + 1
        self.values[key] = value
        return value

    def expire(self, key: str, seconds: int) -> int:
        """Record one key expiry."""
        self.expirations[key] = seconds
        return 1

    def set(self, key: str, value: str, *, ex: int) -> bool:
        """Store one expiring marker."""
        self.values[key] = value
        self.expirations[key] = ex
        return True


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
    assert redis.expirations[attempt_key] == loudness_backfill.LOUDNESS_ATTEMPT_TTL_SECONDS
    assert bookkeeping.increment_failures(attempt_key) == 3
    assert redis.expirations[attempt_key] == loudness_backfill.LOUDNESS_TRANSIENT_COOLDOWN_SECONDS
    assert redis.registered_scripts == [loudness_backfill._INCREMENT_FAILURES_SCRIPT]
    bookkeeping.increment_outcome("transient_failure")
    bookkeeping.clear_failures(attempt_key)

    assert attempt_key not in redis.values
    assert redis.values["audio:analysis:loudness:outcomes:transient_failure"] == 1


def test_bookkeeping_script_error_skips_outcome_and_warns(caplog: pytest.LogCaptureFixture) -> None:
    """Treat an atomic transition failure as transient bookkeeping failure."""

    class ScriptErrorRedis(_BookkeepingRedis):
        def register_script(self, script: str) -> Callable[..., int]:
            self.registered_scripts.append(script)

            def fail(*, keys: list[str], args: list[int]) -> int:
                raise RuntimeError("script unavailable")

            return fail

    redis = ScriptErrorRedis()
    bookkeeping = loudness_backfill.RedisLoudnessBackfillBookkeeping(redis)
    database = FakeDatabaseConnection([[{"loudnessLufs": None}]])
    releases, release = _release_recorder()

    with caplog.at_level(logging.WARNING):
        loudness_backfill.process_loudness_backfill_jobs(
            [_job("track-script-error")],
            database=database,
            release_reservations=release,
            resolve_path=lambda _path: "/music/Artist/track-script-error.flac",
            max_file_size_mb=500,
            timeout_seconds=120,
            bookkeeping=bookkeeping,
            measure=lambda _path, _timeout: {"measurement": None, "failure": "transient"},
            path_exists=lambda _path: True,
            path_size=lambda _path: 1024,
        )

    assert redis.values == {}
    assert "Failed to persist loudness backfill bookkeeping" in caplog.text
    assert releases == [[("track-script-error", "Artist/track-script-error.flac")]]


def test_redis_bookkeeping_parks_permanent_revisions_with_a_ttl() -> None:
    """Let superseded permanent revision keys expire when sweeps stop refreshing them."""
    redis = _BookkeepingRedis()
    bookkeeping = loudness_backfill.RedisLoudnessBackfillBookkeeping(redis)
    attempt_key = "audio:analysis:loudness:attempts:permanent-revision"

    bookkeeping.park_permanently(attempt_key)

    assert redis.values[attempt_key] == loudness_backfill.PERMANENT_FAILURE_MARKER
    assert redis.expirations[attempt_key] == loudness_backfill.LOUDNESS_ATTEMPT_TTL_SECONDS


@pytest.mark.parametrize("invalid_count", [True, 0, -1, "1"])
def test_redis_bookkeeping_rejects_invalid_failure_counts(invalid_count: object) -> None:
    """Reject malformed Redis counter responses before using retry state."""

    class InvalidRedis(_BookkeepingRedis):
        def register_script(self, script: str) -> Callable[..., object]:
            self.registered_scripts.append(script)
            return lambda **_kwargs: invalid_count

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


def test_loudness_job_orchestrates_save_lock_and_rollup() -> None:
    """Persist a measurement and serialize before invoking the shared rollup."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}], [{"id": "track-1"}]])
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
            "measurement": {"loudnessLufs": -18.2, "truePeakDb": -1.1},
            "failure": None,
        },
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert len(database.cursor.executions) == 4
    assert database.cursor.executions[2][0] == loudness_backfill.ALBUM_LOUDNESS_LOCK_SQL
    assert database.cursor.executions[3][0] == loudness_backfill.ALBUM_LOUDNESS_ROLLUP_SQL
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
        measure=lambda _path, _timeout: {"measurement": None, "failure": "transient"},
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


def test_transient_exhaustion_starts_a_recoverable_cooldown() -> None:
    """Reset transient infrastructure failure budgets after the cooldown."""
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
        measure=lambda _path, _timeout: {"measurement": None, "failure": "transient"},
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    assert bookkeeping.outcomes == [
        "transient_failure",
        "transient_failure",
        "transient_failure",
    ]
    assert bookkeeping.cooldowns == [_job("track-failed")["loudnessAttemptKey"]]


def test_permanent_content_failure_stays_parked() -> None:
    """Park an intact-file decode failure until the audio revision changes."""
    database = FakeDatabaseConnection([[{"loudnessLufs": None}]])
    bookkeeping = _Bookkeeping()
    _releases, release = _release_recorder()

    loudness_backfill.process_loudness_backfill_jobs(
        [_job("unsupported")],
        database=database,
        release_reservations=release,
        resolve_path=lambda _path: "/music/unsupported.flac",
        max_file_size_mb=500,
        timeout_seconds=120,
        bookkeeping=bookkeeping,
        measure=lambda _path, _timeout: {"measurement": None, "failure": "permanent"},
        path_exists=lambda _path: True,
        path_size=lambda _path: 1024,
    )

    attempt_key = _job("unsupported")["loudnessAttemptKey"]
    assert bookkeeping.permanent == {attempt_key}
    assert bookkeeping.outcomes == ["permanently_skipped"]


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
    bookkeeping = object()
    worker.loudness_backfill_bookkeeping = bookkeeping
    handled: list[tuple[list[dict[str, Any]], object]] = []
    monkeypatch.setattr(
        loaded_analyzer,
        "process_loudness_backfill_jobs",
        lambda jobs, **kwargs: handled.append((jobs, kwargs["bookkeeping"])),
    )
    worker._process_tracks_parallel = lambda _tracks: (_ for _ in ()).throw(
        AssertionError("ML processing must stay idle")
    )

    assert worker.process_batch_parallel() is True
    assert handled == [([_job("track-idle")], bookkeeping)]
    assert worker.executor is None
    assert worker.pool_active is False
