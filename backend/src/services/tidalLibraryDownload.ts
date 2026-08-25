/** TIDAL album search, sidecar download orchestration, and library scanning. */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { tidalService, type TidalAlbumDownloadResult } from "./tidal";
import { requestCoalescedLibraryScan } from "./coalescedLibraryScan";
import { asPlainObject } from "../utils/plainObject";

type DownloadMetadata = Record<string, unknown>;
type TidalAlbumMatch = NonNullable<
    Awaited<ReturnType<typeof tidalService.findAlbum>>
>;

/** Controls hand-off behavior when this processor is itself a fallback. */
export interface TidalLibraryDownloadOptions {
    isFallback?: boolean;
}

function asMetadata(value: unknown): DownloadMetadata {
    return asPlainObject(value);
}

function withoutFailedAt(metadata: DownloadMetadata): DownloadMetadata {
    const { failedAt: _failedAt, ...retainedMetadata } = metadata;
    return retainedMetadata;
}

async function markSearching(
    jobId: string,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            status: "processing",
            error: null,
            metadata: {
                ...metadata,
                currentSource: "tidal",
                statusText: "Searching TIDAL...",
            },
        },
    });
}

async function markSearchMissHandOff(
    jobId: string,
    fallback: string,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            metadata: {
                ...metadata,
                currentSource: fallback,
                statusText: `TIDAL not found → ${fallback}`,
            },
        },
    });
}

async function handOffToDownloadManager(
    fallback: "lidarr" | "soulseek",
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    metadata: DownloadMetadata,
): Promise<void> {
    const result = await simpleDownloadManager.startDownload(
        jobId,
        artistName,
        albumTitle,
        typeof metadata.albumMbid === "string" ? metadata.albumMbid : "",
        userId,
    );
    if (!result.success) {
        logger.error(`Fallback ${fallback} failed: ${result.error}`);
    }
}

async function handOffSearchMiss(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    metadata: DownloadMetadata,
    isFallback: boolean,
): Promise<boolean> {
    const settings = await getSystemSettings();
    const fallback = settings?.primaryFailureFallback;
    const isManagerFallback = fallback === "lidarr" || fallback === "soulseek";
    if (!isManagerFallback && (fallback !== "youtube" || isFallback)) {
        return false;
    }
    logger.debug(`[TIDAL] Album not found, falling back to ${fallback}`);
    await markSearchMissHandOff(jobId, fallback, metadata);
    if (isManagerFallback) {
        await handOffToDownloadManager(
            fallback,
            jobId,
            artistName,
            albumTitle,
            userId,
            metadata,
        );
        return true;
    }
    const { processYoutubeDownload } = await import("./youtubeLibraryDownload");
    await processYoutubeDownload(jobId, artistName, albumTitle, userId, {
        isFallback: true,
    });
    return true;
}

async function markDownloading(
    jobId: string,
    match: TidalAlbumMatch,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            metadata: {
                ...metadata,
                currentSource: "tidal",
                statusText: `Downloading ${match.numberOfTracks} tracks...`,
                tidalAlbumId: match.albumId,
            },
        },
    });
}

async function downloadAlbum(
    match: TidalAlbumMatch,
): Promise<TidalAlbumDownloadResult> {
    const result = await tidalService.downloadAlbum(match.albumId);
    logger.debug(
        `[TIDAL] Download complete: ${result.downloaded}/${result.total_tracks} tracks`,
    );
    if (result.downloaded === 0) {
        throw new Error(`All ${result.total_tracks} tracks failed to download`);
    }
    return result;
}

function completedStatusText(result: TidalAlbumDownloadResult): string {
    return result.failed > 0
        ? `${result.downloaded}/${result.total_tracks} tracks (${result.failed} failed)`
        : `${result.downloaded} tracks`;
}

async function completeTidalJob(
    jobId: string,
    match: TidalAlbumMatch,
    result: TidalAlbumDownloadResult,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            status: "completed",
            completedAt: new Date(),
            error: null,
            metadata: {
                ...withoutFailedAt(metadata),
                currentSource: "tidal",
                statusText: `TIDAL ✓ ${completedStatusText(result)}`,
                tidalAlbumId: match.albumId,
                tidalResult: {
                    downloaded: result.downloaded,
                    failed: result.failed,
                    totalTracks: result.total_tracks,
                },
            },
        },
    });
}

async function queueLibraryScan(
    userId: string,
    result: TidalAlbumDownloadResult,
): Promise<void> {
    await requestCoalescedLibraryScan(userId, "tidal-download");
    logger.debug(
        `[TIDAL] Scan queued for: ${result.artist} - ${result.album_title}`,
    );
}

async function queueLibraryScanSafely(
    jobId: string,
    userId: string,
    result: TidalAlbumDownloadResult,
): Promise<void> {
    try {
        await queueLibraryScan(userId, result);
    } catch (error) {
        logger.warn(
            "TIDAL library scan enqueue failed; download remains completed",
            { jobId, error },
        );
    }
}

async function failTidalJob(
    jobId: string,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            status: "failed",
            error: "TIDAL download failed",
            completedAt: new Date(),
            metadata: {
                ...metadata,
                currentSource: "tidal",
                statusText: "TIDAL failed",
                failedAt: new Date().toISOString(),
            },
        },
    });
}

/** Process one library album through TIDAL search and download. */
export async function processTidalDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    options: TidalLibraryDownloadOptions = {},
): Promise<void> {
    const existingJob = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
    });
    const metadata = asMetadata(existingJob?.metadata);
    let completedResult: TidalAlbumDownloadResult;
    try {
        await markSearching(jobId, metadata);
        const match = await tidalService.findAlbum(artistName, albumTitle);
        if (!match) {
            const handedOff = await handOffSearchMiss(
                jobId,
                artistName,
                albumTitle,
                userId,
                metadata,
                options.isFallback === true,
            );
            if (handedOff) return;
            throw new Error(
                `Album not found on TIDAL: ${artistName} - ${albumTitle}`,
            );
        }
        logger.debug(
            `[TIDAL] Found album: "${match.title}" by ${match.artist} (ID: ${match.albumId}, ${match.numberOfTracks} tracks)`,
        );
        await markDownloading(jobId, match, metadata);
        const result = await downloadAlbum(match);
        await completeTidalJob(jobId, match, result, metadata);
        completedResult = result;
    } catch (error: unknown) {
        logger.error(
            `[TIDAL] Download failed for job ${jobId}:`,
            error instanceof Error ? error.message : error,
        );
        await failTidalJob(jobId, metadata);
        return;
    }
    await queueLibraryScanSafely(jobId, userId, completedResult);
}
