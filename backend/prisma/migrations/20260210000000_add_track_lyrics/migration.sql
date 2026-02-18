-- CreateTable
CREATE TABLE "TrackLyrics" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "syncedLyrics" TEXT,
    "plainLyrics" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackLyrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackLyrics_trackId_key" ON "TrackLyrics"("trackId");

-- CreateIndex
CREATE INDEX "TrackLyrics_trackId_idx" ON "TrackLyrics"("trackId");

-- AddForeignKey
ALTER TABLE "TrackLyrics" ADD CONSTRAINT "TrackLyrics_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
