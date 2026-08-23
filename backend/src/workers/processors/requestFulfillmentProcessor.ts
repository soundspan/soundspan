import type { MusicRequest } from "@prisma/client";
import { recordMusicRequestAction } from "../../metrics";
import {
    notificationService,
    type RequestNotificationMetadata,
} from "../../services/notificationService";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const log = logger.child("RequestFulfillmentProcessor");

/** Maximum approved requests reconciled during one five-minute tick. */
export const MAX_REQUEST_FULFILLMENTS_PER_TICK = 200;
const TERMINAL_DOWNLOAD_STATUSES = ["completed", "failed", "exhausted"];

type RequestCandidate = Pick<
    MusicRequest,
    "id" | "userId" | "rgMbid" | "artistName" | "albumTitle" | "downloadJobId"
>;

function metadata(request: RequestCandidate): RequestNotificationMetadata {
    return {
        requestId: request.id,
        rgMbid: request.rgMbid,
        artistName: request.artistName,
        albumTitle: request.albumTitle,
    };
}

async function notifyTransition(
    request: RequestCandidate,
    nextStatus: "fulfilled" | "failed",
): Promise<void> {
    try {
        if (nextStatus === "fulfilled") {
            await notificationService.notifyRequestFulfilled(
                request.userId,
                metadata(request),
            );
        } else {
            await notificationService.notifyRequestFailed(
                request.userId,
                metadata(request),
            );
        }
    } catch (error) {
        log.warn("Request fulfillment notification failed", {
            requestId: request.id,
            nextStatus,
            error,
        });
    }
}

async function transitionCandidate(
    request: RequestCandidate,
    downloadStatus: string,
): Promise<"fulfilled" | "failed" | null> {
    const nextStatus = downloadStatus === "completed" ? "fulfilled" : "failed";
    const changed = await prisma.musicRequest.updateMany({
        where: { id: request.id, status: "approved" },
        data: { status: nextStatus },
    });
    if (changed.count === 0) return null;
    recordMusicRequestAction(nextStatus);
    log.info("Music request reached a terminal download state", {
        requestId: request.id,
        downloadJobId: request.downloadJobId,
        nextStatus,
    });
    await notifyTransition(request, nextStatus);
    return nextStatus;
}

async function loadCandidates(): Promise<{
    requests: RequestCandidate[];
    existingJobIds: Set<string>;
    statusByJobId: Map<string, string>;
}> {
    const requests = await prisma.musicRequest.findMany({
        where: { status: "approved", downloadJobId: { not: null } },
        select: {
            id: true,
            userId: true,
            rgMbid: true,
            artistName: true,
            albumTitle: true,
            downloadJobId: true,
        },
        orderBy: { updatedAt: "asc" },
        take: MAX_REQUEST_FULFILLMENTS_PER_TICK,
    });
    const jobIds = requests.flatMap((request) =>
        request.downloadJobId ? [request.downloadJobId] : [],
    );
    if (jobIds.length === 0) {
        return {
            requests,
            existingJobIds: new Set(),
            statusByJobId: new Map(),
        };
    }
    const [existingJobs, terminalJobs] = await Promise.all([
        prisma.downloadJob.findMany({
            where: { id: { in: jobIds } },
            select: { id: true },
            take: MAX_REQUEST_FULFILLMENTS_PER_TICK,
        }),
        prisma.downloadJob.findMany({
            where: {
                id: { in: jobIds },
                status: { in: TERMINAL_DOWNLOAD_STATUSES },
            },
            select: { id: true, status: true },
            take: MAX_REQUEST_FULFILLMENTS_PER_TICK,
        }),
    ]);
    return {
        requests,
        existingJobIds: new Set(existingJobs.map((job) => job.id)),
        statusByJobId: new Map(terminalJobs.map((job) => [job.id, job.status])),
    };
}

/** Reconcile one bounded batch of approved requests against terminal jobs. */
export async function processRequestFulfillmentBatch(): Promise<{
    selected: number;
    fulfilled: number;
    failed: number;
}> {
    const { requests, existingJobIds, statusByJobId } = await loadCandidates();
    let fulfilled = 0;
    let failed = 0;
    for (
        let index = 0;
        index < requests.length && index < MAX_REQUEST_FULFILLMENTS_PER_TICK;
        index += 1
    ) {
        const request = requests[index];
        const jobId = request.downloadJobId;
        if (!jobId) continue;
        const downloadStatus =
            statusByJobId.get(jobId) ??
            (existingJobIds.has(jobId) ? undefined : "deleted");
        if (!downloadStatus) continue;
        const outcome = await transitionCandidate(request, downloadStatus);
        if (outcome === "fulfilled") fulfilled += 1;
        if (outcome === "failed") failed += 1;
    }
    return { selected: requests.length, fulfilled, failed };
}
