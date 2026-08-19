import { Router, type Request, type Response } from "express";
import type {
    Audiobook,
    AudiobookProgress,
    FederationPeer,
} from "@prisma/client";
import { z } from "zod";
import { logger } from "../utils/logger";
import { audiobookshelfService } from "../services/audiobookshelf";
import { audiobookCacheService } from "../services/audiobookCache";
import { prisma } from "../utils/db";
import { requireAuthOrToken } from "../middleware/auth";
import { imageLimiter, apiLimiter } from "../middleware/rateLimiter";
import { safeResolvePath } from "../utils/safeResolvePath";
import { buildSafeAudiobookCoverUrl } from "../services/audiobookCoverProxy";
import {
    MAX_EXTERNAL_IMAGE_BYTES,
    readResponseBodyWithByteCap,
} from "../services/imageProxy";
import { sendRouteError } from "./routeErrorResponse";
import { sendFileFromRoot } from "../utils/sendFileFromRoot";
import { config } from "../config";
import {
    proxyFederatedAudiobookCover,
    proxyFederatedAudiobookStream,
} from "../services/federationAudiobookProxy";
import {
    parseStoredSections,
    type AudiobookSections,
} from "../services/audiobookSections";
import { findRouteNameMatch } from "./routeParamName";

const router = Router();

const federationPeerInclude = {
    federationPeer: {
        select: {
            id: true,
            name: true,
            outboundStatus: true,
            baseUrl: true,
            outboundToken: true,
        },
    },
} as const;
const audiobookSearchSchema = z.strictObject({
    q: z.string().trim().min(1).max(200),
});
const audiobookProgressMetadataSelect = {
    title: true,
    author: true,
    coverUrl: true,
    duration: true,
    libraryId: true,
    localCoverPath: true,
    peerId: true,
} as const;

type AudiobookRow = Audiobook & {
    federationPeer?: Pick<
        FederationPeer,
        "id" | "name" | "outboundStatus" | "baseUrl" | "outboundToken"
    > | null;
};

type ProgressRow = Pick<
    AudiobookProgress,
    "currentTime" | "duration" | "isFinished" | "lastPlayedAt"
>;

function federatedSource(book: AudiobookRow) {
    if (!book.peerId || !book.federationPeer) return {};
    return {
        source: "federated" as const,
        peer: {
            id: book.federationPeer.id,
            name: book.federationPeer.name,
            online: book.federationPeer.outboundStatus === "ACTIVE",
        },
    };
}

function progressResponse(progress: ProgressRow | null | undefined) {
    if (!progress) return null;
    return {
        currentTime: progress.currentTime,
        progress:
            progress.duration > 0
                ? (progress.currentTime / progress.duration) * 100
                : 0,
        isFinished: progress.isFinished,
        lastPlayedAt: progress.lastPlayedAt,
    };
}

function audiobookListResponse(
    book: AudiobookRow,
    progress: ProgressRow | null | undefined,
) {
    return {
        id: book.id,
        title: book.title,
        author: book.author || "Unknown Author",
        narrator: book.narrator,
        description: book.description,
        coverUrl:
            book.localCoverPath || book.coverUrl
                ? `/audiobooks/${book.id}/cover`
                : null,
        duration: book.duration || 0,
        libraryId: book.libraryId,
        series: book.series
            ? { name: book.series, sequence: book.seriesSequence || "1" }
            : null,
        genres: book.genres || [],
        progress: progressResponse(progress),
        ...federatedSource(book),
    };
}

function sectionsArePlayable(cachedSections: AudiobookSections): boolean {
    return cachedSections.kind !== "none";
}

/**
 * @openapi
 * /api/audiobooks/continue-listening:
 *   get:
 *     summary: Get audiobooks the user is currently listening to
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of audiobooks with active progress
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /audiobooks/continue-listening
 * Get audiobooks the user is currently listening to (for "Continue Listening" section)
 * NOTE: This must come BEFORE the /:id route to avoid matching "continue-listening" as an ID
 */
router.get(
    "/continue-listening",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            // Check if Audiobookshelf is enabled
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json([]);
            }

            const recentProgress = await prisma.audiobookProgress.findMany({
                where: {
                    userId: req.user!.id,
                    isFinished: false,
                    currentTime: {
                        gt: 0,
                    },
                },
                orderBy: {
                    lastPlayedAt: "desc",
                },
                take: 10,
            });

            // Transform the cover URLs to use the audiobook__ prefix for the proxy
            const transformed = recentProgress.map((progress: any) => {
                const coverUrl =
                    progress.coverUrl && !progress.coverUrl.startsWith("http")
                        ? `audiobook__${progress.coverUrl}`
                        : progress.coverUrl;

                return {
                    ...progress,
                    coverUrl,
                };
            });

            res.json(transformed);
        } catch (error: any) {
            logger.error("Error fetching continue listening:", error);
            res.status(500).json({
                error: "Failed to fetch continue listening",
            });
        }
    },
);

/**
 * @openapi
 * /api/audiobooks/sync:
 *   post:
 *     summary: Manually trigger audiobook sync from Audiobookshelf
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Sync completed successfully
 *       400:
 *         description: Audiobookshelf not enabled
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /audiobooks/sync
 * Manually trigger audiobook sync from Audiobookshelf
 * Fetches all audiobooks and caches metadata + cover images locally
 */
router.post("/sync", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        const { getSystemSettings } = await import("../utils/systemSettings");
        const { notificationService } =
            await import("../services/notificationService");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res
                .status(400)
                .json({ error: "Audiobookshelf not enabled" });
        }

        logger.debug("[Audiobooks] Starting manual audiobook sync...");
        const result = await audiobookCacheService.syncAll();

        // Check how many have series after sync
        const seriesCount = await prisma.audiobook.count({
            where: { series: { not: null } },
        });
        logger.debug(
            `[Audiobooks] Sync complete. Books with series: ${seriesCount}`,
        );

        // Send notification to user
        if (req.user?.id) {
            await notificationService.notifySystem(
                req.user.id,
                "Audiobook Sync Complete",
                `Synced ${result.synced || 0} audiobooks (${seriesCount} with series)`,
            );
        }

        res.json({
            success: true,
            result,
        });
    } catch (error: any) {
        logger.error("Audiobook sync failed:", error);
        res.status(500).json({
            error: "Sync failed",
        });
    }
});

/**
 * @openapi
 * /api/audiobooks/debug-series:
 *   get:
 *     summary: Debug endpoint to see raw series data from Audiobookshelf
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Raw series debug information
 *       400:
 *         description: Audiobookshelf not enabled
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /audiobooks/debug-series
 * Debug endpoint to see raw series data from Audiobookshelf
 */
// Debug endpoint for series data
router.get("/debug-series", requireAuthOrToken, async (req, res) => {
    logger.debug("[Audiobooks] Debug series endpoint called");
    try {
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res
                .status(400)
                .json({ error: "Audiobookshelf not enabled" });
        }

        // Get raw data from Audiobookshelf
        const rawBooks = await audiobookshelfService.getAllAudiobooks();
        logger.debug(
            `[Audiobooks] Got ${rawBooks.length} books from Audiobookshelf`,
        );

        // Find books with series data
        const booksWithSeries = rawBooks.filter((book: any) => {
            const metadata = book.media?.metadata || book;
            return metadata.series || metadata.seriesName;
        });

        logger.debug(
            `[Audiobooks] Books with series data: ${booksWithSeries.length}`,
        );

        // Extract series info from all books (first 20)
        const allSeriesInfo = rawBooks.slice(0, 20).map((book: any) => {
            const metadata = book.media?.metadata || book;
            return {
                title: metadata.title || book.title,
                rawSeries: metadata.series,
                seriesName: metadata.seriesName,
                seriesSequence: metadata.seriesSequence,
                // Also check if there's series in the top-level book object
                bookSeries: book.series,
            };
        });

        // Get a full sample of one book with series (if any)
        let fullSample = null;
        if (booksWithSeries.length > 0) {
            const sampleBook = booksWithSeries[0];
            fullSample = {
                id: sampleBook.id,
                media: sampleBook.media,
            };
        }

        res.json({
            totalBooks: rawBooks.length,
            booksWithSeriesCount: booksWithSeries.length,
            sampleSeriesData: allSeriesInfo,
            fullSampleWithSeries: fullSample,
        });
    } catch (error: any) {
        logger.error("[Audiobooks] Debug series error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * @openapi
 * /api/audiobooks/search:
 *   get:
 *     summary: Search audiobooks
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query string
 *     responses:
 *       200:
 *         description: Search results
 *       400:
 *         description: Query parameter required
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /audiobooks/search
 * Search audiobooks
 */
router.get("/search", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled && !config.features.federation) {
            return res.status(200).json([]);
        }

        const query = audiobookSearchSchema.safeParse(req.query);
        if (!query.success) {
            return res.status(400).json({ error: "Query parameter required" });
        }
        const { q } = query.data;

        const federated = config.features.federation
            ? await prisma.audiobook.findMany({
                  where: {
                      peerId: { not: null },
                      OR: [
                          { title: { contains: q, mode: "insensitive" } },
                          { author: { contains: q, mode: "insensitive" } },
                          { narrator: { contains: q, mode: "insensitive" } },
                      ],
                  },
                  orderBy: { title: "asc" },
                  take: 100,
                  include: federationPeerInclude,
              })
            : [];
        const remote = settings?.audiobookshelfEnabled
            ? await audiobookshelfService.searchAudiobooks(q)
            : [];
        res.json([
            ...remote,
            ...federated.map((book) => audiobookListResponse(book, null)),
        ]);
    } catch (error: any) {
        logger.error("Error searching audiobooks:", error);
        res.status(500).json({
            error: "Failed to search audiobooks",
        });
    }
});

/**
 * @openapi
 * /api/audiobooks:
 *   get:
 *     summary: Get all audiobooks from cached database
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *         description: Maximum number of audiobooks to return (max 100)
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *         description: Number of audiobooks to skip for pagination
 *     responses:
 *       200:
 *         description: List of audiobooks with user progress
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /audiobooks
 * Get all audiobooks from cached database (instant, no API calls)
 */
router.get("/", requireAuthOrToken, apiLimiter, async (req, res) => {
    logger.debug("[Audiobooks] GET / - fetching audiobooks list");
    try {
        // Check if Audiobookshelf is enabled first
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled && !config.features.federation) {
            return res.status(200).json({
                configured: false,
                enabled: false,
                audiobooks: [],
            });
        }

        const parsedLimit = parseInt(req.query?.limit as string, 10);
        const parsedOffset = parseInt(req.query?.offset as string, 10);
        const hasLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;
        const hasOffset = Number.isFinite(parsedOffset) && parsedOffset > 0;
        const take = hasLimit ? Math.min(parsedLimit, 100) : undefined;
        const skip = hasOffset ? parsedOffset : undefined;

        // Read from cached database instead of hitting Audiobookshelf API
        const pagination = {
            ...(take !== undefined ? { take } : {}),
            ...(skip !== undefined ? { skip } : {}),
        };
        const audiobooks = config.features.federation
            ? await prisma.audiobook.findMany({
                  where: settings?.audiobookshelfEnabled
                      ? undefined
                      : { peerId: { not: null } },
                  orderBy: { title: "asc" },
                  include: federationPeerInclude,
                  ...pagination,
              })
            : await prisma.audiobook.findMany({
                  orderBy: { title: "asc" },
                  ...pagination,
              });

        if (!settings?.audiobookshelfEnabled && audiobooks.length === 0) {
            return res.status(200).json({
                configured: false,
                enabled: false,
                audiobooks: [],
            });
        }

        const audiobookIds = audiobooks.map((book) => book.id);
        const progressEntries =
            audiobookIds.length > 0
                ? await prisma.audiobookProgress.findMany({
                      where: {
                          userId: req.user!.id,
                          audiobookshelfId: { in: audiobookIds },
                      },
                  })
                : [];
        const progressMap = new Map(
            progressEntries.map((entry) => [entry.audiobookshelfId, entry]),
        );

        // Get user's progress for each audiobook
        const audiobooksWithProgress = audiobooks.map((book) =>
            audiobookListResponse(book, progressMap.get(book.id)),
        );

        res.json(audiobooksWithProgress);
    } catch (error: any) {
        logger.error("Error fetching audiobooks:", error);
        res.status(500).json({
            error: "Failed to fetch audiobooks",
        });
    }
});

/**
 * @openapi
 * /api/audiobooks/series/{seriesName}:
 *   get:
 *     summary: Get all books in a series
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesName
 *         required: true
 *         schema:
 *           type: string
 *         description: URL-encoded series name
 *     responses:
 *       200:
 *         description: List of audiobooks in the series with user progress
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /audiobooks/series/:seriesName
 * Get all books in a series (from cached database)
 */
router.get<{ seriesName: string }>(
    "/series/:seriesName",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            // Check if Audiobookshelf is enabled
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json([]);
            }

            const { seriesName } = req.params;

            const audiobooks =
                (await findRouteNameMatch(seriesName, async (candidate) => {
                    const matches = await prisma.audiobook.findMany({
                        where: { series: candidate },
                        orderBy: { seriesSequence: "asc" },
                    });
                    return matches.length > 0 ? matches : null;
                })) ?? [];

            const seriesIds = audiobooks.map((book) => book.id);
            const seriesProgressEntries =
                seriesIds.length > 0
                    ? await prisma.audiobookProgress.findMany({
                          where: {
                              userId: req.user!.id,
                              audiobookshelfId: { in: seriesIds },
                          },
                      })
                    : [];
            const seriesProgressMap = new Map(
                seriesProgressEntries.map((entry) => [
                    entry.audiobookshelfId,
                    entry,
                ]),
            );

            const seriesBooks = audiobooks.map((book) => {
                const progress = seriesProgressMap.get(book.id);

                return {
                    id: book.id,
                    title: book.title,
                    author: book.author || "Unknown Author",
                    narrator: book.narrator,
                    description: book.description,
                    coverUrl:
                        book.localCoverPath || book.coverUrl
                            ? `/audiobooks/${book.id}/cover`
                            : null,
                    duration: book.duration || 0,
                    libraryId: book.libraryId,
                    series: book.series
                        ? {
                              name: book.series,
                              sequence: book.seriesSequence || "1",
                          }
                        : null,
                    genres: book.genres || [],
                    progress: progress
                        ? {
                              currentTime: progress.currentTime,
                              progress:
                                  progress.duration > 0
                                      ? (progress.currentTime /
                                            progress.duration) *
                                        100
                                      : 0,
                              isFinished: progress.isFinished,
                              lastPlayedAt: progress.lastPlayedAt,
                          }
                        : null,
                };
            });

            res.json(seriesBooks);
        } catch (error: any) {
            logger.error("Error fetching series:", error);
            res.status(500).json({
                error: "Failed to fetch series",
            });
        }
    },
);

/**
 * @openapi
 * /api/audiobooks/{id}/cover:
 *   get:
 *     summary: Serve audiobook cover image
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Audiobook ID
 *     responses:
 *       200:
 *         description: Cover image file
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Invalid audiobook ID
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Cover not found
 */
/**
 * GET /audiobooks/:id/cover
 * Serve cached cover image from local disk, or proxy from Audiobookshelf if not cached
 * Uses the high-volume imageLimiter (matches library/browse image routes)
 */
type AudiobookCoverRow = Awaited<ReturnType<typeof loadAudiobookCover>>;

async function loadAudiobookCover(id: string) {
    return prisma.audiobook.findUnique({
        where: { id },
        select: {
            localCoverPath: true,
            coverUrl: true,
            peerId: true,
            remoteId: true,
            federationPeer: {
                select: {
                    id: true,
                    baseUrl: true,
                    outboundToken: true,
                    outboundStatus: true,
                },
            },
        },
    });
}

async function serveFederatedAudiobookCover(
    req: Request,
    res: Response,
    audiobook: AudiobookCoverRow,
): Promise<boolean> {
    if (!config.features.federation || !audiobook?.peerId) return false;
    const peer = audiobook.federationPeer;
    if (
        !peer ||
        peer.outboundStatus !== "ACTIVE" ||
        !peer.baseUrl ||
        !peer.outboundToken ||
        !audiobook.remoteId
    ) {
        sendRouteError(res, 503, "Federation peer is offline", {
            code: "PEER_OFFLINE",
        });
        return true;
    }
    const served = await proxyFederatedAudiobookCover({
        req,
        res,
        peer,
        remoteId: audiobook.remoteId,
    });
    if (!served) sendRouteError(res, 404, "Cover not found");
    return true;
}

async function resolveAudiobookCoverPath(
    id: string,
    coverDir: string,
    storedPath: string | null | undefined,
): Promise<string | null | undefined> {
    if (storedPath) return storedPath;
    const fs = await import("fs");
    const fallbackPath = safeResolvePath(coverDir, `${id}.jpg`);
    if (!fallbackPath || !fs.existsSync(fallbackPath)) return null;
    try {
        await prisma.audiobook.update({
            where: { id },
            data: { localCoverPath: fallbackPath },
        });
    } catch (error: unknown) {
        logger.debug("Could not persist audiobook cover fallback", { error });
    }
    return fallbackPath;
}

async function serveAudiobookCoverFile(
    res: Response,
    coverPath: string | null | undefined,
    coverDir: string,
): Promise<boolean> {
    if (!coverPath) return false;
    const fs = await import("fs");
    if (!fs.existsSync(coverPath)) return false;
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    sendFileFromRoot(res, coverPath, coverDir);
    return true;
}

async function fetchAudiobookshelfCover(
    id: string,
    coverUrl: string,
): Promise<globalThis.Response | null> {
    const { getSystemSettings } = await import("../utils/systemSettings");
    const settings = await getSystemSettings();
    if (!settings?.audiobookshelfUrl || !settings.audiobookshelfApiKey) {
        return null;
    }
    const baseUrl = settings.audiobookshelfUrl.replace(/\/$/, "");
    const coverApiUrl = buildSafeAudiobookCoverUrl(coverUrl, baseUrl);
    if (!coverApiUrl) {
        logger.warn(
            `[Audiobook Cover] Blocked unsafe cover path for ${id}: ${coverUrl}`,
        );
        return null;
    }
    try {
        return await fetch(coverApiUrl, {
            headers: {
                Authorization: `Bearer ${settings.audiobookshelfApiKey}`,
            },
            signal: AbortSignal.timeout(15000),
        });
    } catch (error: unknown) {
        logger.error(`[Audiobook Cover] Proxy error for ${id}:`, error);
        return null;
    }
}

async function sendAudiobookshelfCover(
    res: Response,
    response: globalThis.Response,
): Promise<boolean> {
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return false;
    }
    const bodyResult = await readResponseBodyWithByteCap(
        response,
        MAX_EXTERNAL_IMAGE_BYTES,
    );
    if (!bodyResult.ok) return false;
    res.setHeader(
        "Content-Type",
        response.headers.get("content-type") || "image/jpeg",
    );
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(bodyResult.buffer);
    return true;
}

export async function handleAudiobookCover(
    req: Request<{ id: string }>,
    res: Response,
) {
    try {
        const { id } = req.params;
        if (!/^[A-Za-z0-9_:-]+$/.test(id)) {
            return res.status(400).json({ error: "Invalid audiobook ID" });
        }

        const path = await import("path");
        const audiobook = await loadAudiobookCover(id);
        if (await serveFederatedAudiobookCover(req, res, audiobook)) {
            return undefined;
        }

        const coverDir = path.join(
            config.music.musicPath,
            "cover-cache",
            "audiobooks",
        );
        const coverPath = await resolveAudiobookCoverPath(
            id,
            coverDir,
            audiobook?.localCoverPath,
        );
        if (await serveAudiobookCoverFile(res, coverPath, coverDir)) return;

        if (audiobook?.coverUrl) {
            const response = await fetchAudiobookshelfCover(
                id,
                audiobook.coverUrl,
            );
            if (response && (await sendAudiobookshelfCover(res, response))) {
                return undefined;
            }
        }

        return res.status(404).json({ error: "Cover not found" });
    } catch (error: unknown) {
        logger.error("Error serving cover:", error);
        return res.status(500).json({
            error: "Failed to serve cover",
        });
    }
}

router.get<{ id: string }>(
    "/:id/cover",
    requireAuthOrToken,
    imageLimiter,
    handleAudiobookCover,
);

/**
 * @openapi
 * /api/audiobooks/{id}:
 *   get:
 *     summary: Get a specific audiobook with full details
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Audiobook ID
 *     responses:
 *       200:
 *         description: Cached audiobook details with validated sections and user progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [id, title, author, duration, sectionKind, sections, sectionsPlayable]
 *               properties:
 *                 id:
 *                   type: string
 *                 title:
 *                   type: string
 *                 author:
 *                   type: string
 *                 duration:
 *                   type: number
 *                 sectionKind:
 *                   type: string
 *                   enum: [chapters, parts, none]
 *                 sectionsPlayable:
 *                   type: boolean
 *                   description: Whether section seek targets are safe for the current stream proxy
 *                 sections:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [index, title, startSeconds]
 *                     properties:
 *                       index:
 *                         type: integer
 *                         minimum: 0
 *                       title:
 *                         type: string
 *                       startSeconds:
 *                         type: number
 *                         minimum: 0
 *       404:
 *         description: Audiobook not found
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /audiobooks/:id
 * Get a specific audiobook with full details from the cache or ABS fallback
 */
router.get<{ id: string }>(
    "/:id",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();
            const { id } = req.params;
            let audiobook: AudiobookRow | null = config.features.federation
                ? await prisma.audiobook.findUnique({
                      where: { id },
                      include: federationPeerInclude,
                  })
                : null;
            const isFederated = Boolean(audiobook?.peerId);

            if (!settings?.audiobookshelfEnabled && !isFederated) {
                return res
                    .status(200)
                    .json({ configured: false, enabled: false });
            }

            if (!config.features.federation) {
                audiobook = await prisma.audiobook.findUnique({
                    where: { id },
                });
            }

            const staleBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const cacheNeedsRefresh =
                !isFederated &&
                (!audiobook ||
                    audiobook.sections === null ||
                    audiobook.lastSyncedAt < staleBefore);
            if (cacheNeedsRefresh) {
                logger.debug(
                    `[AUDIOBOOK] Audiobook ${id} not cached, stale, or missing sections; syncing...`,
                );
                audiobook = await audiobookCacheService.getAudiobook(id);
            }

            if (!audiobook) {
                return res.status(404).json({ error: "Audiobook not found" });
            }

            const cachedSections = parseStoredSections(audiobook.sections);

            // Get user's progress
            const progress = await prisma.audiobookProgress.findUnique({
                where: {
                    userId_audiobookshelfId: {
                        userId: req.user!.id,
                        audiobookshelfId: id,
                    },
                },
            });

            const response = {
                id: audiobook.id,
                title: audiobook.title,
                author: audiobook.author || "Unknown Author",
                narrator: audiobook.narrator,
                description: audiobook.description,
                coverUrl:
                    audiobook.localCoverPath || audiobook.coverUrl
                        ? `/audiobooks/${audiobook.id}/cover`
                        : null,
                duration: audiobook.duration || 0,
                publisher: audiobook.publisher,
                publishedYear: audiobook.publishedYear,
                genres: audiobook.genres || [],
                isbn: audiobook.isbn,
                asin: audiobook.asin,
                language: audiobook.language,
                series: audiobook.series
                    ? {
                          name: audiobook.series,
                          sequence: audiobook.seriesSequence || "1",
                      }
                    : null,
                sectionKind: cachedSections.kind,
                sections: cachedSections.sections,
                sectionsPlayable: sectionsArePlayable(cachedSections),
                libraryId: audiobook.libraryId,
                progress: progress
                    ? {
                          currentTime: progress.currentTime,
                          progress:
                              progress.duration > 0
                                  ? (progress.currentTime / progress.duration) *
                                    100
                                  : 0,
                          isFinished: progress.isFinished,
                          lastPlayedAt: progress.lastPlayedAt,
                      }
                    : null,
                ...federatedSource(audiobook),
            };

            res.json(response);
        } catch (error: any) {
            logger.error("Error fetching audiobook__", error);
            res.status(500).json({
                error: "Failed to fetch audiobook",
            });
        }
    },
);

/**
 * @openapi
 * /api/audiobooks/{id}/stream:
 *   get:
 *     summary: Stream an audiobook with authentication proxy
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Audiobook ID
 *       - in: header
 *         name: Range
 *         required: false
 *         schema:
 *           type: string
 *         description: HTTP range header for partial content
 *     responses:
 *       200:
 *         description: Full concatenated audio stream
 *         headers:
 *           Accept-Ranges:
 *             schema: { type: string, example: bytes }
 *           Content-Length:
 *             schema: { type: integer, format: int64 }
 *         content:
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       206:
 *         description: Partial concatenated audio stream
 *         headers:
 *           Accept-Ranges:
 *             schema: { type: string, example: bytes }
 *           Content-Length:
 *             schema: { type: integer, format: int64 }
 *           Content-Range:
 *             schema: { type: string, example: "bytes 100-199/1000" }
 *       416:
 *         description: Requested byte range is outside the concatenated audiobook
 *         headers:
 *           Accept-Ranges:
 *             schema: { type: string, example: bytes }
 *           Content-Range:
 *             schema: { type: string }
 *       401:
 *         description: Not authenticated
 *       503:
 *         description: Audiobookshelf is not configured
 */
/**
 * GET /audiobooks/:id/stream
 * Proxy the audiobook stream with authentication
 */
async function tryFederatedAudiobookStream(
    req: Request<{ id: string }>,
    res: Response,
): Promise<boolean> {
    if (!config.features.federation) return false;
    const audiobook = await prisma.audiobook.findUnique({
        where: { id: req.params.id },
        select: {
            peerId: true,
            remoteId: true,
            federationPeer: {
                select: {
                    id: true,
                    name: true,
                    baseUrl: true,
                    outboundToken: true,
                    outboundStatus: true,
                },
            },
        },
    });
    if (!audiobook?.peerId) return false;
    const peer = audiobook.federationPeer;
    if (
        !peer ||
        peer.outboundStatus !== "ACTIVE" ||
        !peer.baseUrl ||
        !peer.outboundToken ||
        !audiobook.remoteId
    ) {
        sendRouteError(res, 503, "Federation peer is offline", {
            code: "PEER_OFFLINE",
        });
        return true;
    }
    try {
        await proxyFederatedAudiobookStream({
            req,
            res,
            peer,
            remoteId: audiobook.remoteId,
        });
    } catch (error: unknown) {
        logger.warn("Federated audiobook stream proxy failed", { error });
        if (!res.headersSent) {
            sendRouteError(res, 503, "Federation peer is offline", {
                code: "PEER_OFFLINE",
            });
        }
    }
    return true;
}

router.get<{ id: string }>(
    "/:id/stream",
    requireAuthOrToken,
    async (req, res) => {
        try {
            logger.debug(
                `[Audiobook Stream] Request for audiobook: ${req.params.id}`,
            );
            logger.debug(
                `[Audiobook Stream] User: ${req.user?.id || "unknown"}`,
            );

            if (await tryFederatedAudiobookStream(req, res)) return;

            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                logger.debug("[Audiobook Stream] Audiobookshelf not enabled");
                return res
                    .status(503)
                    .json({ error: "Audiobookshelf is not configured" });
            }

            const { id } = req.params;
            const rangeHeader = req.headers.range as string | undefined;

            logger.debug(
                `[Audiobook Stream] Fetching stream for ${id}, range: ${
                    rangeHeader || "none"
                }`,
            );

            const { stream, headers, status } =
                await audiobookshelfService.streamAudiobook(id, rangeHeader, {
                    request: req,
                    response: res,
                });

            logger.debug(
                `[Audiobook Stream] Got stream, status: ${status}, content-type: ${headers["content-type"]}`,
            );

            const responseStatus = status || (rangeHeader ? 206 : 200);
            res.status(responseStatus);

            // Set content type - ensure it's audio
            // axios >=1.18 types indexed header access as a union; coerce to string.
            if (responseStatus !== 416) {
                const contentType = String(
                    headers["content-type"] || "audio/mpeg",
                );
                res.setHeader("Content-Type", contentType);
            }

            // Set other headers
            if (headers["content-length"]) {
                res.setHeader(
                    "Content-Length",
                    String(headers["content-length"]),
                );
            }
            if (headers["accept-ranges"]) {
                res.setHeader("Accept-Ranges", headers["accept-ranges"]);
            } else {
                res.setHeader("Accept-Ranges", "bytes");
            }
            if (headers["content-range"]) {
                res.setHeader("Content-Range", headers["content-range"]);
            }

            res.setHeader("Cache-Control", "public, max-age=0");

            // Clean up upstream stream when client disconnects (e.g., skips track, closes browser)
            res.on("close", () => {
                if (!stream.destroyed) {
                    stream.destroy();
                }
            });

            stream.pipe(res);

            stream.on("error", (error: any) => {
                logger.error("[Audiobook Stream] Stream error:", error);
                if (!res.headersSent) {
                    res.status(500).json({
                        error: "Failed to stream audiobook",
                    });
                } else {
                    res.end();
                }
            });
        } catch (error: any) {
            logger.error("[Audiobook Stream] Error:", error.message);
            res.status(500).json({
                error: "Failed to stream audiobook",
            });
        }
    },
);

/**
 * @openapi
 * /api/audiobooks/{id}/progress:
 *   post:
 *     summary: Update playback progress for an audiobook
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Audiobook ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               currentTime:
 *                 type: number
 *                 description: Current playback position in seconds
 *               duration:
 *                 type: number
 *                 description: Total duration in seconds
 *               isFinished:
 *                 type: boolean
 *                 description: Whether the audiobook is finished
 *     responses:
 *       200:
 *         description: Progress updated successfully
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /audiobooks/:id/progress
 * Update playback progress for an audiobook
 */
router.post<{ id: string }>(
    "/:id/progress",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();
            const { id } = req.params;
            let cachedAudiobook = config.features.federation
                ? await prisma.audiobook.findUnique({
                      where: { id },
                      select: audiobookProgressMetadataSelect,
                  })
                : null;

            if (
                !settings?.audiobookshelfEnabled &&
                !(config.features.federation && cachedAudiobook?.peerId)
            ) {
                return res.status(200).json({
                    success: false,
                    message: "Audiobookshelf is not configured",
                });
            }
            if (!config.features.federation) {
                cachedAudiobook = await prisma.audiobook.findUnique({
                    where: { id },
                    select: audiobookProgressMetadataSelect,
                });
            }

            const {
                currentTime: rawCurrentTime,
                duration: rawDuration,
                isFinished,
            } = req.body;

            const currentTime =
                typeof rawCurrentTime === "number" &&
                Number.isFinite(rawCurrentTime)
                    ? Math.max(0, rawCurrentTime)
                    : 0;
            const durationValue =
                typeof rawDuration === "number" && Number.isFinite(rawDuration)
                    ? Math.max(rawDuration, 0)
                    : 0;

            logger.debug(`\n [AUDIOBOOK PROGRESS] Received update:`);
            logger.debug(`   User: ${req.user!.username}`);
            logger.debug(`   Audiobook ID: ${id}`);
            logger.debug(
                `   Current Time: ${currentTime}s (${Math.floor(
                    currentTime / 60,
                )} mins)`,
            );
            logger.debug(
                `   Duration: ${durationValue}s (${Math.floor(
                    durationValue / 60,
                )} mins)`,
            );
            if (durationValue > 0) {
                logger.debug(
                    `   Progress: ${(
                        (currentTime / durationValue) *
                        100
                    ).toFixed(1)}%`,
                );
            } else {
                logger.debug("   Progress: duration unknown");
            }
            logger.debug(`   Finished: ${!!isFinished}`);

            // Pull cached metadata to avoid hitting Audiobookshelf for every update
            const existingProgress = await prisma.audiobookProgress.findUnique({
                where: {
                    userId_audiobookshelfId: {
                        userId: req.user!.id,
                        audiobookshelfId: id,
                    },
                },
            });

            const fallbackDuration =
                durationValue ||
                cachedAudiobook?.duration ||
                existingProgress?.duration ||
                0;

            const metadataTitle =
                cachedAudiobook?.title ||
                existingProgress?.title ||
                "Unknown Title";
            const metadataAuthor =
                cachedAudiobook?.author ||
                existingProgress?.author ||
                "Unknown Author";
            const metadataCover =
                cachedAudiobook?.coverUrl || existingProgress?.coverUrl || null;

            // Update progress in our database
            const progress = await prisma.audiobookProgress.upsert({
                where: {
                    userId_audiobookshelfId: {
                        userId: req.user!.id,
                        audiobookshelfId: id,
                    },
                },
                create: {
                    userId: req.user!.id,
                    audiobookshelfId: id,
                    title: metadataTitle,
                    author: metadataAuthor,
                    coverUrl: metadataCover,
                    currentTime,
                    duration: fallbackDuration,
                    isFinished: !!isFinished,
                    lastPlayedAt: new Date(),
                },
                update: {
                    title: metadataTitle,
                    author: metadataAuthor,
                    coverUrl: metadataCover,
                    currentTime,
                    duration: fallbackDuration,
                    isFinished: !!isFinished,
                    lastPlayedAt: new Date(),
                },
            });

            logger.debug(`   Progress saved to database`);

            if (!cachedAudiobook?.peerId) {
                try {
                    await audiobookshelfService.updateProgress(
                        id,
                        currentTime,
                        fallbackDuration,
                        isFinished,
                    );
                    logger.debug(`   Progress synced to Audiobookshelf`);
                } catch (error) {
                    logger.error(
                        "Failed to sync progress to Audiobookshelf:",
                        error,
                    );
                }
            }

            res.json({
                success: true,
                progress: {
                    currentTime: progress.currentTime,
                    progress:
                        progress.duration > 0
                            ? (progress.currentTime / progress.duration) * 100
                            : 0,
                    isFinished: progress.isFinished,
                },
            });
        } catch (error: any) {
            logger.error("Error updating progress:", error);
            res.status(500).json({
                error: "Failed to update progress",
            });
        }
    },
);

/**
 * @openapi
 * /api/audiobooks/{id}/progress:
 *   delete:
 *     summary: Remove playback progress for an audiobook
 *     tags: [Audiobooks]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Audiobook ID
 *     responses:
 *       200:
 *         description: Progress removed successfully
 *       401:
 *         description: Not authenticated
 */
/**
 * DELETE /audiobooks/:id/progress
 * Remove/reset progress for an audiobook
 */
router.delete<{ id: string }>(
    "/:id/progress",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();
            const { id } = req.params;
            const audiobook = config.features.federation
                ? await prisma.audiobook.findUnique({
                      where: { id },
                      select: { peerId: true },
                  })
                : null;

            if (!settings?.audiobookshelfEnabled && !audiobook?.peerId) {
                return res.status(200).json({
                    success: false,
                    message: "Audiobookshelf is not configured",
                });
            }

            logger.debug(`\n[AUDIOBOOK PROGRESS] Removing progress:`);
            logger.debug(`   User: ${req.user!.username}`);
            logger.debug(`   Audiobook ID: ${id}`);

            // Delete progress from our database
            await prisma.audiobookProgress.deleteMany({
                where: {
                    userId: req.user!.id,
                    audiobookshelfId: id,
                },
            });

            logger.debug(`   Progress removed from database`);

            if (!audiobook?.peerId) {
                try {
                    await audiobookshelfService.updateProgress(id, 0, 0, false);
                    logger.debug(`   Progress reset in Audiobookshelf`);
                } catch (error) {
                    logger.error(
                        "Failed to reset progress in Audiobookshelf:",
                        error,
                    );
                }
            }

            res.json({
                success: true,
                message: "Progress removed",
            });
        } catch (error: any) {
            logger.error("Error removing progress:", error);
            res.status(500).json({
                error: "Failed to remove progress",
            });
        }
    },
);

export default router;
