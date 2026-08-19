"""Behavioral coverage for process-pool crash detection and recovery."""

from __future__ import annotations

import json
import sys
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from types import ModuleType
from typing import Any

import pytest
from conftest import FakeDatabaseConnection, FakeRedis


def _build_worker(
    module: ModuleType,
    database: FakeDatabaseConnection | None = None,
    redis_client: FakeRedis | None = None,
) -> object:
    """Build an analysis worker without running external-client initialization."""
    worker = object.__new__(module.AnalysisWorker)
    worker.db = database or FakeDatabaseConnection()
    worker.redis = redis_client or FakeRedis()
    return worker


@pytest.mark.parametrize(
    "error",
    [
        BrokenProcessPool("pool unavailable"),
        RuntimeError("A process in the process pool was terminated"),
        RuntimeError("worker TERMINATED ABRUPTLY"),
    ],
)
def test_pool_crash_detection_accepts_known_failures(
    loaded_analyzer: ModuleType,
    error: Exception,
) -> None:
    """Recognize typed and message-based process-pool failures."""
    assert loaded_analyzer.AnalysisWorker._is_pool_crash_error(error) is True


def test_pool_crash_detection_rejects_ordinary_errors(loaded_analyzer: ModuleType) -> None:
    """Do not classify an ordinary analysis exception as a pool crash."""
    assert loaded_analyzer.AnalysisWorker._is_pool_crash_error(ValueError("bad audio")) is False


def test_consume_batch_results_requeues_unfinalized_tracks_after_pool_crash(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cancel pending work, requeue unfinished tracks, and propagate pool failure."""
    successful: Future[tuple[str, str, dict[str, Any]]] = Future()
    successful.set_result(("track-a", "/music/a.flac", {"bpm": 120.0}))
    crashed: Future[tuple[str, str, dict[str, Any]]] = Future()
    crashed.set_exception(BrokenProcessPool("worker exited"))
    pending: Future[tuple[str, str, dict[str, Any]]] = Future()
    tracks = [
        ("track-a", "/music/a.flac"),
        ("track-b", "/music/b.flac"),
        ("track-c", "/music/c.flac"),
    ]
    futures = dict(zip((successful, crashed, pending), tracks, strict=True))
    worker = _build_worker(loaded_analyzer)
    saved_results: list[tuple[str, str, dict[str, Any]]] = []
    requeues: list[tuple[list[tuple[str, str]], str]] = []
    monkeypatch.setattr(
        worker,
        "_save_results",
        lambda *args: saved_results.append(args) or True,
    )
    monkeypatch.setattr(
        worker,
        "_requeue_tracks_for_retry",
        lambda retry_tracks, reason: requeues.append((retry_tracks, reason)),
    )
    monkeypatch.setattr(
        loaded_analyzer,
        "as_completed",
        lambda _futures, timeout: iter((successful, crashed)),
    )
    counts = {"completed": 0, "failed": 0, "permanent_failed": 0}
    finalized_track_ids: set[str] = set()

    with pytest.raises(BrokenProcessPool, match="worker exited"):
        worker._consume_batch_results(futures, tracks, finalized_track_ids, counts)

    assert saved_results == [("track-a", "/music/a.flac", {"bpm": 120.0})]
    assert finalized_track_ids == {"track-a"}
    assert counts == {"completed": 1, "failed": 0, "permanent_failed": 0}
    assert pending.cancelled() is True
    assert requeues == [
        (
            [("track-b", "/music/b.flac"), ("track-c", "/music/c.flac")],
            "Analyzer worker process crashed; re-queued for retry",
        )
    ]


def test_consume_batch_results_records_retryable_ordinary_failure(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Persist an ordinary future exception as retryable without requeueing."""
    failed_future: Future[tuple[str, str, dict[str, Any]]] = Future()
    failed_future.set_exception(ValueError("decode failed"))
    track = ("track-a", "/music/a.flac")
    worker = _build_worker(loaded_analyzer)
    failures: list[tuple[str, str, bool]] = []
    requeues: list[tuple[list[tuple[str, str]], str]] = []
    monkeypatch.setattr(
        worker,
        "_save_failed",
        lambda track_id, error, permanent=False: failures.append((track_id, error, permanent)),
    )
    monkeypatch.setattr(
        worker,
        "_requeue_tracks_for_retry",
        lambda tracks, reason: requeues.append((tracks, reason)),
    )
    counts = {"completed": 0, "failed": 0, "permanent_failed": 0}
    finalized_track_ids: set[str] = set()

    worker._consume_batch_results(
        {failed_future: track},
        [track],
        finalized_track_ids,
        counts,
    )

    assert failures == [("track-a", "Timeout or error: decode failed", False)]
    assert counts == {"completed": 0, "failed": 1, "permanent_failed": 0}
    assert finalized_track_ids == {"track-a"}
    assert requeues == []


def test_requeue_tracks_resets_only_eligible_rows_without_retry_cost(
    loaded_analyzer: ModuleType,
) -> None:
    """Reset processing rows and queue only identifiers returned by PostgreSQL."""
    database = FakeDatabaseConnection([[{"id": "track-b"}]])
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)
    tracks = [("track-a", "/music/a.flac"), ("track-b", "/music/b.flac")]
    reason = "pool crash: " + ("x" * 600)

    worker._requeue_tracks_for_retry(tracks, reason)

    assert len(database.cursor.executions) == 1
    sql, params = database.cursor.executions[0]
    assert "\"analysisStatus\" = 'pending'" in sql
    assert '"analysisStartedAt" = NULL' in sql
    assert "AND \"analysisStatus\" = 'processing'" in sql
    assert '"analysisRetryCount"' not in sql
    assert params == (reason[:500], ["track-a", "track-b"])
    assert len(params[0]) <= 500
    assert database.commit_calls == 1
    assert redis_client.queue_pipeline.pushes == [
        (
            loaded_analyzer.ANALYSIS_QUEUE,
            json.dumps({"trackId": "track-b", "filePath": "/music/b.flac"}),
        )
    ]
    assert redis_client.queue_pipeline.execute_calls == 1


def test_requeue_tracks_skips_redis_when_no_rows_are_eligible(
    loaded_analyzer: ModuleType,
) -> None:
    """Avoid queue writes when PostgreSQL returns no reset track identifiers."""
    database = FakeDatabaseConnection([[]])
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)

    worker._requeue_tracks_for_retry([("track-a", "/music/a.flac")], "pool crash")

    assert database.commit_calls == 1
    assert redis_client.pipeline_calls == 0
    assert redis_client.queue_pipeline.pushes == []


def test_requeue_tracks_rolls_back_database_errors_without_raising(
    loaded_analyzer: ModuleType,
) -> None:
    """Roll back a failed reset and avoid publishing retry jobs."""
    database = FakeDatabaseConnection(fail_on_execute=1)
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)

    worker._requeue_tracks_for_retry([("track-a", "/music/a.flac")], "pool crash")

    assert database.rollback_calls == 1
    assert database.commit_calls == 0
    assert database.cursor.closed is True
    assert redis_client.pipeline_calls == 0


def test_requeue_tracks_returns_before_opening_database_for_empty_input(
    loaded_analyzer: ModuleType,
) -> None:
    """Perform no database or Redis work for an empty retry list."""
    database = FakeDatabaseConnection()
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)

    worker._requeue_tracks_for_retry([], "pool crash")

    assert database.get_cursor_calls == 0
    assert database.cursor.executions == []
    assert redis_client.pipeline_calls == 0


def test_load_ml_models_uses_essentia_wrappers_without_tensorflow_import(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Enable enhanced mode through Essentia wrappers without importing TensorFlow."""
    assert "tensorflow" not in sys.modules
    base_calls: list[dict[str, Any]] = []
    head_calls: list[dict[str, Any]] = []

    class TensorflowPredictMusiCNN:
        """Record base-model constructor arguments."""

        def __init__(self, **kwargs: Any) -> None:
            base_calls.append(kwargs)

    class TensorflowPredict2D:
        """Record classification-head constructor arguments."""

        def __init__(self, **kwargs: Any) -> None:
            head_calls.append(kwargs)

    essentia_stub = ModuleType("essentia")
    standard_stub = ModuleType("essentia.standard")
    standard_stub.TensorflowPredictMusiCNN = TensorflowPredictMusiCNN  # type: ignore[attr-defined]
    standard_stub.TensorflowPredict2D = TensorflowPredict2D  # type: ignore[attr-defined]
    essentia_stub.standard = standard_stub  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "essentia", essentia_stub)
    monkeypatch.setitem(sys.modules, "essentia.standard", standard_stub)
    monkeypatch.setattr(loaded_analyzer, "TF_MODELS_AVAILABLE", True)
    monkeypatch.setattr(loaded_analyzer.os.path, "exists", lambda _path: True)
    analyzer_obj = object.__new__(loaded_analyzer.AudioAnalyzer)
    analyzer_obj.enhanced_mode = False
    analyzer_obj.musicnn_model = None
    analyzer_obj.prediction_models = {}

    analyzer_obj._load_ml_models()

    assert analyzer_obj.enhanced_mode is True
    assert base_calls == [
        {
            "graphFilename": loaded_analyzer.MODELS["musicnn"],
            "output": "model/dense/BiasAdd",
        }
    ]
    assert {call["graphFilename"] for call in head_calls} == {
        loaded_analyzer.MODELS[name]
        for name in (
            "mood_happy",
            "mood_sad",
            "mood_relaxed",
            "mood_aggressive",
            "mood_party",
            "mood_acoustic",
            "mood_electronic",
            "danceability",
            "voice_instrumental",
        )
    }
    assert "tensorflow" not in sys.modules
