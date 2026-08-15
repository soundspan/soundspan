-- Add Prisma-maintained change timestamps without rewriting existing tables.
-- PostgreSQL installs stable statement-time defaults as metadata, matching the
-- existing Track.updatedAt rollout while backfilling current rows.

-- AlterTable
ALTER TABLE "Artist"
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Album"
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex (CONCURRENTLY cannot run inside a transaction block, so this
-- migration must remain free of explicit BEGIN/COMMIT statements.)
CREATE INDEX CONCURRENTLY "Artist_updatedAt_id_idx"
    ON "Artist"("updatedAt", "id");
CREATE INDEX CONCURRENTLY "Album_updatedAt_id_idx"
    ON "Album"("updatedAt", "id");
