-- Durable track identity (#457), phase 1: content/tag match keys used to
-- preserve Track.id across file moves, renames, retags, and in-place quality
-- upgrades (see docs/designs/durable-track-identity.md).
--
-- All four columns are nullable with no default, so ADD COLUMN is a pure
-- catalog change — no table rewrite, no backfill here. audioHash is
-- populated by the scanner (new/changed files) and a background backfill
-- worker; recordingMbid/isrc populate from tags on the next regular scan.
--
-- Columns are deliberately NOT unique: the same audio can legitimately exist
-- at two paths, and the same recording appears on album + compilation. They
-- are match keys, not identity keys.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN "audioHash" TEXT;
ALTER TABLE "Track" ADD COLUMN "audioHashedAt" TIMESTAMP(3);
ALTER TABLE "Track" ADD COLUMN "recordingMbid" TEXT;
ALTER TABLE "Track" ADD COLUMN "isrc" TEXT;

-- CreateIndex (CONCURRENTLY cannot run inside a transaction block, so this
-- migration must remain free of explicit BEGIN/COMMIT statements.)
CREATE INDEX CONCURRENTLY "Track_audioHash_idx" ON "Track"("audioHash");
CREATE INDEX CONCURRENTLY "Track_recordingMbid_idx" ON "Track"("recordingMbid");
CREATE INDEX CONCURRENTLY "Track_isrc_idx" ON "Track"("isrc");
