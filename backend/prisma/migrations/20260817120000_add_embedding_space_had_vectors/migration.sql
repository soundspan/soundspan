BEGIN;

-- Persist whether a space has ever served stored vectors. Existing populated
-- spaces are marked during rollout so later vector loss cannot be mistaken
-- for a fresh-install active space.
ALTER TABLE "embedding_spaces"
    ADD COLUMN "had_vectors" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "embedding_spaces" AS space
SET "had_vectors" = TRUE
WHERE EXISTS (
    SELECT 1
    FROM "track_embeddings" AS embedding
    WHERE embedding."space_id" = space."id"
);

COMMIT;
