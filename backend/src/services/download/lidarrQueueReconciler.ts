import type { DownloadJob } from "@prisma/client";
import { prisma } from "../../utils/db";
import { toErrorMessage } from "../../utils/errors";
import { logger } from "../../utils/logger";
import { asPlainObject } from "../../utils/plainObject";
import { yieldToEventLoop } from "../../utils/async";
import { parseArtistAlbumSubject } from "../../utils/downloadSubject";
import { patchDownloadJobMetadataFrom } from "../downloadJobStatus";
import { lidarrService, type ReconciliationSnapshot } from "../lidarr";
import { lidarrErrorLogFields } from "../lidarr/lidarrHttpClient";

type ReconcileResult = {
    reconciled: number;
    errors: string[];
    snapshot?: ReconciliationSnapshot;
};

type QueueSyncResult = { cancelled: number; errors: string[] };

async function checkDiscoveryBatches(batchIds: Set<string>): Promise<void> {
    if (batchIds.size === 0) return;
    const { discoverWeeklyService } = await import("../discoverWeekly");
    for (const batchId of batchIds) {
        await discoverWeeklyService.checkBatchCompletion(batchId);
        await yieldToEventLoop();
    }
}

function isJobAvailable(
    job: DownloadJob,
    snapshot: ReconciliationSnapshot,
): boolean {
    const metadata = asPlainObject(job.metadata);
    const albumMbid =
        job.targetMbid ||
        String(metadata.albumMbid || metadata.lidarrMbid || "");
    const artistName =
        typeof metadata.artistName === "string"
            ? metadata.artistName
            : undefined;
    const albumTitle =
        typeof metadata.albumTitle === "string"
            ? metadata.albumTitle
            : undefined;
    if (
        lidarrService.isAlbumAvailableInSnapshot(
            snapshot,
            albumMbid,
            artistName,
            albumTitle,
        )
    ) {
        return true;
    }
    if (
        typeof metadata.lidarrMbid === "string" &&
        metadata.lidarrMbid !== albumMbid &&
        lidarrService.isAlbumAvailableInSnapshot(
            snapshot,
            metadata.lidarrMbid,
            undefined,
            undefined,
        )
    ) {
        return true;
    }
    if (artistName || !job.subject) return false;
    const parsed = parseArtistAlbumSubject(job.subject);
    return (
        parsed.artist !== job.subject &&
        lidarrService.isAlbumAvailableInSnapshot(
            snapshot,
            undefined,
            parsed.artist,
            parsed.album,
        )
    );
}

/** Reconcile processing jobs against a caller-owned Lidarr snapshot. */
export async function reconcileWithLidarr(
    existingSnapshot?: ReconciliationSnapshot,
): Promise<ReconcileResult> {
    const processingJobs = await prisma.downloadJob.findMany({
        where: { status: "processing" },
    });
    if (processingJobs.length === 0) return { reconciled: 0, errors: [] };
    if (!existingSnapshot) return { reconciled: 0, errors: [] };
    const toComplete: string[] = [];
    const discoveryBatchIds = new Set<string>();
    for (const job of processingJobs) {
        if (!isJobAvailable(job, existingSnapshot)) continue;
        toComplete.push(job.id);
        if (job.discoveryBatchId) discoveryBatchIds.add(job.discoveryBatchId);
    }
    if (toComplete.length > 0) {
        await prisma.downloadJob.updateMany({
            where: { id: { in: toComplete } },
            data: {
                status: "completed",
                completedAt: new Date(),
                error: null,
            },
        });
    }
    await checkDiscoveryBatches(discoveryBatchIds);
    return {
        reconciled: toComplete.length,
        errors: [],
        snapshot: existingSnapshot,
    };
}

interface QueueSyncPlan {
    reset: DownloadJob[];
    increment: Array<[DownloadJob, number]>;
    replace: Array<{
        job: DownloadJob;
        newDownloadId: string;
        oldDownloadId: string;
    }>;
    complete: DownloadJob[];
    fail: Array<[DownloadJob, number]>;
    discoveryBatchIds: Set<string>;
}

function emptyQueueSyncPlan(): QueueSyncPlan {
    return {
        reset: [],
        increment: [],
        replace: [],
        complete: [],
        fail: [],
        discoveryBatchIds: new Set(),
    };
}

function findReplacement(
    snapshot: ReconciliationSnapshot,
    artistName: string | undefined,
    albumTitle: string | undefined,
): string | undefined {
    if (!albumTitle) return undefined;
    const searchAlbum = albumTitle.toLowerCase();
    const searchArtist = artistName?.toLowerCase();
    const item = Array.from(snapshot.queue.values()).find((candidate) => {
        const title = candidate.title?.toLowerCase() || "";
        return (
            Boolean(candidate.downloadId) &&
            title.includes(searchAlbum) &&
            (!searchArtist || title.includes(searchArtist))
        );
    });
    return item?.downloadId;
}

function planMissingJob(
    job: DownloadJob,
    snapshot: ReconciliationSnapshot,
    plan: QueueSyncPlan,
): void {
    const metadata = asPlainObject(job.metadata);
    const missingCount =
        (typeof metadata.queueSyncMissingCount === "number"
            ? metadata.queueSyncMissingCount
            : 0) + 1;
    if (missingCount < 3) {
        plan.increment.push([job, missingCount]);
        return;
    }
    const artistName =
        typeof metadata.artistName === "string"
            ? metadata.artistName
            : undefined;
    const albumTitle =
        typeof metadata.albumTitle === "string"
            ? metadata.albumTitle
            : undefined;
    const replacement = findReplacement(snapshot, artistName, albumTitle);
    if (replacement && job.lidarrRef) {
        plan.replace.push({
            job,
            newDownloadId: replacement,
            oldDownloadId: job.lidarrRef,
        });
        return;
    }
    if (
        lidarrService.isAlbumAvailableInSnapshot(
            snapshot,
            job.targetMbid || undefined,
            artistName,
            albumTitle,
        )
    ) {
        plan.complete.push(job);
        return;
    }
    plan.fail.push([job, missingCount]);
    if (job.discoveryBatchId) plan.discoveryBatchIds.add(job.discoveryBatchId);
}

function buildQueueSyncPlan(
    processingJobs: DownloadJob[],
    snapshot: ReconciliationSnapshot,
): QueueSyncPlan {
    const plan = emptyQueueSyncPlan();
    for (const job of processingJobs) {
        if (!job.lidarrRef) continue;
        const metadata = asPlainObject(job.metadata);
        if (snapshot.queue.has(job.lidarrRef)) {
            if (
                typeof metadata.queueSyncMissingCount === "number" &&
                metadata.queueSyncMissingCount > 0
            ) {
                plan.reset.push(job);
            }
            continue;
        }
        planMissingJob(job, snapshot, plan);
    }
    return plan;
}

async function applyCounterUpdates(plan: QueueSyncPlan): Promise<void> {
    for (const job of plan.reset) {
        await patchDownloadJobMetadataFrom(job.metadata, job.id, {
            queueSyncMissingCount: 0,
            lastQueueSyncFound: new Date().toISOString(),
        });
    }
    for (const [job, missingCount] of plan.increment) {
        await patchDownloadJobMetadataFrom(job.metadata, job.id, {
            queueSyncMissingCount: missingCount,
            lastQueueSyncCheck: new Date().toISOString(),
        });
    }
}

async function applyReplacementUpdates(plan: QueueSyncPlan): Promise<void> {
    for (const { job, newDownloadId, oldDownloadId } of plan.replace) {
        await patchDownloadJobMetadataFrom(
            job.metadata,
            job.id,
            {
                previousDownloadId: oldDownloadId,
                replacementDetected: true,
                replacementDetectedAt: new Date().toISOString(),
                queueSyncMissingCount: 0,
            },
            { lidarrRef: newDownloadId, error: null },
        );
    }
}

async function applyTerminalUpdates(plan: QueueSyncPlan): Promise<void> {
    for (const job of plan.complete) {
        await patchDownloadJobMetadataFrom(
            job.metadata,
            job.id,
            {
                completedAt: new Date().toISOString(),
                queueSyncCompleted: true,
                queueSyncMissingCount: 0,
            },
            { status: "completed", completedAt: new Date(), error: null },
        );
    }
    for (const [job, missingCount] of plan.fail) {
        await patchDownloadJobMetadataFrom(
            job.metadata,
            job.id,
            {
                cancelledAt: new Date().toISOString(),
                queueSyncCancelled: true,
                queueSyncMissingCount: missingCount,
            },
            {
                status: "failed",
                error: "Lidarr queue sync: Download not found after 90s (3 checks).",
                completedAt: new Date(),
                lidarrRef: null,
            },
        );
    }
}

/** Sync tracked download identifiers against a caller-owned Lidarr snapshot. */
export async function syncWithLidarrQueue(
    existingSnapshot?: ReconciliationSnapshot,
): Promise<QueueSyncResult> {
    const processingJobs = await prisma.downloadJob.findMany({
        where: { status: "processing", lidarrRef: { not: null } },
    });
    if (processingJobs.length === 0 || !existingSnapshot) {
        return { cancelled: 0, errors: [] };
    }
    try {
        const plan = buildQueueSyncPlan(processingJobs, existingSnapshot);
        await applyCounterUpdates(plan);
        await applyReplacementUpdates(plan);
        await applyTerminalUpdates(plan);
        await checkDiscoveryBatches(plan.discoveryBatchIds);
        return {
            cancelled: plan.complete.length + plan.fail.length,
            errors: [],
        };
    } catch (error) {
        logger.error(
            "[QUEUE-SYNC] Failed to sync with Lidarr queue:",
            lidarrErrorLogFields(error),
        );
        return { cancelled: 0, errors: [toErrorMessage(error)] };
    }
}
