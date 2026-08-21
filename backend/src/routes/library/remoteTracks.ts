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

type ParsedRemoteTrackId = NonNullable<ReturnType<typeof parseRemoteTrackId>>;
type RemotePreferenceMetadata = {
    title?: string;
    artist?: string;
    album?: string;
    thumbnailUrl?: string;
    duration?: number;
    isrc?: string;
};

function readRemotePreferenceMetadata(body: unknown): RemotePreferenceMetadata {
    if (typeof body !== "object" || body === null) return {};
    const requestBody = body as { metadata?: unknown };
    const source =
        typeof requestBody.metadata === "object" &&
        requestBody.metadata !== null
            ? requestBody.metadata
            : body;
    return source as RemotePreferenceMetadata;
}

function parseTidalId(parsed: ParsedRemoteTrackId): number | undefined {
    if (parsed.provider !== "tidal") return undefined;
    const tidalId = Number.parseInt(parsed.externalId, 10);
    return Number.isFinite(tidalId) && tidalId > 0 ? tidalId : undefined;
}

async function resolveLikedRemoteTrack(
    parsed: ParsedRemoteTrackId,
    userId: string,
    tidalId: number | undefined,
    metadata: RemotePreferenceMetadata,
) {
    const resolved = await resolveRemoteTrackMetadataForRequest({
        provider: parsed.provider,
        userId,
        ...(parsed.provider === "tidal"
            ? { tidalId: tidalId as number }
            : { videoId: parsed.externalId }),
        fetchArtworkIfMissing: true,
        metadata,
    });
    return parsed.provider === "tidal"
        ? trackMappingService.ensureRemoteTrack({
              provider: "tidal",
              tidalId: tidalId as number,
              ...resolved,
          })
        : trackMappingService.ensureRemoteTrack({
              provider: "youtube",
              videoId: parsed.externalId,
              title: resolved.title,
              artist: resolved.artist,
              album: resolved.album,
              duration: resolved.duration,
              thumbnailUrl: resolved.thumbnailUrl,
          });
}

async function saveRemoteTrackLike(
    userId: string,
    ensured: Awaited<ReturnType<typeof resolveLikedRemoteTrack>>,
    likedAt: Date,
): Promise<void> {
    if (ensured.provider === "tidal") {
        await prisma.likedRemoteTrack.upsert({
            where: {
                userId_trackTidalId: { userId, trackTidalId: ensured.id },
            },
            create: { userId, trackTidalId: ensured.id, likedAt },
            update: { likedAt },
        });
        return;
    }
    await prisma.likedRemoteTrack.upsert({
        where: {
            userId_trackYtMusicId: { userId, trackYtMusicId: ensured.id },
        },
        create: { userId, trackYtMusicId: ensured.id, likedAt },
        update: { likedAt },
    });
}

async function clearRemoteTrackLike(
    parsed: ParsedRemoteTrackId,
    userId: string,
): Promise<void> {
    if (parsed.provider === "tidal") {
        const tidalId = parseTidalId(parsed);
        if (!tidalId) return;
        const track = await prisma.trackTidal.findUnique({
            where: { tidalId },
            select: { id: true },
        });
        if (track) {
            await prisma.likedRemoteTrack.deleteMany({
                where: { userId, trackTidalId: track.id },
            });
        }
        return;
    }
    const track = await prisma.trackYtMusic.findUnique({
        where: { videoId: parsed.externalId },
        select: { id: true },
    });
    if (track) {
        await prisma.likedRemoteTrack.deleteMany({
            where: { userId, trackYtMusicId: track.id },
        });
    }
}

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

    const metadata = readRemotePreferenceMetadata(req.body);
    const now = new Date();
    const tidalId = parseTidalId(parsed);
    if (signal === "thumbs_up" && parsed.provider === "tidal" && !tidalId) {
        return res.status(400).json({
            error: "Invalid remote track ID. Use yt:videoId or tidal:trackId format.",
        });
    }
    if (signal === "thumbs_up") {
        const ensured = await resolveLikedRemoteTrack(
            parsed,
            userId,
            tidalId,
            metadata,
        );
        await saveRemoteTrackLike(userId, ensured, now);
    } else {
        await clearRemoteTrackLike(parsed, userId);
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
