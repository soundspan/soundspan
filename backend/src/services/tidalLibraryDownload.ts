/** TIDAL album search, sidecar download orchestration, and library scanning. */

import { logger } from "../utils/logger";
import {
    type LibraryAlbumDownloadOptions,
    type LibraryDownloadProcessorConfig,
    runLibraryAlbumDownload,
} from "./libraryDownloadProcessor";
import { patchDownloadJobMetadata } from "./downloadJobStatus";
import { tidalService, type TidalAlbumDownloadResult } from "./tidal";

type TidalAlbumMatch = NonNullable<
    Awaited<ReturnType<typeof tidalService.findAlbum>>
>;

/** Controls hand-off behavior when this processor is itself a fallback. */
export type TidalLibraryDownloadOptions = LibraryAlbumDownloadOptions;

function completedStatusText(result: TidalAlbumDownloadResult): string {
    return result.failed > 0
        ? `${result.downloaded}/${result.total_tracks} tracks (${result.failed} failed)`
        : `${result.downloaded} tracks`;
}

const tidalLibraryDownloadConfig = {
    sourceKey: "tidal",
    sourceLabel: "TIDAL",
    searchingStatusText: "Searching TIDAL...",
    failedError: "TIDAL download failed",
    failedStatusText: "TIDAL failed",
    findMatch: (artistName, albumTitle) =>
        tidalService.findAlbum(artistName, albumTitle),
    download: async (match, { jobId }) => {
        logger.debug(
            `[TIDAL] Found album: "${match.title}" by ${match.artist} (ID: ${match.albumId}, ${match.numberOfTracks} tracks)`,
        );
        await patchDownloadJobMetadata(jobId, {
            currentSource: "tidal",
            statusText: `Downloading ${match.numberOfTracks} tracks...`,
            tidalAlbumId: match.albumId,
        });
        const result = await tidalService.downloadAlbum(match.albumId);
        logger.debug(
            `[TIDAL] Download complete: ${result.downloaded}/${result.total_tracks} tracks`,
        );
        if (result.downloaded === 0) {
            throw new Error(
                `All ${result.total_tracks} tracks failed to download`,
            );
        }
        return result;
    },
    resultSummary: (match, result) => ({
        statusText: `TIDAL ✓ ${completedStatusText(result)}`,
        metadata: {
            tidalAlbumId: match.albumId,
            tidalResult: {
                downloaded: result.downloaded,
                failed: result.failed,
                totalTracks: result.total_tracks,
            },
        },
    }),
    fallbackPeer: {
        sourceKey: "youtube",
        run: async (jobId, artistName, albumTitle, userId, options) => {
            const { processYoutubeDownload } =
                await import("./youtubeLibraryDownload");
            await processYoutubeDownload(
                jobId,
                artistName,
                albumTitle,
                userId,
                options,
            );
        },
    },
    logFallbackSelection: true,
    prefixManagerFailureLog: false,
    scanSource: "tidal-download",
    onScanQueued: (result) => {
        logger.debug(
            `[TIDAL] Scan queued for: ${result.artist} - ${result.album_title}`,
        );
    },
} satisfies LibraryDownloadProcessorConfig<
    TidalAlbumMatch,
    TidalAlbumDownloadResult
>;

/** Process one library album through TIDAL search and download. */
export async function processTidalDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    options: TidalLibraryDownloadOptions = {},
): Promise<void> {
    await runLibraryAlbumDownload(
        tidalLibraryDownloadConfig,
        jobId,
        artistName,
        albumTitle,
        userId,
        options,
    );
}
