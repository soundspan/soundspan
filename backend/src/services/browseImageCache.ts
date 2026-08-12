import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { coalesceInFlightByKey } from "../utils/singleflight";
import { fetchExternalImage } from "./imageProxy";

const MIN_IMAGE_BYTES = 500;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — YouTube thumbnails are typically 20-100 KB
const QUERYLESS_THUMBNAIL_HOST_SUFFIXES = [
    ".googleusercontent.com",
    ".ggpht.com",
    ".ytimg.com",
];
const QUERYLESS_THUMBNAIL_HOSTS = new Set(["resources.tidal.com"]);
const CACHE_FILE_PATTERN = /^([a-f0-9]{64})\.(img|meta)$/;
const browseImageCacheLogger = logger.child("BrowseImageCache");
const inFlightFetches = new Map<
    string,
    Promise<BrowseImageCacheEntry | null>
>();
let cacheDirPromise: Promise<string> | null = null;
let mutationTail: Promise<void> = Promise.resolve();

interface DiskCacheEntry {
    key: string;
    imagePath: string;
    metaPath: string;
    totalBytes: number;
    lastAccessedMs: number;
}

/**
 * Returns the canonical root used for server-managed browse images.
 */
export function getBrowseImageCacheRoot(): string {
    return path.resolve(config.music.transcodeCachePath, "../covers/browse");
}

/** Resolves the browse image cache root, creating it lazily on first call. */
function ensureCacheDir(): Promise<string> {
    if (cacheDirPromise) return cacheDirPromise;
    const cacheDir = getBrowseImageCacheRoot();
    cacheDirPromise = fs
        .mkdir(cacheDir, { recursive: true })
        .then(() => cacheDir);
    return cacheDirPromise;
}

function isMissingFileError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function runCacheMutation<T>(work: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(work, work);
    mutationTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function isQuerylessThumbnailHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return (
        QUERYLESS_THUMBNAIL_HOSTS.has(normalized) ||
        QUERYLESS_THUMBNAIL_HOST_SUFFIXES.some(
            (suffix) =>
                normalized === suffix.slice(1) || normalized.endsWith(suffix),
        )
    );
}

/**
 * Canonicalizes provider thumbnail URLs without collapsing path-based image transforms.
 */
export function canonicalizeBrowseImageUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = "";
        if (isQuerylessThumbnailHost(parsed.hostname)) parsed.search = "";
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Produces a deterministic cache key (SHA-256 hex) for a given URL.
 */
export function browseImageCacheKey(url: string): string {
    return crypto
        .createHash("sha256")
        .update(canonicalizeBrowseImageUrl(url))
        .digest("hex");
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
export async function getBrowseImageFromCache(
    key: string,
): Promise<BrowseImageCacheEntry | null> {
    return runCacheMutation(async () => {
        const dir = await ensureCacheDir();
        return readCachedEntry(dir, key, true);
    });
}

async function readCachedEntry(
    dir: string,
    key: string,
    touch: boolean,
): Promise<BrowseImageCacheEntry | null> {
    const filePath = path.join(dir, `${key}.img`);
    const metaPath = path.join(dir, `${key}.meta`);
    try {
        await fs.access(filePath);
    } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
    }

    const contentType = await readContentType(metaPath);
    if (touch) await touchCachePair(filePath, metaPath);
    return { filePath, contentType };
}

async function readContentType(metaPath: string): Promise<string> {
    try {
        return (await fs.readFile(metaPath, "utf8")).trim() || "image/jpeg";
    } catch (error) {
        if (!isMissingFileError(error)) {
            browseImageCacheLogger.warn("Failed to read cache metadata", {
                metaPath,
                error,
            });
        }
        return "image/jpeg";
    }
}

async function touchCachePair(
    imagePath: string,
    metaPath: string,
): Promise<void> {
    const now = new Date();
    const results = await Promise.allSettled([
        fs.utimes(imagePath, now, now),
        fs.utimes(metaPath, now, now),
    ]);
    const imageTouch = results[0];
    if (imageTouch.status === "rejected") throw imageTouch.reason;
}

async function statCacheEntry(
    dir: string,
    key: string,
): Promise<DiskCacheEntry | null> {
    const imagePath = path.join(dir, `${key}.img`);
    const metaPath = path.join(dir, `${key}.meta`);
    try {
        const imageStat = await fs.stat(imagePath);
        const metaStat = await fs.stat(metaPath).catch((error: unknown) => {
            if (isMissingFileError(error)) return null;
            throw error;
        });
        return {
            key,
            imagePath,
            metaPath,
            totalBytes: imageStat.size + (metaStat?.size ?? 0),
            lastAccessedMs: Math.max(
                imageStat.mtimeMs,
                metaStat?.mtimeMs ?? imageStat.mtimeMs,
            ),
        };
    } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
    }
}

async function removeFileIfPresent(filePath: string): Promise<void> {
    try {
        await fs.unlink(filePath);
    } catch (error) {
        if (!isMissingFileError(error)) throw error;
    }
}

async function removeCacheEntry(entry: DiskCacheEntry): Promise<void> {
    await removeFileIfPresent(entry.imagePath);
    await removeFileIfPresent(entry.metaPath);
}

async function listCacheEntries(dir: string): Promise<DiskCacheEntry[]> {
    const directoryEntries = await fs.readdir(dir, { withFileTypes: true });
    const fileNames = new Set(
        directoryEntries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name),
    );
    const entries: DiskCacheEntry[] = [];

    for (const fileName of fileNames) {
        if (fileName.endsWith(".tmp")) {
            await removeFileIfPresent(path.join(dir, fileName));
            continue;
        }
        const match = CACHE_FILE_PATTERN.exec(fileName);
        if (!match || match[2] !== "img") continue;
        const entry = await statCacheEntry(dir, match[1]);
        if (entry) entries.push(entry);
    }

    for (const fileName of fileNames) {
        const match = CACHE_FILE_PATTERN.exec(fileName);
        if (!match || match[2] !== "meta") continue;
        if (!fileNames.has(`${match[1]}.img`)) {
            await removeFileIfPresent(path.join(dir, fileName));
        }
    }
    return entries;
}

function isWithinQuota(entryCount: number, totalBytes: number): boolean {
    return (
        entryCount <= config.browseImageCache.maxEntries &&
        totalBytes <= config.browseImageCache.maxBytes
    );
}

async function makeRoomForEntry(
    dir: string,
    incomingBytes: number,
): Promise<boolean> {
    if (!isWithinQuota(1, incomingBytes)) return false;
    const entries = await listCacheEntries(dir);
    entries.sort(
        (left, right) =>
            left.lastAccessedMs - right.lastAccessedMs ||
            left.key.localeCompare(right.key),
    );
    let totalBytes = entries.reduce((sum, entry) => sum + entry.totalBytes, 0);
    let entryCount = entries.length;
    for (const entry of entries) {
        if (isWithinQuota(entryCount + 1, totalBytes + incomingBytes)) break;
        await removeCacheEntry(entry);
        totalBytes -= entry.totalBytes;
        entryCount -= 1;
    }
    return isWithinQuota(entryCount + 1, totalBytes + incomingBytes);
}

async function writeCacheEntry(
    key: string,
    buffer: Buffer,
    contentType: string,
): Promise<BrowseImageCacheEntry | null> {
    return runCacheMutation(async () => {
        const dir = await ensureCacheDir();
        const existing = await readCachedEntry(dir, key, true);
        if (existing) return existing;
        const incomingBytes = buffer.length + Buffer.byteLength(contentType);
        if (!(await makeRoomForEntry(dir, incomingBytes))) {
            browseImageCacheLogger.warn(
                "Image exceeds configured cache quota",
                {
                    incomingBytes,
                },
            );
            return null;
        }
        return persistCacheEntry(dir, key, buffer, contentType);
    });
}

async function persistCacheEntry(
    dir: string,
    key: string,
    buffer: Buffer,
    contentType: string,
): Promise<BrowseImageCacheEntry | null> {
    const filePath = path.join(dir, `${key}.img`);
    const metaPath = path.join(dir, `${key}.meta`);
    const tempId = `${key}.${process.pid}.${crypto.randomUUID()}`;
    const imageTempPath = path.join(dir, `${tempId}.img.tmp`);
    const metaTempPath = path.join(dir, `${tempId}.meta.tmp`);
    try {
        await fs.writeFile(imageTempPath, buffer, { flag: "wx" });
        await fs.writeFile(metaTempPath, contentType, { flag: "wx" });
        await fs.rename(metaTempPath, metaPath);
        await fs.rename(imageTempPath, filePath);
        return { filePath, contentType };
    } catch (error) {
        browseImageCacheLogger.error("Failed to write cache entry", { error });
        await Promise.allSettled([
            removeFileIfPresent(imageTempPath),
            removeFileIfPresent(metaTempPath),
            removeFileIfPresent(metaPath),
        ]);
        return null;
    }
}

/**
 * Fetches an external image via the shared image proxy, writes it to disk cache
 * atomically (write-to-temp then rename), and returns the cache entry — or null on failure.
 */
export async function fetchAndCacheBrowseImage(
    url: string,
): Promise<BrowseImageCacheEntry | null> {
    const key = browseImageCacheKey(url);
    return coalesceInFlightByKey(inFlightFetches, key, () =>
        fetchAndCacheBrowseImageOnce(url, key),
    );
}

async function fetchAndCacheBrowseImageOnce(
    url: string,
    key: string,
): Promise<BrowseImageCacheEntry | null> {
    const result = await fetchExternalImage({ url });
    if (!result.ok) {
        browseImageCacheLogger.warn("Failed to fetch image", {
            status: result.status,
            message: result.message,
            url,
        });
        return null;
    }

    const contentType = resolveImageContentType(result.contentType, url);
    if (!contentType || !isImageSizeAllowed(result.buffer.length, url)) {
        return null;
    }
    return writeCacheEntry(key, result.buffer, contentType);
}

function resolveImageContentType(
    contentType: string | null | undefined,
    url: string,
): string | null {
    const resolved = contentType ?? "";
    if (resolved && !resolved.startsWith("image/")) {
        browseImageCacheLogger.warn("Rejected non-image content type", {
            contentType: resolved,
            url,
        });
        return null;
    }
    return resolved || "image/jpeg";
}

function isImageSizeAllowed(bytes: number, url: string): boolean {
    if (bytes < MIN_IMAGE_BYTES) {
        browseImageCacheLogger.warn("Rejected tiny image response", {
            bytes,
            url,
        });
        return false;
    }
    if (bytes > MAX_IMAGE_BYTES) {
        browseImageCacheLogger.warn("Rejected oversized image response", {
            bytes,
            url,
        });
        return false;
    }
    return true;
}
