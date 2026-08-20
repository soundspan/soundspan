BEGIN;

LOCK TABLE "Album", "OwnedAlbum" IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX "OwnedAlbum_rgMbid_idx" ON "OwnedAlbum"("rgMbid");

DELETE FROM "OwnedAlbum" AS owned
WHERE NOT EXISTS (
    SELECT 1
    FROM "Album" AS album
    WHERE album."rgMbid" = owned."rgMbid"
);

ALTER TABLE "OwnedAlbum"
ADD CONSTRAINT "OwnedAlbum_rgMbid_fkey"
FOREIGN KEY ("rgMbid") REFERENCES "Album"("rgMbid")
ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT;
