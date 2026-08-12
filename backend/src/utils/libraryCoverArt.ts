import crypto from "crypto";
import fs from "fs";
import type {
    Request as ExpressRequest,
    Response as ExpressResponse,
} from "express";
import { config } from "../config";
import { BRAND_USER_AGENT } from "../config/brand";
import { buildSafeAudiobookCoverUrl } from "../services/audiobookCoverProxy";
import {
    negotiateCoverArtFormat,
    resizeCoverArt,
    snapCoverArtSize,
} from "../services/coverArtResize";
import {
    MAX_EXTERNAL_IMAGE_BYTES,
    readResponseBodyWithByteCap,
} from "../services/imageProxy";
import { sendRouteError } from "../routes/routeErrorResponse";
import { isOriginAllowed } from "./cors";
import { logger } from "./logger";
import { redisClient } from "./redis";
import { getSystemSettings } from "./systemSettings";

/** Lifetime of a successful cover-art image cache entry. */
export const COVER_ART_IMAGE_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
/** Lifetime of a negative cover-art cache entry. */
export const COVER_ART_NOT_FOUND_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
/** Browser cache policy for immutable cover-art responses. */
export const COVER_ART_IMAGE_CACHE_CONTROL = `public, max-age=${COVER_ART_IMAGE_CACHE_TTL_SECONDS}, immutable`;

/**
 * Builds cover-art CORS headers from the same origin allowlist enforced by the
 * Express app. Unlisted origins get no CORS headers; requests without an
 * Origin receive a wildcard header.
 */
export const buildCoverArtCorsHeaders = (
    origin?: string,
): Record<string, string> => {
    const headers: Record<string, string> = {
        "Cross-Origin-Resource-Policy": "cross-origin",
    };
    if (!origin) {
        headers["Access-Control-Allow-Origin"] = "*";
    } else if (isOriginAllowed(origin, config.allowedOrigins, config.nodeEnv)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
    }
    return headers;
};

/** Applies the allowlisted CORS response headers used for library cover art. */
export const applyCoverArtCorsHeaders = (
    res: ExpressResponse,
    origin?: string,
) => {
    for (const [name, value] of Object.entries(
        buildCoverArtCorsHeaders(origin),
    )) {
        res.setHeader(name, value);
    }
};

/** Fetches and returns an authenticated Audiobookshelf cover image. */
export const sendAudiobookCover = async (
    req: ExpressRequest,
    res: ExpressResponse,
    audiobookPath: string,
): Promise<ExpressResponse> => {
    const coverArtLogger = logger.child("CoverArt");
    const settings = await getSystemSettings();
    const audiobookshelfUrl =
        settings?.audiobookshelfUrl || process.env.AUDIOBOOKSHELF_URL || "";
    const audiobookshelfApiKey =
        settings?.audiobookshelfApiKey ||
        (config.secretsDbOnly ? "" : process.env.AUDIOBOOKSHELF_API_KEY || "");
    const coverUrl = buildSafeAudiobookCoverUrl(
        audiobookPath,
        audiobookshelfUrl.replace(/\/$/, ""),
    );

    if (!coverUrl) {
        coverArtLogger.warn("Blocked unsafe audiobook cover path", {
            audiobookPath,
        });
        return sendRouteError(res, 400, "Invalid audiobook cover path");
    }

    coverArtLogger.debug("Fetching audiobook cover", { coverUrl });
    const imageResponse = await fetch(coverUrl, {
        headers: {
            Authorization: `Bearer ${audiobookshelfApiKey}`,
            "User-Agent": BRAND_USER_AGENT,
        },
        signal: AbortSignal.timeout(15000),
    });

    if (!imageResponse.ok) {
        coverArtLogger.error("Failed to fetch audiobook cover", {
            coverUrl,
            status: imageResponse.status,
            statusText: imageResponse.statusText,
        });
        try {
            await imageResponse.body?.cancel();
        } catch (error) {
            coverArtLogger.warn("Failed to cancel audiobook cover body", {
                coverUrl,
                error,
            });
        }
        return sendRouteError(res, 404, "Audiobook cover art not found");
    }

    const bodyResult = await readResponseBodyWithByteCap(
        imageResponse,
        MAX_EXTERNAL_IMAGE_BYTES,
    );
    if (!bodyResult.ok) {
        return sendRouteError(res, 404, "Audiobook cover art not found");
    }
    const imageBuffer = bodyResult.buffer;
    const contentType = imageResponse.headers.get("content-type");
    if (contentType) {
        res.setHeader("Content-Type", contentType);
    }
    applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
    res.setHeader("Cache-Control", COVER_ART_IMAGE_CACHE_CONTROL);
    return res.send(imageBuffer);
};

const sendResizedNativeCoverResponse = (
    req: ExpressRequest,
    res: ExpressResponse,
    etag: string,
    contentType: string | null,
    buffer: Buffer,
): void => {
    if (contentType) {
        res.setHeader("Content-Type", contentType);
    }
    applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
    res.setHeader("Cache-Control", COVER_ART_IMAGE_CACHE_CONTROL);
    res.setHeader("Vary", "Accept");
    res.setHeader("ETag", etag);
    res.send(buffer);
};

/**
 * Serves a native cover file resized to the requested `size` query param.
 * Resized variants are cached in Redis keyed by file identity
 * (path + mtime + size on disk) plus the snapped size and negotiated
 * format, so repeat requests and If-None-Match revalidations are
 * answered without re-decoding the image. Returns true when a response
 * was sent; false when the caller should fall back to sending the
 * original file from disk.
 */
export const trySendResizedNativeCover = async (
    req: ExpressRequest,
    res: ExpressResponse,
    cachePath: string,
): Promise<boolean> => {
    const requestedSize = snapCoverArtSize(req.query.size);
    if (!requestedSize) {
        return false;
    }

    try {
        const imageFormat = negotiateCoverArtFormat(req.headers.accept);
        const fileStat = await fs.promises.stat(cachePath);
        const cacheKey = `cover-art:native:${crypto
            .createHash("md5")
            .update(
                `${cachePath}-${fileStat.mtimeMs}-${fileStat.size}-${requestedSize}-${imageFormat}`,
            )
            .digest("hex")}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const cachedData = JSON.parse(cached);
                if (req.headers["if-none-match"] === cachedData.etag) {
                    res.status(304).end();
                    return true;
                }
                sendResizedNativeCoverResponse(
                    req,
                    res,
                    cachedData.etag,
                    cachedData.contentType ?? null,
                    Buffer.from(cachedData.data, "base64"),
                );
                return true;
            }
        } catch (cacheError) {
            logger.warn("[COVER-ART] Redis cache read error:", cacheError);
        }

        const fileBuffer = await fs.promises.readFile(cachePath);
        const resizeResult = await resizeCoverArt({
            buffer: fileBuffer,
            contentType: "image/jpeg",
            size: requestedSize,
            format: imageFormat,
        });
        if (!resizeResult.resized) {
            return false;
        }

        const etag = crypto
            .createHash("md5")
            .update(resizeResult.buffer)
            .digest("hex");

        try {
            await redisClient.setEx(
                cacheKey,
                COVER_ART_IMAGE_CACHE_TTL_SECONDS,
                JSON.stringify({
                    etag,
                    contentType: resizeResult.contentType,
                    data: resizeResult.buffer.toString("base64"),
                }),
            );
        } catch (cacheError) {
            logger.warn("[COVER-ART] Redis cache write error:", cacheError);
        }

        if (req.headers["if-none-match"] === etag) {
            res.status(304).end();
            return true;
        }

        sendResizedNativeCoverResponse(
            req,
            res,
            etag,
            resizeResult.contentType,
            resizeResult.buffer,
        );
        return true;
    } catch (error) {
        logger.warn(
            `[COVER-ART] Native cover resize failed for ${cachePath}:`,
            error,
        );
        return false;
    }
};
