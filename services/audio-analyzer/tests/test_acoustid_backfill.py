"""Behavioral coverage for resumable AcoustID lookup claims."""

from __future__ import annotations

import logging

import acoustid_backfill
import pytest
from conftest import FakeDatabaseConnection


class _LookupClient:
    """Return one deterministic accepted lookup result."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
        self.calls.append((fingerprint, duration))
        return {
            "recordingMbid": "recording-mbid",
            "releaseGroupMbid": "release-group-mbid",
            "score": 0.91,
        }


class _ReplicaHandoffClient(_LookupClient):
    """Attempt a second replica pass while the leader is inside its lookup."""

    def __init__(self, second_worker: acoustid_backfill.AcoustIDBackfill) -> None:
        super().__init__()
        self.second_worker = second_worker
        self.second_result: bool | None = None

    def lookup(self, fingerprint: str, duration: int) -> dict[str, object]:
        self.second_result = self.second_worker.run_once()
        return super().lookup(fingerprint, duration)


class _FailingLookupClient:
    """Raise one deterministic retryable lookup failure."""

    def lookup(self, _fingerprint: str, _duration: int) -> None:
        raise acoustid_backfill.AcoustIDLookupError("timeout")


def test_no_key_skips_without_database_or_lookup_work() -> None:
    """Disable network lookup cleanly while local fingerprinting remains available."""
    database = FakeDatabaseConnection()
    worker = acoustid_backfill.AcoustIDBackfill(database, api_key="")

    assert worker.run_once() is False
    assert database.get_cursor_calls == 0


def test_busy_deployment_lock_skips_without_claiming() -> None:
    """Let one replica own the rate-limited pass across the deployment."""
    database = FakeDatabaseConnection([[{"acquired": False}]])
    client = _LookupClient()
    worker = acoustid_backfill.AcoustIDBackfill(
        database,
        api_key="configured",
        client=client,
    )

    assert worker.run_once() is False
    assert client.calls == []
    assert len(database.cursor.executions) == 1
    assert database.commit_calls == 1


def test_replica_handoff_skips_while_leader_holds_whole_pass_lock() -> None:
    """Keep a second replica out while the leader drains more than one batch."""
    second_database = FakeDatabaseConnection([[{"acquired": False}]])
    second_client = _LookupClient()
    second_worker = acoustid_backfill.AcoustIDBackfill(
        second_database,
        api_key="configured",
        client=second_client,
    )
    leader_database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"trackId": "track-1", "fingerprint": "fp-1", "duration": 247}],
            [{"trackId": "track-1"}],
            [{"trackId": "track-1"}],
            [{"backend_pid": 101}],
            [{"trackId": "track-2", "fingerprint": "fp-2", "duration": 248}],
            [{"trackId": "track-2"}],
            [{"trackId": "track-2"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    leader_client = _ReplicaHandoffClient(second_worker)
    leader = acoustid_backfill.AcoustIDBackfill(
        leader_database,
        api_key="configured",
        client=leader_client,
        batch_size=1,
    )

    assert leader.run_once() is True
    assert leader_client.second_result is False
    assert leader_client.calls == [("fp-1", 247), ("fp-2", 248)]
    assert second_client.calls == []
    release_index = next(
        index
        for index, (sql, _params) in enumerate(leader_database.cursor.executions)
        if "pg_advisory_unlock" in sql
    )
    second_claim_index = next(
        index
        for index, (sql, _params) in enumerate(leader_database.cursor.executions)
        if "fingerprint = %s" in sql and "\"lookupStatus\" = 'processing'" in sql
    )
    assert release_index > second_claim_index


def test_backend_session_change_aborts_owned_pass_before_next_batch(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Stop lookup work when reconnecting loses the session-level owner lock."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"trackId": "track-1", "fingerprint": "fp-1", "duration": 247}],
            [{"trackId": "track-1"}],
            [{"trackId": "track-1"}],
            [{"backend_pid": 202}],
        ]
    )
    client = _LookupClient()
    worker = acoustid_backfill.AcoustIDBackfill(
        database,
        api_key="configured",
        client=client,
        batch_size=1,
    )

    with caplog.at_level(logging.WARNING):
        assert worker.run_once() is True

    assert client.calls == [("fp-1", 247)]
    assert "AcoustID lookup owner session changed" in caplog.text
    claim_executions = [
        sql for sql, _params in database.cursor.executions if "FOR UPDATE SKIP LOCKED" in sql
    ]
    assert len(claim_executions) == 1
    # The new session never owned the lock, so no unlock may be attempted.
    unlock_executions = [
        sql for sql, _params in database.cursor.executions if "pg_advisory_unlock" in sql
    ]
    assert unlock_executions == []


def test_claimed_batch_is_committed_then_resumed_and_persisted() -> None:
    """Claim a bounded batch before lookup and save each completed result."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"trackId": "track-1", "fingerprint": "fp", "duration": 247}],
            [{"trackId": "track-1"}],
            [{"trackId": "track-1"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    client = _LookupClient()
    worker = acoustid_backfill.AcoustIDBackfill(
        database,
        api_key="configured",
        client=client,
        batch_size=10,
    )

    assert worker.run_once() is True
    assert client.calls == [("fp", 247)]
    assert database.commit_calls == 4
    assert database.rollback_calls == 0
    assert "pg_try_advisory_lock" in database.cursor.executions[0][0]
    assert "FOR UPDATE SKIP LOCKED" in database.cursor.executions[2][0]
    assert database.cursor.executions[2][1] == (15, 3, 10)
    assert database.cursor.executions[4][1] == (
        "recording-mbid",
        "release-group-mbid",
        0.91,
        "track-1",
        "fp",
    )


def test_changed_fingerprint_discards_stale_lookup_result(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Do not overwrite identity after a claimed track is re-fingerprinted during HTTP."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"trackId": "track-1", "fingerprint": "old-fp", "duration": 247}],
            [{"trackId": "track-1"}],
            [],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    client = _LookupClient()
    worker = acoustid_backfill.AcoustIDBackfill(database, "configured", client=client)

    with caplog.at_level(logging.INFO):
        assert worker.run_once() is True
    assert client.calls == [("old-fp", 247)]
    _, save_params = database.cursor.executions[4]
    assert save_params[-2:] == ("track-1", "old-fp")
    assert "1 claimed, 0 completed, 0 failed" in caplog.text


def test_changed_fingerprint_discards_stale_lookup_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Do not consume retry budget after a failed claim is re-fingerprinted during HTTP."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"trackId": "track-1", "fingerprint": "old-fp", "duration": 247}],
            [{"trackId": "track-1"}],
            [],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    worker = acoustid_backfill.AcoustIDBackfill(
        database,
        "configured",
        client=_FailingLookupClient(),
    )

    with caplog.at_level(logging.INFO):
        assert worker.run_once() is True
    _, failure_params = database.cursor.executions[4]
    assert failure_params[-2:] == ("track-1", "old-fp")
    assert "1 claimed, 0 completed, 0 failed" in caplog.text


def test_lookup_save_sql_placeholder_count_matches_tuple_arity() -> None:
    """Keep AcoustID save SQL and positional values in lockstep."""
    values = acoustid_backfill.lookup_result_values(
        "track-1",
        "fingerprint",
        {
            "recordingMbid": "recording-mbid",
            "releaseGroupMbid": None,
            "score": 0.8,
        },
    )

    assert acoustid_backfill.SAVE_LOOKUP_SQL.count("%s") == len(values)


def test_completed_batch_logs_bounded_progress(caplog: pytest.LogCaptureFixture) -> None:
    """Report one aggregate progress line for a claimed batch."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [{"trackId": "track-1", "fingerprint": "fp", "duration": 247}],
            [{"trackId": "track-1"}],
            [{"trackId": "track-1"}],
            [{"backend_pid": 101}],
            [],
            [{"released": True}],
        ]
    )
    worker = acoustid_backfill.AcoustIDBackfill(
        database,
        api_key="configured",
        client=_LookupClient(),
    )

    with caplog.at_level(logging.INFO):
        worker.run_once()

    assert "AcoustID lookup batch complete: 1 claimed, 1 completed, 0 failed" in caplog.text


def test_shutdown_stops_mid_batch_without_processing_remaining_rows() -> None:
    """A stop request between rows abandons the rest of the claimed batch."""
    database = FakeDatabaseConnection(
        [
            [{"acquired": True, "backend_pid": 101}],
            [{"backend_pid": 101}],
            [
                {"trackId": "track-1", "fingerprint": "fp-1", "duration": 247},
                {"trackId": "track-2", "fingerprint": "fp-2", "duration": 248},
                {"trackId": "track-3", "fingerprint": "fp-3", "duration": 249},
            ],
            [{"trackId": "track-1"}],
            [{"trackId": "track-1"}],
            [{"released": True}],
        ]
    )
    client = _LookupClient()
    worker = acoustid_backfill.AcoustIDBackfill(
        database,
        api_key="configured",
        client=client,
        batch_size=10,
    )
    stops = iter([False, False, True, True])

    assert worker.run_once(lambda: next(stops)) is True
    # Only the first row was looked up; the stop landed before row two.
    assert client.calls == [("fp-1", 247)]
