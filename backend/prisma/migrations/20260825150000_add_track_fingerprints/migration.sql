-- Persist local Chromaprint output independently from optional AcoustID lookup
-- state. IF NOT EXISTS keeps this migration safe to re-run after an interrupted
-- deployment without requiring audio to be decoded again.
CREATE TABLE IF NOT EXISTS "TrackFingerprint" (
    "trackId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "fingerprintedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lookupStatus" TEXT NOT NULL DEFAULT 'pending',
    "lookupStartedAt" TIMESTAMPTZ,
    "lookupRetryCount" INTEGER NOT NULL DEFAULT 0,
    "lookupError" TEXT,
    "recordingMbid" TEXT,
    "releaseGroupMbid" TEXT,
    "score" DOUBLE PRECISION,
    "lookedUpAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackFingerprint_pkey" PRIMARY KEY ("trackId"),
    CONSTRAINT "TrackFingerprint_trackId_fkey"
        FOREIGN KEY ("trackId") REFERENCES "Track"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TrackFingerprint_lookupStatus_lookupRetryCount_fingerprintedAt_idx"
    ON "TrackFingerprint"("lookupStatus", "lookupRetryCount", "fingerprintedAt");

CREATE INDEX IF NOT EXISTS "TrackFingerprint_recordingMbid_idx"
    ON "TrackFingerprint"("recordingMbid");

CREATE INDEX IF NOT EXISTS "TrackFingerprint_releaseGroupMbid_idx"
    ON "TrackFingerprint"("releaseGroupMbid");
