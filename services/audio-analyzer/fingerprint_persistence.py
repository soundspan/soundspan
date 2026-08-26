"""Parameterized persistence for locally computed track fingerprints."""

from __future__ import annotations

from typing import Protocol

from fingerprinting import Fingerprint

SAVE_FINGERPRINT_SQL = """
    INSERT INTO "TrackFingerprint" (
        "trackId", fingerprint, duration, "fingerprintedAt", "updatedAt"
    ) VALUES (%s, %s, %s, NOW(), NOW())
    ON CONFLICT ("trackId") DO UPDATE SET
        fingerprint = EXCLUDED.fingerprint,
        duration = EXCLUDED.duration,
        "fingerprintedAt" = NOW(),
        "lookupStatus" = 'pending',
        "lookupStartedAt" = NULL,
        "lookupRetryCount" = 0,
        "lookupError" = NULL,
        "recordingMbid" = NULL,
        "releaseGroupMbid" = NULL,
        score = NULL,
        "lookedUpAt" = NULL,
        "updatedAt" = NOW()
    WHERE "TrackFingerprint".fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
       OR "TrackFingerprint".duration IS DISTINCT FROM EXCLUDED.duration
"""


class Cursor(Protocol):
    """Describe the cursor operation required by fingerprint persistence."""

    def execute(self, query: object, params: object = None) -> None: ...


def fingerprint_values(track_id: str, fingerprint: Fingerprint) -> tuple[str | int, ...]:
    """Build positional values for one fingerprint upsert."""
    return (track_id, fingerprint["fingerprint"], fingerprint["duration"])


def persist_fingerprint(
    cursor: Cursor,
    track_id: str,
    fingerprint: Fingerprint | None,
) -> None:
    """Save an available fingerprint without disturbing an unchanged lookup."""
    if fingerprint is None:
        return
    cursor.execute(SAVE_FINGERPRINT_SQL, fingerprint_values(track_id, fingerprint))
