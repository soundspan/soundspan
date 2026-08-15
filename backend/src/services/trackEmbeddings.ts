import { prisma } from "../utils/db";
import { parseEmbedding } from "../utils/embedding";
import { TRACK_BROWSE_SQL } from "../utils/libraryRadioPredicates";

/**
 * trackEmbeddings — service-layer reads of the pgvector `track_embeddings`
 * column.
 *
 * The `embedding` column is `Unsupported("vector(512)")`, so the Prisma
 * client cannot select it; reading it requires a raw query. This module is
 * the service-layer home for those reads (beside the other blessed pgvector
 * sites in `services/hybridSimilarity` and `utils/annQuery`), so route files
 * never grow new raw SQL of their own — routes call this instead.
 */

export interface TrackEmbeddingRow {
    trackId: string;
    embedding: number[];
}

const EMBEDDING_DIMENSIONS = 512;

/** Upserts one validated CLAP vector received from a trusted service boundary. */
export async function upsertTrackEmbedding(
    trackId: string,
    embedding: readonly number[],
): Promise<void> {
    if (
        embedding.length !== EMBEDDING_DIMENSIONS ||
        embedding.some((value) => !Number.isFinite(value))
    ) {
        throw new Error("Track embedding must contain 512 finite values");
    }
    const vector = `[${embedding.join(",")}]`;
    await prisma.$executeRaw`
        INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
        VALUES (${trackId}, ${vector}::vector, 'laion-clap-music', NOW())
        ON CONFLICT (track_id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            model_version = EXCLUDED.model_version,
            analyzed_at = EXCLUDED.analyzed_at
    `;
}

/**
 * Fetch the CLAP embeddings for `trackIds` (parsed to number arrays), in no
 * guaranteed order. Ids without an embedding row are simply absent from the
 * result — callers decide whether a partial result is acceptable. An empty
 * input resolves to `[]` without touching the database.
 */
export async function fetchEmbeddingsByTrackIds(
    trackIds: readonly string[],
): Promise<TrackEmbeddingRow[]> {
    if (trackIds.length === 0) return [];
    const rows = await prisma.$queryRaw<
        { trackId: string; embedding: string }[]
    >`
        SELECT te.track_id AS "trackId", te.embedding::text AS embedding
        FROM track_embeddings te
        JOIN "Track" t ON t.id = te.track_id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.track_id = ANY(${trackIds as string[]})
    `;
    return rows.map((row) => ({
        trackId: row.trackId,
        embedding: parseEmbedding(row.embedding),
    }));
}
