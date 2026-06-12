-- Create new FK-based remote likes table.
CREATE TABLE IF NOT EXISTS "LikedRemoteTrack" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackTidalId" TEXT,
    "trackYtMusicId" TEXT,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LikedRemoteTrack_pkey" PRIMARY KEY ("id")
);

-- Uniqueness by provider-entity per user.
CREATE UNIQUE INDEX IF NOT EXISTS "LikedRemoteTrack_userId_trackTidalId_key"
    ON "LikedRemoteTrack" ("userId", "trackTidalId");

CREATE UNIQUE INDEX IF NOT EXISTS "LikedRemoteTrack_userId_trackYtMusicId_key"
    ON "LikedRemoteTrack" ("userId", "trackYtMusicId");

CREATE INDEX IF NOT EXISTS "LikedRemoteTrack_userId_idx"
    ON "LikedRemoteTrack" ("userId");

CREATE INDEX IF NOT EXISTS "LikedRemoteTrack_likedAt_idx"
    ON "LikedRemoteTrack" ("likedAt");

ALTER TABLE "LikedRemoteTrack"
    ADD CONSTRAINT "LikedRemoteTrack_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LikedRemoteTrack"
    ADD CONSTRAINT "LikedRemoteTrack_trackTidalId_fkey"
    FOREIGN KEY ("trackTidalId") REFERENCES "TrackTidal"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LikedRemoteTrack"
    ADD CONSTRAINT "LikedRemoteTrack_trackYtMusicId_fkey"
    FOREIGN KEY ("trackYtMusicId") REFERENCES "TrackYtMusic"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
