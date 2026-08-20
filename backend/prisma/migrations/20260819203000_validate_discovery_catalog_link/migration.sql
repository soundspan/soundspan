-- Validation uses a weaker lock after the bounded backfill has completed.
ALTER TABLE "DiscoveryAlbum"
VALIDATE CONSTRAINT "DiscoveryAlbum_catalogAlbumId_fkey";
