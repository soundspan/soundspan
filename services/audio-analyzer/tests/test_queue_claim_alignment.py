"""Behavioral coverage for producer and consumer queue-claim alignment."""

from __future__ import annotations

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
    """Keep only tracks atomically claimed from pending state."""
    tracks = [
        ("pending-track", "/music/pending.flac"),
        ("processing-track", "/music/processing.flac"),
        ("stale-track", "/music/stale.flac"),
    ]
    database = FakeDatabaseConnection([[{"id": "pending-track"}]])
    worker = _build_worker(loaded_analyzer, database)

    claimed = worker._claim_tracks_for_processing(tracks)

    assert claimed == tracks[:1]
    assert len(database.cursor.executions) == 1
    sql, params = database.cursor.executions[0]
    assert "\"analysisStatus\" = 'pending'" in sql
    assert '"analysisStartedAt" = NOW()' in sql
    assert "COALESCE" not in sql
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


def test_reconciliation_processes_pending_tracks_without_redis_handoff(
    loaded_analyzer: ModuleType,
) -> None:
    """Process reconciliation rows directly so the consumer owns the claim."""
    tracks = [
        {"id": "track-a", "filePath": "/music/a.flac"},
        {"id": "track-b", "filePath": "/music/b.flac"},
    ]
    database = FakeDatabaseConnection([tracks, [{"id": "track-a"}, {"id": "track-b"}]])
    redis_client = FakeRedis()
    worker = _build_worker(loaded_analyzer, database, redis_client)
    processed: list[list[tuple[str, str]]] = []
    worker._process_claimed_tracks_parallel = lambda batch: processed.append(batch)

    found_work = worker._run_db_reconciliation()

    assert found_work is True
    assert len(database.cursor.executions) == 2
    select_sql, select_params = database.cursor.executions[0]
    claim_sql, claim_params = database.cursor.executions[1]
    assert "FOR UPDATE SKIP LOCKED" in select_sql
    assert select_params == (loaded_analyzer.MAX_RETRIES, loaded_analyzer.BATCH_SIZE)
    assert "\"analysisStatus\" = 'processing'" in claim_sql
    assert "\"analysisStatus\" = 'pending'" in claim_sql
    assert claim_params == (["track-a", "track-b"],)
    assert database.commit_calls == 1
    assert processed == [[("track-a", "/music/a.flac"), ("track-b", "/music/b.flac")]]
    assert redis_client.pipeline_calls == 1
    assert redis_client.queue_pipeline.deletes == [
        "audio:analysis:queue:reserved:track-a",
        "audio:analysis:queue:reserved:track-b",
    ]


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


def test_reconciliation_processes_only_rows_claimed_in_its_transaction(
    loaded_analyzer: ModuleType,
) -> None:
    """Discard rows that changed state after the locking select."""
    tracks = [
        {"id": "track-a", "filePath": "/music/a.flac"},
        {"id": "track-b", "filePath": "/music/b.flac"},
    ]
    database = FakeDatabaseConnection([tracks, [{"id": "track-b"}]])
    worker = _build_worker(loaded_analyzer, database)
    processed: list[list[tuple[str, str]]] = []
    worker._process_claimed_tracks_parallel = lambda batch: processed.append(batch)

    found_work = worker._run_db_reconciliation()

    assert found_work is True
    assert processed == [[("track-b", "/music/b.flac")]]
    assert database.commit_calls == 1
