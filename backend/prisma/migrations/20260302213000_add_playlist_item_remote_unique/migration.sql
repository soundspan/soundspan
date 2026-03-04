-- Add unique constraints for remote playlist item references.
-- Postgres unique semantics for nullable columns allow multiple NULL rows,
-- so these only enforce uniqueness when the remote FK is present.
CREATE UNIQUE INDEX IF NOT EXISTS "PlaylistItem_playlistId_trackTidalId_key"
    ON "PlaylistItem" ("playlistId", "trackTidalId");

CREATE UNIQUE INDEX IF NOT EXISTS "PlaylistItem_playlistId_trackYtMusicId_key"
    ON "PlaylistItem" ("playlistId", "trackYtMusicId");
