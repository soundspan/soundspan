BEGIN;

ALTER TABLE "DiscoveryAlbum" ADD COLUMN "catalogAlbumId" TEXT;

UPDATE "DiscoveryAlbum" AS discovery
SET "catalogAlbumId" = album."id"
FROM "Album" AS album
WHERE album."rgMbid" = discovery."rgMbid";

CREATE INDEX "DiscoveryAlbum_catalogAlbumId_idx"
ON "DiscoveryAlbum"("catalogAlbumId");

ALTER TABLE "DiscoveryAlbum"
ADD CONSTRAINT "DiscoveryAlbum_catalogAlbumId_fkey"
FOREIGN KEY ("catalogAlbumId") REFERENCES "Album"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
