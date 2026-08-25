/** Soulseek album track-list resolution, batch download, and job persistence. */

import { prisma } from "../utils/db";
import { logger as rootLogger } from "../utils/logger";
import { asPlainObject } from "../utils/plainObject";
import { getSystemSettings } from "../utils/systemSettings";
import {
    failDownloadJob,
    patchDownloadJobMetadata,
    patchDownloadJobMetadataFrom,
} from "./downloadJobStatus";
import { lastFmService } from "./lastfm";
import { musicBrainzService } from "./musicbrainz";
import { soulseekService } from "./soulseek";

const logger = rootLogger.child("SoulseekLibraryDownload");
const SOULSEEK_DOWNLOAD_FAILED = "Soulseek download failed";

interface AlbumTrack {
    title: string;
    position?: number;
}

/** Result returned to compatibility acquisition callers. */
export interface SoulseekAlbumDownloadResult {
    success: boolean;
    source?: "soulseek";
    downloadJobId?: number;
    error?: string;
    tracksDownloaded?: number;
    tracksTotal?: number;
}

function requestedTracksFrom(metadata: unknown): AlbumTrack[] | null {
    const requestedTracks = asPlainObject(metadata).requestedTracks;
    if (!Array.isArray(requestedTracks) || requestedTracks.length === 0) {
        return null;
    }
    const tracks = requestedTracks.filter(
        (track): track is AlbumTrack =>
            typeof track === "object" &&
            track !== null &&
            typeof (track as Record<string, unknown>).title === "string",
    );
    return tracks.length === requestedTracks.length ? tracks : null;
}

async function lastFmTracks(
    artistName: string,
    albumTitle: string,
): Promise<AlbumTrack[]> {
    const albumInfo = await lastFmService.getAlbumInfo(artistName, albumTitle);
    const tracks = albumInfo?.tracks?.track;
    if (!Array.isArray(tracks)) return [];
    return tracks
        .map(asLastFmTrack)
        .filter((track): track is AlbumTrack => track !== null);
}

function asLastFmTrack(value: unknown): AlbumTrack | null {
    const track = asPlainObject(value);
    const title =
        typeof track.name === "string"
            ? track.name
            : typeof track.title === "string"
              ? track.title
              : null;
    if (!title) return null;
    const rank = asPlainObject(track["@attr"]).rank;
    return {
        title,
        position:
            typeof rank === "string" ? Number.parseInt(rank, 10) : undefined,
    };
}

async function resolveAlbumTracks(
    albumMbid: string,
    artistName: string,
    albumTitle: string,
    requestedTracks: AlbumTrack[] | null,
): Promise<AlbumTrack[]> {
    if (requestedTracks) return requestedTracks;
    const musicBrainzTracks =
        await musicBrainzService.getAlbumTracks(albumMbid);
    if (musicBrainzTracks.length > 0) return musicBrainzTracks;
    logger.debug("MusicBrainz has no tracks; trying Last.fm", {
        artistName,
        albumTitle,
    });
    try {
        return await lastFmTracks(artistName, albumTitle);
    } catch (error) {
        logger.warn("Last.fm track-list fallback failed", { error });
        return [];
    }
}

async function markFailed(
    jobId: string,
    failureMessage: string,
    result: SoulseekAlbumDownloadResult = {
        success: false,
        error: failureMessage,
    },
): Promise<SoulseekAlbumDownloadResult> {
    await failDownloadJob(jobId, failureMessage);
    return result;
}

async function updateAttempt(jobId: string, metadata: unknown): Promise<void> {
    const current = asPlainObject(metadata);
    const soulseekAttempts =
        (typeof current.soulseekAttempts === "number"
            ? current.soulseekAttempts
            : 0) + 1;
    await patchDownloadJobMetadataFrom(current, jobId, {
        currentSource: "soulseek",
        lidarrAttempts:
            typeof current.lidarrAttempts === "number"
                ? current.lidarrAttempts
                : 0,
        soulseekAttempts,
        statusText: `Soulseek #${soulseekAttempts}`,
    });
}

async function persistBatchOutcome(
    jobId: string,
    successful: number,
    total: number,
): Promise<SoulseekAlbumDownloadResult> {
    const success = successful >= Math.ceil(total * 0.5);
    const failureMessage = success
        ? undefined
        : `Only ${successful}/${total} tracks found`;
    await patchDownloadJobMetadata(
        jobId,
        { tracksDownloaded: successful, tracksTotal: total },
        {
            status: success ? "completed" : "failed",
            error: failureMessage ?? null,
            completedAt: new Date(),
        },
    );
    return {
        success,
        source: "soulseek",
        downloadJobId: Number.parseInt(jobId, 10),
        tracksDownloaded: successful,
        tracksTotal: total,
        error: failureMessage,
    };
}

async function persistUnexpectedFailure(
    jobId: string,
    error: unknown,
): Promise<SoulseekAlbumDownloadResult> {
    logger.error("Soulseek album download failed", { jobId, error });
    await failDownloadJob(jobId, SOULSEEK_DOWNLOAD_FAILED).catch(
        (persistenceError) => {
            logger.error("Failed to persist Soulseek download failure", {
                jobId,
                error: persistenceError,
            });
        },
    );
    return { success: false, error: SOULSEEK_DOWNLOAD_FAILED };
}

async function runSoulseekDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    albumMbid: string,
    metadata: unknown,
    musicPath: string,
    concurrency: number,
): Promise<SoulseekAlbumDownloadResult> {
    await updateAttempt(jobId, metadata);
    const tracks = await resolveAlbumTracks(
        albumMbid,
        artistName,
        albumTitle,
        requestedTracksFrom(metadata),
    );
    if (tracks.length === 0) {
        return markFailed(
            jobId,
            "Could not get track list from MusicBrainz or Last.fm",
        );
    }
    const result = await soulseekService.searchAndDownloadBatch(
        tracks.map((track) => ({
            artist: artistName,
            title: track.title,
            album: albumTitle,
        })),
        musicPath,
        concurrency,
    );
    if (result.successful > 0) {
        return persistBatchOutcome(jobId, result.successful, tracks.length);
    }
    const failureMessage = `No tracks found on Soulseek (searched ${tracks.length} tracks)`;
    return markFailed(jobId, failureMessage, {
        success: false,
        downloadJobId: Number.parseInt(jobId, 10),
        tracksTotal: tracks.length,
        error: failureMessage,
    });
}

/** Process one existing library album job through Soulseek. */
export async function processSoulseekDownload(
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
): Promise<SoulseekAlbumDownloadResult> {
    void userId;
    const job = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { targetMbid: true, metadata: true },
    });
    if (!job) return { success: false, error: "Download job not found" };

    try {
        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            return markFailed(jobId, "Music path not configured");
        }
        if (!job.targetMbid) {
            return markFailed(
                jobId,
                "Album MBID required for Soulseek download",
            );
        }
        return await runSoulseekDownload(
            jobId,
            artistName,
            albumTitle,
            job.targetMbid,
            job.metadata,
            settings.musicPath,
            settings.soulseekConcurrentDownloads || 4,
        );
    } catch (error) {
        return persistUnexpectedFailure(jobId, error);
    }
}
