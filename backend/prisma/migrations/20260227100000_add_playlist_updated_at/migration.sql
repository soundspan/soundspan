-- AlterTable
ALTER TABLE "Playlist" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: set updatedAt to createdAt for existing playlists
UPDATE "Playlist" SET "updatedAt" = "createdAt";
