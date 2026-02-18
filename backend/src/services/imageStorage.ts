/**
 * Image Storage Service
 *
 * Downloads and stores images locally for fast serving.
 * Images are stored in the covers directory and served directly from disk.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { BRAND_USER_AGENT } from "../config/brand";

const ARTIST_IMAGES_DIR = "artists";
const ALBUM_IMAGES_DIR = "albums";

/**
 * Get the base covers directory path
 */
function getCoversBasePath(): string {
    return path.join(config.music.transcodeCachePath, "../covers");
}

/**
 * Ensure the covers directory exists
 */
function ensureCoversDir(subdir: string): string {
    const dirPath = path.join(getCoversBasePath(), subdir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.debug(`[ImageStorage] Created directory: ${dirPath}`);
    }
    return dirPath;
}

/**
 * Download an image from URL and save locally
 * Returns the native path (e.g., "native:artists/artistId.jpg") or null on failure
 */
export async function downloadAndStoreImage(
    url: string,
    id: string,
    type: "artist" | "album"
): Promise<string | null> {
    if (!url) return null;

    const subdir = type === "artist" ? ARTIST_IMAGES_DIR : ALBUM_IMAGES_DIR;
    const dirPath = ensureCoversDir(subdir);
    const filename = `${id}.jpg`;
    const filePath = path.join(dirPath, filename);

    try {
        logger.debug(`[ImageStorage] Downloading ${type} image: ${url.substring(0, 60)}...`);

        const response = await fetch(url, {
            headers: {
                "User-Agent": BRAND_USER_AGENT,
            },
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            logger.debug(`[ImageStorage] Failed to download: ${response.status}`);
            return null;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) {
            logger.debug(`[ImageStorage] Not an image: ${contentType}`);
            return null;
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength < 1000) {
            logger.debug(`[ImageStorage] Image too small (${buffer.byteLength} bytes), likely placeholder`);
            return null;
        }

        fs.writeFileSync(filePath, Buffer.from(buffer));
        logger.debug(`[ImageStorage] Saved ${type} image: ${filename}`);

        return `native:${subdir}/${filename}`;
    } catch (error: any) {
        logger.debug(`[ImageStorage] Download failed: ${error.message}`);
        return null;
    }
}

/**
 * Check if a local image exists
 */
export function localImageExists(nativePath: string): boolean {
    if (!nativePath.startsWith("native:")) return false;

    const relativePath = nativePath.replace("native:", "");
    const fullPath = path.join(getCoversBasePath(), relativePath);
    return fs.existsSync(fullPath);
}

/**
 * Get the full filesystem path for a native image path
 */
export function getLocalImagePath(nativePath: string): string | null {
    if (!nativePath.startsWith("native:")) return null;

    const relativePath = nativePath.replace("native:", "");
    const fullPath = path.join(getCoversBasePath(), relativePath);

    if (!fs.existsSync(fullPath)) return null;
    return fullPath;
}

/**
 * Delete a local image
 */
export function deleteLocalImage(nativePath: string): boolean {
    const fullPath = getLocalImagePath(nativePath);
    if (!fullPath) return false;

    try {
        fs.unlinkSync(fullPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a URL is an external URL (not already local)
 */
export function isExternalUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Check if a URL is a native local path
 */
export function isNativePath(url: string | null | undefined): boolean {
    if (!url) return false;
    return url.startsWith("native:");
}
