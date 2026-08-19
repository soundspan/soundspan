import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import crypto from "crypto";
import path from "path";
import { deezerService } from "../../services/deezer";
import { coverArtService } from "../../services/coverArt";
import { extractColorsFromImage } from "../../utils/colorExtractor";
import {
    fetchExternalImage,
    normalizeExternalImageUrl,
} from "../../services/imageProxy";
import {
    negotiateCoverArtFormat,
    resizeCoverArt,
    snapCoverArtSize,
} from "../../services/coverArtResize";
import { sendInternalRouteError, sendRouteError } from "../routeErrorResponse";
import {
    getAlbumIdFromNativeCoverPath,
    persistHealedAlbumCover,
    resolveNativeCoverCacheHit,
    tryHealMissingNativeAlbumCover,
    coversBaseDir,
} from "../../services/nativeCoverHealing";
import { sendFileFromRoot } from "../../utils/sendFileFromRoot";
import { proxyFederatedCover } from "../../services/federationCoverProxy";
import { config } from "../../config";
import {
    applyCoverArtCorsHeaders,
    buildCoverArtCorsHeaders,
    COVER_ART_IMAGE_CACHE_CONTROL,
    COVER_ART_IMAGE_CACHE_TTL_SECONDS,
    COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS,
    sendAudiobookCover,
    trySendResizedNativeCover,
} from "../../utils/libraryCoverArt";
import { normalizeRouteName } from "../routeParamName";

const coverAlbumSelect = {
    id: true,
    title: true,
    rgMbid: true,
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
    artist: { select: { name: true } },
} satisfies Prisma.AlbumSelect;

function isDirectCoverResource(id: string): boolean {
    return (
        id.startsWith("native:") ||
        id.startsWith("audiobook__") ||
        id.startsWith("http://") ||
        id.startsWith("https://")
    );
}

function findCoverAlbum(id: string) {
    return prisma.album.findUnique({
        where: { id },
        select: coverAlbumSelect,
    });
}

async function resolveCoverId(raw: string) {
    const [routeId, legacyId] = normalizeRouteName(raw);
    if (isDirectCoverResource(routeId)) {
        return { id: routeId, album: null };
    }

    const album = await findCoverAlbum(routeId);
    if (album || !legacyId) {
        return { id: routeId, album };
    }
    if (isDirectCoverResource(legacyId)) {
        return { id: legacyId, album: null };
    }

    const legacyAlbum = await findCoverAlbum(legacyId);
    return legacyAlbum
        ? { id: legacyId, album: legacyAlbum }
        : { id: routeId, album: null };
}

/**
 * Router segment for coverArt routes registered at this position.
 */
export const coverArtRouter = Router();
/**
 * @openapi
 * /api/library/cover-art/{id}:
 *   get:
 *     summary: Proxy and cache album cover art images
 *     tags: [Library]
 *     security:
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
 *         description: >
 *           Requested image size in pixels. Snapped to the allowlist
 *           (64, 128, 192, 320, 512, 768); images are downscaled
 *           server-side (never upscaled) and served as webp when the
 *           Accept header includes image/webp. Omit to receive the
 *           original image.
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
// Express 5 (path-to-regexp v8) replaced the ":id?" optional-param syntax with
// braces: "{/:id}" matches both /cover-art and /cover-art/:id.
/**
 * Handles GET /api/library/cover-art{/:id}.
 */
export async function handleGetCoverArt(
    req: Request<{ id?: string }>,
    res: Response,
) {
    const { size, url } = req.query;
    let coverUrl: string;

    // Check if a full URL was provided as a query parameter
    if (url) {
        const rawUrl = Array.isArray(url) ? url[0] : url;
        const decodedUrl = typeof rawUrl === "string" ? rawUrl : String(rawUrl);

        // Check if this is an audiobook cover (prefixed with "audiobook__")
        if (decodedUrl.startsWith("audiobook__")) {
            const audiobookPath = decodedUrl.replace("audiobook__", "");
            return sendAudiobookCover(req, res, audiobookPath);
        }

        // Check if this is a native cover (prefixed with "native:")
        if (decodedUrl.startsWith("native:")) {
            const nativePath = decodedUrl.replace("native:", "");

            const nativeCacheHit = resolveNativeCoverCacheHit(nativePath);
            if (!nativeCacheHit) {
                logger.warn(
                    `[COVER-ART] Native cover not found: ${nativePath}, trying Deezer fallback`,
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
                        error,
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
                        canonicalNativeCoverUrl,
                    ).catch((error) => {
                        logger.warn(
                            `[COVER-ART] Failed to backfill canonical native path for album ${canonicalAlbumId}:`,
                            error,
                        );
                    });
                }
                logger.debug(
                    `[COVER-ART] Resolved legacy native cover path ${nativePath} -> ${canonicalNativePath}`,
                );
            }

            logger.debug(
                `[COVER-ART] Serving native cover: ${nativeCacheHit.cachePath}`,
            );

            if (
                await trySendResizedNativeCover(
                    req,
                    res,
                    nativeCacheHit.cachePath,
                )
            ) {
                return;
            }

            // Serve the file directly
            const headers: Record<string, string> = {
                "Content-Type": "image/jpeg", // Assume JPEG for now
                "Cache-Control": COVER_ART_IMAGE_CACHE_CONTROL,
                ...buildCoverArtCorsHeaders(req.headers.origin),
            };

            return sendFileFromRoot(
                res,
                nativeCacheHit.cachePath,
                coversBaseDir(),
                { headers },
            );
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

        const { id: resolvedId, album: resolvedAlbum } =
            await resolveCoverId(coverId);

        // Check if this is a native cover (prefixed with "native:")
        if (resolvedId.startsWith("native:")) {
            const nativePath = resolvedId.replace("native:", "");

            const nativeCacheHit = resolveNativeCoverCacheHit(nativePath);
            if (nativeCacheHit) {
                const canonicalNativePath = nativeCacheHit.resolvedNativePath;
                if (canonicalNativePath !== nativePath) {
                    const canonicalNativeCoverUrl = `native:${canonicalNativePath}`;
                    const canonicalAlbumId =
                        getAlbumIdFromNativeCoverPath(canonicalNativePath);
                    /* istanbul ignore else -- native cache hit candidates always normalize to file-name ids */
                    if (canonicalAlbumId) {
                        void persistHealedAlbumCover(
                            canonicalAlbumId,
                            canonicalNativeCoverUrl,
                        ).catch((error) => {
                            logger.warn(
                                `[COVER-ART] Failed to backfill canonical native path for album ${canonicalAlbumId}:`,
                                error,
                            );
                        });
                    }
                    logger.debug(
                        `[COVER-ART] Resolved legacy native cover path ${nativePath} -> ${canonicalNativePath}`,
                    );
                }

                if (
                    await trySendResizedNativeCover(
                        req,
                        res,
                        nativeCacheHit.cachePath,
                    )
                ) {
                    return;
                }

                // Serve the file directly
                const headers: Record<string, string> = {
                    "Content-Type": "image/jpeg",
                    "Cache-Control": COVER_ART_IMAGE_CACHE_CONTROL,
                    ...buildCoverArtCorsHeaders(req.headers.origin),
                };

                return sendFileFromRoot(
                    res,
                    nativeCacheHit.cachePath,
                    coversBaseDir(),
                    { headers },
                );
            }

            // Native cover file missing - try to find album and fetch from Deezer
            logger.warn(
                `[COVER-ART] Native cover not found: ${nativePath}, trying Deezer fallback`,
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
                    error,
                );
            }

            return sendRouteError(res, 404, "Cover art not found");
        }

        // Check if this is an audiobook cover (prefixed with "audiobook__")
        if (resolvedId.startsWith("audiobook__")) {
            const audiobookPath = resolvedId.replace("audiobook__", "");
            return sendAudiobookCover(req, res, audiobookPath);
        }
        // Check if coverId is already a full URL (from Cover Art Archive or elsewhere)
        else if (
            resolvedId.startsWith("http://") ||
            resolvedId.startsWith("https://")
        ) {
            coverUrl = resolvedId;
        } else {
            // Treat as album ID — on-demand cover art fetch for albums with null coverUrl
            const album = resolvedAlbum;

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
                    fetchedCoverUrl =
                        await coverArtService.getCoverArt(validRgMbid);
                } catch (err) {
                    logger.warn(
                        `[COVER-ART] On-demand CAA fetch failed for ${validRgMbid}:`,
                        err,
                    );
                }
            }

            if (!fetchedCoverUrl && album.artist) {
                try {
                    fetchedCoverUrl = await deezerService.getAlbumCover(
                        album.artist.name,
                        album.title,
                    );
                } catch (err) {
                    logger.warn(
                        `[COVER-ART] On-demand Deezer fetch failed for ${album.artist.name} - ${album.title}:`,
                        err,
                    );
                }
            }

            if (fetchedCoverUrl) {
                // Persist the discovered cover URL
                void persistHealedAlbumCover(album.id, fetchedCoverUrl).catch(
                    (err) => {
                        logger.warn(
                            `[COVER-ART] Failed to persist on-demand cover for album ${album.id}:`,
                            err,
                        );
                    },
                );
                coverUrl = fetchedCoverUrl;
            } else {
                if (
                    config.features.federation &&
                    album.remoteId &&
                    album.federationPeer?.outboundStatus === "ACTIVE" &&
                    album.federationPeer.baseUrl &&
                    album.federationPeer.outboundToken
                ) {
                    try {
                        const proxied = await proxyFederatedCover({
                            req,
                            res,
                            peer: album.federationPeer,
                            remoteId: album.remoteId,
                        });
                        if (proxied) return;
                    } catch (error: unknown) {
                        logger.warn("Federated cover proxy failed", { error });
                    }
                }
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

    // Snap the requested size to the allowlist and negotiate the
    // output format (webp when the client supports it). Without a
    // size the original bytes are served untouched.
    const requestedSize = snapCoverArtSize(size);
    const imageFormat = requestedSize
        ? negotiateCoverArtFormat(req.headers.accept)
        : "original";

    // Create cache key from URL + snapped size + negotiated format
    const cacheKey = `cover-art:${crypto
        .createHash("md5")
        .update(`${coverUrl}-${requestedSize || "original"}-${imageFormat}`)
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
                        60,
                    )}...`,
                );
                return res.status(404).json({ error: "Cover art not found" });
            }

            logger.debug(
                `[COVER-ART] Cache HIT for ${coverUrl.substring(0, 60)}...`,
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
                req.headers.origin as string | undefined,
            );
            res.setHeader("Cache-Control", COVER_ART_IMAGE_CACHE_CONTROL);
            res.setHeader("Vary", "Accept");
            res.setHeader("ETag", cachedData.etag);
            return res.send(imageBuffer);
        } else {
            logger.debug(
                `[COVER-ART] ✗ Cache MISS for ${coverUrl.substring(0, 60)}...`,
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
                `[COVER-ART] Blocked invalid cover URL: ${imageResult.url}`,
            );
            return sendRouteError(res, 400, "Invalid cover art URL");
        }

        if (imageResult.status === "not_found") {
            try {
                await redisClient.setEx(
                    cacheKey,
                    COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS,
                    JSON.stringify({ notFound: true }),
                );
                logger.debug(
                    `[COVER-ART] Cached 404 response for ${COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS}s`,
                );
            } catch (cacheError) {
                logger.warn("[COVER-ART] Redis cache write error:", cacheError);
            }

            return sendRouteError(res, 404, "Cover art not found");
        }

        logger.error(
            `[COVER-ART] Failed to fetch: ${imageResult.url} (${imageResult.message || "fetch error"})`,
        );
        return sendRouteError(res, 502, "Failed to fetch cover art");
    }

    logger.debug(`[COVER-ART] Successfully fetched, caching...`);

    // Resize/convert before caching so the cached variant matches
    // the requested size + negotiated format
    const resizeResult = await resizeCoverArt({
        buffer: imageResult.buffer,
        contentType: imageResult.contentType,
        size: requestedSize,
        format: imageFormat,
    });
    const imageBuffer = resizeResult.buffer;
    const responseContentType = resizeResult.contentType;
    const etag = resizeResult.resized
        ? crypto.createHash("md5").update(imageBuffer).digest("hex")
        : imageResult.etag;

    // Cache in Redis for 7 days
    try {
        await redisClient.setEx(
            cacheKey,
            COVER_ART_IMAGE_CACHE_TTL_SECONDS,
            JSON.stringify({
                etag,
                contentType: responseContentType,
                data: imageBuffer.toString("base64"),
            }),
        );
    } catch (cacheError) {
        logger.warn("Redis cache write error:", cacheError);
    }

    // Check if client has cached version
    if (req.headers["if-none-match"] === etag) {
        return res.status(304).end();
    }

    // Set appropriate headers
    if (responseContentType) {
        res.setHeader("Content-Type", responseContentType);
    }

    // Set aggressive caching headers
    applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
    res.setHeader("Cache-Control", COVER_ART_IMAGE_CACHE_CONTROL);
    res.setHeader("Vary", "Accept");
    res.setHeader("ETag", etag);

    // Send the image
    res.send(imageBuffer);
}

coverArtRouter.get<{ id?: string }>(
    "/cover-art{/:id}",
    asyncHandler(handleGetCoverArt),
);

/**
 * @openapi
 * /api/library/album-cover/{mbid}:
 *   get:
 *     summary: Fetch and cache album cover art by MusicBrainz release group ID
 *     tags: [Library]
 *     security:
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
/**
 * Handles GET /api/library/album-cover/:mbid.
 */
export async function handleGetAlbumCover(
    req: Request<{ mbid: string }>,
    res: Response,
) {
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
}

coverArtRouter.get<{ mbid: string }>(
    "/album-cover/:mbid",
    asyncHandler(handleGetAlbumCover),
);

/**
 * @openapi
 * /api/library/cover-art-colors:
 *   get:
 *     summary: Extract dominant colors from a cover art image
 *     tags: [Library]
 *     security:
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
/**
 * Handles GET /api/library/cover-art-colors.
 */
export async function handleGetCoverArtColors(req: Request, res: Response) {
    const { url } = req.query;

    if (!url) {
        return sendRouteError(res, 400, "URL parameter required");
    }

    const rawImageUrl = Array.isArray(url) ? url[0] : url;
    const imageUrl =
        typeof rawImageUrl === "string" ? rawImageUrl : String(rawImageUrl);
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
            `[COLORS] Placeholder image detected, returning fallback colors`,
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
                `[COLORS] Cache HIT for ${normalizedImageUrl.substring(0, 60)}...`,
            );
            return res.json(JSON.parse(cached));
        } else {
            logger.debug(
                `[COLORS] ✗ Cache MISS for ${normalizedImageUrl.substring(0, 60)}...`,
            );
        }
    } catch (cacheError) {
        logger.warn("[COLORS] Redis cache read error:", cacheError);
    }

    // Fetch the image
    logger.debug(
        `[COLORS] Fetching image: ${normalizedImageUrl.substring(0, 100)}...`,
    );
    const imageResult = await fetchExternalImage({
        url: normalizedImageUrl,
        timeoutMs: 15000,
        maxRetries: 2,
    });

    if (!imageResult.ok) {
        if (imageResult.status === "not_found") {
            logger.error(
                `[COLORS] Failed to fetch image: ${imageResult.url} (404)`,
            );
            return sendRouteError(res, 404, "Image not found");
        }

        logger.error(
            `[COLORS] Failed to fetch image: ${imageResult.url} (${imageResult.message || "fetch error"})`,
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
            JSON.stringify(colors),
        );
        logger.debug(`[COLORS] Cached colors for 30 days`);
    } catch (cacheError) {
        logger.warn("[COLORS] Redis cache write error:", cacheError);
    }

    res.json(colors);
}

coverArtRouter.get("/cover-art-colors", asyncHandler(handleGetCoverArtColors));
