-- Prisma migrate deploy does not wrap this migration in a transaction, so the
-- index can be built without blocking discovery writes.
CREATE INDEX CONCURRENTLY "DiscoveryAlbum_catalogAlbumId_idx"
ON "DiscoveryAlbum"("catalogAlbumId");
