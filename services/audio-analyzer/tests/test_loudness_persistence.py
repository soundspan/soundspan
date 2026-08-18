"""Behavioral coverage for loudness result persistence and album rollups."""

from __future__ import annotations

from types import ModuleType
from typing import Any

from conftest import FakeDatabaseConnection


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


def build_worker(module: ModuleType, database: FakeDatabaseConnection) -> object:
    """Build a worker without external client initialization."""
    worker = object.__new__(module.AnalysisWorker)
    worker.db = database
    return worker


def test_save_sql_placeholder_count_matches_result_tuple_arity(
    loaded_analyzer: ModuleType,
) -> None:
    """Keep SQL placeholders and positional result values in lockstep."""
    values = loaded_analyzer._analysis_result_values(
        "track-1",
        analysis_features(),
    )

    assert loaded_analyzer._SAVE_ANALYSIS_RESULTS_SQL.count("%s") == len(values)


def test_measured_track_save_recomputes_album_measurements_in_same_transaction(
    loaded_analyzer: ModuleType,
) -> None:
    """Update album loudness and peak after the measured track save."""
    database = FakeDatabaseConnection()
    worker = build_worker(loaded_analyzer, database)

    worker._save_results("track-1", "/music/track.flac", analysis_features())

    assert len(database.cursor.executions) == 3
    rollup_sql, rollup_params = database.cursor.executions[1]
    assert 'UPDATE "Album" AS album' in rollup_sql
    assert '"albumTruePeakDb" = aggregate."albumTruePeakDb"' in rollup_sql
    assert 'sibling."loudnessLufs" IS NOT NULL' in rollup_sql
    assert "sibling.duration > 0" in rollup_sql
    assert "SUM(sibling.duration)" in rollup_sql
    assert 'POWER(10.0, sibling."loudnessLufs" / 10.0)' in rollup_sql
    assert 'MAX(sibling."truePeakDb") AS "albumTruePeakDb"' in rollup_sql
    assert "NULLIF" in rollup_sql
    assert rollup_params == ("track-1",)
    assert database.commit_calls == 1


def test_unmeasured_track_save_does_not_recompute_album_loudness(
    loaded_analyzer: ModuleType,
) -> None:
    """Avoid album work when optional loudness measurement failed."""
    database = FakeDatabaseConnection()
    worker = build_worker(loaded_analyzer, database)

    worker._save_results(
        "track-1",
        "/music/track.flac",
        analysis_features(loudness_lufs=None),
    )

    assert len(database.cursor.executions) == 2
    assert all('UPDATE "Album"' not in sql for sql, _ in database.cursor.executions)
