"""Behavioral coverage for successful audio-analysis failure resolution."""

from __future__ import annotations

from datetime import UTC, datetime
from types import ModuleType
from typing import Any

import pytest
from conftest import FakeDatabaseConnection


def _analysis_features() -> dict[str, Any]:
    """Build the required successful-analysis feature payload."""
    return {
        "bpm": 120.0,
        "beatsCount": 240,
        "key": "C",
        "keyScale": "major",
        "keyStrength": 0.9,
        "energy": 0.8,
        "loudness": -8.0,
        "loudnessLufs": -18.4,
        "truePeakDb": -1.2,
        "dynamicRange": 6.0,
        "danceability": 0.7,
        "valence": 0.6,
        "arousal": 0.5,
        "instrumentalness": 0.4,
        "acousticness": 0.3,
        "speechiness": 0.2,
        "moodTags": ["happy"],
        "essentiaGenres": ["rock"],
    }


def _build_worker(module: ModuleType, database: FakeDatabaseConnection) -> object:
    """Build an analysis worker without running external-client initialization."""
    worker = object.__new__(module.AnalysisWorker)
    worker.db = database
    return worker


def test_save_results_resolves_unresolved_audio_failures(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Persist results and resolve stale audio failures in one transaction."""
    analyzed_at = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)

    class FixedDateTime:
        """Return a deterministic analysis timestamp."""

        @staticmethod
        def now(_timezone: object) -> datetime:
            """Return the test's fixed UTC timestamp."""
            return analyzed_at

    monkeypatch.setattr(loaded_analyzer, "datetime", FixedDateTime)
    database = FakeDatabaseConnection()
    worker = _build_worker(loaded_analyzer, database)
    track_id = "track-a"
    features = _analysis_features()

    worker._save_results(track_id, "/music/a.flac", features)

    assert len(database.cursor.executions) == 4
    result_sql, result_params = database.cursor.executions[0]
    lock_sql, lock_params = database.cursor.executions[1]
    rollup_sql, rollup_params = database.cursor.executions[2]
    failure_sql, failure_params = database.cursor.executions[3]
    assert 'UPDATE "Track"' in result_sql
    assert result_params == loaded_analyzer._analysis_result_values(track_id, features)
    assert "pg_advisory_xact_lock" in lock_sql
    assert lock_params == (track_id,)
    assert 'UPDATE "Album"' in rollup_sql
    assert rollup_params == (track_id,)
    assert 'UPDATE "EnrichmentFailure"' in failure_sql
    assert "\"entityType\" = 'audio'" in failure_sql
    assert '"entityId" = %s' in failure_sql
    assert "resolved = true" in failure_sql
    assert "resolved = false" in failure_sql
    assert failure_params == (track_id,)
    assert database.commit_calls == 1
    assert database.rollback_calls == 0
    assert database.cursor.closed is True


def test_save_results_rolls_back_and_closes_cursor_on_database_error(
    loaded_analyzer: ModuleType,
) -> None:
    """Roll back a failed result write without propagating the database error."""
    database = FakeDatabaseConnection(fail_on_execute=1)
    worker = _build_worker(loaded_analyzer, database)

    worker._save_results("track-a", "/music/a.flac", _analysis_features())

    assert len(database.cursor.executions) == 1
    assert database.commit_calls == 0
    assert database.rollback_calls == 1
    assert database.cursor.closed is True
