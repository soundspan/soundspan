-- Persist current library health state for tracks instead of deleting context.
CREATE TYPE "LibraryHealthStatus" AS ENUM ('MISSING_FROM_DISK', 'UNREADABLE_METADATA');

CREATE TABLE "LibraryHealthRecord" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "status" "LibraryHealthStatus" NOT NULL,
    "filePath" TEXT NOT NULL,
    "detail" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryHealthRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LibraryHealthRecord_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LibraryHealthRecord_trackId_key"
    ON "LibraryHealthRecord" ("trackId");

CREATE INDEX "LibraryHealthRecord_status_updatedAt_idx"
    ON "LibraryHealthRecord" ("status", "updatedAt");
