import type { DownloadJob } from "@prisma/client";
import { logger as rootLogger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import {
    type DownloadSource,
    type DownloadSourceAvailability,
    type DownloadSourceResolution,
    probeDownloadSourceAvailability,
    resolveDownloadSource,
} from "./downloadSourcePolicy";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { processTidalDownload } from "./tidalLibraryDownload";
import { processYoutubeDownload } from "./youtubeLibraryDownload";
import { processSoulseekDownload } from "./soulseekLibraryDownload";
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

type ProviderDownloadProcessor = (
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    options?: { fallbackSource?: DownloadSource },
) => Promise<void>;

type FailedDownloadSourceResolution = Extract<
    DownloadSourceResolution,
    { kind: "fail" }
> & { source: DownloadSource };

/** Resolved album-download routing snapshot used by queue workers. */
export type AlbumDownloadRouting =
    | {
          kind: "fail";
          job: DownloadJob;
          resolution: FailedDownloadSourceResolution;
      }
    | {
          kind: "dispatch";
          source: DownloadSource;
          fallbackSource?: DownloadSource;
          availability: DownloadSourceAvailability;
          job: DownloadJob;
          names: AlbumNames;
          userId: string;
      };

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

async function dispatchProviderSource(
    processor: ProviderDownloadProcessor,
    fallbackSource: DownloadSource | undefined,
    params: AlbumDownloadDispatchParams,
    names: AlbumNames,
    userId: string,
): Promise<void> {
    if (fallbackSource) {
        await processor(params.jobId, names.artist, names.album, userId, {
            fallbackSource,
        });
        return;
    }
    await processor(params.jobId, names.artist, names.album, userId);
}

async function dispatchResolvedSource(
    source: DownloadSource,
    fallbackSource: DownloadSource | undefined,
    params: AlbumDownloadDispatchParams,
    names: AlbumNames,
    userId: string,
): Promise<void> {
    if (source === "tidal") {
        await dispatchProviderSource(
            processTidalDownload,
            fallbackSource,
            params,
            names,
            userId,
        );
        return;
    }
    if (source === "youtube") {
        await dispatchProviderSource(
            processYoutubeDownload,
            fallbackSource,
            params,
            names,
            userId,
        );
        return;
    }
    if (source === "soulseek") {
        await processSoulseekDownload(
            params.jobId,
            names.artist,
            names.album,
            userId,
        );
        return;
    }

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

function resolveRuntimeFallback(
    configuredSource: DownloadSource,
    dispatchedSource: DownloadSource,
    fallback: string | null | undefined,
    availability: DownloadSourceAvailability,
): DownloadSource | undefined {
    if (configuredSource !== dispatchedSource) return undefined;
    const resolution = resolveDownloadSource({
        configuredSource,
        fallback,
        availability: { ...availability, [configuredSource]: false },
    });
    if (resolution.kind === "fail" || resolution.source === dispatchedSource) {
        return undefined;
    }
    return resolution.source;
}

/** Resolve one album download against a single settings and availability snapshot. */
export async function resolveAlbumDownloadRouting(
    params: AlbumDownloadDispatchParams,
): Promise<AlbumDownloadRouting | null> {
    const job = await prisma.downloadJob.findUnique({
        where: { id: params.jobId },
    });
    if (!job) {
        logger.error(`Job ${params.jobId} not found`);
        return null;
    }
    if (params.type !== "album") return null;

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
        return {
            kind: "fail",
            job,
            resolution: { ...resolution, source: configuredSource },
        };
    }

    logger.debug(
        `Download source: configured=${configuredSource}, effective=${resolution.source}`,
    );
    return {
        kind: "dispatch",
        source: resolution.source,
        fallbackSource: resolveRuntimeFallback(
            configuredSource,
            resolution.source,
            settings?.primaryFailureFallback,
            availability,
        ),
        availability,
        job,
        names,
        userId: job.userId,
    };
}

/**
 * Dispatch a previously resolved routing snapshot without probing settings or
 * availability again. Configuration changes after resolution affect later jobs.
 */
export async function dispatchResolvedAlbumDownload(
    routing: AlbumDownloadRouting | null,
    params: AlbumDownloadDispatchParams,
): Promise<void> {
    if (!routing) return;
    if (routing.kind === "fail") {
        await failJobWithoutDispatch(
            params.jobId,
            routing.job.metadata,
            routing.resolution.source,
            routing.resolution.error,
            routing.resolution.statusText,
        );
        return;
    }

    await dispatchResolvedSource(
        routing.source,
        routing.fallbackSource,
        params,
        routing.names,
        routing.userId,
    );
}

/**
 * Dispatch an existing album download job through the configured source and
 * fallback policy. Missing jobs and non-album types are left undispatched.
 */
export async function dispatchAlbumDownload(
    params: AlbumDownloadDispatchParams,
): Promise<void> {
    const routing = await resolveAlbumDownloadRouting(params);
    await dispatchResolvedAlbumDownload(routing, params);
}
