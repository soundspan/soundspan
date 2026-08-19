"""Atomic PostgreSQL claim operations for audio-analysis reconciliation."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

_SELECT_RECONCILIATION_TRACKS_SQL = """
    SELECT id, "filePath"
    FROM "Track"
    WHERE "analysisStatus" = 'pending'
    AND COALESCE("analysisRetryCount", 0) < %s
    ORDER BY "fileModified" DESC
    LIMIT %s
    FOR UPDATE SKIP LOCKED
"""

_CLAIM_RECONCILIATION_TRACKS_SQL = """
    UPDATE "Track"
    SET "analysisStatus" = 'processing',
        "analysisStartedAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = ANY(%s)
    AND "analysisStatus" = 'pending'
    RETURNING id
"""


class _ReconciliationCursor(Protocol):
    """Describe the cursor operations required to claim reconciliation work."""

    def execute(self, query: object, params: object = None) -> None: ...

    def fetchall(self) -> list[Mapping[str, Any]]: ...


def claim_reconciliation_tracks(
    cursor: _ReconciliationCursor,
    max_retries: int,
    batch_size: int,
) -> list[tuple[str, str]]:
    """Lock and claim one bounded pending batch in the current transaction."""
    cursor.execute(_SELECT_RECONCILIATION_TRACKS_SQL, (max_retries, batch_size))
    tracks = cursor.fetchall()
    if not tracks:
        return []

    track_ids = [track["id"] for track in tracks]
    cursor.execute(_CLAIM_RECONCILIATION_TRACKS_SQL, (track_ids,))
    claimed_ids = {row["id"] for row in cursor.fetchall()}
    return [(track["id"], track["filePath"]) for track in tracks if track["id"] in claimed_ids]
