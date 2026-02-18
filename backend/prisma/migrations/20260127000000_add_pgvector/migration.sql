-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Create track_embeddings table for storing CLAP embeddings
CREATE TABLE "track_embeddings" (
    "track_id" TEXT NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "model_version" VARCHAR(50) NOT NULL DEFAULT 'laion-clap-music',
    "analyzed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_embeddings_pkey" PRIMARY KEY ("track_id")
);

-- Foreign key constraint with CASCADE delete
ALTER TABLE "track_embeddings" ADD CONSTRAINT "track_embeddings_track_id_fkey"
    FOREIGN KEY ("track_id") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- IVFFlat index for approximate nearest neighbor search
-- lists = 224 (sqrt of 50k target tracks)
CREATE INDEX "track_embeddings_embedding_idx" ON "track_embeddings"
    USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 224);

-- Index on model_version for filtering by embedding version
CREATE INDEX "track_embeddings_model_version_idx" ON "track_embeddings"("model_version");
