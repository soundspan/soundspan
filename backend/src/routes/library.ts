import { Router, type Response as ExpressResponse } from "express";
import { requireAdmin, requireAuth, requireAuthOrToken } from "../middleware/auth";
import { imageLimiter, apiLimiter } from "../middleware/rateLimiter";
import { lastFmService } from "../services/lastfm";
import { prisma, Prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import crypto from "crypto";
import path from "path";
import fs from "fs";

// Static imports for performance (avoid dynamic imports in hot paths)
import { config } from "../config";
import { fanartService } from "../services/fanart";
import { deezerService } from "../services/deezer";
import { imageProviderService } from "../services/imageProvider";
import { musicBrainzService } from "../services/musicbrainz";
import { coverArtService } from "../services/coverArt";
import { getSystemSettings } from "../utils/systemSettings";
import {
    AudioStreamingService,
    type Quality as StreamingQuality,
} from "../services/audioStreaming";
import { scanQueue } from "../workers/queues";
import { organizeSingles } from "../workers/organizeSingles";
import { BRAND_USER_AGENT } from "../config/brand";
import { extractColorsFromImage } from "../utils/colorExtractor";
import {
    fetchExternalImage,
    normalizeExternalImageUrl,
} from "../services/imageProxy";
import { downloadAndStoreImage } from "../services/imageStorage";
import { dataCacheService } from "../services/dataCache";
import {
    backfillAllArtistCounts,
    isBackfillNeeded,
    getBackfillProgress,
    isBackfillInProgress,
} from "../services/artistCountsService";
import {
    isImageBackfillNeeded,
    getImageBackfillProgress,
    backfillAllImages,
} from "../services/imageBackfill";
import {
    getMergedGenres,
    getArtistDisplaySummary,
} from "../utils/metadataOverrides";
import {
    getEffectiveYear,
    getDecadeWhereClause,
    getDecadeFromYear,
} from "../utils/dateFilters";
import { shuffleArray } from "../utils/shuffle";
import { separateArtists } from "../utils/separateArtists";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    normalizeTrackPreferenceSignal,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
    type ResolvedTrackPreference,
} from "../services/trackPreference";
import {
    sendInternalRouteError,
    sendRouteError,
} from "./routeErrorResponse";

const router = Router();

const ARTIST_SORT_MAP: Record<string, any> = {
    "name": { name: "asc" as const },
    "name-desc": { name: "desc" as const },
    "tracks": { totalTrackCount: "desc" as const },
};

const ALBUM_SORT_MAP: Record<string, any> = {
    "name": { title: "asc" as const },
    "name-desc": { title: "desc" as const },
    "recent": { year: "desc" as const },
};

const TRACK_SORT_MAP: Record<string, any> = {
    "name": { title: "asc" as const },
    "name-desc": { title: "desc" as const },
};

// Maximum items per request to prevent DoS attacks while supporting large libraries
const MAX_LIMIT = 10000;
const DEFAULT_MY_LIKED_LIMIT = 100;
const MY_LIKED_PLAYLIST_ID = "my-liked";
const MY_LIKED_PLAYLIST_NAME = "My Liked";
const MY_LIKED_PLAYLIST_DESCRIPTION = "All your thumbs-up tracks";
const ALBUM_COVER_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
const COVER_ART_IMAGE_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const COVER_ART_IMAGE_CACHE_CONTROL = `public, max-age=${COVER_ART_IMAGE_CACHE_TTL_SECONDS}, immutable`;
const RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX = "2.1b6-enhanced-v3";
const AUDIO_INFO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const AUDIO_INFO_CACHE_MAX_ENTRIES = 2000;
const NATIVE_COVER_HEAL_TIMEOUT_MS = 5000;

const nativeCoverHealInFlight = new Map<string, Promise<string | null>>();

interface AudioInfoResponsePayload {
    codec: string | null;
    bitrate: number | null;
    sampleRate: number | null;
    bitDepth: number | null;
    lossless: boolean | null;
    channels: number | null;
}

interface AudioInfoCacheEntry {
    expiresAt: number;
    payload: AudioInfoResponsePayload;
}

const audioInfoCache = new Map<string, AudioInfoCacheEntry>();

const buildAudioInfoCacheKey = (
    trackId: string,
    filePath: string,
    fileModified?: Date | null,
    options: {
        scope?: "source" | "playback";
        quality?: StreamingQuality | null;
    } = {}
): string => {
    const modifiedToken =
        fileModified instanceof Date ? fileModified.toISOString() : "unknown";
    const scope = options.scope ?? "source";
    const quality = options.quality ?? "na";
    return `${trackId}:${scope}:${quality}:${filePath}:${modifiedToken}`;
};

const pruneAudioInfoCache = (now: number) => {
    for (const [key, entry] of audioInfoCache.entries()) {
        if (entry.expiresAt <= now) {
            audioInfoCache.delete(key);
        }
    }

    while (audioInfoCache.size > AUDIO_INFO_CACHE_MAX_ENTRIES) {
        const oldestKey = audioInfoCache.keys().next().value as
            | string
            | undefined;
        if (!oldestKey) break;
        audioInfoCache.delete(oldestKey);
    }
};

const normalizeStreamingQuality = (
    value: unknown,
): StreamingQuality | null => {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (
        normalized === "original" ||
        normalized === "high" ||
        normalized === "medium" ||
        normalized === "low"
    ) {
        return normalized;
    }
    return null;
};

const resolveAudioInfoAbsolutePath = (relativeFilePath: string): string =>
    path.join(config.music.musicPath, relativeFilePath.replace(/\\/g, "/"));

const readAudioInfoPayload = async (
    absolutePath: string
): Promise<AudioInfoResponsePayload> => {
    const { parseFile } = await import("music-metadata");
    const metadata = await parseFile(absolutePath, {
        duration: false,
        skipCovers: true,
    });
    const fmt = metadata.format;

    return {
        codec: fmt.codec || null,
        bitrate: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null, // kbps
        sampleRate: fmt.sampleRate || null, // Hz
        bitDepth: fmt.bitsPerSample || null, // e.g. 16, 24
        lossless: fmt.lossless ?? null,
        channels: fmt.numberOfChannels || null,
    };
};

const hasReliableEnhancedAnalysis = (
    analysisMode: string | null | undefined,
    analysisVersion: string | null | undefined
): boolean =>
    analysisMode === "enhanced" &&
    typeof analysisVersion === "string" &&
    analysisVersion.startsWith(RELIABLE_ENHANCED_ANALYSIS_VERSION_PREFIX);

const parseBooleanQueryParam = (
    value: unknown,
    defaultValue = true
): boolean => {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (
            normalized === "true" ||
            normalized === "1" ||
            normalized === "yes" ||
            normalized === "on"
        ) {
            return true;
        }
        if (
            normalized === "false" ||
            normalized === "0" ||
            normalized === "no" ||
            normalized === "off"
        ) {
            return false;
        }
    }

    return defaultValue;
};

const formatTrackPreferenceResponse = (
    trackId: string,
    preference: ResolvedTrackPreference
) => ({
    trackId,
    signal: preference.signal,
    state: preference.state,
    score: preference.score,
    likedAt: preference.likedAt ? preference.likedAt.toISOString() : null,
    dislikedAt: preference.dislikedAt ? preference.dislikedAt.toISOString() : null,
    updatedAt: preference.updatedAt ? preference.updatedAt.toISOString() : null,
});

type NormalizedTrackPreferenceSignal = Exclude<
    ReturnType<typeof normalizeTrackPreferenceSignal>,
    null
>;

const formatAlbumPreferenceResponse = (
    albumId: string,
    trackCount: number,
    preference: ResolvedTrackPreference
) => ({
    albumId,
    trackCount,
    signal: preference.signal,
    state: preference.state,
    score: preference.score,
    likedAt: preference.likedAt ? preference.likedAt.toISOString() : null,
    dislikedAt: preference.dislikedAt ? preference.dislikedAt.toISOString() : null,
    updatedAt: preference.updatedAt ? preference.updatedAt.toISOString() : null,
});

const applyTrackPreferenceSignalToTrackIds = async (
    tx: {
        likedTrack: {
            deleteMany: typeof prisma.likedTrack.deleteMany;
            createMany: typeof prisma.likedTrack.createMany;
        };
        dislikedEntity: {
            deleteMany: typeof prisma.dislikedEntity.deleteMany;
            createMany: typeof prisma.dislikedEntity.createMany;
        };
    },
    userId: string,
    trackIds: string[],
    signal: NormalizedTrackPreferenceSignal,
    now: Date
) => {
    if (trackIds.length === 0) {
        return;
    }

    if (signal === "thumbs_up") {
        await tx.dislikedEntity.deleteMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: trackIds },
            },
        });
        await tx.likedTrack.deleteMany({
            where: {
                userId,
                trackId: { in: trackIds },
            },
        });
        await tx.likedTrack.createMany({
            data: trackIds.map((trackId) => ({
                userId,
                trackId,
                likedAt: now,
            })),
            skipDuplicates: true,
        });
        return;
    }

    if (signal === "thumbs_down") {
        await tx.likedTrack.deleteMany({
            where: {
                userId,
                trackId: { in: trackIds },
            },
        });
        await tx.dislikedEntity.deleteMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: { in: trackIds },
            },
        });
        await tx.dislikedEntity.createMany({
            data: trackIds.map((trackId) => ({
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: trackId,
                dislikedAt: now,
            })),
            skipDuplicates: true,
        });
        return;
    }

    await tx.likedTrack.deleteMany({
        where: {
            userId,
            trackId: { in: trackIds },
        },
    });
    await tx.dislikedEntity.deleteMany({
        where: {
            userId,
            entityType: TRACK_DISLIKE_ENTITY_TYPE,
            entityId: { in: trackIds },
        },
    });
};

const buildTrackPreferenceScoreMapForUser = async (
    userId: string | undefined,
    trackIds: string[]
): Promise<Map<string, number>> => {
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
        const preference = resolveTrackPreference({
            likedAt: likedByTrackId.get(trackId) ?? null,
            dislikedAt: dislikedByTrackId.get(trackId) ?? null,
        });
        if (preference.score !== 0) {
            scoreMap.set(trackId, preference.score);
        }
    }

    return scoreMap;
};

const getRadioArtistCapForLimit = (limit: number): number => {
    if (!Number.isFinite(limit) || limit <= 0) return 2;
    return Math.max(2, Math.floor(limit / 12));
};

const getRelaxedRadioArtistCapForLimit = (limit: number): number => {
    const strictCap = getRadioArtistCapForLimit(limit);
    return Math.max(strictCap + 1, Math.ceil(limit / 6));
};

const selectTracksWithArtistDiversity = <
    T extends { id: string; artistId: string },
>(
    tracks: T[],
    targetCount: number,
    strictCap: number,
    relaxedCap: number
): T[] => {
    if (!Array.isArray(tracks) || targetCount <= 0) {
        return [];
    }

    const selected: T[] = [];
    const deferred: T[] = [];
    const artistCounts = new Map<string, number>();

    const trySelect = (track: T, cap: number): boolean => {
        const artistKey =
            typeof track.artistId === "string" && track.artistId.length > 0 ?
                track.artistId
            :   `unknown:${track.id}`;
        const count = artistCounts.get(artistKey) ?? 0;

        if (count >= cap) {
            return false;
        }

        artistCounts.set(artistKey, count + 1);
        selected.push(track);
        return true;
    };

    for (const track of tracks) {
        if (selected.length >= targetCount) break;
        if (!trySelect(track, strictCap)) {
            deferred.push(track);
        }
    }

    if (selected.length < targetCount) {
        for (const track of deferred) {
            if (selected.length >= targetCount) break;
            trySelect(track, relaxedCap);
        }
    }

    if (selected.length < targetCount) {
        for (const track of deferred) {
            if (selected.length >= targetCount) break;
            selected.push(track);
        }
    }

    return selected.slice(0, targetCount);
};

const applyCoverArtCorsHeaders = (res: ExpressResponse, origin?: string) => {
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
};

const getAlbumIdFromNativeCoverPath = (nativePath: string): string | null => {
    const parsed = path.parse(nativePath);
    return parsed.name || null;
};

const getNativeCoverCachePath = (nativePath: string): string =>
    path.join(config.music.transcodeCachePath, "../covers", nativePath);

const getNativeCoverPathCandidates = (nativePath: string): string[] => {
    const trimmedNativePath = nativePath.replace(/^\/+/, "").trim();
    const candidates = new Set<string>();

    if (trimmedNativePath.length > 0) {
        candidates.add(trimmedNativePath);
        if (!trimmedNativePath.startsWith("albums/")) {
            candidates.add(`albums/${trimmedNativePath}`);
        }
    }

    return Array.from(candidates);
};

const resolveNativeCoverCacheHit = (
    nativePath: string
): { resolvedNativePath: string; cachePath: string } | null => {
    const candidates = getNativeCoverPathCandidates(nativePath);
    for (const candidate of candidates) {
        const candidateCachePath = getNativeCoverCachePath(candidate);
        if (fs.existsSync(candidateCachePath)) {
            return {
                resolvedNativePath: candidate,
                cachePath: candidateCachePath,
            };
        }
    }
    return null;
};

const buildNativeCoverProxyRedirectPath = (nativeCoverUrl: string): string =>
    `/api/library/cover-art?url=${encodeURIComponent(nativeCoverUrl)}`;

const persistHealedAlbumCover = async (
    albumId: string,
    coverUrl: string
): Promise<void> => {
    await prisma.album.update({
        where: { id: albumId },
        data: { coverUrl },
    });

    try {
        await redisClient.setEx(
            `album-cover:${albumId}`,
            ALBUM_COVER_CACHE_TTL_SECONDS,
            coverUrl
        );
    } catch (cacheError) {
        logger.warn(
            `[COVER-ART] Failed to refresh album cover cache for ${albumId}:`,
            cacheError
        );
    }
};

const tryHealMissingNativeAlbumCover = async (
    nativePath: string
): Promise<string | null> => {
    const albumId = getAlbumIdFromNativeCoverPath(nativePath);
    if (!albumId) return null;

    const inFlight = nativeCoverHealInFlight.get(albumId);
    if (inFlight) {
        return inFlight;
    }

    const healPromise = (async (): Promise<string | null> => {
        const album = await prisma.album.findUnique({
            where: { id: albumId },
            select: {
                id: true,
                title: true,
                rgMbid: true,
                coverUrl: true,
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        if (!album || !album.artist) {
            return null;
        }

        const existingNativeCover = album.coverUrl;
        if (
            typeof existingNativeCover === "string" &&
            existingNativeCover.startsWith("native:")
        ) {
            const existingNativePath = existingNativeCover.replace("native:", "");
            const nativeCacheHit = resolveNativeCoverCacheHit(existingNativePath);
            if (nativeCacheHit) {
                const canonicalNativeCoverUrl =
                    `native:${nativeCacheHit.resolvedNativePath}`;
                if (canonicalNativeCoverUrl !== existingNativeCover) {
                    await persistHealedAlbumCover(album.id, canonicalNativeCoverUrl);
                }
                return buildNativeCoverProxyRedirectPath(
                    canonicalNativeCoverUrl
                );
            }
        }

        const candidateUrls = new Set<string>();
        const addCandidateUrl = (candidate: string | null | undefined) => {
            if (!candidate) return;
            const normalized = normalizeExternalImageUrl(candidate);
            if (normalized) {
                candidateUrls.add(normalized);
            }
        };

        if (
            typeof album.coverUrl === "string" &&
            (album.coverUrl.startsWith("http://") ||
                album.coverUrl.startsWith("https://"))
        ) {
            addCandidateUrl(album.coverUrl);
        }

        const validRgMbid =
            typeof album.rgMbid === "string" &&
            album.rgMbid.length > 0 &&
            !album.rgMbid.startsWith("temp-")
                ? album.rgMbid
                : null;

        if (validRgMbid) {
            try {
                const coverArtArchiveCover =
                    await coverArtService.getCoverArt(validRgMbid);
                addCandidateUrl(coverArtArchiveCover);
            } catch (error) {
                logger.warn(
                    `[COVER-ART] Cover Art Archive recovery failed for ${validRgMbid}:`,
                    error
                );
            }
        }

        try {
            const providerCover = await imageProviderService.getAlbumCover(
                album.artist.name,
                album.title,
                validRgMbid ?? undefined,
                { timeout: NATIVE_COVER_HEAL_TIMEOUT_MS }
            );
            addCandidateUrl(providerCover?.url);
        } catch (error) {
            logger.warn(
                `[COVER-ART] Provider-chain recovery failed for ${album.artist.name} - ${album.title}:`,
                error
            );
        }

        try {
            const deezerCover = await deezerService.getAlbumCover(
                album.artist.name,
                album.title
            );
            addCandidateUrl(deezerCover);
        } catch (error) {
            logger.warn(
                `[COVER-ART] Deezer recovery failed for ${album.artist.name} - ${album.title}:`,
                error
            );
        }

        const orderedCandidateUrls = Array.from(candidateUrls);
        for (const candidateUrl of orderedCandidateUrls) {
            const localCoverPath = await downloadAndStoreImage(
                candidateUrl,
                album.id,
                "album"
            );

            if (!localCoverPath) {
                continue;
            }

            await persistHealedAlbumCover(album.id, localCoverPath);
            return buildNativeCoverProxyRedirectPath(localCoverPath);
        }

        const fallbackExternalUrl = orderedCandidateUrls[0];
        if (fallbackExternalUrl) {
            await persistHealedAlbumCover(album.id, fallbackExternalUrl);
            return fallbackExternalUrl;
        }

        return null;
    })()
        .finally(() => {
            nativeCoverHealInFlight.delete(albumId);
        });

    nativeCoverHealInFlight.set(albumId, healPromise);
    return healPromise;
};

const isLibraryDeletionEnabled = async (): Promise<boolean> => {
    const settings = await getSystemSettings();
    return settings?.libraryDeletionEnabled !== false;
};

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

// Apply API rate limiter to routes that need it
// Skip rate limiting for high-traffic endpoints (cover-art, streaming)
router.use((req, res, next) => {
    // Skip rate limiting for cover-art endpoint (handled by imageLimiter separately)
    if (req.path.startsWith("/cover-art")) {
        return next();
    }
    // Skip rate limiting for streaming endpoints - audio must not be interrupted
    if (req.path.includes("/stream")) {
        return next();
    }
    // Apply API rate limiter to all other routes
    return apiLimiter(req, res, next);
});

/**
 * @openapi
 * /api/library/delete-policy:
 *   get:
 *     summary: Get library deletion policy for the current user
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Deletion policy details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isAdmin:
 *                   type: boolean
 *                 libraryDeletionEnabled:
 *                   type: boolean
 *                 canDelete:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
// GET /library/delete-policy - Determine whether current user can delete library content
router.get("/delete-policy", async (req, res) => {
    try {
        const isAdmin = req.user?.role === "admin";
        if (!isAdmin) {
            return res.json({
                isAdmin: false,
                libraryDeletionEnabled: false,
                canDelete: false,
            });
        }

        const libraryDeletionEnabled = await isLibraryDeletionEnabled();

        return res.json({
            isAdmin: true,
            libraryDeletionEnabled,
            canDelete: libraryDeletionEnabled,
        });
    } catch (error) {
        logger.error("Get library delete policy error:", error);
        return sendInternalRouteError(res, "Failed to determine delete policy");
    }
});

/**
 * @openapi
 * /library/scan:
 *   post:
 *     summary: Start a library scan job
 *     description: Initiates a background job to scan the music directory and index all audio files
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library scan started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Library scan started"
 *                 jobId:
 *                   type: string
 *                   description: Job ID to track progress
 *                   example: "123"
 *                 musicPath:
 *                   type: string
 *                   example: "/path/to/music"
 *       500:
 *         description: Failed to start scan
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/scan", async (req, res) => {
    try {
        if (!config.music.musicPath) {
            return res.status(500).json({
                error: "Music path not configured. Please set MUSIC_PATH environment variable.",
            });
        }

        // First, organize any SLSKD downloads from Docker container to music library
        // This ensures files are moved before the scan finds them
        try {
            const { organizeSingles } = await import(
                "../workers/organizeSingles"
            );
            logger.info("[Scan] Organizing SLSKD downloads before scan...");
            await organizeSingles();
            logger.info("[Scan] SLSKD organization complete");
        } catch (err: any) {
            // Not a fatal error - SLSKD might not be running or have no files
            logger.info("[Scan] SLSKD organization skipped:", err.message);
        }

        const userId = req.user?.id || "system";

        // Add scan job to queue
        const job = await scanQueue.add("scan", {
            userId,
            musicPath: config.music.musicPath,
        });

        res.json({
            message: "Library scan started",
            jobId: job.id,
            musicPath: config.music.musicPath,
        });
    } catch (error) {
        logger.error("Scan trigger error:", error);
        sendInternalRouteError(res, "Failed to start scan");
    }
});

/**
 * @openapi
 * /api/library/scan/status/{jobId}:
 *   get:
 *     summary: Check the status of a library scan job
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The scan job ID returned from POST /scan
 *     responses:
 *       200:
 *         description: Scan job status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 progress:
 *                   type: object
 *                 result:
 *                   type: object
 *       404:
 *         description: Job not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/scan/status/:jobId - Check scan job status
router.get("/scan/status/:jobId", async (req, res) => {
    try {
        const job = await scanQueue.getJob(req.params.jobId);

        if (!job) {
            return sendRouteError(res, 404, "Job not found");
        }

        const state = await job.getState();
        const progress = job.progress();
        const result = job.returnvalue;

        res.json({
            status: state,
            progress,
            result,
        });
    } catch (error) {
        logger.error("Get scan status error:", error);
        sendInternalRouteError(res, "Failed to get job status");
    }
});

/**
 * @openapi
 * /api/library/organize:
 *   post:
 *     summary: Manually trigger file organization script
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Organization started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       401:
 *         description: Not authenticated
 */
// POST /library/organize - Manually trigger organization script
router.post("/organize", async (req, res) => {
    try {
        // Run in background
        organizeSingles().catch((err) => {
            logger.error("Manual organization failed:", err);
        });

        res.json({ message: "Organization started in background" });
    } catch (error) {
        logger.error("Organization trigger error:", error);
        sendInternalRouteError(res, "Failed to start organization");
    }
});

/**
 * @openapi
 * /api/library/recently-listened:
 *   get:
 *     summary: Get recently listened artists, audiobooks, and podcasts
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of items to return
 *     responses:
 *       200:
 *         description: Recently listened items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 */
// GET /library/recently-listened?limit=10
router.get("/recently-listened", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const userId = req.user!.id;
        const limitNum = parseInt(limit as string, 10);

        const [recentPlays, inProgressAudiobooks, inProgressPodcasts] =
            await Promise.all([
                prisma.play.findMany({
                    where: {
                        userId,
                        // Exclude pure discovery plays (only show library and kept discovery)
                        source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
                        // Also filter by album location to exclude discovery albums
                        track: {
                            album: {
                                location: "LIBRARY",
                            },
                        },
                    },
                    orderBy: { playedAt: "desc" },
                    take: limitNum * 3, // Get more than needed to account for duplicates
                    include: {
                        track: {
                            include: {
                                album: {
                                    include: {
                                        artist: {
                                            select: {
                                                id: true,
                                                mbid: true,
                                                name: true,
                                                heroUrl: true,
                                                userHeroUrl: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                }),
                prisma.audiobookProgress.findMany({
                    where: {
                        userId,
                        isFinished: false,
                        currentTime: { gt: 0 }, // Only show if actually started
                    },
                    orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                    take: Math.ceil(limitNum / 3), // Get up to 1/3 for audiobooks
                }),
                prisma.podcastProgress.findMany({
                    where: {
                        userId,
                        isFinished: false,
                        currentTime: { gt: 0 }, // Only show if actually started
                    },
                    orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                    take: limitNum * 2, // Get extra to account for deduplication
                    include: {
                        episode: {
                            include: {
                                podcast: {
                                    select: {
                                        id: true,
                                        title: true,
                                        author: true,
                                        imageUrl: true,
                                    },
                                },
                            },
                        },
                    },
                }),
            ]);

        // Deduplicate podcasts - keep only the most recently played episode per podcast
        const seenPodcasts = new Set();
        const uniquePodcasts = inProgressPodcasts
            .filter((pp) => {
                const podcastId = pp.episode.podcast.id;
                if (seenPodcasts.has(podcastId)) {
                    return false;
                }
                seenPodcasts.add(podcastId);
                return true;
            })
            .slice(0, Math.ceil(limitNum / 3)); // Limit to 1/3 after deduplication

        // Extract unique artists and audiobooks
        const items: any[] = [];
        const artistsMap = new Map();

        // Add music artists
        for (const play of recentPlays) {
            const artist = play.track.album.artist;
            if (!artistsMap.has(artist.id)) {
                artistsMap.set(artist.id, {
                    ...artist,
                    type: "artist",
                    lastPlayedAt: play.playedAt,
                });
            }
            if (items.length >= limitNum) break;
        }

        // Combine artists, audiobooks, and podcasts
        const combined = [
            ...Array.from(artistsMap.values()),
            ...inProgressAudiobooks.map((ab: any) => {
                // For audiobooks, prefix the path with 'audiobook__' so the frontend knows to use the audiobook endpoint
                const coverArt =
                    ab.coverUrl && !ab.coverUrl.startsWith("http")
                        ? `audiobook__${ab.coverUrl}`
                        : ab.coverUrl;

                return {
                    id: ab.audiobookshelfId,
                    name: ab.title,
                    coverArt,
                    type: "audiobook",
                    author: ab.author,
                    progress:
                        ab.duration > 0
                            ? Math.round((ab.currentTime / ab.duration) * 100)
                            : 0,
                    lastPlayedAt: ab.lastPlayedAt,
                };
            }),
            ...uniquePodcasts.map((pp: any) => ({
                id: pp.episode.podcast.id,
                episodeId: pp.episodeId,
                name: pp.episode.podcast.title,
                coverArt: pp.episode.podcast.imageUrl,
                type: "podcast",
                author: pp.episode.podcast.author,
                progress:
                    pp.duration > 0
                        ? Math.round((pp.currentTime / pp.duration) * 100)
                        : 0,
                lastPlayedAt: pp.lastPlayedAt,
            })),
        ];

        // Sort by lastPlayedAt and limit
        combined.sort(
            (a, b) =>
                new Date(b.lastPlayedAt).getTime() -
                new Date(a.lastPlayedAt).getTime()
        );
        const limitedItems = combined.slice(0, limitNum);

        // Get album counts for artists
        const artistIds = limitedItems
            .filter((item) => item.type === "artist")
            .map((item) => item.id);
        const albumCounts = await prisma.ownedAlbum.groupBy({
            by: ["artistId"],
            where: { artistId: { in: artistIds } },
            _count: { rgMbid: true },
        });
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.rgMbid])
        );

        // Map results - no on-demand image fetching for performance
        // Artists without images will show placeholders until enrichment completes
        const results = limitedItems.map((item) => {
            if (item.type === "audiobook" || item.type === "podcast") {
                return item;
            } else {
                // Use override pattern: userHeroUrl ?? heroUrl
                const coverArt = item.userHeroUrl ?? item.heroUrl ?? null;
                return {
                    ...item,
                    coverArt,
                    albumCount: albumCountMap.get(item.id) || 0,
                };
            }
        });

        res.json({ items: results });
    } catch (error) {
        logger.error("Get recently listened error:", error);
        sendInternalRouteError(res, "Failed to fetch recently listened");
    }
});

/**
 * @openapi
 * /api/library/recently-added:
 *   get:
 *     summary: Get recently added artists to the library
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of artists to return
 *     responses:
 *       200:
 *         description: Recently added artists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 */
// GET /library/recently-added?limit=10
router.get("/recently-added", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const limitNum = parseInt(limit as string, 10);

        // Get the 20 most recently added LIBRARY albums (by lastSynced timestamp)
        // This limits "Recently Added" to actual recent additions, not the entire library
        const recentAlbums = await prisma.album.findMany({
            where: {
                location: "LIBRARY",
                tracks: { some: {} }, // Only albums with actual tracks
            },
            orderBy: { lastSynced: "desc" },
            take: 20, // Hard limit to last 20 albums
            include: {
                artist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        userHeroUrl: true,
                    },
                },
            },
        });

        // Extract unique artists from recent albums (preserving order of most recent)
        const artistsMap = new Map();
        for (const album of recentAlbums) {
            if (!artistsMap.has(album.artist.id)) {
                artistsMap.set(album.artist.id, album.artist);
            }
            if (artistsMap.size >= limitNum) break;
        }

        // Get album counts for each artist (only LIBRARY albums)
        const artistIds = Array.from(artistsMap.keys());
        const albumCounts = await prisma.album.groupBy({
            by: ["artistId"],
            where: {
                artistId: { in: artistIds },
                location: "LIBRARY",
                tracks: { some: {} },
            },
            _count: { id: true },
        });
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.id])
        );

        // Map results - no on-demand image fetching for performance
        // Artists without images will show placeholders until enrichment completes
        const artistsWithImages = Array.from(artistsMap.values()).map((artist) => {
            // Use override pattern: userHeroUrl ?? heroUrl
            const coverArt = artist.userHeroUrl ?? artist.heroUrl ?? null;
            return {
                ...artist,
                coverArt,
                albumCount: albumCountMap.get(artist.id) || 0,
            };
        });

        res.json({ artists: artistsWithImages });
    } catch (error) {
        logger.error("Get recently added error:", error);
        sendInternalRouteError(res, "Failed to fetch recently added");
    }
});

/**
 * @openapi
 * /api/library/artists:
 *   get:
 *     summary: List artists in the library with pagination and filtering
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *         description: Search filter by artist name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of artists to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [owned, discovery, all]
 *           default: owned
 *         description: Filter by ownership type
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor ID for cursor-based pagination
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [name, name-desc, tracks]
 *           default: name
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Paginated list of artists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *       401:
 *         description: Not authenticated
 */
// GET /library/artists?query=&limit=&offset=&filter=owned|discovery|all&cursor=
// Optimized with denormalized counts for O(1) filtering
router.get("/artists", async (req, res) => {
    try {
        const {
            query = "",
            limit: limitParam = "50",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
            cursor, // Optional cursor for cursor-based pagination
            sortBy = "name",
        } = req.query;

        const limit = Math.min(
            parseInt(limitParam as string, 10) || 50,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        const orderBy = ARTIST_SORT_MAP[sortBy as string] ?? { name: "asc" as const };

        // Check whether denormalized counts have been backfilled.
        // If no artist has a non-null countsLastUpdated, the counts are stale
        // (e.g. fresh DB after first scan before backfill finishes) and we
        // must fall back to JOIN-based filtering to avoid returning 0 results.
        const countsReady = (await prisma.artist.count({
            where: { countsLastUpdated: { not: null } },
        })) > 0;

        // Build WHERE clause
        let where: any = {};

        if (countsReady) {
            // Fast path: use denormalized counts (indexed lookup)
            if (filter === "owned") {
                where.OR = [
                    { libraryAlbumCount: { gt: 0 } },
                    { ownedAlbums: { some: {} } },
                ];
            } else if (filter === "discovery") {
                where.discoveryAlbumCount = { gt: 0 };
                where.libraryAlbumCount = 0;
            } else {
                where.OR = [
                    { libraryAlbumCount: { gt: 0 } },
                    { discoveryAlbumCount: { gt: 0 } },
                ];
            }
        } else {
            // Fallback: counts not yet backfilled — use JOINs
            if (filter === "owned") {
                where.OR = [
                    { albums: { some: { location: "LIBRARY", tracks: { some: {} } } } },
                    { ownedAlbums: { some: {} } },
                ];
            } else if (filter === "discovery") {
                where.albums = { some: { location: "DISCOVER", tracks: { some: {} } } };
                where.NOT = { albums: { some: { location: "LIBRARY", tracks: { some: {} } } } };
            } else {
                where.albums = { some: { tracks: { some: {} } } };
            }
        }

        // Add search query if provided
        if (query) {
            where.name = { contains: query as string, mode: "insensitive" };
        }

        // Execute queries with timeout to prevent cascade failures
        const [artists, total] = await prisma.$transaction(
            async (tx) => {
                // Build findMany args - cursor or offset pagination
                const findManyArgs: Parameters<typeof tx.artist.findMany>[0] = {
                    where,
                    take: limit,
                    orderBy,
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        userHeroUrl: true,
                        libraryAlbumCount: true,
                        discoveryAlbumCount: true,
                        totalTrackCount: true,
                    },
                };

                // Use cursor-based pagination if cursor provided, otherwise offset
                if (cursor) {
                    findManyArgs.cursor = { id: cursor as string };
                    findManyArgs.skip = 1;
                } else {
                    findManyArgs.skip = offset;
                }

                return Promise.all([
                    tx.artist.findMany(findManyArgs),
                    tx.artist.count({ where }),
                ]);
            },
            { timeout: 30000 } // 30 second timeout as safety net
        );

        // Use DataCacheService for batch image lookup (DB + Redis, no API calls for lists)
        const imageMap = await dataCacheService.getArtistImagesBatch(
            artists.map((a) => ({
                id: a.id,
                heroUrl: a.heroUrl,
                userHeroUrl: a.userHeroUrl,
            }))
        );

        const artistsWithImages = artists.map((artist) => {
            const coverArt =
                imageMap.get(artist.id) || artist.heroUrl || null;

            // Use denormalized counts when ready, otherwise show raw sum
            const albumCount = countsReady
                ? (filter === "discovery"
                    ? artist.discoveryAlbumCount
                    : filter === "all"
                      ? artist.libraryAlbumCount + artist.discoveryAlbumCount
                      : artist.libraryAlbumCount)
                : artist.libraryAlbumCount + artist.discoveryAlbumCount;

            return {
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
                heroUrl: coverArt,
                coverArt, // Alias for frontend consistency
                albumCount,
                trackCount: artist.totalTrackCount,
            };
        });

        // Include cursor for next page (last artist ID)
        const nextCursor =
            artists.length === limit ? artists[artists.length - 1].id : null;

        res.json({
            artists: artistsWithImages,
            total,
            offset,
            limit,
            nextCursor, // For cursor-based pagination
        });
    } catch (error: any) {
        logger.error("[Library] Get artists error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch artists",
            details: error?.message,
        });
    }
});

/**
 * @openapi
 * /api/library/artist-counts/status:
 *   get:
 *     summary: Check artist counts backfill status
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Backfill status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 needsBackfill:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
// GET /library/artist-counts/status - Check artist counts backfill status
router.get("/artist-counts/status", async (req, res) => {
    try {
        const [needsBackfill, progress] = await Promise.all([
            isBackfillNeeded(),
            getBackfillProgress(),
        ]);

        res.json({
            needsBackfill,
            ...progress,
        });
    } catch (error: any) {
        logger.error("[ArtistCounts] Status check error:", error?.message);
        sendInternalRouteError(res, "Failed to check status");
    }
});

/**
 * @openapi
 * /api/library/artist-counts/backfill:
 *   post:
 *     summary: Trigger artist counts backfill
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Backfill started or already in progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 status:
 *                   type: string
 *       401:
 *         description: Not authenticated
 */
// POST /library/artist-counts/backfill - Trigger artist counts backfill
router.post("/artist-counts/backfill", async (req, res) => {
    try {
        if (isBackfillInProgress()) {
            return res.json({
                message: "Backfill already in progress",
                status: "processing",
            });
        }

        // Return immediately, run backfill in background
        res.json({ message: "Backfill started", status: "processing" });

        // Run backfill (non-blocking)
        backfillAllArtistCounts((processed, total) => {
            if (processed % 100 === 0) {
                logger.debug(`[ArtistCounts] Progress: ${processed}/${total}`);
            }
        }).catch((error) => {
            logger.error("[ArtistCounts] Backfill failed:", error);
        });
    } catch (error: any) {
        logger.error("[ArtistCounts] Backfill trigger error:", error?.message);
        sendInternalRouteError(res, "Failed to start backfill");
    }
});

/**
 * @openapi
 * /api/library/image-backfill/status:
 *   get:
 *     summary: Check image backfill status
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Image backfill status and progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Not authenticated
 */
// GET /library/image-backfill/status - Check image backfill status
router.get("/image-backfill/status", async (req, res) => {
    try {
        const [status, progress] = await Promise.all([
            isImageBackfillNeeded(),
            getImageBackfillProgress(),
        ]);

        res.json({
            ...status,
            ...progress,
        });
    } catch (error: any) {
        logger.error("[ImageBackfill] Status check error:", error?.message);
        sendInternalRouteError(res, "Failed to check status");
    }
});

/**
 * @openapi
 * /api/library/image-backfill/start:
 *   post:
 *     summary: Trigger image backfill for artists and albums
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Image backfill started or already in progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 status:
 *                   type: string
 *       401:
 *         description: Not authenticated
 */
// POST /library/image-backfill/start - Trigger image backfill
router.post("/image-backfill/start", async (req, res) => {
    try {
        const progress = getImageBackfillProgress();
        if (progress.inProgress) {
            return res.json({
                message: "Image backfill already in progress",
                status: "processing",
                progress,
            });
        }

        // Return immediately, run backfill in background
        res.json({ message: "Image backfill started", status: "processing" });

        // Run backfill (non-blocking)
        backfillAllImages().catch((error) => {
            logger.error("[ImageBackfill] Backfill failed:", error);
        });
    } catch (error: any) {
        logger.error("[ImageBackfill] Backfill trigger error:", error?.message);
        sendInternalRouteError(res, "Failed to start image backfill");
    }
});

/**
 * @openapi
 * /api/library/backfill-genres:
 *   post:
 *     summary: Backfill genres for artists missing genre data
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Genre backfill result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 count:
 *                   type: integer
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Not authenticated
 */
// POST /library/backfill-genres - Backfill genres for artists missing them
router.post("/backfill-genres", async (req, res) => {
    try {
        // Find artists that have been enriched but have no genres
        const artistsToBackfill = await prisma.artist.findMany({
            where: {
                enrichmentStatus: "completed",
                OR: [
                    { genres: { equals: Prisma.DbNull } },
                    { genres: { equals: [] } },
                ],
            },
            select: { id: true, name: true, mbid: true },
            take: 50, // Process in batches
        });

        if (artistsToBackfill.length === 0) {
            return res.json({
                message: "No artists need genre backfill",
                count: 0,
            });
        }

        // Reset these artists to pending so enrichment worker re-processes them
        const result = await prisma.artist.updateMany({
            where: {
                id: { in: artistsToBackfill.map((a) => a.id) },
            },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });

        logger.info(
            `[Backfill] Reset ${result.count} artists for genre enrichment`
        );

        res.json({
            message: `Reset ${result.count} artists for genre enrichment`,
            count: result.count,
            artists: artistsToBackfill.map((a) => a.name).slice(0, 10),
        });
    } catch (error: any) {
        logger.error("[Backfill] Genre backfill error:", error?.message);
        sendInternalRouteError(res, "Failed to backfill genres");
    }
});

/**
 * @openapi
 * /api/library/artists/{id}:
 *   get:
 *     summary: Get detailed artist information including discography and similar artists
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Artist ID, name, or MusicBrainz ID
 *       - in: query
 *         name: includeDiscography
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include full discography from MusicBrainz
 *       - in: query
 *         name: includeTopTracks
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include top tracks from Last.fm
 *       - in: query
 *         name: includeSimilarArtists
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include similar artists
 *     responses:
 *       200:
 *         description: Artist details with albums, top tracks, and similar artists
 *       404:
 *         description: Artist not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/artists/:id
router.get("/artists/:id", async (req, res) => {
    try {
        const idParam = req.params.id;
        const includeDiscography = parseBooleanQueryParam(
            req.query.includeDiscography,
            true
        );
        const includeTopTracks = parseBooleanQueryParam(
            req.query.includeTopTracks,
            true
        );
        const includeSimilarArtists = parseBooleanQueryParam(
            req.query.includeSimilarArtists,
            true
        );
        const shouldResolveMbid =
            includeDiscography || includeTopTracks || includeSimilarArtists;

        const artistInclude = {
            albums: {
                orderBy: { year: Prisma.SortOrder.desc },
                include: {
                    tracks: {
                        orderBy: [
                            { discNo: Prisma.SortOrder.asc },
                            { trackNo: Prisma.SortOrder.asc },
                        ],
                        take: 10, // Top tracks
                        include: {
                            album: {
                                select: {
                                    id: true,
                                    title: true,
                                    coverUrl: true,
                                },
                            },
                        },
                    },
                },
            },
            ownedAlbums: true,
            // Note: similarFrom (FK-based) is no longer used for display
            // We now use similarArtistsJson which is fetched by default
        };

        // Single query with OR to find artist by ID, name, or MBID
        const decodedName = decodeURIComponent(idParam);
        const artist = await prisma.artist.findFirst({
            where: {
                OR: [
                    { id: idParam },
                    { name: { equals: decodedName, mode: "insensitive" } },
                    { mbid: idParam },
                ],
            },
            include: artistInclude,
        });

        if (!artist) {
            return sendRouteError(res, 404, "Artist not found");
        }

        // For enriched artists with ownedAlbums, skip expensive MusicBrainz calls.
        // Only fetch from MusicBrainz if the artist hasn't been enriched yet.
        let albumsWithOwnership = [];
        const ownedRgMbids = new Set(artist.ownedAlbums.map((o) => o.rgMbid));

        // If artist has temp MBID, try to find real MBID by searching MusicBrainz
        let effectiveMbid = artist.mbid;
        if (
            shouldResolveMbid &&
            (!effectiveMbid || effectiveMbid.startsWith("temp-"))
        ) {
            logger.debug(
                ` Artist has temp/no MBID, searching MusicBrainz for ${artist.name}...`
            );
            try {
                const searchResults = await musicBrainzService.searchArtist(
                    artist.name,
                    1
                );
                if (searchResults.length > 0) {
                    effectiveMbid = searchResults[0].id;
                    logger.debug(`  Found MBID: ${effectiveMbid}`);

                    const existingOwner = await prisma.artist.findUnique({
                        where: { mbid: effectiveMbid },
                        select: { id: true },
                    });

                    // Update database with real MBID for future use (skip if duplicate).
                    // Pre-check avoids noisy unique-constraint logs in common races.
                    if (existingOwner && existingOwner.id !== artist.id) {
                        logger.debug(
                            `MBID ${effectiveMbid} already exists for another artist, skipping update`
                        );
                    } else {
                        try {
                            await prisma.artist.update({
                                where: { id: artist.id },
                                data: { mbid: effectiveMbid },
                            });
                        } catch (mbidError: any) {
                            // If MBID was claimed between pre-check and update, continue.
                            if (mbidError.code === "P2002") {
                                logger.debug(
                                    `MBID ${effectiveMbid} already exists for another artist, skipping update`
                                );
                            } else {
                                logger.error(
                                    `  ✗ Failed to update MBID:`,
                                    mbidError
                                );
                            }
                        }
                    }
                } else {
                    logger.debug(
                        `  ✗ No MusicBrainz match found for ${artist.name}`
                    );
                }
            } catch (error) {
                logger.error(` MusicBrainz search failed:`, error);
            }
        }

        // Track whether we successfully loaded the full discography
        let discographyComplete = !includeDiscography;

        // Albums from database have actual tracks on disk - they MUST show as owned
        const dbAlbums = artist.albums.map((album) => ({
            ...album,
            owned: true, // If it's in the database with tracks, user owns it!
            coverArt: album.coverUrl,
            source: "database" as const,
        }));

        logger.debug(
            `[Artist] Found ${dbAlbums.length} albums from database (actual owned files)`
        );

        if (!includeDiscography) {
            albumsWithOwnership = dbAlbums;
        } else {
            // Always fetch discography if we have a valid MBID - users need to see what's available
            const shouldFetchDiscography =
                effectiveMbid && !effectiveMbid.startsWith("temp-");

            if (shouldFetchDiscography) {
                const discoCacheKey = `discography:${effectiveMbid}`;
                try {
                    // Check Redis cache first (cache for 24 hours)
                    let releaseGroups: any[] = [];

                    const cachedDisco = await redisClient.get(discoCacheKey);
                    if (cachedDisco && cachedDisco !== "NOT_FOUND") {
                        releaseGroups = JSON.parse(cachedDisco);
                        logger.debug(
                            `[Artist] Using cached discography (${releaseGroups.length} albums)`
                        );
                    } else {
                        logger.debug(
                            `[Artist] Fetching discography from MusicBrainz...`
                        );
                        releaseGroups = await musicBrainzService.getReleaseGroups(
                            effectiveMbid,
                            ["album", "ep"],
                            100
                        );
                        // Cache for 24 hours
                        await redisClient.setEx(
                            discoCacheKey,
                            24 * 60 * 60,
                            JSON.stringify(releaseGroups)
                        );
                    }

                    logger.debug(
                        `  Got ${releaseGroups.length} albums from MusicBrainz (before filtering)`
                    );

                    // Filter out live albums, compilations, soundtracks, remixes, etc.
                    const excludedSecondaryTypes = [
                        "Live",
                        "Compilation",
                        "Soundtrack",
                        "Remix",
                        "DJ-mix",
                        "Mixtape/Street",
                        "Demo",
                        "Interview",
                        "Audio drama",
                        "Audiobook",
                        "Spokenword",
                    ];

                    const filteredReleaseGroups = releaseGroups.filter(
                        (rg: any) => {
                            // Keep if no secondary types (pure studio album/EP)
                            if (
                                !rg["secondary-types"] ||
                                rg["secondary-types"].length === 0
                            ) {
                                return true;
                            }
                            // Exclude if any secondary type matches our exclusion list
                            return !rg["secondary-types"].some((type: string) =>
                                excludedSecondaryTypes.includes(type)
                            );
                        }
                    );

                    logger.debug(
                        `  Filtered to ${filteredReleaseGroups.length} studio albums/EPs`
                    );

                    // Transform MusicBrainz release groups to album format
                    // PERFORMANCE: Only check Redis cache for covers, don't make API calls
                    // This makes artist pages load instantly after the first visit
                    const mbAlbums = await Promise.all(
                        filteredReleaseGroups.map(async (rg: any) => {
                            let coverUrl = null;

                            // Only check Redis cache - don't make external API calls
                            // Covers will be fetched lazily by the frontend or during enrichment
                            const cacheKey = `caa:${rg.id}`;
                            try {
                                const cached = await redisClient.get(cacheKey);
                                if (cached && cached !== "NOT_FOUND") {
                                    coverUrl = cached;
                                }
                            } catch (err) {
                                // Redis error, continue without cover
                            }

                            return {
                                id: rg.id,
                                rgMbid: rg.id,
                                title: rg.title,
                                year: rg["first-release-date"]
                                    ? parseInt(
                                          rg["first-release-date"].substring(0, 4)
                                      )
                                    : null,
                                type: rg["primary-type"],
                                coverUrl,
                                coverArt: coverUrl,
                                artistId: artist.id,
                                owned: ownedRgMbids.has(rg.id),
                                trackCount: 0,
                                tracks: [],
                                source: "musicbrainz" as const,
                            };
                        })
                    );

                    // Merge database albums with MusicBrainz albums
                    // Database albums take precedence (they have actual files!)
                    const dbAlbumTitles = new Set(
                        dbAlbums.map((a) => a.title.toLowerCase())
                    );
                    const mbAlbumsFiltered = mbAlbums.filter(
                        (a) => !dbAlbumTitles.has(a.title.toLowerCase())
                    );

                    albumsWithOwnership = [...dbAlbums, ...mbAlbumsFiltered];

                    logger.debug(
                        `  Total albums: ${albumsWithOwnership.length} (${dbAlbums.length} owned from database, ${mbAlbumsFiltered.length} from MusicBrainz)`
                    );
                    logger.debug(
                        `  Owned: ${
                            albumsWithOwnership.filter((a) => a.owned).length
                        }, Available: ${
                            albumsWithOwnership.filter((a) => !a.owned).length
                        }`
                    );
                    discographyComplete = true;
                } catch (error: any) {
                    const transientErrorCodes = new Set([
                        "ECONNRESET",
                        "ECONNABORTED",
                        "ETIMEDOUT",
                        "EAI_AGAIN",
                        "ENOTFOUND",
                        "EHOSTUNREACH",
                        "ENETUNREACH",
                        "ERR_SOCKET_CLOSED",
                    ]);
                    const statusCode = Number(error?.response?.status);
                    const isTransientMusicBrainzError =
                        transientErrorCodes.has(String(error?.code || "")) ||
                        (Number.isFinite(statusCode) &&
                            statusCode >= 500 &&
                            statusCode <= 599);

                    if (isTransientMusicBrainzError) {
                        logger.warn(
                            `[Artist] MusicBrainz discography lookup failed for ${artist.name} (${effectiveMbid}): ${error?.message || "unknown error"}`
                        );
                    } else {
                        logger.error(`Failed to fetch MusicBrainz discography:`, error);
                    }

                    // Short-cache the miss to avoid rapid repeat retries during transient outages.
                    try {
                        await redisClient.setEx(discoCacheKey, 120, JSON.stringify([]));
                    } catch (cacheError) {
                        logger.debug("[Artist] Failed to write transient discography fallback cache:", cacheError);
                    }
                    // Just use database albums - discographyComplete stays false
                    albumsWithOwnership = dbAlbums;
                }
            } else {
                // No valid MBID - just use database albums
                // Still mark as complete since there's nothing more to fetch
                discographyComplete = true;
                logger.debug(
                    `[Artist] No valid MBID, using ${dbAlbums.length} albums from database`
                );
                albumsWithOwnership = dbAlbums;
            }
        }

        let similarArtists: any[] = [];
        let topTracks: any[] = [];

        if (includeTopTracks) {
            // Extract top tracks from library first
            const allTracks = artist.albums.flatMap((a) => a.tracks);
            topTracks = allTracks.slice(0, 10);

            // Get user play counts for all tracks
            const userId = req.user!.id;
            const trackIds = allTracks.map((t) => t.id);
            const userPlays = await prisma.play.groupBy({
                by: ["trackId"],
                where: {
                    userId,
                    trackId: { in: trackIds },
                },
                _count: {
                    id: true,
                },
            });
            const userPlayCounts = new Map(
                userPlays.map((p) => [p.trackId, p._count.id])
            );

            // Fetch Last.fm top tracks (cached for 24 hours)
            const topTracksCacheKey = `top-tracks:${artist.id}`;
            try {
                // Check cache first
                const cachedTopTracks = await redisClient.get(topTracksCacheKey);
                let lastfmTopTracks: any[] = [];

                if (cachedTopTracks && cachedTopTracks !== "NOT_FOUND") {
                    lastfmTopTracks = JSON.parse(cachedTopTracks);
                    logger.debug(
                        `[Artist] Using cached top tracks (${lastfmTopTracks.length})`
                    );
                } else {
                    // Cache miss - fetch from Last.fm
                    const validMbid =
                        effectiveMbid && !effectiveMbid.startsWith("temp-")
                            ? effectiveMbid
                            : "";
                    lastfmTopTracks = await lastFmService.getArtistTopTracks(
                        validMbid,
                        artist.name,
                        10
                    );
                    // Cache for 24 hours
                    await redisClient.setEx(
                        topTracksCacheKey,
                        24 * 60 * 60,
                        JSON.stringify(lastfmTopTracks)
                    );
                    logger.debug(
                        `[Artist] Cached ${lastfmTopTracks.length} top tracks`
                    );
                }

                // Build lookup map for O(1) matching instead of O(n*m)
                const tracksByTitle = new Map<string, (typeof allTracks)[0]>();
                for (const track of allTracks) {
                    const key = track.title.toLowerCase();
                    if (!tracksByTitle.has(key)) {
                        tracksByTitle.set(key, track);
                    }
                }

                // For each Last.fm track, try to match with library track or add as unowned
                const combinedTracks: any[] = [];

                // Collect unowned tracks that need Deezer cover lookups
                const unownedEntries: Array<{
                    index: number;
                    lfmTrack: (typeof lastfmTopTracks)[number];
                    albumTitle: string;
                }> = [];

                for (const lfmTrack of lastfmTopTracks) {
                    // O(1) lookup instead of O(n) find
                    const key = lfmTrack.name.toLowerCase();
                    const matchedTrack = tracksByTitle.get(key);

                    if (matchedTrack) {
                        // Track exists in library - include user play count
                        combinedTracks.push({
                            ...matchedTrack,
                            playCount: lfmTrack.playcount
                                ? parseInt(lfmTrack.playcount)
                                : 0,
                            listeners: lfmTrack.listeners
                                ? parseInt(lfmTrack.listeners)
                                : 0,
                            userPlayCount:
                                userPlayCounts.get(matchedTrack.id) || 0,
                            album: {
                                ...matchedTrack.album,
                                coverArt: matchedTrack.album.coverUrl,
                            },
                        });
                    } else {
                        const albumTitle =
                            lfmTrack.album?.["#text"] || "Unknown Album";
                        // Push placeholder; coverArt will be filled after batch lookup
                        const idx = combinedTracks.length;
                        combinedTracks.push({
                            id: `lastfm-${artist.mbid || artist.name}-${
                                lfmTrack.name
                            }`,
                            title: lfmTrack.name,
                            playCount: lfmTrack.playcount
                                ? parseInt(lfmTrack.playcount)
                                : 0,
                            listeners: lfmTrack.listeners
                                ? parseInt(lfmTrack.listeners)
                                : 0,
                            duration: lfmTrack.duration
                                ? Math.floor(parseInt(lfmTrack.duration) / 1000)
                                : 0,
                            url: lfmTrack.url,
                            album: {
                                title: albumTitle,
                                coverArt: null,
                            },
                            userPlayCount: 0,
                            // NO album.id - this indicates track is not in library
                        });
                        if (albumTitle !== "Unknown Album") {
                            unownedEntries.push({
                                index: idx,
                                lfmTrack,
                                albumTitle,
                            });
                        }
                    }
                }

                // Fetch Deezer covers for unowned tracks in parallel (cached 24h)
                if (unownedEntries.length > 0) {
                    const covers = await Promise.all(
                        unownedEntries.map((entry) =>
                            deezerService
                                .getAlbumCover(artist.name, entry.albumTitle)
                                .catch(() => null)
                        )
                    );
                    for (let i = 0; i < unownedEntries.length; i++) {
                        if (covers[i]) {
                            combinedTracks[unownedEntries[i].index].album.coverArt =
                                covers[i];
                        }
                    }
                }

                topTracks = combinedTracks.slice(0, 10);
            } catch (error) {
                logger.error(
                    `Failed to get Last.fm top tracks for ${artist.name}:`,
                    error
                );
                // If Last.fm fails, add user play counts to library tracks
                topTracks = topTracks.map((t) => ({
                    ...t,
                    userPlayCount: userPlayCounts.get(t.id) || 0,
                    album: {
                        ...t.album,
                        coverArt: t.album.coverUrl,
                    },
                }));
            }
        }

        const heroUrl =
            includeDiscography || includeTopTracks || includeSimilarArtists
                ? await dataCacheService.getArtistImage(
                      artist.id,
                      artist.name,
                      effectiveMbid
                  )
                : artist.userHeroUrl ?? artist.heroUrl ?? null;

        if (includeSimilarArtists) {
            const similarCacheKey = `similar-artists:${artist.id}`;
            const cachedSimilar = await redisClient.get(similarCacheKey);

            // Check if artist has pre-enriched similar artists JSON (full Last.fm data)
            const enrichedSimilar = artist.similarArtistsJson as Array<{
                name: string;
                mbid: string | null;
                match: number;
            }> | null;

            if (enrichedSimilar && enrichedSimilar.length > 0) {
                // Use pre-enriched data from database (fast path)
                logger.debug(
                    `[Artist] Using ${enrichedSimilar.length} similar artists from enriched JSON`
                );

                // First, batch lookup which similar artists exist in our library
                const similarNames = enrichedSimilar
                    .slice(0, 10)
                    .map((s) => s.name.toLowerCase());
                const similarMbids = enrichedSimilar
                    .slice(0, 10)
                    .map((s) => s.mbid)
                    .filter(Boolean) as string[];

                // Find library artists matching by name or mbid
                const libraryMatches = await prisma.artist.findMany({
                    where: {
                        OR: [
                            { normalizedName: { in: similarNames } },
                            ...(similarMbids.length > 0
                                ? [{ mbid: { in: similarMbids } }]
                                : []),
                        ],
                    },
                    select: {
                        id: true,
                        name: true,
                        normalizedName: true,
                        mbid: true,
                        heroUrl: true,
                        _count: {
                            select: {
                                albums: {
                                    where: {
                                        location: "LIBRARY",
                                        tracks: { some: {} },
                                    },
                                },
                            },
                        },
                    },
                });

                // Create lookup maps for quick matching
                const libraryByName = new Map(
                    libraryMatches.map((a) => [
                        a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
                        a,
                    ])
                );
                const libraryByMbid = new Map(
                    libraryMatches.filter((a) => a.mbid).map((a) => [a.mbid!, a])
                );

                // Fetch images in parallel from Deezer (cached in Redis)
                const similarWithImages = await Promise.all(
                    enrichedSimilar.slice(0, 10).map(async (s) => {
                        // Check if this artist is in our library
                        const libraryArtist =
                            (s.mbid && libraryByMbid.get(s.mbid)) ||
                            libraryByName.get(s.name.toLowerCase());

                        let image = libraryArtist?.heroUrl || null;

                        // If no library image, try Deezer
                        if (!image) {
                            try {
                                // Check Redis cache first
                                const cacheKey = `deezer-artist-image:${s.name}`;
                                const cached = await redisClient.get(cacheKey);
                                if (cached && cached !== "NOT_FOUND") {
                                    image = cached;
                                } else {
                                    image = await deezerService.getArtistImage(
                                        s.name
                                    );
                                    if (image) {
                                        await redisClient.setEx(
                                            cacheKey,
                                            24 * 60 * 60,
                                            image
                                        );
                                    }
                                }
                            } catch (err) {
                                // Deezer failed, leave null
                            }
                        }

                        return {
                            id: libraryArtist?.id || s.name,
                            name: s.name,
                            mbid: s.mbid || null,
                            coverArt: image,
                            albumCount: 0, // Would require MusicBrainz lookup - skip for performance
                            ownedAlbumCount: libraryArtist?._count?.albums || 0,
                            weight: s.match,
                            inLibrary: !!libraryArtist,
                        };
                    })
                );

                similarArtists = similarWithImages;
            } else if (cachedSimilar && cachedSimilar !== "NOT_FOUND") {
                similarArtists = JSON.parse(cachedSimilar);
                logger.debug(
                    `[Artist] Using cached similar artists (${similarArtists.length})`
                );
            } else {
                // Cache miss - fetch from Last.fm
                logger.debug(
                    `[Artist] Fetching similar artists from Last.fm...`
                );

                try {
                    const validMbid =
                        effectiveMbid && !effectiveMbid.startsWith("temp-")
                            ? effectiveMbid
                            : "";
                    const lastfmSimilar = await lastFmService.getSimilarArtists(
                        validMbid,
                        artist.name,
                        10
                    );

                    // Batch lookup which similar artists exist in our library
                    const similarNames = lastfmSimilar.map((s: any) =>
                        s.name.toLowerCase()
                    );
                    const similarMbids = lastfmSimilar
                        .map((s: any) => s.mbid)
                        .filter(Boolean) as string[];

                    const libraryMatches = await prisma.artist.findMany({
                        where: {
                            OR: [
                                { normalizedName: { in: similarNames } },
                                ...(similarMbids.length > 0
                                    ? [{ mbid: { in: similarMbids } }]
                                    : []),
                            ],
                        },
                        select: {
                            id: true,
                            name: true,
                            normalizedName: true,
                            mbid: true,
                            heroUrl: true,
                            _count: {
                                select: {
                                    albums: {
                                        where: {
                                            location: "LIBRARY",
                                            tracks: { some: {} },
                                        },
                                    },
                                },
                            },
                        },
                    });

                    const libraryByName = new Map(
                        libraryMatches.map((a) => [
                            a.normalizedName?.toLowerCase() ||
                                a.name.toLowerCase(),
                            a,
                        ])
                    );
                    const libraryByMbid = new Map(
                        libraryMatches
                            .filter((a) => a.mbid)
                            .map((a) => [a.mbid!, a])
                    );

                    // Fetch images in parallel (Deezer only - fastest source)
                    const similarWithImages = await Promise.all(
                        lastfmSimilar.map(async (s: any) => {
                            const libraryArtist =
                                (s.mbid && libraryByMbid.get(s.mbid)) ||
                                libraryByName.get(s.name.toLowerCase());

                            let image = libraryArtist?.heroUrl || null;

                            if (!image) {
                                try {
                                    image = await deezerService.getArtistImage(
                                        s.name
                                    );
                                } catch (err) {
                                    // Deezer failed, leave null
                                }
                            }

                            return {
                                id: libraryArtist?.id || s.name,
                                name: s.name,
                                mbid: s.mbid || null,
                                coverArt: image,
                                albumCount: 0,
                                ownedAlbumCount:
                                    libraryArtist?._count?.albums || 0,
                                weight: s.match,
                                inLibrary: !!libraryArtist,
                            };
                        })
                    );

                    similarArtists = similarWithImages;

                    // Cache for 24 hours
                    await redisClient.setEx(
                        similarCacheKey,
                        24 * 60 * 60,
                        JSON.stringify(similarArtists)
                    );
                    logger.debug(
                        `[Artist] Cached ${similarArtists.length} similar artists`
                    );
                } catch (error) {
                    logger.error(
                        `[Artist] Failed to fetch similar artists:`,
                        error
                    );
                    similarArtists = [];
                }
            }
        }

        res.json({
            ...artist,
            coverArt: heroUrl, // Use fetched hero image (falls back to artist.heroUrl)
            bio: getArtistDisplaySummary(artist),
            genres: getMergedGenres(artist),
            albums: albumsWithOwnership,
            topTracks,
            similarArtists,
            discographyComplete,
        });
    } catch (error) {
        logger.error("Get artist error:", error);
        sendInternalRouteError(res, "Failed to fetch artist");
    }
});

/**
 * @openapi
 * /api/library/albums:
 *   get:
 *     summary: List albums in the library with pagination and filtering
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: artistId
 *         schema:
 *           type: string
 *         description: Filter by artist ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 500
 *         description: Number of albums to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [owned, discovery, all]
 *           default: owned
 *         description: Filter by ownership type
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [name, name-desc, recent]
 *           default: name
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Paginated list of albums
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 albums:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /library/albums?artistId=&limit=&offset=&filter=owned|discovery|all
router.get("/albums", async (req, res) => {
    try {
        const {
            artistId,
            limit: limitParam = "500",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
            sortBy = "name",
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 500,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        const orderBy = ALBUM_SORT_MAP[sortBy as string] ?? { title: "asc" as const };

        let where: any = {
            tracks: { some: {} }, // Only albums with tracks
        };

        // Apply location filter
        if (filter === "owned") {
            // Get all owned album rgMbids (includes liked discovery albums)
            const ownedAlbumMbids = await prisma.ownedAlbum.findMany({
                select: { rgMbid: true },
            });
            const ownedMbids = ownedAlbumMbids.map((oa) => oa.rgMbid);

            // Albums with LIBRARY location OR rgMbid in OwnedAlbum
            where.OR = [
                { location: "LIBRARY", tracks: { some: {} } },
                { rgMbid: { in: ownedMbids }, tracks: { some: {} } },
            ];
        } else if (filter === "discovery") {
            where.location = "DISCOVER";
        }
        // filter === "all" shows all locations

        // If artistId is provided, filter by artist
        if (artistId) {
            if (where.OR) {
                // If we have OR conditions, wrap with AND
                where = {
                    AND: [{ OR: where.OR }, { artistId: artistId as string }],
                };
            } else {
                where.artistId = artistId as string;
            }
        }

        const [albumsData, total] = await Promise.all([
            prisma.album.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy,
                include: {
                    artist: {
                        select: {
                            id: true,
                            mbid: true,
                            name: true,
                        },
                    },
                },
            }),
            prisma.album.count({ where }),
        ]);

        // Normalize coverArt field for frontend
        const albums = albumsData.map((album) => ({
            ...album,
            coverArt: album.coverUrl,
        }));

        res.json({
            albums,
            total,
            offset,
            limit,
        });
    } catch (error: any) {
        logger.error("[Library] Get albums error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch albums",
            details: error?.message,
        });
    }
});

/**
 * @openapi
 * /api/library/albums/{id}:
 *   get:
 *     summary: Get album details with tracks
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID or release group MBID
 *       - in: query
 *         name: includeTracks
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include track listing
 *     responses:
 *       200:
 *         description: Album details with tracks and ownership info
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/albums/:id
router.get("/albums/:id", async (req, res) => {
    try {
        const idParam = req.params.id;
        const includeTracks = parseBooleanQueryParam(
            req.query.includeTracks,
            true
        );

        // Find album by ID or rgMbid (for discovery albums) in single query.
        // Tracks can be excluded for lightweight progressive hydration.
        const album = includeTracks
            ? await prisma.album.findFirst({
                  where: {
                      OR: [{ id: idParam }, { rgMbid: idParam }],
                  },
                  include: {
                      artist: {
                          select: {
                              id: true,
                              mbid: true,
                              name: true,
                          },
                      },
                      tracks: {
                          orderBy: [
                              { discNo: Prisma.SortOrder.asc },
                              { trackNo: Prisma.SortOrder.asc },
                          ],
                      },
                  },
              })
            : await prisma.album.findFirst({
                  where: {
                      OR: [{ id: idParam }, { rgMbid: idParam }],
                  },
                  include: {
                      artist: {
                          select: {
                              id: true,
                              mbid: true,
                              name: true,
                          },
                      },
                  },
              });

        if (!album) {
            return sendRouteError(res, 404, "Album not found");
        }

        // Check ownership with O(1) indexed lookup (separate query is faster than fetching all ownedAlbums)
        const owned = await prisma.ownedAlbum.findUnique({
            where: {
                artistId_rgMbid: {
                    artistId: album.artistId,
                    rgMbid: album.rgMbid,
                },
            },
        });
        const isOwned = !!owned;

        const artistData = album.artist;
        const tracks = includeTracks && "tracks" in album ? album.tracks : [];

        res.json({
            ...album,
            artist: artistData,
            tracks,
            owned: isOwned,
            coverArt: album.coverUrl,
        });
    } catch (error) {
        logger.error("Get album error:", error);
        sendInternalRouteError(res, "Failed to fetch album");
    }
});

/**
 * @openapi
 * /api/library/tracks:
 *   get:
 *     summary: List tracks with optional album filter and pagination
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: albumId
 *         schema:
 *           type: string
 *         description: Filter by album ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of tracks to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [name, name-desc]
 *           default: name
 *         description: Sort order (ignored when albumId is provided)
 *     responses:
 *       200:
 *         description: Paginated list of tracks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks?albumId=&limit=100&offset=0
router.get("/tracks", async (req, res) => {
    try {
        const {
            albumId,
            limit: limitParam = "100",
            offset: offsetParam = "0",
            sortBy = "name",
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 100,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        let orderBy: any;
        if (albumId) {
            orderBy = [
                { discNo: "asc" as const },
                { trackNo: "asc" as const },
            ];
        } else {
            orderBy = TRACK_SORT_MAP[sortBy as string] ?? { title: "asc" as const };
        }

        const where: any = {};
        if (albumId) {
            where.albumId = albumId as string;
        }

        const [tracksData, total] = await Promise.all([
            prisma.track.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy,
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            }),
            prisma.track.count({ where }),
        ]);

        // Add coverArt field to albums
        const tracks = tracksData.map((track) => ({
            ...track,
            album: {
                ...track.album,
                coverArt: track.album.coverUrl,
            },
        }));

        res.json({ tracks, total, offset, limit });
    } catch (error) {
        logger.error("Get tracks error:", error);
        sendInternalRouteError(res, "Failed to fetch tracks");
    }
});

/**
 * @openapi
 * /api/library/liked:
 *   get:
 *     summary: Get the user's liked tracks playlist with cursor-based pagination
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of tracks to return
 *       - in: query
 *         name: cursorLikedAt
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Cursor timestamp for pagination (must be paired with cursorTrackId)
 *       - in: query
 *         name: cursorTrackId
 *         schema:
 *           type: string
 *         description: Cursor track ID for pagination (must be paired with cursorLikedAt)
 *     responses:
 *       200:
 *         description: Liked tracks playlist with pagination info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 playlist:
 *                   type: object
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *                     nextCursor:
 *                       type: object
 *                       nullable: true
 *       400:
 *         description: Bad request (mismatched cursor params)
 *       401:
 *         description: Not authenticated
 */
// GET /library/liked?limit=100&cursorLikedAt=<iso>&cursorTrackId=<id>
router.get("/liked", async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return sendRouteError(
                res,
                401,
                "Authentication required for liked playlist"
            );
        }

        const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
        const limit =
            Number.isFinite(parsedLimit) && parsedLimit > 0 ?
                Math.min(parsedLimit, MAX_LIMIT)
            :   DEFAULT_MY_LIKED_LIMIT;

        const cursorLikedAtParam =
            typeof req.query.cursorLikedAt === "string" ?
                req.query.cursorLikedAt
            :   null;
        const cursorTrackIdParam =
            typeof req.query.cursorTrackId === "string" ?
                req.query.cursorTrackId
            :   null;

        if (!!cursorLikedAtParam !== !!cursorTrackIdParam) {
            return sendRouteError(
                res,
                400,
                "cursorLikedAt and cursorTrackId must be provided together"
            );
        }

        let cursorLikedAt: Date | null = null;
        if (cursorLikedAtParam) {
            const parsedCursor = new Date(cursorLikedAtParam);
            if (Number.isNaN(parsedCursor.getTime())) {
                return sendRouteError(res, 400, "Invalid cursorLikedAt timestamp");
            }
            cursorLikedAt = parsedCursor;
        }

        const likedWhere: Prisma.LikedTrackWhereInput =
            cursorLikedAt && cursorTrackIdParam ?
                {
                    userId,
                    OR: [
                        { likedAt: { lt: cursorLikedAt } },
                        {
                            likedAt: cursorLikedAt,
                            trackId: { gt: cursorTrackIdParam },
                        },
                    ],
                }
            :   { userId };

        const [total, likedEntriesWithExtra] = await Promise.all([
            prisma.likedTrack.count({
                where: { userId },
            }),
            prisma.likedTrack.findMany({
                where: likedWhere,
                select: {
                    trackId: true,
                    likedAt: true,
                },
                orderBy: [{ likedAt: "desc" }, { trackId: "asc" }],
                take: limit + 1,
            }),
        ]);

        const hasMore = likedEntriesWithExtra.length > limit;
        const likedEntries =
            hasMore ?
                likedEntriesWithExtra.slice(0, limit)
            :   likedEntriesWithExtra;
        const trackIds = likedEntries.map((entry) => entry.trackId);

        if (trackIds.length === 0) {
            return res.json({
                playlist: {
                    id: MY_LIKED_PLAYLIST_ID,
                    name: MY_LIKED_PLAYLIST_NAME,
                    description: MY_LIKED_PLAYLIST_DESCRIPTION,
                },
                tracks: [],
                total,
                pagination: {
                    limit,
                    hasMore: false,
                    nextCursor: null,
                },
            });
        }

        const tracks = await prisma.track.findMany({
            where: {
                id: { in: trackIds },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
        });

        const trackById = new Map(tracks.map((track) => [track.id, track]));
        const orderedTracks = likedEntries
            .map((entry) => {
                const track = trackById.get(entry.trackId);
                if (!track) {
                    return null;
                }

                return {
                    id: track.id,
                    title: track.title,
                    duration: track.duration,
                    trackNo: track.trackNo,
                    filePath: track.filePath,
                    likedAt: entry.likedAt.toISOString(),
                    artist: {
                        id: track.album.artist.id,
                        name: track.album.artist.name,
                    },
                    album: {
                        id: track.album.id,
                        title: track.album.title,
                        coverArt: track.album.coverUrl,
                    },
                };
            })
            .filter((track): track is NonNullable<typeof track> => track !== null);

        const nextCursor =
            hasMore && likedEntries.length > 0 ?
                {
                    likedAt:
                        likedEntries[likedEntries.length - 1].likedAt.toISOString(),
                    trackId: likedEntries[likedEntries.length - 1].trackId,
                }
            :   null;

        return res.json({
            playlist: {
                id: MY_LIKED_PLAYLIST_ID,
                name: MY_LIKED_PLAYLIST_NAME,
                description: MY_LIKED_PLAYLIST_DESCRIPTION,
            },
            tracks: orderedTracks,
            total,
            pagination: {
                limit,
                hasMore,
                nextCursor,
            },
        });
    } catch (error) {
        logger.error("Get liked playlist error:", error);
        return sendInternalRouteError(res, "Failed to fetch liked playlist");
    }
});

/**
 * @openapi
 * /api/library/tracks/shuffle:
 *   get:
 *     summary: Get random tracks for shuffle play
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of random tracks to return
 *     responses:
 *       200:
 *         description: Shuffled tracks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/shuffle?limit=100 - Get random tracks for shuffle play
router.get("/tracks/shuffle", async (req, res) => {
    try {
        const { limit: limitParam = "100" } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 100,
            MAX_LIMIT
        );

        // Get total count of tracks
        const totalTracks = await prisma.track.count();

        if (totalTracks === 0) {
            return res.json({ tracks: [], total: 0 });
        }

        // For small libraries, fetch all and shuffle in memory
        // For large libraries, use database-level randomization for memory efficiency
        let tracksData;
        if (totalTracks <= limit) {
            // Fetch all tracks and shuffle
            tracksData = await prisma.track.findMany({
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });
            tracksData = shuffleArray(tracksData);
        } else {
            // For large libraries, use database-level randomization
            // Get random track IDs first (efficient, O(limit) memory)
            const randomIds = await prisma.$queryRaw<{ id: string }[]>`
                SELECT id FROM "Track"
                ORDER BY RANDOM()
                LIMIT ${limit}
            `;

            // Then fetch full track data for selected IDs
            tracksData = await prisma.track.findMany({
                where: {
                    id: { in: randomIds.map((r) => r.id) },
                },
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });

            // Shuffle the result to maintain randomness (findMany doesn't preserve order)
            for (let i = tracksData.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tracksData[i], tracksData[j]] = [tracksData[j], tracksData[i]];
            }
        }

        // Add coverArt field to albums
        const tracks = tracksData.slice(0, limit).map((track) => ({
            ...track,
            album: {
                ...track.album,
                coverArt: track.album.coverUrl,
            },
        }));

        res.json({ tracks, total: totalTracks });
    } catch (error) {
        logger.error("Shuffle tracks error:", error);
        sendInternalRouteError(res, "Failed to shuffle tracks");
    }
});

/**
 * @openapi
 * /api/library/cover-art/{id}:
 *   get:
 *     summary: Proxy and cache album cover art images
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: false
 *         schema:
 *           type: string
 *         description: Album ID, cover URL, native cover path, or audiobook cover path
 *       - in: query
 *         name: url
 *         schema:
 *           type: string
 *         description: Full cover art URL (alternative to path parameter)
 *       - in: query
 *         name: size
 *         schema:
 *           type: string
 *         description: Requested image size
 *     responses:
 *       200:
 *         description: Cover art image binary
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       304:
 *         description: Not modified (client cache is current)
 *       400:
 *         description: Invalid cover art URL
 *       404:
 *         description: Cover art not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/cover-art/:id?size= or GET /library/cover-art?url=&size=
// Apply lenient image limiter (500 req/min) instead of general API limiter (100 req/15min)
router.get("/cover-art/:id?", imageLimiter, async (req, res) => {
    try {
        const { size, url } = req.query;
        let coverUrl: string;

        // Check if a full URL was provided as a query parameter
        if (url) {
            const rawUrl = Array.isArray(url) ? url[0] : url;
            const decodedUrl =
                typeof rawUrl === "string" ? rawUrl : String(rawUrl);

            // Check if this is an audiobook cover (prefixed with "audiobook__")
            if (decodedUrl.startsWith("audiobook__")) {
                const audiobookPath = decodedUrl.replace("audiobook__", "");

                // Get Audiobookshelf settings
                const settings = await getSystemSettings();
                const audiobookshelfUrl =
                    settings?.audiobookshelfUrl ||
                    process.env.AUDIOBOOKSHELF_URL ||
                    "";
                const audiobookshelfApiKey =
                    settings?.audiobookshelfApiKey ||
                    process.env.AUDIOBOOKSHELF_API_KEY ||
                    "";
                const audiobookshelfBaseUrl = audiobookshelfUrl.replace(
                    /\/$/,
                    ""
                );

                coverUrl = `${audiobookshelfBaseUrl}/api/${audiobookPath}`;

                // Fetch with authentication
                logger.debug(
                    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(
                        0,
                        100
                    )}...`
                );
                const imageResponse = await fetch(coverUrl, {
                    headers: {
                        Authorization: `Bearer ${audiobookshelfApiKey}`,
                        "User-Agent": BRAND_USER_AGENT,
                    },
                });

                if (!imageResponse.ok) {
                    logger.error(
                        `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
                    );
                    return res
                        .status(404)
                        .json({ error: "Audiobook cover art not found" });
                }

                const buffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(buffer);
                const contentType = imageResponse.headers.get("content-type");

                if (contentType) {
                    res.setHeader("Content-Type", contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    COVER_ART_IMAGE_CACHE_CONTROL
                );

                return res.send(imageBuffer);
            }

            // Check if this is a native cover (prefixed with "native:")
            if (decodedUrl.startsWith("native:")) {
                const nativePath = decodedUrl.replace("native:", "");

                const nativeCacheHit = resolveNativeCoverCacheHit(nativePath);
                if (!nativeCacheHit) {
                    const missingCoverCachePath = getNativeCoverCachePath(nativePath);
                    logger.warn(
                        `[COVER-ART] Native cover not found: ${missingCoverCachePath}, trying Deezer fallback`
                    );
                    try {
                        const deezerCover =
                            await tryHealMissingNativeAlbumCover(nativePath);
                        if (deezerCover) {
                            return res.redirect(deezerCover);
                        }
                    } catch (error) {
                        logger.error(
                            `[COVER-ART] Failed to fetch Deezer fallback for native path ${nativePath}:`,
                            error
                        );
                    }
                    return sendRouteError(res, 404, "Cover art not found");
                }

                const canonicalNativePath = nativeCacheHit.resolvedNativePath;
                if (canonicalNativePath !== nativePath) {
                    const canonicalNativeCoverUrl = `native:${canonicalNativePath}`;
                    const canonicalAlbumId =
                        getAlbumIdFromNativeCoverPath(canonicalNativePath);
                    /* istanbul ignore else -- native cache hit candidates always normalize to file-name ids */
                    if (canonicalAlbumId) {
                        void persistHealedAlbumCover(
                            canonicalAlbumId,
                            canonicalNativeCoverUrl
                        ).catch((error) => {
                            logger.warn(
                                `[COVER-ART] Failed to backfill canonical native path for album ${canonicalAlbumId}:`,
                                error
                            );
                        });
                    }
                    logger.debug(
                        `[COVER-ART] Resolved legacy native cover path ${nativePath} -> ${canonicalNativePath}`
                    );
                }

                logger.debug(
                    `[COVER-ART] Serving native cover: ${nativeCacheHit.cachePath}`
                );

                // Serve the file directly
                const requestOrigin = req.headers.origin;
                const headers: Record<string, string> = {
                    "Content-Type": "image/jpeg", // Assume JPEG for now
                    "Cache-Control": COVER_ART_IMAGE_CACHE_CONTROL,
                    "Cross-Origin-Resource-Policy": "cross-origin",
                };
                if (requestOrigin) {
                    headers["Access-Control-Allow-Origin"] = requestOrigin;
                    headers["Access-Control-Allow-Credentials"] = "true";
                } else {
                    headers["Access-Control-Allow-Origin"] = "*";
                }

                return res.sendFile(nativeCacheHit.cachePath, {
                    headers,
                });
            }

            coverUrl = decodedUrl;
        } else {
            // Otherwise use the ID from the path parameter
            const coverId = req.params.id;
            if (!coverId) {
                return res
                    .status(400)
                    .json({ error: "No cover ID or URL provided" });
            }

            const decodedId = decodeURIComponent(coverId);

            // Check if this is a native cover (prefixed with "native:")
            if (decodedId.startsWith("native:")) {
                const nativePath = decodedId.replace("native:", "");

                const nativeCacheHit = resolveNativeCoverCacheHit(nativePath);
                if (nativeCacheHit) {
                    const canonicalNativePath = nativeCacheHit.resolvedNativePath;
                    if (canonicalNativePath !== nativePath) {
                        const canonicalNativeCoverUrl =
                            `native:${canonicalNativePath}`;
                        const canonicalAlbumId =
                            getAlbumIdFromNativeCoverPath(canonicalNativePath);
                        /* istanbul ignore else -- native cache hit candidates always normalize to file-name ids */
                        if (canonicalAlbumId) {
                            void persistHealedAlbumCover(
                                canonicalAlbumId,
                                canonicalNativeCoverUrl
                            ).catch((error) => {
                                logger.warn(
                                    `[COVER-ART] Failed to backfill canonical native path for album ${canonicalAlbumId}:`,
                                    error
                                );
                            });
                        }
                        logger.debug(
                            `[COVER-ART] Resolved legacy native cover path ${nativePath} -> ${canonicalNativePath}`
                        );
                    }

                    // Serve the file directly
                    const requestOrigin = req.headers.origin;
                    const headers: Record<string, string> = {
                        "Content-Type": "image/jpeg",
                        "Cache-Control": COVER_ART_IMAGE_CACHE_CONTROL,
                        "Cross-Origin-Resource-Policy": "cross-origin",
                    };
                    if (requestOrigin) {
                        headers["Access-Control-Allow-Origin"] = requestOrigin;
                        headers["Access-Control-Allow-Credentials"] = "true";
                    } else {
                        headers["Access-Control-Allow-Origin"] = "*";
                    }

                    return res.sendFile(nativeCacheHit.cachePath, {
                        headers,
                    });
                }

                // Native cover file missing - try to find album and fetch from Deezer
                const missingCoverCachePath = getNativeCoverCachePath(nativePath);
                logger.warn(
                    `[COVER-ART] Native cover not found: ${missingCoverCachePath}, trying Deezer fallback`
                );

                try {
                    const deezerCover =
                        await tryHealMissingNativeAlbumCover(nativePath);
                    if (deezerCover) {
                        // Redirect to the Deezer cover
                        return res.redirect(deezerCover);
                    }
                } catch (error) {
                    logger.error(
                        `[COVER-ART] Failed to fetch Deezer fallback for native path ${nativePath}:`,
                        error
                    );
                }

                return sendRouteError(res, 404, "Cover art not found");
            }

            // Check if this is an audiobook cover (prefixed with "audiobook__")
            if (decodedId.startsWith("audiobook__")) {
                const audiobookPath = decodedId.replace("audiobook__", "");

                // Get Audiobookshelf settings
                const settings = await getSystemSettings();
                const audiobookshelfUrl =
                    settings?.audiobookshelfUrl ||
                    process.env.AUDIOBOOKSHELF_URL ||
                    "";
                const audiobookshelfApiKey =
                    settings?.audiobookshelfApiKey ||
                    process.env.AUDIOBOOKSHELF_API_KEY ||
                    "";
                const audiobookshelfBaseUrl = audiobookshelfUrl.replace(
                    /\/$/,
                    ""
                );

                coverUrl = `${audiobookshelfBaseUrl}/api/${audiobookPath}`;

                // Fetch with authentication
                logger.debug(
                    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(
                        0,
                        100
                    )}...`
                );
                const imageResponse = await fetch(coverUrl, {
                    headers: {
                        Authorization: `Bearer ${audiobookshelfApiKey}`,
                        "User-Agent": BRAND_USER_AGENT,
                    },
                });

                if (!imageResponse.ok) {
                    logger.error(
                        `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
                    );
                    return res
                        .status(404)
                        .json({ error: "Audiobook cover art not found" });
                }

                const buffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(buffer);
                const contentType = imageResponse.headers.get("content-type");

                if (contentType) {
                    res.setHeader("Content-Type", contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    COVER_ART_IMAGE_CACHE_CONTROL
                );

                return res.send(imageBuffer);
            }
            // Check if coverId is already a full URL (from Cover Art Archive or elsewhere)
            else if (
                decodedId.startsWith("http://") ||
                decodedId.startsWith("https://")
            ) {
                coverUrl = decodedId;
            } else {
                // Treat as album ID — on-demand cover art fetch for albums with null coverUrl
                const album = await prisma.album.findUnique({
                    where: { id: decodedId },
                    select: {
                        id: true,
                        title: true,
                        rgMbid: true,
                        coverUrl: true,
                        artist: { select: { name: true } },
                    },
                });

                if (!album) {
                    return sendRouteError(res, 404, "Album not found");
                }

                // If album already has a cover URL, redirect to it
                if (album.coverUrl) {
                    const redirectUrl = album.coverUrl.startsWith("native:")
                        ? `/api/library/cover-art?url=${encodeURIComponent(album.coverUrl)}`
                        : album.coverUrl;
                    return res.redirect(redirectUrl);
                }

                // On-demand fetch: try to find cover art now
                let fetchedCoverUrl: string | null = null;
                const validRgMbid =
                    typeof album.rgMbid === "string" &&
                    album.rgMbid.length > 0 &&
                    !album.rgMbid.startsWith("temp-")
                        ? album.rgMbid
                        : null;

                // Clear stale NOT_FOUND cache so retry uses improved matching
                if (validRgMbid) {
                    await coverArtService.clearNotFoundCache(validRgMbid);
                    try {
                        fetchedCoverUrl = await coverArtService.getCoverArt(validRgMbid);
                    } catch (err) {
                        logger.warn(`[COVER-ART] On-demand CAA fetch failed for ${validRgMbid}:`, err);
                    }
                }

                if (!fetchedCoverUrl && album.artist) {
                    try {
                        fetchedCoverUrl = await deezerService.getAlbumCover(
                            album.artist.name,
                            album.title
                        );
                    } catch (err) {
                        logger.warn(
                            `[COVER-ART] On-demand Deezer fetch failed for ${album.artist.name} - ${album.title}:`,
                            err
                        );
                    }
                }

                if (fetchedCoverUrl) {
                    // Persist the discovered cover URL
                    void persistHealedAlbumCover(album.id, fetchedCoverUrl).catch((err) => {
                        logger.warn(`[COVER-ART] Failed to persist on-demand cover for album ${album.id}:`, err);
                    });
                    coverUrl = fetchedCoverUrl;
                } else {
                    return sendRouteError(res, 404, "Cover art not found");
                }
            }
        }

        const normalizedCoverUrl = normalizeExternalImageUrl(coverUrl);
        if (!normalizedCoverUrl) {
            logger.warn(`[COVER-ART] Blocked invalid cover URL: ${coverUrl}`);
            return sendRouteError(res, 400, "Invalid cover art URL");
        }
        coverUrl = normalizedCoverUrl;

        // Create cache key from URL + size
        const cacheKey = `cover-art:${crypto
            .createHash("md5")
            .update(`${coverUrl}-${size || "original"}`)
            .digest("hex")}`;

        // Try to get from Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const cachedData = JSON.parse(cached);

                // Check if this is a cached 404
                if (cachedData.notFound) {
                    logger.debug(
                        `[COVER-ART] Cached 404 for ${coverUrl.substring(
                            0,
                            60
                        )}...`
                    );
                    return res
                        .status(404)
                        .json({ error: "Cover art not found" });
                }

                logger.debug(
                    `[COVER-ART] Cache HIT for ${coverUrl.substring(0, 60)}...`
                );
                const imageBuffer = Buffer.from(cachedData.data, "base64");

                // Check if client has cached version
                if (req.headers["if-none-match"] === cachedData.etag) {
                    logger.debug(`[COVER-ART] Client has cached version (304)`);
                    return res.status(304).end();
                }

                // Set headers and send cached image
                if (cachedData.contentType) {
                    res.setHeader("Content-Type", cachedData.contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    COVER_ART_IMAGE_CACHE_CONTROL
                );
                res.setHeader("ETag", cachedData.etag);
                return res.send(imageBuffer);
            } else {
                logger.debug(
                    `[COVER-ART] ✗ Cache MISS for ${coverUrl.substring(
                        0,
                        60
                    )}...`
                );
            }
        } catch (cacheError) {
            logger.warn("[COVER-ART] Redis cache read error:", cacheError);
        }

        // Fetch and proxy image with URL validation + safe redirect handling
        logger.debug(`[COVER-ART] Fetching: ${coverUrl.substring(0, 100)}...`);
        const imageResult = await fetchExternalImage({
            url: coverUrl,
            timeoutMs: 15000,
            maxRetries: 3,
        });

        if (!imageResult.ok) {
            if (imageResult.status === "invalid_url") {
                logger.warn(
                    `[COVER-ART] Blocked invalid cover URL: ${imageResult.url}`
                );
                return sendRouteError(res, 400, "Invalid cover art URL");
            }

            if (imageResult.status === "not_found") {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS,
                        JSON.stringify({ notFound: true })
                    );
                    logger.debug(
                        `[COVER-ART] Cached 404 response for ${COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS}s`
                    );
                } catch (cacheError) {
                    logger.warn("[COVER-ART] Redis cache write error:", cacheError);
                }

                return sendRouteError(res, 404, "Cover art not found");
            }

            logger.error(
                `[COVER-ART] Failed to fetch: ${imageResult.url} (${imageResult.message || "fetch error"})`
            );
            return sendRouteError(res, 502, "Failed to fetch cover art");
        }

        logger.debug(`[COVER-ART] Successfully fetched, caching...`);
        const imageBuffer = imageResult.buffer;
        const etag = imageResult.etag;

        // Cache in Redis for 7 days
        try {
            await redisClient.setEx(
                cacheKey,
                COVER_ART_IMAGE_CACHE_TTL_SECONDS,
                JSON.stringify({
                    etag,
                    contentType: imageResult.contentType,
                    data: imageBuffer.toString("base64"),
                })
            );
        } catch (cacheError) {
            logger.warn("Redis cache write error:", cacheError);
        }

        // Check if client has cached version
        if (req.headers["if-none-match"] === etag) {
            return res.status(304).end();
        }

        // Set appropriate headers
        if (imageResult.contentType) {
            res.setHeader("Content-Type", imageResult.contentType);
        }

        // Set aggressive caching headers
        applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
        res.setHeader("Cache-Control", COVER_ART_IMAGE_CACHE_CONTROL);
        res.setHeader("ETag", etag);

        // Send the image
        res.send(imageBuffer);
    } catch (error) {
        logger.error("Get cover art error:", error);
        sendInternalRouteError(res, "Failed to fetch cover art");
    }
});

/**
 * @openapi
 * /api/library/album-cover/{mbid}:
 *   get:
 *     summary: Fetch and cache album cover art by MusicBrainz release group ID
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: mbid
 *         required: true
 *         schema:
 *           type: string
 *         description: MusicBrainz release group MBID
 *     responses:
 *       200:
 *         description: Cover art URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 coverUrl:
 *                   type: string
 *       204:
 *         description: No cover art available for this MBID
 *       400:
 *         description: Valid MBID required
 *       401:
 *         description: Not authenticated
 */
// GET /library/album-cover/:mbid - Fetch and cache album cover by MBID
// This is called lazily by the frontend when an album doesn't have a cached cover
router.get("/album-cover/:mbid", imageLimiter, async (req, res) => {
    try {
        const { mbid } = req.params;

        if (!mbid || mbid.startsWith("temp-")) {
            return sendRouteError(res, 400, "Valid MBID required");
        }

        // Fetch from Cover Art Archive (this uses caching internally)
        const coverUrl = await coverArtService.getCoverArt(mbid);

        if (!coverUrl) {
            // Return 204 No Content instead of 404 to avoid console spam
            // Cover Art Archive doesn't have covers for all albums
            return res.status(204).send();
        }

        res.json({ coverUrl });
    } catch (error) {
        logger.error("Get album cover error:", error);
        sendInternalRouteError(res, "Failed to fetch cover art");
    }
});

/**
 * @openapi
 * /api/library/cover-art-colors:
 *   get:
 *     summary: Extract dominant colors from a cover art image
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 *         description: Cover art image URL to extract colors from
 *     responses:
 *       200:
 *         description: Extracted color palette
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vibrant:
 *                   type: string
 *                 darkVibrant:
 *                   type: string
 *                 lightVibrant:
 *                   type: string
 *                 muted:
 *                   type: string
 *                 darkMuted:
 *                   type: string
 *                 lightMuted:
 *                   type: string
 *       400:
 *         description: URL parameter required or invalid
 *       404:
 *         description: Image not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/cover-art-colors?url= - Extract colors from a cover art URL
router.get("/cover-art-colors", imageLimiter, async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return sendRouteError(res, 400, "URL parameter required");
        }

        const rawImageUrl = Array.isArray(url) ? url[0] : url;
        const imageUrl =
            typeof rawImageUrl === "string"
                ? rawImageUrl
                : String(rawImageUrl);
        const normalizedImageUrl = normalizeExternalImageUrl(imageUrl);
        if (!normalizedImageUrl) {
            logger.warn(`[COLORS] Blocked invalid image URL: ${imageUrl}`);
            return sendRouteError(res, 400, "Invalid image URL");
        }

        // Handle placeholder images - return default fallback colors
        if (
            normalizedImageUrl.includes("placeholder") ||
            normalizedImageUrl.startsWith("/placeholder")
        ) {
            logger.debug(
                `[COLORS] Placeholder image detected, returning fallback colors`
            );
            return res.json({
                vibrant: "#1db954",
                darkVibrant: "#121212",
                lightVibrant: "#181818",
                muted: "#535353",
                darkMuted: "#121212",
                lightMuted: "#b3b3b3",
            });
        }

        // Create cache key for colors
        const cacheKey = `colors:${crypto
            .createHash("md5")
            .update(normalizedImageUrl)
            .digest("hex")}`;

        // Try to get from Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(
                    `[COLORS] Cache HIT for ${normalizedImageUrl.substring(0, 60)}...`
                );
                return res.json(JSON.parse(cached));
            } else {
                logger.debug(
                    `[COLORS] ✗ Cache MISS for ${normalizedImageUrl.substring(0, 60)}...`
                );
            }
        } catch (cacheError) {
            logger.warn("[COLORS] Redis cache read error:", cacheError);
        }

        // Fetch the image
        logger.debug(
            `[COLORS] Fetching image: ${normalizedImageUrl.substring(0, 100)}...`
        );
        const imageResult = await fetchExternalImage({
            url: normalizedImageUrl,
            timeoutMs: 15000,
            maxRetries: 2,
        });

        if (!imageResult.ok) {
            if (imageResult.status === "not_found") {
                logger.error(
                    `[COLORS] Failed to fetch image: ${imageResult.url} (404)`
                );
                return sendRouteError(res, 404, "Image not found");
            }

            logger.error(
                `[COLORS] Failed to fetch image: ${imageResult.url} (${imageResult.message || "fetch error"})`
            );
            return sendRouteError(res, 504, "Image fetch failed");
        }

        const imageBuffer = imageResult.buffer;

        // Extract colors using sharp
        const colors = await extractColorsFromImage(imageBuffer);

        logger.debug(`[COLORS] Extracted colors:`, colors);

        // Cache the result for 30 days
        try {
            await redisClient.setEx(
                cacheKey,
                30 * 24 * 60 * 60, // 30 days
                JSON.stringify(colors)
            );
            logger.debug(`[COLORS] Cached colors for 30 days`);
        } catch (cacheError) {
            logger.warn("[COLORS] Redis cache write error:", cacheError);
        }

        res.json(colors);
    } catch (error) {
        logger.error("Extract colors error:", error);
        sendInternalRouteError(res, "Failed to extract colors");
    }
});

/**
 * @openapi
 * /api/library/tracks/{id}/stream:
 *   get:
 *     summary: Stream an audio track with optional quality transcoding
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *           enum: [original, high, medium, low]
 *         description: Streaming quality (defaults to user preference)
 *     responses:
 *       200:
 *         description: Audio stream
 *         content:
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       206:
 *         description: Partial content (range request)
 *       404:
 *         description: Track not found or not available
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id/stream
router.get("/tracks/:id/stream", async (req, res) => {
    try {
        logger.debug("[STREAM] Request received for track:", req.params.id);
        const { quality } = req.query;
        const userId = req.user?.id;

        if (!userId) {
            logger.debug("[STREAM] No userId in session - unauthorized");
            return sendRouteError(res, 401, "Unauthorized");
        }

        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
        });

        if (!track) {
            logger.debug("[STREAM] Track not found");
            return sendRouteError(res, 404, "Track not found");
        }

        // Log play start - only if this is a new playback session
        const recentPlay = await prisma.play.findFirst({
            where: {
                userId,
                trackId: track.id,
                playedAt: {
                    gte: new Date(Date.now() - 30 * 1000),
                },
            },
            orderBy: { playedAt: "desc" },
        });

        if (!recentPlay) {
            await prisma.play.create({
                data: {
                    userId,
                    trackId: track.id,
                },
            });
            logger.debug("[STREAM] Logged new play for track:", track.title);
        }

        // Get user's quality preference
        let requestedQuality: string = "medium";
        if (quality) {
            requestedQuality = quality as string;
        } else {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            requestedQuality = settings?.playbackQuality || "medium";
        }

        const ext = track.filePath
            ? path.extname(track.filePath).toLowerCase()
            : "";
        logger.debug(
            `[STREAM] Quality: requested=${
                quality || "default"
            }, using=${requestedQuality}, format=${ext}`
        );

        // === NATIVE FILE STREAMING ===
        // Check if track has native file path
        if (track.filePath && track.fileModified) {
            try {
                // Initialize streaming service
                const streamingService = new AudioStreamingService(
                    config.music.musicPath,
                    config.music.transcodeCachePath,
                    config.music.transcodeCacheMaxGb
                );

                // Get absolute path to source file
                // Normalize path separators for cross-platform compatibility (Windows -> Linux)
                const normalizedFilePath = track.filePath.replace(/\\/g, "/");
                const absolutePath = path.join(
                    config.music.musicPath,
                    normalizedFilePath
                );

                logger.debug(
                    `[STREAM] Using native file: ${track.filePath} (${requestedQuality})`
                );

                // Get stream file (either original or transcoded)
                const { filePath, mimeType } =
                    await streamingService.getStreamFilePath(
                        track.id,
                        requestedQuality as any,
                        track.fileModified,
                        absolutePath
                    );

                // Stream file with range support
                logger.debug(
                    `[STREAM] Sending file: ${filePath}, mimeType: ${mimeType}`
                );

                await streamingService.streamFileWithRangeSupport(
                    req,
                    res,
                    filePath,
                    mimeType
                );
                streamingService.destroy();
                logger.debug(
                    `[STREAM] File sent successfully: ${path.basename(
                        filePath
                    )}`
                );

                return;
            } catch (err: any) {
                // If FFmpeg not found, try original quality instead
                if (
                    err.code === "FFMPEG_NOT_FOUND" &&
                    requestedQuality !== "original"
                ) {
                    logger.warn(
                        `[STREAM] FFmpeg not available, falling back to original quality`
                    );
                    const fallbackFilePath = track.filePath.replace(/\\/g, "/");
                    const absolutePath = path.join(
                        config.music.musicPath,
                        fallbackFilePath
                    );

                    const streamingService = new AudioStreamingService(
                        config.music.musicPath,
                        config.music.transcodeCachePath,
                        config.music.transcodeCacheMaxGb
                    );

                    const { filePath, mimeType } =
                        await streamingService.getStreamFilePath(
                            track.id,
                            "original",
                            track.fileModified,
                            absolutePath
                        );

                    await streamingService.streamFileWithRangeSupport(
                        req,
                        res,
                        filePath,
                        mimeType
                    );
                    streamingService.destroy();
                    return;
                }

                logger.error("[STREAM] Native streaming failed:", err.message);
                return res
                    .status(500)
                    .json({ error: "Failed to stream track" });
            }
        }

        // No file path available
        logger.debug("[STREAM] Track has no file path - unavailable");
        return sendRouteError(res, 404, "Track not available");
    } catch (error) {
        logger.error("Stream track error:", error);
        sendInternalRouteError(res, "Failed to stream track");
    }
});

/**
 * @openapi
 * /api/library/tracks/{id}/preference:
 *   get:
 *     summary: Get the current user's preference (like/dislike) for a track
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     responses:
 *       200:
 *         description: Track preference state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trackId:
 *                   type: string
 *                 signal:
 *                   type: string
 *                 state:
 *                   type: string
 *                 score:
 *                   type: number
 *                 likedAt:
 *                   type: string
 *                   nullable: true
 *                 dislikedAt:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id/preference
router.get("/tracks/:id/preference", async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return sendRouteError(res, 401, "Authentication required");
        }

        const trackId = req.params.id;
        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: { id: true },
        });
        if (!track) {
            return sendRouteError(res, 404, "Track not found");
        }

        const [likedEntry, dislikedEntry] = await Promise.all([
            prisma.likedTrack.findUnique({
                where: {
                    userId_trackId: {
                        userId,
                        trackId,
                    },
                },
                select: {
                    likedAt: true,
                },
            }),
            prisma.dislikedEntity.findUnique({
                where: {
                    userId_entityType_entityId: {
                        userId,
                        entityType: TRACK_DISLIKE_ENTITY_TYPE,
                        entityId: trackId,
                    },
                },
                select: {
                    dislikedAt: true,
                },
            }),
        ]);

        const preference = resolveTrackPreference({
            likedAt: likedEntry?.likedAt ?? null,
            dislikedAt: dislikedEntry?.dislikedAt ?? null,
        });

        res.json(formatTrackPreferenceResponse(trackId, preference));
    } catch (error) {
        logger.error("Get track preference error:", error);
        sendInternalRouteError(res, "Failed to fetch track preference");
    }
});

/**
 * @openapi
 * /api/library/albums/{id}/preference:
 *   post:
 *     summary: Set preference (like/dislike) for all tracks in an album
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID or release group MBID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [thumbs_up, thumbs_down, clear]
 *     responses:
 *       200:
 *         description: Album preference set successfully
 *       400:
 *         description: Invalid preference signal
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
// POST /library/albums/:id/preference
router.post("/albums/:id/preference", async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return sendRouteError(res, 401, "Authentication required");
        }

        const requestedAlbumId = req.params.id;
        const signal = normalizeTrackPreferenceSignal(
            req.body?.signal ?? req.body?.score ?? req.body?.action
        );

        if (!signal) {
            return res.status(400).json({
                error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
            });
        }

        const album = await prisma.album.findFirst({
            where: {
                OR: [{ id: requestedAlbumId }, { rgMbid: requestedAlbumId }],
            },
            select: {
                id: true,
            },
        });
        if (!album) {
            return sendRouteError(res, 404, "Album not found");
        }

        const albumTracks = await prisma.track.findMany({
            where: { albumId: album.id },
            select: { id: true },
        });
        const trackIds = Array.from(
            new Set(
                albumTracks
                    .map((track) => track.id)
                    .filter(
                        (trackId): trackId is string =>
                            typeof trackId === "string" && trackId.length > 0
                    )
            )
        );
        const now = new Date();

        if (trackIds.length > 0) {
            await prisma.$transaction(async (tx) => {
                await applyTrackPreferenceSignalToTrackIds(
                    tx,
                    userId,
                    trackIds,
                    signal,
                    now
                );
            });
        }

        const preference = resolveTrackPreference({
            likedAt: signal === "thumbs_up" ? now : null,
            dislikedAt: signal === "thumbs_down" ? now : null,
        });

        res.json(
            formatAlbumPreferenceResponse(
                album.id,
                trackIds.length,
                preference
            )
        );
    } catch (error) {
        logger.error("Set album preference error:", error);
        sendInternalRouteError(res, "Failed to set album preference");
    }
});

/**
 * @openapi
 * /api/library/tracks/{id}/preference:
 *   post:
 *     summary: Set preference (like/dislike/clear) for a track
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [thumbs_up, thumbs_down, clear]
 *     responses:
 *       200:
 *         description: Track preference set successfully
 *       400:
 *         description: Invalid preference signal
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// POST /library/tracks/:id/preference
router.post("/tracks/:id/preference", async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return sendRouteError(res, 401, "Authentication required");
        }

        const trackId = req.params.id;
        const signal = normalizeTrackPreferenceSignal(
            req.body?.signal ?? req.body?.score ?? req.body?.action
        );

        if (!signal) {
            return res.status(400).json({
                error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
            });
        }

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: { id: true },
        });
        if (!track) {
            return sendRouteError(res, 404, "Track not found");
        }

        const now = new Date();

        if (signal === "thumbs_up") {
            await prisma.likedTrack.upsert({
                where: {
                    userId_trackId: {
                        userId,
                        trackId,
                    },
                },
                create: {
                    userId,
                    trackId,
                    likedAt: now,
                },
                update: {
                    likedAt: now,
                },
            });
            await prisma.dislikedEntity.deleteMany({
                where: {
                    userId,
                    entityType: TRACK_DISLIKE_ENTITY_TYPE,
                    entityId: trackId,
                },
            });
        } else if (signal === "thumbs_down") {
            await prisma.dislikedEntity.upsert({
                where: {
                    userId_entityType_entityId: {
                        userId,
                        entityType: TRACK_DISLIKE_ENTITY_TYPE,
                        entityId: trackId,
                    },
                },
                create: {
                    userId,
                    entityType: TRACK_DISLIKE_ENTITY_TYPE,
                    entityId: trackId,
                    dislikedAt: now,
                },
                update: {
                    dislikedAt: now,
                },
            });
            await prisma.likedTrack.deleteMany({
                where: {
                    userId,
                    trackId,
                },
            });
        } else {
            await prisma.likedTrack.deleteMany({
                where: {
                    userId,
                    trackId,
                },
            });
            await prisma.dislikedEntity.deleteMany({
                where: {
                    userId,
                    entityType: TRACK_DISLIKE_ENTITY_TYPE,
                    entityId: trackId,
                },
            });
        }

        const preference = resolveTrackPreference({
            likedAt: signal === "thumbs_up" ? now : null,
            dislikedAt: signal === "thumbs_down" ? now : null,
        });

        res.json(formatTrackPreferenceResponse(trackId, preference));
    } catch (error) {
        logger.error("Set track preference error:", error);
        sendInternalRouteError(res, "Failed to set track preference");
    }
});

/**
 * @openapi
 * /api/library/tracks/{id}:
 *   get:
 *     summary: Get a single track by ID
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     responses:
 *       200:
 *         description: Track details with artist and album info
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id
router.get("/tracks/:id", async (req, res) => {
    try {
        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
        });

        if (!track) {
            return sendRouteError(res, 404, "Track not found");
        }

        // Transform to match frontend Track interface: artist at top level
        const formattedTrack = {
            id: track.id,
            title: track.title,
            artist: {
                name: track.album?.artist?.name || "Unknown Artist",
                id: track.album?.artist?.id,
            },
            album: {
                title: track.album?.title || "Unknown Album",
                coverArt: track.album?.coverUrl,
                id: track.album?.id,
            },
            duration: track.duration,
        };

        res.json(formattedTrack);
    } catch (error) {
        logger.error("Get track error:", error);
        sendInternalRouteError(res, "Failed to fetch track");
    }
});

/**
 * @openapi
 * /api/library/tracks/{id}/audio-info:
 *   get:
 *     summary: Get audio quality metadata for a track (codec, bitrate, sample rate, etc.)
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *       - in: query
 *         name: playback
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, return info for the transcoded playback file instead of the source
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *           enum: [original, high, medium, low]
 *         description: Quality level for playback info (defaults to user preference)
 *     responses:
 *       200:
 *         description: Audio metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 codec:
 *                   type: string
 *                   nullable: true
 *                 bitrate:
 *                   type: number
 *                   nullable: true
 *                 sampleRate:
 *                   type: number
 *                   nullable: true
 *                 bitDepth:
 *                   type: number
 *                   nullable: true
 *                 lossless:
 *                   type: boolean
 *                   nullable: true
 *                 channels:
 *                   type: number
 *                   nullable: true
 *       404:
 *         description: Track or file not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id/audio-info
// Returns audio quality metadata (bitrate, sample rate, bit depth, codec)
// by probing the file on disk with music-metadata. Uses a short-lived
// in-process cache keyed by track/file identity to avoid repeated probes.
router.get("/tracks/:id/audio-info", requireAuth, async (req, res) => {
    try {
        const trackId = req.params.id;
        const playback = parseBooleanQueryParam(req.query.playback, false);
        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                filePath: true,
                fileModified: true,
            },
        });

        if (!track?.filePath) {
            return sendRouteError(res, 404, "Track not found");
        }

        const absolutePath = resolveAudioInfoAbsolutePath(track.filePath);
        if (!fs.existsSync(absolutePath)) {
            return sendRouteError(res, 404, "File not found on disk");
        }

        let metadataPath = absolutePath;
        let cacheScope: "source" | "playback" = "source";
        let cacheQuality: StreamingQuality | null = null;

        if (playback) {
            const userId = req.user?.id;
            if (!userId) {
                return sendRouteError(res, 401, "Unauthorized");
            }

            const queryQuality = normalizeStreamingQuality(req.query.quality);
            let requestedQuality: StreamingQuality = queryQuality ?? "medium";

            if (!queryQuality) {
                const userSettings = await prisma.userSettings.findUnique({
                    where: { userId },
                    select: { playbackQuality: true },
                });
                requestedQuality =
                    normalizeStreamingQuality(userSettings?.playbackQuality) ??
                    "medium";
            }

            const streamingService = new AudioStreamingService(
                config.music.musicPath,
                config.music.transcodeCachePath,
                config.music.transcodeCacheMaxGb
            );

            try {
                const playbackFile = await streamingService.getStreamFilePath(
                    trackId,
                    requestedQuality,
                    track.fileModified,
                    absolutePath
                );
                metadataPath = playbackFile.filePath;
                cacheScope = "playback";
                cacheQuality = requestedQuality;
            } finally {
                streamingService.destroy();
            }
        }

        const cacheKey = buildAudioInfoCacheKey(trackId, track.filePath, track.fileModified, {
            scope: cacheScope,
            quality: cacheQuality,
        });
        const now = Date.now();
        const cachedEntry = audioInfoCache.get(cacheKey);
        if (cachedEntry && cachedEntry.expiresAt > now) {
            return res.json(cachedEntry.payload);
        }
        if (cachedEntry) {
            audioInfoCache.delete(cacheKey);
        }

        if (!fs.existsSync(metadataPath)) {
            return sendRouteError(res, 404, "Playback file not found on disk");
        }

        const payload = await readAudioInfoPayload(metadataPath);

        audioInfoCache.set(cacheKey, {
            payload,
            expiresAt: now + AUDIO_INFO_CACHE_TTL_MS,
        });
        pruneAudioInfoCache(now);

        res.json(payload);
    } catch (error) {
        logger.error("Get audio info error:", error);
        sendInternalRouteError(res, "Failed to read audio metadata");
    }
});

/**
 * @openapi
 * /api/library/tracks/{id}:
 *   delete:
 *     summary: Delete a track from the library and filesystem
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     responses:
 *       200:
 *         description: Track deleted successfully
 *       403:
 *         description: Library deletion is disabled or not admin
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /library/tracks/:id
router.delete("/tracks/:id", requireAdmin, async (req, res) => {
    try {
        const deletionsEnabled = await isLibraryDeletionEnabled();
        if (!deletionsEnabled) {
            return res.status(403).json({
                error: "Library deletion is disabled in admin settings",
            });
        }

        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        if (!track) {
            return sendRouteError(res, 404, "Track not found");
        }

        // Delete file from filesystem if path is available
        if (track.filePath) {
            try {
                const absolutePath = path.join(
                    config.music.musicPath,
                    track.filePath
                );

                if (fs.existsSync(absolutePath)) {
                    fs.unlinkSync(absolutePath);
                    logger.debug(`[DELETE] Deleted file: ${absolutePath}`);
                }
            } catch (err) {
                logger.warn("[DELETE] Could not delete file:", err);
                // Continue with database deletion even if file deletion fails
            }
        }

        // Delete from database (cascade will handle related records)
        await prisma.track.delete({
            where: { id: track.id },
        });

        logger.debug(`[DELETE] Deleted track: ${track.title}`);

        res.json({ message: "Track deleted successfully" });
    } catch (error) {
        logger.error("Delete track error:", error);
        sendInternalRouteError(res, "Failed to delete track");
    }
});

/**
 * @openapi
 * /api/library/albums/{id}:
 *   delete:
 *     summary: Delete an album and its tracks from the library and filesystem
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID
 *     responses:
 *       200:
 *         description: Album deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 deletedFiles:
 *                   type: integer
 *       403:
 *         description: Library deletion is disabled or not admin
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /library/albums/:id
router.delete("/albums/:id", requireAdmin, async (req, res) => {
    try {
        const deletionsEnabled = await isLibraryDeletionEnabled();
        if (!deletionsEnabled) {
            return res.status(403).json({
                error: "Library deletion is disabled in admin settings",
            });
        }

        const album = await prisma.album.findUnique({
            where: { id: req.params.id },
            include: {
                artist: true,
                tracks: {
                    include: {
                        album: true,
                    },
                },
            },
        });

        if (!album) {
            return sendRouteError(res, 404, "Album not found");
        }

        // Delete all track files
        let deletedFiles = 0;
        for (const track of album.tracks) {
            if (track.filePath) {
                try {
                    const absolutePath = path.join(
                        config.music.musicPath,
                        track.filePath
                    );

                    if (fs.existsSync(absolutePath)) {
                        fs.unlinkSync(absolutePath);
                        deletedFiles++;
                    }
                } catch (err) {
                    logger.warn("[DELETE] Could not delete file:", err);
                }
            }
        }

        // Try to delete album folder if empty
        try {
            const artistName = album.artist.name;
            const albumFolder = path.join(
                config.music.musicPath,
                artistName,
                album.title
            );

            if (fs.existsSync(albumFolder)) {
                const files = fs.readdirSync(albumFolder);
                if (files.length === 0) {
                    fs.rmdirSync(albumFolder);
                    logger.debug(
                        `[DELETE] Deleted empty album folder: ${albumFolder}`
                    );
                }
            }
        } catch (err) {
            logger.warn("[DELETE] Could not delete album folder:", err);
        }

        // Delete from database (cascade will delete tracks)
        await prisma.album.delete({
            where: { id: album.id },
        });

        logger.debug(
            `[DELETE] Deleted album: ${album.title} (${deletedFiles} files)`
        );

        res.json({
            message: "Album deleted successfully",
            deletedFiles,
        });
    } catch (error) {
        logger.error("Delete album error:", error);
        sendInternalRouteError(res, "Failed to delete album");
    }
});

/**
 * @openapi
 * /api/library/artists/{id}:
 *   delete:
 *     summary: Delete an artist and all their albums/tracks from the library and filesystem
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Artist ID
 *     responses:
 *       200:
 *         description: Artist deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 deletedFiles:
 *                   type: integer
 *                 lidarrDeleted:
 *                   type: boolean
 *                 lidarrError:
 *                   type: string
 *                   nullable: true
 *       403:
 *         description: Library deletion is disabled or not admin
 *       404:
 *         description: Artist not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /library/artists/:id
router.delete("/artists/:id", requireAdmin, async (req, res) => {
    try {
        const deletionsEnabled = await isLibraryDeletionEnabled();
        if (!deletionsEnabled) {
            return res.status(403).json({
                error: "Library deletion is disabled in admin settings",
            });
        }

        const artist = await prisma.artist.findUnique({
            where: { id: req.params.id },
            include: {
                albums: {
                    include: {
                        tracks: true,
                    },
                },
            },
        });

        if (!artist) {
            return sendRouteError(res, 404, "Artist not found");
        }

        // Delete all track files and collect actual artist folders from file paths
        let deletedFiles = 0;
        const artistFoldersToDelete = new Set<string>();

        for (const album of artist.albums) {
            for (const track of album.tracks) {
                if (track.filePath) {
                    try {
                        const absolutePath = path.join(
                            config.music.musicPath,
                            track.filePath
                        );

                        if (fs.existsSync(absolutePath)) {
                            fs.unlinkSync(absolutePath);
                            deletedFiles++;

                            // Extract actual artist folder from file path
                            // Path format: Soulseek/Artist/Album/Track.mp3 OR Artist/Album/Track.mp3
                            const pathParts = track.filePath.split(path.sep);
                            if (pathParts.length >= 2) {
                                // If first part is "Soulseek", artist folder is Soulseek/Artist
                                // Otherwise, artist folder is just Artist
                                const actualArtistFolder =
                                    pathParts[0].toLowerCase() === "soulseek"
                                        ? path.join(
                                              config.music.musicPath,
                                              pathParts[0],
                                              pathParts[1]
                                          )
                                        : path.join(
                                              config.music.musicPath,
                                              pathParts[0]
                                          );
                                artistFoldersToDelete.add(actualArtistFolder);
                            } else if (pathParts.length === 1) {
                                // Single-level path (rare case)
                                const actualArtistFolder = path.join(
                                    config.music.musicPath,
                                    pathParts[0]
                                );
                                artistFoldersToDelete.add(actualArtistFolder);
                            }
                        }
                    } catch (err) {
                        logger.warn("[DELETE] Could not delete file:", err);
                    }
                }
            }
        }

        // Delete artist folders based on actual file paths, not database name
        for (const artistFolder of artistFoldersToDelete) {
            try {
                if (fs.existsSync(artistFolder)) {
                    logger.debug(
                        `[DELETE] Attempting to delete folder: ${artistFolder}`
                    );

                    // Always try recursive delete with force
                    fs.rmSync(artistFolder, {
                        recursive: true,
                        force: true,
                    });
                    logger.debug(
                        `[DELETE] Successfully deleted artist folder: ${artistFolder}`
                    );
                }
            } catch (err: any) {
                logger.error(
                    `[DELETE] Failed to delete artist folder ${artistFolder}:`,
                    err?.message || err
                );

                // Try alternative: delete contents first, then folder
                try {
                    const files = fs.readdirSync(artistFolder);
                    for (const file of files) {
                        const filePath = path.join(artistFolder, file);
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filePath, {
                                    recursive: true,
                                    force: true,
                                });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                            logger.debug(`[DELETE] Deleted: ${filePath}`);
                        } catch (fileErr: any) {
                            logger.error(
                                `[DELETE] Could not delete ${filePath}:`,
                                fileErr?.message
                            );
                        }
                    }
                    // Try deleting the now-empty folder
                    fs.rmdirSync(artistFolder);
                    logger.debug(
                        `[DELETE] Deleted artist folder after manual cleanup: ${artistFolder}`
                    );
                } catch (cleanupErr: any) {
                    logger.error(
                        `[DELETE] Cleanup also failed for ${artistFolder}:`,
                        cleanupErr?.message
                    );
                }
            }
        }

        // Also try deleting from common music folder paths (in case tracks weren't indexed)
        const commonPaths = [
            path.join(config.music.musicPath, artist.name),
            path.join(config.music.musicPath, "Soulseek", artist.name),
            path.join(config.music.musicPath, "discovery", artist.name),
        ];

        for (const commonPath of commonPaths) {
            if (
                fs.existsSync(commonPath) &&
                !artistFoldersToDelete.has(commonPath)
            ) {
                try {
                    fs.rmSync(commonPath, { recursive: true, force: true });
                    logger.debug(
                        `[DELETE] Deleted additional artist folder: ${commonPath}`
                    );
                } catch (err: any) {
                    logger.error(
                        `[DELETE] Could not delete ${commonPath}:`,
                        err?.message
                    );
                }
            }
        }

        // Delete from Lidarr if connected and artist has MBID
        let lidarrDeleted = false;
        let lidarrError: string | null = null;
        if (artist.mbid && !artist.mbid.startsWith("temp-")) {
            try {
                const { lidarrService } = await import("../services/lidarr");
                const lidarrResult = await lidarrService.deleteArtist(
                    artist.mbid,
                    true
                );
                if (lidarrResult.success) {
                    logger.debug(`[DELETE] Lidarr: ${lidarrResult.message}`);
                    lidarrDeleted = true;
                } else {
                    logger.warn(
                        `[DELETE] Lidarr deletion note: ${lidarrResult.message}`
                    );
                    lidarrError = lidarrResult.message;
                }
            } catch (err: any) {
                logger.warn(
                    "[DELETE] Could not delete from Lidarr:",
                    err?.message || err
                );
                lidarrError = err?.message || "Unknown error";
            }
        }

        // Explicitly delete OwnedAlbum records first (should cascade, but being safe)
        try {
            await prisma.ownedAlbum.deleteMany({
                where: { artistId: artist.id },
            });
        } catch (err) {
            logger.warn("[DELETE] Could not delete OwnedAlbum records:", err);
        }

        // Delete from database (cascade will delete albums and tracks)
        logger.debug(
            `[DELETE] Deleting artist from database: ${artist.name} (${artist.id})`
        );
        await prisma.artist.delete({
            where: { id: artist.id },
        });

        logger.debug(
            `[DELETE] Successfully deleted artist: ${
                artist.name
            } (${deletedFiles} files${
                lidarrDeleted ? ", removed from Lidarr" : ""
            })`
        );

        res.json({
            message: "Artist deleted successfully",
            deletedFiles,
            lidarrDeleted,
            lidarrError,
        });
    } catch (error: any) {
        logger.error("Delete artist error:", error?.message || error);
        logger.error("Delete artist stack:", error?.stack);
        res.status(500).json({
            error: "Failed to delete artist",
            details: error?.message || "Unknown error",
        });
    }
});

/**
 * @openapi
 * /api/library/genres:
 *   get:
 *     summary: Get list of genres in the library with track counts
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of genres with track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 genres:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       genre:
 *                         type: string
 *                       count:
 *                         type: integer
 *       401:
 *         description: Not authenticated
 */
router.get("/genres", async (req, res) => {
    try {
        // Get artist names to filter them out of genres (they sometimes get incorrectly tagged)
        const artists = await prisma.artist.findMany({
            select: { name: true, normalizedName: true },
        });
        const artistNames = new Set(
            artists.flatMap((a) =>
                [a.name.toLowerCase(), a.normalizedName?.toLowerCase()].filter(
                    Boolean
                )
            )
        );

        // Query Artist.genres field (populated by enrichment from Last.fm tags)
        // Use raw SQL to expand JSONB array and count tracks per genre
        const minTracks = 15; // Minimum tracks for a genre to show up
        const genreResults = await prisma.$queryRaw<
            { genre: string; track_count: bigint }[]
        >`
            SELECT LOWER(g.genre) as genre, COUNT(DISTINCT t.id) as track_count
            FROM "Artist" ar
            CROSS JOIN LATERAL jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
            JOIN "Album" a ON a."artistId" = ar.id
            JOIN "Track" t ON t."albumId" = a.id
            WHERE ar.genres IS NOT NULL
            GROUP BY LOWER(g.genre)
            HAVING COUNT(DISTINCT t.id) >= ${minTracks}
            ORDER BY track_count DESC
            LIMIT 20
        `;

        // Filter out artist names and convert bigint to number
        const genres = genreResults
            .map((row) => ({
                genre: row.genre,
                count: Number(row.track_count),
            }))
            .filter((g) => !artistNames.has(g.genre.toLowerCase()));

        logger.debug(
            `[Genres] Found ${genres.length} genres from Artist.genres (min ${minTracks} tracks)`
        );

        res.json({ genres });
    } catch (error) {
        logger.error("Genres endpoint error:", error);
        sendInternalRouteError(res, "Failed to get genres");
    }
});

/**
 * @openapi
 * /api/library/decades:
 *   get:
 *     summary: Get available decades in the library with track counts
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of decades with track counts (only decades with 15+ tracks)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 decades:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       decade:
 *                         type: integer
 *                         example: 1990
 *                       count:
 *                         type: integer
 *       401:
 *         description: Not authenticated
 */
router.get("/decades", async (req, res) => {
    try {
        // Get all albums with year fields and track count
        const albums = await prisma.album.findMany({
            select: {
                year: true,
                originalYear: true,
                displayYear: true,
                _count: { select: { tracks: true } },
            },
        });

        // Group by decade using effective year (displayYear > originalYear > year)
        const decadeMap = new Map<number, number>();

        for (const album of albums) {
            const effectiveYear = getEffectiveYear(album);
            if (effectiveYear) {
                const decadeStart = getDecadeFromYear(effectiveYear);
                decadeMap.set(
                    decadeStart,
                    (decadeMap.get(decadeStart) || 0) + album._count.tracks
                );
            }
        }

        // Convert to array, filter by minimum tracks, and sort by decade
        const decades = Array.from(decadeMap.entries())
            .map(([decade, count]) => ({ decade, count }))
            .filter((d) => d.count >= 15) // Minimum 15 tracks for a radio station
            .sort((a, b) => b.decade - a.decade); // Newest first

        res.json({ decades });
    } catch (error) {
        logger.error("Decades endpoint error:", error);
        sendInternalRouteError(res, "Failed to get decades");
    }
});

/**
 * @openapi
 * /api/library/radio:
 *   get:
 *     summary: Get tracks for a library-based radio station
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [all, liked, discovery, favorites, decade, genre, mood, workout, artist, vibe]
 *         description: Radio station type
 *       - in: query
 *         name: value
 *         schema:
 *           type: string
 *         description: Value for the radio type (e.g. decade year, genre name, artist ID, track ID)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of tracks to return
 *     responses:
 *       200:
 *         description: Radio tracks queue
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 sourceFeatures:
 *                   type: object
 *                   description: Source track audio features (only for vibe mode)
 *       400:
 *         description: Radio type is required
 *       401:
 *         description: Not authenticated
 */
router.get("/radio", async (req, res) => {
    try {
        const { type, value, limit = "50" } = req.query;
        const radioType = typeof type === "string" ? type : "";
        const radioValue = typeof value === "string" ? value : undefined;
        const parsedLimit = Number.parseInt(String(limit), 10);
        const normalizedRequestedLimit =
            Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
        const limitNum =
            radioType === "liked"
                ? Math.min(normalizedRequestedLimit, MAX_LIMIT)
                : Math.min(normalizedRequestedLimit, 100);
        const userId = req.user?.id;

        if (!radioType) {
            return sendRouteError(res, 400, "Radio type is required");
        }

        let trackIds: string[] = [];
        let vibeSourceFeatures: any = null; // For vibe mode - store source track features

        switch (radioType) {
            case "discovery":
                // Lesser-played tracks - get tracks the user hasn't played or played least
                // First, get tracks with NO plays at all (truly undiscovered)
                const unplayedTracks = await prisma.track.findMany({
                    where: {
                        plays: { none: {} }, // No plays by anyone
                    },
                    select: { id: true },
                    take: limitNum * 2,
                });

                if (unplayedTracks.length >= limitNum) {
                    trackIds = unplayedTracks.map((t) => t.id);
                } else {
                    // Fallback: get tracks with the fewest plays using raw count
                    const leastPlayedTracks = await prisma.$queryRaw<
                        { id: string }[]
                    >`
                        SELECT t.id 
                        FROM "Track" t
                        LEFT JOIN "Play" p ON p."trackId" = t.id
                        GROUP BY t.id
                        ORDER BY COUNT(p.id) ASC
                        LIMIT ${limitNum * 2}
                    `;
                    trackIds = leastPlayedTracks.map((t) => t.id);
                }
                break;

            case "liked":
                if (!userId) {
                    return res.status(401).json({
                        error: "Authentication required for liked radio",
                    });
                }

                const likedTracks = await prisma.likedTrack.findMany({
                    where: { userId },
                    select: { trackId: true },
                    orderBy: { likedAt: "desc" },
                    take: limitNum,
                });
                trackIds = likedTracks.map((entry) => entry.trackId);
                logger.debug(
                    `[Radio:liked] Loaded ${trackIds.length} liked tracks for user ${userId}`
                );
                break;

            case "favorites":
                // Most-played tracks - use raw query for accurate count ordering
                const mostPlayedTracks = await prisma.$queryRaw<
                    { id: string; play_count: bigint }[]
                >`
                    SELECT t.id, COUNT(p.id) as play_count
                    FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    GROUP BY t.id
                    HAVING COUNT(p.id) > 0
                    ORDER BY play_count DESC
                    LIMIT ${limitNum * 2}
                `;

                if (mostPlayedTracks.length > 0) {
                    trackIds = mostPlayedTracks.map((t) => t.id);
                } else {
                    // No play data yet - just get random tracks
                    logger.debug(
                        "[Radio:favorites] No play data found, returning random tracks"
                    );
                    const randomTracks = await prisma.track.findMany({
                        select: { id: true },
                        take: limitNum * 2,
                    });
                    trackIds = randomTracks.map((t) => t.id);
                }
                break;

            case "decade":
                // Filter by decade (e.g., value = "1990" for 90s)
                const decadeStart = parseInt(radioValue || "2000", 10) || 2000;

                const decadeTracks = await prisma.track.findMany({
                    where: {
                        album: getDecadeWhereClause(decadeStart),
                    },
                    select: { id: true },
                    take: limitNum * 3,
                });
                trackIds = decadeTracks.map((t) => t.id);
                break;

            case "genre":
                // Filter by genre (uses Artist.genres and Artist.userGenres)
                const genreValue = (radioValue || "").toLowerCase();

                // Query Artist.genres and userGenres fields with raw SQL
                // Join Artist → Album → Track and filter by genre using LIKE for partial matching
                // Check BOTH canonical genres AND user-added genres (OR condition)
                const genreTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT DISTINCT t.id
                    FROM "Artist" ar
                    JOIN "Album" a ON a."artistId" = ar.id
                    JOIN "Track" t ON t."albumId" = a.id
                    WHERE (
                        (ar.genres IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
                            WHERE LOWER(g.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                        OR
                        (ar."userGenres" IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar."userGenres"::jsonb) AS ug(genre)
                            WHERE LOWER(ug.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                    )
                    LIMIT ${limitNum * 2}
                `;
                trackIds = genreTracks.map((t) => t.id);

                logger.debug(
                    `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" from Artist.genres and userGenres`
                );
                break;

            case "mood":
                // Mood-based filtering using audio analysis features
                const moodValue = (radioValue || "").toLowerCase();
                let moodWhere: any = { analysisStatus: "completed" };

                switch (moodValue) {
                    case "high-energy":
                        moodWhere = {
                            analysisStatus: "completed",
                            energy: { gte: 0.7 },
                            bpm: { gte: 120 },
                        };
                        break;
                    case "chill":
                        moodWhere = {
                            analysisStatus: "completed",
                            OR: [
                                { energy: { lte: 0.4 } },
                                { arousal: { lte: 0.4 } },
                            ],
                        };
                        break;
                    case "happy":
                        moodWhere = {
                            analysisStatus: "completed",
                            valence: { gte: 0.6 },
                            energy: { gte: 0.5 },
                        };
                        break;
                    case "melancholy":
                        moodWhere = {
                            analysisStatus: "completed",
                            OR: [
                                { valence: { lte: 0.4 } },
                                { keyScale: "minor" },
                            ],
                        };
                        break;
                    case "dance":
                        moodWhere = {
                            analysisStatus: "completed",
                            danceability: { gte: 0.7 },
                        };
                        break;
                    case "acoustic":
                        moodWhere = {
                            analysisStatus: "completed",
                            acousticness: { gte: 0.6 },
                        };
                        break;
                    case "instrumental":
                        moodWhere = {
                            analysisStatus: "completed",
                            instrumentalness: { gte: 0.7 },
                        };
                        break;
                    default:
                        // Try Last.fm tags if mood not recognized
                        moodWhere = {
                            lastfmTags: { has: moodValue },
                        };
                }

                const moodTracks = await prisma.track.findMany({
                    where: moodWhere,
                    select: { id: true },
                    take: limitNum * 3,
                });
                trackIds = moodTracks.map((t) => t.id);
                break;

            case "workout":
                // High-energy workout tracks - multiple strategies
                let workoutTrackIds: string[] = [];

                // Strategy 1: Audio analysis - high energy AND fast BPM
                const energyTracks = await prisma.track.findMany({
                    where: {
                        analysisStatus: "completed",
                        OR: [
                            // High energy with fast tempo
                            {
                                AND: [
                                    { energy: { gte: 0.65 } },
                                    { bpm: { gte: 115 } },
                                ],
                            },
                            // Has workout mood tag
                            {
                                moodTags: {
                                    hasSome: ["workout", "energetic", "upbeat"],
                                },
                            },
                        ],
                    },
                    select: { id: true },
                    take: limitNum * 2,
                });
                workoutTrackIds = energyTracks.map((t) => t.id);
                logger.debug(
                    `[Radio:workout] Found ${workoutTrackIds.length} tracks via audio analysis`
                );

                // Strategy 2: Genre-based (if not enough from audio)
                if (workoutTrackIds.length < limitNum) {
                    const workoutGenreNames = [
                        "rock",
                        "metal",
                        "hard rock",
                        "alternative rock",
                        "punk",
                        "hip hop",
                        "rap",
                        "trap",
                        "electronic",
                        "edm",
                        "house",
                        "techno",
                        "drum and bass",
                        "dubstep",
                        "hardstyle",
                        "metalcore",
                        "hardcore",
                        "industrial",
                        "nu metal",
                        "pop punk",
                    ];

                    // Check Genre table
                    const workoutGenres = await prisma.genre.findMany({
                        where: {
                            name: {
                                in: workoutGenreNames,
                                mode: "insensitive",
                            },
                        },
                        include: {
                            trackGenres: {
                                select: { trackId: true },
                                take: 50,
                            },
                        },
                    });

                    const genreTrackIds = workoutGenres.flatMap((g) =>
                        g.trackGenres.map((tg) => tg.trackId)
                    );
                    workoutTrackIds = [
                        ...new Set([...workoutTrackIds, ...genreTrackIds]),
                    ];
                    logger.debug(
                        `[Radio:workout] After genre check: ${workoutTrackIds.length} tracks`
                    );

                    // Also check album.genres JSON field
                    if (workoutTrackIds.length < limitNum) {
                        const albumGenreTracks = await prisma.track.findMany({
                            where: {
                                album: {
                                    OR: workoutGenreNames.map((g) => ({
                                        genres: { string_contains: g },
                                    })),
                                },
                            },
                            select: { id: true },
                            take: limitNum,
                        });
                        workoutTrackIds = [
                            ...new Set([
                                ...workoutTrackIds,
                                ...albumGenreTracks.map((t) => t.id),
                            ]),
                        ];
                        logger.debug(
                            `[Radio:workout] After album genre check: ${workoutTrackIds.length} tracks`
                        );
                    }
                }

                trackIds = workoutTrackIds;
                break;

            case "artist":
                // Artist Radio - plays tracks from the artist + similar artists in library
                // Uses hybrid approach: Last.fm similarity (filtered to library) + genre matching + vibe boost
                const artistId = radioValue;
                if (!artistId) {
                    return res
                        .status(400)
                        .json({ error: "Artist ID required for artist radio" });
                }

                logger.debug(
                    `[Radio:artist] Starting artist radio for: ${artistId}`
                );

                // 1. Get tracks from this artist (they're in library by definition)
                const artistTracks = await prisma.track.findMany({
                    where: { album: { artistId } },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        danceability: true,
                    },
                });
                logger.debug(
                    `[Radio:artist] Found ${artistTracks.length} tracks from artist`
                );

                if (artistTracks.length === 0) {
                    return res.json({ tracks: [] });
                }

                // Calculate artist's average "vibe" for later matching
                const analyzedTracks = artistTracks.filter(
                    (t) => t.bpm || t.energy || t.valence
                );
                const avgVibe =
                    analyzedTracks.length > 0
                        ? {
                              bpm:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.bpm || 0),
                                      0
                                  ) / analyzedTracks.length,
                              energy:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.energy || 0),
                                      0
                                  ) / analyzedTracks.length,
                              valence:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.valence || 0),
                                      0
                                  ) / analyzedTracks.length,
                              danceability:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.danceability || 0),
                                      0
                                  ) / analyzedTracks.length,
                          }
                        : null;
                logger.debug(`[Radio:artist] Artist vibe:`, avgVibe);

                // 2. Get library artist IDs (artists user actually owns)
                const ownedArtists = await prisma.ownedAlbum.findMany({
                    select: { artistId: true },
                    distinct: ["artistId"],
                });
                const libraryArtistIds = new Set(
                    ownedArtists.map((o) => o.artistId)
                );
                libraryArtistIds.delete(artistId); // Exclude the current artist
                logger.debug(
                    `[Radio:artist] Library has ${libraryArtistIds.size} other artists`
                );

                // 3. Try Last.fm similar artists, filtered to library
                const similarInLibrary = await prisma.similarArtist.findMany({
                    where: {
                        fromArtistId: artistId,
                        toArtistId: { in: Array.from(libraryArtistIds) },
                    },
                    orderBy: { weight: "desc" },
                    take: 15,
                });
                let similarArtistIds = similarInLibrary.map(
                    (s) => s.toArtistId
                );
                logger.debug(
                    `[Radio:artist] Found ${similarArtistIds.length} Last.fm similar artists in library`
                );

                // 4. Fallback: genre matching if not enough similar artists
                if (similarArtistIds.length < 5 && libraryArtistIds.size > 0) {
                    const artist = await prisma.artist.findUnique({
                        where: { id: artistId },
                        select: { genres: true, userGenres: true },
                    });
                    const artistGenres = getMergedGenres(artist || {});

                    if (artistGenres.length > 0) {
                        // Find library artists with overlapping genres
                        const genreMatchArtists = await prisma.artist.findMany({
                            where: {
                                id: { in: Array.from(libraryArtistIds) },
                            },
                            select: {
                                id: true,
                                genres: true,
                                userGenres: true,
                            },
                        });

                        // Score artists by genre overlap using merged genres
                        const scoredArtists = genreMatchArtists
                            .map((a) => {
                                const theirGenres = getMergedGenres(a);
                                const overlap = artistGenres.filter((g) =>
                                    theirGenres.some(
                                        (tg) =>
                                            tg
                                                .toLowerCase()
                                                .includes(g.toLowerCase()) ||
                                            g
                                                .toLowerCase()
                                                .includes(tg.toLowerCase())
                                    )
                                ).length;
                                return { id: a.id, score: overlap };
                            })
                            .filter((a) => a.score > 0)
                            .sort((a, b) => b.score - a.score)
                            .slice(0, 10);

                        const genreArtistIds = scoredArtists.map((a) => a.id);
                        similarArtistIds = [
                            ...new Set([
                                ...similarArtistIds,
                                ...genreArtistIds,
                            ]),
                        ];
                        logger.debug(
                            `[Radio:artist] After genre matching: ${similarArtistIds.length} similar artists`
                        );
                    }
                }

                // 5. Get tracks from similar library artists
                let similarTracks: {
                    id: string;
                    artistId: string;
                    bpm: number | null;
                    energy: number | null;
                    valence: number | null;
                    danceability: number | null;
                    vibeScore?: number;
                }[] = [];
                if (similarArtistIds.length > 0) {
                    const similarTrackRows = await prisma.track.findMany({
                        where: {
                            album: { artistId: { in: similarArtistIds } },
                        },
                        select: {
                            id: true,
                            bpm: true,
                            energy: true,
                            valence: true,
                            danceability: true,
                            album: {
                                select: {
                                    artistId: true,
                                },
                            },
                        },
                    });
                    similarTracks = similarTrackRows.map((track) => ({
                        id: track.id,
                        artistId: track.album.artistId,
                        bpm: track.bpm,
                        energy: track.energy,
                        valence: track.valence,
                        danceability: track.danceability,
                    }));
                    logger.debug(
                        `[Radio:artist] Found ${similarTracks.length} tracks from similar artists`
                    );
                }

                // 6. Apply vibe boost if we have audio analysis data
                if (avgVibe && similarTracks.length > 0) {
                    // Score each similar track by how close its vibe is to the artist's average
                    similarTracks = similarTracks
                        .map((t) => {
                            if (!t.bpm && !t.energy && !t.valence)
                                return { ...t, vibeScore: 0.5 };

                            let score = 0;
                            let factors = 0;

                            if (t.bpm && avgVibe.bpm) {
                                // BPM within 20 = good match
                                const bpmDiff = Math.abs(t.bpm - avgVibe.bpm);
                                score += Math.max(0, 1 - bpmDiff / 40);
                                factors++;
                            }
                            if (t.energy !== null && avgVibe.energy) {
                                score +=
                                    1 -
                                    Math.abs((t.energy || 0) - avgVibe.energy);
                                factors++;
                            }
                            if (t.valence !== null && avgVibe.valence) {
                                score +=
                                    1 -
                                    Math.abs(
                                        (t.valence || 0) - avgVibe.valence
                                    );
                                factors++;
                            }
                            if (
                                t.danceability !== null &&
                                avgVibe.danceability
                            ) {
                                score +=
                                    1 -
                                    Math.abs(
                                        (t.danceability || 0) -
                                            avgVibe.danceability
                                    );
                                factors++;
                            }

                            return {
                                ...t,
                                vibeScore: factors > 0 ? score / factors : 0.5,
                            };
                        })
                        .sort(
                            (a, b) =>
                                (b as any).vibeScore - (a as any).vibeScore
                        );

                    logger.debug(
                        `[Radio:artist] Applied vibe boost, top score: ${(
                            similarTracks[0] as any
                        )?.vibeScore?.toFixed(2)}`
                    );
                }

                const similarTrackPreferenceScores =
                    await buildTrackPreferenceScoreMapForUser(
                        userId,
                        similarTracks.map((track) => track.id)
                    );
                if (similarTrackPreferenceScores.size > 0) {
                    similarTracks = similarTracks
                        .map((track) => {
                            const adjustedScore =
                                applyTrackPreferenceSimilarityBias(
                                    track.vibeScore ?? 0.5,
                                    similarTrackPreferenceScores.get(track.id) ??
                                        0
                                );
                            return {
                                ...track,
                                vibeScore: adjustedScore,
                            };
                        })
                        .sort(
                            (left, right) =>
                                (right.vibeScore ?? 0) - (left.vibeScore ?? 0)
                        );
                    logger.debug(
                        `[Radio:artist] Applied light preference weighting across ${similarTrackPreferenceScores.size} similar-track preferences`
                    );
                }

                // 7. Mix: ~40% original artist, ~60% similar (vibe-boosted)
                const originalCount = Math.min(
                    Math.ceil(limitNum * 0.4),
                    artistTracks.length
                );
                const similarCount = Math.min(
                    limitNum - originalCount,
                    similarTracks.length
                );
                const strictSimilarArtistCap =
                    getRadioArtistCapForLimit(limitNum);
                const relaxedSimilarArtistCap =
                    getRelaxedRadioArtistCapForLimit(limitNum);

                const selectedOriginal = shuffleArray(artistTracks).slice(
                    0,
                    originalCount
                );
                // Prioritize top vibe matches, but cap per-similar-artist to avoid overrepresentation.
                const prioritizedSimilarPool = shuffleArray(
                    similarTracks.slice(0, Math.max(similarCount * 3, similarCount))
                );
                const remainingSimilarPool = similarTracks.slice(
                    Math.max(similarCount * 3, similarCount)
                );
                const selectedSimilar = selectTracksWithArtistDiversity(
                    [...prioritizedSimilarPool, ...remainingSimilarPool],
                    similarCount,
                    strictSimilarArtistCap,
                    relaxedSimilarArtistCap
                );
                const uniqueSimilarArtists = new Set(
                    selectedSimilar.map((track) => track.artistId)
                ).size;
                logger.debug(
                    `[Radio:artist] Similar artist diversity cap strict=${strictSimilarArtistCap}, relaxed=${relaxedSimilarArtistCap}, unique artists=${uniqueSimilarArtists}`
                );

                trackIds = [...selectedOriginal, ...selectedSimilar].map(
                    (t) => t.id
                );
                logger.debug(
                    `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`
                );
                break;

            case "vibe":
                // Vibe Match - finds tracks that sound like the given track
                // Pure audio feature matching with graceful fallbacks
                const sourceTrackId = radioValue;
                if (!sourceTrackId) {
                    return res
                        .status(400)
                        .json({ error: "Track ID required for vibe matching" });
                }

                logger.debug(
                    `[Radio:vibe] Starting vibe match for track: ${sourceTrackId}`
                );

                // 1. Get the source track's audio features (including Enhanced mode fields)
                const sourceTrack = (await prisma.track.findUnique({
                    where: { id: sourceTrackId },
                    include: {
                        album: {
                            select: {
                                artistId: true,
                                genres: true,
                                artist: { select: { id: true, name: true } },
                            },
                        },
                    },
                })) as any; // Cast to any to include all Track fields

                if (!sourceTrack) {
                    return sendRouteError(res, 404, "Track not found");
                }

                const sourceHasReliableEnhancedAnalysis =
                    hasReliableEnhancedAnalysis(
                        sourceTrack.analysisMode,
                        sourceTrack.analysisVersion
                    );

                logger.debug(
                    `[Radio:vibe] Source: "${sourceTrack.title}" by ${sourceTrack.album.artist.name}`
                );
                logger.debug(
                    `[Radio:vibe] Analysis mode: ${
                        sourceHasReliableEnhancedAnalysis
                            ? "ENHANCED"
                            : "STANDARD"
                    }`
                );
                logger.debug(
                    `[Radio:vibe] Source features: BPM=${sourceTrack.bpm}, Energy=${sourceTrack.energy}, Valence=${sourceTrack.valence}`
                );
                if (sourceHasReliableEnhancedAnalysis) {
                    logger.debug(
                        `[Radio:vibe] ML Moods: Happy=${sourceTrack.moodHappy}, Sad=${sourceTrack.moodSad}, Relaxed=${sourceTrack.moodRelaxed}, Aggressive=${sourceTrack.moodAggressive}, Party=${sourceTrack.moodParty}, Acoustic=${sourceTrack.moodAcoustic}, Electronic=${sourceTrack.moodElectronic}`
                    );
                }

                // Store source features for frontend visualization
                vibeSourceFeatures = {
                    bpm: sourceTrack.bpm,
                    energy: sourceTrack.energy,
                    valence: sourceTrack.valence,
                    arousal: sourceTrack.arousal,
                    danceability: sourceTrack.danceability,
                    keyScale: sourceTrack.keyScale,
                    instrumentalness: sourceTrack.instrumentalness,
                    // Enhanced mode features (all 7 ML mood predictions)
                    moodHappy: sourceTrack.moodHappy,
                    moodSad: sourceTrack.moodSad,
                    moodRelaxed: sourceTrack.moodRelaxed,
                    moodAggressive: sourceTrack.moodAggressive,
                    moodParty: sourceTrack.moodParty,
                    moodAcoustic: sourceTrack.moodAcoustic,
                    moodElectronic: sourceTrack.moodElectronic,
                    analysisMode: sourceHasReliableEnhancedAnalysis
                        ? "enhanced"
                        : "standard",
                };

                let vibeMatchedIds: string[] = [];
                const sourceArtistId = sourceTrack.album.artistId;

                // 2. Try audio feature matching first (if track is analyzed)
                const hasAudioData =
                    sourceTrack.bpm ||
                    sourceTrack.energy ||
                    sourceTrack.valence;

                if (hasAudioData) {
                    // Get all analyzed tracks (excluding source) - include Enhanced mode fields
                    const analyzedTracks = await prisma.track.findMany({
                        where: {
                            id: { not: sourceTrackId },
                            analysisStatus: "completed",
                        },
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
                            // Enhanced mode fields (all 7 ML mood predictions)
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
                        },
                    });

                    logger.debug(
                        `[Radio:vibe] Found ${analyzedTracks.length} analyzed tracks to compare`
                    );

                    if (analyzedTracks.length > 0) {
                        // === COSINE SIMILARITY SCORING ===
                        // Industry-standard approach: build feature vectors, compute cosine similarity
                        // Uses ALL 13 features for comprehensive matching

                        // Enhanced valence: mode/tonality + mood + audio features
                        const calculateEnhancedValence = (
                            track: any
                        ): number => {
                            const happy = track.moodHappy ?? 0.5;
                            const sad = track.moodSad ?? 0.5;
                            const party = (track as any).moodParty ?? 0.5;
                            const isMajor = track.keyScale === "major";
                            const isMinor = track.keyScale === "minor";
                            const modeValence = isMajor
                                ? 0.3
                                : isMinor
                                ? -0.2
                                : 0;
                            const moodValence =
                                happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
                            const audioValence =
                                (track.energy ?? 0.5) * 0.1 +
                                (track.danceabilityMl ??
                                    track.danceability ??
                                    0.5) *
                                    0.1;

                            return Math.max(
                                0,
                                Math.min(
                                    1,
                                    moodValence + modeValence + audioValence
                                )
                            );
                        };

                        // Enhanced arousal: mood + energy + tempo (avoids unreliable "electronic" mood)
                        const calculateEnhancedArousal = (
                            track: any
                        ): number => {
                            const aggressive = track.moodAggressive ?? 0.5;
                            const party = (track as any).moodParty ?? 0.5;
                            const relaxed = track.moodRelaxed ?? 0.5;
                            const acoustic = (track as any).moodAcoustic ?? 0.5;
                            const energy = track.energy ?? 0.5;
                            const bpm = track.bpm ?? 120;
                            const moodArousal = aggressive * 0.3 + party * 0.2;
                            const energyArousal = energy * 0.25;
                            const tempoArousal =
                                Math.max(0, Math.min(1, (bpm - 60) / 120)) *
                                0.15;
                            const calmReduction =
                                (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

                            return Math.max(
                                0,
                                Math.min(
                                    1,
                                    moodArousal +
                                        energyArousal +
                                        tempoArousal +
                                        calmReduction
                                )
                            );
                        };

                        // OOD detection using Energy-based scoring
                        const detectOOD = (track: any): boolean => {
                            const coreMoods = [
                                track.moodHappy ?? 0.5,
                                track.moodSad ?? 0.5,
                                track.moodRelaxed ?? 0.5,
                                track.moodAggressive ?? 0.5,
                            ];

                            const minMood = Math.min(...coreMoods);
                            const maxMood = Math.max(...coreMoods);

                            // Enhanced OOD detection based on research
                            // Flag if all core moods are high (>0.7) with low variance, OR if all are very neutral (~0.5)
                            const allHigh =
                                minMood > 0.7 && maxMood - minMood < 0.3;
                            const allNeutral =
                                Math.abs(maxMood - 0.5) < 0.15 &&
                                Math.abs(minMood - 0.5) < 0.15;

                            return allHigh || allNeutral;
                        };

                        // Octave-aware BPM distance calculation
                        const octaveAwareBPMDistance = (
                            bpm1: number,
                            bpm2: number
                        ): number => {
                            if (!bpm1 || !bpm2) return 0;

                            // Normalize to standard octave range (77-154 BPM)
                            const normalizeToOctave = (bpm: number): number => {
                                while (bpm < 77) bpm *= 2;
                                while (bpm > 154) bpm /= 2;
                                return bpm;
                            };

                            const norm1 = normalizeToOctave(bpm1);
                            const norm2 = normalizeToOctave(bpm2);

                            // Calculate distance on logarithmic scale for harmonic equivalence
                            const logDistance = Math.abs(
                                Math.log2(norm1) - Math.log2(norm2)
                            );
                            return Math.min(logDistance, 1); // Cap at 1 for similarity calculation
                        };

                        // Helper: Build enhanced weighted feature vector from track
                        const buildFeatureVector = (track: any): number[] => {
                            const trackHasReliableEnhancedAnalysis =
                                hasReliableEnhancedAnalysis(
                                    track.analysisMode,
                                    track.analysisVersion
                                );
                            const isOOD =
                                trackHasReliableEnhancedAnalysis &&
                                detectOOD(track);

                            // Get mood values with OOD normalization
                            const getMoodValue = (
                                value: number | null,
                                defaultValue: number
                            ): number => {
                                if (!value) return defaultValue;
                                if (!isOOD) return value;
                                // Normalize OOD predictions to spread them out (0.2-0.8 range)
                                return (
                                    0.2 +
                                    Math.max(0, Math.min(0.6, value - 0.2))
                                );
                            };

                            // Use enhanced valence/arousal calculations
                            const enhancedValence =
                                trackHasReliableEnhancedAnalysis
                                    ? calculateEnhancedValence(track)
                                    : (track.valence ?? 0.5);
                            const enhancedArousal =
                                trackHasReliableEnhancedAnalysis
                                    ? calculateEnhancedArousal(track)
                                    : (track.arousal ??
                                        track.energy ??
                                        0.5);

                            return [
                                // ML Mood predictions (7 features) - enhanced weighting and OOD handling
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? track.moodHappy
                                        : null,
                                    0.5
                                ) * 1.3, // 1.3x weight for semantic features
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? track.moodSad
                                        : null,
                                    0.5
                                ) * 1.3,
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? track.moodRelaxed
                                        : null,
                                    0.5
                                ) * 1.3,
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? track.moodAggressive
                                        : null,
                                    0.5
                                ) * 1.3,
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? (track as any).moodParty
                                        : null,
                                    0.5
                                ) * 1.3,
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? (track as any).moodAcoustic
                                        : null,
                                    0.5
                                ) * 1.3,
                                getMoodValue(
                                    trackHasReliableEnhancedAnalysis
                                        ? (track as any).moodElectronic
                                        : null,
                                    0.5
                                ) * 1.3,
                                // Audio features (5 features) - standard weight
                                track.energy ?? 0.5,
                                enhancedArousal, // Use enhanced arousal
                                track.danceabilityMl ??
                                    track.danceability ??
                                    0.5,
                                track.instrumentalness ?? 0.5,
                                // Octave-aware BPM normalized to 0-1
                                1 -
                                    octaveAwareBPMDistance(
                                        track.bpm ?? 120,
                                        120
                                    ), // Similarity to reference tempo
                                // Enhanced key mode with valence consideration
                                enhancedValence, // Use enhanced valence instead of binary key
                            ];
                        };

                        // Helper: Compute cosine similarity between two vectors
                        const cosineSimilarity = (
                            a: number[],
                            b: number[]
                        ): number => {
                            let dot = 0,
                                magA = 0,
                                magB = 0;
                            for (let i = 0; i < a.length; i++) {
                                dot += a[i] * b[i];
                                magA += a[i] * a[i];
                                magB += b[i] * b[i];
                            }
                            if (magA === 0 || magB === 0) return 0;
                            return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                        };

                        // Helper: Compute tag overlap bonus
                        const computeTagBonus = (
                            sourceTags: string[],
                            sourceGenres: string[],
                            trackTags: string[],
                            trackGenres: string[]
                        ): number => {
                            const sourceSet = new Set(
                                [...sourceTags, ...sourceGenres].map((t) =>
                                    t.toLowerCase()
                                )
                            );
                            const trackSet = new Set(
                                [...trackTags, ...trackGenres].map((t) =>
                                    t.toLowerCase()
                                )
                            );
                            if (sourceSet.size === 0 || trackSet.size === 0)
                                return 0;
                            const overlap = [...sourceSet].filter((tag) =>
                                trackSet.has(tag)
                            ).length;
                            // Max 5% bonus for tag overlap
                            return Math.min(0.05, overlap * 0.01);
                        };

                        // Build source feature vector once
                        const sourceVector = buildFeatureVector(sourceTrack);
                        const vibePreferenceScores =
                            await buildTrackPreferenceScoreMapForUser(
                                userId,
                                analyzedTracks.map((track) => track.id)
                            );

                        // Check if source track has Enhanced mode data
                        const sourceUsesEnhancedFeatures =
                            sourceHasReliableEnhancedAnalysis;

                        const scored = analyzedTracks.map((t) => {
                            const targetUsesEnhancedFeatures =
                                hasReliableEnhancedAnalysis(
                                    t.analysisMode,
                                    t.analysisVersion
                                );
                            const useEnhanced =
                                sourceUsesEnhancedFeatures &&
                                targetUsesEnhancedFeatures;

                            // Build target feature vector
                            const targetVector = buildFeatureVector(t as any);

                            // Compute base cosine similarity
                            let score = cosineSimilarity(
                                sourceVector,
                                targetVector
                            );

                            // Add tag/genre overlap bonus (max 5%)
                            const tagBonus = computeTagBonus(
                                sourceTrack.lastfmTags || [],
                                sourceTrack.essentiaGenres || [],
                                t.lastfmTags || [],
                                t.essentiaGenres || []
                            );

                            // Final score: 95% cosine similarity + 5% tag bonus,
                            // plus light thumbs preference weighting.
                            const finalScore = Math.max(
                                0,
                                Math.min(
                                    1,
                                    applyTrackPreferenceSimilarityBias(
                                        score * 0.95 + tagBonus,
                                        vibePreferenceScores.get(t.id) ?? 0
                                    )
                                )
                            );

                            return {
                                id: t.id,
                                score: finalScore,
                                enhanced: useEnhanced,
                            };
                        });

                        // Filter to good matches and sort by score
                        // Use lower threshold (40%) for Enhanced mode since it's more precise
                        const minThreshold = sourceHasReliableEnhancedAnalysis
                            ? 0.4
                            : 0.5;
                        const goodMatches = scored
                            .filter((t) => t.score > minThreshold)
                            .sort((a, b) => b.score - a.score);

                        vibeMatchedIds = goodMatches.map((t) => t.id);
                        const enhancedCount = goodMatches.filter(
                            (t) => t.enhanced
                        ).length;
                        logger.debug(
                            `[Radio:vibe] Audio matching found ${
                                vibeMatchedIds.length
                            } tracks (>${minThreshold * 100}% similarity)`
                        );
                        logger.debug(
                            `[Radio:vibe] Enhanced matches: ${enhancedCount}, Standard matches: ${
                                goodMatches.length - enhancedCount
                            }`
                        );
                        if (vibePreferenceScores.size > 0) {
                            logger.debug(
                                `[Radio:vibe] Applied light preference weighting to ${vibePreferenceScores.size} analyzed candidates`
                            );
                        }

                        if (goodMatches.length > 0) {
                            logger.debug(
                                `[Radio:vibe] Top match score: ${goodMatches[0].score.toFixed(
                                    2
                                )} (${
                                    goodMatches[0].enhanced
                                        ? "enhanced"
                                        : "standard"
                                })`
                            );
                        }
                    }
                }

                // 3. Fallback A: Same artist's other tracks
                if (vibeMatchedIds.length < limitNum) {
                    const artistTracks = await prisma.track.findMany({
                        where: {
                            album: { artistId: sourceArtistId },
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                    });
                    const newIds = artistTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback A (same artist): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                // 4. Fallback B: Similar artists from Last.fm (filtered to library)
                if (vibeMatchedIds.length < limitNum) {
                    const ownedArtistIds = await prisma.ownedAlbum.findMany({
                        select: { artistId: true },
                        distinct: ["artistId"],
                    });
                    const libraryArtistSet = new Set(
                        ownedArtistIds.map((o) => o.artistId)
                    );
                    libraryArtistSet.delete(sourceArtistId);

                    const similarArtists = await prisma.similarArtist.findMany({
                        where: {
                            fromArtistId: sourceArtistId,
                            toArtistId: { in: Array.from(libraryArtistSet) },
                        },
                        orderBy: { weight: "desc" },
                        take: 10,
                    });

                    if (similarArtists.length > 0) {
                        const similarArtistTracks = await prisma.track.findMany(
                            {
                                where: {
                                    album: {
                                        artistId: {
                                            in: similarArtists.map(
                                                (s) => s.toArtistId
                                            ),
                                        },
                                    },
                                    id: {
                                        notIn: [
                                            sourceTrackId,
                                            ...vibeMatchedIds,
                                        ],
                                    },
                                },
                                select: { id: true },
                            }
                        );
                        const newIds = similarArtistTracks.map((t) => t.id);
                        vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                        logger.debug(
                            `[Radio:vibe] Fallback B (similar artists): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                        );
                    }
                }

                // 5. Fallback C: Same genre (using TrackGenre relation)
                const sourceGenres =
                    (sourceTrack.album.genres as string[]) || [];
                if (
                    vibeMatchedIds.length < limitNum &&
                    sourceGenres.length > 0
                ) {
                    // Search using the TrackGenre relation for better accuracy
                    const genreTracks = await prisma.track.findMany({
                        where: {
                            trackGenres: {
                                some: {
                                    genre: {
                                        name: {
                                            in: sourceGenres,
                                            mode: "insensitive",
                                        },
                                    },
                                },
                            },
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                        take: limitNum,
                    });
                    const newIds = genreTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback C (same genre): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                // 6. Fallback D: Random from library
                if (vibeMatchedIds.length < limitNum) {
                    const randomTracks = await prisma.track.findMany({
                        where: {
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                        take: limitNum - vibeMatchedIds.length,
                    });
                    const newIds = randomTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback D (random): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                trackIds = vibeMatchedIds;
                logger.debug(
                    `[Radio:vibe] Final vibe queue: ${trackIds.length} tracks`
                );
                break;

            case "all":
            default:
                // Random selection from all tracks in library
                const allTracks = await prisma.track.findMany({
                    select: { id: true },
                });
                trackIds = allTracks.map((t) => t.id);
        }

        // Keep deterministic ordering for vibe (similarity-ranked) and liked (likedAt-ranked) queues.
        // Shuffle the source pool for all other radio modes.
        const preserveInputOrder =
            radioType === "vibe" || radioType === "liked";
        const basePoolIds =
            preserveInputOrder ?
                trackIds
            :   shuffleArray(trackIds).slice(
                    0,
                    Math.max(limitNum * 4, limitNum)
                );
        const preferenceScoreMap =
            radioType === "liked" ?
                new Map<string, number>()
            :   await buildTrackPreferenceScoreMapForUser(userId, basePoolIds);
        const preferenceWeightedPoolIds =
            preferenceScoreMap.size > 0 ?
                applyTrackPreferenceOrderBias(basePoolIds, preferenceScoreMap)
            :   basePoolIds;
        const finalIds = preferenceWeightedPoolIds.slice(0, limitNum);

        if (preferenceScoreMap.size > 0) {
            logger.debug(
                `[Radio:${radioType}] Applied light preference weighting using ${preferenceScoreMap.size} track preferences`
            );
        }

        if (finalIds.length === 0) {
            return res.json({ tracks: [] });
        }

        // Fetch full track data (include all analysis fields for logging)
        const tracks = await prisma.track.findMany({
            where: {
                id: { in: finalIds },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                trackGenres: {
                    include: {
                        genre: { select: { name: true } },
                    },
                },
            },
        });

        // Reorder tracks whenever we preserve input order since Prisma IN does not preserve ordering.
        let orderedTracks = tracks;
        if (preserveInputOrder) {
            const trackMap = new Map(tracks.map((t) => [t.id, t]));
            orderedTracks = finalIds
                .map((id) => trackMap.get(id))
                .filter((t): t is (typeof tracks)[0] => t !== undefined);
        }

        // === VIBE QUEUE LOGGING ===
        // Log detailed info for vibe matching analysis (using ordered tracks)
        if (radioType === "vibe" && vibeSourceFeatures) {
            logger.debug("\n" + "=".repeat(100));
            logger.debug("VIBE QUEUE ANALYSIS - Source Track");
            logger.debug("=".repeat(100));

            // Find source track for logging
            const srcTrack = await prisma.track.findUnique({
                where: { id: radioValue as string },
                include: {
                    album: { include: { artist: { select: { name: true } } } },
                    trackGenres: {
                        include: { genre: { select: { name: true } } },
                    },
                },
            });

            if (srcTrack) {
                logger.debug(
                    `SOURCE: "${srcTrack.title}" by ${srcTrack.album.artist.name}`
                );
                logger.debug(`  Album: ${srcTrack.album.title}`);
                logger.debug(
                    `  Analysis Mode: ${
                        (srcTrack as any).analysisMode || "unknown"
                    }`
                );
                logger.debug(
                    `  BPM: ${srcTrack.bpm?.toFixed(1) || "N/A"} | Energy: ${
                        srcTrack.energy?.toFixed(2) || "N/A"
                    } | Valence: ${srcTrack.valence?.toFixed(2) || "N/A"}`
                );
                logger.debug(
                    `  Danceability: ${
                        srcTrack.danceability?.toFixed(2) || "N/A"
                    } | Arousal: ${
                        srcTrack.arousal?.toFixed(2) || "N/A"
                    } | Key: ${srcTrack.keyScale || "N/A"}`
                );
                logger.debug(
                    `  ML Moods: Happy=${
                        (srcTrack as any).moodHappy?.toFixed(2) || "N/A"
                    }, Sad=${
                        (srcTrack as any).moodSad?.toFixed(2) || "N/A"
                    }, Relaxed=${
                        (srcTrack as any).moodRelaxed?.toFixed(2) || "N/A"
                    }, Aggressive=${
                        (srcTrack as any).moodAggressive?.toFixed(2) || "N/A"
                    }`
                );
                logger.debug(
                    `  Genres: ${
                        srcTrack.trackGenres
                            .map((tg) => tg.genre.name)
                            .join(", ") || "N/A"
                    }`
                );
                logger.debug(
                    `  Last.fm Tags: ${
                        ((srcTrack as any).lastfmTags || []).join(", ") || "N/A"
                    }`
                );
                logger.debug(
                    `  Mood Tags: ${
                        ((srcTrack as any).moodTags || []).join(", ") || "N/A"
                    }`
                );
            }

            logger.debug("\n" + "-".repeat(100));
            logger.debug(
                `VIBE QUEUE - ${orderedTracks.length} tracks (showing up to 50, SORTED BY MATCH SCORE)`
            );
            logger.debug("-".repeat(100));
            logger.debug(
                `${"#".padEnd(3)} | ${"TRACK".padEnd(35)} | ${"ARTIST".padEnd(
                    20
                )} | ${"BPM".padEnd(6)} | ${"ENG".padEnd(5)} | ${"VAL".padEnd(
                    5
                )} | ${"H".padEnd(4)} | ${"S".padEnd(4)} | ${"R".padEnd(
                    4
                )} | ${"A".padEnd(4)} | MODE    | GENRES`
            );
            logger.debug("-".repeat(100));

            orderedTracks.slice(0, 50).forEach((track, i) => {
                const t = track as any;
                const title = track.title.substring(0, 33).padEnd(35);
                const artist = track.album.artist.name
                    .substring(0, 18)
                    .padEnd(20);
                const bpm = track.bpm
                    ? track.bpm.toFixed(0).padEnd(6)
                    : "N/A".padEnd(6);
                const energy =
                    track.energy !== null
                        ? track.energy.toFixed(2).padEnd(5)
                        : "N/A".padEnd(5);
                const valence =
                    track.valence !== null
                        ? track.valence.toFixed(2).padEnd(5)
                        : "N/A".padEnd(5);
                const happy =
                    t.moodHappy !== null
                        ? t.moodHappy.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const sad =
                    t.moodSad !== null
                        ? t.moodSad.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const relaxed =
                    t.moodRelaxed !== null
                        ? t.moodRelaxed.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const aggressive =
                    t.moodAggressive !== null
                        ? t.moodAggressive.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const mode = (t.analysisMode || "std")
                    .substring(0, 7)
                    .padEnd(8);
                const genres = track.trackGenres
                    .slice(0, 3)
                    .map((tg) => tg.genre.name)
                    .join(", ");

                logger.debug(
                    `${String(i + 1).padEnd(
                        3
                    )} | ${title} | ${artist} | ${bpm} | ${energy} | ${valence} | ${happy} | ${sad} | ${relaxed} | ${aggressive} | ${mode} | ${genres}`
                );
            });

            if (orderedTracks.length > 50) {
                logger.debug(
                    `... and ${orderedTracks.length - 50} more tracks`
                );
            }

            logger.debug("=".repeat(100) + "\n");
        }

        // Transform to match frontend Track interface
        const transformedTracks = orderedTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            trackNo: track.trackNo,
            filePath: track.filePath,
            artist: {
                id: track.album.artist.id,
                name: track.album.artist.name,
            },
            album: {
                id: track.album.id,
                title: track.album.title,
                coverArt: track.album.coverUrl,
            },
            // Include audio features for vibe mode visualization (if available)
            ...(vibeSourceFeatures && {
                audioFeatures: {
                    bpm: track.bpm,
                    energy: track.energy,
                    valence: track.valence,
                    arousal: track.arousal,
                    danceability: track.danceability,
                    keyScale: track.keyScale,
                    instrumentalness: track.instrumentalness,
                    analysisMode: track.analysisMode,
                    // ML Mood predictions for enhanced visualization
                    moodHappy: track.moodHappy,
                    moodSad: track.moodSad,
                    moodRelaxed: track.moodRelaxed,
                    moodAggressive: track.moodAggressive,
                    moodParty: track.moodParty,
                    moodAcoustic: track.moodAcoustic,
                    moodElectronic: track.moodElectronic,
                },
            }),
        }));

        // Keep deterministic ordering for vibe/liked queues. Shuffle all other radio queues.
        const finalTracks =
            preserveInputOrder ? transformedTracks : separateArtists(
                shuffleArray(transformedTracks),
                (t: any) => t.artist?.id ?? `unknown:${t.id}`
            );

        // Include source features if this was a vibe request
        const response: any = { tracks: finalTracks };
        if (vibeSourceFeatures) {
            response.sourceFeatures = vibeSourceFeatures;
        }

        res.json(response);
    } catch (error) {
        logger.error("Radio endpoint error:", error);
        sendInternalRouteError(res, "Failed to get radio tracks");
    }
});

export default router;
