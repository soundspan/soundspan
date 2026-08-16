import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { parseEmbedding } from "../utils/embedding";
import { runAnnQuery } from "../utils/annQuery";
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

/** Track row returned by nearest-neighbor embedding queries. */
export interface NearestTrackRow {
    id: string;
    title: string;
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    arousal: number | null;
}

/** Track row returned by text-embedding search queries. */
export interface TextSearchResult {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    // Audio features for re-ranking
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    arousal: number | null;
    speechiness: number | null;
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

/**
 * Fetch a single track's CLAP embedding from pgvector.
 */
export async function fetchTrackEmbedding(
    trackId: string,
): Promise<number[] | null> {
    const rows = await prisma.$queryRaw<{ embedding: string }[]>`
        SELECT te.embedding::text
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL} AND te.track_id = ${trackId}
        LIMIT 1
    `;
    if (!rows.length) return null;
    return parseEmbedding(rows[0].embedding);
}

/** Finds the closest browsable tracks to an embedding. */
export async function findNearestToEmbedding(
    embedding: number[],
    limit: number,
    excludeIds: string[] = [],
): Promise<NearestTrackRow[]> {
    if (excludeIds.length > 0) {
        return runAnnQuery<NearestTrackRow[]>(Prisma.sql`
            SELECT
                t.id, t.title,
                te.embedding <=> ${embedding}::vector AS distance,
                a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId", ar.name AS "artistName",
                t.energy, t.valence, t.danceability, t.arousal
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE t."removedAt" IS NULL
              AND ${TRACK_BROWSE_SQL}
              AND te.track_id != ALL(${excludeIds}::text[])
            ORDER BY te.embedding <=> ${embedding}::vector
            LIMIT ${limit}
        `);
    }
    return runAnnQuery<NearestTrackRow[]>(Prisma.sql`
        SELECT
            t.id, t.title,
            te.embedding <=> ${embedding}::vector AS distance,
            a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
            ar.id AS "artistId", ar.name AS "artistName",
            t.energy, t.valence, t.danceability, t.arousal
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
        ORDER BY te.embedding <=> ${embedding}::vector
        LIMIT ${limit}
    `);
}

/** Finds browsable tracks nearest to a text-search embedding. */
export async function findTracksByTextEmbedding(
    searchEmbedding: number[],
    maxDistance: number,
    candidateLimit: number,
): Promise<TextSearchResult[]> {
    return runAnnQuery<TextSearchResult[]>(Prisma.sql`
        SELECT
            t.id,
            t.title,
            t.duration,
            t."trackNo",
            te.embedding <=> ${searchEmbedding}::vector AS distance,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName",
            t.energy,
            t.valence,
            t.danceability,
            t.acousticness,
            t.instrumentalness,
            t.arousal,
            t.speechiness
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.embedding <=> ${searchEmbedding}::vector <= ${maxDistance}
        ORDER BY te.embedding <=> ${searchEmbedding}::vector
        LIMIT ${candidateLimit}
    `);
}

/** Counts embeddings for tracks visible on browsable library surfaces. */
export async function countEmbeddedBrowsableTracks(): Promise<number> {
    const embeddedTracks = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
    `;

    return Number(embeddedTracks[0]?.count || 0);
}

/** Counts embeddings for local tracks included in analysis status. */
export async function countEmbeddedLocalTracks(): Promise<number> {
    const embeddingCount = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count
        FROM track_embeddings te
        INNER JOIN "Track" t ON t.id = te.track_id
        WHERE t."removedAt" IS NULL
          AND t.origin = ${"LOCAL"}::"TrackOrigin"
    `;
    return Number(embeddingCount[0]?.count || 0);
}
