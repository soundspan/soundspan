BEGIN;

LOCK TABLE "Audiobook", "AudiobookProgress", "PlaybackState" IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX "AudiobookProgress_audiobookshelfId_idx" ON "AudiobookProgress"("audiobookshelfId");

CREATE INDEX "PlaybackState_audiobookId_idx" ON "PlaybackState"("audiobookId");

DELETE FROM "AudiobookProgress" AS p
WHERE NOT EXISTS (
    SELECT 1
    FROM "Audiobook" AS a
    WHERE a.id = p."audiobookshelfId"
);

UPDATE "PlaybackState"
SET "audiobookId" = NULL
WHERE "audiobookId" IS NOT NULL
AND NOT EXISTS (
    SELECT 1
    FROM "Audiobook" AS a
    WHERE a.id = "PlaybackState"."audiobookId"
);

ALTER TABLE "AudiobookProgress"
ADD CONSTRAINT "AudiobookProgress_audiobookshelfId_fkey"
FOREIGN KEY ("audiobookshelfId") REFERENCES "Audiobook"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlaybackState"
ADD CONSTRAINT "PlaybackState_audiobookId_fkey"
FOREIGN KEY ("audiobookId") REFERENCES "Audiobook"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
