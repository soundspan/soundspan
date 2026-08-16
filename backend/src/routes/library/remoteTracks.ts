import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import path from "path";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    normalizeTrackPreferenceSignal,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../../services/trackPreference";
import {
    applyTrackPreferenceSignalToTrackIds,
    buildTrackPreferenceScoreMapForUser,
    formatAlbumPreferenceResponse,
    formatTrackPreferenceResponse,
    hasConnectedProviderToken,
    toLikedResponseTrack,
} from "../../services/libraryTrackPreferences";
import { sendInternalRouteError, sendRouteError } from "../routeErrorResponse";
import { trackMappingService } from "../../services/trackMappingService";
import { resolveRemoteTrackMetadataForRequest } from "../../services/remoteTrackMetadataResolver";

/**
 * Router segment for remoteTracks routes registered at this position.
 */
export const remoteTracksRouter = Router();
// ── Remote Track Preference (YT Music / TIDAL) ─────────────────

function parseRemoteTrackId(
    compositeId: string,
): { provider: "youtube" | "tidal"; externalId: string } | null {
    if (compositeId.startsWith("yt:")) {
        const externalId = compositeId.slice(3).trim();
        return externalId.length > 0
            ? { provider: "youtube", externalId }
            : null;
    }
    if (compositeId.startsWith("tidal:")) {
        const externalId = compositeId.slice(6).trim();
        return externalId.length > 0 ? { provider: "tidal", externalId } : null;
    }
    return null;
}

/**
 * @openapi
 * /api/library/remote-tracks/{id}/preference:
 *   get:
 *     summary: Get preference for a remote (YT/TIDAL) track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: "Composite track ID (yt:videoId or tidal:trackId)"
 *     responses:
 *       200:
 *         description: Remote track preference state
 *       400:
 *         description: Invalid remote track ID format
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/remote-tracks/:id/preference.
 */
export async function handleGetRemoteTrackPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const parsed = parseRemoteTrackId(req.params.id);
    if (!parsed) {
        return res.status(400).json({
            error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
        });
    }

    let likedAt: Date | null = null;
    if (parsed.provider === "tidal") {
        const tidalTrackId = Number.parseInt(parsed.externalId, 10);
        if (!Number.isFinite(tidalTrackId) || tidalTrackId <= 0) {
            return res.status(400).json({
                error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
            });
        }

        const trackTidal = await prisma.trackTidal.findUnique({
            where: { tidalId: tidalTrackId },
            select: { id: true },
        });
        if (trackTidal) {
            const liked = await prisma.likedRemoteTrack.findUnique({
                where: {
                    userId_trackTidalId: {
                        userId,
                        trackTidalId: trackTidal.id,
                    },
                },
                select: { likedAt: true },
            });
            likedAt = liked?.likedAt ?? null;
        }
    } else {
        const trackYtMusic = await prisma.trackYtMusic.findUnique({
            where: { videoId: parsed.externalId },
            select: { id: true },
        });
        if (trackYtMusic) {
            const liked = await prisma.likedRemoteTrack.findUnique({
                where: {
                    userId_trackYtMusicId: {
                        userId,
                        trackYtMusicId: trackYtMusic.id,
                    },
                },
                select: { likedAt: true },
            });
            likedAt = liked?.likedAt ?? null;
        }
    }

    const preference = resolveTrackPreference({
        likedAt,
        dislikedAt: null,
    });

    res.json(formatTrackPreferenceResponse(req.params.id, preference));
}

remoteTracksRouter.get(
    "/remote-tracks/:id/preference",
    asyncHandler(handleGetRemoteTrackPreference),
);

/**
 * @openapi
 * /api/library/remote-tracks/{id}/preference:
 *   post:
 *     summary: Set preference for a remote (YT/TIDAL) track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: "Composite track ID (yt:videoId or tidal:trackId)"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - signal
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [thumbs_up, thumbs_down, clear]
 *               metadata:
 *                 type: object
 *                 properties:
 *                   title:
 *                     type: string
 *                   artist:
 *                     type: string
 *                   album:
 *                     type: string
 *                   thumbnailUrl:
 *                     type: string
 *                   duration:
 *                     type: integer
 *     responses:
 *       200:
 *         description: Updated remote track preference
 *       400:
 *         description: Invalid remote track ID or signal
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles POST /api/library/remote-tracks/:id/preference.
 */
export async function handleSetRemoteTrackPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const parsed = parseRemoteTrackId(req.params.id);
    if (!parsed) {
        return res.status(400).json({
            error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
        });
    }

    const signal = normalizeTrackPreferenceSignal(
        req.body?.signal ?? req.body?.score ?? req.body?.action,
    );
    if (!signal) {
        return res.status(400).json({
            error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
        });
    }

    const metadataSource =
        req.body?.metadata && typeof req.body.metadata === "object"
            ? req.body.metadata
            : (req.body ?? {});
    const metadata = metadataSource as {
        title?: string;
        artist?: string;
        album?: string;
        thumbnailUrl?: string;
        duration?: number;
        isrc?: string;
    };
    const now = new Date();

    if (signal === "thumbs_up") {
        const tidalId =
            parsed.provider === "tidal"
                ? Number.parseInt(parsed.externalId, 10)
                : undefined;
        if (parsed.provider === "tidal") {
            if (
                typeof tidalId !== "number" ||
                !Number.isFinite(tidalId) ||
                tidalId <= 0
            ) {
                return res.status(400).json({
                    error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
                });
            }
        }

        const resolvedMetadata = await resolveRemoteTrackMetadataForRequest({
            provider: parsed.provider,
            userId,
            ...(parsed.provider === "tidal"
                ? { tidalId: tidalId as number }
                : { videoId: parsed.externalId }),
            metadata: {
                title: metadata.title,
                artist: metadata.artist,
                album: metadata.album,
                duration: metadata.duration,
                thumbnailUrl: metadata.thumbnailUrl,
                isrc: metadata.isrc,
            },
        });

        const ensured =
            parsed.provider === "tidal"
                ? await trackMappingService.ensureRemoteTrack({
                      provider: "tidal",
                      tidalId: tidalId as number,
                      title: resolvedMetadata.title,
                      artist: resolvedMetadata.artist,
                      album: resolvedMetadata.album,
                      duration: resolvedMetadata.duration,
                      isrc: resolvedMetadata.isrc,
                      explicit: resolvedMetadata.explicit,
                  })
                : await trackMappingService.ensureRemoteTrack({
                      provider: "youtube",
                      videoId: parsed.externalId,
                      title: resolvedMetadata.title,
                      artist: resolvedMetadata.artist,
                      album: resolvedMetadata.album,
                      duration: resolvedMetadata.duration,
                      thumbnailUrl: resolvedMetadata.thumbnailUrl,
                  });

        if (ensured.provider === "tidal") {
            await prisma.likedRemoteTrack.upsert({
                where: {
                    userId_trackTidalId: {
                        userId,
                        trackTidalId: ensured.id,
                    },
                },
                create: {
                    userId,
                    trackTidalId: ensured.id,
                    likedAt: now,
                },
                update: { likedAt: now },
            });
        } else {
            await prisma.likedRemoteTrack.upsert({
                where: {
                    userId_trackYtMusicId: {
                        userId,
                        trackYtMusicId: ensured.id,
                    },
                },
                create: {
                    userId,
                    trackYtMusicId: ensured.id,
                    likedAt: now,
                },
                update: { likedAt: now },
            });
        }
    } else {
        if (parsed.provider === "tidal") {
            const tidalTrackId = Number.parseInt(parsed.externalId, 10);
            if (Number.isFinite(tidalTrackId) && tidalTrackId > 0) {
                const trackTidal = await prisma.trackTidal.findUnique({
                    where: { tidalId: tidalTrackId },
                    select: { id: true },
                });
                if (trackTidal) {
                    await prisma.likedRemoteTrack.deleteMany({
                        where: {
                            userId,
                            trackTidalId: trackTidal.id,
                        },
                    });
                }
            }
        } else {
            const trackYtMusic = await prisma.trackYtMusic.findUnique({
                where: { videoId: parsed.externalId },
                select: { id: true },
            });
            if (trackYtMusic) {
                await prisma.likedRemoteTrack.deleteMany({
                    where: {
                        userId,
                        trackYtMusicId: trackYtMusic.id,
                    },
                });
            }
        }
    }

    const preference = resolveTrackPreference({
        likedAt: signal === "thumbs_up" ? now : null,
        dislikedAt: null,
    });

    res.json(formatTrackPreferenceResponse(req.params.id, preference));
}

remoteTracksRouter.post(
    "/remote-tracks/:id/preference",
    asyncHandler(handleSetRemoteTrackPreference),
);
