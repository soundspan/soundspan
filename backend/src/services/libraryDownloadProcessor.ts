/** Shared orchestration for provider-backed library album downloads. */

import { logger as rootLogger } from "../utils/logger";
import { prisma } from "../utils/db";
import { asPlainObject } from "../utils/plainObject";
import { requestCoalescedLibraryScan } from "./coalescedLibraryScan";
import type { DownloadSource } from "./downloadSourcePolicy";
import { patchDownloadJobMetadata } from "./downloadJobStatus";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { musicBrainzService } from "./musicbrainz";
import { classifyDownloadCompleteness } from "./albumDownloadCompleteness";

const logger = rootLogger.child("LibraryDownloadProcessor");

type DownloadMetadata = Record<string, unknown>;
type PeerFallbackOptions = LibraryAlbumDownloadOptions & {
    isFallback: true;
};

interface DownloadContext {
    jobId: string;
    metadata: DownloadMetadata;
    albumMbid: string | null;
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
    readDownloadedCount: (result: TResult) => number | null;
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

function withoutFailureMetadata(metadata: DownloadMetadata): DownloadMetadata {
    const {
        failedAt: _failedAt,
        partial: _partial,
        ...retainedMetadata
    } = metadata;
    return retainedMetadata;
}

function persistedExpectedTracks(metadata: DownloadMetadata): number | null {
    const value = metadata.expectedTracks;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}

function resolveAlbumMbid(
    targetMbid: string | undefined,
    metadata: DownloadMetadata,
): string | null {
    if (targetMbid) return targetMbid;
    const legacyMbid = metadata.albumMbid;
    return typeof legacyMbid === "string" && legacyMbid ? legacyMbid : null;
}

function warnExpectedTracksUnavailable(
    config: { sourceKey: string },
    context: DownloadContext,
    reason: string,
    error?: unknown,
): void {
    logger.warn("Album completeness verification skipped", {
        jobId: context.jobId,
        source: config.sourceKey,
        albumMbid: context.albumMbid ?? undefined,
        reason,
        ...(error === undefined ? {} : { error }),
    });
}

async function resolveExpectedTracks<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    context: DownloadContext,
): Promise<number | null> {
    const persisted = persistedExpectedTracks(context.metadata);
    if (persisted !== null) return persisted;
    if (!context.albumMbid) {
        warnExpectedTracksUnavailable(
            config,
            context,
            "Album MusicBrainz ID is missing",
        );
        return null;
    }
    let expectedTracks: number;
    try {
        expectedTracks = await musicBrainzService.getExpectedTrackCount(
            context.albumMbid,
        );
    } catch (error) {
        warnExpectedTracksUnavailable(
            config,
            context,
            "MusicBrainz expected-count lookup failed",
            error,
        );
        return null;
    }
    if (!Number.isSafeInteger(expectedTracks) || expectedTracks <= 0) {
        warnExpectedTracksUnavailable(
            config,
            context,
            "MusicBrainz returned no expected track count",
        );
        return null;
    }
    await patchDownloadJobMetadata(context.jobId, {
        expectedTracks,
    });
    return expectedTracks;
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
        context.albumMbid ?? "",
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
    expectedTracks: number | null,
): Promise<void> {
    const summary = config.resultSummary(match, result);
    await patchDownloadJobMetadata(
        jobId,
        (current) => ({
            ...withoutFailureMetadata(current),
            currentSource: config.sourceKey,
            statusText: summary.statusText,
            ...summary.metadata,
            ...(expectedTracks === null ? {} : { expectedTracks }),
        }),
        {
            status: "completed",
            completedAt: new Date(),
            error: null,
        },
    );
}

async function failPartialJob<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
    match: TMatch,
    result: TResult,
    downloadedTracks: number,
    expectedTracks: number,
): Promise<void> {
    const statusText = `Partial download: ${downloadedTracks}/${expectedTracks} tracks`;
    const summary = config.resultSummary(match, result);
    logger.warn("Album download is incomplete", {
        jobId,
        source: config.sourceKey,
        downloadedTracks,
        expectedTracks,
    });
    await patchDownloadJobMetadata(
        jobId,
        (current) => ({
            ...current,
            currentSource: config.sourceKey,
            statusText,
            ...summary.metadata,
            expectedTracks,
            partial: true,
            failedAt: new Date().toISOString(),
        }),
        { status: "failed", error: statusText, completedAt: new Date() },
    );
}

async function settleJob<TMatch, TResult>(
    config: LibraryDownloadProcessorConfig<TMatch, TResult>,
    jobId: string,
    match: TMatch,
    result: TResult,
    expectedTracks: number | null,
): Promise<void> {
    const downloadedTracks = config.readDownloadedCount(result);
    const completeness = classifyDownloadCompleteness(
        downloadedTracks,
        expectedTracks,
    );
    if (
        completeness === "partial" &&
        downloadedTracks !== null &&
        expectedTracks !== null
    ) {
        await failPartialJob(
            config,
            jobId,
            match,
            result,
            downloadedTracks,
            expectedTracks,
        );
        return;
    }
    await completeJob(config, jobId, match, result, expectedTracks);
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
    expectedTracks: number | null,
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
        albumMbid: context.albumMbid,
    });
    await settleJob(config, context.jobId, match, result, expectedTracks);
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
            `${config.sourceLabel} library scan enqueue failed; download status remains unchanged`,
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
        select: { targetMbid: true, metadata: true },
    });
    const metadata = asPlainObject(existingJob?.metadata);
    const albumMbid = resolveAlbumMbid(existingJob?.targetMbid, metadata);
    let result: TResult | null;
    try {
        const context = {
            jobId,
            artistName,
            albumTitle,
            userId,
            metadata,
            albumMbid,
            isFallback: options.isFallback === true,
            fallbackSource: options.fallbackSource,
        };
        const expectedTracks = await resolveExpectedTracks(config, context);
        result = await runAttempt(config, context, expectedTracks);
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
