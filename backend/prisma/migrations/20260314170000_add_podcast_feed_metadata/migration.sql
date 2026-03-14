-- Persist podcast feed cache validators for conditional refreshes.
ALTER TABLE "Podcast"
    ADD COLUMN "feedEtag" TEXT,
    ADD COLUMN "feedLastModified" TEXT;
