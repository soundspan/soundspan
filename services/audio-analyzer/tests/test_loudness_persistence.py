"""Behavioral coverage for loudness result persistence and album rollups."""

from __future__ import annotations

import math
from types import ModuleType
from typing import Any

import pytest
from loudness import ALBUM_LOUDNESS_ROLLUP_SQL


class _ApplyingCursor:
    """Apply analyzer persistence statements to an in-memory music catalog."""

    def __init__(self, database: _ApplyingDatabase) -> None:
        self.database = database

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        assert params is not None
        if sql == self.database.save_sql:
            track = self.database.tracks[params[-1]]
            track["loudnessLufs"] = params[7]
            track["truePeakDb"] = params[8]
            return
        if sql == ALBUM_LOUDNESS_ROLLUP_SQL:
            self.database.roll_up_album(params[0])
            return
        if sql == self.database.resolve_sql:
            return
        raise AssertionError("unexpected persistence operation")

    def close(self) -> None:
        """Close the in-memory cursor."""


class _ApplyingDatabase:
    """Model track saves and weighted active-sibling album aggregation."""

    def __init__(self, module: ModuleType) -> None:
        self.save_sql = module._SAVE_ANALYSIS_RESULTS_SQL
        self.resolve_sql = module._RESOLVE_AUDIO_FAILURES_SQL
        self.tracks: dict[str, dict[str, Any]] = {}
        self.albums: dict[str, dict[str, float | None]] = {}
        self.cursor = _ApplyingCursor(self)
        self.commit_calls = 0
        self.rollback_calls = 0

    def get_cursor(self) -> _ApplyingCursor:
        """Return the state-applying cursor."""
        return self.cursor

    def commit(self) -> None:
        """Record a successful unit of work."""
        self.commit_calls += 1

    def rollback(self) -> None:
        """Record a failed unit of work."""
        self.rollback_calls += 1

    def roll_up_album(self, saved_track_id: str) -> None:
        """Apply the production weighted aggregate to eligible siblings."""
        album_id = self.tracks[saved_track_id]["albumId"]
        eligible = [
            track
            for track in self.tracks.values()
            if track["albumId"] == album_id
            and track["removedAt"] is None
            and track["loudnessLufs"] is not None
            and track["duration"] > 0
        ]
        album = self.albums[album_id]
        if not eligible:
            album["albumLoudnessLufs"] = None
            album["albumTruePeakDb"] = None
            return
        total_duration = sum(track["duration"] for track in eligible)
        mean_power = (
            sum(track["duration"] * 10 ** (track["loudnessLufs"] / 10) for track in eligible)
            / total_duration
        )
        album["albumLoudnessLufs"] = 10 * math.log10(mean_power)
        peaks = [track["truePeakDb"] for track in eligible if track["truePeakDb"] is not None]
        album["albumTruePeakDb"] = max(peaks) if peaks else None


def _track(
    album_id: str,
    loudness_lufs: float | None,
    true_peak_db: float | None,
    *,
    duration: int = 180,
    removed: bool = False,
) -> dict[str, Any]:
    """Build one in-memory track persistence row."""
    return {
        "albumId": album_id,
        "duration": duration,
        "removedAt": object() if removed else None,
        "loudnessLufs": loudness_lufs,
        "truePeakDb": true_peak_db,
    }


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
    values = loaded_analyzer._analysis_result_values(
        "track-1",
        analysis_features(),
    )

    assert loaded_analyzer._SAVE_ANALYSIS_RESULTS_SQL.count("%s") == len(values)


def test_album_rollup_weights_only_active_measured_siblings(
    loaded_analyzer: ModuleType,
) -> None:
    """Exclude a louder soft-removed sibling from weighted album values."""
    database = _ApplyingDatabase(loaded_analyzer)
    database.tracks = {
        "track-1": _track("album-1", None, None, duration=100),
        "track-2": _track("album-1", -20.0, -2.0, duration=300),
        "removed": _track("album-1", -5.0, 3.0, duration=500, removed=True),
    }
    database.albums = {"album-1": {"albumLoudnessLufs": -5.0, "albumTruePeakDb": 3.0}}
    worker = build_worker(loaded_analyzer, database)

    worker._save_results("track-1", "/music/track.flac", analysis_features())

    expected_power = (100 * 10 ** (-18.4 / 10) + 300 * 10 ** (-20.0 / 10)) / 400
    assert database.albums["album-1"]["albumLoudnessLufs"] == pytest.approx(
        10 * math.log10(expected_power)
    )
    assert database.albums["album-1"]["albumTruePeakDb"] == -1.2
    assert database.commit_calls == 1


def test_last_eligible_measurement_disappearing_clears_album_aggregate(
    loaded_analyzer: ModuleType,
) -> None:
    """Set both album values to null when no measured active sibling remains."""
    database = _ApplyingDatabase(loaded_analyzer)
    database.tracks = {
        "track-1": _track("album-1", -18.0, -1.0, removed=True),
    }
    database.albums = {"album-1": {"albumLoudnessLufs": -18.0, "albumTruePeakDb": -1.0}}
    worker = build_worker(loaded_analyzer, database)

    worker._save_results("track-1", "/music/track.flac", analysis_features())

    assert database.albums["album-1"] == {
        "albumLoudnessLufs": None,
        "albumTruePeakDb": None,
    }


def test_measured_to_null_transition_recomputes_album_aggregate(
    loaded_analyzer: ModuleType,
) -> None:
    """Clear a stale aggregate when re-analysis loses the last measurement."""
    database = _ApplyingDatabase(loaded_analyzer)
    database.tracks = {
        "track-1": _track("album-1", -18.0, -1.0),
    }
    database.albums = {"album-1": {"albumLoudnessLufs": -18.0, "albumTruePeakDb": -1.0}}
    worker = build_worker(loaded_analyzer, database)

    worker._save_results("track-1", "/music/track.flac", analysis_features(None))

    assert database.tracks["track-1"]["loudnessLufs"] is None
    assert database.albums["album-1"] == {
        "albumLoudnessLufs": None,
        "albumTruePeakDb": None,
    }
