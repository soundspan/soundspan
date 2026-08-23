-- CreateTable
CREATE TABLE "MusicRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'album',
    "artistName" TEXT NOT NULL,
    "albumTitle" TEXT NOT NULL,
    "artistMbid" TEXT,
    "rgMbid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "deniedReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "downloadJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MusicRequest_downloadJobId_idx" ON "MusicRequest"("downloadJobId");
CREATE INDEX "MusicRequest_status_createdAt_idx" ON "MusicRequest"("status", "createdAt");
CREATE INDEX "MusicRequest_userId_createdAt_idx" ON "MusicRequest"("userId", "createdAt");
CREATE INDEX "MusicRequest_rgMbid_idx" ON "MusicRequest"("rgMbid");

-- One open request per user and album. Fulfilled, denied, and cancelled rows
-- remain historical records and do not block a later request.
CREATE UNIQUE INDEX IF NOT EXISTS "MusicRequest_userId_rgMbid_open_unique"
ON "MusicRequest" ("userId", "rgMbid")
WHERE status IN ('pending', 'approved');

COMMENT ON INDEX "MusicRequest_userId_rgMbid_open_unique" IS
    'Allows one pending or approved request per user and album; denied, failed, fulfilled, and cancelled rows do not block re-requests.';

-- AddForeignKey
ALTER TABLE "MusicRequest" ADD CONSTRAINT "MusicRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
