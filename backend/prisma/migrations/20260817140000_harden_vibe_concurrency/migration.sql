BEGIN;

-- A force rebuild increments this token. Worker finalization compares the
-- captured value so an older in-flight generation cannot settle newer work.
ALTER TABLE "Track"
    ADD COLUMN "vibeAnalysisGeneration" INTEGER NOT NULL DEFAULT 0;

-- Retirement cleanup claims a space before deleting vectors or dropping its
-- partial ANN index. Provider registration refreshes last_seen_at so lifecycle
-- selection follows the configured provider instead of creation order.
ALTER TABLE "embedding_spaces"
    ADD COLUMN "cleaning_at" TIMESTAMPTZ,
    ADD COLUMN "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

COMMIT;
