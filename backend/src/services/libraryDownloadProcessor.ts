/** Shared orchestration for provider-backed library album downloads. */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { asPlainObject } from "../utils/plainObject";
import { requestCoalescedLibraryScan } from "./coalescedLibraryScan";
import type { DownloadSource } from "./downloadSourcePolicy";
import { patchDownloadJobMetadata } from "./downloadJobStatus";
import { simpleDownloadManager } from "./simpleDownloadManager";

type DownloadMetadata = Record<string, unknown>;
type PeerFallbackOptions = LibraryAlbumDownloadOptions & {
    isFallback: true;
};

interface DownloadContext {
    jobId: string;
    metadata: DownloadMetadata;
}

interface ProcessorContext extends DownloadContext {
    artistName: string;
    albumTitle: string;
    userId: string;
    isFallback: boolean;
    fallbackSource?: DownloadSource;
}

interface ResultSummary {
    statusText: string;
    metadata: DownloadMetadata;
}

/** Controls hand-off behavior when a processor is itself a fallback. */
export interface LibraryAlbumDownloadOptions {
    isFallback?: boolean;
    fallbackSource?: DownloadSource;
}

/** Defines provider-specific steps and text for the shared processor. */
export interface LibraryDownloadProcessorConfig<TMatch, TResult> {
    sourceKey: string;
    sourceLabel: string;
    searchingStatusText: string;
    failedError: string;
    failedStatusText: string;
    findMatch: (
        artistName: string,
        albumTitle: string,
    ) => Promise<TMatch | null>;
    download: (match: TMatch, context: DownloadContext) => Promise<TResult>;
    resultSummary: (match: TMatch, result: TResult) => ResultSummary;
    fallbackPeer: {
        sourceKey: string;
        run: (
            jobId: string,
            artistName: string,
            albumTitle: string,
            userId: string,
            options: PeerFallbackOptions,
        ) => Promise<void>;
    };
    logFallbackSelection: boolean;
    prefixManagerFailureLog: boolean;
    scanSource: string;
    onScanQueued?: (result: TResult) => Promise<void> | void;
}

function withoutFailedAt(metadata: DownloadMetadata): DownloadMetadata {
    const { failedAt: _failedAt, ...retainedMetadata } = metadata;
    return retainedMetadata;
}

async function markSearching<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
): Promise<void> {
    await patchDownloadJobMetadata(
        jobId,
        {
            currentSource: config.sourceKey,
            statusText: config.searchingStatusText,
        },
        {
            status: "processing",
            error: null,
        },
    );
}

async function markSearchMissHandOff<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
    fallback: string,
): Promise<void> {
    await patchDownloadJobMetadata(jobId, {
        currentSource: fallback,
        statusText: `${config.sourceLabel} not found → ${fallback}`,
    });
}

async function handOffToManager<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    context: ProcessorContext,
): Promise<void> {
    const result = await simpleDownloadManager.startDownload(
        context.jobId,
        context.artistName,
        context.albumTitle,
        typeof context.metadata.albumMbid === "string"
            ? context.metadata.albumMbid
            : "",
        context.userId,
        false,
        typeof context.metadata.artistMbid === "string"
            ? context.metadata.artistMbid
            : undefined,
    );
    if (result.success) return;
    const prefix = config.prefixManagerFailureLog
        ? `[${config.sourceLabel}] `
        : "";
    logger.error(`${prefix}Fallback lidarr failed: ${result.error}`);
}

async function handOffToPeer<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    context: ProcessorContext,
): Promise<void> {
    const options: PeerFallbackOptions = { isFallback: true };
    await config.fallbackPeer.run(
        context.jobId,
        context.artistName,
        context.albumTitle,
        context.userId,
        options,
    );
}

async function dispatchHandOff<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    fallback: DownloadSource,
    context: ProcessorContext,
): Promise<void> {
    if (fallback === config.fallbackPeer.sourceKey) {
        await handOffToPeer(config, context);
        return;
    }
    if (fallback === "soulseek") {
        const { processSoulseekDownload } =
            await import("./soulseekLibraryDownload");
        await processSoulseekDownload(
            context.jobId,
            context.artistName,
            context.albumTitle,
            context.userId,
        );
        return;
    }
    if (fallback === "lidarr") {
        await handOffToManager(config, context);
    }
}

async function handOffSearchMiss<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    context: ProcessorContext,
): Promise<boolean> {
    const selectedFallback = context.fallbackSource;
    if (!selectedFallback || context.isFallback) return false;
    if (config.logFallbackSelection) {
        logger.debug(
            `[${config.sourceLabel}] Album not found, falling back to ${selectedFallback}`,
        );
    }
    await markSearchMissHandOff(config, context.jobId, selectedFallback);
    await dispatchHandOff(config, selectedFallback, context);
    return true;
}

async function completeJob<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
    match: TMatch,
    result: TResult,
): Promise<void> {
    const summary = config.resultSummary(match, result);
    await patchDownloadJobMetadata(
        jobId,
        (current) => ({
            ...withoutFailedAt(current),
            currentSource: config.sourceKey,
            statusText: summary.statusText,
            ...summary.metadata,
        }),
        {
            status: "completed",
            completedAt: new Date(),
            error: null,
        },
    );
}

async function failJob<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
): Promise<void> {
    await patchDownloadJobMetadata(
        jobId,
        {
            currentSource: config.sourceKey,
            statusText: config.failedStatusText,
            failedAt: new Date().toISOString(),
        },
        {
            status: "failed",
            error: config.failedError,
            completedAt: new Date(),
        },
    );
}

async function runAttempt<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    context: ProcessorContext,
): Promise<TResult | null> {
    await markSearching(config, context.jobId);
    const match = await config.findMatch(
        context.artistName,
        context.albumTitle,
    );
    if (!match) {
        if (await handOffSearchMiss(config, context)) return null;
        throw new Error(
            `Album not found on ${config.sourceLabel}: ${context.artistName} - ${context.albumTitle}`,
        );
    }
    const result = await config.download(match, {
        jobId: context.jobId,
        metadata: context.metadata,
    });
    await completeJob(config, context.jobId, match, result);
    return result;
}

async function queueLibraryScanSafely<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
    userId: string,
    result: TResult,
): Promise<void> {
    try {
        await requestCoalescedLibraryScan(userId, config.scanSource);
        await config.onScanQueued?.(result);
    } catch (error) {
        logger.warn(
            `${config.sourceLabel} library scan enqueue failed; download remains completed`,
            { jobId, error },
        );
    }
}

/** Run one provider-backed library album search, download, and scan request. */
export async function runLibraryAlbumDownload<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
    artistName: string,
    albumTitle: string,
    userId: string,
    options: LibraryAlbumDownloadOptions = {},
): Promise<void> {
    const existingJob = await prisma.downloadJob.findUnique({
        where: { id: jobId },
        select: { metadata: true },
    });
    const metadata = asPlainObject(existingJob?.metadata);
    let result: TResult | null;
    try {
        result = await runAttempt(config, {
            jobId,
            artistName,
            albumTitle,
            userId,
            metadata,
            isFallback: options.isFallback === true,
            fallbackSource: options.fallbackSource,
        });
    } catch (error: unknown) {
        logger.error(
            `[${config.sourceLabel}] Download failed for job ${jobId}:`,
            error instanceof Error ? error.message : error,
        );
        await failJob(config, jobId);
        return;
    }
    if (result === null) return;
    await queueLibraryScanSafely(config, jobId, userId, result);
}
