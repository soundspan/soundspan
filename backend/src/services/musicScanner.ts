import * as fs from "fs";
import type { Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import * as path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { resolveAlbumCover } from "./metadata/albumCoverResolver";
import {
    normalizeArtistName,
    canonicalizeVariousArtists,
    extractPrimaryArtist,
    parseArtistFromPath,
} from "../utils/artistNormalization";
import { processBatched } from "../utils/async";
import { computeAudioStreamHash } from "./audioHash";
import { matchTrackIdentities } from "./trackIdentityMatcher";
import { cleanupOrphanedLibraryEntities } from "./libraryOrphanCleanup";
import { config } from "../config";
import { extractTrackIdentityTags } from "./trackIdentityTags";
import { trackMappingService } from "./trackMappingService";
import {
    federationDedupConfidence,
    type FederationDedupIdentity,
} from "../utils/federationDedup";
import { rebindMovedTrack } from "./trackRebinding";
import { recomputeAlbumLoudness } from "./albumLoudness";
import { persistScannedTrack } from "./scannedTrackPersistence";
import { deriveAudioFormatLabel } from "./audioFormatLabel";
import { promoteAlbumOwnership } from "./albumOwnershipPromotion";
import { updateArtistCountsInBatches } from "./artistCountsService";
import {
    resolveScannerAlbum,
    resolveScannerArtist,
} from "./musicScannerIdentity";
import { bumpSearchCacheVersion } from "./searchCacheVersion";

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
    album: { select: { rgMbid: true, artistId: true } },
} satisfies Prisma.TrackSelect;

const FEDERATION_RECONCILIATION_TRACK_SELECT = {
    ...TRACK_IDENTITY_SELECT,
    album: { select: { rgMbid: true, location: true, artistId: true } },
} satisfies Prisma.TrackSelect;

type IdentityTrackRow = Prisma.TrackGetPayload<{
    select: typeof TRACK_IDENTITY_SELECT;
}>;

type FederationLocalIdentityTrackRow = Prisma.TrackGetPayload<{
    select: typeof FEDERATION_RECONCILIATION_TRACK_SELECT;
}>;

type LocalIdentityTrackRow = Omit<IdentityTrackRow, "filePath"> & {
    filePath: string;
};

function keepTracksWithPaths(
    tracks: readonly IdentityTrackRow[],
): LocalIdentityTrackRow[] {
    return tracks.flatMap((track) =>
        track.filePath === null ? [] : [{ ...track, filePath: track.filePath }],
    );
}

function isTrackRemoved(
    track: Pick<LocalIdentityTrackRow, "removedAt">,
): boolean {
    return track.removedAt instanceof Date;
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

function toErrorMessage(error: unknown): string {
    const message =
        error && typeof error === "object" && "message" in error
            ? error.message
            : error;
    return String(message ?? error);
}

function mergeTracksById(
    first: readonly LocalIdentityTrackRow[],
    second: readonly LocalIdentityTrackRow[],
): LocalIdentityTrackRow[] {
    const tracksById = new Map(first.map((track) => [track.id, track]));
    for (const track of second) tracksById.set(track.id, track);
    return [...tracksById.values()];
}

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
const MAX_FEDERATED_DEDUP_CANDIDATES = 10_000;
const MAX_FEDERATED_DEDUP_TIERS = 4;
const MAX_FEDERATED_DEDUP_TOTAL_CANDIDATES =
    MAX_FEDERATED_DEDUP_TIERS * MAX_FEDERATED_DEDUP_CANDIDATES;
const DISCOVERY_DOWNLOAD_SELECT = {
    id: true,
    metadata: true,
} satisfies Prisma.DownloadJobSelect;
type DiscoveryDownloadIdentity = Prisma.DownloadJobGetPayload<{
    select: typeof DISCOVERY_DOWNLOAD_SELECT;
}>;
type AlbumResolution = Awaited<ReturnType<typeof resolveScannerAlbum>>;

// Ogg/Opus duration parsing can merge a full picture packet before discarding
// it under skipCovers. Serialize only this fallback to cap retained buffers.
let durationFallbackTail: Promise<void> = Promise.resolve();

function parseFullFileDuration(filePath: string): ReturnType<typeof parseFile> {
    const result = durationFallbackTail.then(
        () => parseFile(filePath, { duration: true, skipCovers: true }),
        () => parseFile(filePath, { duration: true, skipCovers: true }),
    );
    durationFallbackTail = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

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

/** Scans local audio metadata into the library. */
export class MusicScannerService {
    private scanQueue = new PQueue({ concurrency: config.scanFileConcurrency });
    private progressCallback?: (progress: ScanProgress) => void;
    private coverArtExtractor?: CoverArtExtractor;
    private touchedArtistIds = new Set<string>();
    private albumResolutions = new Map<string, Promise<AlbumResolution>>();
    private discoveryDownloadIdentities?: Promise<DiscoveryDownloadIdentity[]>;

    constructor(
        progressCallback?: (progress: ScanProgress) => void,
        coverCachePath?: string,
    ) {
        this.progressCallback = progressCallback;
        if (coverCachePath) {
            this.coverArtExtractor = new CoverArtExtractor(coverCachePath);
        }
    }

    private async promoteNativeAlbum(album: {
        id: string;
        artistId: string;
        rgMbid: string;
        location: string;
    }): Promise<void> {
        if (album.location === "LIBRARY") {
            const ownership = await prisma.ownedAlbum.findUnique({
                where: {
                    artistId_rgMbid: {
                        artistId: album.artistId,
                        rgMbid: album.rgMbid,
                    },
                },
                select: { source: true },
            });
            if (ownership?.source === "native_scan") return;
        }
        await prisma.$transaction((transaction) =>
            promoteAlbumOwnership(transaction, album, "native_scan"),
        );
    }

    private promoteNativeAlbumOnce(
        album: {
            id: string;
            artistId: string;
            rgMbid: string;
            location: string;
        },
        albumPromotions: Map<string, Promise<void>>,
    ): Promise<void> {
        const currentPromotion = albumPromotions.get(album.id);
        if (currentPromotion) return currentPromotion;
        let promotion: Promise<void>;
        promotion = this.promoteNativeAlbum(album).catch((error: unknown) => {
            if (albumPromotions.get(album.id) === promotion) {
                albumPromotions.delete(album.id);
            }
            throw error;
        });
        albumPromotions.set(album.id, promotion);
        return promotion;
    }

    private resolveOnce<T>(
        resolutions: Map<string, Promise<T>>,
        key: string,
        resolve: () => Promise<T>,
    ): Promise<T> {
        const existing = resolutions.get(key);
        if (existing) return existing;
        let resolution: Promise<T>;
        resolution = resolve().finally(() => {
            if (resolutions.get(key) === resolution) resolutions.delete(key);
        });
        resolutions.set(key, resolution);
        return resolution;
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
        tracks: Array<{ id: string; filePath: string; albumId: string }>,
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
        const removed = await prisma.$transaction(async (transaction) => {
            const result = await transaction.track.updateMany({
                where: {
                    id: { in: tracks.map((track) => track.id) },
                    origin: "LOCAL",
                    removedAt: null,
                },
                data: { removedAt: new Date() },
            });
            if (result.count > 0) {
                await recomputeAlbumLoudness(
                    transaction,
                    tracks.map((track) => track.albumId),
                );
            }
            return result;
        });
        logger.info(
            `Soft-removed ${removed.count} missing tracks from the library`,
        );
        return removed.count;
    }

    private async rebindMovedTracks(
        missing: LocalIdentityTrackRow[],
        candidatePaths: readonly string[],
        revival = false,
    ): Promise<{
        unmatched: LocalIdentityTrackRow[];
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
                await rebindMovedTrack(match, revival);
                reboundMatches.push(match);
                this.touchedArtistIds.add(match.missing.album.artistId);
                this.touchedArtistIds.add(match.candidate.album.artistId);
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
    ): Promise<LocalIdentityTrackRow[]> {
        const tracks = await processBatched(
            [...filePaths],
            TRACK_PATH_QUERY_BATCH_SIZE,
            (batch) =>
                prisma.track.findMany({
                    where: {
                        origin: "LOCAL",
                        filePath: { in: batch },
                    },
                    select: TRACK_IDENTITY_SELECT,
                }),
        );
        return keepTracksWithPaths(tracks);
    }

    private async loadTracksForScan(
        scannedPaths: ReadonlySet<string>,
    ): Promise<LocalIdentityTrackRow[]> {
        const activeRows = await prisma.track.findMany({
            where: {
                origin: "LOCAL",
                filePath: { not: null },
                removedAt: null,
            },
            select: TRACK_IDENTITY_SELECT,
        });
        const activeTracks = keepTracksWithPaths(activeRows);
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
        const removedRows = await prisma.track.findMany({
            where: {
                origin: "LOCAL",
                filePath: { not: null },
                removedAt: { not: null, gte: purgeCutoff },
            },
            orderBy: { removedAt: "desc" },
            take: REMOVED_TRACK_REVIVAL_POOL_LIMIT,
            select: TRACK_IDENTITY_SELECT,
        });
        const removedTracks = keepTracksWithPaths(removedRows);
        const result = await this.rebindMovedTracks(
            removedTracks,
            candidatePaths,
            true,
        );
        return result.rebound;
    }

    /** Scans the music directory and updates the database. */
    async scanLibrary(musicPath: string): Promise<ScanResult> {
        const startTime = Date.now();
        this.touchedArtistIds = new Set<string>();
        this.discoveryDownloadIdentities = undefined;
        const result: ScanResult = {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
            errors: [],
            duration: 0,
        };

        logger.debug(`Starting library scan: ${musicPath}`);

        const audioFiles = await this.findAudioFiles(musicPath);
        logger.debug(`Found ${audioFiles.length} audio files`);
        const scannedPaths = new Set(
            audioFiles.map((file) => path.relative(musicPath, file)),
        );

        // Load active tracks plus removed rows that still own a scanned path.
        const existingTracks = await this.loadTracksForScan(scannedPaths);

        const tracksByPath = new Map(
            existingTracks.map((t) => [t.filePath, t]),
        );

        // Existing tracks default to disc 1 until this one-time backfill runs.
        const settings = await prisma.systemSettings.findFirst();
        const needsDiscBackfill = !(settings?.discNoBackfillDone ?? false);
        if (needsDiscBackfill) {
            logger.info(
                "[Scanner] One-time disc-number backfill — will re-read disc metadata from all files",
            );
        }

        let filesScanned = 0;
        const progress: ScanProgress = {
            filesScanned: 0,
            filesTotal: audioFiles.length,
            currentFile: "",
            errors: [],
        };
        const newTrackPaths = new Set<string>();
        const albumPromotions = new Map<string, Promise<void>>();
        const scanTasks: Promise<unknown>[] = [];
        const recordFileError = (audioFile: string, err: unknown): void => {
            if (result.errors.some((error) => error.file === audioFile)) return;
            const error = {
                file: audioFile,
                error: toErrorMessage(err),
            };
            result.errors.push(error);
            progress.errors.push(error);
            logger.error(`Error processing ${audioFile}:`, err);
        };

        for (const audioFile of audioFiles) {
            await this.scanQueue.onSizeLessThan(config.scanFileConcurrency * 4);
            const scanTask = async (): Promise<void> => {
                const relativePath = path.relative(musicPath, audioFile);
                let countedAsExisting: boolean | undefined;
                try {
                    progress.currentFile = relativePath;
                    this.progressCallback?.(progress);

                    const stats = await fs.promises.stat(audioFile);
                    const fileModified = stats.mtime;

                    const existingTrack = tracksByPath.get(relativePath);

                    if (existingTrack) {
                        if (
                            !isTrackRemoved(existingTrack) &&
                            !needsDiscBackfill &&
                            existingTrack.fileModified &&
                            existingTrack.fileModified >= fileModified
                        ) {
                            return;
                        }
                        result.tracksUpdated++;
                        countedAsExisting = true;
                    } else {
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

                    const removedTrack =
                        existingTrack && isTrackRemoved(existingTrack);
                    const contentChangeDetected = Boolean(
                        existingTrack &&
                        (removedTrack ||
                            !existingTrack.fileModified ||
                            existingTrack.fileModified < fileModified),
                    );
                    await this.processAudioFile(
                        audioFile,
                        relativePath,
                        musicPath,
                        needsHash,
                        existingTrack?.audioHash ?? null,
                        existingTrack?.albumId ?? null,
                        existingTrack?.duration ?? null,
                        contentChangeDetected,
                        Boolean(removedTrack),
                        albumPromotions,
                    );
                    if (existingTrack)
                        this.touchedArtistIds.add(existingTrack.album.artistId);
                    if (!existingTrack) newTrackPaths.add(relativePath);
                } catch (err: unknown) {
                    const existingTrack = tracksByPath.get(relativePath);
                    if (countedAsExisting === true) result.tracksUpdated -= 1;
                    if (countedAsExisting === false) result.tracksAdded -= 1;
                    if (existingTrack) {
                        try {
                            await this.markTrackHealthIssue(
                                existingTrack.id,
                                "UNREADABLE_METADATA",
                                existingTrack.filePath,
                                toErrorMessage(err),
                            );
                        } catch (healthError: unknown) {
                            logger.error(
                                `Failed to record health issue for ${audioFile}:`,
                                healthError,
                            );
                        }
                    }
                    recordFileError(audioFile, err);
                } finally {
                    filesScanned++;
                    progress.filesScanned = filesScanned;
                    progress.currentFile = relativePath;
                    try {
                        this.progressCallback?.(progress);
                    } catch (error: unknown) {
                        recordFileError(audioFile, error);
                    }
                }
            };
            const queuedTask = this.scanQueue
                .add(scanTask)
                .catch((error: unknown) => recordFileError(audioFile, error));
            scanTasks.push(queuedTask);
        }

        await this.scanQueue.onIdle();
        await Promise.all(scanTasks);

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

        if (config.features.federation && newTrackPaths.size > 0) {
            await this.reconcileFederatedDuplicates([...newTrackPaths]);
        }

        if (unmatchedTracks.length > 0) {
            result.tracksRemoved = await this.handleMissingTracks(
                unmatchedTracks,
                audioFiles.length,
            );
            if (result.tracksRemoved > 0) {
                for (const track of unmatchedTracks) {
                    this.touchedArtistIds.add(track.album.artistId);
                }
            }
        }

        const shouldCleanOrphans =
            tracksToRemove.length === 0 ||
            result.tracksRemoved > 0 ||
            reboundTracks > 0 ||
            revivedTracks > 0;

        // Soft-removed tracks preserve parents because they retain Track rows.
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

        const touchedArtistIds = [...this.touchedArtistIds].sort();
        if (touchedArtistIds.length > 0) {
            updateArtistCountsInBatches(touchedArtistIds).catch((err) => {
                logger.error("[Scan] Artist counts update failed:", err);
            });
        }

        await bumpSearchCacheVersion();

        return result;
    }

    private dedupIdentity(track: {
        audioHash: string | null;
        recordingMbid: string | null;
        isrc: string | null;
        discNo: number;
        trackNo: number;
        album: { rgMbid: string };
    }): FederationDedupIdentity {
        return { ...track, albumRgMbid: track.album.rgMbid };
    }

    private async reconcileFederatedTrack(
        local: FederationLocalIdentityTrackRow,
    ): Promise<void> {
        const candidates = await this.loadFederatedDedupCandidates(local);
        let confidence: number | null = null;
        for (
            let index = 0;
            index < MAX_FEDERATED_DEDUP_TOTAL_CANDIDATES &&
            index < candidates.length;
            index += 1
        ) {
            const candidateConfidence = federationDedupConfidence(
                this.dedupIdentity(local),
                this.dedupIdentity(candidates[index]),
            );
            if (candidateConfidence === null) continue;
            const updated = await prisma.track.updateMany({
                where: { id: candidates[index].id, dedupPinned: false },
                data: { dedupOfTrackId: local.id },
            });
            if (updated.count !== 1) continue;
            confidence = Math.max(confidence ?? 0, candidateConfidence);
        }
        if (confidence === null) return;
        await trackMappingService.createMapping({
            trackId: local.id,
            confidence,
            source: "federation",
        });
    }

    private async loadFederatedCandidates(
        identityWhere: Prisma.TrackWhereInput,
    ): Promise<IdentityTrackRow[]> {
        return prisma.track.findMany({
            where: {
                ...identityWhere,
                origin: "FEDERATED",
                removedAt: null,
                dedupPinned: false,
                AND: {
                    OR: [
                        { dedupOfTrackId: null },
                        { dedupOfTrack: { removedAt: { not: null } } },
                    ],
                },
            },
            orderBy: { id: "asc" },
            take: MAX_FEDERATED_DEDUP_CANDIDATES,
            select: TRACK_IDENTITY_SELECT,
        });
    }

    private federatedDedupQueries(
        local: FederationLocalIdentityTrackRow,
    ): Prisma.TrackWhereInput[] {
        const queries: Prisma.TrackWhereInput[] = [];
        if (local.audioHash) queries.push({ audioHash: local.audioHash });
        if (local.recordingMbid) {
            queries.push({ recordingMbid: local.recordingMbid });
        }
        if (local.isrc) queries.push({ isrc: local.isrc });
        const positional = this.positionalFederatedQuery(local);
        if (positional) queries.push(positional);
        return queries;
    }

    private positionalFederatedQuery(
        local: FederationLocalIdentityTrackRow,
    ): Prisma.TrackWhereInput | null {
        if (local.album.location !== "LIBRARY") return null;
        const encodedRgMbid = Buffer.from(local.album.rgMbid).toString(
            "base64url",
        );
        return {
            discNo: local.discNo,
            trackNo: local.trackNo,
            album: {
                location: "FEDERATED",
                OR: [
                    { rgMbid: local.album.rgMbid },
                    {
                        AND: [
                            { rgMbid: { startsWith: "federation:" } },
                            { rgMbid: { endsWith: `:${encodedRgMbid}` } },
                        ],
                    },
                ],
            },
        };
    }

    private async loadFederatedDedupCandidates(
        local: FederationLocalIdentityTrackRow,
    ): Promise<IdentityTrackRow[]> {
        const queries = this.federatedDedupQueries(local);
        const candidatesById = new Map<string, IdentityTrackRow>();
        for (let index = 0; index < MAX_FEDERATED_DEDUP_TIERS; index += 1) {
            const query = queries[index];
            if (!query) break;
            const candidates = await this.loadFederatedCandidates(query);
            for (
                let candidateIndex = 0;
                candidateIndex < MAX_FEDERATED_DEDUP_CANDIDATES &&
                candidateIndex < candidates.length;
                candidateIndex += 1
            ) {
                const candidate = candidates[candidateIndex];
                candidatesById.set(candidate.id, candidate);
            }
        }
        return [...candidatesById.values()];
    }

    private async reconcileFederatedDuplicates(
        newTrackPaths: string[],
    ): Promise<void> {
        const tracks = await processBatched(
            newTrackPaths,
            TRACK_PATH_QUERY_BATCH_SIZE,
            (batch) =>
                prisma.track.findMany({
                    where: {
                        filePath: { in: batch },
                        origin: "LOCAL",
                        removedAt: null,
                    },
                    orderBy: { id: "asc" },
                    select: FEDERATION_RECONCILIATION_TRACK_SELECT,
                }),
        );
        for (let index = 0; index < tracks.length; index += 1) {
            await this.reconcileFederatedTrack(tracks[index]);
        }
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

    private loadDiscoveryDownloadIdentities(): Promise<
        DiscoveryDownloadIdentity[]
    > {
        if (this.discoveryDownloadIdentities) {
            return this.discoveryDownloadIdentities;
        }
        let identities: Promise<DiscoveryDownloadIdentity[]>;
        identities = prisma.downloadJob
            .findMany({
                where: {
                    discoveryBatchId: { not: null },
                    status: { in: ["pending", "processing", "completed"] },
                },
                select: DISCOVERY_DOWNLOAD_SELECT,
            })
            .catch((error: unknown) => {
                if (this.discoveryDownloadIdentities === identities) {
                    this.discoveryDownloadIdentities = undefined;
                }
                throw error;
            });
        this.discoveryDownloadIdentities = identities;
        return identities;
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

        const discoveryJobs = await this.loadDiscoveryDownloadIdentities();

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
                logger.debug(`[Scanner]   Job: "${jobArtist}" - "${jobAlbum}"`);
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

            if (jobAlbum === normalizedAlbum && normalizedAlbum.length > 3) {
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
        const discoveryAlbumByTitle = await prisma.discoveryAlbum.findFirst({
            where: {
                albumTitle: { equals: albumTitle, mode: "insensitive" },
                status: { in: ["ACTIVE", "LIKED"] },
            },
        });

        if (discoveryAlbumByTitle) {
            logger.debug(
                `[Scanner] DiscoveryAlbum match (by title): ${discoveryAlbumByTitle.id}`,
            );
            return true;
        }

        // Pass 5: Check if artist name matches any discovery album
        // This catches cases where Lidarr downloads a different album than requested
        // e.g., requested "Broods - Broods" but got "Broods - Evergreen"
        const discoveryAlbumByArtist = await prisma.discoveryAlbum.findFirst({
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
     * Imports one audio file. Persistence and loudness decisions remain in
     * persistScannedTrack to keep this metadata workflow cohesive.
     */
    private async processAudioFile(
        absolutePath: string,
        relativePath: string,
        musicPath: string,
        computeHash = true,
        existingAudioHash: string | null = null,
        previousAlbumId: string | null = null,
        previousDuration: number | null = null,
        contentChangeDetected = false,
        revival = false,
        albumPromotions: Map<string, Promise<void>> = new Map(),
    ): Promise<void> {
        let metadata = await parseFile(absolutePath, { skipCovers: true });
        if (!metadata.format.duration) {
            metadata = await parseFullFileDuration(absolutePath);
        }
        const stats = await fs.promises.stat(absolutePath);

        const title =
            metadata.common.title ||
            path.basename(relativePath, path.extname(relativePath));
        const trackNo = metadata.common.track.no || 0;
        const discNo = metadata.common.disk?.no || 1;
        const duration = Math.floor(metadata.format.duration || 0);
        const mime = deriveAudioFormatLabel(metadata.format, relativePath);
        const { recordingMbid, isrc } = extractTrackIdentityTags(metadata);

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

        const artistMbid = metadata.common.musicbrainz_artistid?.[0];
        const artistResolution = await resolveScannerArtist({
            artistMbid,
            artistName,
            extractedPrimaryArtist,
            rawArtistName,
        });
        let artist = artistResolution.artist;
        artistName = artistResolution.artistName;

        // Exact normalized-name matches may safely adopt better capitalization.
        if (
            artistResolution.matchKind === "exact" &&
            artist.name !== artistName
        ) {
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

        const albumResolutionKey = albumMbid
            ? `mbid:${albumMbid}`
            : `title:${artist.id}:${albumTitle}`;
        const albumResolution = await this.resolveOnce(
            this.albumResolutions,
            albumResolutionKey,
            () =>
                resolveScannerAlbum({
                    albumMbid,
                    albumPromotions,
                    albumTitle,
                    artistId: artist.id,
                    isDiscoveryAlbum,
                    year,
                }),
        );
        let album = albumResolution.album;

        if (albumResolution.wasMissing) {
            // Extract cover art if we have an extractor
            // Re-extract if: no cover, OR native cover file is missing
            if (this.coverArtExtractor) {
                let needsExtraction = !album.coverUrl;

                if (album.coverUrl?.startsWith("native:")) {
                    const nativePath = album.coverUrl.replace("native:", "");
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
                        // No embedded art, use the canonical provider ladder.
                        try {
                            const resolution = await resolveAlbumCover({
                                artistName,
                                albumTitle,
                                rgMbid: albumMbid,
                            });
                            if (resolution) {
                                await prisma.album.update({
                                    where: { id: album.id },
                                    data: { coverUrl: resolution.url },
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
            }
            await this.promoteNativeAlbumOnce(
                { ...album, artistId: artist.id },
                albumPromotions,
            );
            album = { ...album, location: "LIBRARY" };
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
                origin: "LOCAL",
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

        await persistScannedTrack(
            trackUpsert,
            album.id,
            duration,
            {
                contentChangeDetected,
                storedAudioHash: existingAudioHash,
                computedAudioHash,
                previousAlbumId,
                previousDuration,
                revival,
            },
            (trackId) => this.clearTrackHealthIssue(trackId),
            () => this.touchedArtistIds.add(artist.id),
        );
    }
}
