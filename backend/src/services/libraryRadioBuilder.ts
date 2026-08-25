import { prisma, Prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    computeAggregateFeatureVector,
    scoreTracksAgainstSeed,
} from "./radioVibeEngine";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
} from "./trackPreference";
import { buildTrackPreferenceScoreMapForUser } from "./libraryTrackPreferences";
import { loadScalarRadioCandidatePool } from "./libraryRadioCache";
import { getMergedGenres } from "../utils/metadataOverrides";
import { shuffleArray } from "../utils/shuffle";
import { escapeLikePattern } from "../utils/likePattern";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import { applyArtistCap } from "./programmaticPlaylistArtistCap";

/** Return the strict per-artist cap for a requested radio queue length. */
export const getRadioArtistCapForLimit = (limit: number): number => {
    if (!Number.isFinite(limit) || limit <= 0) return 2;
    return Math.max(2, Math.floor(limit / 12));
};

/** Return the bounded relaxed per-artist cap for a radio queue length. */
export const getRelaxedRadioArtistCapForLimit = (limit: number): number => {
    const strictCap = getRadioArtistCapForLimit(limit);
    return Math.max(strictCap + 1, Math.ceil(limit / 6));
};

/**
 * Select ranked radio tracks under strict and relaxed artist caps.
 *
 * The final refill remains bounded by the shared 30%-share ceiling, so a
 * narrow one- or two-artist pool may return fewer tracks than requested.
 */
export const selectTracksWithArtistDiversity = <
    T extends { id: string; artistId: string },
>(
    tracks: T[],
    targetCount: number,
    strictCap: number,
    relaxedCap: number,
): T[] => {
    if (
        !Array.isArray(tracks) ||
        !Number.isFinite(targetCount) ||
        targetCount <= 0
    ) {
        return [];
    }
    return applyArtistCap(tracks, {
        preserveInputOrder: true,
        targetCount,
        maxPerArtist: strictCap,
        getArtistId: (track) => track.artistId,
        fallback: {
            enabled: true,
            relaxationStep: Math.max(1, relaxedCap - strictCap),
            maxRelaxedPerArtist: relaxedCap,
            refillFromExcludedAfterMaxRelaxation: true,
        },
    });
};

/**
 * Builds a multi-track seeded radio queue using vibe-matching against a centroid
 * computed from the seed tracks' audio features.
 *
 * Falls back through: vibe matches → seed artist tracks → genre expansion → random fill.
 *
 * @param seedTrackIds - IDs of the seed tracks to derive the radio vibe from.
 * @param excludeTrackIds - IDs to exclude from results (typically the seeds themselves).
 * @param limitNum - Maximum number of tracks to return.
 * @param userId - Authenticated user ID for preference weighting.
 * @returns Object with trackIds array and preserveInputOrder flag.
 */
export const buildMultiTrackRadio = async (
    seedTrackIds: string[],
    excludeTrackIds: string[],
    limitNum: number,
    userId: string | undefined,
): Promise<{ trackIds: string[]; preserveInputOrder: boolean }> => {
    if (seedTrackIds.length === 0) {
        return { trackIds: [], preserveInputOrder: true };
    }

    // 1. Load seed tracks with analysis fields
    const seedTracks = await prisma.track.findMany({
        where: { ...TRACK_VISIBLE_WHERE, id: { in: seedTrackIds } },
        select: {
            id: true,
            bpm: true,
            energy: true,
            valence: true,
            arousal: true,
            danceability: true,
            keyScale: true,
            moodTags: true,
            lastfmTags: true,
            essentiaGenres: true,
            instrumentalness: true,
            moodHappy: true,
            moodSad: true,
            moodRelaxed: true,
            moodAggressive: true,
            moodParty: true,
            moodAcoustic: true,
            moodElectronic: true,
            danceabilityMl: true,
            analysisMode: true,
            analysisVersion: true,
            album: {
                select: {
                    artistId: true,
                    artist: {
                        select: { id: true, genres: true, userGenres: true },
                    },
                },
            },
        },
    });

    if (seedTracks.length === 0) {
        return { trackIds: [], preserveInputOrder: true };
    }

    // 2. Compute aggregate feature vector (centroid)
    const seedVector = computeAggregateFeatureVector(seedTracks);

    // 3. Merge tags and genres from all seeds
    const allTags = new Set<string>();
    const allGenres = new Set<string>();
    for (const t of seedTracks) {
        for (const tag of t.lastfmTags || []) allTags.add(tag);
        for (const genre of t.essentiaGenres || []) allGenres.add(genre);
    }

    // Collect seed artist IDs for fallback
    const seedArtistIds = new Set<string>();
    for (const t of seedTracks) {
        if (t.album?.artistId) seedArtistIds.add(t.album.artistId);
    }

    const excludeSet = new Set(excludeTrackIds);
    let resultIds: string[] = [];

    // 4. Score candidates via vibe matching (if we have a valid centroid)
    if (seedVector) {
        const candidates = (await loadScalarRadioCandidatePool()).filter(
            (candidate) => !excludeSet.has(candidate.id),
        );

        logger.debug(
            `[Radio:multi-seed] Found ${candidates.length} analyzed candidates to score against ${seedTracks.length} seed tracks`,
        );

        const scored = scoreTracksAgainstSeed(
            seedVector,
            [...allTags],
            [...allGenres],
            candidates,
            new Map(),
            applyTrackPreferenceSimilarityBias,
        );

        logger.debug(
            `[Radio:multi-seed] Vibe scoring matched ${scored.length} tracks above threshold`,
        );

        // Apply artist diversity to scored results
        const candidateArtistMap = new Map(
            candidates.map((c) => [c.id, c.album?.artistId ?? ""]),
        );
        const scoredWithArtist = scored.map((s) => ({
            id: s.id,
            score: s.score,
            artistId: candidateArtistMap.get(s.id) ?? "",
        }));

        const strictCap = getRadioArtistCapForLimit(limitNum);
        const relaxedCap = getRelaxedRadioArtistCapForLimit(limitNum);
        const diverseMatches = selectTracksWithArtistDiversity(
            scoredWithArtist,
            limitNum,
            strictCap,
            relaxedCap,
        );
        resultIds = diverseMatches.map((m) => m.id);
    }

    // 5. Fallback chain (if not enough vibe matches)
    if (resultIds.length < limitNum) {
        // Fallback A: Other tracks from seed artists (not already in results)
        const currentExclude = new Set([...excludeSet, ...resultIds]);
        const artistTracks = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                album: { artistId: { in: [...seedArtistIds] } },
                id: { notIn: [...currentExclude] },
            },
            select: { id: true },
            take: limitNum - resultIds.length,
        });
        const newArtistIds = artistTracks.map((t) => t.id);
        resultIds.push(...newArtistIds);
        if (newArtistIds.length > 0) {
            logger.debug(
                `[Radio:multi-seed] Fallback A: added ${newArtistIds.length} tracks from seed artists`,
            );
        }
    }

    if (resultIds.length < limitNum) {
        // Fallback B: Genre-based expansion from seed artist genres
        const seedArtistGenres = new Set<string>();
        for (const t of seedTracks) {
            if (t.album?.artist) {
                for (const g of getMergedGenres(t.album.artist)) {
                    seedArtistGenres.add(g.toLowerCase());
                }
            }
        }

        if (seedArtistGenres.size > 0) {
            const currentExclude = [...excludeSet, ...resultIds];
            const genreKeywords = [...seedArtistGenres].slice(0, 5);
            const genreConditions = genreKeywords.map(
                (g) =>
                    Prisma.sql`EXISTS (
                        SELECT 1 FROM jsonb_array_elements_text("Artist"."genres") AS g
                        WHERE LOWER(g) LIKE ${`%${escapeLikePattern(g)}%`} ESCAPE '\\'
                    )`,
            );
            const genreTracks = await prisma.$queryRaw<{ id: string }[]>`
                SELECT "Track"."id"
                FROM "Track"
                JOIN "Album" ON "Track"."albumId" = "Album"."id"
                JOIN "Artist" ON "Album"."artistId" = "Artist"."id"
                WHERE "Track"."removedAt" IS NULL
                AND "Track"."id" NOT IN (${Prisma.join(currentExclude.length > 0 ? currentExclude : ["__none__"])})
                AND (${Prisma.join(genreConditions, " OR ")})
                ORDER BY RANDOM()
                LIMIT ${limitNum - resultIds.length}
            `;
            const newGenreIds = genreTracks.map((t) => t.id);
            resultIds.push(...newGenreIds);
            if (newGenreIds.length > 0) {
                logger.debug(
                    `[Radio:multi-seed] Fallback B: added ${newGenreIds.length} tracks from genre expansion (${genreKeywords.join(", ")})`,
                );
            }
        }
    }

    if (resultIds.length < limitNum) {
        // Fallback C: Random library fill
        const currentExclude = [...excludeSet, ...resultIds];
        const randomTracks = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                id: { notIn: currentExclude },
            },
            select: { id: true },
            take: (limitNum - resultIds.length) * 3,
        });
        const shuffled = shuffleArray(randomTracks.map((t) => t.id));
        const newRandomIds = shuffled.slice(0, limitNum - resultIds.length);
        resultIds.push(...newRandomIds);
        if (newRandomIds.length > 0) {
            logger.debug(
                `[Radio:multi-seed] Fallback C: added ${newRandomIds.length} random library tracks`,
            );
        }
    }

    const finalPreferenceScores = await buildTrackPreferenceScoreMapForUser(
        userId,
        resultIds,
    );
    if (finalPreferenceScores.size > 0) {
        resultIds = applyTrackPreferenceOrderBias(
            resultIds,
            finalPreferenceScores,
        );
    }

    logger.debug(`[Radio:multi-seed] Final queue: ${resultIds.length} tracks`);

    return { trackIds: resultIds, preserveInputOrder: true };
};
