import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { fetchExternalImage } from "./imageProxy";

const MIN_IMAGE_BYTES = 500;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — YouTube thumbnails are typically 20-100 KB
let cacheDir: string | null = null;

/**
 * Resolves the browse image cache directory path, creating it lazily on first call.
 */
function ensureCacheDir(): string {
    if (cacheDir) return cacheDir;
    cacheDir = path.join(config.music.transcodeCachePath, "../covers/browse");
    fs.mkdirSync(cacheDir, { recursive: true });
    return cacheDir;
}

/**
 * Produces a deterministic cache key (SHA-256 hex) for a given URL.
 */
export function browseImageCacheKey(url: string): string {
    return crypto.createHash("sha256").update(url).digest("hex");
}

/**
 * Cached image metadata stored alongside the file.
 */
export interface BrowseImageCacheEntry {
    filePath: string;
    contentType: string;
}

/**
 * Returns the cached image entry if the file exists on disk, or null.
 */
export function getBrowseImageFromCache(
    key: string
): BrowseImageCacheEntry | null {
    const dir = ensureCacheDir();
    const filePath = path.join(dir, `${key}.img`);
    const metaPath = path.join(dir, `${key}.meta`);
    if (!fs.existsSync(filePath)) return null;

    let contentType = "image/jpeg";
    try {
        const meta = fs.readFileSync(metaPath, "utf-8").trim();
        if (meta) contentType = meta;
    } catch {
        // Missing meta file is fine — default to image/jpeg
    }

    return { filePath, contentType };
}

/**
 * Fetches an external image via the shared image proxy, writes it to disk cache
 * atomically (write-to-temp then rename), and returns the cache entry — or null on failure.
 */
export async function fetchAndCacheBrowseImage(
    url: string
): Promise<BrowseImageCacheEntry | null> {
    const result = await fetchExternalImage({ url });
    if (!result.ok) {
        logger.warn(
            `[BrowseImageCache] Failed to fetch image: ${result.status} — ${result.message ?? url}`
        );
        return null;
    }

    const contentType = result.contentType ?? "";
    if (contentType && !contentType.startsWith("image/")) {
        logger.warn(
            `[BrowseImageCache] Rejected non-image content-type: ${contentType} — ${url}`
        );
        return null;
    }

    if (result.buffer.length < MIN_IMAGE_BYTES) {
        logger.warn(
            `[BrowseImageCache] Rejected tiny response (${result.buffer.length} bytes) — ${url}`
        );
        return null;
    }

    if (result.buffer.length > MAX_IMAGE_BYTES) {
        logger.warn(
            `[BrowseImageCache] Rejected oversized response (${result.buffer.length} bytes) — ${url}`
        );
        return null;
    }

    const key = browseImageCacheKey(url);
    const dir = ensureCacheDir();
    const filePath = path.join(dir, `${key}.img`);
    const metaPath = path.join(dir, `${key}.meta`);
    const tmpPath = path.join(dir, `${key}.tmp`);

    try {
        // Atomic write: write to temp file, then rename to final path
        fs.writeFileSync(tmpPath, result.buffer);
        fs.renameSync(tmpPath, filePath);

        // Store content-type metadata
        const resolvedType = contentType || "image/jpeg";
        fs.writeFileSync(metaPath, resolvedType);

        return { filePath, contentType: resolvedType };
    } catch (err) {
        logger.error(`[BrowseImageCache] Failed to write cache file:`, err);
        // Clean up temp file if it exists
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            // Ignore cleanup errors
        }
        return null;
    }
}
