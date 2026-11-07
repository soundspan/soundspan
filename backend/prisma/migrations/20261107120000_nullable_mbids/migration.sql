-- Artists and albums keep their own cuid primary key as identity. A missing
-- MusicBrainz id is stored as NULL instead of a synthetic temp- placeholder.
BEGIN;

LOCK TABLE "Artist", "Album", "OwnedAlbum" IN SHARE ROW EXCLUSIVE MODE;

-- OwnedAlbum references the album by its primary key instead of rgMbid.
ALTER TABLE "OwnedAlbum" DROP CONSTRAINT "OwnedAlbum_rgMbid_fkey";
ALTER TABLE "OwnedAlbum" ADD COLUMN "albumId" TEXT;

UPDATE "OwnedAlbum" AS owned
SET "albumId" = album.id
FROM "Album" AS album
WHERE album."rgMbid" = owned."rgMbid";

DELETE FROM "OwnedAlbum" WHERE "albumId" IS NULL;

ALTER TABLE "OwnedAlbum" DROP CONSTRAINT "OwnedAlbum_pkey";
DROP INDEX "OwnedAlbum_rgMbid_idx";
ALTER TABLE "OwnedAlbum" DROP COLUMN "rgMbid";
ALTER TABLE "OwnedAlbum" ALTER COLUMN "albumId" SET NOT NULL;
ALTER TABLE "OwnedAlbum"
    ADD CONSTRAINT "OwnedAlbum_pkey" PRIMARY KEY ("artistId", "albumId");
CREATE INDEX "OwnedAlbum_albumId_idx" ON "OwnedAlbum"("albumId");
ALTER TABLE "OwnedAlbum"
    ADD CONSTRAINT "OwnedAlbum_albumId_fkey"
    FOREIGN KEY ("albumId") REFERENCES "Album"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- MusicBrainz ids become optional; synthetic temp- placeholders become NULL.
ALTER TABLE "Artist" ALTER COLUMN "mbid" DROP NOT NULL;
ALTER TABLE "Album" ALTER COLUMN "rgMbid" DROP NOT NULL;

UPDATE "Artist" SET "mbid" = NULL WHERE "mbid" LIKE 'temp-%';
UPDATE "Album" SET "rgMbid" = NULL WHERE "rgMbid" LIKE 'temp-%';

COMMIT;
