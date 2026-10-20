-- CreateTable
CREATE TABLE "ArtistCatalogReleaseGroup" (
    "artistId" TEXT NOT NULL,
    "rgMbid" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "firstReleaseDate" TEXT,
    "primaryType" TEXT NOT NULL,
    "secondaryTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ArtistCatalogReleaseGroup_pkey" PRIMARY KEY ("artistId","rgMbid")
);

-- AddForeignKey
ALTER TABLE "ArtistCatalogReleaseGroup" ADD CONSTRAINT "ArtistCatalogReleaseGroup_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Catalogs synced before this table existed have no release-group rows.
-- Clearing the sync time makes the next artist view re-sync from MusicBrainz.
UPDATE "Artist" SET "catalogSyncedAt" = NULL WHERE "catalogSyncedAt" IS NOT NULL;
