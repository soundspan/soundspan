import { promises as fsPromises } from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../../config";

const MANIFEST_FILE_NAME = "manifest.mpd";
const DASH_SEGMENT_FILE_REGEX = /\.m4s$/i;
const SEGMENTED_CACHE_BASE_PATH_ENV = "SEGMENTED_STREAMING_CACHE_PATH";

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

class SegmentedStreamingCacheService {
    private readonly dashCacheRoot = path.join(
        resolveSegmentedStreamingCacheBasePath(),
        "segmented-dash",
    );
    private readonly sessionRefs = new Map<string, Set<string>>();

    buildDashCacheKey(input: LocalDashCacheKeyInput): string {
        const cacheIdentity = input.cacheIdentity?.trim();
        const sourceIdentity =
            cacheIdentity ||
            `${input.trackId}:${input.sourcePath}:${input.sourceModifiedIso}`;

        return crypto
            .createHash("sha256")
            .update(`${sourceIdentity}:${input.quality}`)
            .digest("hex")
            .slice(0, 24);
    }

    getDashAssetPaths(cacheKey: string): LocalDashAssetPaths {
        const outputDir = path.join(this.dashCacheRoot, cacheKey);
        return {
            cacheKey,
            outputDir,
            manifestPath: path.join(outputDir, MANIFEST_FILE_NAME),
        };
    }

    async ensureDashAssetDirectory(cacheKey: string): Promise<LocalDashAssetPaths> {
        const paths = this.getDashAssetPaths(cacheKey);
        await fsPromises.mkdir(paths.outputDir, { recursive: true });
        return paths;
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
}

const resolveSegmentedStreamingCacheBasePath = (): string => {
    const configuredPath = process.env[SEGMENTED_CACHE_BASE_PATH_ENV]?.trim();
    if (configuredPath) {
        return configuredPath;
    }

    return config.music.transcodeCachePath;
};

export const segmentedStreamingCacheService = new SegmentedStreamingCacheService();
