-- Extend ListenSource enum for remote play attribution.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum
        WHERE enumlabel = 'TIDAL'
          AND enumtypid = '"ListenSource"'::regtype
    ) THEN
        ALTER TYPE "ListenSource" ADD VALUE 'TIDAL';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum
        WHERE enumlabel = 'YOUTUBE_MUSIC'
          AND enumtypid = '"ListenSource"'::regtype
    ) THEN
        ALTER TYPE "ListenSource" ADD VALUE 'YOUTUBE_MUSIC';
    END IF;
END $$;

-- Allow remote-only plays and add remote track references.
ALTER TABLE "Play"
    ALTER COLUMN "trackId" DROP NOT NULL;

ALTER TABLE "Play"
    ADD COLUMN IF NOT EXISTS "trackTidalId" TEXT,
    ADD COLUMN IF NOT EXISTS "trackYtMusicId" TEXT;

CREATE INDEX IF NOT EXISTS "Play_trackTidalId_idx"
    ON "Play" ("trackTidalId");

CREATE INDEX IF NOT EXISTS "Play_trackYtMusicId_idx"
    ON "Play" ("trackYtMusicId");

ALTER TABLE "Play"
    ADD CONSTRAINT "Play_trackTidalId_fkey"
    FOREIGN KEY ("trackTidalId") REFERENCES "TrackTidal"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Play"
    ADD CONSTRAINT "Play_trackYtMusicId_fkey"
    FOREIGN KEY ("trackYtMusicId") REFERENCES "TrackYtMusic"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Play"
    DROP CONSTRAINT IF EXISTS "Play_trackId_fkey";

ALTER TABLE "Play"
    ADD CONSTRAINT "Play_trackId_fkey"
    FOREIGN KEY ("trackId") REFERENCES "Track"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
