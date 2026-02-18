-- AddColumn: Artist.similarArtistsJson
-- Stores full Last.fm similar artists data as JSON instead of FK-based SimilarArtist table
ALTER TABLE "Artist" ADD COLUMN "similarArtistsJson" JSONB;
