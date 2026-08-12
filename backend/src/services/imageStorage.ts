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
import { safeResolvePath } from "../utils/safeResolvePath";
import { fetchExternalImage } from "./imageProxy";

const ARTIST_IMAGES_DIR = "artists";
const ALBUM_IMAGES_DIR = "albums";
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
type ImageType = "artist" | "album";

/**
 * Get the base covers directory path
 */
function getCoversBasePath(): string {
    return path.join(config.music.transcodeCachePath, "../covers");
}

function getImageDirectory(type: ImageType): string {
    const subdir =
        type === "artist" ? ARTIST_IMAGES_DIR : ALBUM_IMAGES_DIR;
    return path.resolve(getCoversBasePath(), subdir);
}

function resolveImagePath(id: string, type: ImageType): string | null {
    if (!IMAGE_ID_PATTERN.test(id)) return null;
    return safeResolvePath(getImageDirectory(type), `${id}.jpg`);
}

function resolveNativeImagePath(nativePath: string): string | null {
    const artistPrefix = `native:${ARTIST_IMAGES_DIR}/`;
    const albumPrefix = `native:${ALBUM_IMAGES_DIR}/`;
    const type = nativePath.startsWith(artistPrefix) ? "artist" : "album";
    const prefix = type === "artist" ? artistPrefix : albumPrefix;
    if (!nativePath.startsWith(prefix) || !nativePath.endsWith(".jpg")) {
        return null;
    }

    const id = nativePath.slice(prefix.length, -".jpg".length);
    return resolveImagePath(id, type);
}

/**
 * Ensure the covers directory exists
 */
function ensureCoversDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.debug(`[ImageStorage] Created directory: ${dirPath}`);
    }
}

/**
 * Download an image from URL and save locally
 * Returns the native path (e.g., "native:artists/artistId.jpg") or null on failure
 */
export async function downloadAndStoreImage(
    url: string,
    id: string,
    type: ImageType,
): Promise<string | null> {
    const filePath = resolveImagePath(id, type);
    if (!url || !filePath) return null;

    const subdir = type === "artist" ? ARTIST_IMAGES_DIR : ALBUM_IMAGES_DIR;
    const filename = `${id}.jpg`;
    ensureCoversDir(path.dirname(filePath));

    try {
        logger.debug(
            `[ImageStorage] Downloading ${type} image: ${url.substring(0, 60)}...`,
        );

        const result = await fetchExternalImage({
            url,
            timeoutMs: 30000,
            maxRetries: 1,
        });

        if (!result.ok) {
            logger.debug(
                `[ImageStorage] Download failed: ${result.message ?? result.status}`,
            );
            return null;
        }

        const contentType = result.contentType || "";
        if (!contentType.startsWith("image/")) {
            logger.debug(`[ImageStorage] Not an image: ${contentType}`);
            return null;
        }

        const buffer = result.buffer;
        if (buffer.byteLength < 1000) {
            logger.debug(
                `[ImageStorage] Image too small (${buffer.byteLength} bytes), likely placeholder`,
            );
            return null;
        }

        fs.writeFileSync(filePath, buffer);
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
    const fullPath = resolveNativeImagePath(nativePath);
    if (!fullPath) return false;
    return fs.existsSync(fullPath);
}

/**
 * Get the full filesystem path for a native image path
 */
export function getLocalImagePath(nativePath: string): string | null {
    const fullPath = resolveNativeImagePath(nativePath);
    if (!fullPath) return null;

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
