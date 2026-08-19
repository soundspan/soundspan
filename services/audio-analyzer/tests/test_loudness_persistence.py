"""Orchestration coverage for analyzer loudness persistence."""

from __future__ import annotations

from types import ModuleType
from typing import Any

from conftest import FakeDatabaseConnection
from loudness import ALBUM_LOUDNESS_LOCK_SQL, ALBUM_LOUDNESS_ROLLUP_SQL


def analysis_features(loudness_lufs: float | None = -18.4) -> dict[str, Any]:
    """Build one complete analyzer result payload."""
    return {
        "bpm": 120.0,
        "beatsCount": 240,
        "key": "C",
        "keyScale": "major",
        "keyStrength": 0.9,
        "energy": 0.8,
        "loudness": -8.0,
        "loudnessLufs": loudness_lufs,
        "truePeakDb": -1.2 if loudness_lufs is not None else None,
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


def build_worker(module: ModuleType, database: object) -> object:
    """Build a worker without external client initialization."""
    worker = object.__new__(module.AnalysisWorker)
    worker.db = database
    return worker


def test_save_sql_placeholder_count_matches_result_tuple_arity(
    loaded_analyzer: ModuleType,
) -> None:
    """Keep SQL placeholders and positional result values in lockstep."""
    values = loaded_analyzer._analysis_result_values("track-1", analysis_features())

    assert loaded_analyzer._SAVE_ANALYSIS_RESULTS_SQL.count("%s") == len(values)


def test_save_serializes_album_rollup_before_resolving_failures(
    loaded_analyzer: ModuleType,
) -> None:
    """Take the shared advisory lock before the aggregate statement."""
    database = FakeDatabaseConnection()
    worker = build_worker(loaded_analyzer, database)

    worker._save_results("track-1", "/music/track.flac", analysis_features())

    statements = [sql for sql, _params in database.cursor.executions]
    assert statements == [
        loaded_analyzer._SAVE_ANALYSIS_RESULTS_SQL,
        ALBUM_LOUDNESS_LOCK_SQL,
        ALBUM_LOUDNESS_ROLLUP_SQL,
        loaded_analyzer._RESOLVE_AUDIO_FAILURES_SQL,
    ]
    assert database.commit_calls == 1
    assert database.rollback_calls == 0
