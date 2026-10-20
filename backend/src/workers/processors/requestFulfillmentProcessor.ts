import type { MusicRequest } from "@prisma/client";
import { recordMusicRequestAction } from "../../metrics";
import type { RequestFailureCause } from "../../services/notificationService";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    createAdminRecipientIdsLoader,
    type AdminRecipientIdsLoader,
    notifyRequestTransition,
} from "./requestFulfillmentNotifications";

const log = logger.child("RequestFulfillmentProcessor");

/** Maximum approved requests reconciled during one five-minute tick. */
export const MAX_REQUEST_FULFILLMENTS_PER_TICK = 200;
/** Maximum approved-request pages scanned during one reconciliation tick. */
export const MAX_REQUEST_FULFILLMENT_PAGES = 5;

type RequestCandidate = Pick<
    MusicRequest,
    "id" | "userId" | "rgMbid" | "artistName" | "albumTitle" | "downloadJobId"
>;

interface TerminalCandidate {
    request: RequestCandidate;
    downloadStatus: string;
    cause?: RequestFailureCause;
}

function terminalCandidate(
    request: RequestCandidate,
    statusByJobId: ReadonlyMap<string, string>,
): TerminalCandidate | null {
    const jobId = request.downloadJobId;
    if (!jobId) return null;
    const downloadStatus = statusByJobId.get(jobId) ?? "deleted";
    if (downloadStatus === "completed") return { request, downloadStatus };
    if (downloadStatus === "failed" || downloadStatus === "exhausted") {
        return { request, downloadStatus, cause: "download_failed" };
    }
    if (downloadStatus === "cancelled" || downloadStatus === "deleted") {
        return { request, downloadStatus, cause: "download_stopped" };
    }
    return null;
}

function appendTerminalCandidates(
    candidates: TerminalCandidate[],
    requests: RequestCandidate[],
    statusByJobId: ReadonlyMap<string, string>,
): void {
    for (
        let index = 0;
        index < requests.length &&
        index < MAX_REQUEST_FULFILLMENTS_PER_TICK &&
        candidates.length < MAX_REQUEST_FULFILLMENTS_PER_TICK;
        index += 1
    ) {
        const candidate = terminalCandidate(requests[index], statusByJobId);
        if (candidate) candidates.push(candidate);
    }
}

async function loadRequestPage(cursor?: string): Promise<RequestCandidate[]> {
    return prisma.musicRequest.findMany({
        where: { status: "approved", downloadJobId: { not: null } },
        select: {
            id: true,
            userId: true,
            rgMbid: true,
            artistName: true,
            albumTitle: true,
            downloadJobId: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: MAX_REQUEST_FULFILLMENTS_PER_TICK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
}

async function loadJobStatuses(
    requests: RequestCandidate[],
): Promise<Map<string, string>> {
    const jobIds = requests.flatMap((request) =>
        request.downloadJobId ? [request.downloadJobId] : [],
    );
    if (jobIds.length === 0) return new Map();
    const jobs = await prisma.downloadJob.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, status: true },
        take: MAX_REQUEST_FULFILLMENTS_PER_TICK,
    });
    return new Map(jobs.map((job) => [job.id, job.status]));
}

async function loadCandidates(): Promise<{
    candidates: TerminalCandidate[];
    selected: number;
}> {
    const candidates: TerminalCandidate[] = [];
    let selected = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REQUEST_FULFILLMENT_PAGES; page += 1) {
        const requests = await loadRequestPage(cursor);
        selected += requests.length;
        appendTerminalCandidates(
            candidates,
            requests,
            await loadJobStatuses(requests),
        );
        if (
            candidates.length >= MAX_REQUEST_FULFILLMENTS_PER_TICK ||
            requests.length < MAX_REQUEST_FULFILLMENTS_PER_TICK
        )
            break;
        cursor = requests.at(-1)?.id;
        if (!cursor) break;
    }
    return { candidates, selected };
}

async function ownedAlbumsByMbid(
    candidates: TerminalCandidate[],
): Promise<Map<string, string>> {
    if (candidates.length === 0) return new Map();
    const rgMbids = [
        ...new Set(candidates.map(({ request }) => request.rgMbid)),
    ];
    const albums = await prisma.album.findMany({
        where: { rgMbid: { in: rgMbids }, location: "LIBRARY" },
        select: { id: true, rgMbid: true },
    });
    return new Map(albums.map((album) => [album.rgMbid, album.id]));
}

async function transitionCandidate(
    candidate: TerminalCandidate,
    loadAdminRecipientIds: AdminRecipientIdsLoader,
    albumId?: string,
): Promise<"fulfilled" | "failed" | null> {
    const nextStatus =
        albumId || candidate.downloadStatus === "completed"
            ? "fulfilled"
            : "failed";
    const changed = await prisma.musicRequest.updateMany({
        where: {
            id: candidate.request.id,
            status: "approved",
            downloadJobId: candidate.request.downloadJobId,
        },
        data: { status: nextStatus },
    });
    if (changed.count === 0) return null;
    recordMusicRequestAction(nextStatus);
    log.info("Music request reached a terminal download state", {
        requestId: candidate.request.id,
        downloadJobId: candidate.request.downloadJobId,
        nextStatus,
    });
    await notifyRequestTransition(candidate.request, nextStatus, {
        albumId,
        cause: candidate.cause,
        loadAdminRecipientIds,
    });
    return nextStatus;
}

/** Reconcile one bounded batch of approved requests against terminal jobs. */
export async function processRequestFulfillmentBatch(): Promise<{
    selected: number;
    fulfilled: number;
    failed: number;
}> {
    const { candidates, selected } = await loadCandidates();
    const ownedAlbums = await ownedAlbumsByMbid(candidates);
    const loadAdminRecipientIds = createAdminRecipientIdsLoader();
    let fulfilled = 0;
    let failed = 0;
    for (
        let index = 0;
        index < candidates.length && index < MAX_REQUEST_FULFILLMENTS_PER_TICK;
        index += 1
    ) {
        const candidate = candidates[index];
        const albumId = ownedAlbums.get(candidate.request.rgMbid);
        const outcome = await transitionCandidate(
            candidate,
            loadAdminRecipientIds,
            albumId,
        );
        if (outcome === "fulfilled") fulfilled += 1;
        if (outcome === "failed") failed += 1;
    }
    return { selected, fulfilled, failed };
}
