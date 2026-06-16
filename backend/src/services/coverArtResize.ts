/**
 * Cover Art Resize Service
 *
 * Server-side downscaling of cover-art images so mobile clients never
 * download multi-megapixel originals for thumbnail-sized renders.
 * Requested sizes are snapped to a small allowlist to bound cache
 * cardinality, images are never upscaled, and webp output is used when
 * the client's Accept header advertises support.
 */

import sharp from "sharp";
import { logger } from "../utils/logger";

/**
 * Allowed cover-art bounding-box sizes (px). Requested sizes are snapped
 * up to the nearest entry; larger requests are capped at the maximum.
 */
export const COVER_ART_SIZES = [64, 128, 192, 320, 512, 768] as const;

/**
 * Output format negotiated from the request Accept header.
 * "original" keeps the source encoding (jpeg/png/...).
 */
export type CoverArtFormat = "webp" | "original";

/**
 * Snaps a raw `size` query value to the cover-art size allowlist.
 * Returns null when the size is missing or invalid (meaning: serve the
 * original image untouched).
 */
export function snapCoverArtSize(
    rawSize: unknown
): number | null {
    const candidate = Array.isArray(rawSize) ? rawSize[0] : rawSize;
    const parsed =
        typeof candidate === "number"
            ? candidate
            : typeof candidate === "string"
              ? parseInt(candidate, 10)
              : NaN;

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    for (const allowed of COVER_ART_SIZES) {
        if (parsed <= allowed) {
            return allowed;
        }
    }
    return COVER_ART_SIZES[COVER_ART_SIZES.length - 1];
}

/**
 * Negotiates the cover-art output format from a request Accept header.
 */
export function negotiateCoverArtFormat(
    acceptHeader: string | undefined
): CoverArtFormat {
    return acceptHeader && acceptHeader.includes("image/webp")
        ? "webp"
        : "original";
}

const FORMAT_CONTENT_TYPES: Record<string, string> = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    tiff: "image/tiff",
};

/** Result of a cover-art resize attempt. */
export interface CoverArtResizeResult {
    /** Output image bytes (the input buffer when no resize happened). */
    buffer: Buffer;
    /** Content type matching the output encoding. */
    contentType: string | null;
    /** True when the image was re-encoded (resized and/or converted). */
    resized: boolean;
}

/**
 * Resizes a cover-art buffer to fit within `size` x `size` (aspect
 * preserved, never upscaled) and optionally converts it to webp.
 * Returns the original buffer untouched when `size` is null or when the
 * input cannot be decoded as an image.
 */
export async function resizeCoverArt(options: {
    buffer: Buffer;
    contentType: string | null;
    size: number | null;
    format: CoverArtFormat;
}): Promise<CoverArtResizeResult> {
    const { buffer, contentType, size, format } = options;

    if (size === null) {
        return { buffer, contentType, resized: false };
    }

    try {
        let pipeline = sharp(buffer).resize({
            width: size,
            height: size,
            fit: "inside",
            withoutEnlargement: true,
        });
        if (format === "webp") {
            pipeline = pipeline.webp();
        }

        const { data, info } = await pipeline.toBuffer({
            resolveWithObject: true,
        });
        const outputContentType =
            FORMAT_CONTENT_TYPES[info.format] || contentType;

        return { buffer: data, contentType: outputContentType, resized: true };
    } catch (error) {
        logger.warn("[COVER-ART] Resize failed, serving original:", error);
        return { buffer, contentType, resized: false };
    }
}
