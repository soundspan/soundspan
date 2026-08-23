import { audiobookshelfService } from "./audiobookshelf";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import fs from "fs/promises";
import path from "path";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import { buildCachePath, isPastStaleWindow } from "./cacheHelpers";
import { safeResolvePath } from "../utils/safeResolvePath";
import {
    buildSafeAudiobookCoverUrl,
    safeCoverFilename,
} from "./audiobookCoverProxy";
import { buildSectionsWhenPresent } from "./audiobookSections";
import {
    AUDIOBOOK_SYNC_CLAIM_KEY,
    AUDIOBOOK_SYNC_CLAIM_TTL_MS,
    AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
    runWithSchedulerClaim,
} from "../utils/schedulerClaim";
import { withTimeout } from "../utils/withTimeout";
import {
    MAX_EXTERNAL_IMAGE_BYTES,
    readResponseBodyWithByteCap,
} from "./imageProxy";

/**
 * Service to sync audiobooks from Audiobookshelf and cache them locally
 * This allows us to serve audiobook metadata from our database instead of hitting
 * the Audiobookshelf API every time, dramatically improving performance
 */

interface SyncResult {
    synced: number;
    failed: number;
    skipped: number;
    deleted: number;
    errors: string[];
}

const AUDIOBOOK_CACHE_STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUDIOBOOK_PRUNE_BATCH_SIZE = 100;
const audiobookCacheLogger = logger.child("AudiobookCache");
const AUDIOBOOK_SYNC_TIMEOUT_MESSAGE = `Full audiobook sync timed out after ${AUDIOBOOK_SYNC_WORK_TIMEOUT_MS}ms`;

type LocalAudiobookRow = {
    id: string;
    localCoverPath: string | null;
};

function hasNonEmptyAudiobookId(book: any): boolean {
    return typeof book?.id === "string" && book.id.trim().length > 0;
}

function createSyncResult(): SyncResult {
    return {
        synced: 0,
        failed: 0,
        skipped: 0,
        deleted: 0,
        errors: [],
    };
}

class AudiobookSyncTimeoutError extends Error {
    constructor() {
        super(AUDIOBOOK_SYNC_TIMEOUT_MESSAGE);
        this.name = "AudiobookSyncTimeoutError";
    }
}

function throwIfSyncDeadlineExpired(deadlineMs: number): void {
    if (Date.now() >= deadlineMs) throw new AudiobookSyncTimeoutError();
}

/**
 * Represents the AudiobookCacheService class.
 */
export class AudiobookCacheService {
    private coverCacheDir: string;
    private coverCacheAvailable: boolean = false;

    constructor() {
        // Store covers in: <MUSIC_PATH>/cover-cache/audiobooks/
        this.coverCacheDir = buildCachePath(
            config.music.musicPath,
            "cover-cache",
            "audiobooks",
        );
    }

    /**
     * Try to ensure cover cache directory exists
     * Returns true if available, false if not (permissions issue)
     */
    private async ensureCoverCacheDir(): Promise<boolean> {
        try {
            await fs.mkdir(this.coverCacheDir, { recursive: true });
            this.coverCacheAvailable = true;
            return true;
        } catch (error: any) {
            logger.warn(
                `[AUDIOBOOK] Cover cache directory unavailable: ${error.message}`,
            );
            logger.warn(
                "[AUDIOBOOK] Covers will be served directly from Audiobookshelf",
            );
            this.coverCacheAvailable = false;
            return false;
        }
    }

    /**
     * Sync all Audiobookshelf books and destructively reconcile the local cache.
     * Removes absent local rows, cached covers, progress, and playback references,
     * and writes federation tombstones when enabled. Empty or malformed listings
     * skip pruning.
     */
    async syncAll(): Promise<SyncResult> {
        try {
            const locked = await withTimeout(
                () =>
                    runWithSchedulerClaim(
                        AUDIOBOOK_SYNC_CLAIM_KEY,
                        AUDIOBOOK_SYNC_CLAIM_TTL_MS,
                        "full audiobook sync",
                        () =>
                            this.syncAllLocked(
                                Date.now() + AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
                            ),
                    ),
                AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
                "full audiobook sync",
                audiobookCacheLogger,
            );
            if (!locked) throw new AudiobookSyncTimeoutError();
            if (!locked.acquired) {
                throw new Error("audiobook sync already running");
            }
            return locked.value;
        } catch (error: any) {
            logger.error(" Audiobook sync failed:", error);
            throw error;
        }
    }

    private async syncAllLocked(deadlineMs: number): Promise<SyncResult> {
        const result = createSyncResult();
        logger.debug(" Starting audiobook sync from Audiobookshelf...");
        await this.ensureCoverCacheDir();
        const pruneCutoff = new Date();
        const listing = await audiobookshelfService.getAudiobookListing();
        const audiobooks = listing.books;
        logger.debug(
            `[AUDIOBOOK] Found ${audiobooks.length} audiobooks in Audiobookshelf`,
        );
        await this.syncBooks(
            audiobooks,
            result,
            { logEachBook: true },
            deadlineMs,
        );
        result.deleted = await this.pruneMissingAudiobooks(
            audiobooks,
            listing.verifiedCompleteLibraryIds,
            pruneCutoff,
            deadlineMs,
        );
        this.logSyncSummary(result);
        return result;
    }

    private logSyncSummary(result: SyncResult): void {
        logger.debug("\nSync Summary:");
        logger.debug(`  Synced: ${result.synced}`);
        logger.debug(`   Failed: ${result.failed}`);
        logger.debug(`    Skipped: ${result.skipped}`);
        logger.debug(`    Deleted: ${result.deleted}`);
        if (result.errors.length === 0) return;
        logger.debug("\n[ERRORS]:");
        result.errors.forEach((error) => logger.debug(`  - ${error}`));
    }

    /**
     * Sync audiobooks that exist in Audiobookshelf but are not cached locally.
     * This fetches the full item listing because Audiobookshelf has no delta API.
     * It is lighter than syncAll because cached books skip upserts and cover work.
     */
    async syncMissing(): Promise<SyncResult> {
        try {
            const locked = await runWithSchedulerClaim(
                AUDIOBOOK_SYNC_CLAIM_KEY,
                AUDIOBOOK_SYNC_CLAIM_TTL_MS,
                "incremental audiobook sync",
                () =>
                    this.syncMissingLocked(
                        Date.now() + AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
                    ),
            );
            if (!locked.acquired) {
                audiobookCacheLogger.debug(
                    "Skipped incremental audiobook sync because another audiobook sync is running",
                );
                return createSyncResult();
            }
            return locked.value;
        } catch (error: any) {
            logger.error(" Audiobook incremental sync failed:", error);
            throw error;
        }
    }

    private async syncMissingLocked(deadlineMs: number): Promise<SyncResult> {
        const result = createSyncResult();
        const audiobooks = await audiobookshelfService.getAllAudiobooks();
        if (audiobooks.length === 0) return result;
        const cachedAudiobooks = await prisma.audiobook.findMany({
            where: { peerId: null },
            select: { id: true },
        });
        const cachedIds = new Set(
            cachedAudiobooks.map((audiobook) => audiobook.id),
        );
        const missingAudiobooks = audiobooks.filter(
            (audiobook) => !cachedIds.has(audiobook.id),
        );
        result.skipped = audiobooks.length - missingAudiobooks.length;
        if (missingAudiobooks.length === 0) return result;
        await this.ensureCoverCacheDir();
        await this.syncBooks(
            missingAudiobooks,
            result,
            {
                logEachBook: false,
            },
            deadlineMs,
        );
        logger.debug(
            `[AUDIOBOOK] Incremental sync complete: ${result.synced} new, ${result.skipped} already cached or skipped, ${result.failed} failed`,
        );
        return result;
    }

    private async findFederatedCollisionIds(
        books: any[],
    ): Promise<Set<string>> {
        const ids = books
            .filter(hasNonEmptyAudiobookId)
            .map((book) => book.id as string);
        if (ids.length === 0) return new Set();
        const rows = await prisma.audiobook.findMany({
            where: {
                id: { in: ids },
                peerId: { not: null },
            },
            select: { id: true },
        });
        return new Set(rows.map((row) => row.id));
    }

    private async syncBooks(
        books: any[],
        result: SyncResult,
        options: { logEachBook: boolean },
        deadlineMs: number,
    ): Promise<void> {
        const federatedCollisionIds =
            await this.findFederatedCollisionIds(books);
        for (const book of books) {
            throwIfSyncDeadlineExpired(deadlineMs);
            if (federatedCollisionIds.has(book.id)) {
                result.skipped++;
                audiobookCacheLogger.warn(
                    "Skipped ABS book whose id collides with a federated audiobook",
                    { audiobookId: book.id },
                );
                continue;
            }
            const metadata = book.media?.metadata || book;
            const title = metadata.title || book.title || "Unknown Title";
            const author =
                metadata.authorName ||
                metadata.author ||
                book.author ||
                "Unknown Author";

            try {
                await this.syncAudiobook(book);
                result.synced++;
                if (options.logEachBook) {
                    logger.debug(`  Synced: ${title} by ${author}`);
                }
            } catch (error: any) {
                result.failed++;
                const errorMsg = `Failed to sync ${title}: ${error.message}`;
                result.errors.push(errorMsg);
                logger.error(` ${errorMsg}`, error);
            }
        }
    }

    private async pruneMissingAudiobooks(
        books: any[],
        verifiedCompleteLibraryIds: ReadonlySet<string>,
        pruneCutoff: Date,
        deadlineMs: number,
    ): Promise<number> {
        if (!books.every(hasNonEmptyAudiobookId)) {
            audiobookCacheLogger.warn(
                "Skipped pruning audiobooks because Audiobookshelf returned a malformed listing",
            );
            return 0;
        }

        const localRowCount = await prisma.audiobook.count({
            where: {
                peerId: null,
                lastSyncedAt: { lt: pruneCutoff },
            },
        });

        if (books.length === 0 && localRowCount > 0) {
            audiobookCacheLogger.warn(
                "Skipped pruning audiobooks because Audiobookshelf returned an empty listing; the configured library may be unavailable",
            );
            return 0;
        }

        const verifiedLibraryIds = await this.getPrunableLibraryIds(
            books,
            verifiedCompleteLibraryIds,
        );
        await this.logSkippedPruneRows(verifiedLibraryIds, pruneCutoff);
        const localRows = await prisma.audiobook.findMany({
            where: {
                peerId: null,
                libraryId: { in: verifiedLibraryIds },
                lastSyncedAt: { lt: pruneCutoff },
            },
            select: { id: true, localCoverPath: true },
        });
        const listedIds = new Set(books.map((book) => book.id));
        const staleRows = localRows.filter((row) => !listedIds.has(row.id));
        return this.pruneAudiobookBatches(staleRows, pruneCutoff, deadlineMs);
    }

    private async getPrunableLibraryIds(
        books: any[],
        verifiedLibraryIds: ReadonlySet<string>,
    ): Promise<string[]> {
        const listedLibraryIds = new Set(
            books
                .map((book) => book.libraryId)
                .filter(
                    (libraryId): libraryId is string =>
                        typeof libraryId === "string" && libraryId.length > 0,
                ),
        );
        const prunableLibraryIds: string[] = [];
        for (const libraryId of verifiedLibraryIds) {
            if (listedLibraryIds.has(libraryId)) {
                prunableLibraryIds.push(libraryId);
                continue;
            }
            const localRowCount = await prisma.audiobook.count({
                where: { peerId: null, libraryId },
            });
            if (localRowCount === 0) {
                prunableLibraryIds.push(libraryId);
                continue;
            }
            audiobookCacheLogger.warn(
                `Skipped pruning audiobook library ${libraryId} because Audiobookshelf returned an empty listing while ${localRowCount} local rows exist`,
            );
        }
        return prunableLibraryIds;
    }

    private async logSkippedPruneRows(
        verifiedLibraryIds: string[],
        pruneCutoff: Date,
    ): Promise<void> {
        const baseWhere = {
            peerId: null,
            lastSyncedAt: { lt: pruneCutoff },
        } as const;
        const [unknownLibraryCount, unverifiedLibraryCount] = await Promise.all(
            [
                prisma.audiobook.count({
                    where: { ...baseWhere, libraryId: null },
                }),
                prisma.audiobook.count({
                    where: {
                        ...baseWhere,
                        libraryId: {
                            not: null,
                            notIn: verifiedLibraryIds,
                        },
                    },
                }),
            ],
        );
        if (unknownLibraryCount > 0) {
            audiobookCacheLogger.warn(
                `skipped ${unknownLibraryCount} audiobooks with unknown library during prune`,
            );
        }
        if (unverifiedLibraryCount > 0) {
            audiobookCacheLogger.debug(
                `Skipped ${unverifiedLibraryCount} audiobooks from libraries without verified-complete listings during prune`,
            );
        }
    }

    private async pruneAudiobookBatches(
        staleRows: LocalAudiobookRow[],
        pruneCutoff: Date,
        deadlineMs: number,
    ): Promise<number> {
        let deleted = 0;
        for (
            let offset = 0;
            offset < staleRows.length;
            offset += AUDIOBOOK_PRUNE_BATCH_SIZE
        ) {
            throwIfSyncDeadlineExpired(deadlineMs);
            const batch = staleRows.slice(
                offset,
                offset + AUDIOBOOK_PRUNE_BATCH_SIZE,
            );
            const deletedRows = await this.deleteAudiobookBatch(
                batch,
                pruneCutoff,
            );
            deleted += deletedRows.length;
            await this.unlinkAudiobookCovers(deletedRows);
        }
        return deleted;
    }

    private async deleteAudiobookBatch(
        batch: LocalAudiobookRow[],
        pruneCutoff: Date,
    ): Promise<LocalAudiobookRow[]> {
        const ids = batch.map((row) => row.id);
        return prisma.$transaction(async (transaction) => {
            const result = await transaction.audiobook.deleteMany({
                where: {
                    id: { in: ids },
                    peerId: null,
                    lastSyncedAt: { lt: pruneCutoff },
                },
            });
            const deletedRows = await this.resolveDeletedAudiobooks(
                transaction,
                batch,
                result.count,
            );
            const deletedIds = deletedRows.map((row) => row.id);
            await this.deleteAudiobookUserState(transaction, deletedIds);
            await this.writeAudiobookTombstones(transaction, deletedIds);
            return deletedRows;
        });
    }

    private async resolveDeletedAudiobooks(
        transaction: Prisma.TransactionClient,
        selected: LocalAudiobookRow[],
        deletedCount: number,
    ): Promise<LocalAudiobookRow[]> {
        if (deletedCount === selected.length) return selected;
        const remaining = await transaction.audiobook.findMany({
            where: { id: { in: selected.map((row) => row.id) } },
            select: { id: true },
        });
        const remainingIds = new Set(remaining.map((row) => row.id));
        const deletedRows = selected.filter((row) => !remainingIds.has(row.id));
        if (deletedRows.length !== deletedCount) {
            throw new Error(
                "Audiobook deletion count changed during prune cleanup",
            );
        }
        return deletedRows;
    }

    private async deleteAudiobookUserState(
        transaction: Prisma.TransactionClient,
        audiobookIds: string[],
    ): Promise<void> {
        if (audiobookIds.length === 0) return;
        await transaction.audiobookProgress.deleteMany({
            where: { audiobookshelfId: { in: audiobookIds } },
        });
        await transaction.playbackState.updateMany({
            where: { audiobookId: { in: audiobookIds } },
            data: { audiobookId: null },
        });
    }

    private async writeAudiobookTombstones(
        transaction: Prisma.TransactionClient,
        audiobookIds: string[],
    ): Promise<void> {
        if (!config.features.federation || audiobookIds.length === 0) return;
        await transaction.federationTombstone.createMany({
            data: audiobookIds.map((entityId) => ({
                entityType: "audiobook",
                entityId,
            })),
        });
    }

    private async unlinkAudiobookCovers(
        deletedRows: LocalAudiobookRow[],
    ): Promise<void> {
        for (const row of deletedRows) {
            await this.unlinkAudiobookCover(row);
        }
    }

    private async unlinkAudiobookCover(row: LocalAudiobookRow): Promise<void> {
        const coverPath = this.resolveAudiobookCoverPath(row);
        if (!coverPath) return;
        try {
            await fs.unlink(coverPath);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            audiobookCacheLogger.warn("Failed to delete audiobook cover", {
                audiobookId: row.id,
                coverPath,
                error,
            });
        }
    }

    private resolveAudiobookCoverPath(row: LocalAudiobookRow): string | null {
        const cacheDir = path.resolve(this.coverCacheDir);
        const relativeCoverPath =
            row.localCoverPath ?? safeCoverFilename(row.id);
        if (!relativeCoverPath) {
            this.warnUnsafeCoverId(row.id);
            return null;
        }
        const coverPath = safeResolvePath(cacheDir, relativeCoverPath);
        if (coverPath) return coverPath;
        audiobookCacheLogger.warn("Skipped unsafe audiobook cover path", {
            audiobookId: row.id,
        });
        return null;
    }

    private warnUnsafeCoverId(audiobookId: string): void {
        audiobookCacheLogger.warn(
            "Skipped audiobook cover operation for unsafe audiobook id",
            { audiobookId },
        );
    }

    /**
     * Sync a single audiobook
     */
    private async syncAudiobook(book: any): Promise<void> {
        const metadata = book.media?.metadata || book;
        const title = metadata.title || book.title;

        if (!title) {
            logger.warn(`  Skipping audiobook ${book.id} - missing title`);
            return;
        }

        const author = metadata.authorName || metadata.author || null;
        const narrator = metadata.narratorName || metadata.narrator || null;
        const description = metadata.description || null;
        const publishedYear = metadata.publishedYear
            ? parseInt(metadata.publishedYear)
            : null;
        const publisher = metadata.publisher || null;
        const isbn = metadata.isbn || null;
        const asin = metadata.asin || null;
        const language = metadata.language || null;
        const genres = metadata.genres || [];
        const tags = book.tags || [];
        const duration = book.media?.duration || null;
        const numTracks = book.media?.numTracks || null;
        const sections = buildSectionsWhenPresent({
            durationSeconds: duration,
            chapters: book.media?.chapters,
            audioFiles: book.media?.audioFiles,
        });
        const size = book.size ? BigInt(book.size) : null;
        const libraryId = book.libraryId || null;

        const coverPath = book.media?.coverPath || null;
        const coverUrl = coverPath ? `items/${book.id}/cover` : null;

        // Parse series name and sequence from seriesName string (e.g. "Series Name #2")
        let series: string | null = null;
        let seriesSequence: string | null = null;

        if (metadata.seriesName && typeof metadata.seriesName === "string") {
            const seriesStr = metadata.seriesName.trim();

            const sequencePatterns = [
                /^(.+?)\s*#(\d+(?:\.\d+)?)\s*$/, // "Series Name #1" or "Series Name #1.5"
                /^(.+?)\s*,?\s*Book\s*(\d+(?:\.\d+)?)\s*$/i, // "Series Name Book 1" or "Series Name, Book 1"
                /^(.+?)\s*,?\s*Vol\.?\s*(\d+(?:\.\d+)?)\s*$/i, // "Series Name Vol 1" or "Series Name, Vol. 1"
                /^(.+?)\s*\((\d+(?:\.\d+)?)\)\s*$/, // "Series Name (1)"
            ];

            let matched = false;
            for (const pattern of sequencePatterns) {
                const match = seriesStr.match(pattern);
                if (match) {
                    series = match[1].trim();
                    seriesSequence = match[2];
                    matched = true;
                    break;
                }
            }

            // If no sequence pattern matched, use the whole string as series name
            if (!matched && seriesStr) {
                series = seriesStr;
                seriesSequence = null;
            }
        }

        if (!series) {
            if (Array.isArray(metadata.series) && metadata.series.length > 0) {
                series = metadata.series[0]?.name || null;
                seriesSequence =
                    metadata.series[0]?.sequence?.toString() || null;
            } else if (
                typeof metadata.series === "object" &&
                metadata.series !== null
            ) {
                series = metadata.series.name || null;
                seriesSequence = metadata.series.sequence?.toString() || null;
            }
        }

        if (series) {
            logger.debug(
                `    [Series] "${title}" -> "${series}" #${
                    seriesSequence || "?"
                }`,
            );
        }

        let localCoverPath: string | null = null;
        if (coverUrl) {
            const fullCoverUrl = await this.getFullCoverUrl(coverUrl);
            if (fullCoverUrl) {
                localCoverPath = await this.downloadCover(
                    book.id,
                    fullCoverUrl,
                );
            }
        }

        // Upsert to database
        await prisma.audiobook.upsert({
            where: { id: book.id },
            create: {
                id: book.id,
                title,
                author,
                narrator,
                description,
                publishedYear,
                publisher,
                series,
                seriesSequence,
                duration,
                numTracks,
                sections: sections ?? Prisma.DbNull,
                size,
                isbn,
                asin,
                language,
                genres,
                tags,
                localCoverPath,
                coverUrl,
                audioUrl: book.id,
                libraryId,
                lastSyncedAt: new Date(),
            },
            update: {
                title,
                author,
                narrator,
                description,
                publishedYear,
                publisher,
                series,
                seriesSequence,
                duration,
                numTracks,
                ...(sections === null ? {} : { sections }),
                size,
                isbn,
                asin,
                language,
                genres,
                tags,
                localCoverPath: localCoverPath || undefined,
                coverUrl,
                audioUrl: book.id,
                libraryId,
                lastSyncedAt: new Date(),
            },
        });
    }

    /**
     * Get the full Audiobookshelf cover URL, confining the path through the
     * shared cover-path allowlist.
     */
    private async getFullCoverUrl(
        relativePath: string,
    ): Promise<string | null> {
        try {
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();

            if (settings?.audiobookshelfUrl) {
                const baseUrl = settings.audiobookshelfUrl.replace(/\/$/, "");
                const coverUrl = buildSafeAudiobookCoverUrl(
                    relativePath,
                    baseUrl,
                );
                if (!coverUrl) {
                    logger.warn(
                        `[AUDIOBOOK] Rejected unsafe cover path: ${relativePath}`,
                    );
                }
                return coverUrl;
            }

            return null;
        } catch (error: any) {
            logger.error(
                "Failed to get Audiobookshelf base URL:",
                error.message,
            );
            return null;
        }
    }

    /**
     * Download a cover image and save it locally
     * Returns null if cover caching is not available (permissions issue)
     */
    private async downloadCover(
        audiobookId: string,
        coverUrl: string,
    ): Promise<string | null> {
        // Skip cover download if cache directory is not available
        if (!this.coverCacheAvailable) {
            return null;
        }
        const fileName = safeCoverFilename(audiobookId);
        if (!fileName) {
            this.warnUnsafeCoverId(audiobookId);
            return null;
        }

        try {
            // Get API key for authentication
            const { getSystemSettings } =
                await import("../utils/systemSettings");
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfApiKey) {
                throw new Error("Audiobookshelf API key not configured");
            }

            const response = await fetch(coverUrl, {
                headers: {
                    Authorization: `Bearer ${settings.audiobookshelfApiKey}`,
                },
                signal: AbortSignal.timeout(15000),
            });

            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new Error(
                    `HTTP ${response.status}: ${response.statusText}`,
                );
            }

            const bodyResult = await readResponseBodyWithByteCap(
                response,
                MAX_EXTERNAL_IMAGE_BYTES,
            );
            if (!bodyResult.ok) {
                return null;
            }
            const filePath = path.join(this.coverCacheDir, fileName);

            await fs.writeFile(filePath, bodyResult.buffer);

            return filePath;
        } catch (error: any) {
            logger.error(
                `Failed to download cover for ${audiobookId}:`,
                error.message,
            );
            return null;
        }
    }

    /**
     * Get a single audiobook from cache or sync it
     */
    async getAudiobook(audiobookId: string): Promise<any> {
        // Try to get from database first
        let audiobook = await prisma.audiobook.findUnique({
            where: { id: audiobookId },
        });

        // If not cached, stale, or missing section data, try to sync it.
        if (
            !audiobook ||
            audiobook.sections === null ||
            isPastStaleWindow(
                audiobook.lastSyncedAt,
                AUDIOBOOK_CACHE_STALE_WINDOW_MS,
            )
        ) {
            logger.debug(
                `[AUDIOBOOK] Audiobook ${audiobookId} not cached, stale, or missing sections; syncing...`,
            );
            try {
                const book =
                    await audiobookshelfService.getAudiobook(audiobookId);
                await this.syncAudiobook(book);
                audiobook = await prisma.audiobook.findUnique({
                    where: { id: audiobookId },
                });
            } catch (syncError: any) {
                logger.warn(
                    `  Failed to sync audiobook ${audiobookId} from Audiobookshelf:`,
                    syncError.message,
                );
                // If we have stale cached data, return it anyway
                if (audiobook) {
                    logger.debug(
                        `   Using stale cached data for ${audiobookId}`,
                    );
                } else {
                    // No cached data and sync failed - throw error
                    throw new Error(
                        `Audiobook not found in cache and sync failed: ${syncError.message}`,
                    );
                }
            }
        }

        return audiobook;
    }

    /**
     * Clean up old cached covers that are no longer in database
     */
    async cleanupOrphanedCovers(): Promise<number> {
        // Ensure cache directory is available
        const available = await this.ensureCoverCacheDir();
        if (!available) {
            logger.warn(
                "[AUDIOBOOK] Cannot cleanup covers - cache directory unavailable",
            );
            return 0;
        }

        const audiobooks = await prisma.audiobook.findMany({
            select: { localCoverPath: true },
        });

        const validCoverPaths = new Set(
            audiobooks
                .filter((a) => a.localCoverPath)
                .map((a) => path.basename(a.localCoverPath!)),
        );

        let deleted = 0;
        try {
            const files = await fs.readdir(this.coverCacheDir);

            for (const file of files) {
                if (!validCoverPaths.has(file)) {
                    await fs.unlink(path.join(this.coverCacheDir, file));
                    deleted++;
                    logger.debug(`  [DELETE] Deleted orphaned cover: ${file}`);
                }
            }
        } catch (error: any) {
            logger.warn(
                `[AUDIOBOOK] Failed to read cover cache directory: ${error.message}`,
            );
        }

        return deleted;
    }
}

// Export singleton instance
export const audiobookCacheService = new AudiobookCacheService();
