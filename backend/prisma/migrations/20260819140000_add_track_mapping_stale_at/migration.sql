ALTER TABLE "TrackMapping"
ADD COLUMN "staleAt" TIMESTAMP(3);

-- Existing stale mappings start their retention clock at deployment. This
-- prevents a migration from making historical rows immediately collectable.
UPDATE "TrackMapping"
SET "staleAt" = CURRENT_TIMESTAMP
WHERE "stale" = true;

CREATE INDEX "TrackMapping_stale_staleAt_idx"
ON "TrackMapping"("stale", "staleAt");

-- Maintain the timestamp for every writer, including an older application
-- replica during a rolling deployment.
CREATE OR REPLACE FUNCTION track_mapping_set_stale_at()
RETURNS trigger AS $$
BEGIN
    IF NEW."stale" = false THEN
        NEW."staleAt" := NULL;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        NEW."staleAt" := COALESCE(
            NEW."staleAt",
            OLD."staleAt",
            CURRENT_TIMESTAMP
        );
        RETURN NEW;
    END IF;

    NEW."staleAt" := COALESCE(NEW."staleAt", CURRENT_TIMESTAMP);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER track_mapping_set_stale_at_trigger
BEFORE INSERT OR UPDATE OF "stale", "staleAt" ON "TrackMapping"
FOR EACH ROW
EXECUTE FUNCTION track_mapping_set_stale_at();
