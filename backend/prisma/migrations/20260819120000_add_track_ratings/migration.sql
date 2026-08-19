CREATE TABLE "TrackRating" (
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,

    CONSTRAINT "TrackRating_pkey" PRIMARY KEY ("userId", "trackId"),
    CONSTRAINT "TrackRating_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE INDEX "TrackRating_trackId_idx" ON "TrackRating"("trackId");

ALTER TABLE "TrackRating"
ADD CONSTRAINT "TrackRating_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackRating"
ADD CONSTRAINT "TrackRating_trackId_fkey"
FOREIGN KEY ("trackId") REFERENCES "Track"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
