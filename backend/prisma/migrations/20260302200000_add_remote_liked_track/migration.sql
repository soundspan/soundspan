-- CreateTable
CREATE TABLE "RemoteLikedTrack" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "thumbnailUrl" TEXT,
    "duration" INTEGER,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteLikedTrack_pkey" PRIMARY KEY ("userId","provider","externalId")
);

-- CreateIndex
CREATE INDEX "RemoteLikedTrack_userId_idx" ON "RemoteLikedTrack"("userId");

-- CreateIndex
CREATE INDEX "RemoteLikedTrack_likedAt_idx" ON "RemoteLikedTrack"("likedAt");

-- AddForeignKey
ALTER TABLE "RemoteLikedTrack" ADD CONSTRAINT "RemoteLikedTrack_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
