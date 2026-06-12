-- Add persistent per-user bookmarks for OpenSubsonic compatibility.
CREATE TABLE "Bookmark" (
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "positionSeconds" DOUBLE PRECISION NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("userId", "trackId"),
    CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Bookmark_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Bookmark_userId_updatedAt_idx"
    ON "Bookmark" ("userId", "updatedAt");

CREATE INDEX "Bookmark_trackId_idx"
    ON "Bookmark" ("trackId");
