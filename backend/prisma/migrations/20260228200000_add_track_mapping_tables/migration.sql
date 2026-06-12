-- CreateTable
CREATE TABLE "TrackTidal" (
    "id" TEXT NOT NULL,
    "tidalId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "isrc" TEXT,
    "quality" TEXT,
    "explicit" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackTidal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackYtMusic" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "thumbnailUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackYtMusic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackMapping" (
    "id" TEXT NOT NULL,
    "trackId" TEXT,
    "trackTidalId" TEXT,
    "trackYtMusicId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackMapping_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Make PlaylistItem.trackId nullable and add provider FKs
ALTER TABLE "PlaylistItem" ALTER COLUMN "trackId" DROP NOT NULL;
ALTER TABLE "PlaylistItem" ADD COLUMN "trackTidalId" TEXT;
ALTER TABLE "PlaylistItem" ADD COLUMN "trackYtMusicId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TrackTidal_tidalId_key" ON "TrackTidal"("tidalId");

-- CreateIndex
CREATE INDEX "TrackTidal_isrc_idx" ON "TrackTidal"("isrc");

-- CreateIndex
CREATE UNIQUE INDEX "TrackYtMusic_videoId_key" ON "TrackYtMusic"("videoId");

-- CreateIndex
CREATE INDEX "TrackMapping_trackId_idx" ON "TrackMapping"("trackId");

-- CreateIndex
CREATE INDEX "TrackMapping_trackTidalId_idx" ON "TrackMapping"("trackTidalId");

-- CreateIndex
CREATE INDEX "TrackMapping_trackYtMusicId_idx" ON "TrackMapping"("trackYtMusicId");

-- CreateIndex
CREATE INDEX "TrackMapping_stale_idx" ON "TrackMapping"("stale");

-- CreateIndex
CREATE INDEX "PlaylistItem_trackTidalId_idx" ON "PlaylistItem"("trackTidalId");

-- CreateIndex
CREATE INDEX "PlaylistItem_trackYtMusicId_idx" ON "PlaylistItem"("trackYtMusicId");

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_trackTidalId_fkey" FOREIGN KEY ("trackTidalId") REFERENCES "TrackTidal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_trackYtMusicId_fkey" FOREIGN KEY ("trackYtMusicId") REFERENCES "TrackYtMusic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackMapping" ADD CONSTRAINT "TrackMapping_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackMapping" ADD CONSTRAINT "TrackMapping_trackTidalId_fkey" FOREIGN KEY ("trackTidalId") REFERENCES "TrackTidal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackMapping" ADD CONSTRAINT "TrackMapping_trackYtMusicId_fkey" FOREIGN KEY ("trackYtMusicId") REFERENCES "TrackYtMusic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
