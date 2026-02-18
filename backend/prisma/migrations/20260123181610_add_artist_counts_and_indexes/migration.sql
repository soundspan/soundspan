-- AlterTable
ALTER TABLE "Artist" ADD COLUMN     "countsLastUpdated" TIMESTAMP(3),
ADD COLUMN     "discoveryAlbumCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "libraryAlbumCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalTrackCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Album_artistId_location_idx" ON "Album"("artistId", "location");

-- CreateIndex
CREATE INDEX "Artist_libraryAlbumCount_idx" ON "Artist"("libraryAlbumCount");

-- CreateIndex
CREATE INDEX "Artist_discoveryAlbumCount_idx" ON "Artist"("discoveryAlbumCount");

-- CreateIndex
CREATE INDEX "Artist_totalTrackCount_idx" ON "Artist"("totalTrackCount");
