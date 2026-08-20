-- Prisma runs migrations inside a transaction, so CONCURRENTLY is not
-- available here. DiscoveryAlbum stays small (bounded weekly batches), so a
-- plain index build holds its lock only briefly.
CREATE INDEX "DiscoveryAlbum_catalogAlbumId_idx"
ON "DiscoveryAlbum"("catalogAlbumId");
