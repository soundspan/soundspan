-- Expand-only local-wins marker for consumer-side federation deduplication.
ALTER TABLE "Track"
ADD COLUMN "dedupOfTrackId" TEXT;

ALTER TABLE "Track"
ADD CONSTRAINT "Track_dedupOfTrackId_fkey"
FOREIGN KEY ("dedupOfTrackId") REFERENCES "Track"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX CONCURRENTLY "Track_dedupOfTrackId_idx"
ON "Track"("dedupOfTrackId");
