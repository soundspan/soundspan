-- Add per-device playback state and track position persistence
ALTER TABLE "PlaybackState"
    ADD COLUMN IF NOT EXISTS "deviceId" TEXT NOT NULL DEFAULT 'legacy',
    ADD COLUMN IF NOT EXISTS "currentTime" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Replace single-row-per-user primary key with composite key (user + device)
ALTER TABLE "PlaybackState" DROP CONSTRAINT IF EXISTS "PlaybackState_pkey";
ALTER TABLE "PlaybackState"
    ADD CONSTRAINT "PlaybackState_pkey" PRIMARY KEY ("userId", "deviceId");

DROP INDEX IF EXISTS "PlaybackState_userId_idx";
CREATE INDEX IF NOT EXISTS "PlaybackState_userId_updatedAt_idx"
    ON "PlaybackState"("userId", "updatedAt");
