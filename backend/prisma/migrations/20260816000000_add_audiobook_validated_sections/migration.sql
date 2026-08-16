-- Store validated audiobook navigation produced during Audiobookshelf sync.
-- numChapters remains for rollback compatibility but is superseded by sections
-- and is no longer refreshed by sync code.

ALTER TABLE "Audiobook" ADD COLUMN "sections" JSONB;
