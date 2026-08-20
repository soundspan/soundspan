-- Remove legacy-spelling duplicates before canonicalizing the retained source.
DELETE FROM "OwnedAlbum" AS legacy
USING "OwnedAlbum" AS canonical
WHERE legacy."source" = 'discover_liked'
  AND canonical."source" = 'discovery_liked'
  AND canonical."artistId" = legacy."artistId"
  AND canonical."rgMbid" = legacy."rgMbid";

UPDATE "OwnedAlbum"
SET "source" = 'discovery_liked'
WHERE "source" = 'discover_liked';

-- Previous releases created source='enrichment' as automated metadata noise.
-- Keep only rows backed by user intent: a LIKED discovery row linked to the
-- same catalog album, or an unlinked rolling-deploy row with the same rgMbid.
DELETE FROM "OwnedAlbum" AS enrichment
USING "OwnedAlbum" AS canonical
WHERE enrichment."source" = 'enrichment'
  AND canonical."source" = 'discovery_liked'
  AND canonical."artistId" = enrichment."artistId"
  AND canonical."rgMbid" = enrichment."rgMbid";

UPDATE "OwnedAlbum" AS owned
SET "source" = 'discovery_liked'
WHERE owned."source" = 'enrichment'
  AND EXISTS (
      SELECT 1
      FROM "DiscoveryAlbum" AS discovery
      LEFT JOIN "Album" AS linked
        ON linked."id" = discovery."catalogAlbumId"
      WHERE discovery."status" = 'LIKED'
        AND (
            (
                discovery."catalogAlbumId" IS NOT NULL
                AND linked."artistId" = owned."artistId"
                AND linked."rgMbid" = owned."rgMbid"
            )
            OR (
                discovery."catalogAlbumId" IS NULL
                AND discovery."rgMbid" = owned."rgMbid"
            )
        )
  );

DELETE FROM "OwnedAlbum"
WHERE "source" = 'enrichment';
