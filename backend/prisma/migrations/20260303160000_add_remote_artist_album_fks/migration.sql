-- AlterEnum: Add REMOTE to AlbumLocation
ALTER TYPE "AlbumLocation" ADD VALUE 'REMOTE';

-- AlterTable: Add remoteTrackCount to Artist
ALTER TABLE "Artist" ADD COLUMN "remoteTrackCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: Add artistId and albumId FKs to TrackTidal
ALTER TABLE "TrackTidal" ADD COLUMN "artistId" TEXT;
ALTER TABLE "TrackTidal" ADD COLUMN "albumId" TEXT;

-- AlterTable: Add artistId and albumId FKs to TrackYtMusic
ALTER TABLE "TrackYtMusic" ADD COLUMN "artistId" TEXT;
ALTER TABLE "TrackYtMusic" ADD COLUMN "albumId" TEXT;

-- AddForeignKey: TrackTidal -> Artist
ALTER TABLE "TrackTidal" ADD CONSTRAINT "TrackTidal_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: TrackTidal -> Album
ALTER TABLE "TrackTidal" ADD CONSTRAINT "TrackTidal_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: TrackYtMusic -> Artist
ALTER TABLE "TrackYtMusic" ADD CONSTRAINT "TrackYtMusic_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: TrackYtMusic -> Album
ALTER TABLE "TrackYtMusic" ADD CONSTRAINT "TrackYtMusic_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: TrackTidal FK indexes
CREATE INDEX "TrackTidal_artistId_idx" ON "TrackTidal"("artistId");
CREATE INDEX "TrackTidal_albumId_idx" ON "TrackTidal"("albumId");

-- CreateIndex: TrackYtMusic FK indexes
CREATE INDEX "TrackYtMusic_artistId_idx" ON "TrackYtMusic"("artistId");
CREATE INDEX "TrackYtMusic_albumId_idx" ON "TrackYtMusic"("albumId");

-- CreateIndex: Artist remoteTrackCount index
CREATE INDEX "Artist_remoteTrackCount_idx" ON "Artist"("remoteTrackCount");
