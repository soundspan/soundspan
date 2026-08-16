-- Register embedding spaces so stored vectors are never queried outside the
-- model and preprocessing identity that gives them meaning.

-- This repo's migrations apply statement-by-statement (autocommit), so wrap
-- the whole change in one transaction: a mid-file failure must leave no
-- partial DDL, and the ADD COLUMN lock must be held through SET NOT NULL so
-- a still-running old sidecar cannot slip a NULL space_id row in between.
-- (Safe here: no CONCURRENTLY and no ALTER TYPE ADD VALUE in this file.)
BEGIN;

-- CreateEnum
CREATE TYPE "EmbeddingSpaceStatus" AS ENUM ('active', 'migrating', 'retired');

-- CreateTable
CREATE TABLE "embedding_spaces" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "checkpoint_hash" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "preprocessing" JSONB NOT NULL,
    "status" "EmbeddingSpaceStatus" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_spaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embedding_spaces_family_checkpoint_hash_key"
    ON "embedding_spaces"("family", "checkpoint_hash");
CREATE INDEX "embedding_spaces_status_idx" ON "embedding_spaces"("status");

-- Prisma cannot model partial unique indexes. This raw index follows the
-- existing raw pgvector-index precedent and enforces one active space.
CREATE UNIQUE INDEX "embedding_spaces_one_active_idx"
    ON "embedding_spaces" ((1)) WHERE "status" = 'active';

-- Seed the canonical LAION-CLAP music_audioset embedding space.
INSERT INTO "embedding_spaces" (
    "id",
    "family",
    "checkpoint_hash",
    "dim",
    "preprocessing",
    "status"
) VALUES (
    'space_clap_music_audioset_v1',
    'clap-music-audioset',
    'fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd',
    512,
    '{"sampleRateHz": 48000, "mono": true, "maxDurationSeconds": 60, "window": "middle", "loader": "librosa"}'::jsonb,
    'active'
);

-- Add the nullable column first, then backfill every historical embedding.
-- Both former model_version values identify this same canonical space.
ALTER TABLE "track_embeddings" ADD COLUMN "space_id" TEXT;
UPDATE "track_embeddings" SET "space_id" = 'space_clap_music_audioset_v1';
ALTER TABLE "track_embeddings" ALTER COLUMN "space_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "track_embeddings"
    ADD CONSTRAINT "track_embeddings_space_id_fkey"
    FOREIGN KEY ("space_id") REFERENCES "embedding_spaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "track_embeddings_space_id_idx" ON "track_embeddings"("space_id");

-- Remove the ambiguous free-form model identity.
DROP INDEX "track_embeddings_model_version_idx";
ALTER TABLE "track_embeddings" DROP COLUMN "model_version";

COMMIT;
