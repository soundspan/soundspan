import { Router } from "express";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth } from "../middleware/auth";
import { findSimilarTracks } from "../services/hybridSimilarity";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../services/trackPreference";
import {
    getVocabulary,
    expandQueryWithVocabulary,
    rerankWithFeatures,
    loadVocabulary,
    VocabTerm
} from "../services/vibeVocabulary";

const router = Router();

// Load vocabulary at module initialization
loadVocabulary();

const TEXT_EMBED_REQUEST_STREAM = "audio:text:embed:requests";
const TEXT_EMBED_RESPONSE_PREFIX = "audio:text:embed:response:";
const TEXT_EMBED_TIMEOUT_SECONDS = 30;

interface TextSearchResult {
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

async function buildTrackPreferenceScoreMapForUser(
    userId: string | undefined,
    trackIds: string[]
): Promise<Map<string, number>> {
    if (!userId || trackIds.length === 0) {
        return new Map<string, number>();
    }

    const uniqueTrackIds = Array.from(
        new Set(
            trackIds.filter(
                (trackId): trackId is string =>
                    typeof trackId === "string" && trackId.length > 0
            )
        )
    );
    if (uniqueTrackIds.length === 0) {
        return new Map<string, number>();
    }

    const [likedEntries, dislikedEntries] = await Promise.all([
        prisma.likedTrack.findMany({
            where: {
                userId,
                trackId: { in: uniqueTrackIds },
            },
            select: {
                trackId: true,
                likedAt: true,
            },
        }),
        prisma.dislikedEntity.findMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: uniqueTrackIds },
            },
            select: {
                entityId: true,
                dislikedAt: true,
            },
        }),
    ]);

    const likedByTrackId = new Map<string, Date>();
    for (const entry of likedEntries) {
        likedByTrackId.set(entry.trackId, entry.likedAt);
    }

    const dislikedByTrackId = new Map<string, Date>();
    for (const entry of dislikedEntries) {
        dislikedByTrackId.set(entry.entityId, entry.dislikedAt);
    }

    const scoreMap = new Map<string, number>();
    for (const trackId of uniqueTrackIds) {
        const resolved = resolveTrackPreference({
            likedAt: likedByTrackId.get(trackId) ?? null,
            dislikedAt: dislikedByTrackId.get(trackId) ?? null,
        });
        if (resolved.score !== 0) {
            scoreMap.set(trackId, resolved.score);
        }
    }

    return scoreMap;
}

/**
 * GET /api/vibe/similar/:trackId
 * Find tracks similar to a given track using hybrid similarity (CLAP + audio features)
 */
router.get("/similar/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;
        const userId = req.user?.id;
        const limit = Math.min(
            Math.max(1, parseInt(req.query.limit as string) || 20),
            100
        );

        const tracks = await findSimilarTracks(trackId, limit);
        let weightedTracks = tracks;

        const preferenceScores = await buildTrackPreferenceScoreMapForUser(
            userId,
            tracks.map((track) => track.id)
        );
        if (preferenceScores.size > 0) {
            const ordering = applyTrackPreferenceOrderBias(
                tracks.map((track) => track.id),
                preferenceScores
            );
            const trackById = new Map(tracks.map((track) => [track.id, track]));
            weightedTracks = ordering
                .map((id) => trackById.get(id))
                .filter((track): track is (typeof tracks)[number] => Boolean(track))
                .map((track) => ({
                    ...track,
                    similarity: Math.max(
                        0,
                        Math.min(
                            1,
                            applyTrackPreferenceSimilarityBias(
                                track.similarity,
                                preferenceScores.get(track.id) ?? 0
                            )
                        )
                    ),
                }));
            logger.debug(
                `[Vibe] Applied light preference weighting using ${preferenceScores.size} track preferences`
            );
        }

        if (weightedTracks.length === 0) {
            return res.status(404).json({
                error: "No similar tracks found",
                message: "This track may not have been analyzed yet, or no analyzer is running",
            });
        }

        // Fetch source track audio features for vibe match comparison
        const sourceTrack = await prisma.track.findUnique({
            where: { id: trackId },
            select: { energy: true, valence: true, danceability: true, arousal: true },
        });

        res.json({
            sourceTrackId: trackId,
            sourceFeatures: sourceTrack ? {
                energy: sourceTrack.energy,
                valence: sourceTrack.valence,
                danceability: sourceTrack.danceability,
                arousal: sourceTrack.arousal,
            } : null,
            tracks: weightedTracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                distance: t.distance,
                similarity: t.similarity,
                album: {
                    id: t.albumId,
                    title: t.albumTitle,
                    coverUrl: t.albumCoverUrl,
                },
                artist: {
                    id: t.artistId,
                    name: t.artistName,
                },
                audioFeatures: {
                    energy: t.energy,
                    valence: t.valence,
                    danceability: t.danceability,
                    arousal: t.arousal,
                },
            })),
        });
    } catch (error: any) {
        logger.error("Hybrid similarity error:", error);
        res.status(500).json({ error: "Failed to find similar tracks" });
    }
});

// Convert CLAP cosine distance (0-2 range) to similarity percentage (0-1)
// distance 0 = identical, distance 1 = orthogonal, distance 2 = opposite
function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance / 2);
}

// Minimum similarity threshold for search results
// 0.65 = 65% match, meaning distance <= 0.7
const MIN_SEARCH_SIMILARITY = 0.60;

interface TextEmbedResponsePayload {
    requestId: string;
    success: boolean;
    embedding: number[] | null;
    modelVersion: string;
    error?: string;
}

/**
 * POST /api/vibe/search
 * Search for tracks using natural language text via CLAP text embeddings
 */
router.post("/search", requireAuth, async (req, res) => {
    try {
        const { query, limit: requestedLimit, minSimilarity } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return res.status(400).json({
                error: "Query must be at least 2 characters",
            });
        }

        const limit = Math.min(
            Math.max(1, requestedLimit || 20),
            100
        );

        // Allow override but default to MIN_SEARCH_SIMILARITY
        const similarityThreshold = typeof minSimilarity === "number"
            ? Math.max(0, Math.min(1, minSimilarity))
            : MIN_SEARCH_SIMILARITY;

        // Convert similarity threshold to max distance
        // similarity = 1 - (distance / 2), so distance = 2 * (1 - similarity)
        const maxDistance = 2 * (1 - similarityThreshold);

        const requestId = randomUUID();
        const responseKey = `${TEXT_EMBED_RESPONSE_PREFIX}${requestId}`;
        const normalizedQuery = query.trim();

        try {
            // Queue text-embedding request via Redis Streams to ensure a single
            // CLAP replica claims and processes each request.
            await redisClient.xAdd(
                TEXT_EMBED_REQUEST_STREAM,
                "*",
                {
                    requestId,
                    text: normalizedQuery,
                    responseKey,
                }
            );

            // Wait for response from the CLAP worker.
            const response = await redisClient.blPop(
                responseKey,
                TEXT_EMBED_TIMEOUT_SECONDS
            );

            if (!response?.element) {
                throw new Error("Text embedding request timed out");
            }

            let payload: TextEmbedResponsePayload;
            try {
                payload = JSON.parse(response.element) as TextEmbedResponsePayload;
            } catch (_error) {
                throw new Error("Invalid response from analyzer");
            }

            if (payload.error) {
                throw new Error(payload.error);
            }

            if (!Array.isArray(payload.embedding)) {
                throw new Error("Invalid response from analyzer");
            }

            const textEmbedding = payload.embedding;

            // Query expansion with vocabulary
            const vocab = getVocabulary();
            let searchEmbedding = textEmbedding;
            let genreConfidence = 0;
            let matchedTerms: VocabTerm[] = [];

            if (vocab) {
                const expansion = expandQueryWithVocabulary(textEmbedding, normalizedQuery, vocab);
                searchEmbedding = expansion.embedding;
                genreConfidence = expansion.genreConfidence;
                matchedTerms = expansion.matchedTerms;

                logger.info(`[VIBE-SEARCH] Query "${normalizedQuery}" expanded with terms: ${matchedTerms.map(t => t.name).join(", ") || "none"}, genre confidence: ${(genreConfidence * 100).toFixed(0)}%`);
            }

            // Query for similar tracks using the (possibly expanded) embedding
            // Fetch more candidates for re-ranking (3x limit)
            // Filter by max distance to exclude poor matches
            const similarTracks = await prisma.$queryRaw<TextSearchResult[]>`
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
                WHERE te.embedding <=> ${searchEmbedding}::vector <= ${maxDistance}
                ORDER BY te.embedding <=> ${searchEmbedding}::vector
                LIMIT ${limit * 3}
            `;

            logger.info(`Vibe search "${normalizedQuery}": found ${similarTracks.length} candidates above ${Math.round(similarityThreshold * 100)}% similarity (max distance: ${maxDistance.toFixed(2)})`);

            // Re-rank using audio features if we have vocabulary matches
            let rankedTracks: typeof similarTracks | ReturnType<typeof rerankWithFeatures<TextSearchResult>> = similarTracks;
            if (vocab && matchedTerms.length > 0) {
                const reranked = rerankWithFeatures(similarTracks, matchedTerms, genreConfidence);
                rankedTracks = reranked.slice(0, limit);

                logger.info(`[VIBE-SEARCH] Re-ranked ${similarTracks.length} candidates, top result: ${rankedTracks[0]?.title || "none"}`);
            } else {
                rankedTracks = similarTracks.slice(0, limit);
            }

            // If we have results, log the similarity range
            if (rankedTracks.length > 0) {
                const first = rankedTracks[0];
                const last = rankedTracks[rankedTracks.length - 1];
                const bestSim = "finalScore" in first ? first.finalScore : distanceToSimilarity(first.distance);
                const worstSim = "finalScore" in last ? last.finalScore : distanceToSimilarity(last.distance);
                logger.info(`Vibe search similarity range: ${Math.round(bestSim * 100)}% - ${Math.round(worstSim * 100)}%`);
            }

            const tracks = rankedTracks.map((row) => ({
                id: row.id,
                title: row.title,
                duration: row.duration,
                trackNo: row.trackNo,
                distance: row.distance,
                similarity: "finalScore" in row ? row.finalScore : distanceToSimilarity(row.distance),
                album: {
                    id: row.albumId,
                    title: row.albumTitle,
                    coverUrl: row.albumCoverUrl,
                },
                artist: {
                    id: row.artistId,
                    name: row.artistName,
                },
            }));

            res.json({
                query: normalizedQuery,
                tracks,
                minSimilarity: similarityThreshold,
                totalAboveThreshold: tracks.length,
                debug: {
                    matchedTerms: matchedTerms.map(t => t.name),
                    genreConfidence,
                    featureWeight: matchedTerms.length > 0 ? 0.2 + (genreConfidence * 0.5) : 0
                }
            });
        } finally {
            await redisClient.del(responseKey).catch(() => {});
        }
    } catch (error: any) {
        logger.error("Vibe text search error:", error);
        if (error.message?.includes("timed out")) {
            return res.status(504).json({
                error: "Text embedding service unavailable",
                message: "The CLAP analyzer service did not respond in time",
            });
        }
        res.status(500).json({ error: "Failed to search tracks by vibe" });
    }
});

/**
 * GET /api/vibe/status
 * Get embedding analysis progress statistics
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const totalTracks = await prisma.track.count();

        const embeddedTracks = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;

        const embeddedCount = Number(embeddedTracks[0]?.count || 0);
        const progress = totalTracks > 0
            ? Math.round((embeddedCount / totalTracks) * 100)
            : 0;

        res.json({
            totalTracks,
            embeddedTracks: embeddedCount,
            progress,
            isComplete: embeddedCount >= totalTracks && totalTracks > 0,
        });
    } catch (error: any) {
        logger.error("Vibe status error:", error);
        res.status(500).json({ error: "Failed to get embedding status" });
    }
});

export default router;
