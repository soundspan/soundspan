import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { parseEmbedding } from "../utils/embedding";
import { runAnnQuery } from "../utils/annQuery";
import { TRACK_BROWSE_SQL } from "../utils/libraryRadioPredicates";
import {
    getActiveSpace,
    getVibeEmbeddingTargetSpaceId,
} from "./embeddingSpaces";
import {
    vibeEmbeddingEligibleTrackWhere,
    vibeEmbeddingTargetGateWhere,
} from "./vibeEmbeddingEligibility";

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
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
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
    loudnessLufs?: number | null;
    truePeakDb?: number | null;
    albumLoudnessLufs?: number | null;
    albumTruePeakDb?: number | null;
    // Audio features for re-ranking
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    arousal: number | null;
    speechiness: number | null;
}

/** Claimed local vibe generation finalized with its vector write. */
export interface VibeEmbeddingWriteClaim {
    generation: number;
    completedAt: Date;
}

/** Raised when a cached worker target can no longer accept vectors. */
export class EmbeddingTargetInvalidatedError extends Error {
    readonly code = "EMBEDDING_TARGET_INVALIDATED";

    constructor(public readonly spaceId: string) {
        super(`Embedding space ${spaceId} no longer accepts vector writes`);
        this.name = "EmbeddingTargetInvalidatedError";
    }
}

/** Raised when an invalidated local job loses its generation fence. */
export class VibeEmbeddingGenerationMismatchError extends Error {
    readonly code = "VIBE_EMBEDDING_GENERATION_MISMATCH";

    constructor(
        public readonly trackId: string,
        public readonly generation: number,
    ) {
        super(`Track ${trackId} no longer owns vibe generation ${generation}`);
        this.name = "VibeEmbeddingGenerationMismatchError";
    }
}

function boundedTextSearchCandidateLimit(candidateLimit: number): number {
    if (!Number.isFinite(candidateLimit)) return 1;
    return Math.min(Math.max(1, Math.trunc(candidateLimit)), 300);
}

function validateEmbeddingValues(embedding: readonly number[]): void {
    if (
        embedding.length === 0 ||
        embedding.some((value) => !Number.isFinite(value))
    ) {
        throw new Error("Track embedding must contain only finite values");
    }
}

async function lockWritableEmbeddingSpace(
    transaction: Prisma.TransactionClient,
    spaceId: string,
): Promise<number> {
    const spaces = await transaction.$queryRaw<Array<{ dim: number }>>`
        SELECT dim
        FROM embedding_spaces
        WHERE id = ${spaceId}
          AND status IN ('active', 'migrating')
          AND cleaning_at IS NULL
        FOR SHARE
    `;
    const targetSpace = spaces[0];
    if (!targetSpace) throw new EmbeddingTargetInvalidatedError(spaceId);
    return targetSpace.dim;
}

async function finalizeVibeEmbeddingClaim(
    transaction: Prisma.TransactionClient,
    trackId: string,
    claim: VibeEmbeddingWriteClaim | undefined,
): Promise<void> {
    if (!claim) return;
    const completed = await transaction.track.updateMany({
        where: {
            id: trackId,
            origin: "LOCAL",
            removedAt: null,
            vibeAnalysisStatus: "processing",
            vibeAnalysisGeneration: claim.generation,
        },
        data: {
            vibeAnalysisStatus: "completed",
            vibeAnalysisError: null,
            vibeAnalysisStartedAt: null,
            vibeAnalysisStatusUpdatedAt: claim.completedAt,
        },
    });
    if (completed.count !== 1) {
        throw new VibeEmbeddingGenerationMismatchError(
            trackId,
            claim.generation,
        );
    }
}

async function writeEmbeddingVector(
    transaction: Prisma.TransactionClient,
    trackId: string,
    vector: string,
    spaceId: string,
): Promise<void> {
    const written = await transaction.$executeRaw`
        INSERT INTO track_embeddings (track_id, embedding, space_id, analyzed_at)
        VALUES (${trackId}, ${vector}::vector, ${spaceId}, NOW())
        ON CONFLICT (track_id, space_id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            analyzed_at = EXCLUDED.analyzed_at
    `;
    if (written !== 1) {
        throw new Error("Track embedding upsert did not affect one row");
    }
}

async function markEmbeddingSpacePopulated(
    transaction: Prisma.TransactionClient,
    spaceId: string,
): Promise<void> {
    const marked = await transaction.embeddingSpace.updateMany({
        where: {
            id: spaceId,
            status: { in: ["active", "migrating"] },
            cleaningAt: null,
            hadVectors: false,
        },
        data: { hadVectors: true },
    });
    if (marked.count < 0 || marked.count > 1) {
        throw new Error("Embedding-space marker update was inconsistent");
    }
}

/** Prisma relation filter for tracks without a vector in `targetSpaceId`. */
export function missingActiveEmbeddingWhere(
    targetSpaceId: string,
): Prisma.TrackWhereInput {
    return {
        embeddings: { none: { spaceId: targetSpaceId } },
    };
}

/** Select bounded local queue candidates missing a target-space vector. */
export async function findLocalTracksNeedingActiveEmbedding(
    limit: number,
    targetSpaceId?: string,
): Promise<Array<{ id: string; filePath: string | null }>> {
    const resolvedTargetSpaceId =
        targetSpaceId ?? (await getVibeEmbeddingTargetSpaceId());
    return prisma.track.findMany({
        where: {
            ...vibeEmbeddingEligibleTrackWhere(),
            ...vibeEmbeddingTargetGateWhere(resolvedTargetSpaceId),
        },
        select: { id: true, filePath: true },
        take: limit,
        orderBy: { fileModified: "desc" },
    });
}

/** Upserts one validated CLAP vector received from a trusted service boundary. */
export async function upsertTrackEmbedding(
    trackId: string,
    embedding: readonly number[],
    spaceId: string,
    claim?: VibeEmbeddingWriteClaim,
): Promise<void> {
    validateEmbeddingValues(embedding);
    const vector = `[${embedding.join(",")}]`;
    await prisma.$transaction(async (transaction) => {
        const expectedDim = await lockWritableEmbeddingSpace(
            transaction,
            spaceId,
        );
        if (embedding.length !== expectedDim) {
            throw new Error(
                `Track embedding must contain ${expectedDim} finite values`,
            );
        }
        await finalizeVibeEmbeddingClaim(transaction, trackId, claim);
        await writeEmbeddingVector(transaction, trackId, vector, spaceId);
        await markEmbeddingSpacePopulated(transaction, spaceId);
    });
}

/** Upserts a bounded page of validated peer vectors in one transaction. */
export async function upsertTrackEmbeddingPage(
    rows: readonly { trackId: string; embedding: readonly number[] }[],
    spaceId: string,
): Promise<void> {
    if (rows.length === 0) return;
    await prisma.$transaction((transaction) =>
        upsertTrackEmbeddingPageInTransaction(transaction, rows, spaceId),
    );
}

/** Writes a peer-vector page inside a caller-owned transaction. */
export async function upsertTrackEmbeddingPageInTransaction(
    transaction: Prisma.TransactionClient,
    rows: readonly { trackId: string; embedding: readonly number[] }[],
    spaceId: string,
): Promise<void> {
    if (rows.length === 0) return;
    const vectors = rows.map(({ embedding }) => {
        validateEmbeddingValues(embedding);
        return `[${embedding.join(",")}]`;
    });
    const expectedDim = await lockWritableEmbeddingSpace(transaction, spaceId);
    if (rows.some(({ embedding }) => embedding.length !== expectedDim)) {
        throw new Error(
            `Track embedding must contain ${expectedDim} finite values`,
        );
    }
    const written = await transaction.$executeRaw`
        INSERT INTO track_embeddings
            (track_id, embedding, space_id, analyzed_at)
        SELECT input.track_id, input.vector::vector, ${spaceId}, NOW()
        FROM unnest(
            ${rows.map(({ trackId }) => trackId)}::text[],
            ${vectors}::text[]
        ) AS input(track_id, vector)
        ON CONFLICT (track_id, space_id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            analyzed_at = EXCLUDED.analyzed_at
    `;
    if (written !== rows.length) {
        throw new Error("Track embedding page upsert was incomplete");
    }
    await markEmbeddingSpacePopulated(transaction, spaceId);
}

/**
 * Fetch the CLAP embeddings for `trackIds` (parsed to number arrays), in no
 * guaranteed order. Ids without an embedding row are simply absent from the
 * result — callers decide whether a partial result is acceptable. An empty
 * input resolves to `[]` without touching the database.
 */
export async function fetchEmbeddingsByTrackIds(
    trackIds: readonly string[],
    spaceId?: string,
): Promise<TrackEmbeddingRow[]> {
    if (trackIds.length === 0) return [];
    const resolvedSpaceId = spaceId ?? (await getActiveSpace()).id;
    const rows = await prisma.$queryRaw<
        { trackId: string; embedding: string }[]
    >`
        SELECT te.track_id AS "trackId", te.embedding::text AS embedding
        FROM track_embeddings te
        JOIN "Track" t ON t.id = te.track_id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.space_id = ${resolvedSpaceId}
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
    const activeSpace = await getActiveSpace();
    const rows = await prisma.$queryRaw<{ embedding: string }[]>`
        SELECT te.embedding::text
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.space_id = ${activeSpace.id}
          AND te.track_id = ${trackId}
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
    const activeSpace = await getActiveSpace();
    if (excludeIds.length > 0) {
        return runAnnQuery<NearestTrackRow[]>(Prisma.sql`
            SELECT
                t.id, t.title,
                te.embedding <=> ${embedding}::vector AS distance,
                a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId", ar.name AS "artistName",
                t."loudnessLufs", t."truePeakDb",
                a."albumLoudnessLufs", a."albumTruePeakDb",
                t.energy, t.valence, t.danceability, t.arousal
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE t."removedAt" IS NULL
              AND ${TRACK_BROWSE_SQL}
              AND te.space_id = ${activeSpace.id}
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
            t."loudnessLufs", t."truePeakDb",
            a."albumLoudnessLufs", a."albumTruePeakDb",
            t.energy, t.valence, t.danceability, t.arousal
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.space_id = ${activeSpace.id}
        ORDER BY te.embedding <=> ${embedding}::vector
        LIMIT ${limit}
    `);
}

/** Finds browsable tracks nearest to a text-search embedding. */
export async function findTracksByTextEmbedding(
    searchEmbedding: number[],
    maxDistance: number,
    candidateLimit: number,
    spaceId?: string,
): Promise<TextSearchResult[]> {
    const resolvedSpaceId = spaceId ?? (await getActiveSpace()).id;
    const boundedCandidateLimit =
        boundedTextSearchCandidateLimit(candidateLimit);
    // Migrating spaces have no ANN index before cutover, so pgvector uses an
    // exact scan during this bounded migration window.
    const query = Prisma.sql`
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
            t."loudnessLufs",
            t."truePeakDb",
            a."albumLoudnessLufs",
            a."albumTruePeakDb",
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
          AND te.space_id = ${resolvedSpaceId}
          AND te.embedding <=> ${searchEmbedding}::vector <= ${maxDistance}
        ORDER BY te.embedding <=> ${searchEmbedding}::vector
        LIMIT ${boundedCandidateLimit}
    `;
    return runAnnQuery<TextSearchResult[]>(query, undefined, {
        statementTimeoutMs: 5_000,
        timeoutMessage: "Vibe text search query timed out",
    });
}

/** Counts embeddings for tracks visible on browsable library surfaces. */
export async function countEmbeddedBrowsableTracks(): Promise<number> {
    const activeSpace = await getActiveSpace();
    const embeddedTracks = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.space_id = ${activeSpace.id}
    `;

    return Number(embeddedTracks[0]?.count || 0);
}

/** Counts embeddings for local tracks included in analysis status. */
export async function countEmbeddedLocalTracks(): Promise<number> {
    const activeSpace = await getActiveSpace();
    const embeddingCount = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count
        FROM track_embeddings te
        INNER JOIN "Track" t ON t.id = te.track_id
        WHERE t."removedAt" IS NULL
          AND t.origin = ${"LOCAL"}::"TrackOrigin"
          AND te.space_id = ${activeSpace.id}
    `;
    return Number(embeddingCount[0]?.count || 0);
}
