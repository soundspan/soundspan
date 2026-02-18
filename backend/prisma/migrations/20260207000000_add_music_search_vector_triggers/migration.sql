-- Migration: Add search vector triggers for Artist, Album, Track
-- These tables have searchVector columns and GIN indexes already defined in the schema,
-- but no triggers to populate them (unlike Podcast/Episode/Audiobook).
-- This migration creates the trigger functions, triggers, and backfills existing rows.

-- ============================================================================
-- ARTIST SEARCH VECTOR FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION artist_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artist_search_vector_update ON "Artist";
CREATE TRIGGER artist_search_vector_update
  BEFORE INSERT OR UPDATE OF name
  ON "Artist"
  FOR EACH ROW
  EXECUTE FUNCTION artist_search_vector_trigger();

-- ============================================================================
-- ALBUM SEARCH VECTOR FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION album_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS album_search_vector_update ON "Album";
CREATE TRIGGER album_search_vector_update
  BEFORE INSERT OR UPDATE OF title
  ON "Album"
  FOR EACH ROW
  EXECUTE FUNCTION album_search_vector_trigger();

-- ============================================================================
-- TRACK SEARCH VECTOR FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION track_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS track_search_vector_update ON "Track";
CREATE TRIGGER track_search_vector_update
  BEFORE INSERT OR UPDATE OF title
  ON "Track"
  FOR EACH ROW
  EXECUTE FUNCTION track_search_vector_trigger();

-- ============================================================================
-- BACKFILL EXISTING ROWS
-- ============================================================================
UPDATE "Artist" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(name, '')), 'A');

UPDATE "Album" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A');

UPDATE "Track" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A');
