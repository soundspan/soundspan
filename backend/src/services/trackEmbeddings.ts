import { prisma } from "../utils/db";
import { parseEmbedding } from "../utils/embedding";

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

/**
 * Fetch the CLAP embeddings for `trackIds` (parsed to number arrays), in no
 * guaranteed order. Ids without an embedding row are simply absent from the
 * result — callers decide whether a partial result is acceptable. An empty
 * input resolves to `[]` without touching the database.
 */
export async function fetchEmbeddingsByTrackIds(
    trackIds: readonly string[]
): Promise<TrackEmbeddingRow[]> {
    if (trackIds.length === 0) return [];
    const rows = await prisma.$queryRaw<
        { trackId: string; embedding: string }[]
    >`
        SELECT track_id AS "trackId", embedding::text AS embedding
        FROM track_embeddings
        WHERE track_id = ANY(${trackIds as string[]})
    `;
    return rows.map((row) => ({
        trackId: row.trackId,
        embedding: parseEmbedding(row.embedding),
    }));
}
