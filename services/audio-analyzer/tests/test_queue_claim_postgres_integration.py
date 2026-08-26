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

import acoustid_backfill
import pytest
from acoustid_backfill import AcoustIDBackfill
from fingerprint_persistence import persist_fingerprint

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
            cursor.execute(
                sql.SQL(
                    """
                    CREATE TABLE {}."TrackFingerprint" (
                        "trackId" TEXT PRIMARY KEY,
                        fingerprint TEXT NOT NULL,
                        duration INTEGER NOT NULL,
                        "fingerprintedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        "lookupStatus" TEXT NOT NULL DEFAULT 'pending',
                        "lookupStartedAt" TIMESTAMPTZ,
                        "lookupRetryCount" INTEGER NOT NULL DEFAULT 0,
                        "lookupError" TEXT,
                        "recordingMbid" TEXT,
                        "releaseGroupMbid" TEXT,
                        score DOUBLE PRECISION,
                        "lookedUpAt" TIMESTAMPTZ,
                        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                ).format(sql.Identifier(schema_name))
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


def _configure_database(module: ModuleType, schema_name: str):
    """Connect one analyzer database manager to the isolated test schema."""
    assert TEST_DATABASE_URL is not None
    database = module.DatabaseConnection(TEST_DATABASE_URL)
    database.connect()
    cursor = database.get_cursor()
    cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema_name)))
    database.commit()
    cursor.close()
    return database


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


def test_fingerprint_upsert_and_lookup_claim_round_trip(loaded_analyzer: ModuleType) -> None:
    """Prove fingerprint and claim SQL behavior against real PostgreSQL."""
    assert TEST_DATABASE_URL is not None
    schema_name = f"fingerprint_claim_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    database = loaded_analyzer.DatabaseConnection(TEST_DATABASE_URL)
    database.connect()

    class Client:
        def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
            assert (fingerprint, duration) == ("chromaprint-value", 247)
            return {
                "recordingMbid": "recording-mbid",
                "releaseGroupMbid": "release-group-mbid",
                "score": 0.91,
            }

    try:
        cursor = database.get_cursor()
        cursor.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema_name)))
        persist_fingerprint(
            cursor,
            "claim-track-a",
            {"fingerprint": "chromaprint-value", "duration": 247},
        )
        database.commit()
        cursor.close()

        worker = AcoustIDBackfill(database, "configured", client=Client())
        assert worker.run_once() is True

        cursor = database.get_cursor()
        cursor.execute(
            'SELECT "lookupStatus", "recordingMbid", "releaseGroupMbid", score '
            'FROM "TrackFingerprint" WHERE "trackId" = %s',
            ("claim-track-a",),
        )
        row = cursor.fetchone()
        database.commit()
        cursor.close()
        assert row == {
            "lookupStatus": "completed",
            "recordingMbid": "recording-mbid",
            "releaseGroupMbid": "release-group-mbid",
            "score": 0.91,
        }
    finally:
        database.close()
        _drop_test_schema(schema_name)


@pytest.mark.parametrize("lookup_fails", [False, True])
def test_lookup_compare_and_set_discards_refingerprinted_claim(
    loaded_analyzer: ModuleType,
    lookup_fails: bool,
) -> None:
    """Preserve a new pending fingerprint across stale lookup success and failure writes."""
    schema_name = f"fingerprint_race_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    database = _configure_database(loaded_analyzer, schema_name)

    class RefingerprintingClient:
        called = False

        def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
            assert (fingerprint, duration) == ("old-fingerprint", 247)
            cursor = database.get_cursor()
            persist_fingerprint(
                cursor,
                "claim-track-a",
                {"fingerprint": "new-fingerprint", "duration": 248},
            )
            database.commit()
            cursor.close()
            self.called = True
            if lookup_fails:
                raise acoustid_backfill.AcoustIDLookupError("timeout")
            return {
                "recordingMbid": "stale-recording",
                "releaseGroupMbid": "stale-release-group",
                "score": 0.99,
            }

    client = RefingerprintingClient()
    try:
        cursor = database.get_cursor()
        persist_fingerprint(
            cursor,
            "claim-track-a",
            {"fingerprint": "old-fingerprint", "duration": 247},
        )
        database.commit()
        cursor.close()

        worker = AcoustIDBackfill(database, "configured", client=client)
        assert worker.run_once(lambda: client.called) is True

        cursor = database.get_cursor()
        cursor.execute(
            'SELECT fingerprint, duration, "lookupStatus", "lookupRetryCount", '
            '"recordingMbid", "releaseGroupMbid", score '
            'FROM "TrackFingerprint" WHERE "trackId" = %s',
            ("claim-track-a",),
        )
        row = cursor.fetchone()
        database.commit()
        cursor.close()
        assert row == {
            "fingerprint": "new-fingerprint",
            "duration": 248,
            "lookupStatus": "pending",
            "lookupRetryCount": 0,
            "recordingMbid": None,
            "releaseGroupMbid": None,
            "score": None,
        }
    finally:
        database.close()
        _drop_test_schema(schema_name)


def test_lookup_owner_lock_excludes_second_replica_for_whole_pass(
    loaded_analyzer: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exclude another database session while the leader drains multiple batches."""
    schema_name = f"lookup_owner_{uuid.uuid4().hex}"
    _create_test_schema(schema_name)
    first_database = _configure_database(loaded_analyzer, schema_name)
    second_database = _configure_database(loaded_analyzer, schema_name)
    owner_key = f"soundspan:test:acoustid:{uuid.uuid4().hex}"
    monkeypatch.setattr(acoustid_backfill, "LOOKUP_OWNER_KEY", owner_key)

    class SecondClient:
        calls = 0

        def lookup(self, _fingerprint: str, _duration: int) -> None:
            self.calls += 1

    second_client = SecondClient()
    second_worker = AcoustIDBackfill(second_database, "configured", client=second_client)

    class LeaderClient:
        def __init__(self) -> None:
            self.calls: list[tuple[str, int]] = []
            self.handoffs: list[bool] = []

        def lookup(self, fingerprint: str, duration: int) -> None:
            self.calls.append((fingerprint, duration))
            self.handoffs.append(second_worker.run_once())

    leader_client = LeaderClient()
    try:
        cursor = first_database.get_cursor()
        persist_fingerprint(cursor, "claim-track-a", {"fingerprint": "fp-a", "duration": 247})
        persist_fingerprint(cursor, "claim-track-b", {"fingerprint": "fp-b", "duration": 248})
        first_database.commit()
        cursor.close()

        leader = AcoustIDBackfill(
            first_database,
            "configured",
            client=leader_client,
            batch_size=1,
        )
        assert leader.run_once() is True
        assert leader_client.calls == [("fp-a", 247), ("fp-b", 248)]
        assert leader_client.handoffs == [False, False]
        assert second_client.calls == 0
    finally:
        first_database.close()
        second_database.close()
        _drop_test_schema(schema_name)
