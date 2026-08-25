-- AlterEnum
ALTER TYPE "AlbumLocation" ADD VALUE 'CATALOG';

-- AlterTable
ALTER TABLE "Album" ADD COLUMN "catalogTouchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Artist" ADD COLUMN "catalogSyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Album_location_catalogTouchedAt_id_idx" ON "Album"("location", "catalogTouchedAt", "id");
