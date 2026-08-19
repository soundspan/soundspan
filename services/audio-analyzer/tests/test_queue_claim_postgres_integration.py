"""Real-PostgreSQL proof for concurrent reconciliation claims.

The test is environment-gated for local analyzer runs. The repository's Backend
PostgreSQL Integration job supplies TEST_DATABASE_URL and runs this file.
"""

from __future__ import annotations

import importlib
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import ModuleType

import pytest

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required for PostgreSQL integration",
)

if TEST_DATABASE_URL:
    import psycopg2
    from psycopg2 import sql
    from psycopg2.extras import RealDictCursor


def _claim_in_transaction(
    module: ModuleType,
    schema_name: str,
    start_barrier: threading.Barrier,
    claimed_barrier: threading.Barrier,
) -> list[str]:
    """Claim one batch and hold its locks until both transactions have selected."""
    assert TEST_DATABASE_URL is not None
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    try:
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(
                sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(schema_name))
            )
            cursor.execute("SET LOCAL statement_timeout = '5s'")
            start_barrier.wait(timeout=5)
            worker = object.__new__(module.AnalysisWorker)
            claimed = worker._select_and_claim_reconciliation_tracks(cursor)
            claimed_barrier.wait(timeout=5)
        connection.commit()
        return [track_id for track_id, _ in claimed]
    finally:
        connection.close()


def _create_test_schema(schema_name: str) -> list[str]:
    """Create an isolated minimal Track table and seed two claim batches."""
    assert TEST_DATABASE_URL is not None
    track_ids = ["claim-track-a", "claim-track-b", "claim-track-c", "claim-track-d"]
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema_name)))
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."Track" (
                        id TEXT PRIMARY KEY,
                        "filePath" TEXT NOT NULL,
                        "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
                        "analysisRetryCount" INTEGER NOT NULL DEFAULT 0,
                        "fileModified" TIMESTAMP NOT NULL,
                        "analysisStartedAt" TIMESTAMP,
                        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                ).format(sql.Identifier(schema_name))
            )
            cursor.executemany(
                sql.SQL(
                    """
                    INSERT INTO {}."Track" (id, "filePath", "fileModified")
                    VALUES (%s, %s, NOW() - (%s * INTERVAL '1 second'))
                    """
                ).format(sql.Identifier(schema_name)),
                [
                    ("claim-track-a", "/music/a.flac", 1),
                    ("claim-track-b", "/music/b.flac", 2),
                    ("claim-track-c", "/music/c.flac", 3),
                    ("claim-track-d", "/music/d.flac", 4),
                ],
            )
    finally:
        connection.close()
    return track_ids


def _drop_test_schema(schema_name: str) -> None:
    """Drop the isolated integration schema after both transactions close."""
    assert TEST_DATABASE_URL is not None
    connection = psycopg2.connect(TEST_DATABASE_URL, connect_timeout=5)
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema_name)))
    finally:
        connection.close()


def test_reconciliation_claims_are_disjoint_across_transactions(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claim every pending row exactly once across two live transactions."""
    connection_module = importlib.import_module("database_connection")
    assert loaded_analyzer.psycopg2 is psycopg2
    assert connection_module.psycopg2 is psycopg2

    schema_name = f"analyzer_claim_{uuid.uuid4().hex}"
    expected_ids = _create_test_schema(schema_name)
    monkeypatch.setattr(loaded_analyzer, "BATCH_SIZE", 2)
    start_barrier = threading.Barrier(2)
    claimed_barrier = threading.Barrier(2)

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(
                    _claim_in_transaction,
                    loaded_analyzer,
                    schema_name,
                    start_barrier,
                    claimed_barrier,
                )
                for _ in range(2)
            ]
            first_claim, second_claim = [future.result(timeout=10) for future in futures]

        assert set(first_claim).isdisjoint(second_claim)
        assert sorted(first_claim + second_claim) == sorted(expected_ids)
        assert len(first_claim + second_claim) == len(set(first_claim + second_claim))
    finally:
        _drop_test_schema(schema_name)
