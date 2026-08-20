-- Expand only: keep the ACCESS EXCLUSIVE lock short for rolling deploys.
ALTER TABLE "DiscoveryAlbum" ADD COLUMN "catalogAlbumId" TEXT;

ALTER TABLE "DiscoveryAlbum"
ADD CONSTRAINT "DiscoveryAlbum_catalogAlbumId_fkey"
FOREIGN KEY ("catalogAlbumId") REFERENCES "Album"("id")
ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
