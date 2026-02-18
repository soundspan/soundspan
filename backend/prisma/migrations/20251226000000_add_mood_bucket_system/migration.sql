-- Add MoodBucket table for pre-computed mood assignments
CREATE TABLE "MoodBucket" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoodBucket_pkey" PRIMARY KEY ("id")
);

-- Add UserMoodMix table for storing user's active mood mix
CREATE TABLE "UserMoodMix" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mood" TEXT NOT NULL,
    "trackIds" TEXT[],
    "coverUrls" TEXT[],
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMoodMix_pkey" PRIMARY KEY ("id")
);

-- Unique constraint: one entry per track+mood combination
CREATE UNIQUE INDEX "MoodBucket_trackId_mood_key" ON "MoodBucket"("trackId", "mood");

-- Index for fast mood lookups sorted by score
CREATE INDEX "MoodBucket_mood_score_idx" ON "MoodBucket"("mood", "score" DESC);

-- Index for track lookups
CREATE INDEX "MoodBucket_trackId_idx" ON "MoodBucket"("trackId");

-- Unique constraint: one mood mix per user
CREATE UNIQUE INDEX "UserMoodMix_userId_key" ON "UserMoodMix"("userId");

-- Index for user lookups
CREATE INDEX "UserMoodMix_userId_idx" ON "UserMoodMix"("userId");

-- Foreign key constraints
ALTER TABLE "MoodBucket" ADD CONSTRAINT "MoodBucket_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserMoodMix" ADD CONSTRAINT "UserMoodMix_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add indexes to Track table for mood-related columns (for query optimization)
CREATE INDEX IF NOT EXISTS "Track_analysisMode_idx" ON "Track"("analysisMode");
CREATE INDEX IF NOT EXISTS "Track_moodHappy_idx" ON "Track"("moodHappy");
CREATE INDEX IF NOT EXISTS "Track_moodSad_idx" ON "Track"("moodSad");
CREATE INDEX IF NOT EXISTS "Track_moodRelaxed_idx" ON "Track"("moodRelaxed");
CREATE INDEX IF NOT EXISTS "Track_moodAggressive_idx" ON "Track"("moodAggressive");
CREATE INDEX IF NOT EXISTS "Track_moodParty_idx" ON "Track"("moodParty");
CREATE INDEX IF NOT EXISTS "Track_moodAcoustic_idx" ON "Track"("moodAcoustic");
CREATE INDEX IF NOT EXISTS "Track_moodElectronic_idx" ON "Track"("moodElectronic");
CREATE INDEX IF NOT EXISTS "Track_arousal_idx" ON "Track"("arousal");
CREATE INDEX IF NOT EXISTS "Track_acousticness_idx" ON "Track"("acousticness");
CREATE INDEX IF NOT EXISTS "Track_instrumentalness_idx" ON "Track"("instrumentalness");
