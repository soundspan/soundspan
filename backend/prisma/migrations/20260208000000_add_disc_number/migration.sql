-- Add disc number column to Track table for multi-disc album support
ALTER TABLE "Track" ADD COLUMN "discNo" INTEGER NOT NULL DEFAULT 1;

-- Create index for efficient disc+track ordering
CREATE INDEX "Track_albumId_discNo_trackNo_idx" ON "Track" ("albumId", "discNo", "trackNo");

-- Add backfill flag to SystemSettings so the scanner does a one-time disc-number backfill
ALTER TABLE "SystemSettings" ADD COLUMN "discNoBackfillDone" BOOLEAN NOT NULL DEFAULT false;
