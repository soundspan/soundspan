-- Space-scoped vector queries must never enter a global approximate index:
-- pgvector applies filters after an IVFFlat scan, which can discard neighbors
-- from the requested space. Runtime lifecycle management owns one partial ANN
-- index per sufficiently populated space.
--
-- DROP INDEX CONCURRENTLY cannot run inside a transaction block. This
-- migration therefore intentionally has no explicit BEGIN/COMMIT statements,
-- matching the repository's concurrent-index migration pattern.
DROP INDEX CONCURRENTLY IF EXISTS "track_embeddings_embedding_idx";
