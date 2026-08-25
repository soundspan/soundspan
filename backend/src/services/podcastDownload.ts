import { prisma, Prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";
import fs from "fs/promises";
import type { WriteStream } from "node:fs";
import path from "path";
import axios, { type AxiosResponse } from "axios";
import pLimit from "p-limit";
import { BRAND_USER_AGENT } from "../config/brand";
import {
    resolveSafeOutboundRedirectTarget,
    resolveSafeOutboundUrl,
} from "./outboundUrlSafety";
import { safeResolvePath } from "../utils/safeResolvePath";

/**
 * PodcastDownloadService - Background download and caching of podcast episodes
 *
 * Features:
 * - Non-blocking background downloads when episodes are played
 * - 30-day cache expiry with automatic cleanup
 * - Proper range request support for cached files
 */

// Track in-progress downloads to avoid duplicates
const downloadingEpisodes = new Set<string>();

// Track download progress (episodeId -> { bytesDownloaded, totalBytes })
interface DownloadProgress {
    bytesDownloaded: number;
    totalBytes: number;
}
const downloadProgress = new Map<string, DownloadProgress>();
const PODCAST_DOWNLOAD_PRISMA_RETRY_ATTEMPTS = 3;
const PODCAST_DOWNLOAD_IDLE_TIMEOUT_MS = 120_000;
const MAX_PODCAST_DOWNLOAD_REDIRECTS = 5;
const MAX_PODCAST_EPISODE_ID_LENGTH = 128;
const PODCAST_EPISODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PODCAST_AUTO_CACHE_CONCURRENCY = 3;
const PODCAST_AUTO_CACHE_QUEUE_CAPACITY = 32;
/** Maximum declared or observed bytes accepted for one podcast download. */
export const MAX_PODCAST_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const podcastDownloadLogger = logger.child("PodcastDownload");
const autoCacheDownloadLimit = pLimit(PODCAST_AUTO_CACHE_CONCURRENCY);
const admittedAutoCacheDownloads = new Set<Promise<void>>();

class PodcastDownloadBlockedError extends Error {
    constructor(url: string) {
        super(`Blocked SSRF-unsafe podcast download target: ${url}`);
        this.name = "PodcastDownloadBlockedError";
    }
}

class PodcastDownloadLimitError extends Error {
    constructor() {
        super("Podcast enclosure exceeds maximum download size");
        this.name = "PodcastDownloadLimitError";
    }
}

class PodcastDownloadAuthorizationError extends Error {
    constructor() {
        super("Podcast episode is not available to this user");
        this.name = "PodcastDownloadAuthorizationError";
    }
}

async function openSafePodcastDownloadStream(
    rawUrl: string,
    signal?: AbortSignal,
): Promise<import("axios").AxiosResponse> {
    let current = await resolveSafeOutboundUrl(rawUrl);
    if (!current) throw new PodcastDownloadBlockedError(rawUrl);

    for (let hop = 0; hop <= MAX_PODCAST_DOWNLOAD_REDIRECTS; hop += 1) {
        const response = await axios.get(current, {
            responseType: "stream",
            timeout: 600000,
            signal,
            maxRedirects: 0,
            headers: { "User-Agent": BRAND_USER_AGENT },
            decompress: false,
            validateStatus: (status) =>
                (status >= 200 && status < 300) ||
                (status >= 300 && status < 400),
        });
        if (response.status < 300) return response;
        if (response.data && typeof response.data.destroy === "function") {
            response.data.destroy();
        }
        if (hop === MAX_PODCAST_DOWNLOAD_REDIRECTS) {
            throw new PodcastDownloadBlockedError(current);
        }
        const location =
            typeof response.headers?.location === "string"
                ? response.headers.location
                : undefined;
        if (!location) throw new PodcastDownloadBlockedError(current);
        const next = await resolveSafeOutboundRedirectTarget(location, current);
        if (!next) throw new PodcastDownloadBlockedError(location);
        current = next;
    }
    throw new PodcastDownloadBlockedError(current);
}

function isRetryablePodcastDownloadPrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return ["P1001", "P1002", "P1017", "P2024", "P2037"].includes(
            error.code,
        );
    }

    if (error instanceof Prisma.PrismaClientRustPanicError) {
        return true;
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        const message = error.message || "";
        return (
            message.includes("Response from the Engine was empty") ||
            message.includes("Engine has already exited")
        );
    }

    const message =
        error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Response from the Engine was empty") ||
        message.includes("Engine has already exited") ||
        message.includes("Can't reach database server") ||
        message.includes("Connection reset")
    );
}

async function withPodcastDownloadPrismaRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    for (
        let attempt = 1;
        attempt <= PODCAST_DOWNLOAD_PRISMA_RETRY_ATTEMPTS;
        attempt += 1
    ) {
        try {
            return await operation();
        } catch (error) {
            if (
                !isRetryablePodcastDownloadPrismaError(error) ||
                attempt === PODCAST_DOWNLOAD_PRISMA_RETRY_ATTEMPTS
            ) {
                throw error;
            }

            podcastDownloadLogger.warn(
                `${operationName} failed (attempt ${attempt}/${PODCAST_DOWNLOAD_PRISMA_RETRY_ATTEMPTS}), retrying`,
                error,
            );
            await prisma.$connect().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
    throw new Error(`${operationName} exhausted its retry bound`);
}

// Cache directory for podcast audio files
const getPodcastCacheDir = (): string => {
    return path.resolve(config.music.transcodeCachePath, "../podcast-audio");
};

function isValidEpisodeId(episodeId: string): boolean {
    return (
        episodeId.length > 0 &&
        episodeId.length <= MAX_PODCAST_EPISODE_ID_LENGTH &&
        PODCAST_EPISODE_ID_PATTERN.test(episodeId)
    );
}

function resolvePodcastCacheFile(
    episodeId: string,
    extension: "mp3" | "tmp",
): string | null {
    if (!isValidEpisodeId(episodeId)) return null;
    return safeResolvePath(getPodcastCacheDir(), `${episodeId}.${extension}`);
}

function resolveStoredPodcastCacheFile(localPath: string): string | null {
    const cacheDir = getPodcastCacheDir();
    const resolvedLocalPath = path.resolve(localPath);
    if (path.extname(resolvedLocalPath).toLowerCase() !== ".mp3") return null;
    const relativePath = path.relative(cacheDir, resolvedLocalPath);
    return safeResolvePath(cacheDir, relativePath);
}

interface AuthorizedCacheMetadata {
    episode: { fileSize: number | null; podcastId: string };
    download: { userId: string; fileSizeMb: number };
}

async function findAuthorizedCacheMetadata(
    episodeId: string,
): Promise<AuthorizedCacheMetadata | null> {
    const episode = await withPodcastDownloadPrismaRetry(
        "getCachedFilePath.podcastEpisode.findUnique",
        () =>
            prisma.podcastEpisode.findUnique({
                where: { id: episodeId },
                select: { fileSize: true, podcastId: true },
            }),
    );
    if (!episode) return null;

    const download = await withPodcastDownloadPrismaRetry(
        "getCachedFilePath.podcastDownload.findFirst",
        () =>
            prisma.podcastDownload.findFirst({
                where: { episodeId },
                select: { userId: true, fileSizeMb: true },
            }),
    );
    if (!download) return null;

    const subscription = await withPodcastDownloadPrismaRetry(
        "getCachedFilePath.podcastSubscription.findUnique",
        () =>
            prisma.podcastSubscription.findUnique({
                where: {
                    userId_podcastId: {
                        userId: download.userId,
                        podcastId: episode.podcastId,
                    },
                },
                select: { userId: true },
            }),
    );
    return subscription ? { episode, download } : null;
}

async function deleteInvalidCachedFile(
    episodeId: string,
    cachedPath: string,
    reason: string,
): Promise<void> {
    podcastDownloadLogger.debug(`${reason} for ${episodeId}, deleting cache`);
    await fs.unlink(cachedPath).catch(() => {});
    await withPodcastDownloadPrismaRetry(
        "getCachedFilePath.podcastDownload.deleteMany.invalidSize",
        () => prisma.podcastDownload.deleteMany({ where: { episodeId } }),
    );
}

async function hasValidCachedFileSize(
    episodeId: string,
    cachedPath: string,
    actualBytes: number,
    metadata: AuthorizedCacheMetadata,
): Promise<boolean> {
    const canonicalBytes = metadata.episode.fileSize || 0;
    if (
        canonicalBytes > 0 &&
        Math.abs(actualBytes - canonicalBytes) / canonicalBytes > 0.01
    ) {
        await deleteInvalidCachedFile(
            episodeId,
            cachedPath,
            `Canonical size mismatch (${actualBytes}/${canonicalBytes})`,
        );
        return false;
    }

    const recordedBytes = metadata.download.fileSizeMb * 1024 * 1024;
    if (
        recordedBytes > 0 &&
        Math.abs(actualBytes - recordedBytes) / recordedBytes > 0.01
    ) {
        await deleteInvalidCachedFile(
            episodeId,
            cachedPath,
            `Recorded size mismatch (${actualBytes}/${Math.round(recordedBytes)})`,
        );
        return false;
    }
    return true;
}

/**
 * Get download progress for an episode
 * Returns { progress: 0-100, downloading: boolean } or null if not downloading
 */
export function getDownloadProgress(
    episodeId: string,
): { progress: number; downloading: boolean } | null {
    if (!downloadingEpisodes.has(episodeId)) {
        return null;
    }

    const progress = downloadProgress.get(episodeId);
    if (!progress || progress.totalBytes === 0) {
        return { progress: 0, downloading: true };
    }

    const percent = Math.round(
        (progress.bytesDownloaded / progress.totalBytes) * 100,
    );
    return { progress: Math.min(100, percent), downloading: true };
}

/**
 * Check if a cached file exists and is valid
 * Returns null if file doesn't exist, is empty, or is still being downloaded
 */
export async function getCachedFilePath(
    episodeId: string,
): Promise<string | null> {
    const cachedPath = resolvePodcastCacheFile(episodeId, "mp3");
    if (!cachedPath) return null;

    // Don't return cache path if still downloading - file may be incomplete
    if (downloadingEpisodes.has(episodeId)) {
        podcastDownloadLogger.debug(
            `Episode ${episodeId} is still downloading, not using cache`,
        );
        return null;
    }

    try {
        const metadata = await findAuthorizedCacheMetadata(episodeId);
        if (!metadata) return null;

        await fs.access(cachedPath, fs.constants.F_OK);
        const stats = await fs.stat(cachedPath);

        if (stats.size <= 0) return null;
        if (
            !(await hasValidCachedFileSize(
                episodeId,
                cachedPath,
                stats.size,
                metadata,
            ))
        ) {
            return null;
        }

        await withPodcastDownloadPrismaRetry(
            "getCachedFilePath.podcastDownload.updateMany.lastAccessedAt",
            () =>
                prisma.podcastDownload.updateMany({
                    where: { episodeId },
                    data: { lastAccessedAt: new Date() },
                }),
        );
        podcastDownloadLogger.debug(
            `Cache valid for ${episodeId}: ${stats.size} bytes`,
        );
        return cachedPath;
    } catch {
        return null;
    }
}

async function performAutoCacheDownload(
    episodeId: string,
    audioUrl: string,
    userId: string,
): Promise<void> {
    try {
        await performDownload(episodeId, audioUrl, userId);
    } catch (error) {
        podcastDownloadLogger.error(
            `Background download failed for ${episodeId}`,
            toErrorMessage(error),
        );
    } finally {
        downloadingEpisodes.delete(episodeId);
    }
}

function enqueueAutoCacheDownload(
    episodeId: string,
    audioUrl: string,
    userId: string,
): boolean {
    downloadingEpisodes.add(episodeId);
    const task = autoCacheDownloadLimit(() =>
        performAutoCacheDownload(episodeId, audioUrl, userId),
    );
    admittedAutoCacheDownloads.add(task);
    void task.then(
        () => admittedAutoCacheDownloads.delete(task),
        (error: unknown) => {
            admittedAutoCacheDownloads.delete(task);
            downloadingEpisodes.delete(episodeId);
            podcastDownloadLogger.error(
                `Auto-cache queue failed for ${episodeId}`,
                toErrorMessage(error),
            );
        },
    );
    return true;
}

function rejectAutoCacheQueueOverflow(episodeId: string): false {
    podcastDownloadLogger.warn(
        "Podcast auto-cache queue at capacity; rejecting download",
        {
            episodeId,
            active: autoCacheDownloadLimit.activeCount,
            capacity: PODCAST_AUTO_CACHE_QUEUE_CAPACITY,
            queued: autoCacheDownloadLimit.pendingCount,
        },
    );
    return false;
}

/**
 * Start a bounded background auto-cache download for an episode.
 * Returns whether the work was admitted; duplicate, invalid, and overflow work
 * is rejected without starting another download.
 */
export function downloadInBackground(
    episodeId: string,
    audioUrl: string,
    userId: string,
): boolean {
    if (!resolvePodcastCacheFile(episodeId, "mp3")) {
        podcastDownloadLogger.warn("Rejected invalid podcast episode ID");
        return false;
    }
    if (downloadingEpisodes.has(episodeId)) {
        podcastDownloadLogger.debug(
            `Already downloading episode ${episodeId}, skipping`,
        );
        return false;
    }
    if (
        autoCacheDownloadLimit.pendingCount >= PODCAST_AUTO_CACHE_QUEUE_CAPACITY
    ) {
        return rejectAutoCacheQueueOverflow(episodeId);
    }
    return enqueueAutoCacheDownload(episodeId, audioUrl, userId);
}

/** Return the process-wide podcast auto-cache queue state. */
export function getAutoCacheDownloadQueueState(): {
    active: number;
    capacity: number;
    concurrency: number;
    queued: number;
} {
    return {
        active: autoCacheDownloadLimit.activeCount,
        capacity: PODCAST_AUTO_CACHE_QUEUE_CAPACITY,
        concurrency: PODCAST_AUTO_CACHE_CONCURRENCY,
        queued: autoCacheDownloadLimit.pendingCount,
    };
}

/** Wait until all podcast auto-cache downloads admitted so far have settled. */
export async function drainAutoCacheDownloadQueue(): Promise<void> {
    await Promise.allSettled([...admittedAutoCacheDownloads]);
}

interface PodcastDownloadPaths {
    cacheDir: string;
    tempPath: string;
    finalPath: string;
}

function getPodcastDownloadPaths(episodeId: string): PodcastDownloadPaths {
    const tempPath = resolvePodcastCacheFile(episodeId, "tmp");
    const finalPath = resolvePodcastCacheFile(episodeId, "mp3");
    if (!tempPath || !finalPath) throw new PodcastDownloadAuthorizationError();
    return { cacheDir: getPodcastCacheDir(), tempPath, finalPath };
}

async function authorizePodcastDownload(episodeId: string, userId: string) {
    const episode = await withPodcastDownloadPrismaRetry(
        "performDownload.podcastEpisode.findUnique.authorization",
        () =>
            prisma.podcastEpisode.findUnique({
                where: { id: episodeId },
                select: { fileSize: true, podcastId: true },
            }),
    );
    if (!episode) throw new PodcastDownloadAuthorizationError();

    const subscription = await withPodcastDownloadPrismaRetry(
        "performDownload.podcastSubscription.findUnique.authorization",
        () =>
            prisma.podcastSubscription.findUnique({
                where: {
                    userId_podcastId: { userId, podcastId: episode.podcastId },
                },
                select: { userId: true },
            }),
    );
    if (!subscription) throw new PodcastDownloadAuthorizationError();
    return episode;
}

function getDeclaredDownloadBytes(response: AxiosResponse): number {
    const rawDeclared = response.headers["content-length"];
    if (rawDeclared === undefined) return 0;
    const declared = Number(rawDeclared);
    if (!Number.isSafeInteger(declared) || declared < 0) {
        return MAX_PODCAST_DOWNLOAD_BYTES + 1;
    }
    return declared;
}

function rejectOversizedDownload(
    response: AxiosResponse,
    controller: AbortController,
): never {
    controller.abort();
    response.data.destroy();
    throw new PodcastDownloadLimitError();
}

async function determineExpectedDownloadBytes(
    episodeId: string,
    storedBytes: number | null,
    response: AxiosResponse,
    controller: AbortController,
): Promise<number> {
    const declaredBytes = getDeclaredDownloadBytes(response);
    if (declaredBytes > MAX_PODCAST_DOWNLOAD_BYTES) {
        rejectOversizedDownload(response, controller);
    }
    const expectedBytes = declaredBytes || storedBytes || 0;
    if (expectedBytes > MAX_PODCAST_DOWNLOAD_BYTES) {
        rejectOversizedDownload(response, controller);
    }
    if (declaredBytes === 0) return expectedBytes;

    try {
        if (
            !storedBytes ||
            Math.abs(storedBytes - declaredBytes) / storedBytes > 0.01
        ) {
            await withPodcastDownloadPrismaRetry(
                "performDownload.podcastEpisode.update.fileSize",
                () =>
                    prisma.podcastEpisode.update({
                        where: { id: episodeId },
                        data: { fileSize: declaredBytes },
                    }),
            );
        }
    } catch (error) {
        podcastDownloadLogger.warn(
            `Failed to persist Content-Length: ${toErrorMessage(error)}`,
        );
    }
    return expectedBytes;
}

interface DownloadStreamState {
    bytesDownloaded: number;
    idleTimer?: ReturnType<typeof setTimeout>;
    lastLogTime: number;
    settled: boolean;
}

function clearDownloadIdleTimer(state: DownloadStreamState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
}

function recordDownloadedChunk(
    state: DownloadStreamState,
    episodeId: string,
    expectedBytes: number,
    chunkLength: number,
): boolean {
    state.bytesDownloaded += chunkLength;
    if (state.bytesDownloaded > MAX_PODCAST_DOWNLOAD_BYTES) return false;
    downloadProgress.set(episodeId, {
        bytesDownloaded: state.bytesDownloaded,
        totalBytes: expectedBytes,
    });
    const now = Date.now();
    if (now - state.lastLogTime <= 30000) return true;
    const percent = expectedBytes
        ? Math.round((state.bytesDownloaded / expectedBytes) * 100)
        : 0;
    podcastDownloadLogger.debug(
        `Download progress ${episodeId}: ${percent}% (${Math.round(state.bytesDownloaded / 1024 / 1024)}MB)`,
    );
    state.lastLogTime = now;
    return true;
}

function resetDownloadIdleTimer(
    state: DownloadStreamState,
    abort: (error: Error) => void,
): void {
    clearDownloadIdleTimer(state);
    state.idleTimer = setTimeout(
        () =>
            abort(
                new Error(
                    `Download idle timeout after ${PODCAST_DOWNLOAD_IDLE_TIMEOUT_MS}ms`,
                ),
            ),
        PODCAST_DOWNLOAD_IDLE_TIMEOUT_MS,
    );
    state.idleTimer.unref?.();
}

function destroyDownloadStreams(
    response: AxiosResponse,
    writeStream: WriteStream,
): void {
    response.data.destroy();
    writeStream.destroy();
}

async function streamDownloadToFile(
    episodeId: string,
    tempPath: string,
    expectedBytes: number,
    response: AxiosResponse,
    controller: AbortController,
): Promise<void> {
    const writeStream = (await import("fs")).createWriteStream(tempPath);
    const state: DownloadStreamState = {
        bytesDownloaded: 0,
        lastLogTime: Date.now(),
        settled: false,
    };

    await new Promise<void>((resolve, reject) => {
        const settle = (error?: Error) => {
            if (state.settled) return;
            state.settled = true;
            clearDownloadIdleTimer(state);
            if (error) reject(error);
            else resolve();
        };
        const abort = (error: Error) => {
            controller.abort();
            destroyDownloadStreams(response, writeStream);
            settle(error);
        };

        resetDownloadIdleTimer(state, abort);
        response.data.on("data", (chunk: Buffer) => {
            if (state.settled) return;
            resetDownloadIdleTimer(state, abort);
            if (
                !recordDownloadedChunk(
                    state,
                    episodeId,
                    expectedBytes,
                    chunk.length,
                )
            ) {
                abort(new PodcastDownloadLimitError());
            }
        });
        response.data.on("end", () => writeStream.end(() => settle()));
        writeStream.on("error", (error) => {
            settle(error);
            response.data.destroy();
        });
        response.data.on("error", (error: Error) => {
            settle(error);
            writeStream.destroy();
        });
        response.data.on("aborted", () => {
            settle(new Error("Download aborted by server"));
            writeStream.destroy();
        });
        if (!state.settled) response.data.pipe(writeStream, { end: false });
    });
}

async function finalizePodcastDownload(
    episodeId: string,
    userId: string,
    paths: PodcastDownloadPaths,
    expectedBytes: number,
): Promise<void> {
    const stats = await fs.stat(paths.tempPath);
    if (stats.size === 0) throw new Error("Downloaded file is empty");
    if (expectedBytes > 0) {
        const variance = Math.abs(stats.size - expectedBytes) / expectedBytes;
        if (variance > 0.01) {
            throw new Error(
                `Download incomplete: got ${stats.size} bytes, expected ${expectedBytes}`,
            );
        }
    }

    await fs.rename(paths.tempPath, paths.finalPath);
    const fileSizeMb = stats.size / 1024 / 1024;
    await withPodcastDownloadPrismaRetry(
        "performDownload.podcastDownload.upsert",
        () =>
            prisma.podcastDownload.upsert({
                where: { userId_episodeId: { userId, episodeId } },
                create: {
                    userId,
                    episodeId,
                    localPath: paths.finalPath,
                    fileSizeMb,
                    downloadedAt: new Date(),
                    lastAccessedAt: new Date(),
                },
                update: {
                    localPath: paths.finalPath,
                    fileSizeMb,
                    downloadedAt: new Date(),
                    lastAccessedAt: new Date(),
                },
            }),
    );
    podcastDownloadLogger.debug(
        `Successfully cached episode ${episodeId} (${fileSizeMb.toFixed(1)}MB)`,
    );
}

async function performDownloadAttempt(
    episodeId: string,
    audioUrl: string,
    userId: string,
    paths: PodcastDownloadPaths,
): Promise<void> {
    const episode = await authorizePodcastDownload(episodeId, userId);
    if (
        episode.fileSize !== null &&
        episode.fileSize > MAX_PODCAST_DOWNLOAD_BYTES
    ) {
        throw new PodcastDownloadLimitError();
    }
    await fs.mkdir(paths.cacheDir, { recursive: true });

    downloadingEpisodes.delete(episodeId);
    try {
        if (await getCachedFilePath(episodeId)) return;
    } finally {
        downloadingEpisodes.add(episodeId);
    }
    await fs.unlink(paths.tempPath).catch(() => {});

    const controller = new AbortController();
    const response = await openSafePodcastDownloadStream(
        audioUrl,
        controller.signal,
    );
    const expectedBytes = await determineExpectedDownloadBytes(
        episodeId,
        episode.fileSize,
        response,
        controller,
    );
    podcastDownloadLogger.debug(
        `Downloading ${episodeId} (${Math.round(expectedBytes / 1024 / 1024)}MB)`,
    );
    downloadProgress.set(episodeId, {
        bytesDownloaded: 0,
        totalBytes: expectedBytes,
    });
    await streamDownloadToFile(
        episodeId,
        paths.tempPath,
        expectedBytes,
        response,
        controller,
    );
    await finalizePodcastDownload(episodeId, userId, paths, expectedBytes);
}

function isNonRetryableDownloadError(error: unknown): boolean {
    return (
        error instanceof PodcastDownloadBlockedError ||
        error instanceof PodcastDownloadLimitError ||
        error instanceof PodcastDownloadAuthorizationError
    );
}

/** Performs one bounded series of download attempts. */
async function performDownload(
    episodeId: string,
    audioUrl: string,
    userId: string,
): Promise<void> {
    const maxAttempts = 3;
    const paths = getPodcastDownloadPaths(episodeId);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        podcastDownloadLogger.debug(
            `Starting download for ${episodeId} (attempt ${attempt}/${maxAttempts})`,
        );
        try {
            await performDownloadAttempt(episodeId, audioUrl, userId, paths);
            downloadProgress.delete(episodeId);
            return;
        } catch (error) {
            await fs.unlink(paths.tempPath).catch(() => {});
            downloadProgress.delete(episodeId);
            if (isNonRetryableDownloadError(error) || attempt === maxAttempts) {
                throw error;
            }
            podcastDownloadLogger.debug(
                `Download failed (attempt ${attempt}), retrying in 5s: ${toErrorMessage(error)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

interface ExpiredPodcastDownload {
    id: string;
    localPath: string;
    fileSizeMb: number;
}

async function deleteExpiredPodcastDownload(
    download: ExpiredPodcastDownload,
): Promise<number | null> {
    try {
        const safeLocalPath = resolveStoredPodcastCacheFile(download.localPath);
        if (safeLocalPath) {
            await fs.unlink(safeLocalPath).catch(() => {});
        } else {
            podcastDownloadLogger.warn(
                "Skipped unsafe podcast cache cleanup path",
            );
        }
        await withPodcastDownloadPrismaRetry(
            "cleanupExpiredCache.podcastDownload.delete",
            () =>
                prisma.podcastDownload.delete({
                    where: { id: download.id },
                }),
        );
        podcastDownloadLogger.debug(
            `Deleted expired cache record: ${path.basename(download.localPath)}`,
        );
        return safeLocalPath ? download.fileSizeMb : 0;
    } catch (error) {
        podcastDownloadLogger.error(
            `Failed to delete ${download.localPath}`,
            toErrorMessage(error),
        );
        return null;
    }
}

/**
 * Clean up cached episodes older than 30 days
 * Should be called periodically (e.g., daily)
 */
export async function cleanupExpiredCache(): Promise<{
    deleted: number;
    freedMb: number;
}> {
    podcastDownloadLogger.debug("Starting cache cleanup");

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Find expired downloads
    const expiredDownloads = await withPodcastDownloadPrismaRetry(
        "cleanupExpiredCache.podcastDownload.findMany",
        () =>
            prisma.podcastDownload.findMany({
                where: {
                    lastAccessedAt: { lt: thirtyDaysAgo },
                },
            }),
    );

    let deleted = 0;
    let freedMb = 0;

    for (const download of expiredDownloads) {
        const freedForDownload = await deleteExpiredPodcastDownload(download);
        if (freedForDownload === null) continue;
        deleted++;
        freedMb += freedForDownload;
    }

    podcastDownloadLogger.debug(
        `Cleanup complete: ${deleted} records deleted, ${freedMb.toFixed(1)}MB freed`,
    );

    return { deleted, freedMb };
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
    totalFiles: number;
    totalSizeMb: number;
    oldestFile: Date | null;
}> {
    const downloads = await withPodcastDownloadPrismaRetry(
        "getCacheStats.podcastDownload.findMany",
        () =>
            prisma.podcastDownload.findMany({
                select: {
                    fileSizeMb: true,
                    downloadedAt: true,
                },
                orderBy: { downloadedAt: "asc" },
            }),
    );

    return {
        totalFiles: downloads.length,
        totalSizeMb: downloads.reduce((sum, d) => sum + d.fileSizeMb, 0),
        oldestFile: downloads.length > 0 ? downloads[0].downloadedAt : null,
    };
}

/**
 * Check if an episode is currently being downloaded
 */
export function isDownloading(episodeId: string): boolean {
    return downloadingEpisodes.has(episodeId);
}
import { toErrorMessage } from "../utils/errors";
