-- Durable track identity (#457), phase 2a: retain missing tracks so a later
-- scan can revive the same Track.id and preserve all related library data.
--
-- The column is nullable with no default, so ADD COLUMN is a pure catalog
-- change with no table rewrite or backfill. Existing rows remain active.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN "removedAt" TIMESTAMP(3);

-- CreateIndex (CONCURRENTLY cannot run inside a transaction block, so this
-- migration must remain free of explicit BEGIN/COMMIT statements.)
CREATE INDEX CONCURRENTLY "Track_removedAt_idx" ON "Track"("removedAt");
