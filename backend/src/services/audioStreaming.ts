import * as fs from "fs";
import { promises as fsPromises } from "fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { Request, Response } from "express";
import { logger } from "../utils/logger";
import * as path from "path";
import * as crypto from "crypto";
import { prisma } from "../utils/db";
import ffmpeg from "fluent-ffmpeg";
import PQueue from "p-queue";
import { AppError, ErrorCode, ErrorCategory } from "../utils/errors";
import { parseRangeHeader } from "../utils/rangeParser";
import { parseFile } from "music-metadata";
import { isOriginAllowed } from "../utils/cors";
import { config } from "../config";
import { coalesceInFlightByKey } from "../utils/singleflight";
import {
    inspectFfmpegVersion,
    resolveFfmpegBinaryPath,
} from "../utils/configValidator";

const ffmpegBinaryPath = resolveFfmpegBinaryPath(
    config.streaming.ffmpegPathOverride,
);
inspectFfmpegVersion(ffmpegBinaryPath);
ffmpeg.setFfmpegPath(ffmpegBinaryPath);

const transcodeQueue = new PQueue({ concurrency: config.transcodeConcurrency });
const inflightTranscodes = new Map<string, Promise<string>>();
const inflightFederatedStreams = new Map<
    string,
    Promise<StreamFileInfo | FederatedStreamSource>
>();
const BYTES_PER_GIBIBYTE = 1024 * 1024 * 1024;
const OFFSET_TEMP_DIRECTORY = "offset-tmp";
const OFFSET_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const OFFSET_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const OFFSET_SWEEP_FILE_LIMIT = 1000;
const activeOffsetFiles = new Set<string>();
let lastOffsetSweepAt = 0;
let offsetSweepInFlight = false;
let offsetSweepPromise: Promise<void> | null = null;

async function removeOffsetFile(filePath: string): Promise<void> {
    try {
        await fsPromises.unlink(filePath);
    } catch {
        // Temporary-file cleanup is best effort.
    }
}

async function releaseActiveOffsetFile(filePath: string): Promise<void> {
    await removeOffsetFile(filePath);
    activeOffsetFiles.delete(filePath);
}

async function sweepStaleOffsetFiles(
    offsetTempPath: string,
    nowMs: number,
): Promise<void> {
    try {
        const entries = await fsPromises.readdir(offsetTempPath, {
            withFileTypes: true,
        });
        const cutoff = nowMs - OFFSET_TEMP_MAX_AGE_MS;
        const boundedEntries = entries.slice(0, OFFSET_SWEEP_FILE_LIMIT);
        for (const entry of boundedEntries) {
            if (!entry.isFile()) continue;
            const filePath = path.join(offsetTempPath, entry.name);
            if (activeOffsetFiles.has(filePath)) continue;
            try {
                const stats = await fsPromises.stat(filePath);
                if (stats.mtimeMs < cutoff) await fsPromises.unlink(filePath);
            } catch {
                // Cleanup tolerates concurrent removal and permission failures.
            }
        }
    } catch (issue) {
        logger.warn("Offset transcode cleanup failed:", issue);
    }
}

function startOffsetSweep(offsetTempPath: string): void {
    const nowMs = Date.now();
    const sweepIsRecent =
        lastOffsetSweepAt !== 0 &&
        nowMs - lastOffsetSweepAt <= OFFSET_SWEEP_INTERVAL_MS;
    if (offsetSweepInFlight || sweepIsRecent) return;

    lastOffsetSweepAt = nowMs;
    offsetSweepInFlight = true;
    const sweep = sweepStaleOffsetFiles(offsetTempPath, nowMs).finally(() => {
        offsetSweepInFlight = false;
        if (offsetSweepPromise === sweep) offsetSweepPromise = null;
    });
    offsetSweepPromise = sweep;
}

/** Resets process-wide offset sweep bookkeeping for deterministic tests. */
export function resetOffsetSweepStateForTests(): void {
    lastOffsetSweepAt = 0;
    offsetSweepInFlight = false;
    offsetSweepPromise = null;
    activeOffsetFiles.clear();
}

/** Waits for the current process-wide offset sweep during deterministic tests. */
export function waitForOffsetSweepForTests(): Promise<void> {
    return offsetSweepPromise ?? Promise.resolve();
}

// Quality settings
export const QUALITY_SETTINGS = {
    original: { bitrate: null, format: null }, // No transcoding
    high: { bitrate: 320, format: "mp3" },
    medium: { bitrate: 192, format: "mp3" },
    low: { bitrate: 128, format: "mp3" },
} as const;

export type Quality = keyof typeof QUALITY_SETTINGS;

interface StreamFileInfo {
    filePath: string;
    mimeType: string;
    cleanup?: () => Promise<void>;
}

type FfmpegExecution = {
    command: ReturnType<typeof ffmpeg>;
    cachePath: string;
    trackId: string;
    quality: Quality;
    sourcePath: string;
    signal?: AbortSignal;
};

type OffsetTranscodeInput = {
    trackId: string;
    quality: Quality;
    sourcePath: string;
    temporaryPath: string;
    bitrate: number;
    format: string;
    timeOffsetSeconds: number;
    signal?: AbortSignal;
};

/** Complete peer response metadata needed to decide cache fill or passthrough. */
export interface FederatedStreamSource {
    stream: Readable;
    mimeType: string;
    status: number;
    contentLength: number | null;
    headers?: Record<string, unknown>;
}

/** Signals that an unknown-length federated cache fill crossed its byte ceiling. */
export class FederatedCacheCapacityError extends Error {
    constructor() {
        super("Federated cache fill exceeded remaining capacity");
        this.name = "FederatedCacheCapacityError";
    }
}

function createByteLimitGuard(maxBytes: number): Transform {
    let writtenBytes = 0;
    return new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            writtenBytes += chunk.byteLength;
            if (writtenBytes > maxBytes) {
                callback(new FederatedCacheCapacityError());
                return;
            }
            callback(null, chunk);
        },
    });
}

/**
 * Represents the AudioStreamingService class.
 */
export class AudioStreamingService {
    private musicPath: string;
    private transcodeCachePath: string;
    private offsetTempPath: string;
    private transcodeCacheMaxGb: number;
    private evictionInterval: NodeJS.Timeout | null = null;

    constructor(
        musicPath: string,
        transcodeCachePath: string,
        transcodeCacheMaxGb: number,
    ) {
        this.musicPath = musicPath;
        this.transcodeCachePath = transcodeCachePath;
        this.offsetTempPath = path.join(
            this.transcodeCachePath,
            OFFSET_TEMP_DIRECTORY,
        );
        this.transcodeCacheMaxGb = transcodeCacheMaxGb;

        // Ensure cache directory exists
        if (!fs.existsSync(this.transcodeCachePath)) {
            fs.mkdirSync(this.transcodeCachePath, { recursive: true });
        }
        fs.mkdirSync(this.offsetTempPath, { recursive: true });
        startOffsetSweep(this.offsetTempPath);

        // Start cache eviction timer (every 6 hours)
        this.evictionInterval = setInterval(
            () => {
                this.evictCache(this.transcodeCacheMaxGb).catch((err) => {
                    logger.error("Cache eviction failed:", err);
                });
            },
            6 * 60 * 60 * 1000,
        );
    }

    /**
     * Get file path for streaming (either original or transcoded)
     */
    async getStreamFilePath(
        trackId: string,
        quality: Quality,
        sourceModified: Date,
        sourceAbsolutePath: string,
        timeOffsetSeconds = 0,
        signal?: AbortSignal,
    ): Promise<StreamFileInfo> {
        logger.debug(
            `[AudioStreaming] Request: trackId=${trackId}, quality=${quality}, source=${path.basename(sourceAbsolutePath)}`,
        );

        if (quality === "original") {
            return this.originalStreamFile(sourceAbsolutePath);
        }
        if (timeOffsetSeconds > 0) {
            return this.transcodeWithoutCache(
                trackId,
                quality,
                sourceAbsolutePath,
                timeOffsetSeconds,
                signal,
            );
        }

        const cachedPath = await this.getCachedTranscode(
            trackId,
            quality,
            sourceModified,
        );

        if (cachedPath) {
            logger.debug(
                `[STREAM] Using cached transcode: ${quality} (${cachedPath})`,
            );
            return {
                filePath: cachedPath,
                mimeType: "audio/mpeg",
            };
        }

        if (await this.shouldServeOriginal(sourceAbsolutePath, quality)) {
            return this.originalStreamFile(sourceAbsolutePath);
        }

        await this.ensureTranscodeCacheCapacity();
        logger.debug(
            `[STREAM] Transcoding to ${quality} quality: ${sourceAbsolutePath}`,
        );
        const transcodedPath = await this.transcodeToCache(
            trackId,
            quality,
            sourceAbsolutePath,
            sourceModified,
        );

        return {
            filePath: transcodedPath,
            mimeType: "audio/mpeg",
        };
    }

    private originalStreamFile(sourcePath: string): StreamFileInfo {
        const mimeType = this.getMimeType(sourcePath);
        logger.debug(`[AudioStreaming] Serving original: mimeType=${mimeType}`);
        return { filePath: sourcePath, mimeType };
    }

    private async shouldServeOriginal(
        sourcePath: string,
        quality: Quality,
    ): Promise<boolean> {
        const targetBitrate = QUALITY_SETTINGS[quality].bitrate;
        if (!targetBitrate) return false;
        try {
            const metadata = await parseFile(sourcePath);
            const sourceBitrate = metadata.format.bitrate
                ? Math.round(metadata.format.bitrate / 1000)
                : null;
            if (!sourceBitrate || sourceBitrate > targetBitrate) return false;
            logger.debug(
                `[STREAM] Source bitrate (${sourceBitrate}kbps) <= target (${targetBitrate}kbps), serving original`,
            );
            return true;
        } catch (error) {
            logger.warn(
                "[STREAM] Failed to read source metadata, will transcode anyway:",
                error,
            );
            return false;
        }
    }

    private async ensureTranscodeCacheCapacity(): Promise<void> {
        const currentSize = await this.getCacheSize();
        if (currentSize <= this.transcodeCacheMaxGb * 0.9) return;
        logger.debug(
            `[STREAM] Cache near full (${currentSize.toFixed(2)}GB), evicting to 80%...`,
        );
        await this.evictCache(this.transcodeCacheMaxGb * 0.8);
    }

    private async transcodeWithoutCache(
        trackId: string,
        quality: Quality,
        sourcePath: string,
        timeOffsetSeconds: number,
        signal?: AbortSignal,
    ): Promise<StreamFileInfo> {
        const settings = QUALITY_SETTINGS[quality];
        if (!settings.bitrate || !settings.format) {
            throw this.invalidQualityError(quality);
        }
        const temporaryPath = path.join(
            this.offsetTempPath,
            `soundspan-offset-${crypto.randomUUID()}.${settings.format}`,
        );
        activeOffsetFiles.add(temporaryPath);
        try {
            await this.enqueueOffsetTranscode({
                trackId,
                quality,
                sourcePath,
                temporaryPath,
                bitrate: settings.bitrate,
                format: settings.format,
                timeOffsetSeconds,
                signal,
            });
        } catch (issue) {
            await releaseActiveOffsetFile(temporaryPath);
            throw issue;
        }
        return {
            filePath: temporaryPath,
            mimeType: "audio/mpeg",
            cleanup: () => releaseActiveOffsetFile(temporaryPath),
        };
    }

    private async enqueueOffsetTranscode(
        input: OffsetTranscodeInput,
    ): Promise<void> {
        await transcodeQueue.add(
            () =>
                this.runFfmpeg(
                    input.sourcePath,
                    input.temporaryPath,
                    input.bitrate,
                    input.format,
                    input.trackId,
                    input.quality,
                    input.timeOffsetSeconds,
                    input.signal,
                ),
            input.signal ? { signal: input.signal } : undefined,
        );
    }

    /** Returns a complete peer stream cache hit without source staleness checks. */
    async getCachedFederatedStreamFilePath(
        trackId: string,
        quality: Quality,
        mimeType: string,
    ): Promise<StreamFileInfo | null> {
        const cached = await prisma.transcodedFile.findFirst({
            where: { trackId, quality },
        });
        if (!cached) return null;
        const fullPath = path.join(this.transcodeCachePath, cached.cachePath);
        if (!fs.existsSync(fullPath)) {
            await prisma.transcodedFile.delete({ where: { id: cached.id } });
            return null;
        }
        await prisma.transcodedFile.update({
            where: { id: cached.id },
            data: { lastAccessed: new Date() },
        });
        return { filePath: fullPath, mimeType };
    }

    /** Caches one complete status-200 peer stream or returns it for passthrough. */
    async cacheFederatedStream(
        trackId: string,
        quality: Quality,
        sourceModified: Date,
        fallbackMimeType: string,
        loadStream: () => Promise<FederatedStreamSource>,
    ): Promise<StreamFileInfo | FederatedStreamSource> {
        const cached = await this.getCachedFederatedStreamFilePath(
            trackId,
            quality,
            fallbackMimeType,
        );
        if (cached) return cached;
        const key = `${trackId}-${quality}`;
        const existingFill = inflightFederatedStreams.get(key);
        if (existingFill) {
            logger.debug(
                `[STREAM] Joining in-flight federated cache fill for ${key}`,
            );
            return existingFill.then(async (result) => {
                if (!("stream" in result)) return result;
                return loadStream();
            });
        }
        return coalesceInFlightByKey(
            inflightFederatedStreams,
            key,
            () =>
                this.doCacheFederatedStream(
                    trackId,
                    quality,
                    sourceModified,
                    loadStream,
                ),
            {
                onCoalescedWait: () =>
                    logger.debug(
                        `[STREAM] Joining in-flight federated cache fill for ${key}`,
                    ),
            },
        );
    }

    private async doCacheFederatedStream(
        trackId: string,
        quality: Quality,
        sourceModified: Date,
        loadStream: () => Promise<FederatedStreamSource>,
    ): Promise<StreamFileInfo | FederatedStreamSource> {
        const remainingBytes = await this.ensureFederatedCacheCapacity();
        const cacheFileName = this.federatedCacheFileName(trackId, quality);
        const cachePath = path.join(this.transcodeCachePath, cacheFileName);
        const tempPath = `${cachePath}.tmp-${crypto.randomUUID()}`;
        const source = await loadStream();
        if (source.status !== 200) return source;
        if (
            source.contentLength !== null &&
            source.contentLength > remainingBytes
        ) {
            return source;
        }
        try {
            await pipeline(
                source.stream,
                createByteLimitGuard(remainingBytes),
                fs.createWriteStream(tempPath),
            );
            await fs.promises.rename(tempPath, cachePath);
            await this.persistTranscode(
                trackId,
                quality,
                cacheFileName,
                cachePath,
                sourceModified,
            );
            return { filePath: cachePath, mimeType: source.mimeType };
        } catch (error) {
            await fs.promises.unlink(tempPath).catch(() => undefined);
            await fs.promises.unlink(cachePath).catch(() => undefined);
            throw error;
        }
    }

    private async ensureFederatedCacheCapacity(): Promise<number> {
        let currentSizeGb = await this.getCacheSize();
        if (currentSizeGb > this.transcodeCacheMaxGb * 0.9) {
            await this.evictCache(this.transcodeCacheMaxGb * 0.8);
            currentSizeGb = await this.getCacheSize();
        }
        const maxBytes = Math.floor(
            this.transcodeCacheMaxGb * BYTES_PER_GIBIBYTE,
        );
        const currentBytes = Math.ceil(currentSizeGb * BYTES_PER_GIBIBYTE);
        return Math.max(0, maxBytes - currentBytes);
    }

    private federatedCacheFileName(trackId: string, quality: Quality): string {
        const hash = crypto
            .createHash("md5")
            .update(`federated-${trackId}-${quality}`)
            .digest("hex");
        return `${hash}.audio`;
    }

    /**
     * Get cached transcode if it exists and is valid
     */
    private async getCachedTranscode(
        trackId: string,
        quality: Quality,
        sourceModified: Date,
    ): Promise<string | null> {
        const cached = await prisma.transcodedFile.findFirst({
            where: {
                trackId,
                quality,
            },
        });

        if (!cached) return null;

        // Invalidate if source file was modified after transcode was created
        if (cached.sourceModified < sourceModified) {
            logger.debug(
                `[STREAM] Cache stale for track ${trackId}, removing...`,
            );
            await prisma.transcodedFile.delete({ where: { id: cached.id } });

            // Delete file from disk
            const cachePath = path.join(
                this.transcodeCachePath,
                cached.cachePath,
            );
            await fs.promises.unlink(cachePath).catch(() => {});

            return null;
        }

        // Update last accessed time
        await prisma.transcodedFile.update({
            where: { id: cached.id },
            data: { lastAccessed: new Date() },
        });

        const fullPath = path.join(this.transcodeCachePath, cached.cachePath);

        // Verify file exists
        if (!fs.existsSync(fullPath)) {
            logger.debug(`[STREAM] Cache file missing: ${fullPath}`);
            await prisma.transcodedFile.delete({ where: { id: cached.id } });
            return null;
        }

        return fullPath;
    }

    /**
     * Transcode audio file to cache, deduplicating concurrent requests for the same track+quality.
     */
    private transcodeToCache(
        trackId: string,
        quality: Quality,
        sourcePath: string,
        sourceModified: Date,
    ): Promise<string> {
        const dedupeKey = `${trackId}-${quality}`;
        return coalesceInFlightByKey(
            inflightTranscodes,
            dedupeKey,
            () =>
                transcodeQueue.add(() =>
                    this.doTranscode(
                        trackId,
                        quality,
                        sourcePath,
                        sourceModified,
                    ),
                ),
            {
                onCoalescedWait: () =>
                    logger.debug(
                        `[STREAM] Joining in-flight transcode for ${dedupeKey}`,
                    ),
            },
        );
    }

    /**
     * Run the actual ffmpeg transcode and persist the cache record.
     */
    private async doTranscode(
        trackId: string,
        quality: Quality,
        sourcePath: string,
        sourceModified: Date,
    ): Promise<string> {
        const settings = QUALITY_SETTINGS[quality];
        if (!settings.bitrate || !settings.format) {
            throw this.invalidQualityError(quality);
        }

        const hash = crypto
            .createHash("md5")
            .update(`${trackId}-${quality}`)
            .digest("hex");
        const cacheFileName = `${hash}.${settings.format}`;
        const cachePath = path.join(this.transcodeCachePath, cacheFileName);

        await this.runFfmpeg(
            sourcePath,
            cachePath,
            settings.bitrate,
            settings.format,
            trackId,
            quality,
        );
        await this.persistTranscode(
            trackId,
            quality,
            cacheFileName,
            cachePath,
            sourceModified,
        );
        return cachePath;
    }

    private runFfmpeg(
        sourcePath: string,
        cachePath: string,
        bitrate: number,
        format: string,
        trackId: string,
        quality: Quality,
        timeOffsetSeconds = 0,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(
                this.cancelledTranscodeIssue(trackId, quality, sourcePath),
            );
        }
        try {
            const command = this.createFfmpegCommand(
                sourcePath,
                bitrate,
                format,
                timeOffsetSeconds,
            );
            return new Promise((resolve, reject) => {
                this.observeFfmpeg(
                    {
                        command,
                        cachePath,
                        trackId,
                        quality,
                        sourcePath,
                        signal,
                    },
                    resolve,
                    reject,
                );
            });
        } catch {
            return Promise.reject(
                this.ffmpegUnavailableError(trackId, quality),
            );
        }
    }

    private observeFfmpeg(
        input: FfmpegExecution,
        resolve: () => void,
        reject: (reason?: unknown) => void,
    ): void {
        let settled = false;
        let deadline: NodeJS.Timeout | undefined;
        const finish = (): void => {
            if (deadline !== undefined) clearTimeout(deadline);
            input.signal?.removeEventListener("abort", abort);
        };
        const fail = (issue: AppError): void => {
            if (settled) return;
            settled = true;
            finish();
            reject(issue);
        };
        const terminate = (issue: AppError): void => {
            if (settled) return;
            settled = true;
            finish();
            this.terminateTranscode(
                input.command,
                input.cachePath,
                issue,
                reject,
            );
        };
        const abort = (): void =>
            terminate(
                this.cancelledTranscodeIssue(
                    input.trackId,
                    input.quality,
                    input.sourcePath,
                ),
            );
        const complete = (): void => {
            if (settled) return;
            settled = true;
            finish();
            resolve();
        };
        this.attachFfmpegHandlers(input, fail, complete);
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) {
            abort();
            return;
        }
        deadline = this.startFfmpegDeadline(input, terminate);
        try {
            input.command.save(input.cachePath);
        } catch {
            fail(this.ffmpegUnavailableError(input.trackId, input.quality));
        }
    }

    private startFfmpegDeadline(
        input: FfmpegExecution,
        terminate: (issue: AppError) => void,
    ): NodeJS.Timeout {
        return setTimeout(
            () =>
                terminate(
                    this.timedOutTranscodeIssue(
                        input.trackId,
                        input.quality,
                        input.sourcePath,
                    ),
                ),
            config.transcodeTimeoutMs,
        );
    }

    private attachFfmpegHandlers(
        input: FfmpegExecution,
        fail: (issue: AppError) => void,
        complete: () => void,
    ): void {
        input.command.on("error", (issue) => {
            fail(
                this.toFfmpegError(
                    issue,
                    input.trackId,
                    input.quality,
                    input.sourcePath,
                ),
            );
        });
        input.command.on("end", complete);
    }

    private cancelledTranscodeIssue(
        trackId: string,
        quality: Quality,
        sourcePath: string,
    ): AppError {
        return new AppError(
            ErrorCode.TRANSCODE_FAILED,
            ErrorCategory.RECOVERABLE,
            "Transcoding cancelled because the client disconnected",
            { trackId, quality, source: sourcePath },
        );
    }

    private timedOutTranscodeIssue(
        trackId: string,
        quality: Quality,
        sourcePath: string,
    ): AppError {
        return new AppError(
            ErrorCode.TRANSCODE_FAILED,
            ErrorCategory.RECOVERABLE,
            `Transcoding timed out after ${config.transcodeTimeoutMs}ms`,
            { trackId, quality, source: sourcePath },
        );
    }

    private ffmpegUnavailableError(
        trackId: string,
        quality: Quality,
    ): AppError {
        return new AppError(
            ErrorCode.FFMPEG_NOT_FOUND,
            ErrorCategory.FATAL,
            "FFmpeg not available. Please install FFmpeg to enable transcoding.",
            { trackId, quality },
        );
    }

    private createFfmpegCommand(
        sourcePath: string,
        bitrate: number,
        format: string,
        timeOffsetSeconds: number,
    ): ReturnType<typeof ffmpeg> {
        const command = ffmpeg(sourcePath);
        if (timeOffsetSeconds > 0) {
            command.inputOptions("-ss", String(timeOffsetSeconds));
        }
        return command
            .audioBitrate(bitrate)
            .audioCodec("libmp3lame")
            .format(format);
    }

    private invalidQualityError(quality: Quality): AppError {
        return new AppError(
            ErrorCode.INVALID_CONFIG,
            ErrorCategory.FATAL,
            `Invalid quality setting: ${quality}`,
        );
    }

    private terminateTranscode(
        command: { kill(signal: string): unknown },
        cachePath: string,
        issue: AppError,
        reject: (reason?: unknown) => void,
    ): void {
        try {
            command.kill("SIGKILL");
        } catch {
            // Continue cleanup when the process already exited.
        }
        fs.unlink(cachePath, () => {
            reject(issue);
        });
    }

    private toFfmpegError(
        error: Error,
        trackId: string,
        quality: Quality,
        sourcePath: string,
    ): AppError {
        const errorMessage = error.message.toLowerCase();
        if (
            errorMessage.includes("ffmpeg") &&
            errorMessage.includes("not found")
        ) {
            return new AppError(
                ErrorCode.FFMPEG_NOT_FOUND,
                ErrorCategory.FATAL,
                "FFmpeg not installed. Please install FFmpeg to enable transcoding.",
                { trackId, quality },
            );
        }
        return new AppError(
            ErrorCode.TRANSCODE_FAILED,
            ErrorCategory.RECOVERABLE,
            `Transcoding failed: ${error.message}`,
            { trackId, quality, source: sourcePath },
        );
    }

    private async persistTranscode(
        trackId: string,
        quality: Quality,
        cacheFileName: string,
        cachePath: string,
        sourceModified: Date,
    ): Promise<void> {
        try {
            const stats = await fs.promises.stat(cachePath);
            await prisma.transcodedFile.upsert({
                where: { trackId_quality: { trackId, quality } },
                create: {
                    trackId,
                    quality,
                    cachePath: cacheFileName,
                    cacheSize: stats.size,
                    sourceModified,
                    lastAccessed: new Date(),
                },
                update: {
                    cacheSize: stats.size,
                    sourceModified,
                    lastAccessed: new Date(),
                },
            });
            logger.debug(
                `[STREAM] Transcode complete: ${cacheFileName} (${(
                    stats.size /
                    1024 /
                    1024
                ).toFixed(2)}MB)`,
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Unknown error";
            throw new AppError(
                ErrorCode.DB_QUERY_ERROR,
                ErrorCategory.RECOVERABLE,
                `Failed to save transcode record: ${message}`,
                { trackId, quality },
            );
        }
    }

    /**
     * Get total cache size in GB
     */
    async getCacheSize(): Promise<number> {
        const cached = await prisma.transcodedFile.findMany({
            select: { cacheSize: true },
        });
        const totalBytes = cached.reduce((sum, f) => sum + f.cacheSize, 0);
        return totalBytes / (1024 * 1024 * 1024);
    }

    /**
     * Evict cache using LRU until size is below target
     */
    async evictCache(targetGb: number): Promise<void> {
        logger.debug(`[CACHE] Starting eviction, target: ${targetGb}GB`);

        let currentSize = await this.getCacheSize();
        logger.debug(`[CACHE] Current size: ${currentSize.toFixed(2)}GB`);

        if (currentSize <= targetGb) {
            logger.debug("[CACHE] Below target, no eviction needed");
            return;
        }

        // Get all cached files sorted by last accessed (oldest first)
        const cached = await prisma.transcodedFile.findMany({
            orderBy: { lastAccessed: "asc" },
        });

        let evicted = 0;
        for (const file of cached) {
            if (currentSize <= targetGb) break;

            // Delete file from disk
            const fullPath = path.join(this.transcodeCachePath, file.cachePath);
            try {
                await fs.promises.unlink(fullPath);
            } catch (err) {
                logger.warn(`[CACHE] Failed to delete ${fullPath}:`, err);
            }

            // Delete from database
            await prisma.transcodedFile.delete({ where: { id: file.id } });

            currentSize -= file.cacheSize / (1024 * 1024 * 1024);
            evicted++;
        }

        logger.debug(
            `[CACHE] Evicted ${evicted} files, new size: ${currentSize.toFixed(
                2,
            )}GB`,
        );
    }

    /**
     * Get MIME type from file extension
     */
    getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".m4a": "audio/mp4",
            ".aac": "audio/aac",
            ".ogg": "audio/ogg",
            ".opus": "audio/opus",
            ".wav": "audio/wav",
            ".wma": "audio/x-ms-wma",
            ".ape": "audio/x-ape",
            ".wv": "audio/x-wavpack",
        };
        return mimeTypes[ext] || "audio/mpeg";
    }

    /**
     * Stream a file with Range support and an optional response pacing transform.
     * Manually handles Range requests to ensure compatibility with Firefox's strict
     * Content-Range header validation for large FLAC files.
     */
    async streamFileWithRangeSupport(
        req: Request,
        res: Response,
        filePath: string,
        mimeType: string,
        pacing?: Transform,
    ): Promise<void> {
        try {
            // Get file stats for size
            const stats = await fsPromises.stat(filePath);
            const fileSize = stats.size;

            // Parse Range header
            const range = req.headers.range;
            let start = 0;
            let end = fileSize - 1;

            if (range) {
                const parsed = parseRangeHeader(range, fileSize);
                if (!parsed.ok) {
                    res.status(416).set({
                        "Content-Range": `bytes */${fileSize}`,
                    });
                    res.end();
                    return;
                }
                start = parsed.start;
                end = parsed.end;
            }

            const contentLength = end - start + 1;

            // Set response headers
            const headers: Record<string, string> = {
                "Content-Type": mimeType,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000",
                "Content-Length": contentLength.toString(),
            };

            // Reflect the request Origin with credentials only when it passes
            // the same ALLOWED_ORIGINS allowlist the Express app enforces
            // (utils/cors.ts). Production denies cross-origin requests when
            // the allowlist is empty unless CORS_ALLOW_ALL is enabled;
            // development allows all origins. Same-origin requests carry no
            // Origin header and need no CORS headers.
            const origin = req.headers.origin;
            if (
                origin &&
                isOriginAllowed(origin, config.allowedOrigins, config.nodeEnv)
            ) {
                headers["Access-Control-Allow-Origin"] = origin;
                headers["Access-Control-Allow-Credentials"] = "true";
            }

            // Set status and range-specific headers
            if (range) {
                res.status(206);
                headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
            } else {
                res.status(200);
            }

            res.set(headers);

            // Create read stream with range
            const stream = fs.createReadStream(filePath, { start, end });

            // pipeline() propagates errors from either side and destroys both
            // streams on completion or failure — replacing the manual
            // stream.on("error") handler and res.on("close") teardown that raw
            // pipe() required (and which leaked backpressure/abort handling).
            try {
                if (pacing) await pipeline(stream, pacing, res);
                else await pipeline(stream, res);
            } catch (err) {
                // A client closing the connection mid-stream (seek, skip,
                // navigate away) surfaces as ERR_STREAM_PREMATURE_CLOSE; that's
                // expected for media streaming, not a server error.
                const code = (err as NodeJS.ErrnoException | undefined)?.code;
                if (code !== "ERR_STREAM_PREMATURE_CLOSE") {
                    logger.error(
                        `[AudioStreaming] Stream error for ${filePath}:`,
                        err,
                    );
                    if (!res.headersSent) {
                        res.status(500).end();
                    }
                }
            }
        } catch (err) {
            logger.error(`[AudioStreaming] Failed to stream ${filePath}:`, err);
            if (!res.headersSent) {
                res.status(500).end();
            }
        }
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        if (this.evictionInterval) {
            clearInterval(this.evictionInterval);
            this.evictionInterval = null;
        }
    }
}
