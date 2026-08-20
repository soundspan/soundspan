-- DiscoveryAlbum is inherently small because it contains bounded weekly
-- discovery batches, so one statement holds row locks briefly and misses no
-- rows that would otherwise be skipped by a transaction-local batching loop.
UPDATE "DiscoveryAlbum" AS discovery
SET "catalogAlbumId" = album."id"
FROM "Album" AS album
WHERE discovery."catalogAlbumId" IS NULL
  AND album."rgMbid" = discovery."rgMbid";
