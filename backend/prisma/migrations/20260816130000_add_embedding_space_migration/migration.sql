BEGIN;

-- Keep retirement time as an explicit UTC grace-period anchor. A null value
-- on a retired row means its vectors and partial ANN index were cleaned.
ALTER TABLE "embedding_spaces"
    ADD COLUMN "retired_at" TIMESTAMPTZ;

-- Permit blue/green vector coexistence without rewriting or deleting the
-- existing active-space rows.
ALTER TABLE "track_embeddings"
    DROP CONSTRAINT "track_embeddings_pkey";
ALTER TABLE "track_embeddings"
    ADD CONSTRAINT "track_embeddings_pkey"
    PRIMARY KEY ("track_id", "space_id");

COMMIT;
