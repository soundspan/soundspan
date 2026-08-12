import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { safeResolvePath } from "../utils/safeResolvePath";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { config } from "../config";
import { buildCachePath } from "./cacheHelpers";
import { fetchExternalImage, MAX_EXTERNAL_IMAGE_BYTES } from "./imageProxy";

const podcastCacheLogger = logger.child("PodcastCache");

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isImageMediaType(contentType: string | null): boolean {
    return contentType?.trim().toLowerCase().startsWith("image/") ?? false;
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resolveCoverPaths(
    coverCacheDir: string,
    id: string,
    type: "podcast" | "episode",
): { filePath: string; temporaryPath: string } | null {
    const fileName = `${type}_${id}.jpg`;
    const filePath = safeResolvePath(coverCacheDir, fileName);
    const temporaryPath = safeResolvePath(
        coverCacheDir,
        `${fileName}.${randomUUID()}.tmp`,
    );

    return filePath && temporaryPath ? { filePath, temporaryPath } : null;
}

async function writeCoverAtomically(
    filePath: string,
    temporaryPath: string,
    buffer: Buffer,
): Promise<void> {
    try {
        await fs.writeFile(temporaryPath, buffer);
        await fs.rename(temporaryPath, filePath);
    } catch (error) {
        await fs.unlink(temporaryPath).catch((cleanupError: unknown) => {
            if (!isMissingFileError(cleanupError)) {
                podcastCacheLogger.error(
                    "Failed to clean up partial cover file",
                    { error: cleanupError },
                );
            }
        });
        throw error;
    }
}

/**
 * Service to cache podcast cover images locally
 * Podcasts are already stored in database (from RSS feeds)
 * This service adds cover image caching to avoid repeated downloads
 */

interface CoverSyncResult {
    synced: number;
    failed: number;
    skipped: number;
    errors: string[];
}

/**
 * Represents the PodcastCacheService class.
 */
export class PodcastCacheService {
    private coverCacheDir: string;

    constructor() {
        // Store covers in: <MUSIC_PATH>/cover-cache/podcasts/
        this.coverCacheDir = buildCachePath(
            config.music.musicPath,
            "cover-cache",
            "podcasts",
        );
    }

    /** Returns the canonical root used for server-managed podcast covers. */
    getCoverCacheRoot(): string {
        return this.coverCacheDir;
    }

    /**
     * Sync cover images for all podcasts
     */
    async syncAllCovers(): Promise<CoverSyncResult> {
        const result: CoverSyncResult = {
            synced: 0,
            failed: 0,
            skipped: 0,
            errors: [],
        };

        try {
            podcastCacheLogger.debug("Starting podcast cover sync...");

            // Ensure cover cache directory exists
            await fs.mkdir(this.coverCacheDir, { recursive: true });

            // Fetch all podcasts from database
            const podcasts = await prisma.podcast.findMany({
                where: {
                    localCoverPath: null, // Only sync podcasts without local covers
                    imageUrl: { not: null },
                },
            });

            podcastCacheLogger.debug(
                `Found ${podcasts.length} podcasts needing cover sync`,
            );

            for (const podcast of podcasts) {
                try {
                    if (podcast.imageUrl) {
                        const localPath = await this.downloadCover(
                            podcast.id,
                            podcast.imageUrl,
                            "podcast",
                        );

                        if (localPath) {
                            await prisma.podcast.update({
                                where: { id: podcast.id },
                                data: { localCoverPath: localPath },
                            });
                            result.synced++;
                            podcastCacheLogger.debug(
                                `  Synced cover for: ${podcast.title}`,
                            );
                        } else {
                            result.skipped++;
                        }
                    }
                } catch (error: unknown) {
                    result.failed++;
                    const errorMsg = `Failed to sync cover for ${podcast.title}: ${describeError(error)}`;
                    result.errors.push(errorMsg);
                    podcastCacheLogger.error(` ${errorMsg}`);
                }
            }

            podcastCacheLogger.debug("\nPodcast Cover Sync Summary:");
            podcastCacheLogger.debug(`  Synced: ${result.synced}`);
            podcastCacheLogger.debug(`   Failed: ${result.failed}`);
            podcastCacheLogger.debug(`    Skipped: ${result.skipped}`);

            return result;
        } catch (error: unknown) {
            podcastCacheLogger.error(" Podcast cover sync failed:", error);
            throw error;
        }
    }

    /**
     * Sync cover images for all podcast episodes (if they have unique covers)
     */
    async syncEpisodeCovers(): Promise<CoverSyncResult> {
        const result: CoverSyncResult = {
            synced: 0,
            failed: 0,
            skipped: 0,
            errors: [],
        };

        try {
            podcastCacheLogger.debug("Starting podcast episode cover sync...");

            await fs.mkdir(this.coverCacheDir, { recursive: true });

            // Fetch episodes with unique covers (different from podcast cover)
            const episodes = await prisma.podcastEpisode.findMany({
                where: {
                    localCoverPath: null,
                    imageUrl: { not: null },
                },
                include: {
                    podcast: {
                        select: {
                            imageUrl: true,
                        },
                    },
                },
            });

            // Filter to only episodes with unique covers
            const uniqueEpisodes = episodes.filter(
                (ep) => ep.imageUrl !== ep.podcast.imageUrl,
            );

            podcastCacheLogger.debug(
                `Found ${uniqueEpisodes.length} episodes with unique covers`,
            );

            for (const episode of uniqueEpisodes) {
                try {
                    if (episode.imageUrl) {
                        const localPath = await this.downloadCover(
                            episode.id,
                            episode.imageUrl,
                            "episode",
                        );

                        if (localPath) {
                            await prisma.podcastEpisode.update({
                                where: { id: episode.id },
                                data: { localCoverPath: localPath },
                            });
                            result.synced++;
                            podcastCacheLogger.debug(
                                `  Synced cover for episode: ${episode.title}`,
                            );
                        } else {
                            result.skipped++;
                        }
                    }
                } catch (error: unknown) {
                    result.failed++;
                    const errorMsg = `Failed to sync cover for episode ${episode.title}: ${describeError(error)}`;
                    result.errors.push(errorMsg);
                    podcastCacheLogger.error(` ${errorMsg}`);
                }
            }

            podcastCacheLogger.debug("\nEpisode Cover Sync Summary:");
            podcastCacheLogger.debug(`  Synced: ${result.synced}`);
            podcastCacheLogger.debug(`   Failed: ${result.failed}`);
            podcastCacheLogger.debug(`    Skipped: ${result.skipped}`);

            return result;
        } catch (error: unknown) {
            podcastCacheLogger.error(" Episode cover sync failed:", error);
            throw error;
        }
    }

    /**
     * Download a cover image and save it locally
     */
    private async downloadCover(
        id: string,
        imageUrl: string,
        type: "podcast" | "episode",
    ): Promise<string | null> {
        const paths = resolveCoverPaths(this.coverCacheDir, id, type);
        if (!paths) {
            podcastCacheLogger.error(
                `Rejected cover path outside cache for ${type} ${id}`,
            );
            return null;
        }

        try {
            const result = await fetchExternalImage({
                url: imageUrl,
                timeoutMs: 15000,
                maxRedirects: 0,
                maxRetries: 1,
                maxBytes: MAX_EXTERNAL_IMAGE_BYTES,
            });
            if (!result.ok) {
                if (result.status === "invalid_url") {
                    podcastCacheLogger.error(
                        `SSRF-blocked cover download for ${type} ${id}:`,
                        imageUrl,
                    );
                } else {
                    podcastCacheLogger.error(
                        `Failed to download cover for ${type} ${id}:`,
                        result.message ?? result.status,
                    );
                }
                return null;
            }

            if (!isImageMediaType(result.contentType)) {
                podcastCacheLogger.error(
                    `Rejected non-image cover for ${type} ${id}:`,
                    result.contentType,
                );
                return null;
            }

            await writeCoverAtomically(
                paths.filePath,
                paths.temporaryPath,
                result.buffer,
            );

            return paths.filePath;
        } catch (error: unknown) {
            podcastCacheLogger.error(
                `Failed to download cover for ${type} ${id}:`,
                describeError(error),
            );
            return null;
        }
    }

    /**
     * Clean up orphaned covers
     */
    async cleanupOrphanedCovers(): Promise<number> {
        const podcasts = await prisma.podcast.findMany({
            select: { localCoverPath: true },
        });

        const episodes = await prisma.podcastEpisode.findMany({
            select: { localCoverPath: true },
        });

        const validCoverPaths = new Set([
            ...podcasts
                .filter((p) => p.localCoverPath)
                .map((p) => path.basename(p.localCoverPath!)),
            ...episodes
                .filter((e) => e.localCoverPath)
                .map((e) => path.basename(e.localCoverPath!)),
        ]);

        let deleted = 0;
        const files = await fs.readdir(this.coverCacheDir);

        for (const file of files) {
            if (!validCoverPaths.has(file)) {
                await fs.unlink(path.join(this.coverCacheDir, file));
                deleted++;
                podcastCacheLogger.debug(
                    `  [DELETE] Deleted orphaned podcast cover: ${file}`,
                );
            }
        }

        return deleted;
    }
}

// Export singleton instance
export const podcastCacheService = new PodcastCacheService();
