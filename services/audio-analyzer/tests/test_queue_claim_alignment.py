"""Behavioral coverage for producer and consumer queue-claim alignment."""

from __future__ import annotations

import json
from types import ModuleType

from conftest import FakeDatabaseConnection, FakeRedis


def _build_worker(
    module: ModuleType,
    database: FakeDatabaseConnection,
    redis_client: FakeRedis | None = None,
) -> object:
    """Build an analysis worker without running external-client initialization."""
    worker = object.__new__(module.AnalysisWorker)
    worker.db = database
    worker.redis = redis_client or FakeRedis()
    return worker


def test_claim_tracks_keeps_only_rows_returned_by_database(loaded_analyzer: ModuleType) -> None:
    """Keep eligible pending and pre-claimed tracks while filtering stale jobs."""
    tracks = [
        ("pending-track", "/music/pending.flac"),
        ("processing-track", "/music/processing.flac"),
        ("stale-track", "/music/stale.flac"),
    ]
    database = FakeDatabaseConnection([[{"id": "pending-track"}, {"id": "processing-track"}]])
    worker = _build_worker(loaded_analyzer, database)

    claimed = worker._claim_tracks_for_processing(tracks)

    assert claimed == tracks[:2]
    assert len(database.cursor.executions) == 1
    sql, params = database.cursor.executions[0]
    assert "\"analysisStatus\" IN ('pending', 'processing')" in sql
    assert params == ([track_id for track_id, _ in tracks],)
    assert database.commit_calls == 1
    assert database.cursor.closed is True


def test_claim_tracks_rolls_back_database_errors(loaded_analyzer: ModuleType) -> None:
    """Return no work and roll back when the claim update fails."""
    database = FakeDatabaseConnection(fail_on_execute=1)
    worker = _build_worker(loaded_analyzer, database)

    claimed = worker._claim_tracks_for_processing([("track-a", "/music/a.flac")])

    assert claimed == []
    assert database.rollback_calls == 1
    assert database.commit_calls == 0
    assert database.cursor.closed is True


def test_reconciliation_queues_only_tracks_preclaimed_by_database(
    loaded_analyzer: ModuleType,
) -> None:
    """Queue only pending tracks successfully transitioned to processing."""
    tracks = [
        {"id": "track-a", "filePath": "/music/a.flac"},
        {"id": "track-b", "filePath": "/music/b.flac"},
    ]
    database = FakeDatabaseConnection([tracks, [{"id": "track-b"}]])
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)

    found_work = worker._run_db_reconciliation()

    assert found_work is True
    assert len(database.cursor.executions) == 2
    update_sql, update_params = database.cursor.executions[1]
    assert "SET \"analysisStatus\" = 'processing'" in update_sql
    assert "AND \"analysisStatus\" = 'pending'" in update_sql
    assert update_params == (["track-a", "track-b"],)
    assert database.commit_calls == 1
    assert redis_client.queue_pipeline.pushes == [
        (
            loaded_analyzer.ANALYSIS_QUEUE,
            json.dumps({"trackId": "track-b", "filePath": "/music/b.flac"}),
        )
    ]
    assert redis_client.queue_pipeline.execute_calls == 1


def test_reconciliation_closes_empty_read_transaction(loaded_analyzer: ModuleType) -> None:
    """Commit an empty reconciliation read without touching Redis."""
    database = FakeDatabaseConnection([[]])
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)

    found_work = worker._run_db_reconciliation()

    assert found_work is False
    assert database.commit_calls == 1
    assert database.rollback_calls == 0
    assert redis_client.pipeline_calls == 0
    assert redis_client.queue_pipeline.pushes == []
    assert database.cursor.closed is True
