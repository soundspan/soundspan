import { logger as rootLogger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import {
    type DownloadSource,
    type DownloadSourceAvailability,
    probeDownloadSourceAvailability,
    resolveDownloadSource,
} from "./downloadSourcePolicy";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { processTidalDownload } from "./tidalLibraryDownload";
import { processYoutubeDownload } from "./youtubeLibraryDownload";
import { parseArtistAlbumSubject } from "../utils/downloadSubject";
import { patchDownloadJobMetadataFrom } from "./downloadJobStatus";

const logger = rootLogger.child("DownloadDispatcher");

/** Parameters required to dispatch one existing album download job. */
export interface AlbumDownloadDispatchParams {
    jobId: string;
    type: string;
    mbid: string;
    subject: string;
    artistName?: string;
    artistMbid?: string;
    albumTitle?: string;
}

interface AlbumNames {
    artist: string;
    album: string;
}

function parseAlbumNames({
    subject,
    artistName,
    albumTitle,
}: Pick<
    AlbumDownloadDispatchParams,
    "subject" | "artistName" | "albumTitle"
>): AlbumNames {
    if (artistName && albumTitle) {
        return { artist: artistName, album: albumTitle };
    }
    return parseArtistAlbumSubject(subject);
}

async function failJobWithoutDispatch(
    jobId: string,
    jobMetadata: unknown,
    source: string,
    message: string,
    statusText: string,
): Promise<void> {
    logger.error(`${message} — job ${jobId} not dispatched`);

    await patchDownloadJobMetadataFrom(
        jobMetadata,
        jobId,
        {
            currentSource: source,
            statusText,
            failedAt: new Date().toISOString(),
        },
        {
            status: "failed",
            error: message,
            completedAt: new Date(),
        },
    );
}

async function dispatchResolvedSource(
    source: DownloadSource,
    availability: DownloadSourceAvailability,
    params: AlbumDownloadDispatchParams,
    names: AlbumNames,
    userId: string,
): Promise<void> {
    if (source === "tidal" && availability.tidal) {
        await processTidalDownload(
            params.jobId,
            names.artist,
            names.album,
            userId,
        );
        return;
    }
    if (source === "youtube" && availability.youtube) {
        await processYoutubeDownload(
            params.jobId,
            names.artist,
            names.album,
            userId,
        );
        return;
    }

    // Non-TIDAL dispatch goes through simpleDownloadManager, which is
    // Lidarr-backed — there is no per-source dispatch below this point, so a
    // "soulseek" selection is executed by the Lidarr manager (pre-existing
    // pipeline limitation).
    const managerParams = [
        params.jobId,
        names.artist,
        names.album,
        params.mbid,
        userId,
    ] as const;
    const result = params.artistMbid
        ? await simpleDownloadManager.startDownload(
              ...managerParams,
              false,
              params.artistMbid,
          )
        : await simpleDownloadManager.startDownload(...managerParams);
    if (!result.success) {
        logger.error(`Failed to start download: ${result.error}`);
    }
}

/**
 * Dispatch an existing album download job through the configured source and
 * fallback policy. Missing jobs and non-album types are left undispatched.
 */
export async function dispatchAlbumDownload(
    params: AlbumDownloadDispatchParams,
): Promise<void> {
    const job = await prisma.downloadJob.findUnique({
        where: { id: params.jobId },
    });
    if (!job) {
        logger.error(`Job ${params.jobId} not found`);
        return;
    }
    if (params.type !== "album") return;

    const names = parseAlbumNames(params);
    logger.debug(`Parsed: Artist="${names.artist}", Album="${names.album}"`);

    const settings = await getSystemSettings();
    const configuredSource = (settings?.downloadSource ||
        "soulseek") as DownloadSource;
    const availability = await probeDownloadSourceAvailability();
    const resolution = resolveDownloadSource({
        configuredSource,
        fallback: settings?.primaryFailureFallback,
        availability,
    });
    if (resolution.kind === "fail") {
        await failJobWithoutDispatch(
            params.jobId,
            job.metadata,
            configuredSource,
            resolution.error,
            resolution.statusText,
        );
        return;
    }

    logger.debug(
        `Download source: configured=${configuredSource}, effective=${resolution.source}`,
    );
    await dispatchResolvedSource(
        resolution.source,
        availability,
        params,
        names,
        job.userId,
    );
}
