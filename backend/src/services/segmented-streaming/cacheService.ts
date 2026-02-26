import { promises as fsPromises } from "fs";
import path from "path";
import { config } from "../../config";
import { logger } from "../../utils/logger";
import {
    buildCachePath,
    buildSha256CacheKey,
} from "../cacheHelpers";

const MANIFEST_FILE_NAME = "manifest.mpd";
const DASH_SEGMENT_FILE_REGEX = /\.(m4s|webm)$/i;
const SEGMENTED_CACHE_BASE_PATH_ENV = "SEGMENTED_STREAMING_CACHE_PATH";
const SEGMENTED_CACHE_MAX_GB_ENV = "SEGMENTED_STREAMING_CACHE_MAX_GB";
const SEGMENTED_CACHE_PRUNE_INTERVAL_MS_ENV =
    "SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS";
const SEGMENTED_CACHE_MIN_AGE_MS_ENV =
    "SEGMENTED_STREAMING_CACHE_MIN_AGE_MS";
const SEGMENTED_CACHE_PRUNE_TARGET_RATIO_ENV =
    "SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO";
const SEGMENTED_CACHE_SCHEMA_VERSION_ENV =
    "SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION";
const BYTES_PER_GB = 1024 * 1024 * 1024;
const DEFAULT_SEGMENTED_CACHE_MAX_GB = 10;
const DEFAULT_SEGMENTED_CACHE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_SEGMENTED_CACHE_MIN_AGE_MS = 10 * 60 * 1000;
const DEFAULT_SEGMENTED_CACHE_PRUNE_TARGET_RATIO = 0.8;
const DEFAULT_SEGMENTED_CACHE_SCHEMA_VERSION = "dash-v2";

export type SegmentedDashQuality = "original" | "high" | "medium" | "low";

export interface LocalDashCacheKeyInput {
    trackId: string;
    sourcePath: string;
    sourceModifiedIso: string;
    quality: SegmentedDashQuality;
    cacheIdentity?: string;
}

export interface LocalDashAssetPaths {
    cacheKey: string;
    outputDir: string;
    manifestPath: string;
}

interface DashCacheDirectoryStat {
    cacheKey: string;
    outputDir: string;
    sizeBytes: number;
    modifiedAtMs: number;
}

export interface DashCachePruneResult {
    inspectedEntries: number;
    removedEntries: number;
    skippedActiveEntries: number;
    skippedRecentEntries: number;
    totalBytesBefore: number;
    totalBytesAfter: number;
    maxBytes: number;
}

class SegmentedStreamingCacheService {
    private readonly dashCacheRoot = buildCachePath(
        resolveSegmentedStreamingCacheBasePath(),
        "segmented-dash",
    );
    private readonly sessionRefs = new Map<string, Set<string>>();
    private dashPruneInFlight: Promise<DashCachePruneResult> | null = null;
    private lastDashPruneStartedAtMs = 0;

    buildDashCacheKey(input: LocalDashCacheKeyInput): string {
        const cacheIdentity = input.cacheIdentity?.trim();
        const sourceIdentity =
            cacheIdentity ||
            `${input.trackId}:${input.sourcePath}:${input.sourceModifiedIso}`;
        const schemaVersion = resolveSegmentedCacheSchemaVersion();

        return buildSha256CacheKey({
            identity: sourceIdentity,
            suffix: `${input.quality}:${schemaVersion}`,
            length: 24,
        });
    }

    getDashAssetPaths(cacheKey: string): LocalDashAssetPaths {
        const outputDir = buildCachePath(this.dashCacheRoot, cacheKey);
        return {
            cacheKey,
            outputDir,
            manifestPath: buildCachePath(outputDir, MANIFEST_FILE_NAME),
        };
    }

    async ensureDashAssetDirectory(cacheKey: string): Promise<LocalDashAssetPaths> {
        const paths = this.getDashAssetPaths(cacheKey);
        await fsPromises.mkdir(paths.outputDir, { recursive: true });
        return paths;
    }

    async removeDashAsset(cacheKey: string): Promise<void> {
        const paths = this.getDashAssetPaths(cacheKey);
        await fsPromises.rm(paths.outputDir, {
            recursive: true,
            force: true,
        });
    }

    async hasDashManifest(cacheKey: string): Promise<boolean> {
        try {
            const paths = this.getDashAssetPaths(cacheKey);
            await fsPromises.access(paths.manifestPath);
            return true;
        } catch {
            return false;
        }
    }

    async listDashSegments(cacheKey: string): Promise<string[]> {
        const paths = this.getDashAssetPaths(cacheKey);
        const entries = await fsPromises.readdir(paths.outputDir);
        return entries
            .filter((entry) => DASH_SEGMENT_FILE_REGEX.test(entry))
            .sort((a, b) => a.localeCompare(b));
    }

    registerSessionReference(cacheKey: string, sessionId: string): void {
        const refs = this.sessionRefs.get(cacheKey) ?? new Set<string>();
        refs.add(sessionId);
        this.sessionRefs.set(cacheKey, refs);
    }

    clearSessionReference(cacheKey: string, sessionId: string): void {
        const refs = this.sessionRefs.get(cacheKey);
        if (!refs) {
            return;
        }
        refs.delete(sessionId);
        if (refs.size === 0) {
            this.sessionRefs.delete(cacheKey);
        }
    }

    getSessionReferenceCount(cacheKey: string): number {
        return this.sessionRefs.get(cacheKey)?.size ?? 0;
    }

    scheduleDashCachePrune(): void {
        if (this.dashPruneInFlight) {
            return;
        }

        const intervalMs = resolveSegmentedCachePruneIntervalMs();
        const now = Date.now();
        if (now - this.lastDashPruneStartedAtMs < intervalMs) {
            return;
        }

        this.lastDashPruneStartedAtMs = now;
        this.dashPruneInFlight = this.pruneDashCacheIfNeeded()
            .catch((error) => {
                logger.warn(
                    "[SegmentedStreaming] DASH cache prune failed",
                    error,
                );
                return {
                    inspectedEntries: 0,
                    removedEntries: 0,
                    skippedActiveEntries: 0,
                    skippedRecentEntries: 0,
                    totalBytesBefore: 0,
                    totalBytesAfter: 0,
                    maxBytes: resolveSegmentedCacheMaxBytes(),
                } satisfies DashCachePruneResult;
            })
            .finally(() => {
                this.dashPruneInFlight = null;
            });
    }

    async pruneDashCacheIfNeeded(): Promise<DashCachePruneResult> {
        const maxBytes = resolveSegmentedCacheMaxBytes();
        const targetRatio = resolveSegmentedCachePruneTargetRatio();
        const minAgeMs = resolveSegmentedCacheMinAgeMs();
        const targetBytesAfterPrune = Math.floor(maxBytes * targetRatio);
        const now = Date.now();

        const entries = await this.collectDashCacheDirectoryStats();
        let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
        const totalBytesBefore = totalBytes;
        let removedEntries = 0;
        let skippedActiveEntries = 0;
        let skippedRecentEntries = 0;

        if (totalBytes <= maxBytes) {
            return {
                inspectedEntries: entries.length,
                removedEntries,
                skippedActiveEntries,
                skippedRecentEntries,
                totalBytesBefore,
                totalBytesAfter: totalBytes,
                maxBytes,
            };
        }

        const sortedByOldest = [...entries].sort(
            (left, right) => left.modifiedAtMs - right.modifiedAtMs,
        );

        for (const entry of sortedByOldest) {
            if (totalBytes <= targetBytesAfterPrune) {
                break;
            }

            if (this.getSessionReferenceCount(entry.cacheKey) > 0) {
                skippedActiveEntries += 1;
                continue;
            }

            if (now - entry.modifiedAtMs < minAgeMs) {
                skippedRecentEntries += 1;
                continue;
            }

            try {
                await fsPromises.rm(entry.outputDir, {
                    recursive: true,
                    force: true,
                });
                totalBytes = Math.max(0, totalBytes - entry.sizeBytes);
                removedEntries += 1;
            } catch (error) {
                logger.warn(
                    "[SegmentedStreaming] Failed to remove DASH cache directory",
                    {
                        cacheKey: entry.cacheKey,
                        outputDir: entry.outputDir,
                        error,
                    },
                );
            }
        }

        if (removedEntries > 0) {
            logger.info("[SegmentedStreaming] Pruned DASH cache directories", {
                removedEntries,
                skippedActiveEntries,
                skippedRecentEntries,
                totalBytesBefore,
                totalBytesAfter: totalBytes,
                maxBytes,
            });
        }

        return {
            inspectedEntries: entries.length,
            removedEntries,
            skippedActiveEntries,
            skippedRecentEntries,
            totalBytesBefore,
            totalBytesAfter: totalBytes,
            maxBytes,
        };
    }

    private async collectDashCacheDirectoryStats(): Promise<DashCacheDirectoryStat[]> {
        let rootEntries: Array<{ name: string; isDirectory: () => boolean }>;
        try {
            rootEntries = await fsPromises.readdir(this.dashCacheRoot, {
                withFileTypes: true,
            });
        } catch (error: unknown) {
            if (isFileNotFoundError(error)) {
                return [];
            }

            throw error;
        }

        const stats: DashCacheDirectoryStat[] = [];
        for (const entry of rootEntries) {
            if (!entry.isDirectory()) {
                continue;
            }

            const outputDir = buildCachePath(this.dashCacheRoot, entry.name);
            const { sizeBytes, modifiedAtMs } =
                await this.getDirectoryUsageStats(outputDir);

            stats.push({
                cacheKey: entry.name,
                outputDir,
                sizeBytes,
                modifiedAtMs,
            });
        }

        return stats;
    }

    private async getDirectoryUsageStats(
        outputDir: string,
    ): Promise<{ sizeBytes: number; modifiedAtMs: number }> {
        let sizeBytes = 0;
        let modifiedAtMs = 0;
        const pendingDirectories = [outputDir];

        while (pendingDirectories.length > 0) {
            const currentDir = pendingDirectories.pop();
            if (!currentDir) {
                continue;
            }

            let entries: Array<{ name: string; isDirectory: () => boolean }>;
            try {
                entries = await fsPromises.readdir(currentDir, {
                    withFileTypes: true,
                });
            } catch (error: unknown) {
                if (isFileNotFoundError(error)) {
                    continue;
                }
                throw error;
            }

            for (const entry of entries) {
                const entryPath = path.join(currentDir, entry.name);
                let stat: { size: number; mtimeMs: number };
                try {
                    stat = await fsPromises.stat(entryPath);
                } catch (error: unknown) {
                    if (isFileNotFoundError(error)) {
                        continue;
                    }
                    throw error;
                }

                modifiedAtMs = Math.max(modifiedAtMs, stat.mtimeMs);
                if (entry.isDirectory()) {
                    pendingDirectories.push(entryPath);
                } else {
                    sizeBytes += stat.size;
                }
            }
        }

        return {
            sizeBytes,
            modifiedAtMs,
        };
    }
}

const resolveSegmentedStreamingCacheBasePath = (): string => {
    const configuredPath = process.env[SEGMENTED_CACHE_BASE_PATH_ENV]?.trim();
    if (configuredPath) {
        return configuredPath;
    }

    return config.music.transcodeCachePath;
};

const isFileNotFoundError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT";

const parsePositiveNumberEnv = (envName: string): number | null => {
    const rawValue = process.env[envName]?.trim();
    if (!rawValue) {
        return null;
    }

    const parsedValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        return null;
    }

    return parsedValue;
};

const resolveSegmentedCacheSchemaVersion = (): string => {
    const configuredVersion =
        process.env[SEGMENTED_CACHE_SCHEMA_VERSION_ENV]?.trim();
    if (configuredVersion) {
        return configuredVersion;
    }

    return DEFAULT_SEGMENTED_CACHE_SCHEMA_VERSION;
};

const resolveSegmentedCacheMaxBytes = (): number => {
    const explicitMaxGb = parsePositiveNumberEnv(SEGMENTED_CACHE_MAX_GB_ENV);
    const fallbackMaxGb = Number.isFinite(config.music.transcodeCacheMaxGb) &&
        config.music.transcodeCacheMaxGb > 0
        ? config.music.transcodeCacheMaxGb
        : DEFAULT_SEGMENTED_CACHE_MAX_GB;

    const maxGb = explicitMaxGb ?? fallbackMaxGb;
    return Math.floor(maxGb * BYTES_PER_GB);
};

const resolveSegmentedCachePruneIntervalMs = (): number =>
    Math.floor(
        parsePositiveNumberEnv(SEGMENTED_CACHE_PRUNE_INTERVAL_MS_ENV) ??
            DEFAULT_SEGMENTED_CACHE_PRUNE_INTERVAL_MS,
    );

const resolveSegmentedCacheMinAgeMs = (): number =>
    Math.floor(
        parsePositiveNumberEnv(SEGMENTED_CACHE_MIN_AGE_MS_ENV) ??
            DEFAULT_SEGMENTED_CACHE_MIN_AGE_MS,
    );

const resolveSegmentedCachePruneTargetRatio = (): number => {
    const configuredRatio = parsePositiveNumberEnv(
        SEGMENTED_CACHE_PRUNE_TARGET_RATIO_ENV,
    );
    if (configuredRatio === null) {
        return DEFAULT_SEGMENTED_CACHE_PRUNE_TARGET_RATIO;
    }

    return Math.min(Math.max(configuredRatio, 0.1), 0.99);
};

export const segmentedStreamingCacheService = new SegmentedStreamingCacheService();
