import { Request, Response, Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import {
    TRACK_BROWSE_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";
import { redisClient } from "../utils/redis";
import { blendEmbeddings, lerpEmbedding } from "../utils/embedding";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { findSimilarTracks } from "../services/hybridSimilarity";
import { computeMapProjection } from "../services/umapProjection";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../services/trackPreference";
import { loadVocabulary } from "../services/vibeVocabulary";
import {
    CALIBRATION_MIN_EMBEDDED_TRACKS,
    computeCalibration,
    countEmbeddedTracks,
    parseCachedCalibration,
    type CalibrationPayload,
} from "../services/vibeCalibration";
import {
    MOOD_CONFIG,
    VALID_MOODS,
    MoodType,
    MOOD_BUCKET_MIN_SCORE,
} from "../services/moodBucketService";
import {
    countEmbeddedBrowsableTracks,
    fetchEmbeddingsByTrackIds,
    fetchTrackEmbedding,
    findNearestToEmbedding,
    type NearestTrackRow,
} from "../services/trackEmbeddings";
import { getActiveSpace } from "../services/embeddingSpaces";
import { parseJourneyRequest } from "./vibeJourneyRequest";
import { sendRouteError, sendInternalRouteError } from "./routeErrorResponse";
import { coalesceInFlightByKey } from "../utils/singleflight";
import {
    TextEmbeddingProviderError,
    TextEmbeddingTimeoutError,
    TextEmbeddingUnavailableError,
} from "../services/textEmbedding";
import {
    executeVibeSearch,
    parseVibeSearchRequest,
} from "../services/vibeSearch";

const router = Router();

// Load vocabulary at module initialization
loadVocabulary();

async function buildTrackPreferenceScoreMapForUser(
    userId: string | undefined,
    trackIds: string[],
): Promise<Map<string, number>> {
    if (!userId || trackIds.length === 0) {
        return new Map<string, number>();
    }

    const uniqueTrackIds = Array.from(
        new Set(
            trackIds.filter(
                (trackId): trackId is string =>
                    typeof trackId === "string" && trackId.length > 0,
            ),
        ),
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
 * @openapi
 * /api/vibe/map:
 *   get:
 *     summary: Get vibe map projection data
 *     description: Returns cached or computed 2D projection data for tracks with CLAP embeddings.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: 2D vibe map projection payload
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/map",
    requireAuth,
    asyncHandler(async (_req, res) => {
        try {
            const mapData = await computeMapProjection();
            res.json(mapData);
        } catch (error: any) {
            logger.error("Vibe map error:", error);
            sendInternalRouteError(res, "Failed to compute map projection");
        }
    }),
);

function formatNearestTrack(row: NearestTrackRow) {
    return {
        id: row.id,
        title: row.title,
        distance: row.distance,
        similarity: Math.max(0, 1 - row.distance / 2),
        album: {
            id: row.albumId,
            title: row.albumTitle,
            coverUrl: row.albumCoverUrl,
        },
        artist: { id: row.artistId, name: row.artistName },
        // Mirrors GET /api/vibe/similar/:trackId's audioFeatures shape so the
        // map/journey/path UI can render the same energy/valence/danceability/
        // arousal readout for every track surface, not just similar-tracks.
        audioFeatures: {
            energy: row.energy,
            valence: row.valence,
            danceability: row.danceability,
            arousal: row.arousal,
        },
    };
}

/**
 * Walk from a starting embedding toward a target embedding, one interpolation
 * step at a time, picking the nearest not-yet-used track at each step. Shared
 * by /path (walk between two known tracks) and /journey (walk toward a track
 * or a mood centroid) so the two never drift out of sync.
 */
async function walkEmbeddingSteps(
    fromEmbed: number[],
    targetEmbed: number[],
    tValues: number[],
    initialExcludeIds: string[],
): Promise<ReturnType<typeof formatNearestTrack>[]> {
    const usedIds = new Set(initialExcludeIds);
    const stepResults: ReturnType<typeof formatNearestTrack>[] = [];

    // Deliberately sequential (not Promise.all'd): each step's exclusion set
    // (`usedIds`) accumulates the track picked by every prior step, so step N+1
    // must see step N's pick before it queries or it can re-offer an
    // already-used track (or two steps could double-book the same nearest
    // neighbor). This is an intentional intra-journey dedup dependency, not an
    // accidental N+1 — parallelizing these queries would break it.
    for (const t of tValues) {
        const interpolated = lerpEmbedding(fromEmbed, targetEmbed, t);
        const nearest = await findNearestToEmbedding(
            interpolated,
            5,
            Array.from(usedIds),
        );
        if (nearest.length > 0) {
            const pick = nearest[0];
            usedIds.add(pick.id);
            stepResults.push(formatNearestTrack(pick));
        }
    }

    return stepResults;
}

/**
 * @openapi
 * /api/vibe/path:
 *   get:
 *     summary: Find a musical path between two tracks
 *     description: Interpolates through CLAP embedding space to find intermediate tracks forming a smooth journey from one track to another.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema:
 *           type: string
 *         description: Starting track ID
 *       - in: query
 *         name: to
 *         required: true
 *         schema:
 *           type: string
 *         description: Ending track ID
 *       - in: query
 *         name: steps
 *         schema:
 *           type: integer
 *           default: 5
 *           minimum: 1
 *           maximum: 20
 *         description: Number of intermediate steps
 *     responses:
 *       200:
 *         description: Ordered list of intermediate tracks
 *       400:
 *         description: Missing from or to track IDs
 *       404:
 *         description: One or both tracks lack embeddings
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/path",
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const fromId = req.query.from as string;
            const toId = req.query.to as string;

            if (!fromId || !toId) {
                return sendRouteError(
                    res,
                    400,
                    "Both 'from' and 'to' track IDs are required",
                );
            }

            const steps = Math.min(
                Math.max(1, parseInt(req.query.steps as string) || 5),
                20,
            );

            const [fromEmbed, toEmbed] = await Promise.all([
                fetchTrackEmbedding(fromId),
                fetchTrackEmbedding(toId),
            ]);

            if (!fromEmbed) {
                return sendRouteError(
                    res,
                    404,
                    "Starting track has no embedding",
                );
            }
            if (!toEmbed) {
                return sendRouteError(
                    res,
                    404,
                    "Ending track has no embedding",
                );
            }

            const tValues = Array.from(
                { length: steps },
                (_, idx) => (idx + 1) / (steps + 1),
            );
            const stepResults = await walkEmbeddingSteps(
                fromEmbed,
                toEmbed,
                tValues,
                [fromId, toId],
            );

            res.json({ from: fromId, to: toId, steps: stepResults });
        } catch (error: any) {
            logger.error("Vibe path error:", error);
            sendInternalRouteError(res, "Failed to compute song path");
        }
    }),
);

const MIN_MOOD_BUCKET_TRACKS = 5;
const MOOD_BUCKET_POOL_LIMIT = 50;

interface JourneyTrackDestination {
    embedding: number[];
    target: { trackId: string; title: string };
    /** The literal final waypoint — never re-derived from an ANN query. */
    waypoint: ReturnType<typeof formatNearestTrack>;
}

type JourneyTrackDestinationResult =
    | { ok: true; value: JourneyTrackDestination }
    | { ok: false; status: number; error: string };

/**
 * Resolve a track-mode journey destination: its embedding plus the literal
 * final waypoint built from the Track row itself.
 */
async function resolveTrackDestination(
    toTrackId: string,
): Promise<JourneyTrackDestinationResult> {
    const toEmbed = await fetchTrackEmbedding(toTrackId);
    if (!toEmbed) {
        return {
            ok: false,
            status: 404,
            error: "Destination track has no embedding",
        };
    }

    const destinationTrack = await prisma.track.findUnique({
        where: {
            id: toTrackId,
            ...TRACK_VISIBLE_WHERE,
            AND: [TRACK_BROWSE_WHERE],
        },
        include: { album: { include: { artist: true } } },
    });
    if (!destinationTrack) {
        // TOCTOU: the embedding row fetched above (fetchTrackEmbedding
        // succeeded) can outlive its Track row for a moment if the track is
        // deleted between the two queries — TrackEmbedding has onDelete:
        // Cascade, so this is a genuine race window, not a stale-row bug.
        // Without this guard the route would silently drop the destination
        // instead of ever reaching it.
        return { ok: false, status: 404, error: "Destination track not found" };
    }

    return {
        ok: true,
        value: {
            embedding: toEmbed,
            target: { trackId: toTrackId, title: destinationTrack.title },
            waypoint: {
                id: destinationTrack.id,
                title: destinationTrack.title,
                distance: 0,
                similarity: 1,
                album: {
                    id: destinationTrack.album.id,
                    title: destinationTrack.album.title,
                    coverUrl: destinationTrack.album.coverUrl,
                },
                artist: {
                    id: destinationTrack.album.artist.id,
                    name: destinationTrack.album.artist.name,
                },
                audioFeatures: {
                    energy: destinationTrack.energy,
                    valence: destinationTrack.valence,
                    danceability: destinationTrack.danceability,
                    arousal: destinationTrack.arousal,
                },
            },
        },
    };
}

/**
 * Average the embeddings of the top-scoring qualifying tracks in a mood
 * bucket into a journey target centroid. The pool comes from Prisma (bucket
 * membership is relational data); only the pgvector column read goes through
 * the service-layer `fetchEmbeddingsByTrackIds`. Returns null when fewer
 * than MIN_MOOD_BUCKET_TRACKS embedded tracks qualify — the mood isn't
 * journeyable yet.
 */
async function resolveMoodCentroid(mood: MoodType): Promise<number[] | null> {
    const activeSpace = await getActiveSpace();
    const pool = await prisma.moodBucket.findMany({
        where: {
            mood,
            score: { gte: MOOD_BUCKET_MIN_SCORE },
            track: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                embeddings: { some: { spaceId: activeSpace.id } },
            },
        },
        orderBy: { score: "desc" },
        take: MOOD_BUCKET_POOL_LIMIT,
        select: { trackId: true },
    });
    if (pool.length < MIN_MOOD_BUCKET_TRACKS) return null;

    const rows = await fetchEmbeddingsByTrackIds(pool.map((p) => p.trackId));
    // Re-check after the embedding fetch: a track can lose its embedding row
    // between the two queries (same cascade-delete race as the track-mode
    // destination), and a centroid from too few vectors isn't a mood anymore.
    if (rows.length < MIN_MOOD_BUCKET_TRACKS) return null;

    const embeddings = rows.map((row) => row.embedding);
    return blendEmbeddings(
        embeddings,
        embeddings.map(() => 1),
    );
}

type JourneyComputation =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; status: number; error: string };

async function computeTrackJourney(
    fromTrackId: string,
    toTrackId: string,
    fromEmbed: number[],
    steps: number,
    excludeTrackIds: string[],
): Promise<JourneyComputation> {
    const destination = await resolveTrackDestination(toTrackId);
    if (!destination.ok) return destination;
    const tValues = Array.from(
        { length: steps - 1 },
        (_, index) => (index + 1) / steps,
    );
    const intermediate = await walkEmbeddingSteps(
        fromEmbed,
        destination.value.embedding,
        tValues,
        [fromTrackId, toTrackId, ...excludeTrackIds],
    );
    return {
        ok: true,
        body: {
            mode: "track",
            target: destination.value.target,
            waypoints: [...intermediate, destination.value.waypoint],
        },
    };
}

type AlchemyEmbeddingResult =
    | { ok: true; embeddings: number[][] }
    | { ok: false; missingTrackId: string };

async function fetchAlchemyEmbeddings(
    trackIds: string[],
): Promise<AlchemyEmbeddingResult> {
    const embeddings: number[][] = [];
    for (const trackId of trackIds) {
        const embedding = await fetchTrackEmbedding(trackId);
        if (!embedding) return { ok: false, missingTrackId: trackId };
        embeddings.push(embedding);
    }
    return { ok: true, embeddings };
}

function resolveAlchemyWeights(trackIds: string[], weights: unknown): number[] {
    if (!Array.isArray(weights) || weights.length !== trackIds.length) {
        return trackIds.map(() => 1);
    }
    return weights.map((weight) => Math.max(0, weight as number));
}

async function computeMoodJourney(
    fromTrackId: string,
    mood: MoodType,
    fromEmbed: number[],
    steps: number,
    excludeTrackIds: string[],
): Promise<JourneyComputation> {
    const centroid = await resolveMoodCentroid(mood);
    if (!centroid) {
        return {
            ok: false,
            status: 404,
            error: `Mood '${mood}' does not have enough embedded tracks for a journey`,
        };
    }
    const tValues = Array.from(
        { length: steps },
        (_, index) => (index + 1) / steps,
    );
    const waypoints = await walkEmbeddingSteps(fromEmbed, centroid, tValues, [
        fromTrackId,
        ...excludeTrackIds,
    ]);
    return {
        ok: true,
        body: {
            mode: "mood",
            target: { mood, label: MOOD_CONFIG[mood].name },
            waypoints,
        },
    };
}

async function handleJourney(req: Request, res: Response) {
    try {
        const parsed = parseJourneyRequest(req.body);
        if (!parsed.ok) {
            return sendRouteError(res, parsed.status, parsed.error);
        }
        const { fromTrackId, toTrackId, mood, steps, excludeTrackIds } =
            parsed.value;
        const fromEmbed = await fetchTrackEmbedding(fromTrackId);
        if (!fromEmbed) {
            return sendRouteError(res, 404, "Starting track has no embedding");
        }
        const result =
            toTrackId !== null
                ? await computeTrackJourney(
                      fromTrackId,
                      toTrackId,
                      fromEmbed,
                      steps,
                      excludeTrackIds,
                  )
                : await computeMoodJourney(
                      fromTrackId,
                      mood as MoodType,
                      fromEmbed,
                      steps,
                      excludeTrackIds,
                  );
        if (!result.ok) {
            return sendRouteError(res, result.status, result.error);
        }
        return res.json(result.body);
    } catch (error: any) {
        logger.error("Vibe journey error:", error);
        return sendInternalRouteError(res, "Failed to compute vibe journey");
    }
}

/**
 * @openapi
 * /api/vibe/journey:
 *   post:
 *     summary: Walk from a track toward a destination track or mood
 *     description: Interpolates through CLAP embedding space from a starting track toward either a destination track or the centroid of a mood bucket, returning an ordered list of waypoint tracks.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fromTrackId
 *             properties:
 *               fromTrackId:
 *                 type: string
 *                 description: Starting track ID
 *               toTrackId:
 *                 type: string
 *                 description: Destination track ID (exactly one of toTrackId/mood is required)
 *               mood:
 *                 type: string
 *                 enum: [happy, sad, chill, energetic, party, focus, melancholy, aggressive, acoustic]
 *                 description: Destination mood bucket (exactly one of toTrackId/mood is required)
 *               steps:
 *                 type: integer
 *                 default: 8
 *                 minimum: 2
 *                 maximum: 20
 *                 description: Number of waypoints to return
 *               excludeTrackIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 200
 *                 description: Track IDs to exclude from waypoints
 *     responses:
 *       200:
 *         description: Ordered list of waypoint tracks toward the destination track or mood centroid
 *       400:
 *         description: Missing fromTrackId, not exactly one of toTrackId/mood, invalid mood, or excludeTrackIds invalid/too long
 *       404:
 *         description: Starting track has no embedding, destination track has no embedding, destination track was not found (e.g. deleted between the embedding lookup and the track fetch), or the mood has fewer than 5 embedded tracks
 *       401:
 *         description: Not authenticated
 */
router.post("/journey", requireAuth, asyncHandler(handleJourney));

/**
 * @openapi
 * /api/vibe/moods:
 *   get:
 *     summary: List moods usable as journey/drift anchors
 *     description: Returns each canonical mood with the count of qualifying bucket tracks that also have a CLAP embedding, so the UI can enable/disable mood-based journey targets.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Moods with embedded-track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   mood:
 *                     type: string
 *                   trackCount:
 *                     type: integer
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/moods",
    requireAuth,
    asyncHandler(async (_req, res) => {
        try {
            const activeSpace = await getActiveSpace();
            const grouped = await prisma.moodBucket.groupBy({
                by: ["mood"],
                where: {
                    score: { gte: MOOD_BUCKET_MIN_SCORE },
                    track: {
                        ...TRACK_VISIBLE_WHERE,
                        ...TRACK_BROWSE_WHERE,
                        embeddings: { some: { spaceId: activeSpace.id } },
                    },
                },
                _count: { _all: true },
            });

            const countsByMood = new Map(
                grouped.map((row) => [row.mood, row._count._all]),
            );

            res.json(
                VALID_MOODS.map((mood) => ({
                    mood,
                    trackCount: countsByMood.get(mood) ?? 0,
                })),
            );
        } catch (error: any) {
            logger.error("Vibe moods error:", error);
            sendInternalRouteError(res, "Failed to list moods");
        }
    }),
);

/**
 * @openapi
 * /api/vibe/alchemy:
 *   post:
 *     summary: Blend multiple tracks to discover new vibes
 *     description: Combines CLAP embeddings from multiple ingredient tracks with optional weights to find tracks matching the blended vibe.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - trackIds
 *             properties:
 *               trackIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 2
 *                 maxItems: 10
 *                 description: Track IDs to blend
 *               weights:
 *                 type: array
 *                 items:
 *                   type: number
 *                 description: Optional per-track weights (defaults to equal)
 *               limit:
 *                 type: integer
 *                 default: 20
 *                 minimum: 1
 *                 maximum: 100
 *     responses:
 *       200:
 *         description: Tracks matching the blended vibe
 *       400:
 *         description: Fewer than 2 or more than 10 track IDs provided, or weights do not sum to a positive value
 *       404:
 *         description: One or more ingredient tracks lack embeddings
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/alchemy",
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const { trackIds, weights, limit: requestedLimit } = req.body;

            if (!Array.isArray(trackIds) || trackIds.length < 2) {
                return sendRouteError(
                    res,
                    400,
                    "At least 2 track IDs are required for alchemy",
                );
            }

            if (trackIds.length > 10) {
                return sendRouteError(
                    res,
                    400,
                    "Maximum 10 ingredient tracks allowed",
                );
            }

            const limit = Math.min(Math.max(1, requestedLimit || 20), 100);

            const embeddingResult = await fetchAlchemyEmbeddings(trackIds);
            if (!embeddingResult.ok) {
                return sendRouteError(
                    res,
                    404,
                    `Track ${embeddingResult.missingTrackId} has no embedding`,
                );
            }
            const effectiveWeights = resolveAlchemyWeights(trackIds, weights);

            // Flooring negatives at 0 above still allows every weight to be 0 (e.g.
            // [0, 0]), which makes blendEmbeddings divide by a zero totalWeight and
            // fill the blended vector with NaN — pgvector rejects a NaN-bearing
            // vector, so that request would otherwise reach findNearestToEmbedding
            // and surface as an opaque 500. Reject it explicitly instead.
            const weightSum = effectiveWeights.reduce((s, w) => s + w, 0);
            if (!Number.isFinite(weightSum) || weightSum <= 0) {
                return sendRouteError(
                    res,
                    400,
                    "weights must sum to a positive value",
                );
            }

            const blended = blendEmbeddings(
                embeddingResult.embeddings,
                effectiveWeights,
            );
            const nearest = await findNearestToEmbedding(
                blended,
                limit,
                trackIds,
            );

            res.json({
                ingredients: trackIds,
                weights: effectiveWeights,
                tracks: nearest.map(formatNearestTrack),
            });
        } catch (error: any) {
            logger.error("Vibe alchemy error:", error);
            sendInternalRouteError(res, "Failed to compute alchemy blend");
        }
    }),
);

type SimilarTrack = Awaited<ReturnType<typeof findSimilarTracks>>[number];

async function applySimilarTrackPreferenceWeighting(
    userId: string | undefined,
    tracks: SimilarTrack[],
): Promise<SimilarTrack[]> {
    const scores = await buildTrackPreferenceScoreMapForUser(
        userId,
        tracks.map((track) => track.id),
    );
    if (scores.size === 0) return tracks;
    const ordering = applyTrackPreferenceOrderBias(
        tracks.map((track) => track.id),
        scores,
    );
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const weighted = ordering
        .map((id) => trackById.get(id))
        .filter((track): track is SimilarTrack => Boolean(track))
        .map((track) => ({
            ...track,
            similarity: Math.max(
                0,
                Math.min(
                    1,
                    applyTrackPreferenceSimilarityBias(
                        track.similarity,
                        scores.get(track.id) ?? 0,
                    ),
                ),
            ),
        }));
    logger.debug(
        `[Vibe] Applied light preference weighting using ${scores.size} track preferences`,
    );
    return weighted;
}

function formatSimilarTrack(track: SimilarTrack) {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        distance: track.distance,
        similarity: track.similarity,
        album: {
            id: track.albumId,
            title: track.albumTitle,
            coverUrl: track.albumCoverUrl,
        },
        artist: { id: track.artistId, name: track.artistName },
        audioFeatures: {
            energy: track.energy,
            valence: track.valence,
            danceability: track.danceability,
            arousal: track.arousal,
        },
    };
}

/**
 * @openapi
 * /api/vibe/similar/{trackId}:
 *   get:
 *     summary: Find similar tracks
 *     description: Returns tracks similar to the given track using hybrid similarity (CLAP embeddings + audio features). Results are weighted by user track preferences (likes/dislikes).
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Source track ID to find similar tracks for
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of similar tracks to return
 *     responses:
 *       200:
 *         description: Similar tracks with similarity scores and audio features
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sourceTrackId:
 *                   type: string
 *                 sourceFeatures:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     energy:
 *                       type: number
 *                     valence:
 *                       type: number
 *                     danceability:
 *                       type: number
 *                     arousal:
 *                       type: number
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       title:
 *                         type: string
 *                       duration:
 *                         type: number
 *                       distance:
 *                         type: number
 *                       similarity:
 *                         type: number
 *                       album:
 *                         type: object
 *                       artist:
 *                         type: object
 *                       audioFeatures:
 *                         type: object
 *       404:
 *         description: No similar tracks found or track not analyzed
 *       401:
 *         description: Not authenticated
 */
router.get<{ trackId: string }>(
    "/similar/:trackId",
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const { trackId } = req.params;
            const userId = req.user?.id;
            const limit = Math.min(
                Math.max(1, parseInt(req.query.limit as string) || 20),
                100,
            );

            const tracks = await findSimilarTracks(trackId, limit);
            const weightedTracks = await applySimilarTrackPreferenceWeighting(
                userId,
                tracks,
            );

            if (weightedTracks.length === 0) {
                return sendRouteError(res, 404, "No similar tracks found");
            }

            // Fetch source track audio features for vibe match comparison
            const sourceTrack = await prisma.track.findUnique({
                where: {
                    id: trackId,
                    ...TRACK_VISIBLE_WHERE,
                    AND: [TRACK_BROWSE_WHERE],
                },
                select: {
                    energy: true,
                    valence: true,
                    danceability: true,
                    arousal: true,
                },
            });

            res.json({
                sourceTrackId: trackId,
                sourceFeatures: sourceTrack
                    ? {
                          energy: sourceTrack.energy,
                          valence: sourceTrack.valence,
                          danceability: sourceTrack.danceability,
                          arousal: sourceTrack.arousal,
                      }
                    : null,
                tracks: weightedTracks.map(formatSimilarTrack),
            });
        } catch (error: any) {
            logger.error("Hybrid similarity error:", error);
            sendInternalRouteError(res, "Failed to find similar tracks");
        }
    }),
);

/**
 * @openapi
 * /api/vibe/search:
 *   post:
 *     summary: Search tracks by natural language vibe
 *     description: Searches for tracks using natural language text via CLAP text embeddings. Queries are expanded with a vocabulary of genre/mood terms and results are re-ranked using audio features.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 512
 *                 description: Natural language search query (e.g. "chill acoustic guitar", "aggressive punk rock")
 *               limit:
 *                 type: integer
 *                 default: 20
 *                 minimum: 1
 *                 maximum: 100
 *               minSimilarity:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *                 default: 0.60
 *                 description: Minimum similarity threshold (0-1)
 *     responses:
 *       200:
 *         description: Matching tracks ranked by similarity
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 query:
 *                   type: string
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 minSimilarity:
 *                   type: number
 *                 totalAboveThreshold:
 *                   type: integer
 *                 debug:
 *                   type: object
 *       400:
 *         description: Query must contain between 2 and 512 characters
 *       401:
 *         description: Not authenticated
 *       504:
 *         description: Text embedding service unavailable
 */
router.post(
    "/search",
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const parsed = parseVibeSearchRequest(req.body);
            if (!parsed.ok) return sendRouteError(res, 400, parsed.error);
            res.json(await executeVibeSearch(parsed.value));
        } catch (error: unknown) {
            logger.error("Vibe text search error:", error);
            if (error instanceof TextEmbeddingProviderError) {
                return sendInternalRouteError(
                    res,
                    "Failed to search tracks by vibe",
                );
            }
            if (error instanceof TextEmbeddingUnavailableError) {
                return sendRouteError(
                    res,
                    503,
                    "Text embedding service unavailable",
                );
            }
            if (
                error instanceof TextEmbeddingTimeoutError ||
                (error instanceof Error && error.message.includes("timed out"))
            ) {
                return sendRouteError(
                    res,
                    504,
                    "Text embedding service unavailable",
                );
            }
            sendInternalRouteError(res, "Failed to search tracks by vibe");
        }
    }),
);

/**
 * @openapi
 * /api/vibe/status:
 *   get:
 *     summary: Get embedding analysis progress
 *     description: Returns statistics on how many tracks have been analyzed with CLAP embeddings, including total track count, embedded count, and completion percentage
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Embedding analysis progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalTracks:
 *                   type: integer
 *                 embeddedTracks:
 *                   type: integer
 *                 progress:
 *                   type: integer
 *                   description: Percentage of tracks analyzed (0-100)
 *                 isComplete:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/status",
    requireAuth,
    asyncHandler(async (req, res) => {
        try {
            const totalTracks = await prisma.track.count({
                where: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
            });

            const embeddedCount = await countEmbeddedBrowsableTracks();
            const progress =
                totalTracks > 0
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
            sendInternalRouteError(res, "Failed to get embedding status");
        }
    }),
);

const CALIBRATION_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h
const CALIBRATION_CACHE_KEY_PREFIX = "vibe:calibration:v1:";

/**
 * Single-flight for cold-cache calibration computes, keyed by cache key.
 * The pairwise-distance compute is O(sample²); without this, N concurrent
 * cold-cache requests (e.g. several map tabs opening after the TTL lapses)
 * would each run the full sample + compute. The first request computes and
 * caches; concurrent callers await the same promise. Entries clear in
 * `finally`, so a failed compute is retriable immediately.
 */
const calibrationInFlight = new Map<string, Promise<CalibrationPayload>>();

async function getCachedOrComputeCalibration(
    cacheKey: string,
): Promise<CalibrationPayload> {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
        const payload = parseCachedCalibration(cached);
        if (payload) return payload;
        logger.warn("Ignoring invalid vibe calibration cache payload", {
            cacheKey,
        });
    }

    return coalesceInFlightByKey(calibrationInFlight, cacheKey, () =>
        computeCalibration().then(async (payload) => {
            await redisClient.setEx(
                cacheKey,
                CALIBRATION_CACHE_TTL_SECONDS,
                JSON.stringify(payload),
            );
            return payload;
        }),
    );
}

async function getCalibrationResponse() {
    const embeddedCount = await countEmbeddedTracks();
    if (embeddedCount < CALIBRATION_MIN_EMBEDDED_TRACKS) {
        return { sampleSize: 0, quantiles: [] };
    }
    const cacheKey = `${CALIBRATION_CACHE_KEY_PREFIX}${embeddedCount}`;
    return getCachedOrComputeCalibration(cacheKey);
}

/**
 * @openapi
 * /api/vibe/calibration:
 *   get:
 *     summary: Get library-calibrated pairwise-distance quantiles
 *     description: Returns the p0-p100 percentiles of pairwise CLAP cosine distance over a bounded random sample of embedded tracks in this library, so the UI can express match strength as "closer than N% of random pairs in your library" instead of a fixed linear mapping that reads as inflated on libraries where unrelated tracks rarely exceed distance ~1.0. The sample is drawn via an id-only indexed scan plus a primary-key fetch (never a full-table random sort), cached for 24h keyed on the embedded-track count, and concurrent cold-cache requests collapse into a single compute.
 *     tags: [Vibe]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Distance quantiles, or an empty result when fewer than 10 tracks are embedded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sampleSize:
 *                   type: integer
 *                   description: Number of tracks sampled (0 when the library has fewer than 10 embedded tracks)
 *                 updatedAt:
 *                   type: string
 *                   description: ISO timestamp the sample was computed (omitted when sampleSize is 0)
 *                 quantiles:
 *                   type: array
 *                   items:
 *                     type: number
 *                   description: p0..p100 percentiles of pairwise cosine distance (101 values), empty when sampleSize is 0
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/calibration",
    requireAuth,
    asyncHandler(async (_req, res) => {
        try {
            return res.json(await getCalibrationResponse());
        } catch (error: any) {
            logger.error("Vibe calibration error:", error);
            return sendInternalRouteError(
                res,
                "Failed to compute vibe calibration",
            );
        }
    }),
);

export default router;
