import * as fs from "fs";
import type { Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { deezerService } from "./deezer";
import {
    normalizeArtistName,
    areArtistNamesSimilar,
    canonicalizeVariousArtists,
    extractPrimaryArtist,
    parseArtistFromPath,
} from "../utils/artistNormalization";
import { backfillAllArtistCounts } from "./artistCountsService";
import { processBatched } from "../utils/async";
import { computeAudioStreamHash } from "./audioHash";
import {
    matchTrackIdentities,
    type TrackIdentityMatch,
} from "./trackIdentityMatcher";
import {
    applyTrackReplacement,
    removeReplacementCacheFiles,
} from "./trackReplacement";
import { cleanupOrphanedLibraryEntities } from "./libraryOrphanCleanup";
import { config } from "../config";

const scanLogger = logger.child("MusicScannerService");

const TRACK_IDENTITY_SELECT = {
    id: true,
    filePath: true,
    fileModified: true,
    fileSize: true,
    duration: true,
    title: true,
    discNo: true,
    trackNo: true,
    mime: true,
    albumId: true,
    audioHash: true,
    audioHashedAt: true,
    recordingMbid: true,
    isrc: true,
    removedAt: true,
    album: { select: { rgMbid: true } },
} satisfies Prisma.TrackSelect;

type IdentityTrackRow = Prisma.TrackGetPayload<{
    select: typeof TRACK_IDENTITY_SELECT;
}>;

function isTrackRemoved(track: Pick<IdentityTrackRow, "removedAt">): boolean {
    return track.removedAt instanceof Date;
}

function hasAudioReplacement(
    storedHash: string | null,
    nextHash: string | null,
): boolean {
    return storedHash !== null && nextHash !== null && storedHash !== nextHash;
}

function buildRebindData(
    candidate: IdentityTrackRow,
    missing: IdentityTrackRow,
): Prisma.TrackUpdateArgs["data"] {
    const hashData =
        candidate.audioHash === null && missing.audioHash !== null
            ? {}
            : {
                  audioHash: candidate.audioHash,
                  audioHashedAt: candidate.audioHashedAt,
              };
    return {
        filePath: candidate.filePath,
        fileModified: candidate.fileModified,
        fileSize: candidate.fileSize,
        mime: candidate.mime,
        albumId: candidate.albumId,
        title: candidate.title,
        trackNo: candidate.trackNo,
        discNo: candidate.discNo,
        duration: candidate.duration,
        recordingMbid: candidate.recordingMbid,
        isrc: candidate.isrc,
        ...hashData,
        removedAt: null,
    };
}

type LibraryHealthRecordDelegate = {
    upsert(args: Prisma.LibraryHealthRecordUpsertArgs): Promise<unknown>;
    deleteMany(
        args: Prisma.LibraryHealthRecordDeleteManyArgs,
    ): Promise<unknown>;
};

function getLibraryHealthRecordDelegate(): LibraryHealthRecordDelegate {
    return (
        prisma as typeof prisma & {
            libraryHealthRecord: LibraryHealthRecordDelegate;
        }
    ).libraryHealthRecord;
}

function isPrismaRecordNotFound(error: unknown): boolean {
    return Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2025",
    );
}

function mergeTracksById(
    first: readonly IdentityTrackRow[],
    second: readonly IdentityTrackRow[],
): IdentityTrackRow[] {
    const tracksById = new Map(first.map((track) => [track.id, track]));
    for (const track of second) tracksById.set(track.id, track);
    return [...tracksById.values()];
}

// Supported audio formats
const AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ape",
    ".wv",
]);
const MAX_SCAN_DEPTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRACK_PATH_QUERY_BATCH_SIZE = 10_000;
const REMOVED_TRACK_REVIVAL_POOL_LIMIT = 10_000;
// Cap health writes at the worker database pool's four connections.
const HEALTH_WRITE_BATCH_SIZE = 4;

interface ScanProgress {
    filesScanned: number;
    filesTotal: number;
    currentFile: string;
    errors: Array<{ file: string; error: string }>;
}

interface ScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

/**
 * Represents the MusicScannerService class.
 */
export class MusicScannerService {
    private scanQueue = new PQueue({ concurrency: 10 });
    private progressCallback?: (progress: ScanProgress) => void;
    private coverArtExtractor?: CoverArtExtractor;

    constructor(
        progressCallback?: (progress: ScanProgress) => void,
        coverCachePath?: string,
    ) {
        this.progressCallback = progressCallback;
        if (coverCachePath) {
            this.coverArtExtractor = new CoverArtExtractor(coverCachePath);
        }
    }

    private async markTrackHealthIssue(
        trackId: string,
        status: "MISSING_FROM_DISK" | "UNREADABLE_METADATA",
        filePath: string,
        detail?: string,
    ): Promise<void> {
        await getLibraryHealthRecordDelegate().upsert({
            where: { trackId },
            update: {
                status,
                filePath,
                detail: detail ?? null,
            },
            create: {
                trackId,
                status,
                filePath,
                detail: detail ?? null,
            },
        });
    }

    private async clearTrackHealthIssue(trackId: string): Promise<void> {
        await getLibraryHealthRecordDelegate().deleteMany({
            where: { trackId },
        });
    }

    private async markMissingTracks(
        tracks: Array<{ id: string; filePath: string }>,
    ): Promise<void> {
        await processBatched(tracks, HEALTH_WRITE_BATCH_SIZE, (batch) =>
            Promise.all(
                batch.map((track) =>
                    this.markTrackHealthIssue(
                        track.id,
                        "MISSING_FROM_DISK",
                        track.filePath,
                    ),
                ),
            ),
        );
        logger.debug(
            `Recorded ${tracks.length} missing tracks in library health`,
        );
    }

    private async handleMissingTracks(
        tracks: Array<{ id: string; filePath: string }>,
        audioFileCount: number,
    ): Promise<number> {
        if (audioFileCount === 0) {
            await this.markMissingTracks(tracks);
            logger.warn(
                "Skipped removing missing tracks because no audio files were found; the music directory may be unavailable",
            );
            return 0;
        }

        await this.markMissingTracks(tracks);
        const removed = await prisma.track.updateMany({
            where: {
                id: { in: tracks.map((track) => track.id) },
                removedAt: null,
            },
            data: { removedAt: new Date() },
        });
        logger.info(
            `Soft-removed ${removed.count} missing tracks from the library`,
        );
        return removed.count;
    }

    private async rebindMovedTrack(
        match: TrackIdentityMatch<IdentityTrackRow, IdentityTrackRow>,
        revival: boolean,
    ): Promise<void> {
        const replacement = hasAudioReplacement(
            match.missing.audioHash,
            match.candidate.audioHash,
        );
        const cachePaths = await prisma.$transaction(async (transaction) => {
            await transaction.track.delete({
                where: { id: match.candidate.id },
            });
            const trackData = buildRebindData(match.candidate, match.missing);
            let replacementCachePaths: string[] = [];
            if (replacement) {
                replacementCachePaths = await applyTrackReplacement(
                    transaction,
                    match.missing.id,
                    trackData,
                );
            } else {
                await transaction.track.update({
                    where: { id: match.missing.id },
                    data: trackData,
                });
            }
            await transaction.libraryHealthRecord.deleteMany({
                where: { trackId: match.missing.id },
            });
            return replacementCachePaths;
        });
        await removeReplacementCacheFiles(cachePaths);
        const action = revival ? "Revived" : "Re-bound";
        scanLogger.info(
            `${action} track ${match.missing.filePath} → ${match.candidate.filePath}`,
        );
    }

    private async rebindMovedTracks(
        missing: IdentityTrackRow[],
        candidatePaths: readonly string[],
        revival = false,
    ): Promise<{
        unmatched: IdentityTrackRow[];
        rebound: number;
        consumedCandidatePaths: string[];
    }> {
        if (missing.length === 0 || candidatePaths.length === 0) {
            return {
                unmatched: missing,
                rebound: 0,
                consumedCandidatePaths: [],
            };
        }
        const candidates = await this.loadTracksByPaths(candidatePaths);
        const matches = matchTrackIdentities(missing, candidates);
        const reboundMatches: typeof matches = [];
        for (const match of matches) {
            try {
                await this.rebindMovedTrack(match, revival);
                reboundMatches.push(match);
            } catch (error: unknown) {
                if (!isPrismaRecordNotFound(error)) throw error;
                scanLogger.warn(
                    `Skipped re-binding ${match.missing.id}; a matched track changed concurrently`,
                );
            }
        }
        const reboundIds = new Set(
            reboundMatches.map((match) => match.missing.id),
        );
        return {
            unmatched: missing.filter((track) => !reboundIds.has(track.id)),
            rebound: reboundMatches.length,
            consumedCandidatePaths: reboundMatches.map(
                (match) => match.candidate.filePath,
            ),
        };
    }

    private async loadTracksByPaths(
        filePaths: readonly string[],
    ): Promise<IdentityTrackRow[]> {
        return processBatched(
            [...filePaths],
            TRACK_PATH_QUERY_BATCH_SIZE,
            (batch) =>
                prisma.track.findMany({
                    where: { filePath: { in: batch } },
                    select: TRACK_IDENTITY_SELECT,
                }),
        );
    }

    private async loadTracksForScan(
        scannedPaths: ReadonlySet<string>,
    ): Promise<IdentityTrackRow[]> {
        const activeTracks = await prisma.track.findMany({
            where: { removedAt: null },
            select: TRACK_IDENTITY_SELECT,
        });
        const tracksAtScannedPaths = await this.loadTracksByPaths([
            ...scannedPaths,
        ]);
        return mergeTracksById(activeTracks, tracksAtScannedPaths);
    }

    private async reviveRemovedTracks(
        candidatePaths: readonly string[],
    ): Promise<number> {
        if (candidatePaths.length === 0) return 0;
        const retentionDays = config.workers.trackRemovalRetentionDays;
        if (retentionDays === 0) return 0;
        const purgeCutoff = new Date(Date.now() - retentionDays * DAY_MS);
        const removedTracks = await prisma.track.findMany({
            where: { removedAt: { not: null, gte: purgeCutoff } },
            orderBy: { removedAt: "desc" },
            take: REMOVED_TRACK_REVIVAL_POOL_LIMIT,
            select: TRACK_IDENTITY_SELECT,
        });
        const result = await this.rebindMovedTracks(
            removedTracks,
            candidatePaths,
            true,
        );
        return result.rebound;
    }

    /**
     * Scan the music directory and update the database
     */
    async scanLibrary(musicPath: string): Promise<ScanResult> {
        const startTime = Date.now();
        const result: ScanResult = {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
            errors: [],
            duration: 0,
        };

        logger.debug(`Starting library scan: ${musicPath}`);

        // Step 1: Find all audio files
        const audioFiles = await this.findAudioFiles(musicPath);
        logger.debug(`Found ${audioFiles.length} audio files`);
        const scannedPaths = new Set(
            audioFiles.map((file) => path.relative(musicPath, file)),
        );

        // Step 2: Load active tracks plus removed rows that still own a path
        // found in this scan. The broader removed pool stays bounded below.
        const existingTracks = await this.loadTracksForScan(scannedPaths);

        const tracksByPath = new Map(
            existingTracks.map((t) => [t.filePath, t]),
        );

        // Check if one-time disc-number backfill is needed
        // (discNo was added in a migration — existing tracks default to 1)
        const settings = await prisma.systemSettings.findFirst();
        const needsDiscBackfill = !(settings?.discNoBackfillDone ?? false);
        if (needsDiscBackfill) {
            logger.info(
                "[Scanner] One-time disc-number backfill — will re-read disc metadata from all files",
            );
        }

        // Step 3: Process each audio file
        let filesScanned = 0;
        const progress: ScanProgress = {
            filesScanned: 0,
            filesTotal: audioFiles.length,
            currentFile: "",
            errors: [],
        };
        const newTrackPaths = new Set<string>();

        for (const audioFile of audioFiles) {
            await this.scanQueue.add(async () => {
                let countedAsExisting: boolean | undefined;
                try {
                    const relativePath = path.relative(musicPath, audioFile);
                    progress.currentFile = relativePath;
                    this.progressCallback?.(progress);

                    const stats = await fs.promises.stat(audioFile);
                    const fileModified = stats.mtime;

                    const existingTrack = tracksByPath.get(relativePath);

                    // Check if file needs updating
                    if (existingTrack) {
                        if (
                            !isTrackRemoved(existingTrack) &&
                            !needsDiscBackfill &&
                            existingTrack.fileModified &&
                            existingTrack.fileModified >= fileModified
                        ) {
                            // File hasn't changed and disc backfill already done, skip
                            filesScanned++;
                            progress.filesScanned = filesScanned;
                            return;
                        }
                        // File changed or needs disc metadata update
                        result.tracksUpdated++;
                        countedAsExisting = true;
                    } else {
                        // New file
                        result.tracksAdded++;
                        countedAsExisting = false;
                    }

                    // Hash only new or content-changed files (durable track
                    // identity, #457). Unchanged files reprocessed for the
                    // disc backfill keep their stored hash untouched.
                    const needsHash =
                        !existingTrack ||
                        isTrackRemoved(existingTrack) ||
                        !existingTrack.audioHash ||
                        !existingTrack.fileModified ||
                        existingTrack.fileModified < fileModified;

                    // Extract metadata and update database
                    await this.processAudioFile(
                        audioFile,
                        relativePath,
                        musicPath,
                        needsHash,
                        existingTrack?.audioHash ?? null,
                    );
                    if (!existingTrack) newTrackPaths.add(relativePath);
                } catch (err: any) {
                    const relativePath = path.relative(musicPath, audioFile);
                    const existingTrack = tracksByPath.get(relativePath);
                    if (countedAsExisting === true) result.tracksUpdated -= 1;
                    if (countedAsExisting === false) result.tracksAdded -= 1;
                    if (existingTrack) {
                        await this.markTrackHealthIssue(
                            existingTrack.id,
                            "UNREADABLE_METADATA",
                            existingTrack.filePath,
                            err.message || String(err),
                        );
                    }
                    const error = {
                        file: audioFile,
                        error: err.message || String(err),
                    };
                    result.errors.push(error);
                    progress.errors.push(error);
                    logger.error(`Error processing ${audioFile}:`, err);
                } finally {
                    filesScanned++;
                    progress.filesScanned = filesScanned;
                    this.progressCallback?.(progress);
                }
            });
        }

        await this.scanQueue.onIdle();

        // Step 4: Handle tracked files that no longer exist
        const tracksToRemove = existingTracks.filter(
            (track) =>
                !isTrackRemoved(track) && !scannedPaths.has(track.filePath),
        );

        let reboundTracks = 0;
        let unmatchedTracks = tracksToRemove;
        let revivalCandidatePaths = [...newTrackPaths];
        if (audioFiles.length > 0 && tracksToRemove.length > 0) {
            const rebindResult = await this.rebindMovedTracks(tracksToRemove, [
                ...newTrackPaths,
            ]);
            unmatchedTracks = rebindResult.unmatched;
            reboundTracks = rebindResult.rebound;
            const consumedPaths = new Set(rebindResult.consumedCandidatePaths);
            revivalCandidatePaths = revivalCandidatePaths.filter(
                (candidatePath) => !consumedPaths.has(candidatePath),
            );
            result.tracksAdded -= reboundTracks;
            result.tracksUpdated += reboundTracks;
        }

        const revivedTracks = await this.reviveRemovedTracks(
            revivalCandidatePaths,
        );
        result.tracksAdded -= revivedTracks;
        result.tracksUpdated += revivedTracks;

        if (unmatchedTracks.length > 0) {
            result.tracksRemoved = await this.handleMissingTracks(
                unmatchedTracks,
                audioFiles.length,
            );
        }

        const shouldCleanOrphans =
            tracksToRemove.length === 0 ||
            result.tracksRemoved > 0 ||
            reboundTracks > 0 ||
            revivedTracks > 0;

        // Steps 5-6: Delete only parents with no Track rows. Soft-removed
        // tracks still satisfy the relation and preserve their parents.
        if (shouldCleanOrphans) {
            await cleanupOrphanedLibraryEntities();
        }

        result.duration = Date.now() - startTime;
        logger.debug(
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved} (${result.duration}ms)`,
        );

        // Mark disc-number backfill as done so future scans skip unchanged files normally
        if (needsDiscBackfill) {
            await prisma.systemSettings.updateMany({
                data: { discNoBackfillDone: true },
            });
            logger.info(
                "[Scanner] Disc-number backfill complete — flagged as done",
            );
        }

        // Update artist denormalized counts in background (non-blocking).
        // The library artists route has a JOIN-based fallback for when counts
        // are stale, so the UI works immediately even before this completes.
        backfillAllArtistCounts().catch((err) => {
            logger.error("[Scan] Artist counts update failed:", err);
        });

        return result;
    }

    /**
     * Check if a file path is within the discovery folder
     * Discovery albums are stored in paths like "discovery/Artist/Album/track.flac"
     * or "Discover/Artist/Album/track.flac" (case-insensitive)
     */
    private isDiscoveryPath(relativePath: string): boolean {
        const normalizedPath = relativePath.toLowerCase().replace(/\\/g, "/");
        // Check if path starts with "discovery/" or "discover/"
        return (
            normalizedPath.startsWith("discovery/") ||
            normalizedPath.startsWith("discover/")
        );
    }

    /**
     * Normalize string for matching - handles encoding differences between
     * file metadata and database records
     */
    private normalizeForMatching(str: string): string {
        return str
            .toLowerCase()
            .trim()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // Remove diacritics (café → cafe)
            .replace(/[''´`]/g, "'") // Normalize apostrophes
            .replace(/[""„]/g, '"') // Normalize quotes
            .replace(/[–—−]/g, "-") // Normalize dashes
            .replace(/\s+/g, " ") // Collapse whitespace
            .replace(/[^\w\s'"-]/g, ""); // Remove other special chars
    }

    /**
     * Check if an album is part of a discovery download by matching artist name + album title.
     * Uses multi-pass matching: exact match first, then partial match as fallback.
     */
    private async isDiscoveryDownload(
        artistName: string,
        albumTitle: string,
    ): Promise<boolean> {
        if (!artistName || !albumTitle) return false;

        const normalizedArtist = this.normalizeForMatching(artistName);
        const normalizedAlbum = this.normalizeForMatching(albumTitle);

        // Also try with primary artist extracted (handles "Artist A feat. Artist B")
        const primaryArtist = extractPrimaryArtist(artistName);
        const normalizedPrimaryArtist =
            this.normalizeForMatching(primaryArtist);

        logger.debug(
            `[Scanner] Checking discovery: "${artistName}" -> "${normalizedArtist}"`,
        );
        if (primaryArtist !== artistName) {
            logger.debug(
                `[Scanner]   Primary artist: "${primaryArtist}" -> "${normalizedPrimaryArtist}"`,
            );
        }
        logger.debug(
            `[Scanner]   Album: "${albumTitle}" -> "${normalizedAlbum}"`,
        );

        try {
            // Get all discovery jobs (pending, processing, or recently completed)
            const discoveryJobs = await prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: { not: null },
                    status: { in: ["pending", "processing", "completed"] },
                },
            });

            logger.debug(
                `[Scanner]   Found ${discoveryJobs.length} discovery jobs to check`,
            );

            // Pass 1: Exact match after normalization
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(
                    metadata?.artistName || "",
                );
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || "",
                );

                if (
                    (jobArtist === normalizedArtist ||
                        jobArtist === normalizedPrimaryArtist) &&
                    jobAlbum === normalizedAlbum
                ) {
                    logger.debug(`[Scanner] EXACT MATCH: job ${job.id}`);
                    return true;
                }
            }

            // Pass 2: Partial match fallback (handles "Album" vs "Album (Deluxe)")
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(
                    metadata?.artistName || "",
                );
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || "",
                );

                // Try matching both full artist name and extracted primary artist
                const artistMatch =
                    jobArtist === normalizedArtist ||
                    jobArtist === normalizedPrimaryArtist ||
                    normalizedArtist.includes(jobArtist) ||
                    jobArtist.includes(normalizedArtist) ||
                    normalizedPrimaryArtist.includes(jobArtist) ||
                    jobArtist.includes(normalizedPrimaryArtist);
                const albumMatch =
                    jobAlbum === normalizedAlbum ||
                    normalizedAlbum.includes(jobAlbum) ||
                    jobAlbum.includes(normalizedAlbum);

                if (artistMatch && albumMatch) {
                    logger.debug(`[Scanner] PARTIAL MATCH: job ${job.id}`);
                    logger.debug(
                        `[Scanner]   Job: "${jobArtist}" - "${jobAlbum}"`,
                    );
                    return true;
                }
            }

            // Pass 3: Album-only match (handles featured artists on discovery albums)
            // If the album title matches exactly, this track is likely a featured artist on a discovery album
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobAlbum = this.normalizeForMatching(
                    metadata?.albumTitle || "",
                );

                if (
                    jobAlbum === normalizedAlbum &&
                    normalizedAlbum.length > 3
                ) {
                    logger.debug(
                        `[Scanner] ALBUM-ONLY MATCH (featured artist): job ${job.id}`,
                    );
                    logger.debug(
                        `[Scanner]   Track artist "${normalizedArtist}" is likely featured on "${jobAlbum}"`,
                    );
                    return true;
                }
            }

            // Pass 4: Check DiscoveryAlbum table (for already processed albums) by album title
            const discoveryAlbumByTitle = await prisma.discoveryAlbum.findFirst(
                {
                    where: {
                        albumTitle: { equals: albumTitle, mode: "insensitive" },
                        status: { in: ["ACTIVE", "LIKED"] },
                    },
                },
            );

            if (discoveryAlbumByTitle) {
                logger.debug(
                    `[Scanner] DiscoveryAlbum match (by title): ${discoveryAlbumByTitle.id}`,
                );
                return true;
            }

            // Pass 5: Check if artist name matches any discovery album
            // This catches cases where Lidarr downloads a different album than requested
            // e.g., requested "Broods - Broods" but got "Broods - Evergreen"
            const discoveryAlbumByArtist =
                await prisma.discoveryAlbum.findFirst({
                    where: {
                        artistName: { equals: artistName, mode: "insensitive" },
                        status: { in: ["ACTIVE", "LIKED", "DELETED"] }, // Include DELETED to catch cleanup scenarios
                    },
                });

            if (discoveryAlbumByArtist) {
                // Double-check: only match if this artist has NO library albums yet
                // This prevents marking albums from artists that exist in both library and discovery
                const existingLibraryAlbum = await prisma.album.findFirst({
                    where: {
                        artist: {
                            name: { equals: artistName, mode: "insensitive" },
                        },
                        location: "LIBRARY",
                    },
                });

                if (!existingLibraryAlbum) {
                    logger.debug(
                        `[Scanner] DiscoveryAlbum match (by artist): ${discoveryAlbumByArtist.id}`,
                    );
                    logger.debug(
                        `[Scanner]   Artist "${artistName}" is a discovery-only artist`,
                    );
                    return true;
                }
            }

            logger.debug(`[Scanner] No discovery match found`);
            return false;
        } catch (error) {
            logger.error(`[Scanner] Error checking discovery status:`, error);
            return false;
        }
    }

    /**
     * Find all audio files in a directory.
     */
    private async findAudioFiles(dirPath: string): Promise<string[]> {
        const files: string[] = [];
        const worklist: Array<{ dir: string; depth: number }> = [
            { dir: dirPath, depth: 0 },
        ];

        while (worklist.length > 0) {
            const current = worklist.pop();
            if (!current) {
                break;
            }
            if (current.depth > MAX_SCAN_DEPTH) {
                logger.warn(
                    `[Scanner] Skipping directory beyond maximum scan depth: ${current.dir}`,
                );
                continue;
            }
            const entries = await fs.promises.readdir(current.dir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (entry.isSymbolicLink()) {
                    continue;
                }
                const fullPath = path.join(current.dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name.startsWith(".")) {
                        continue;
                    }
                    worklist.push({
                        dir: fullPath,
                        depth: current.depth + 1,
                    });
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (AUDIO_EXTENSIONS.has(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        }

        return files;
    }

    /**
     * Process a single audio file and update database
     */
    private async processAudioFile(
        absolutePath: string,
        relativePath: string,
        musicPath: string,
        computeHash = true,
        existingAudioHash: string | null = null,
    ): Promise<void> {
        // Extract metadata in two stages. The cheap header-only parse yields
        // a duration for most formats (FLAC STREAMINFO, MP3 Xing, MP4 atoms).
        // Formats that keep the duration at the END of the stream (ogg/opus —
        // YouTube downloads are opus by default) return none, so only those
        // files pay for the full-file `duration: true` parse; without it they
        // import as 0:00. Full-file parsing must stay the exception: running
        // it for every file (10 concurrent parses) pegged the worker's event
        // loop for minutes per scan, starving Bull lock renewal and the
        // liveness probe until the kubelet killed the worker mid-scan.
        let metadata = await parseFile(absolutePath);
        if (!metadata.format.duration) {
            metadata = await parseFile(absolutePath, { duration: true });
        }
        const stats = await fs.promises.stat(absolutePath);

        // Parse basic info
        const title =
            metadata.common.title ||
            path.basename(relativePath, path.extname(relativePath));
        const trackNo = metadata.common.track.no || 0;
        const discNo = metadata.common.disk?.no || 1;
        const duration = Math.floor(metadata.format.duration || 0);
        const mime = metadata.format.codec || "audio/mpeg";
        const recordingMbid =
            metadata.common.musicbrainz_recordingid?.trim() || null;
        const rawIsrc = metadata.common.isrc as string[] | string | undefined;
        const firstIsrc = typeof rawIsrc === "string" ? rawIsrc : rawIsrc?.[0];
        const isrc = firstIsrc?.trim() || null;

        // Artist and album info
        // IMPORTANT: Prefer albumartist over artist to keep albums grouped under the primary artist
        // This prevents featured artists from creating separate album entries
        // e.g., "Artist A feat. Artist B" track should still be under "Artist A"'s album
        let rawArtistName =
            metadata.common.albumartist || metadata.common.artist || "";

        // Folder fallback: If metadata is empty, try to parse from folder structure
        if (!rawArtistName || rawArtistName.trim() === "") {
            const folderPath = path.dirname(relativePath);
            const folderName = path.basename(folderPath);
            let parsedArtist = parseArtistFromPath(folderName);

            // If the immediate parent folder didn't yield an artist (e.g. it's an album
            // folder like "Robbin' The Hood"), try the grandparent folder which may be
            // the artist folder in an Artist/Album/Track directory structure.
            if (!parsedArtist) {
                const grandparentPath = path.dirname(folderPath);
                const grandparentName = path.basename(grandparentPath);
                // Only use grandparent if it's a real folder name (not empty, not the root)
                if (
                    grandparentName &&
                    grandparentName !== "." &&
                    grandparentName !== "/"
                ) {
                    // The grandparent folder is likely the artist name itself
                    // (e.g., "Sublime" in Sublime/Robbin' The Hood/track.flac)
                    const gpParsed = parseArtistFromPath(grandparentName);
                    if (gpParsed) {
                        parsedArtist = gpParsed;
                    } else if (
                        grandparentName.length >= 2 &&
                        !/^\d+$/.test(grandparentName)
                    ) {
                        // Use the grandparent folder name directly as the artist
                        parsedArtist = grandparentName;
                    }
                }
            }

            if (parsedArtist) {
                logger.debug(
                    `[Scanner] No metadata artist found, using folder: "${folderName}" -> "${parsedArtist}"`,
                );
                rawArtistName = parsedArtist;
            } else {
                rawArtistName = "Unknown Artist";
                logger.warn(
                    `[Scanner] Unknown Artist assigned for: ${relativePath} (no metadata, folder parse failed: "${folderName}")`,
                );
            }
        }

        const albumTitle = metadata.common.album || "Unknown Album";
        const year = metadata.common.year || null;

        // ALWAYS extract primary artist first - this handles both:
        // - Featured artists: "Artist A feat. Artist B" -> "Artist A"
        // - Collaborations: "Artist A & Artist B" -> "Artist A"
        // Band names like "Of Mice & Men" are preserved because extractPrimaryArtist
        // only splits on " feat.", " ft.", " featuring ", " & ", etc. (with spaces)
        const extractedPrimaryArtist = extractPrimaryArtist(rawArtistName);
        let artistName = extractedPrimaryArtist;

        // Canonicalize Various Artists variations (VA, V.A., <Various Artists>, etc.)
        artistName = canonicalizeVariousArtists(artistName);

        // Try to find artist with the canonicalized name first
        // This ensures "VA", "V.A.", etc. all find the canonical "Various Artists"
        const normalizedPrimaryName = normalizeArtistName(artistName);
        let artist = await prisma.artist.findFirst({
            where: { normalizedName: normalizedPrimaryName },
        });

        // If no match with primary name and we actually extracted something,
        // also try the full raw name (for bands like "Of Mice & Men")
        if (!artist && extractedPrimaryArtist !== rawArtistName) {
            const normalizedRawName = normalizeArtistName(rawArtistName);
            artist = await prisma.artist.findFirst({
                where: { normalizedName: normalizedRawName },
            });
            // If full name matches an existing artist, use that instead
            if (artist) {
                artistName = rawArtistName;
            }
        }

        // Update normalized name for use below
        const normalizedArtistName = normalizeArtistName(artistName);

        // If we found an artist, optionally update to better capitalization
        if (artist && artist.name !== artistName) {
            // Check if the new name has better capitalization (starts with uppercase)
            const currentNameIsLowercase =
                artist.name[0] === artist.name[0].toLowerCase();
            const newNameIsCapitalized =
                artistName[0] === artistName[0].toUpperCase();

            if (currentNameIsLowercase && newNameIsCapitalized) {
                logger.debug(
                    `Updating artist name capitalization: "${artist.name}" -> "${artistName}"`,
                );
                artist = await prisma.artist.update({
                    where: { id: artist.id },
                    data: { name: artistName },
                });
            }
        }

        if (!artist) {
            // Try fuzzy matching to catch typos like "the weeknd" vs "the weekend"
            // Only check artists with similar normalized names (performance optimization)
            const similarArtists = await prisma.artist.findMany({
                where: {
                    normalizedName: {
                        // Get artists whose normalized names start with similar prefix
                        startsWith: normalizedArtistName.substring(
                            0,
                            Math.min(3, normalizedArtistName.length),
                        ),
                    },
                },
                select: {
                    id: true,
                    name: true,
                    normalizedName: true,
                    mbid: true,
                },
            });

            // Check for fuzzy matches
            for (const candidate of similarArtists) {
                if (areArtistNamesSimilar(artistName, candidate.name, 95)) {
                    logger.debug(
                        `Fuzzy match found: "${artistName}" -> "${candidate.name}"`,
                    );
                    artist = candidate as any;
                    break;
                }
            }
        }

        if (!artist) {
            // Try to find by MusicBrainz ID if available
            const artistMbid = metadata.common.musicbrainz_artistid?.[0];
            if (artistMbid) {
                artist = await prisma.artist.findUnique({
                    where: { mbid: artistMbid },
                });

                // If we have a real MBID but no artist exists, check if there's a temp artist we should consolidate
                if (!artist) {
                    const tempArtist = await prisma.artist.findFirst({
                        where: {
                            normalizedName: normalizedArtistName,
                            mbid: { startsWith: "temp-" },
                        },
                    });

                    if (tempArtist) {
                        // Consolidate: update temp artist to real MBID
                        logger.debug(
                            `[SCANNER] Consolidating temp artist "${tempArtist.name}" with real MBID: ${artistMbid}`,
                        );
                        try {
                            artist = await prisma.artist.update({
                                where: { id: tempArtist.id },
                                data: { mbid: artistMbid },
                            });
                        } catch (error: any) {
                            if (error.code === "P2002") {
                                logger.debug(
                                    `[SCANNER] MBID ${artistMbid} already belongs to another artist, reusing canonical record`,
                                );
                                artist = await prisma.artist.findUnique({
                                    where: { mbid: artistMbid },
                                });
                                if (!artist) {
                                    // Rare race edge case: keep temp artist linkage for this file
                                    // and let later scans consolidate once canonical row is visible.
                                    logger.warn(
                                        `[SCANNER] MBID collision detected for ${artistMbid}, but canonical artist lookup returned null; keeping temp artist linkage`,
                                    );
                                    artist = tempArtist;
                                }
                            } else {
                                throw error;
                            }
                        }
                    }
                }
            }

            if (!artist) {
                // Create new artist (use a temporary MBID for now)
                try {
                    artist = await prisma.artist.create({
                        data: {
                            name: artistName,
                            normalizedName: normalizedArtistName,
                            mbid:
                                artistMbid ||
                                `temp-${Date.now()}-${Math.random()}`,
                            enrichmentStatus: "pending",
                        },
                    });
                } catch (error: any) {
                    // Handle concurrent scanner workers attempting the same artist MBID.
                    if (error.code === "P2002" && artistMbid) {
                        const existingArtist = await prisma.artist.findUnique({
                            where: { mbid: artistMbid },
                        });
                        if (existingArtist) {
                            logger.debug(
                                `[SCANNER] Artist create raced on MBID ${artistMbid}; reusing existing artist "${existingArtist.name}"`,
                            );
                            artist = existingArtist;
                        } else {
                            throw error;
                        }
                    } else {
                        throw error;
                    }
                }
            }
        }

        const albumMbid = metadata.common.musicbrainz_releasegroupid;

        const isDiscoveryByPath = this.isDiscoveryPath(relativePath);
        const isDiscoveryByJob = await this.isDiscoveryDownload(
            artistName,
            albumTitle,
        );

        let isDiscoveryArtist = false;
        if (!isDiscoveryByPath && !isDiscoveryByJob) {
            const artistAlbums = await prisma.album.findMany({
                where: { artistId: artist.id },
                select: { location: true },
            });

            // Artist is discovery-only only when they already have discovery
            // albums and still have no owned library albums.
            if (artistAlbums.length > 0) {
                const hasLibraryAlbums = artistAlbums.some(
                    (candidateAlbum) => candidateAlbum.location === "LIBRARY",
                );
                const hasDiscoveryAlbums = artistAlbums.some(
                    (candidateAlbum) => candidateAlbum.location === "DISCOVER",
                );
                isDiscoveryArtist = hasDiscoveryAlbums && !hasLibraryAlbums;
                if (isDiscoveryArtist) {
                    logger.debug(
                        `[Scanner] Discovery-only artist detected: ${artistName}`,
                    );
                }
            }
        }

        const isDiscoveryAlbum =
            isDiscoveryByPath || isDiscoveryByJob || isDiscoveryArtist;

        // Get or create album.
        //
        // Resolve on the UNIQUE MusicBrainz release-group MBID first, so two
        // albums that share a title but are different release groups — e.g.
        // the two self-titled Crystal Castles albums (2008 and 2010) — never
        // merge into one. Only un-tagged files (no release-group id) fall back
        // to an exact-title match within the artist, so files tagged with
        // distinct release groups are never merged by title.
        let album = albumMbid
            ? await prisma.album.findFirst({
                  where: { artistId: artist.id, rgMbid: albumMbid },
              })
            : await prisma.album.findFirst({
                  where: {
                      artistId: artist.id,
                      title: albumTitle,
                  },
              });

        // rgMbid is globally unique. A tagged file may reference a release
        // group that already exists under a DIFFERENT artist row — e.g.
        // compilation tracks lacking an albumartist tag fall back to the
        // per-track artist, or inconsistent "A & B" vs "B & A" albumartist
        // tags resolve to different primary artists. The artist-scoped
        // lookup above misses those rows, and creating a new album would
        // violate the unique constraint — so fall back to a global lookup
        // and reuse the existing album.
        if (!album && albumMbid) {
            album = await prisma.album.findUnique({
                where: { rgMbid: albumMbid },
            });
        }

        if (!album) {
            // Create new album (un-tagged files get a unique temporary MBID).
            const rgMbid = albumMbid || `temp-${Date.now()}-${Math.random()}`;

            try {
                album = await prisma.album.create({
                    data: {
                        title: albumTitle,
                        artistId: artist.id,
                        rgMbid,
                        year,
                        primaryType: "Album",
                        location: isDiscoveryAlbum ? "DISCOVER" : "LIBRARY",
                    },
                });
            } catch (error: any) {
                // Handle concurrent scanner workers (queue concurrency is 10)
                // creating the same release group at the same time: recover
                // from the unique violation by re-looking the album up
                // globally on rgMbid, mirroring the artist-create recovery
                // above. Without this the P2002 bubbles to the per-file catch
                // and the track gets marked UNREADABLE_METADATA.
                if (error.code === "P2002") {
                    const existingAlbum = await prisma.album.findUnique({
                        where: { rgMbid },
                    });
                    if (existingAlbum) {
                        logger.debug(
                            `[SCANNER] Album create raced on rgMbid ${rgMbid}; reusing existing album "${existingAlbum.title}"`,
                        );
                        album = existingAlbum;
                    } else {
                        throw error;
                    }
                } else {
                    throw error;
                }
            }

            // Extract cover art if we have an extractor
            // Re-extract if: no cover, OR native cover file is missing
            if (this.coverArtExtractor) {
                let needsExtraction = !album.coverUrl;

                // Check if existing native cover file is missing
                if (album.coverUrl?.startsWith("native:")) {
                    const nativePath = album.coverUrl.replace("native:", "");
                    const coverCachePath = path.join(
                        path.dirname(absolutePath),
                        "..",
                        "..",
                        "cache",
                        "covers",
                        nativePath,
                    );
                    // Use the extractor's cache path instead
                    const extractorCachePath = path.join(
                        (this.coverArtExtractor as any).coverCachePath,
                        nativePath,
                    );
                    if (!fs.existsSync(extractorCachePath)) {
                        needsExtraction = true;
                    }
                }

                if (needsExtraction) {
                    const coverPath =
                        await this.coverArtExtractor.extractCoverArt(
                            absolutePath,
                            album.id,
                        );
                    if (coverPath) {
                        await prisma.album.update({
                            where: { id: album.id },
                            data: { coverUrl: `native:${coverPath}` },
                        });
                    } else {
                        // No embedded art, try fetching from Deezer
                        try {
                            const deezerCover =
                                await deezerService.getAlbumCover(
                                    artistName,
                                    albumTitle,
                                );
                            if (deezerCover) {
                                await prisma.album.update({
                                    where: { id: album.id },
                                    data: { coverUrl: deezerCover },
                                });
                            }
                        } catch (error) {
                            // Silently fail - cover art is optional
                        }
                    }
                }
            }
        }

        if (!isDiscoveryAlbum) {
            if (album.location !== "LIBRARY") {
                logger.info(
                    `[Scanner] Promoting album "${album.title}" (${album.id}) from ${album.location} to LIBRARY after local scan`,
                );
                album = await prisma.album.update({
                    where: { id: album.id },
                    data: { location: "LIBRARY" },
                });
            }

            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: artist.id,
                        rgMbid: album.rgMbid,
                    },
                },
                update: {
                    source: "native_scan",
                },
                create: {
                    rgMbid: album.rgMbid,
                    artistId: artist.id,
                    source: "native_scan",
                },
            });
        }

        const hashFields: {
            audioHash?: string | null;
            audioHashedAt?: Date | null;
        } = {};
        let computedAudioHash: string | null | undefined;
        if (computeHash) {
            computedAudioHash = await computeAudioStreamHash(absolutePath);
            if (computedAudioHash !== null || existingAudioHash === null) {
                hashFields.audioHash = computedAudioHash;
                hashFields.audioHashedAt = computedAudioHash
                    ? new Date()
                    : null;
            }
        }

        const trackUpsert = {
            where: { filePath: relativePath },
            create: {
                albumId: album.id,
                title,
                trackNo,
                discNo,
                duration,
                mime,
                filePath: relativePath,
                fileModified: stats.mtime,
                fileSize: stats.size,
                recordingMbid,
                isrc,
                ...hashFields,
            },
            update: {
                albumId: album.id,
                title,
                trackNo,
                discNo,
                duration,
                mime,
                fileModified: stats.mtime,
                fileSize: stats.size,
                recordingMbid,
                isrc,
                removedAt: null,
                ...hashFields,
            },
        } satisfies Prisma.TrackUpsertArgs;

        const replacement =
            computeHash &&
            hasAudioReplacement(existingAudioHash, computedAudioHash ?? null);
        if (replacement) {
            const committed = await prisma.$transaction(async (transaction) => {
                const track = await transaction.track.upsert(trackUpsert);
                const cachePaths = await applyTrackReplacement(
                    transaction,
                    track.id,
                );
                await transaction.libraryHealthRecord.deleteMany({
                    where: { trackId: track.id },
                });
                return { track, cachePaths };
            });
            await removeReplacementCacheFiles(committed.cachePaths);
            return;
        }

        const track = await prisma.track.upsert(trackUpsert);
        await this.clearTrackHealthIssue(track.id);
    }
}
