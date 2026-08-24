import type { AlbumDownloadDispatchParams } from "./downloadDispatcher";
import { albumDownloadQueue } from "../workers/queues";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { ALBUM_DOWNLOAD_QUEUE_OWNER } from "./albumDownloadQueueOwnership";

const log = logger.child("AlbumDownloadQueueService");
const ALBUM_DOWNLOAD_JOB_NAME = "album-download";
const ALBUM_DOWNLOAD_RECOVERY_AGE_MS = 5 * 60_000;
const ALBUM_DOWNLOAD_RECOVERY_LIMIT = 20;

function albumDownloadQueueJobId(jobId: string): string {
    return `albumdl:${jobId}`;
}

function readMetadataString(
    metadata: unknown,
    key: "artistName" | "albumTitle",
): string | undefined {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return undefined;
    }
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
}

async function persistQueueAdmissionFailure(jobId: string): Promise<void> {
    try {
        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status: "failed",
                error: "Download queue unavailable",
                completedAt: new Date(),
            },
        });
    } catch (error) {
        log.error("Failed to persist album download queue admission failure", {
            jobId,
            error,
        });
    }
}

/** Add one album download to the durable queue. */
export async function enqueueAlbumDownload(
    params: AlbumDownloadDispatchParams,
): Promise<void> {
    const queueJobId = albumDownloadQueueJobId(params.jobId);
    try {
        await albumDownloadQueue.add(ALBUM_DOWNLOAD_JOB_NAME, params, {
            jobId: queueJobId,
        });
        log.debug("Album download queued", {
            jobId: params.jobId,
            queueJobId,
        });
    } catch (error) {
        await persistQueueAdmissionFailure(params.jobId);
        throw error;
    }
}

async function findRecoveryCandidates(now: Date) {
    return prisma.downloadJob.findMany({
        where: {
            type: "album",
            status: "pending",
            cleared: false,
            createdAt: {
                lt: new Date(now.getTime() - ALBUM_DOWNLOAD_RECOVERY_AGE_MS),
            },
            metadata: {
                path: ["queuedVia"],
                equals: ALBUM_DOWNLOAD_QUEUE_OWNER,
            },
        },
        orderBy: { createdAt: "asc" },
        take: ALBUM_DOWNLOAD_RECOVERY_LIMIT,
        select: {
            id: true,
            targetMbid: true,
            subject: true,
            metadata: true,
        },
    });
}

async function finalizeRecoveredQueueFailure(jobId: string): Promise<void> {
    await prisma.downloadJob.updateMany({
        where: {
            id: jobId,
            status: { in: ["pending", "processing"] },
        },
        data: {
            status: "failed",
            error: "Download failed",
            completedAt: new Date(),
        },
    });
}

type RemovableQueueJob = Readonly<{ remove: () => Promise<void> }>;

async function finalizeRetainedFailedQueueJob(
    jobId: string,
    queueJob: RemovableQueueJob,
): Promise<void> {
    try {
        await finalizeRecoveredQueueFailure(jobId);
        await queueJob.remove();
    } catch (error) {
        log.error("Failed to finalize retained album download queue failure", {
            jobId,
            error,
        });
    }
}

async function removeIncoherentQueueJob(
    jobId: string,
    queueJob: RemovableQueueJob,
): Promise<void> {
    try {
        await queueJob.remove();
    } catch (error) {
        log.error("Failed to remove incoherent album download queue job", {
            jobId,
            error,
        });
    }
}

async function retainedBullJobHandlesCandidate(
    jobId: string,
): Promise<boolean> {
    const queueJob = await albumDownloadQueue.getJob(
        albumDownloadQueueJobId(jobId),
    );
    if (!queueJob) return false;
    const state = await queueJob.getState();
    switch (state) {
        case "waiting":
        case "active":
        case "delayed":
        case "paused":
            return true;
        case "failed":
            await finalizeRetainedFailedQueueJob(jobId, queueJob);
            return true;
        case "completed":
        case "stuck":
        default:
            await removeIncoherentQueueJob(jobId, queueJob);
            return false;
    }
}

/** Re-enqueue bounded stale queue-owned jobs whose Redis admission was lost. */
export async function recoverUnqueuedAlbumDownloads(
    now = new Date(),
): Promise<number> {
    const staleJobs = await findRecoveryCandidates(now);

    for (const job of staleJobs) {
        if (await retainedBullJobHandlesCandidate(job.id)) continue;
        await enqueueAlbumDownload({
            jobId: job.id,
            type: "album",
            mbid: job.targetMbid,
            subject: job.subject,
            artistName: readMetadataString(job.metadata, "artistName"),
            albumTitle: readMetadataString(job.metadata, "albumTitle"),
        });
    }
    return staleJobs.length;
}

/** Supervise a fire-and-forget album download enqueue operation. */
export function enqueueAlbumDownloadInBackground(
    params: AlbumDownloadDispatchParams,
): void {
    void enqueueAlbumDownload(params).catch((error) => {
        log.error("Album download enqueue failed", {
            jobId: params.jobId,
            error,
        });
    });
}
