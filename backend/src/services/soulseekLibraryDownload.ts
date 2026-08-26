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
import { classifyDownloadCompleteness } from "./albumDownloadCompleteness";

const logger = rootLogger.child("SoulseekLibraryDownload");
const SOULSEEK_DOWNLOAD_FAILED = "Soulseek download failed";

interface AlbumTrack {
    title: string;
    position?: number;
}

interface SoulseekBatchOutcome {
    success: boolean;
    partial: boolean;
    failureMessage: string | undefined;
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

function expectedTracksFrom(metadata: unknown): number | null {
    const expectedTracks = asPlainObject(metadata).expectedTracks;
    return typeof expectedTracks === "number" &&
        Number.isSafeInteger(expectedTracks) &&
        expectedTracks > 0
        ? expectedTracks
        : null;
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
    artistName: string,
    albumTitle: string,
    requestedTracks: AlbumTrack[] | null,
    musicBrainzTracks: AlbumTrack[] | null,
): Promise<AlbumTrack[]> {
    if (requestedTracks) return requestedTracks;
    if (musicBrainzTracks) return musicBrainzTracks;
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

async function resolveExpectedTrackCount(
    jobId: string,
    albumMbid: string,
): Promise<number | null> {
    let expectedTracks: number;
    try {
        expectedTracks =
            await musicBrainzService.getExpectedTrackCount(albumMbid);
    } catch (error) {
        logger.warn("Album completeness verification skipped", {
            jobId,
            source: "soulseek",
            albumMbid,
            reason: "MusicBrainz expected-count lookup failed",
            error,
        });
        return null;
    }
    if (!Number.isSafeInteger(expectedTracks) || expectedTracks <= 0) {
        logger.warn("Album completeness verification skipped", {
            jobId,
            source: "soulseek",
            albumMbid,
            reason: "MusicBrainz returned no expected track count",
        });
        return null;
    }
    await patchDownloadJobMetadata(jobId, {
        expectedTracks,
    });
    return expectedTracks;
}

async function resolveMusicBrainzTracks(
    albumMbid: string,
): Promise<AlbumTrack[] | null> {
    try {
        const tracks = await musicBrainzService.getAlbumTracks(albumMbid);
        return tracks.length > 0 ? tracks : null;
    } catch (error) {
        logger.warn("MusicBrainz track-list lookup failed", { error });
        return null;
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
    expectedTracks: number | null,
): Promise<SoulseekAlbumDownloadResult> {
    const outcome = classifyBatchOutcome(successful, total, expectedTracks);
    await patchDownloadJobMetadata(
        jobId,
        (current) =>
            batchOutcomeMetadata(
                current,
                successful,
                total,
                expectedTracks,
                outcome,
            ),
        {
            status: outcome.success ? "completed" : "failed",
            error: outcome.failureMessage ?? null,
            completedAt: new Date(),
        },
    );
    if (outcome.partial) {
        logger.warn("Album download is incomplete", {
            jobId,
            source: "soulseek",
            downloadedTracks: successful,
            expectedTracks,
        });
    }
    return {
        success: outcome.success,
        source: "soulseek",
        downloadJobId: Number.parseInt(jobId, 10),
        tracksDownloaded: successful,
        tracksTotal: total,
        error: outcome.failureMessage,
    };
}

function classifyBatchOutcome(
    successful: number,
    total: number,
    expectedTracks: number | null,
): SoulseekBatchOutcome {
    const partial =
        classifyDownloadCompleteness(successful, expectedTracks) === "partial";
    const success = !partial && successful >= Math.ceil(total * 0.5);
    const failureMessage = partial
        ? `Partial download: ${successful}/${expectedTracks} tracks`
        : success
          ? undefined
          : `Only ${successful}/${total} tracks found`;
    return { success, partial, failureMessage };
}

function batchOutcomeMetadata(
    current: Record<string, unknown>,
    successful: number,
    total: number,
    expectedTracks: number | null,
    outcome: SoulseekBatchOutcome,
): Record<string, unknown> {
    const { failedAt: _failedAt, partial: _partial, ...retained } = current;
    const base = {
        ...retained,
        tracksDownloaded: successful,
        tracksTotal: total,
        ...(expectedTracks === null ? {} : { expectedTracks }),
    };
    if (!outcome.partial) return base;
    return {
        ...base,
        currentSource: "soulseek",
        statusText: outcome.failureMessage,
        partial: true,
        failedAt: new Date().toISOString(),
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
    const requestedTracks = requestedTracksFrom(metadata);
    const persistedExpectedTracks = expectedTracksFrom(metadata);
    const expectedTracks =
        persistedExpectedTracks ??
        (await resolveExpectedTrackCount(jobId, albumMbid));
    const musicBrainzTracks = requestedTracks
        ? null
        : await resolveMusicBrainzTracks(albumMbid);
    const tracks = await resolveAlbumTracks(
        artistName,
        albumTitle,
        requestedTracks,
        musicBrainzTracks,
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
        expectedTracks ?? tracks.length,
    );
    if (result.successful > 0) {
        return persistBatchOutcome(
            jobId,
            result.successful,
            tracks.length,
            expectedTracks,
        );
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
