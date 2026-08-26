import type { DownloadJob } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { sessionLog } from "../../utils/playlistLogger";
import { asPlainObject } from "../../utils/plainObject";
import { yieldToEventLoop } from "../../utils/async";
import { isAlbumDownloadQueueOwned } from "../albumDownloadQueueOwnership";
import {
    ACTIVE_DOWNLOAD_JOB_STATUSES,
    failDownloadJob,
    patchDownloadJobMetadataFrom,
} from "../downloadJobStatus";
import { lidarrService, type ReconciliationSnapshot } from "../lidarr";
import { lidarrErrorLogFields } from "../lidarr/lidarrHttpClient";
import type { AlbumRetryResult } from "./albumRetryStrategy";
import type { DownloadJobEvents } from "./downloadJobEvents";

/** Maximum age for a grabbed download before Lidarr activity is checked. */
export const IMPORT_TIMEOUT_MS = 15 * 60 * 1000;
/** Maximum age for a pending job that never started. */
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
/** Maximum age for a processing job that Lidarr never grabbed. */
export const NO_SOURCE_TIMEOUT_MS = 5 * 60 * 1000;

interface StaleJobClassification {
    stalePendingJobs: DownloadJob[];
    staleProcessingJobs: DownloadJob[];
    jobsToExtend: DownloadJob[];
}

interface StaleDownloadSweeperDependencies {
    events: DownloadJobEvents;
    blocklistAndRetry: (downloadId: string) => Promise<void>;
    tryNextAlbumFromArtist: (
        job: DownloadJob,
        reason: string,
    ) => Promise<AlbumRetryResult>;
}

type DownloadActivityLookup = (
    snapshot: ReconciliationSnapshot,
    downloadId: string,
) => { active: boolean; progress?: number };

/** Classify active jobs against fixed staleness windows. */
export function classifyStaleDownloadJobs(
    activeJobs: DownloadJob[],
    snapshot: ReconciliationSnapshot | undefined,
    now: Date,
    getDownloadActivity: DownloadActivityLookup,
): StaleJobClassification {
    const pendingCutoff = now.getTime() - PENDING_TIMEOUT_MS;
    const noSourceCutoff = now.getTime() - NO_SOURCE_TIMEOUT_MS;
    const importCutoff = now.getTime() - IMPORT_TIMEOUT_MS;
    const stalePendingJobs: DownloadJob[] = [];
    const staleProcessingJobs: DownloadJob[] = [];
    const jobsToExtend: DownloadJob[] = [];

    for (const job of activeJobs) {
        const metadata = asPlainObject(job.metadata);
        const startedAt = getStartedAt(job, metadata);
        if (job.status === "pending") {
            if (
                !isAlbumDownloadQueueOwned(metadata) &&
                job.createdAt.getTime() < pendingCutoff
            ) {
                stalePendingJobs.push(job);
            }
            continue;
        }
        if (
            metadata.source === "slskd" ||
            metadata.source === "soulseek_direct"
        )
            continue;
        if (!job.lidarrRef && startedAt < noSourceCutoff) {
            staleProcessingJobs.push(job);
            continue;
        }
        if (!job.lidarrRef || !snapshot || startedAt >= importCutoff) continue;
        const activity = getDownloadActivity(snapshot, job.lidarrRef);
        if (activity.active) jobsToExtend.push(job);
        else staleProcessingJobs.push(job);
    }
    return { stalePendingJobs, staleProcessingJobs, jobsToExtend };
}

function getStartedAt(
    job: DownloadJob,
    metadata: Record<string, unknown>,
): number {
    if (typeof metadata.startedAt !== "string") return job.createdAt.getTime();
    return new Date(metadata.startedAt).getTime();
}

async function failStalePendingJobs(jobs: DownloadJob[]): Promise<Set<string>> {
    const batchIds = new Set<string>();
    if (jobs.length === 0) return batchIds;
    logger.debug(
        `\n⏰ Found ${jobs.length} stuck PENDING jobs (never started)`,
    );
    sessionLog("CLEANUP", `Found ${jobs.length} stuck PENDING jobs`);
    for (const job of jobs) {
        if (job.discoveryBatchId) batchIds.add(job.discoveryBatchId);
    }
    await prisma.downloadJob.updateMany({
        where: { id: { in: jobs.map(({ id }) => id) } },
        data: {
            status: "failed",
            error: "Download never started - timed out",
            completedAt: new Date(),
        },
    });
    return batchIds;
}

async function checkDiscoveryBatches(batchIds: Set<string>): Promise<void> {
    if (batchIds.size === 0) return;
    const { discoverWeeklyService } = await import("../discoverWeekly");
    for (const batchId of batchIds) {
        await discoverWeeklyService.checkBatchCompletion(batchId);
        await yieldToEventLoop();
    }
}

async function extendActiveJobs(jobs: DownloadJob[]): Promise<void> {
    for (const job of jobs) {
        await patchDownloadJobMetadataFrom(job.metadata, job.id, {
            startedAt: new Date().toISOString(),
            extendedTimeout: true,
        });
    }
    if (jobs.length > 0) await yieldToEventLoop();
}

async function mergeCompletedDuplicate(
    job: DownloadJob,
    metadata: Record<string, unknown>,
): Promise<boolean> {
    const artistName = String(metadata.artistName || "")
        .toLowerCase()
        .trim();
    const albumTitle = String(metadata.albumTitle || "")
        .toLowerCase()
        .trim();
    if (!artistName || !albumTitle) return false;
    const duplicate = await prisma.downloadJob.findFirst({
        where: { id: { not: job.id }, status: "completed" },
    });
    const duplicateMetadata = asPlainObject(duplicate?.metadata);
    if (
        String(duplicateMetadata.artistName || "")
            .toLowerCase()
            .trim() !== artistName ||
        String(duplicateMetadata.albumTitle || "")
            .toLowerCase()
            .trim() !== albumTitle
    ) {
        return false;
    }
    await patchDownloadJobMetadataFrom(
        metadata,
        job.id,
        { mergedWithJob: duplicate!.id },
        { status: "completed", completedAt: new Date(), error: null },
    );
    return true;
}

async function policyExtendedTimeout(
    job: DownloadJob,
    metadata: Record<string, unknown>,
    events: DownloadJobEvents,
): Promise<boolean> {
    const results = await events.emit("download.timedOut", {
        jobId: job.id,
        subject: job.subject,
    });
    if (!results.some(({ timeoutExtended }) => timeoutExtended)) return false;
    await patchDownloadJobMetadataFrom(metadata, job.id, {
        startedAt: new Date().toISOString(),
        timeoutExtendedByPolicy: true,
    });
    return true;
}

async function processStaleJob(
    job: DownloadJob,
    dependencies: StaleDownloadSweeperDependencies,
): Promise<string | undefined> {
    const metadata = asPlainObject(job.metadata);
    if (await policyExtendedTimeout(job, metadata, dependencies.events)) return;
    const errorMessage = job.lidarrRef
        ? `Import failed - download stuck for ${IMPORT_TIMEOUT_MS / 60000} minutes`
        : "No sources found - no indexer results";
    sessionLog("CLEANUP", `Marking stale: ${job.subject} - ${errorMessage}`);
    if (await mergeCompletedDuplicate(job, metadata)) return;
    if (job.lidarrAlbumId && job.lidarrRef) {
        await dependencies.blocklistAndRetry(job.lidarrRef);
    }
    const artistMbid = job.artistMbid || metadata.artistMbid;
    let replacementStarted = false;
    if (artistMbid && !job.discoveryBatchId) {
        try {
            const result = await dependencies.tryNextAlbumFromArtist(
                job,
                errorMessage,
            );
            replacementStarted = result.retried && Boolean(result.jobId);
        } catch (error) {
            logger.error(
                `   Same-artist fallback error:`,
                lidarrErrorLogFields(error),
            );
        }
    }
    if (!replacementStarted) await failDownloadJob(job.id, errorMessage);
    return job.discoveryBatchId || undefined;
}

/** Mark stale download jobs through the manager's existing public seam. */
export async function markStaleJobsAsFailed(
    existingSnapshot: ReconciliationSnapshot | undefined,
    dependencies: StaleDownloadSweeperDependencies,
    now: Date = new Date(),
): Promise<number> {
    const activeJobs = await prisma.downloadJob.findMany({
        where: { status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES } },
    });
    const spotifyCount = activeJobs.filter(({ id }) =>
        id.startsWith("spotify_"),
    ).length;
    if (spotifyCount > 0) {
        sessionLog(
            "CLEANUP",
            `Checking ${activeJobs.length} active jobs (${spotifyCount} Spotify import)`,
        );
    }
    const classified = classifyStaleDownloadJobs(
        activeJobs,
        existingSnapshot,
        now,
        (snapshot, downloadId) =>
            lidarrService.isDownloadActiveInSnapshot(snapshot, downloadId),
    );
    const pendingBatchIds = await failStalePendingJobs(
        classified.stalePendingJobs,
    );
    await checkDiscoveryBatches(pendingBatchIds);
    await extendActiveJobs(classified.jobsToExtend);
    const processingBatchIds = new Set<string>();
    for (const job of classified.staleProcessingJobs) {
        const batchId = await processStaleJob(job, dependencies);
        if (batchId) processingBatchIds.add(batchId);
    }
    await checkDiscoveryBatches(processingBatchIds);
    return (
        classified.stalePendingJobs.length +
        classified.staleProcessingJobs.length
    );
}
