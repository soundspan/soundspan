-- Backfill legacy links in bounded, retry-safe batches. Each UPDATE touches at
-- most 1,000 rows, and SKIP LOCKED avoids waiting on live discovery writes.
DO $$
DECLARE
    updated_rows INTEGER;
BEGIN
    LOOP
        WITH batch AS (
            SELECT discovery."id", album."id" AS "catalogAlbumId"
            FROM "DiscoveryAlbum" AS discovery
            JOIN "Album" AS album
              ON album."rgMbid" = discovery."rgMbid"
            WHERE discovery."catalogAlbumId" IS NULL
            ORDER BY discovery."id"
            LIMIT 1000
            FOR UPDATE OF discovery SKIP LOCKED
        )
        UPDATE "DiscoveryAlbum" AS discovery
        SET "catalogAlbumId" = batch."catalogAlbumId"
        FROM batch
        WHERE discovery."id" = batch."id";

        GET DIAGNOSTICS updated_rows = ROW_COUNT;
        EXIT WHEN updated_rows = 0;
    END LOOP;
END $$;
