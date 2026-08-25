/** YouTube Music album search, sidecar job orchestration, and library scanning. */

import {
    type LibraryDownloadProcessorConfig,
    runLibraryAlbumDownload,
} from "./libraryDownloadProcessor";
import { patchDownloadJobMetadata } from "./downloadJobStatus";
import { normalizeForExactKey } from "../utils/artistNormalization";
import {
    type YtAlbumDownloadJobStatus,
    watchYouTubeDownloadJobUntilTerminal,
    youtubeDownloadService,
} from "./youtubeDownload";

interface AlbumSearchCandidate {
    browseId: string;
    title: string;
    artists: string[];
}

/** Controls hand-off behavior when this processor is itself a fallback. */
export interface YoutubeLibraryDownloadOptions {
    isFallback?: boolean;
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

function selectAlbumBrowseId(
    candidates: AlbumSearchCandidate[],
    artistName: string,
    albumTitle: string,
): string | null {
    const normalizedTitle = normalizeForExactKey(albumTitle);
    const normalizedArtist = normalizeForExactKey(artistName);
    const exactMatch = candidates.find(
        (candidate) =>
            normalizeForExactKey(candidate.title) === normalizedTitle &&
            candidate.artists.some(
                (artist) => normalizeForExactKey(artist) === normalizedArtist,
            ),
    );
    const titleMatch = candidates.find(
        (candidate) =>
            normalizeForExactKey(candidate.title) === normalizedTitle,
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

async function updateProgress(
    jobId: string,
    sidecarJobId: string,
    progressPct: number,
): Promise<void> {
    await patchDownloadJobMetadata(jobId, {
        currentSource: "youtube",
        statusText: `YouTube Music ${progressPct}%`,
        youtubeAlbumJobId: sidecarJobId,
    });
}

async function startAndWatchAlbum(
    jobId: string,
    browseId: string,
): Promise<YtAlbumDownloadJobStatus> {
    const started = await youtubeDownloadService.startAlbumDownload(browseId);
    await patchDownloadJobMetadata(jobId, {
        currentSource: "youtube",
        statusText: "Downloading from YouTube Music...",
        youtubeAlbumJobId: started.jobId,
    });
    let lastProgress: number | null = null;
    const outcome = await watchYouTubeDownloadJobUntilTerminal(
        started.jobId,
        (id) => youtubeDownloadService.getAlbumDownloadJobStatus(id),
        {
            onStatus: async (status) => {
                if (status.progressPct === lastProgress) return;
                lastProgress = status.progressPct;
                await updateProgress(jobId, started.jobId, status.progressPct);
            },
        },
    );
    if (outcome !== "completed") {
        throw new Error(`YouTube Music sidecar job ended with ${outcome}`);
    }
    return youtubeDownloadService.getAlbumDownloadJobStatus(started.jobId);
}

const youtubeLibraryDownloadConfig = {
    sourceKey: "youtube",
    sourceLabel: "YouTube Music",
    searchingStatusText: "Searching YouTube Music...",
    failedError: "YouTube download failed",
    failedStatusText: "YouTube Music failed",
    findMatch: findAlbumBrowseId,
    download: async (browseId, { jobId }) => {
        const result = await startAndWatchAlbum(jobId, browseId);
        if (result.downloaded === 0) {
            throw new Error(
                `All ${result.totalTracks} tracks failed to download`,
            );
        }
        return result;
    },
    resultSummary: (_browseId, result) => ({
        statusText: `YouTube Music ✓ ${result.downloaded}/${result.totalTracks} tracks`,
        metadata: {
            youtubeAlbumJobId: result.jobId,
            youtubeResult: {
                downloaded: result.downloaded,
                failed: result.failed,
                totalTracks: result.totalTracks,
            },
        },
    }),
    fallbackPeer: {
        sourceKey: "tidal",
        run: async (jobId, artistName, albumTitle, userId, options) => {
            const { processTidalDownload } =
                await import("./tidalLibraryDownload");
            await processTidalDownload(
                jobId,
                artistName,
                albumTitle,
                userId,
                options,
            );
        },
    },
    fallbackOrder: "peer-first",
    logFallbackSelection: false,
    prefixManagerFailureLog: true,
    scanSource: "youtube-download",
} satisfies LibraryDownloadProcessorConfig<string, YtAlbumDownloadJobStatus>;

/** Process a library album through public YouTube Music search and download. */
export async function processYoutubeDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    options: YoutubeLibraryDownloadOptions = {},
): Promise<void> {
    await runLibraryAlbumDownload(
        youtubeLibraryDownloadConfig,
        jobId,
        artistName,
        albumTitle,
        userId,
        options,
    );
}
