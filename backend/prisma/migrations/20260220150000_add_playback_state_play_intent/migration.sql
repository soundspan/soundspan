-- Persist explicit play/pause intent per playback state row
ALTER TABLE "PlaybackState"
    ADD COLUMN IF NOT EXISTS "isPlaying" BOOLEAN NOT NULL DEFAULT false;
