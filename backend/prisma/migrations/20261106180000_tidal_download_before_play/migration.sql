-- Admin toggle: download TIDAL songs to the library before playing them.
ALTER TABLE "SystemSettings" ADD COLUMN "tidalDownloadBeforePlay" BOOLEAN NOT NULL DEFAULT false;

-- Songs downloaded because they were played, with their last play for cleanup.
CREATE TABLE "TidalPlayDownload" (
    "tidalId" INTEGER NOT NULL,
    "relativePath" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "codec" TEXT,
    "bitDepth" INTEGER,
    "sampleRate" INTEGER,
    "downloadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPlayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TidalPlayDownload_pkey" PRIMARY KEY ("tidalId")
);

CREATE INDEX "TidalPlayDownload_lastPlayedAt_idx" ON "TidalPlayDownload"("lastPlayedAt");
