/** YouTube Music album search, sidecar job orchestration, and library scanning. */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { simpleDownloadManager } from "./simpleDownloadManager";
import {
    type YtAlbumDownloadJobStatus,
    watchYouTubeDownloadJobUntilTerminal,
    youtubeDownloadService,
} from "./youtubeDownload";

type DownloadMetadata = Record<string, unknown>;

interface AlbumSearchCandidate {
    browseId: string;
    title: string;
    artists: string[];
}

/** Controls hand-off behavior when this processor is itself a fallback. */
export interface YoutubeLibraryDownloadOptions {
    isFallback?: boolean;
}

function asMetadata(value: unknown): DownloadMetadata {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as DownloadMetadata)
        : {};
}

function withoutFailedAt(metadata: DownloadMetadata): DownloadMetadata {
    const { failedAt: _failedAt, ...retainedMetadata } = metadata;
    return retainedMetadata;
}

function asAlbumSearchCandidate(value: unknown): AlbumSearchCandidate | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.browseId !== "string" || !candidate.browseId) {
        return null;
    }
    return {
        browseId: candidate.browseId,
        title: typeof candidate.title === "string" ? candidate.title : "",
        artists: Array.isArray(candidate.artists)
            ? candidate.artists.filter(
                  (artist): artist is string => typeof artist === "string",
              )
            : [],
    };
}

function normalizeMatchText(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function selectAlbumBrowseId(
    candidates: AlbumSearchCandidate[],
    artistName: string,
    albumTitle: string,
): string | null {
    const normalizedTitle = normalizeMatchText(albumTitle);
    const normalizedArtist = normalizeMatchText(artistName);
    const exactMatch = candidates.find(
        (candidate) =>
            normalizeMatchText(candidate.title) === normalizedTitle &&
            candidate.artists.some(
                (artist) => normalizeMatchText(artist) === normalizedArtist,
            ),
    );
    const titleMatch = candidates.find(
        (candidate) => normalizeMatchText(candidate.title) === normalizedTitle,
    );
    return (
        exactMatch?.browseId ??
        titleMatch?.browseId ??
        candidates[0]?.browseId ??
        null
    );
}

/** Find the best public album-search result using TIDAL-compatible matching. */
export async function findAlbumBrowseId(
    artistName: string,
    albumTitle: string,
): Promise<string | null> {
    const result = await youtubeDownloadService.searchAlbums(
        `${artistName} ${albumTitle}`,
    );
    if (!Array.isArray(result)) return null;
    const candidates = result
        .map(asAlbumSearchCandidate)
        .filter(
            (candidate): candidate is AlbumSearchCandidate =>
                candidate !== null,
        );
    return selectAlbumBrowseId(candidates, artistName, albumTitle);
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
                currentSource: "youtube",
                statusText: "Searching YouTube Music...",
            },
        },
    });
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
    if (!isManagerFallback && (fallback !== "tidal" || isFallback)) {
        return false;
    }
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            metadata: {
                ...metadata,
                currentSource: fallback,
                statusText: `YouTube Music not found → ${fallback}`,
            },
        },
    });
    if (fallback === "tidal") {
        const { processTidalDownload } = await import("./tidalLibraryDownload");
        await processTidalDownload(jobId, artistName, albumTitle, userId, {
            isFallback: true,
        });
        return true;
    }
    const result = await simpleDownloadManager.startDownload(
        jobId,
        artistName,
        albumTitle,
        typeof metadata.albumMbid === "string" ? metadata.albumMbid : "",
        userId,
    );
    if (!result.success) {
        logger.error(
            `[YouTube Music] Fallback ${fallback} failed: ${result.error}`,
        );
    }
    return true;
}

async function updateProgress(
    jobId: string,
    sidecarJobId: string,
    progressPct: number,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            metadata: {
                ...metadata,
                currentSource: "youtube",
                statusText: `YouTube Music ${progressPct}%`,
                youtubeAlbumJobId: sidecarJobId,
            },
        },
    });
}

async function startAndWatchAlbum(
    jobId: string,
    browseId: string,
    metadata: DownloadMetadata,
): Promise<YtAlbumDownloadJobStatus> {
    const started = await youtubeDownloadService.startAlbumDownload(browseId);
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            metadata: {
                ...metadata,
                currentSource: "youtube",
                statusText: "Downloading from YouTube Music...",
                youtubeAlbumJobId: started.jobId,
            },
        },
    });
    let lastProgress: number | null = null;
    const outcome = await watchYouTubeDownloadJobUntilTerminal(
        started.jobId,
        (id) => youtubeDownloadService.getAlbumDownloadJobStatus(id),
        {
            onStatus: async (status) => {
                if (status.progressPct === lastProgress) return;
                lastProgress = status.progressPct;
                await updateProgress(
                    jobId,
                    started.jobId,
                    status.progressPct,
                    metadata,
                );
            },
        },
    );
    if (outcome !== "completed") {
        throw new Error(`YouTube Music sidecar job ended with ${outcome}`);
    }
    return youtubeDownloadService.getAlbumDownloadJobStatus(started.jobId);
}

async function completeYoutubeJob(
    jobId: string,
    result: YtAlbumDownloadJobStatus,
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
                currentSource: "youtube",
                statusText: `YouTube Music ✓ ${result.downloaded}/${result.totalTracks} tracks`,
                youtubeAlbumJobId: result.jobId,
                youtubeResult: {
                    downloaded: result.downloaded,
                    failed: result.failed,
                    totalTracks: result.totalTracks,
                },
            },
        },
    });
}

async function failYoutubeJob(
    jobId: string,
    metadata: DownloadMetadata,
): Promise<void> {
    await prisma.downloadJob.update({
        where: { id: jobId },
        data: {
            status: "failed",
            error: "YouTube download failed",
            completedAt: new Date(),
            metadata: {
                ...metadata,
                currentSource: "youtube",
                statusText: "YouTube Music failed",
                failedAt: new Date().toISOString(),
            },
        },
    });
}

async function queueLibraryScanSafely(
    jobId: string,
    userId: string,
    artistName: string,
    albumTitle: string,
): Promise<void> {
    try {
        const { scanQueue } = await import("../workers/queues");
        await scanQueue.add("scan", {
            userId,
            source: "youtube-download",
            artistName,
            albumTitle,
        });
    } catch (error) {
        logger.warn(
            "YouTube Music library scan enqueue failed; download remains completed",
            { jobId, error },
        );
    }
}

/** Process a library album through public YouTube Music search and download. */
export async function processYoutubeDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    options: YoutubeLibraryDownloadOptions = {},
): Promise<void> {
    const existingJob = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
    });
    const metadata = asMetadata(existingJob?.metadata);
    try {
        await markSearching(jobId, metadata);
        const browseId = await findAlbumBrowseId(artistName, albumTitle);
        if (!browseId) {
            if (
                await handOffSearchMiss(
                    jobId,
                    artistName,
                    albumTitle,
                    userId,
                    metadata,
                    options.isFallback === true,
                )
            )
                return;
            throw new Error(
                `Album not found on YouTube Music: ${artistName} - ${albumTitle}`,
            );
        }
        const result = await startAndWatchAlbum(jobId, browseId, metadata);
        if (result.downloaded === 0) {
            throw new Error(
                `All ${result.totalTracks} tracks failed to download`,
            );
        }
        await completeYoutubeJob(jobId, result, metadata);
    } catch (error: unknown) {
        logger.error(
            `[YouTube Music] Download failed for job ${jobId}:`,
            error instanceof Error ? error.message : error,
        );
        await failYoutubeJob(jobId, metadata);
        return;
    }
    await queueLibraryScanSafely(jobId, userId, artistName, albumTitle);
}
